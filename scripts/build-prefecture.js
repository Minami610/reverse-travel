/**
 * build-prefecture.js - 都道府県単位のビルド入口（段階1）
 *
 * CLAUDE.md「作業の進め方」の再開可能性の要件を最初から満たす：
 * - 県単位の完了マーカー（data/derived/pref/{2桁コード}/.build-complete.json）
 * - 完了済みの県は既定でスキップ（--force で再実行）
 * - 強制再取得オプション（--force。GTFS ZIP の再ダウンロード・カタログスナップショットの
 *   取り直し・完了マーカーの無視をすべて含む）
 * - 1県が失敗しても他の県の処理は続け、最後に失敗一覧を出す
 * - 件数0は成功として扱わない（各ステップの0件チェックは各モジュールに委譲しつつ、
 *   ここでも最終成果物の件数を横断チェックする）
 * - 前回ビルドとのスポット差分レポート（追加/削除QIDと削除原因クラス）。削除が
 *   前回件数の一定割合を超えたら--accept-diff指定がない限り失敗にする
 *   （Wikidata側の分類変更で除外対象が静かに変わりうるため。CLAUDE.md参照）
 * - 前回ビルドとのGTFS構造差分レポート（駅・停留所・路線の追加/削除、名前付き）。
 *   GTFSフィード自体の更新（ダイヤ改正等）が原因のことがあるため、こちらは
 *   ゲートにはせず報告のみ。カタログスナップショットにはfeed_version等の
 *   フィード版情報を記録し、いつのダイヤ改正のデータかを追跡できるようにする。
 *
 * 使い方:
 *   node scripts/build-prefecture.js 37            # 香川県のみビルド
 *   node scripts/build-prefecture.js 37,16,17       # 複数県を順にビルド
 *   node scripts/build-prefecture.js 37 --force      # 完了マーカーを無視して作り直す
 *   node scripts/build-prefecture.js 37 --force --accept-diff  # スポット削除率が閾値超でも続行
 *
 * 出力: data/derived/pref/{2桁コード}/
 *   fare-lookup-tables.json / stops-metadata.json / stations.json / route-info.json /
 *   route-details.json / spots-by-station.json / data-sources.json / spot-diff-report.json /
 *   gtfs-diff-report.json / .build-complete.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';

import { fetchGTFS } from './build-pipeline/fetch-gtfs.js';
import { parseAndTransform } from './build-pipeline/parse-and-transform.js';
import { generateRouteDetails } from './build-pipeline/generate-route-details.js';
import { generateDataSourcesManifest } from './build-pipeline/generate-data-sources-manifest.js';
import { generateSpotsForRegion } from './build-pipeline/generate-spots-by-region.js';
import { loadOrBuildCatalogSnapshot, recordFetchedFeedVersions } from './build-pipeline/catalog-snapshot.js';
import { checkLicenseAllowed } from './build-pipeline/license-check.js';
import { checkFeedHasFareData } from './build-pipeline/fare-feed-check.js';
import { computeSpotDiff, logSpotDiff } from './build-pipeline/spot-diff-report.js';
import { computeGtfsDiff, logGtfsDiff } from './build-pipeline/gtfs-diff-report.js';

// 前回件数に対する削除率がこれを超えたら--accept-diffなしでは失敗にする
const SPOT_REMOVAL_RATIO_THRESHOLD = 0.03;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const rawGtfsDir = path.join(rootDir, 'data/raw-gtfs');
const prefBaseDir = path.join(rootDir, 'data/derived/pref');

function prefCodeStr(code) {
  return String(code).padStart(2, '0');
}

function prefOutputDir(code) {
  return path.join(prefBaseDir, prefCodeStr(code));
}

function completionMarkerPath(code) {
  return path.join(prefOutputDir(code), '.build-complete.json');
}

/** 取得済みGTFSのfeed_info.txtからバージョン情報を読む（なければnullを詰める） */
function readFeedInfo(operatorId) {
  const feedInfoPath = path.join(rawGtfsDir, operatorId, 'feed_info.txt');
  if (!fs.existsSync(feedInfoPath)) {
    return { operatorId, feedVersion: null, feedStartDate: null, feedEndDate: null };
  }
  const records = parse(fs.readFileSync(feedInfoPath, 'utf-8'), { bom: true, columns: true });
  const row = records[0];
  return {
    operatorId,
    feedVersion: row?.feed_version || null,
    feedStartDate: row?.feed_start_date || null,
    feedEndDate: row?.feed_end_date || null,
  };
}

