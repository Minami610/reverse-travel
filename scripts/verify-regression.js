/**
 * verify-regression.js - 公開中の全都道府県の回帰チェック（npm run verify-regression）
 *
 * 【背景】B（駅ID化・route_type判定・運賃と経路の事業者統一）の過程で、
 * 実装ミスにより「乗り継ぎ到達駅: 0駅」「往復予算内: 190駅」（本来199駅）に
 * なっていたことがあったが、npm run verify-render は✅で通っていた。
 * 気づけたのは一時スクリプトで手動確認したからで、そのスクリプトは
 * 確認後に削除していた。「件数0を成功扱いしない」というCLAUDE.mdのルールを、
 * テスト自体が破っていたことになる。同じ事故を繰り返さないよう、この
 * チェックを常設のnpmスクリプトにする。
 *
 * 【2026-10-06追記】香川のみの単一プレフィックス読み込みから、
 * config/published-prefectures.json の公開中の都道府県をすべて確認する構成に
 * 変更した（富山・石川を公開するにあたり、香川だけ確認していては不十分なため）。
 * 併せて、従来data/derived/直下のフラットな香川データ（data/derived/pref/37/の
 * 古いミラー、同期の仕組みが無く実体が古くなりうる）を読んでいた箇所を、
 * 都道府県ごとの正本である data/derived/pref/{コード}/ に統一した。
 *
 * 確認内容（都道府県ごと）：
 * 1. config/regression-baseline.json の prefectures[コード].departures について、
 *    到達駅数・スポット件数が基準値と完全一致すること
 * 2. 運賃を決めた事業者と表示経路の事業者が食い違う件数が0件であること
 *    （その県の直接到達すべてが対象）
 * 1つでもずれれば exit 1 で失敗する。
 *
 * 基準値を意図的に更新する場合は、このスクリプトで新しい値を確認したうえで
 * config/regression-baseline.json を書き換え、コミットメッセージに
 * 「なぜ変わったか」を書くこと（データ更新／仕様変更等）。
 *
 * 【2026-10-06 帯表示への変更】各budgetキーの reachable/spots/transfer は、
 * 「予算以下すべて」ではなく「予算−¥200より高く、予算以下」の帯だけを対象にした
 * 値に変更した（main.jsのperformSearch()と同じ絞り込みをこのテストでも行う）。
 * BAND_WIDTHはmain.jsのBAND_WIDTHと必ず一致させること（値をずらすとテストが
 * 検証する対象と実際の画面表示がずれてしまう）。上限も¥1000→¥2000に変更した
 * ことに合わせ、基準駅には¥2000の帯も追加した。
 */
const BAND_WIDTH = 200; // main.jsのBAND_WIDTHと同じ値を保つこと
const MAX_BUDGET = 2000; // main.jsのMAX_BUDGETと同じ値を保つこと

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pathToFileURL } from 'url';
import { assertBundleFresh } from './check-bundle-freshness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const baselinePath = path.join(rootDir, 'config/regression-baseline.json');
const publishedConfigPath = path.join(rootDir, 'config/published-prefectures.json');

function prefCodeStr(code) {
  return String(code).padStart(2, '0');
}

function readPrefJson(codeStr, name) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, 'data/derived/pref', codeStr, name), 'utf-8'));
}

function toUrl(relativePath) {
  return pathToFileURL(path.join(rootDir, relativePath)).href;
}

