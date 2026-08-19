/**
 * bundle-html.js - 単一HTMLファイル生成
 * 
 * 開発用の分割ファイル（ES6モジュール）と派生JSON を統合して、
 * 単一の HTML ファイルを生成（GitHub Pages デプロイ用）
 * 
 * 処理：
 * 1. index.html を読み込む
 * 2. assets/js の各スクリプトをインライン化
 * 3. assets/css をインライン化
 * 4. data/derived の JSON をJavaScriptオブジェクトリテラルとしてインライン化
 * 5. dist/index.html と docs/index.html に出力
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

    // 2. CSS をインライン化
    console.log('🎨 CSS をインライン化中...');
    const css = fs.readFileSync(cssPath, 'utf-8');
    html = html.replace(
      /<link rel="stylesheet" href="assets\/css\/style.css">/,
      `<style>\n${css}\n</style>`
    );

    // 3. モジュールスクリプトを削除（後でインライン化）
    html = html.replace(
      /<script type="module" src="assets\/js\/main\.js"><\/script>/,
      ''
    );

    // 4. 派生JSONをインライン化
    console.log('💾 派生データをインライン化中...');
    const inlineDataScript = await generateInlineDataScript(derivedDir);

    // 5. JavaScriptをインライン化
    console.log('⚙️  JavaScriptをインライン化中...');
    const inlineJSScript = await generateInlineJSScript(jsDir);

    // 6. body 終了タグ直前に<script>を追加
    const combinedScript = `<script>\n${inlineDataScript}\n${inlineJSScript}\n</script>`;
    html = html.replace('</body>', `  ${combinedScript}\n</body>`);

    // 7. dist/index.html に保存
    fs.writeFileSync(distIndexPath, html);

    const fileSize = fs.statSync(distIndexPath).size;
    const fileSizeKB = (fileSize / 1024).toFixed(2);

    console.log(`\n✅ バンドル完了`);
    console.log(`   出力: ${distIndexPath}`);
    console.log(`   サイズ: ${fileSizeKB} KB`);

    // 8. docs/index.html にもコピー（GitHub Pages の配信元）
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
 * 派生データをJavaScriptオブジェクトリテラルとしてインライン化
 */
async function generateInlineDataScript(derivedDir) {
  const files = {
    'fare-lookup-tables.json': 'EMBEDDED_FARE_DATA',
    'stops-metadata.json': 'EMBEDDED_STOPS_METADATA',
    'stations-by-name.json': 'EMBEDDED_STATIONS_BY_NAME',
    'route-info.json': 'EMBEDDED_ROUTE_INFO',
    'spots-by-station.json': 'EMBEDDED_SPOTS_BY_STATION',
  };

  let script = '// ========== 埋め込みデータ ==========\n';

  for (const [filename, varName] of Object.entries(files)) {
    const filePath = path.join(derivedDir, filename);

    if (!fs.existsSync(filePath)) {
      console.warn(`  ⚠️  ${filename} が見つかりません（スキップ）`);
      script += `window.${varName} = {};\n`;
      continue;
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
    'fare-calculator.js',
    'spot-finder.js',
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
