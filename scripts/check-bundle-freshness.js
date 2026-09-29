/**
 * check-bundle-freshness.js - dist/index.html が埋め込み元のファイルより新しいかを確認する
 *
 * 【背景】verify-render は dist/index.html（bundle-html.js が生成した単一HTML）を
 * 読んで検証する。npm run bundle を忘れると、assets/js/*.js や data/derived/*.json を
 * 直したつもりでも dist/index.html には反映されておらず、古いデータのまま「✅」に
 * なってしまう。実際に、fare-calculator.js の乗り継ぎ到達駅カウントを修正した直後に
 * bundle を忘れ、旧バンドルの値（62）のまま verify-render が一度通ってしまった事故が
 * あった（2026-09-30）。
 *
 * verify-regression は assets/js・data/derived を直接importして検証するため、この罠自体は
 * 踏まない。しかし「verify-regressionは通ったのに、実際にデプロイされる
 * dist/index.html（＝docs/index.html）は古いまま」という食い違いに気づけるよう、
 * 両方の検証スクリプトの冒頭でこのチェックを行う。
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
  'gtfs-loader.js',
  'route-duration.js',
  'fare-calculator.js',
  'spot-finder.js',
  'route-formatter.js',
  'map-view.js',
  'layout-controller.js',
  'main.js',
].map((f) => path.join(rootDir, 'assets/js', f));

function listDerivedJsonFiles() {
  const derivedDir = path.join(rootDir, 'data/derived');
  if (!fs.existsSync(derivedDir)) return [];
  return fs
    .readdirSync(derivedDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(derivedDir, f));
}

function sourceFiles() {
  return [
    path.join(rootDir, 'index.html'),
    path.join(rootDir, 'assets/css/style.css'),
    path.join(rootDir, 'config/spot-ranking-config.json'),
    ...JS_FILES,
    ...listDerivedJsonFiles(),
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
