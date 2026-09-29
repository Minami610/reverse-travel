/**
 * bundle-html.js - 単一HTMLファイル生成
 * 
 * 開発用の分割ファイル（ES6モジュール）と派生JSON を統合して、
 * 単一の HTML ファイルを生成（GitHub Pages デプロイ用）
 * 
 * 処理：
 * 1. index.html を読み込む
 * 2. assets/vendor/leaflet（地図ライブラリ）をインライン化
 * 3. assets/js の各スクリプトをインライン化
 * 4. assets/css をインライン化
 * 5. data/derived の JSON をJavaScriptオブジェクトリテラルとしてインライン化
 * 6. dist/index.html と docs/index.html に出力
 *    （GitHub Pages は main branch / docs folder を配信元に設定）
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// パス定義
const rootDir = path.join(__dirname, '..');
const indexPath = path.join(rootDir, 'index.html');
const cssPath = path.join(rootDir, 'assets/css/style.css');
const jsDir = path.join(rootDir, 'assets/js');
const leafletCssPath = path.join(rootDir, 'assets/vendor/leaflet/leaflet.css');
const leafletJsPath = path.join(rootDir, 'assets/vendor/leaflet/leaflet.js');
const derivedDir = path.join(rootDir, 'data/derived');
const distDir = path.join(rootDir, 'dist');
const distIndexPath = path.join(distDir, 'index.html');
const docsDir = path.join(rootDir, 'docs');
const docsIndexPath = path.join(docsDir, 'index.html');

/**
 * バンドル実行のメイン処理
 */
async function bundleHTML() {
  console.log('📦 単一HTMLファイル生成開始...\n');

  try {
    // dist ディレクトリを作成
    if (!fs.existsSync(distDir)) {
      fs.mkdirSync(distDir, { recursive: true });
    }

    // 1. index.html を読み込む
    console.log('📄 index.html を読み込み中...');
    let html = fs.readFileSync(indexPath, 'utf-8');

    // 2. Leaflet（地図ライブラリ）をインライン化
    //    CDN参照ではなくバンドルに埋め込む方針のため、node_modulesからコピーして
    //    リポジトリ管理下に置いた assets/vendor/leaflet/ を読み込む
    console.log('🗺️  Leaflet をインライン化中...');
    const leafletCss = fs.readFileSync(leafletCssPath, 'utf-8');
    html = html.replace(
      /<link rel="stylesheet" href="assets\/vendor\/leaflet\/leaflet\.css">/,
      `<style>\n${leafletCss}\n</style>`
    );
    const leafletJs = fs.readFileSync(leafletJsPath, 'utf-8');
    html = html.replace(
      /<script src="assets\/vendor\/leaflet\/leaflet\.js"><\/script>/,
      `<script>\n${leafletJs}\n</script>`
    );

    // 3. CSS をインライン化
    console.log('🎨 CSS をインライン化中...');
    const css = fs.readFileSync(cssPath, 'utf-8');
    html = html.replace(
      /<link rel="stylesheet" href="assets\/css\/style.css">/,
      `<style>\n${css}\n</style>`
    );

    // 4. モジュールスクリプトを削除（後でインライン化）
    html = html.replace(
      /<script type="module" src="assets\/js\/main\.js"><\/script>/,
      ''
    );

    // 5. 派生JSONをインライン化
    console.log('💾 派生データをインライン化中...');
    const inlineDataScript = await generateInlineDataScript(derivedDir);

    // 6. JavaScriptをインライン化
    console.log('⚙️  JavaScriptをインライン化中...');
    const inlineJSScript = await generateInlineJSScript(jsDir);

    // 7. body 終了タグ直前に<script>を追加
    const combinedScript = `<script>\n${inlineDataScript}\n${inlineJSScript}\n</script>`;
    html = html.replace('</body>', `  ${combinedScript}\n</body>`);

    // 8. dist/index.html に保存
    fs.writeFileSync(distIndexPath, html);

    const fileSize = fs.statSync(distIndexPath).size;
    const fileSizeKB = (fileSize / 1024).toFixed(2);

    console.log(`\n✅ バンドル完了`);
    console.log(`   出力: ${distIndexPath}`);
    console.log(`   サイズ: ${fileSizeKB} KB`);

    // 9. docs/index.html にもコピー（GitHub Pages の配信元）
    if (!fs.existsSync(docsDir)) {
      fs.mkdirSync(docsDir, { recursive: true });
    }
    fs.copyFileSync(distIndexPath, docsIndexPath);
    console.log(`✅ docs/index.html にコピー完了（GitHub Pages 配信用）`);

    console.log(
      `\n📤 デプロイ準備完了:`
    );
    console.log(`   1. git add docs/index.html dist/index.html`);
    console.log(`   2. git commit -m "Update dist/docs index.html"`);
    console.log(`   3. git push origin main`);
    console.log(
      `   → GitHub Pages (main branch / docs folder) に反映されます\n`
    );
  } catch (error) {
    console.error('❌ バンドル失敗:', error);
    process.exit(1);
  }
}