/**
 * ライセンス許可リスト・運賃データ有無で、この県のビルドに使う事業者を絞り込む。
 * 除外した事業者は理由とともに返す（出典マニフェストとの整合確認・ログ用）。
 */
function filterOperators(operators) {
  const included = [];
  const excluded = [];

  for (const operator of operators) {
    const licenseCheck = checkLicenseAllowed(operator);
    if (!licenseCheck.allowed) {
      excluded.push({ operator: operator.id, operator_name: operator.name, reason: `ライセンス許可リスト外（license_label="${operator.license_label || '(未設定)'}"）` });
      continue;
    }

    const operatorDir = path.join(rawGtfsDir, operator.id);
    if (!fs.existsSync(operatorDir)) {
      excluded.push({ operator: operator.id, operator_name: operator.name, reason: 'GTFSディレクトリが存在しない（フェッチ失敗の可能性）' });
      continue;
    }
    const fareCheck = checkFeedHasFareData(operatorDir);
    if (!fareCheck.hasFareData) {
      excluded.push({ operator: operator.id, operator_name: operator.name, reason: `運賃データなし（${fareCheck.reason}）` });
      continue;
    }

    included.push(operator);
  }

  return { included, excluded };
}

/**
 * 1都道府県分をビルドする。失敗時は例外を投げる（呼び出し側=main()で捕捉し、
 * 他の県の処理は継続する）。
 */
