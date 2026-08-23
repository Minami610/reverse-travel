/**
 * layout-controller.js - PC二段組（sticky）⇔ スマホタブ切替のレイアウト制御
 *
 * #spots-map（Leaflet地図の実体）は単一のDOMノードとして保持し、
 * 画面幅に応じてPC用スロット（左カラム内、sticky）とスマホ用スロット
 * （「地図」タブパネル内）の間で付け替える。地図インスタンスは
 * 再生成せず、ノードを移動してから invalidateSize() でサイズ再計算するだけ
 * にすることで、マーカーや選択状態を保持したまま切り替えられる。
 *
 * ブレークポイントは assets/css/style.css の `@media (min-width: 760px)` と
 * 必ず一致させること（ズレるとCSSとJSで二段組/タブ切替の判定が食い違う）。
 */

const DESKTOP_QUERY = '(min-width: 760px)';

export class LayoutController {
  constructor({ mapEl, desktopSlot, mobileSlot, tabButtons, tabPanels, mapView, onListTabActivated }) {
    this.mapEl = mapEl;
    this.desktopSlot = desktopSlot;
    this.mobileSlot = mobileSlot;
    this.tabButtons = Array.from(tabButtons || []);
    this.tabPanels = Array.from(tabPanels || []);
    this.mapView = mapView;
    this.onListTabActivated = onListTabActivated || null;
    this.mediaQuery = window.matchMedia(DESKTOP_QUERY);
    this.currentTab = 'list';

    // ブラウザの拡大率変更もmatchMediaのchangeとして発火する。
    // 地図のスロット移動だけでなく、タブの表示状態（一覧⇔地図）も
    // CSSの再評価だけに委ねず明示的に再同期し、どちらのレイアウトにも
    // 属さない中途半端な表示（タブが出ないまま縦積みになる等）を防ぐ。
    this.mediaQuery.addEventListener('change', () => {
      this.applyMapSlot();
      this.activateTab(this.currentTab);
    });
    this.tabButtons.forEach((btn) => {
      btn.addEventListener('click', () => this.activateTab(btn.dataset.tab));
    });

    this.applyMapSlot();
    this.activateTab('list');
  }

  isDesktop() {
    return this.mediaQuery.matches;
  }

  applyMapSlot() {
    const targetSlot = this.isDesktop() ? this.desktopSlot : this.mobileSlot;
    if (this.mapEl.parentElement !== targetSlot) {
      targetSlot.appendChild(this.mapEl);
    }
    this.invalidateMapSize();
  }

  activateTab(tabName) {
    this.currentTab = tabName;
    this.tabButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    this.tabPanels.forEach((panel) => {
      panel.classList.toggle('active', panel.dataset.tabPanel === tabName);
    });

    if (tabName === 'map') {
      this.invalidateMapSize();
    } else if (tabName === 'list' && this.onListTabActivated) {
      // display:none → 表示への切り替え直後はまだレイアウトが確定していないため、
      // 次フレームで（＝表示が反映された後に）呼び出す
      requestAnimationFrame(() => this.onListTabActivated());
    }
  }

  invalidateMapSize() {
    // display:none から表示に切り替わった直後はコンテナ寸法が
    // 確定していないことがあるため、次フレームでサイズ再計算＋
    // fitBoundsのやり直し（非表示中に描画されて範囲がずれている場合の補正）を行う
    requestAnimationFrame(() => {
      if (!this.mapView.map) return;
      this.mapView.map.invalidateSize();
      this.mapView.refitBounds();
    });
  }
}
