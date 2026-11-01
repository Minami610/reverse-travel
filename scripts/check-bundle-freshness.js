/**
 * check-bundle-freshness.js - dist/index.html・docs/data/ が元ファイルより新しいかを確認する
 *
 * 【背景】verify-render は dist/index.html（bundle-html.js が生成した単一HTML）を
 * 読んで検証する。npm run bundle を忘れると、assets/js/*.js を直したつもりでも
 * dist/index.html には反映されておらず、古いデータのまま「✅」になってしまう。
 * 実際に、fare-calculator.js の乗り継ぎ到達駅カウントを修正した直後に bundle を
 * 忘れ、旧バンドルの値（62）のまま verify-render が一度通ってしまった事故が
 * あった（2026-09-30）。
 *
 * verify-regression は assets/js・data/derived を直接importして検証するため、この罠自体は
 * 踏まない。しかし「verify-regressionは通ったのに、実際にデプロイされる
 * dist/index.html（＝docs/index.html）は古いまま」という食い違いに気づけるよう、
 * 両方の検証スクリプトの冒頭でこのチェックを行う。
 *
 * 【2026-10-02】県ごとにデータを分割した段階1(c)により、dist/index.htmlは
 * もうデータを埋め込まない（CSS・Leaflet・アプリJSのみ）。一方でverify-renderは
 * docs/data/配下をfetchして検証するため、「data/derived/pref/を直したのに
 * generate-site-data.jsを忘れてdocs/data/pref/が古いまま」という同種の罠が
 * 新たに生まれる。assertSiteDataFresh()で同じ考え方のチェックを行う。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const distIndexPath = path.join(rootDir, 'dist/index.html');

// bundle-html.js が実際に埋め込んでいる入力ファイル一覧と一致させること
// （bundle-html.js自体を変更したときはこちらも見直す）
const JS_FILES = [
  'debug-log.js',
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
].map((f) => path.join(rootDir, 'assets/js', f));

function sourceFiles() {
  return [
    path.join(rootDir, 'index.html'),
    path.join(rootDir, 'assets/css/style.css'),
    ...JS_FILES,
  ].filter((f) => fs.existsSync(f));
}

/**
 * dist/index.html が古ければ理由を出して exit(1) する。
 * @param {string} callerLabel - エラーメッセージに出す呼び出し元スクリプト名
 */
export function assertBundleFresh(callerLabel) {
  if (!fs.existsSync(distIndexPath)) {
    console.error(
      `❌ ${callerLabel}: dist/index.html が見つかりません。先に npm run bundle を実行してください。`
    );
    process.exit(1);
  }

  const distMtime = fs.statSync(distIndexPath).mtimeMs;
  let newest = null;
  for (const file of sourceFiles()) {
    const mtime = fs.statSync(file).mtimeMs;
    if (mtime > distMtime && (!newest || mtime > newest.mtime)) {
      newest = { file, mtime };
    }
  }

  if (newest) {
    console.error(
      `❌ ${callerLabel}: dist/index.html が古い可能性があります` +
      `（${path.relative(rootDir, newest.file)} の方が新しく更新されています）。` +
      `先に npm run bundle を実行してから再実行してください。`
    );
    process.exit(1);
  }
}

/**
 * dist/vendor/maplibre/・docs/vendor/maplibre/（bundle-html.jsがコピーした
 * MapLibre GL JS本体と、3D地図の遅延読込モジュール3つ。インライン化せず
 * 別ファイルとして遅延読込するため、dist/index.html自体の鮮度チェックでは
 * 検出できない）が、それぞれのコピー元より古くないかを確認する
 * （4本目①で追加、4本目②でgsi-dem-protocol.js等3ファイルを追加）。
 * コピー先が存在しない（npm run bundleを一度も実行していない）場合は
 * assertBundleFreshの「dist/index.htmlが無い」で先に止まるため、ここでは
 * 存在するのに古い場合だけを見る。
 *
 * 【注意】ファイルごとに対応するコピー元とだけ比較すること（複数ファイル中の
 * 最新mtimeとまとめて比較しない）。fs.copyFileSyncはコピー元ごとの個別の
 * mtimeをそのまま引き継ぐため、取得・編集時刻が複数ファイル間でわずかでも
 * ずれていると、片方のコピーが「もう片方の時刻」より古いというだけで
 * 誤って「古い」と判定してしまう不具合が実際にあった
 * （2026-10-10、ビルド直後のverify-layoutで発覚）。
 */
