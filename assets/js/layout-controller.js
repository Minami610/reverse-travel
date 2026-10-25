/**
 * layout-controller.js - 地図を画面いっぱいに出すレイアウトの制御（56本目で作り直し）
 *
 * 【2026-10-25、56本目、Minami決定】ヘッダーの下はすべて地図（#map-area）にし、検索カード（#layout-left）と
 * 結果の入れ物（.layout-right）を地図の上に重ねる。以前の「PCは二段組・スマホは一覧／地図タブ」と、
 * #map-areaをPC用・スマホ用の置き場所の間で付け替える仕組みはやめた（地図はいつも同じ場所にある）。
 *
 * ここでやること：
 * - 地図の上に重ねている入れ物（data-map-overlayの付いた要素のうち、見えているもの）の画面上の四角を
 *   1か所で返す（getMapOverlayRects()）。57本目の円の合わせ方（ア：重ねた入れ物を除いた見えている範囲で
 *   円を合わせる）で使う。
 * - スマホで地図の下側に重なっている入れ物の高さを、CSSの変数（#app-layoutの--map-inset-bottom）に入れる。
 *   右下の部品の列・出典・名前の帯が、その上に出るようにするため。
 * - 画面の大きさが変わったら、地図の大きさを測り直す。
 *
 * ブレークポイントは assets/css/style.css の `@media (min-width: 760px)` と必ず一致させること。
 */

const DESKTOP_QUERY = '(min-width: 760px)';
const OVERLAY_SELECTOR = '[data-map-overlay]';

/**
 * 地図の上に重ねている入れ物（見えているものだけ）の、画面上の四角（getBoundingClientRect()の値）。
 * @returns {Array<{el: Element, left: number, top: number, right: number, bottom: number, width: number, height: number}>}
 */
export function getMapOverlayRects() {
  const out = [];
  document.querySelectorAll(OVERLAY_SELECTOR).forEach((el) => {
    if (el.hidden) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return;
    out.push({ el, left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height });
  });
  return out;
}

export class LayoutController {
  constructor({ mapEl, layoutEl, mapView, terrainMapView, onListTabActivated }) {
    this.mapEl = mapEl;
    this.layoutEl = layoutEl;
    this.mapView = mapView;
    // 3DのMapLibreインスタンス自体は3D切替が実際に行われるまで生成されない（main.jsが生成後に差し替える）。
    this.terrainMapView = terrainMapView;
    this.onListTabActivated = onListTabActivated || null;
    this.mediaQuery = window.matchMedia(DESKTOP_QUERY);

    this.mediaQuery.addEventListener('change', () => {
      this.updateInsets();
      this.invalidateMapSize();
    });
    window.addEventListener('resize', () => this.updateInsets());
    // 入れ物の大きさ・出し入れが変わったら、地図の下側の余白を測り直す。
    if (typeof ResizeObserver === 'function') {
      this._resizeObserver = new ResizeObserver(() => this.updateInsets());
      document.querySelectorAll(OVERLAY_SELECTOR).forEach((el) => this._resizeObserver.observe(el));
    }
    if (typeof MutationObserver === 'function' && this.layoutEl) {
      // 検索カード⇔結果の入れ物の切り替え（#app-layoutのクラス・hidden属性）でも測り直す。
      // 地図のピン（#map-areaの中）のクラスは頻繁に変わるため、subtreeは見ない（#app-layout自身と入れ物だけ）。
      this._mutationObserver = new MutationObserver(() => this.updateInsets());
      const opts = { attributes: true, attributeFilter: ['class', 'hidden', 'data-view'] };
      this._mutationObserver.observe(this.layoutEl, opts);
      document.querySelectorAll(OVERLAY_SELECTOR).forEach((el) => this._mutationObserver.observe(el, opts));
    }
    this.updateInsets();
  }

  isDesktop() {
    return this.mediaQuery.matches;
  }

  /** 地図の上に重ねている入れ物の四角（getMapOverlayRects()と同じ）。 */
  overlayRects() {
    return getMapOverlayRects();
  }

  /**
   * スマホで、地図の下側に重なっている入れ物（地図の下の端に接しているもの）の高さを
   * #app-layoutの--map-inset-bottomに入れる。PCは0（入れ物は左上・左に浮かせるため）。
   */
  updateInsets() {
    if (!this.layoutEl || !this.mapEl) return;
    let insetBottom = 0;
    if (!this.isDesktop()) {
      const map = this.mapEl.getBoundingClientRect();
      getMapOverlayRects().forEach((r) => {
        // 下の端から少し浮かせて置いている入れ物（スマホの検索カードは下に8pxのすき間）も、下側に重なっているものとして数える。
        if (r.bottom >= map.bottom - 24) insetBottom = Math.max(insetBottom, map.bottom - r.top);
      });
    }
    const value = `${Math.max(0, Math.round(insetBottom))}px`;
    if (this.layoutEl.style.getPropertyValue('--map-inset-bottom') !== value) {
      this.layoutEl.style.setProperty('--map-inset-bottom', value);
    }
  }

  /** 以前の「一覧／地図」タブの切り替え。タブはやめたため、地図の大きさを測り直すだけ。 */
  activateTab(tabName) {
    if (tabName === 'map') this.invalidateMapSize();
    else if (tabName === 'list' && this.onListTabActivated) requestAnimationFrame(() => this.onListTabActivated());
  }

  invalidateMapSize() {
    requestAnimationFrame(() => {
      if (this.mapView.map) this.mapView.handleShown({ forceRefit: false });
      if (this.terrainMapView?.map) this.terrainMapView.resize();
    });
  }
}