/**
 * spots-by-station.json の健全性チェック。
 *
 * 【背景】旧スポット収集パイプライン（generate-spots.json.js）や
 * refresh-and-normalize-spots.js を誤って実行すると、本番配信中のデータ
 * （新パイプライン=generate-spots-by-region.js産）より明確に劣化した
 * データで上書きされる。両スクリプトはCLAUDE.mdのルールに従い実行時に
 * 即座にエラーで止まるようにしたが、それとは別に「壊れたデータのまま
 * バンドルしてしまう」経路（例：手動でファイルを差し替えた等）も塞ぐため、
 * バンドル時にも構造とデータの健全性を検証する。
 * - spotsIndex/spots/stations を持つ新形式（インデックス化済み）であること
 *   （旧形式は{spots:{qid:詳細}, stations:{...}}でspotsIndexを持たない）
 * - すべてのスポットに sitelinks が設定されていること
 *   （未設定＝旧パイプライン産の証拠。spot-finder.jsの足切りフィルタが
 *   sitelinks===undefinedを「通す」判定にしているため、無言で無効化される）
 * - 停留所に紐づくスポット参照の総数が0でないこと
 *   （空データでの上書きを検出する。過去に実際に発生した事故）
 */
function validateSpotsData(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  if (!Array.isArray(data.spotsIndex) || !Array.isArray(data.spots) || typeof data.stations !== 'object') {
    throw new Error(
      `spots-by-station.json が新形式（spotsIndex/spots/stations）ではありません。` +
      `旧パイプライン（generate-spots.json.js等）で上書きされた可能性があります。`
    );
  }

  const missingSitelinks = data.spots.filter((s) => s.sitelinks === undefined).length;
  if (missingSitelinks > 0) {
    throw new Error(
      `spots-by-station.json 内の ${missingSitelinks}/${data.spots.length} 件のスポットに ` +
      `sitelinks がありません。旧パイプライン（sitelinksを取得しない）で生成された疑いがあります。` +
      `spot-finder.jsの足切りフィルタが無言で無効化されるため、このままバンドルしません。`
    );
  }

  const totalRefs = Object.values(data.stations).reduce((sum, arr) => sum + arr.length, 0);
  if (totalRefs === 0) {
    throw new Error(
      `spots-by-station.json の停留所に紐づくスポット参照が0件です。空データでの上書きの疑いがあります。`
    );
  }

  console.log(
    `  ✅ spots-by-station.json 健全性チェックOK（スポット${data.spots.length}件、駅参照${totalRefs}件、sitelinks欠落0件）`
  );
}

/**
 * 派生データをJavaScriptオブジェクトリテラルとしてインライン化
 */
async function generateInlineDataScript(derivedDir) {
  const files = {
    'fare-lookup-tables.json': 'EMBEDDED_FARE_DATA',
    'stops-metadata.json': 'EMBEDDED_STOPS_METADATA',
    'stations-by-name.json': 'EMBEDDED_STATIONS_BY_NAME',
    'route-info.json': 'EMBEDDED_ROUTE_INFO',
    'route-details.json': 'EMBEDDED_ROUTE_DETAILS',
    'spots-by-station.json': 'EMBEDDED_SPOTS_BY_STATION',
    'data-sources.json': 'EMBEDDED_DATA_SOURCES',
  };

  let script = '// ========== 埋め込みデータ ==========\n';

  for (const [filename, varName] of Object.entries(files)) {
    const filePath = path.join(derivedDir, filename);

    if (!fs.existsSync(filePath)) {
      if (filename === 'spots-by-station.json') {
        // スポットデータは他の派生データと違い「なければ空でもアプリは一応動く」
        // ものではなく、検索結果が常に0件になる致命的な欠落。CLAUDE.mdの
        // 「必須の生成物は不在時にエラーで停止させる」に従い、警告で済ませず止める。
        throw new Error(
          `${filename} が見つかりません。generate-spots-by-region.jsで生成してください` +
          `（parse-and-transform.jsはこのファイルを生成しなくなりました）。`
        );
      }
      console.warn(`  ⚠️  ${filename} が見つかりません（スキップ）`);
      script += `window.${varName} = {};\n`;
      continue;
    }

    if (filename === 'spots-by-station.json') {
      validateSpotsData(filePath);
    }

    const data = fs.readFileSync(filePath, 'utf-8');
    script += `window.${varName} = ${data};\n`;
  }

  // spot-ranking-config.json もインライン化
  const spotConfigPath = path.join(__dirname, '../config/spot-ranking-config.json');
  if (fs.existsSync(spotConfigPath)) {
    const spotConfig = fs.readFileSync(spotConfigPath, 'utf-8');
    script += `window.EMBEDDED_SPOT_RANKING_CONFIG = ${spotConfig};\n`;
  }

  return script;
}

/**
 * JavaScriptファイルをインライン化
 * モジュール形式から単純なスクリプトに変換
 */
async function generateInlineJSScript(jsDir) {
  const jsFiles = [
    'gtfs-loader.js',
    'route-duration.js',
    'fare-calculator.js',
    'spot-finder.js',
    'route-formatter.js',
    'map-view.js',
    'layout-controller.js',
    'main.js',
  ];

  let script = '// ========== アプリケーション ==========\n';

  for (const jsFile of jsFiles) {
    const filePath = path.join(jsDir, jsFile);

    if (!fs.existsSync(filePath)) {
      console.warn(`  ⚠️  ${jsFile} が見つかりません（スキップ）`);
      continue;
    }

    let content = fs.readFileSync(filePath, 'utf-8');

    // import/export を削除（非モジュール化）
    content = content.replace(/^import\s+.*?from\s+['"].*?['"];$/gm, '');
    content = content.replace(/^export\s+/gm, '');
    content = content.replace(
      /window\.addEventListener\('DOMContentLoaded'/,
      'document.addEventListener("DOMContentLoaded"'
    );

    script += `\n// ----- ${jsFile} -----\n${content}\n`;
  }

  return script;
}

// 実行
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  bundleHTML();
}