async function buildOnePrefecture(code, { force, acceptDiff }) {
  const codeStr = prefCodeStr(code);
  const outputDir = prefOutputDir(code);
  const markerPath = completionMarkerPath(code);

  if (!force && fs.existsSync(markerPath)) {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
    console.log(`⏭️  都道府県コード${codeStr}（${marker.pref_name}）は完了済み（${marker.completed_at}）のためスキップ（--force で再実行）`);
    return { skipped: true, prefName: marker.pref_name };
  }

  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`\n=====================================`);
  console.log(`🏗️  都道府県コード${codeStr} のビルド開始`);
  console.log(`=====================================\n`);

  // 1. カタログスナップショット（取得日付き。取得元がdirectかgtfs-data.jpかをここで確定する）
  const catalogEntry = await loadOrBuildCatalogSnapshot(code, { force });
  const prefName = catalogEntry.pref_name;

  // 2. ライセンス許可リスト・運賃データ有無でフィードを絞り込む
  //    （このチェックはGTFSダウンロード前のconfig情報だけで判定できるライセンス面と、
  //    ダウンロード後でないと判定できない運賃面の2段階にまたがるため、
  //    いったん全件フェッチしてから絞り込む）
  const licenseFiltered = catalogEntry.operators.filter((op) => {
    const check = checkLicenseAllowed(op);
    if (!check.allowed) {
      console.warn(`  ⚠️  ${op.name}: ライセンス許可リスト外のため取得前に除外（license_label="${op.license_label || '(未設定)'}"）`);
    }
    return check.allowed;
  });
  if (licenseFiltered.length === 0) {
    throw new Error(`${prefName}: ライセンス許可リストを満たす事業者が1件もありません`);
  }

  console.log('【ステップ1】GTFSデータをダウンロード');
  await fetchGTFS({ operators: licenseFiltered, dataDir: rawGtfsDir, force });

  // カタログスナップショットに、実際に取得したフィードのバージョン（ダイヤ改正の
  // 識別情報）を記録する。「configもコードも変えていないのに結果が変わった」ときに
  // GTFS側の更新が原因かどうかを再現・追跡できるようにするため。
  const feedInfos = licenseFiltered.map((op) => readFeedInfo(op.id));
  recordFetchedFeedVersions(code, feedInfos);

  // 3. 運賃データの有無で最終的な対象事業者を確定する（除外理由を記録）
  const { included: operators, excluded } = filterOperators(licenseFiltered);
  if (excluded.length > 0) {
    console.log(`\n⚠️  除外したフィード: ${excluded.length}件`);
    for (const e of excluded) console.log(`   - ${e.operator}: ${e.reason}`);
  }
  if (operators.length === 0) {
    throw new Error(`${prefName}: 運賃データを持つ事業者が1件も残りませんでした（除外: ${excluded.map((e) => e.operator).join(', ')}）`);
  }

  console.log('\n【ステップ1b】データ出典マニフェストを生成');
  generateDataSourcesManifest({
    operators,
    rawGtfsDir,
    outputPath: path.join(outputDir, 'data-sources.json'),
    coverage: { prefectures: [prefName], note: `都道府県コード${codeStr}（build-prefecture.js、段階1）` },
    excludedOperators: excluded,
  });

  // 前回ビルドのGTFS構造（駅・停留所・路線）を、上書きする前に読んでおく。
  // GTFSフィード自体の更新（ダイヤ改正等）は到達駅数（回帰チェックの基準値）に
  // 影響しうるが、スポットの削除率ゲートとは性質が異なり正当な更新を止めたく
  // ないため、こちらは失敗にはせず報告のみとする。
  function readGtfsSnapshot() {
    const stationsPath = path.join(outputDir, 'stations.json');
    const stopsMetaPath = path.join(outputDir, 'stops-metadata.json');
    const routeInfoPath = path.join(outputDir, 'route-info.json');
    if (!fs.existsSync(stationsPath) || !fs.existsSync(stopsMetaPath) || !fs.existsSync(routeInfoPath)) {
      return null;
    }
    return {
      stations: JSON.parse(fs.readFileSync(stationsPath, 'utf-8')),
      stopsMetadata: JSON.parse(fs.readFileSync(stopsMetaPath, 'utf-8')),
      routeInfo: JSON.parse(fs.readFileSync(routeInfoPath, 'utf-8')),
    };
  }
  const previousGtfs = readGtfsSnapshot();

  console.log('\n【ステップ2】GTFSをパース・変換');
  const parseStats = await parseAndTransform({ operators, rawGtfsDir, outputDir, prefCode: code });
  if (!parseStats.stationCount) {
    throw new Error(`${prefName}: 駅数が0件です`);
  }

  const gtfsDiff = computeGtfsDiff(previousGtfs, readGtfsSnapshot());
  logGtfsDiff(gtfsDiff, prefName);
  fs.writeFileSync(path.join(outputDir, 'gtfs-diff-report.json'), JSON.stringify(gtfsDiff, null, 2));

  console.log('\n【ステップ2b】経路（路線・所要時間）情報を生成');
  const routeStats = await generateRouteDetails({ operators, rawGtfsDir, outputDir });
  if (routeStats.directCount + routeStats.transferCount === 0) {
    throw new Error(`${prefName}: 経路情報が0件です`);
  }

  console.log('\n【ステップ3】観光スポット情報を生成（Wikidata bbox一括取得）');
  const stopsMeta = JSON.parse(fs.readFileSync(path.join(outputDir, 'stops-metadata.json'), 'utf-8'));
  const { normalizedOutput, excludedItems } = await generateSpotsForRegion(stopsMeta, { label: prefName });
  if (normalizedOutput.spotsIndex.length === 0) {
    throw new Error(`${prefName}: スポット件数が0件です`);
  }

  // 前回ビルドとの差分レポート（上書きする前に読む）。Wikidata側の分類変更だけで
  // config・コードを変えなくても除外対象が変わりうるため、削除件数の異常を機械的に検出する。
  const spotsPath = path.join(outputDir, 'spots-by-station.json');
  const previousSpots = fs.existsSync(spotsPath) ? JSON.parse(fs.readFileSync(spotsPath, 'utf-8')) : null;
  const spotDiff = computeSpotDiff(previousSpots, normalizedOutput, excludedItems);
  logSpotDiff(spotDiff, prefName);
  fs.writeFileSync(path.join(outputDir, 'spot-diff-report.json'), JSON.stringify(spotDiff, null, 2));

  if (spotDiff.hasPrevious && spotDiff.removalRatio > SPOT_REMOVAL_RATIO_THRESHOLD && !acceptDiff) {
    throw new Error(
      `${prefName}: スポット削除率が閾値(${(SPOT_REMOVAL_RATIO_THRESHOLD * 100).toFixed(0)}%)を超えました` +
      `（前回${spotDiff.previousCount}件中${spotDiff.removedCount}件、${(spotDiff.removalRatio * 100).toFixed(1)}%）。` +
      `意図した変化（Wikidata側の分類変更等）と確認できたら --accept-diff を指定して再実行してください。`
    );
  }
  if (spotDiff.hasPrevious && spotDiff.removalRatio > SPOT_REMOVAL_RATIO_THRESHOLD && acceptDiff) {
    console.warn(`⚠️  削除率が閾値を超えていますが --accept-diff が指定されているため続行します`);
  }

  fs.writeFileSync(spotsPath, JSON.stringify(normalizedOutput));
  console.log(`✅ spots-by-station.json (${normalizedOutput.spotsIndex.length}件のユニークスポット)`);

  // 完了マーカー
  const marker = {
    pref_code: codeStr,
    pref_name: prefName,
    completed_at: new Date().toISOString(),
    operators: operators.map((op) => op.id),
    excluded_operators: excluded,
    counts: {
      stops: parseStats.stopCount,
      stations: parseStats.stationCount,
      routes: parseStats.routeCount,
      route_details_direct: routeStats.directCount,
      route_details_transfer: routeStats.transferCount,
      route_details_unresolved: routeStats.unresolvedCount,
      spots: normalizedOutput.spotsIndex.length,
    },
    spot_diff: spotDiff.hasPrevious
      ? { previous_count: spotDiff.previousCount, added: spotDiff.addedCount, removed: spotDiff.removedCount, removal_ratio: spotDiff.removalRatio }
      : null,
    gtfs_diff: gtfsDiff.hasPrevious
      ? {
          stations: { added: gtfsDiff.stations.added.length, removed: gtfsDiff.stations.removed.length },
          stops: { added: gtfsDiff.stops.added.length, removed: gtfsDiff.stops.removed.length },
          routes: { added: gtfsDiff.routes.added.length, removed: gtfsDiff.routes.removed.length },
        }
      : null,
  };
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));

  console.log(`\n✅ 都道府県コード${codeStr}（${prefName}）のビルド完了`);
  console.log(`   駅${marker.counts.stations}件 / 路線${marker.counts.routes}件 / 経路情報${marker.counts.route_details_direct + marker.counts.route_details_transfer}件 / スポット${marker.counts.spots}件`);

  return { skipped: false, prefName, counts: marker.counts };
}

