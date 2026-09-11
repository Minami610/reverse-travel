/**
 * generate-data-sources-manifest.js - アプリ画面の出典表示用マニフェスト生成
 *
 * 【背景】応募条件の必須表示「データの出典（公共交通オープンデータセンター／
 * gtfs-data.jp提供である旨。CC BYのフィードは各公開元も明記）」を、
 * ハードコードした文字列ではなくビルド時の実データから組み立てる。
 * ハードコードした文言は実態と食い違っても気づけない（実際、当初の実装は
 * 「gtfs-data.jpから取得」と書きながら実体はことでん直取得だった）。
 * ここで生成する data-sources.json だけが出典表示の情報源であり、
 * フロントエンド（#about-feed-list）はこれをそのまま描画する。
 *
 * 各フィードについて、config/target-operators.json の source_category
 * （「取得元をどう分類するか」は事業者ごとに人間が判断する情報のため設定ファイル側の責務）と、
 * ダウンロード済みGTFSの feed_info.txt（発行元・フィード版・データ期間。GTFS標準項目で
 * 検証可能な事実）を突き合わせて出力する。ライセンスはGTFSに標準項目がなく
 * feed_info.txtにも記載がないため、「表記なし」を正直に出す（CC BYと決め打ちしない）。
 */

import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configPath = path.join(__dirname, '../../config/target-operators.json');
const rawGtfsDir = path.join(__dirname, '../../data/raw-gtfs');
const outputPath = path.join(__dirname, '../../data/derived/data-sources.json');

const ODPT_OR_GTFS_DATA_JP = new Set(['odpt', 'gtfs-data-jp']);

function readFeedInfo(operatorId) {
  const feedInfoPath = path.join(rawGtfsDir, operatorId, 'feed_info.txt');
  if (!fs.existsSync(feedInfoPath)) return null;

  const records = parse(fs.readFileSync(feedInfoPath, 'utf-8'), {
    bom: true,
    columns: true,
  });
  // feed_info.txtは仕様上1行のみ。複数行あっても最初の行を決定的に採用する。
  return records[0] || null;
}

function getFetchedAt(operatorId) {
  const zipPath = path.join(rawGtfsDir, operatorId, 'data.zip');
  if (fs.existsSync(zipPath)) {
    return fs.statSync(zipPath).mtime.toISOString();
  }
  const dirPath = path.join(rawGtfsDir, operatorId);
  if (fs.existsSync(dirPath)) {
    return fs.statSync(dirPath).mtime.toISOString();
  }
  return null;
}

export function generateDataSourcesManifest() {
  console.log('📋 データ出典マニフェスト生成中...');

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const operators = config.phase1_operators || [];

  const feeds = operators.map((operator) => {
    const feedInfo = readFeedInfo(operator.id);
    const fetchedAt = getFetchedAt(operator.id);

    if (!feedInfo) {
      console.warn(`  ⚠️  ${operator.name}: feed_info.txt が見つかりません（未取得の可能性）`);
    }

    return {
      operator_id: operator.id,
      operator_name: operator.name,
      feed_publisher_name: feedInfo?.feed_publisher_name || null,
      feed_publisher_url: feedInfo?.feed_publisher_url || null,
      feed_version: feedInfo?.feed_version || null,
      feed_start_date: feedInfo?.feed_start_date || null,
      feed_end_date: feedInfo?.feed_end_date || null,
      source_category: operator.source_category || 'unknown',
      source_category_label: operator.source_category_label || '分類未設定',
      source_category_note: operator.source_category_note || null,
      source_url: operator.gtfs_url,
      // GTFSに標準のライセンス項目はなく、feed_info.txtにも記載がない。
      // config側の license_label は「フィード自体の記載」ではなく、公開元サイトの
      // 別ページ等で人間が個別に確認した事実（license_source_url/note参照）。
      // 未確認の事業者については決め打ちせず「表記なし」を正直に出す。
      license_label: operator.license_label || 'ライセンス表記が確認できていません（要確認）',
      license_url: operator.license_url || null,
      license_source_url: operator.license_source_url || null,
      license_source_note: operator.license_source_note || null,
      fetched_at: fetchedAt,
    };
  });

  const byCategory = feeds.reduce((acc, feed) => {
    acc[feed.source_category] = (acc[feed.source_category] || 0) + 1;
    return acc;
  }, {});
  const odptOrGtfsDataJpCount = feeds.filter((f) => ODPT_OR_GTFS_DATA_JP.has(f.source_category)).length;

  const manifest = {
    generated_at: new Date().toISOString(),
    feeds,
    summary: {
      total: feeds.length,
      by_category: byCategory,
      odpt_or_gtfs_data_jp_count: odptOrGtfsDataJpCount,
    },
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2));

  console.log(`  - 合計 ${feeds.length} フィード`);
  for (const [category, count] of Object.entries(byCategory)) {
    console.log(`    - ${category}: ${count}件`);
  }
  if (odptOrGtfsDataJpCount > 0) {
    console.log(`  ✅ 公共交通オープンデータセンター／gtfs-data.jp 由来のフィード: ${odptOrGtfsDataJpCount}件`);
  } else {
    console.log(
      '  ℹ️  公共交通オープンデータセンター／gtfs-data.jp 由来のフィードは現時点で0件です（応募条件の「主たるデータ源」化は未達。' +
      '他データソースの併用自体は応募条件違反ではないが、gtfs-data.jp API v2への移行を段階2で実施予定）。'
    );
  }
  console.log(`✅ データ出典マニフェストを生成: ${outputPath}\n`);

  return manifest;
}

// 実行
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  generateDataSourcesManifest();
}