async function checkPrefecture(codeStr, prefBaseline, modules) {
  const { FareCalculator, SpotFinder, mergeIndexedSpotRegions, parseRouteEntry, lookupRouteEntry } = modules;
  console.log(`\n🔁 都道府県コード${codeStr}（${prefBaseline.pref_name}）の回帰チェック（${prefBaseline.departures.length}駅×帯ごと）`);

  const data = {
    fareData: readPrefJson(codeStr, 'fare-lookup-tables.json'),
    stopsMetadata: readPrefJson(codeStr, 'stops-metadata.json'),
    routeInfo: readPrefJson(codeStr, 'route-info.json'),
    routeDetails: readPrefJson(codeStr, 'route-details.json'),
    stations: readPrefJson(codeStr, 'stations.json'),
  };
  const merged = mergeIndexedSpotRegions([readPrefJson(codeStr, 'spots-by-station.json')]);
  data.spots = merged.spots;
  data.spotsByStation = merged.spotsByStation;

  const fareCalc = new FareCalculator(data);
  const spotFinder = new SpotFinder(data);

  function findStationId(displayName) {
    const entry = Object.entries(data.stations).find(([, s]) => s.display_name === displayName);
    if (!entry) throw new Error(`都道府県コード${codeStr}: 基準値の駅がstations.jsonに見つかりません: ${displayName}`);
    return entry[0];
  }

  let failures = 0;

  // 1. 各駅×各帯の到達駅数・スポット件数（帯 = 予算−¥200より高く、予算以下）
  for (const departure of prefBaseline.departures) {
    const stationId = findStationId(departure.display_name);
    for (const [budgetStr, expected] of Object.entries(departure.budgets)) {
      const budget = parseInt(budgetStr, 10);
      const cumulative = await fareCalc.calculateReachable(stationId, budget);
      const reachable = cumulative.filter((r) => r.roundTripFare > budget - BAND_WIDTH);
      const spots = await spotFinder.findSpots(reachable);
      const transfer = reachable.filter((r) => r.reachBy === 'transfer').length;
      const actual = { reachable: reachable.length, spots: spots.length, transfer };

      let ok = actual.reachable === expected.reachable && actual.spots === expected.spots;
      if (expected.transfer !== undefined) {
        ok = ok && actual.transfer === expected.transfer;
      }
      console.log(
        `${ok ? '✅' : '❌'} ${departure.display_name} 往復¥${budget}: ` +
        `到達駅数=${actual.reachable}（基準${expected.reachable}） スポット件数=${actual.spots}（基準${expected.spots}）` +
        (expected.transfer !== undefined ? ` 乗換到達駅数=${actual.transfer}（基準${expected.transfer}）` : '')
      );
      if (!ok) failures += 1;

      // 0件はそもそも基準値も0でない限り失敗（CLAUDE.mdの「0件を成功扱いしない」を
      // このチェック自身が破らないようにする）
      if (actual.reachable === 0 && expected.reachable !== 0) {
        console.log(`   ⚠️  到達駅数が0件です（基準値は${expected.reachable}）`);
      }
    }
  }

  // 2. 運賃事業者と表示経路事業者の食い違い件数（この県の全基準駅、上限¥2000の
  //    累積集合で確認。帯で絞ると上限予算の駅でしか全区間をカバーできないため、
  //    このチェックだけは従来どおり累積のcalculateReachable()をそのまま使う）
  console.log(`🔍 都道府県コード${codeStr}: 運賃事業者と表示経路事業者の食い違いチェック`);
  let totalDirect = 0;
  let totalMismatch = 0;
  for (const departure of prefBaseline.departures) {
    const stationId = findStationId(departure.display_name);
    const reachable = await fareCalc.calculateReachable(stationId, MAX_BUDGET);
    for (const station of reachable) {
      if (station.reachBy !== 'direct') continue;
      totalDirect += 1;
      const entry = lookupRouteEntry(data.routeDetails, stationId, station.station_id, station.viaOperator);
      const parsed = parseRouteEntry(entry);
      if (!parsed) continue; // 経路未確定は別問題（このチェックの対象外）
      const displayedRouteId = parsed.type === 'direct' ? parsed.route_id : parsed.legs[0].route_id;
      const displayedOperator = data.routeInfo[displayedRouteId]?.operator_id;
      if (displayedOperator !== station.viaOperator) {
        totalMismatch += 1;
        console.log(
          `   ❌ ${departure.display_name}→${station.display_name}：運賃事業者=${station.viaOperator}, ` +
          `表示経路事業者=${displayedOperator}, ¥${station.fare}`
        );
      }
    }
  }
  console.log(`直接到達${totalDirect}件中、食い違い${totalMismatch}件`);
  if (totalMismatch > 0) failures += 1;

  return failures;
}

async function main() {
  // このスクリプト自身はソース（assets/js・data/derived/pref/配下）を直接読むため
  // dist/index.htmlの古さには影響されないが、「これが通ったから実際に
  // デプロイされるdist/index.htmlも最新」と誤解しないよう、ここでも確認する。
  assertBundleFresh('verify-regression');

  if (!fs.existsSync(publishedConfigPath)) {
    throw new Error(`公開都道府県の一覧が見つかりません: ${publishedConfigPath}`);
  }
  const published = JSON.parse(fs.readFileSync(publishedConfigPath, 'utf-8')).published || [];
  if (published.length === 0) {
    throw new Error('config/published-prefectures.json の published が空です');
  }

  if (!fs.existsSync(baselinePath)) {
    throw new Error(`基準値ファイルが見つかりません: ${baselinePath}`);
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));

  console.log(`🔁 回帰チェック開始（公開中の${published.length}都道府県: ${published.join(', ')}）`);

  // spot-finder.jsがwindow.EMBEDDED_SPOT_RANKING_CONFIGを同期的に参照するため用意する
  global.window = {
    EMBEDDED_SPOT_RANKING_CONFIG: JSON.parse(
      fs.readFileSync(path.join(rootDir, 'config/spot-ranking-config.json'), 'utf-8')
    ),
  };

  const modules = {
    FareCalculator: (await import(toUrl('assets/js/fare-calculator.js'))).FareCalculator,
    SpotFinder: (await import(toUrl('assets/js/spot-finder.js'))).SpotFinder,
    mergeIndexedSpotRegions: (await import(toUrl('assets/js/gtfs-loader.js'))).mergeIndexedSpotRegions,
    parseRouteEntry: (await import(toUrl('assets/js/route-duration.js'))).parseRouteEntry,
    lookupRouteEntry: (await import(toUrl('assets/js/route-duration.js'))).lookupRouteEntry,
  };

  let failures = 0;
  for (const code of published) {
    const codeStr = prefCodeStr(code);
    const prefBaseline = baseline.prefectures?.[codeStr];
    if (!prefBaseline) {
      console.error(`❌ 都道府県コード${codeStr}: config/regression-baseline.json に基準値がありません（公開中なのに基準値が無いのは危険なため失敗にします）`);
      failures += 1;
      continue;
    }
    failures += await checkPrefecture(codeStr, prefBaseline, modules);
  }

  console.log('');
  if (failures > 0) {
    console.error(`❌ 回帰チェック失敗（${failures}件の不一致）`);
    process.exit(1);
  }
  console.log('✅ 回帰チェック成功: 公開中の全都道府県が基準どおりです');
}

main().catch((error) => {
  console.error('❌ 回帰チェック実行エラー:', error);
  process.exit(1);
});
