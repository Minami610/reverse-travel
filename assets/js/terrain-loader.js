/**
 * terrain-loader.js - 3D地図（MapLibre GL JS・gsi-dem-protocol.js・
 * terrain-map-view.js）の遅延読込だけを担う薄いスタブ（2026-10-10、
 * 4本目②「2Dの人のページを重くしない」）。
 *
 * 【背景】最初の実装（4本目①）ではgsi-dem-protocol.js・terrain-map-view.jsを
 * 他のアプリJSと同じくdist/index.htmlにインライン化していたため、3Dを
 * 一度も使わない人のページも+14.6KB gzip重くなっていた。このファイルだけを
 * 常時バンドルに含め、実際にクラスを使う2ファイルはMapLibre本体と同じく
 * 別ファイル（vendor/maplibre/配下）として3D切替時にだけ動的import()する。
 * import()は非モジュールの<script>内でも使える式（静的importと違い
 * バンドル側で削除されない）ため、このファイル自体はインライン化されても問題ない。
 */

const MAPLIBRE_JS_URL = 'vendor/maplibre/maplibre-gl.js';
const MAPLIBRE_CSS_URL = 'vendor/maplibre/maplibre-gl.css';
// 【注意】classicな（type="module"ではない）<script>内のimport()は、
// "vendor/..."のような接頭辞なしの相対指定を「ベア指定子」（importmapが
// 無いと解決できない）として扱い、"Failed to resolve module specifier"で
// 失敗する。"./"を付けて明示的な相対URLにすること（実機で発覚・修正済み）。
const TERRAIN_MODULE_URL = './vendor/maplibre/terrain-map-view.js';

/**
 * 重いライブラリを読み込む前の軽いWebGL対応チェック。
 * failIfMajorPerformanceCaveatで、ソフトウェアレンダリングのみ（事実上使い物に
 * ならない）の環境もここで弾く。これがfalseなら、MapLibre本体もterrain-map-view.js
 * も一切読み込まない（無駄なネットワーク要求をしない）。
 */
export function isWebglLikelySupported() {
  try {
    const canvas = document.createElement('canvas');
    const ctx =
      canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: true }) ||
      canvas.getContext('webgl', { failIfMajorPerformanceCaveat: true });
    return !!(ctx && typeof ctx.getParameter === 'function');
  } catch {
    return false;
  }
}

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === 'true') { resolve(); return; }
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error(`スクリプト読み込み失敗: ${src}`)));
      return;
    }
    const el = document.createElement('script');
    el.src = src;
    el.addEventListener('load', () => { el.dataset.loaded = 'true'; resolve(); });
    el.addEventListener('error', () => reject(new Error(`スクリプト読み込み失敗: ${src}`)));
    document.head.appendChild(el);
  });
}

function loadStylesheetOnce(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const el = document.createElement('link');
  el.rel = 'stylesheet';
  el.href = href;
  document.head.appendChild(el);
}

let loadPromise = null;

/**
 * MapLibre GL JS本体＋terrain-map-view.jsモジュールを読み込み、
 * {TerrainMapView}を返す。多重呼び出しは同じPromiseに合流する。
 * 失敗時はキャッシュを捨てて次回また最初から試せるようにする。
 */
export function loadTerrainModule() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    if (!isWebglLikelySupported()) {
      throw new Error('WebGLが利用できない環境のため3D地図は使用できません');
    }
    loadStylesheetOnce(MAPLIBRE_CSS_URL);
    await loadScriptOnce(MAPLIBRE_JS_URL);
    if (typeof maplibregl === 'undefined') {
      throw new Error('MapLibre GL JSの読み込みに失敗しました');
    }
    return import(TERRAIN_MODULE_URL);
  })().catch((e) => {
    loadPromise = null;
    throw e;
  });
  return loadPromise;
}

/**
 * 前回3Dを選んだ端末でだけ呼ぶ想定（呼び出し側でmapMode==='3d'を確認する）。
 * ページの読み込みが落ち着いたあと（requestIdleCallback）にMapLibre一式を
 * 先読みしておき、実際に3Dへ切り替わるタイミング（検索結果が出た直後）までに
 * 読み込みを終わらせておく。失敗しても何もしない（実際の切替時に改めて
 * loadTerrainModule()が呼ばれ、通常のエラー処理に従う）。
 */
export function preloadTerrainModuleWhenIdle() {
  const schedule = window.requestIdleCallback || ((cb) => setTimeout(cb, 300));
  schedule(() => {
    loadTerrainModule().catch(() => {});
  });
}
