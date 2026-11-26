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
const maplibreVendorDir = path.join(rootDir, 'assets/vendor/maplibre');
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

    // 10. MapLibre GL JS（4本目①「3D地図の土台」）はLeafletと違いインライン化せず、
    //    3D切替時だけ別の<script>/<link>として動的読み込みする（遅延読込、
    //    3Dを使わない利用者のバンドルサイズを増やさないため）。そのため
    //    dist/・docs/の両方にvendor/maplibre/としてそのままコピーする。
    //    【2026-10-10、4本目②】gsi-dem-protocol.js・terrain-map-view.js・
    //    gsi-dem-worker.jsも同様の理由（2Dの人のページを重くしない）で
    //    インライン化をやめ、MapLibre本体と同じフォルダにそのままコピーする
    //    （terrain-loader.jsがimport()で、gsi-dem-protocol.jsがWorker生成で、
    //    それぞれ相対パスで参照するため同じフォルダに置く必要がある）。
    //    この3ファイルは他のアプリJSと違い、importもexportも削除しない
    //    （本物のESモジュールとしてそのまま動的importされるため）。
    const maplibreOutDirs = [path.join(distDir, 'vendor/maplibre'), path.join(docsDir, 'vendor/maplibre')];
    for (const outDir of maplibreOutDirs) {
      fs.mkdirSync(outDir, { recursive: true });
      for (const file of ['maplibre-gl.js', 'maplibre-gl.css']) {
        fs.copyFileSync(path.join(maplibreVendorDir, file), path.join(outDir, file));
      }
      for (const file of ['gsi-dem-protocol.js', 'terrain-map-view.js', 'gsi-dem-worker.js']) {
        fs.copyFileSync(path.join(jsDir, file), path.join(outDir, file));
      }
      // 【2026-10-21、43本目D】2DでもMapLibreで国土地理院のベクトル地図を描くための、Leaflet用の
      // 橋渡し（@maplibre/maplibre-gl-leaflet 0.1.4、ISCライセンス、assets/vendor/maplibre-gl-leaflet/
      // LICENSE）。MapLibre本体と同じく遅延読込のため、同じフォルダにコピーする。
      fs.copyFileSync(path.join(rootDir, 'assets/vendor/maplibre-gl-leaflet/leaflet-maplibre-gl.js'), path.join(outDir, 'leaflet-maplibre-gl.js'));
    }
    // 【43本目D】下地の地図のスタイル（scripts/build-map-style.jsが作る、国土地理院のベクトル地図・
    // 地図記号なし・アプリの色）。2D・3Dとも、地図を出すときに読み込む。
    const mapStyleSrc = path.join(rootDir, 'assets/vendor/gsi-vector/app-style.json');
    if (!fs.existsSync(mapStyleSrc)) throw new Error('assets/vendor/gsi-vector/app-style.json がありません（node scripts/build-map-style.js を実行してください）');
    for (const outRoot of [distDir, docsDir]) {
      const outDir = path.join(outRoot, 'vendor/gsi-vector');
      fs.mkdirSync(outDir, { recursive: true });
      fs.copyFileSync(mapStyleSrc, path.join(outDir, 'app-style.json'));
    }
    console.log('✅ 下地の地図のスタイル（vendor/gsi-vector/app-style.json）を dist/・docs/ にコピー完了');
    console.log(`✅ MapLibre GL JS・3D地図の遅延読込モジュールを dist/・docs/ の vendor/maplibre/ にコピー完了（インライン化はしない）`);

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
    'debug-log.js',
    'format.js', // 【78本目】金額の3桁区切り。route-formatter.js・favorites.js・main.jsより先に置く
    'gtfs-loader.js',
    'route-duration.js',
    'fare-calculator.js',
    'spot-finder.js',
    'route-formatter.js',
    'map-view.js',
    'terrain-loader.js',
    'layout-controller.js',
    'favorites.js',
    'onward-candidates.js',
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