function parseArgs(argv) {
  const force = argv.includes('--force');
  const acceptDiff = argv.includes('--accept-diff');
  const codesArg = argv.find((a) => !a.startsWith('--'));
  if (!codesArg) {
    throw new Error('都道府県コードを指定してください（例: node scripts/build-prefecture.js 37）');
  }
  const codes = codesArg.split(',').map((s) => s.trim()).filter(Boolean);
  return { codes, force, acceptDiff };
}

async function main() {
  const { codes, force, acceptDiff } = parseArgs(process.argv.slice(2));

  const succeeded = [];
  const skipped = [];
  const failed = [];

  for (const code of codes) {
    try {
      const result = await buildOnePrefecture(code, { force, acceptDiff });
      if (result.skipped) {
        skipped.push({ code: prefCodeStr(code), prefName: result.prefName });
      } else {
        succeeded.push({ code: prefCodeStr(code), prefName: result.prefName, counts: result.counts });
      }
    } catch (error) {
      console.error(`\n❌ 都道府県コード${prefCodeStr(code)} のビルド失敗: ${error.message}`);
      failed.push({ code: prefCodeStr(code), reason: error.message });
    }
  }

  console.log('\n=====================================');
  console.log('📊 ビルド結果サマリー');
  console.log('=====================================');
  console.log(`  成功: ${succeeded.length}件${succeeded.map((s) => ` [${s.code} ${s.prefName}]`).join('')}`);
  console.log(`  スキップ（完了済み）: ${skipped.length}件${skipped.map((s) => ` [${s.code} ${s.prefName}]`).join('')}`);
  console.log(`  失敗: ${failed.length}件`);
  for (const f of failed) {
    console.log(`    - [${f.code}] ${f.reason}`);
  }

  if (failed.length > 0) {
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('❌ 致命的エラー:', error);
    process.exit(1);
  });
}

export { buildOnePrefecture, prefOutputDir, prefCodeStr };
