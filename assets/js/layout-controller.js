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
      // 部品の列の高さ（2D/3Dの切り替え・戻るボタンの出し入れで変わる）も見る
      const cluster = document.getElementById('map-controls-cluster');
      if (cluster) this._resizeObserver.observe(cluster);
      // 【57本目】検索カードの中身の高さ（金額帯の案内・「条件が変わりました」の出し入れ）が変わったら、入りきるか測り直す
      const form = document.getElementById('search-form');
      if (form) this._resizeObserver.observe(form);
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
    // 右下の部品の列（ズーム＋−・方位磁針・戻るボタン・ハンドル）と出典が入るのに要る高さ。スマホでは、地図の下に
    // 重ねる入れ物がこの分を空けて縮む（style.cssの--map-controls-room）。部品の列の高さは2D/3D・検索の前後で変わる。
    const cluster = document.getElementById('map-controls-cluster');
    const room = cluster ? Math.round(cluster.getBoundingClientRect().height + 52) : 120;
    const roomValue = `${room}px`;
    if (this.layoutEl.style.getPropertyValue('--map-controls-room') !== roomValue) {
      this.layoutEl.style.setProperty('--map-controls-room', roomValue);
    }
    this.fitSearchCard();
  }

  /**
   * 【2026-10-25、57本目、Minami指示】検索カードが低い画面（400×464など）でも、カードの中をスクロールせずに
   * 出発駅・予算・スライダー・「この条件で探す」・「データ出典・免責」が見えるようにする。入りきらないときは、
   * 説明文（.search-card-lead）→ 例のボタン（.search-examples）の順に外し、それでも入らなければ
   * 行の間を詰める（.search-card-tight）。それでも入らないときは、今までどおりカードの中をスクロールする。
   * いったんすべて外してから測り直す（画面が広くなったときに戻すため）。
   */
  fitSearchCard() {
    const card = document.getElementById('layout-left');
    if (!card) return;
    const steps = ['search-card-no-lead', 'search-card-no-examples', 'search-card-tight'];
    steps.forEach((c) => card.classList.remove(c));
    if (getComputedStyle(card).display !== 'none') {
      for (const c of steps) {
        if (card.scrollHeight <= card.clientHeight + 1) break;
        card.classList.add(c);
      }
    }
    // 自分でクラスを付け外しした分の変化は、測り直しのきっかけにしない（付け外しのたびに呼ばれ続けないため。
    // ここはupdateInsets()の中なので、それまでに来ていた変化はもう測り終えている）。
    if (this._mutationObserver) this._mutationObserver.takeRecords();
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
