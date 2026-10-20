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
        // 【2026-10-13、22本目、不具合修正】invalidateSize()単体だと既存
        // マーカーの画面上の位置が直らないことがあったため、forceMarkerReposition()
        // （invalidateSize+setView+marker.update()の3段階、map-view.js参照）に
        // 統一した。
        // 【不具合修正、2回目】「一覧」タブを見ながら検索した場合、render()の
        // fitToBudget()はコンテナが非表示（isContainerVisible()がfalse）の間は
        // 何もしない設計のため、地図を一度もfitBounds/setViewしていない
        // （Leaflet内部のmap._loadedがfalseのまま）。forceMarkerReposition()は
        // _loadedがfalseだと何もせず戻る安全策を持つため、この順番
        // （forceMarkerReposition→refitBounds）だと「まだ一度もfitされていない
        // 地図」に対してマーカーの再投影が素通りされ、ずれた位置のまま残って
        // しまっていた（実機相当の検証、[2D/sp]のピンクリックで発覚：
        // 画面外のx座標でクリックが失敗していた）。refitBounds()
        // （fitBounds()を呼び、_loadedを確定させる）を先に行ってから
        // forceMarkerReposition()（確定した地図を基準にマーカーを再投影）を
        // 呼ぶ順に直した（refitBounds()自体が、地図がまだ一度もfitBounds/
        // setViewされていない場合のLeaflet内部キャッシュの問題に対処する。
        // map-view.jsのrefitBounds()のコメント参照）。
        // 【40本目】以下の一連の処理（invalidateSize→refitBounds→forceMarkerReposition→
        // 保留していた塗り替え・波の演出のやり直し）は、2D/3D切替で2Dに戻ったときにも
        // 同じことが必要だったため、MapView.handleShown()へまとめた（円の描き直しも追加）。
        // タブ切替では従来どおり、毎回検索直後の見え方へ合わせ直す（forceRefit:true）。
        this.mapView.handleShown({ forceRefit: true });
      }
      if (this.terrainMapView?.map) {
        this.terrainMapView.resize();
      }
    });
  }
}
