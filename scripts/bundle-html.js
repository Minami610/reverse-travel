/**
 * bundle-html.js - 単一HTMLファイル生成
 *
 * 開発用の分割ファイル（ES6モジュール）と CSS・Leaflet を統合して、
 * 単一の HTML ファイルを生成（GitHub Pages デプロイ用）
 *
 * 処理：
 * 1. index.html を読み込む
 * 2. assets/vendor/leaflet（地図ライブラリ）をインライン化
 * 3. assets/js の各スクリプトをインライン化
 * 4. assets/css をインライン化
 * 5. dist/index.html と docs/index.html に出力
 *    （GitHub Pages は main branch / docs folder を配信元に設定）
 *
 * 【2026-10-02】県ごとに分割したdocs/data/配下のJSONはビルド時に埋め込まない
 * （以前は data/derived の全JSONを単一HTMLに埋め込んでいたが、香川だけで
 * 埋め込みデータがバンドル全体の92%＝2.7MBを占め、県が増えるほどページが
 * 肥大化する構造だった）。gtfs-loader.jsが起動時・検索時にdocs/data/配下を
 * fetchする構成（段階1(c)）に変わったため、このスクリプトはCSS・Leaflet・
 * アプリJSのインライン化だけを担う。docs/data/の生成は
 * scripts/build-pipeline/generate-site-data.js が別途行う。
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

    // 5. JavaScriptをインライン化
    console.log('⚙️  JavaScriptをインライン化中...');
    const inlineJSScript = await generateInlineJSScript(jsDir);

    // 6. body 終了タグ直前に<script>を追加
    const combinedScript = `<script>\n${inlineJSScript}\n</script>`;
    html = html.replace('</body>', `  ${combinedScript}\n</body>`);

    // 7. dist/index.html に保存
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
    'favorites.js',
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

    // import/export を削除（非モジュール化）。
    // 【2026-10-08修正】旧正規表現は`.`がデフォルトで改行をまたがないため、
    // import { a, b, c } from '...'; のように{}の中を複数行に分けて書いた
    // import文（favorites.jsをmain.jsにimportした際に追加）が1文字も
    // マッチせず、importキーワードがそのままバンドルに残ってSyntaxErrorに
    // なった（jsdomでの検証時に発見）。[\s\S]*?で改行もまたいでマッチさせる。
    content = content.replace(/^import\s[\s\S]*?from\s+['"][^'"]*['"];\s*$/gm, '');
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