export function assertMaplibreVendorFresh(callerLabel) {
  const maplibreSrcDir = path.join(rootDir, 'assets/vendor/maplibre');
  const jsSrcDir = path.join(rootDir, 'assets/js');

  // [コピー元ディレクトリ, [ファイル名...]] の組。ファイルごとに自分の
  // コピー元とだけ比較する。
  const groups = [
    [maplibreSrcDir, ['maplibre-gl.js', 'maplibre-gl.css']],
    [jsSrcDir, ['gsi-dem-protocol.js', 'terrain-map-view.js', 'gsi-dem-worker.js']],
    [path.join(rootDir, 'assets/vendor/maplibre-gl-leaflet'), ['leaflet-maplibre-gl.js']], // 【43本目D】
  ];

  for (const outRoot of ['dist', 'docs']) {
    const outDir = path.join(rootDir, outRoot, 'vendor/maplibre');
    for (const [srcDir, files] of groups) {
      for (const file of files) {
        const srcPath = path.join(srcDir, file);
        if (!fs.existsSync(srcPath)) continue;
        const srcMtime = fs.statSync(srcPath).mtimeMs;
        const outPath = path.join(outDir, file);
        if (!fs.existsSync(outPath) || fs.statSync(outPath).mtimeMs < srcMtime) {
          console.error(
            `❌ ${callerLabel}: ${outRoot}/vendor/maplibre/${file} が無いか古い可能性があります。` +
            `先に npm run bundle を実行してから再実行してください。`
          );
          process.exit(1);
        }
      }
    }
    // 【43本目D】下地の地図のスタイル
    const styleSrc = path.join(rootDir, 'assets/vendor/gsi-vector/app-style.json');
    const styleOut = path.join(rootDir, outRoot, 'vendor/gsi-vector/app-style.json');
    if (fs.existsSync(styleSrc) && (!fs.existsSync(styleOut) || fs.statSync(styleOut).mtimeMs < fs.statSync(styleSrc).mtimeMs)) {
      console.error(`❌ ${callerLabel}: ${outRoot}/vendor/gsi-vector/app-style.json が無いか古い可能性があります。先に npm run bundle を実行してください。`);
      process.exit(1);
    }
  }
}

/**
 * docs/data/ 配下（generate-site-data.js の出力）が、変換元の data/derived/pref/
 * や config/spot-ranking-config.json より古くないかを確認する。
 * docs/data/pref/ がまだ存在しない（段階1(c)未実施）場合は何もしない。
 * @param {string} callerLabel - エラーメッセージに出す呼び出し元スクリプト名
 */
export function assertSiteDataFresh(callerLabel) {
  const docsPrefDir = path.join(rootDir, 'docs/data/pref');
  if (!fs.existsSync(docsPrefDir)) return;

  const problems = [];
  for (const code of fs.readdirSync(docsPrefDir)) {
    const docsDir = path.join(docsPrefDir, code);
    const derivedDir = path.join(rootDir, 'data/derived/pref', code);
    if (!fs.statSync(docsDir).isDirectory()) continue;
    for (const file of fs.readdirSync(docsDir)) {
      const derivedPath = path.join(derivedDir, file);
      if (!fs.existsSync(derivedPath)) continue;
      if (fs.statSync(derivedPath).mtimeMs > fs.statSync(path.join(docsDir, file)).mtimeMs) {
        problems.push(`data/derived/pref/${code}/${file} が docs/data/pref/${code}/${file} より新しい`);
      }
    }
  }

  const spotConfigSrc = path.join(rootDir, 'config/spot-ranking-config.json');
  const spotConfigDest = path.join(rootDir, 'docs/data/national/spot-ranking-config.json');
  if (
    fs.existsSync(spotConfigSrc) &&
    fs.existsSync(spotConfigDest) &&
    fs.statSync(spotConfigSrc).mtimeMs > fs.statSync(spotConfigDest).mtimeMs
  ) {
    problems.push('config/spot-ranking-config.json が docs/data/national/spot-ranking-config.json より新しい');
  }

  const supportBadgeSrc = path.join(rootDir, 'config/support-badge.json');
  const supportBadgeDest = path.join(rootDir, 'docs/data/national/support-badge.json');
  if (
    fs.existsSync(supportBadgeSrc) &&
    fs.existsSync(supportBadgeDest) &&
    fs.statSync(supportBadgeSrc).mtimeMs > fs.statSync(supportBadgeDest).mtimeMs
  ) {
    problems.push('config/support-badge.json が docs/data/national/support-badge.json より新しい');
  }

  if (problems.length > 0) {
    console.error(`❌ ${callerLabel}: docs/data/ が古い可能性があります:`);
    problems.forEach((p) => console.error(`  - ${p}`));
    console.error(
      '先に node scripts/build-pipeline/generate-site-data.js <都道府県コード,...> を実行してから再実行してください。'
    );
    process.exit(1);
  }
}
