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
// 【59本目】スマホで、地図の高さがこれより低い画面（400×464の地図は416px）では、下の一覧の小を見出しの1行だけにする
// （横のカードを出すと見えている範囲が狭くなりすぎるため。375×667の地図は619px、390×844は796px）。
const SHEET_COMPACT_MAX_MAP_HEIGHT = 560;
// 【59本目】下の一覧の大の高さ（地図の高さに対する比）。上の＋−カードの下までは伸ばさない。
const SHEET_LARGE_RATIO = 0.6;
const SHEET_LARGE_MIN_VISIBLE_MAP = 150;
const SHEET_LARGE_MIN_HEIGHT = 160;
// 右下の部品の列と出典が入るのに、部品の列の高さに足す余地（出典の行と上下のすき間。--map-controls-roomと同じ）
const CONTROLS_EXTRA_ROOM = 52;

/**
 * 地図の上に重ねている入れ物（見えているものだけ）の、画面上の四角（getBoundingClientRect()の値）。
 * @returns {Array<{el: Element, left: number, top: number, right: number, bottom: number, width: number, height: number}>}
 */
export function getMapOverlayRects() {
  const out = [];
  document.querySelectorAll(OVERLAY_SELECTOR).forEach((el) => {
    if (el.hidden) return;
    // 【58本目】PCで一覧を閉じたときの細いバー（data-map-overlay="bar"）は、地図を覆う入れ物ではなく、円が避ける部品として扱う
    if (el.getAttribute('data-map-overlay') === 'bar') return;
    // 【59本目】入れ物の中の入れ物（PCの一覧パネルの中の上の部分・下の部分）は、外の入れ物で数える
    const outer = el.parentElement && el.parentElement.closest(OVERLAY_SELECTOR);
    if (outer && getComputedStyle(outer).display !== 'contents') return;
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
      this._applyResultsListState();
      this.updateInsets();
      this.invalidateMapSize();
    });
    // 【58本目】PCの結果画面で、左の一覧パネルを開いているか（閉じると地図の左上の細いバーになる）。
    // ＋−・検索し直し・「条件を変える」をまたいで覚えておく。スマホには関係しない（59本目）。
    this._resultsListOpen = true;
    this._resultsPanel = document.querySelector('.results-panel');
    // 【59本目】スマホの結果画面で、下の一覧が大か（小⇔大）。開け閉めと同じく、＋−・検索し直しをまたいで覚えておく。
    this._sheetLarge = false;
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

  /** 【58本目】PCの結果画面で、左の一覧パネルを開いているか。 */
  isResultsListOpen() {
    return this._resultsListOpen;
  }

  /**
   * 【58本目】PCの結果画面で、左の一覧パネルを開く・閉じる（#app-layoutの.results-list-closed）。
   * 閉じている間、パネルは地図の左上の細いバーになり、地図を覆う入れ物（見えている範囲から除く）ではなく、
   * 円が避ける部品になる（data-map-overlay="bar"。map-view.js・terrain-map-view.jsのvisibleMapRect()と
   * circleObstacleRects()）。
   * @param {boolean} open
   * @returns {boolean} 変わったか
   */
  setResultsListOpen(open) {
    if (this._resultsListOpen === open) return false;
    this._resultsListOpen = open;
    this._applyResultsListState();
    this.updateInsets();
    return true;
  }

  /** 【59本目】スマホの結果画面で、下の一覧が大か。 */
  isSheetLarge() {
    return this._sheetLarge;
  }

  /**
   * 【59本目】スマホの結果画面で、下の一覧を大・小にする（#app-layoutの.sheet-large）。PCでは見た目は変わらない。
   * @param {boolean} large
   * @returns {boolean} 変わったか（スマホのときだけ）
   */
  setSheetLarge(large) {
    if (this._sheetLarge === large) return false;
    this._sheetLarge = large;
    this.layoutEl?.classList.toggle('sheet-large', large);
    const handle = document.getElementById('results-sheet-handle');
    if (handle) {
      handle.setAttribute('aria-expanded', String(large));
      handle.setAttribute('aria-label', large ? '一覧を小さくする' : '一覧を大きくする');
    }
    this.updateInsets();
    return !this.isDesktop();
  }

  _applyResultsListState() {
    const closed = !this._resultsListOpen && this.isDesktop();
    this.layoutEl?.classList.toggle('results-list-closed', closed);
    if (this._resultsPanel) this._resultsPanel.setAttribute('data-map-overlay', closed ? 'bar' : '');
    if (this._mutationObserver) this._mutationObserver.takeRecords();
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
    this.updateSheetLayout();
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
    const room = cluster ? Math.round(cluster.getBoundingClientRect().height + CONTROLS_EXTRA_ROOM) : 120;
    const roomValue = `${room}px`;
    if (this.layoutEl.style.getPropertyValue('--map-controls-room') !== roomValue) {
      this.layoutEl.style.setProperty('--map-controls-room', roomValue);
    }
    this.fitControlsCluster(insetBottom);
    this.fitSearchCard();
    this.placeMapDataLine();
    if (this._mutationObserver) this._mutationObserver.takeRecords();
  }

  /**
   * 【59本目】スマホの結果画面の下の一覧：低い画面では小を見出しだけにし（.sheet-compact）、大の高さ
   * （--sheet-large-h）を地図の高さから決める。上の＋−カードの下の端（--results-head-bottom）も測る
   * （名前の帯をそのすぐ下に出す・下の一覧が上の＋−カードにかからないようにするため）。
   */
  updateSheetLayout() {
    const map = this.mapEl.getBoundingClientRect();
    const mobile = !this.isDesktop();
    this.layoutEl.classList.toggle('sheet-compact', mobile && map.height < SHEET_COMPACT_MAX_MAP_HEIGHT);
    const head = document.querySelector('.results-head');
    const hb = head?.getBoundingClientRect();
    const headBottom = mobile && hb && hb.height > 0 ? Math.round(hb.bottom - map.top) : 0;
    const setVar = (name, value) => {
      if (this.layoutEl.style.getPropertyValue(name) !== value) this.layoutEl.style.setProperty(name, value);
    };
    setVar('--results-head-bottom', `${headBottom}px`);
    const avail = Math.max(0, map.height - headBottom - 8);
    // 大でも、地図の見えている範囲を少なくともSHEET_LARGE_MIN_VISIBLE_MAPは残す（400×464では、地図の60%まで伸ばすと
    // 見えている範囲が81pxしか残らず、円が最低ズームでも入りきらなかった）。ただし大の一覧が低くなりすぎないよう、
    // SHEET_LARGE_MIN_HEIGHTより低くはしない。
    const large = Math.max(Math.min(map.height * SHEET_LARGE_RATIO, avail - SHEET_LARGE_MIN_VISIBLE_MAP), Math.min(avail, SHEET_LARGE_MIN_HEIGHT));
    setVar('--sheet-large-h', `${Math.round(large)}px`);
  }

  /**
   * 【59本目】スマホで、右下の部品の列（ズーム＋−・方位磁針・戻るボタン・ハンドル）と出典が、上の＋−カードと
   * 下の一覧の間に入りきらないときは、まずズーム＋−を隠し（指でつまんで拡大・縮小できるため）、それでも
   * 入らなければ部品の列ごと隠す（見本⑥の大きい一覧には部品の列が無い）。PCでは何も隠さない。
   * 入りきるかは、いったんすべて出してから測る（大きさが変わったときに戻すため）。
   * @param {number} insetBottom 地図の下側に重なっている入れ物の高さ
   */
  fitControlsCluster(insetBottom) {
    const cluster = document.getElementById('map-controls-cluster');
    if (!cluster) return;
    cluster.classList.remove('cluster-no-zoom', 'cluster-hidden');
    if (this.isDesktop()) return;
    const map = this.mapEl.getBoundingClientRect();
    const head = document.querySelector('.results-head');
    const hb = head?.getBoundingClientRect();
    const top = hb && hb.height > 0 ? hb.bottom - map.top : 0;
    const space = map.height - insetBottom - top;
    if (cluster.getBoundingClientRect().height + CONTROLS_EXTRA_ROOM <= space) return;
    cluster.classList.add('cluster-no-zoom');
    if (cluster.getBoundingClientRect().height + CONTROLS_EXTRA_ROOM <= space) return;
    cluster.classList.add('cluster-hidden');
  }

  /**
   * 【58本目】PCで一覧を閉じている間の「データ出典・免責」（#map-data-line）を、地図の右下の出典の文字の
   * すぐ左に置く（出典は開くと横に広がるため、出典の左の端から測る。#app-layoutの--map-attrib-room）。
   */
  placeMapDataLine() {
    if (!this.layoutEl || !this.mapEl) return;
    const mode3d = this.mapEl.classList.contains('mode-3d');
    const attrib = this.mapEl.querySelector(mode3d ? '#spots-map-3d .maplibregl-ctrl-attrib' : '#spots-map .leaflet-control-attribution');
    if (attrib && this._resizeObserver && !attrib.dataset.layoutObserved) {
      // 出典を開く・閉じると幅が変わる。そのたびに置き直す。
      attrib.dataset.layoutObserved = '1';
      this._resizeObserver.observe(attrib);
    }
    const map = this.mapEl.getBoundingClientRect();
    const b = attrib?.getBoundingClientRect();
    const room = b && b.width > 0 ? Math.round(map.right - b.left + 8) : 40;
    const value = `${Math.max(0, room)}px`;
    if (this.layoutEl.style.getPropertyValue('--map-attrib-room') !== value) {
      this.layoutEl.style.setProperty('--map-attrib-room', value);
    }
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
