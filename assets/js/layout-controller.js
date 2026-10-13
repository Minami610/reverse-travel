/**
 * layout-controller.js - PC二段組（sticky）⇔ スマホタブ切替のレイアウト制御
 *
 * #map-area（2D用#spots-mapと3D用#spots-map-3dを重ねて持つラッパー）は
 * 単一のDOMノードとして保持し、画面幅に応じてPC用スロット（左カラム内、
 * sticky）とスマホ用スロット（「地図」タブパネル内）の間で付け替える。
 * 地図インスタンスは再生成せず、ノードを移動してから invalidateSize()
 * （3Dはresize()）でサイズ再計算するだけにすることで、マーカーや選択状態を
 * 保持したまま切り替えられる（2026-10-10、4本目①で#spots-map単体から
 * #map-areaラッパーに変更。2D/3Dどちらも同じラッパーごと移動するため、
 * このファイル自体の付け替えロジックに変更はない）。
 *
 * ブレークポイントは assets/css/style.css の `@media (min-width: 760px)` と
 * 必ず一致させること（ズレるとCSSとJSで二段組/タブ切替の判定が食い違う）。
 */

const DESKTOP_QUERY = '(min-width: 760px)';

export class LayoutController {
  constructor({ mapEl, desktopSlot, mobileSlot, tabButtons, tabPanels, mapView, terrainMapView, onListTabActivated }) {
    this.mapEl = mapEl;
    this.desktopSlot = desktopSlot;
    this.mobileSlot = mobileSlot;
    this.tabButtons = Array.from(tabButtons || []);
    this.tabPanels = Array.from(tabPanels || []);
    this.mapView = mapView;
    // 3DのMapLibreインスタンス自体は3D切替が実際に行われるまで生成されない
    // （TerrainMapViewオブジェクトは常に存在するが、中のthis.mapはnullのまま）。
    // invalidateMapSize()側でmapの有無を見て無視するため、ここでは常に受け取る。
    this.terrainMapView = terrainMapView;
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
    // fitBoundsのやり直し（非表示中に描画されて範囲がずれている場合の補正）を行う。
    // 2D・3Dのどちらが実際に表示中かはCSS（#map-area.mode-3d）に任せており
    // ここでは判定しない。3Dが未初期化（this.terrainMapViewがnull、または
    // 生成済みでもthis.map===null）のときはresize()を呼ばない
    // （TerrainMapView自体は3D切替が一度も行われるまで生成されない。4本目②の
    // 遅延読込。main.jsが生成後にthis.terrainMapViewを差し替える）。
    requestAnimationFrame(() => {
      if (this.mapView.map) {
        this.mapView.map.invalidateSize();
        this.mapView.refitBounds();
        // コンテナが0×0の間にスライダーが動かされ、マーカーの塗り替えを
        // 保留していた場合（MapView.applyBudget参照）、実寸を得たここで
        // 改めて反映する。
        if (this.mapView.lastBudget != null) this.mapView.applyBudget(this.mapView.lastBudget);
        // 【2026-10-13、10本目②】検索時に地図タブが非表示（コンテナ0×0）だった
        // ため、波のように点を出す演出が空振りに終わっていた場合、実寸を得た
        // ここで改めてやり直す（MapView._startWaveReveal参照）。
        if (this.mapView._pendingWaveReveal) {
          this.mapView._pendingWaveReveal = false;
          this.mapView._startWaveReveal();
        }
      }
      if (this.terrainMapView?.map) {
        this.terrainMapView.resize();
      }
    });
  }
}
