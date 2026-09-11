/**
 * fetch-and-build.js - ビルド統合実行
 * 
 * 以下を順序実行：
 * 1. fetch-gtfs.js       : GTFSデータのダウンロード
 * 2. parse-and-transform.js : GTFS → 派生JSON
 * 3. generate-spots.json.js : Wikidata/Wikipedia → スポット情報
 */

import { fetchGTFS } from './build-pipeline/fetch-gtfs.js';
import { parseAndTransform } from './build-pipeline/parse-and-transform.js';
import { generateRouteDetails } from './build-pipeline/generate-route-details.js';
import { generateSpots } from './build-pipeline/generate-spots.json.js';
import { generateDataSourcesManifest } from './build-pipeline/generate-data-sources-manifest.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

async function runBuild() {
  console.log('🚀 ビルドパイプライン開始\n');
  console.log('=====================================\n');

  try {
    console.log('【ステップ1】GTFSデータをダウンロード');
    console.log('-------------------------------------');
    await fetchGTFS();

    console.log('\n【ステップ1b】データ出典マニフェストを生成（アプリ画面の出典表示用）');
    console.log('-------------------------------------');
    generateDataSourcesManifest();

    console.log('\n【ステップ2】GTFS をパース・変換');
    console.log('-------------------------------------');
    await parseAndTransform();

    console.log('\n【ステップ2b】経路（路線・所要時間）情報を生成');
    console.log('-------------------------------------');
    await generateRouteDetails();

    console.log('\n【ステップ3】観光スポット情報を生成');
    console.log('-------------------------------------');
    await generateSpots();

    console.log('\n=====================================');
    console.log('✅ ビルド完了');
    console.log('\n次のステップ：');
    console.log('  1. npm run dev  → Live Server で index.html を確認');
    console.log('  2. 動作確認後、npm run bundle → dist/index.html 生成');
    console.log('  3. git commit && git push → GitHub Pages にデプロイ\n');
  } catch (error) {
    console.error('\n❌ ビルド失敗:');
    console.error(error);
    process.exit(1);
  }
}

// 実行
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runBuild();
}
