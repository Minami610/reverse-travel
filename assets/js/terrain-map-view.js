/**
 * terrain-map-view.js - 検索結果を俯瞰する3D地形地図（MapLibre GL JS + 国土地理院
 * 標準地図・標高タイル）。4本目①「3D地図の土台」。feature/3d-mapブランチ。
 *
 * 【設計】2Dのmap-view.js（Leaflet）は既定のまま残し、このクラスは3D切替時にのみ
 * 使う。MapLibre GL JS本体（gzip約240KB）はバンドルに含めず、3Dへの切替が
 * 実際に行われたときだけ<script>/<link>を動的に挿入して読み込む（遅延読込）。
 * 読み込み・WebGL対応チェック・地図初期化のいずれかに失敗した場合は、
 * 例外を投げて呼び出し元（main.js）に伝える。呼び出し元はエラー文言を出さず
 * 2Dのまま据え置く（Minami指示）。
 *
 * 標高タイルは国土地理院の dem_png を gsi-dem-protocol.js
 * （maplibregl.addProtocol）経由で読み、本来の区分式で標高を復元した上で
 * terrarium符号化に変換してMapLibreへ渡す（詳細は同ファイルのコメント参照）。
 */

import { registerGsiDemProtocol } from './gsi-dem-protocol.js';
import { buildSpotPopupHtml, isFiniteNumber } from './map-view.js';

const MAPLIBRE_JS_URL = 'vendor/maplibre/maplibre-gl.js';
const MAPLIBRE_CSS_URL = 'vendor/maplibre/maplibre-gl.css';

const GSI_STD_TILE_URL = 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png';
const GSI_DEM_PROTOCOL_TILE_URL = 'gsidem://https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png';
const GSI_STD_ATTRIBUTION =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>';
const GSI_DEM_ATTRIBUTION = '国土地理院の標高タイルを加工して3D地形として表示';

const DEFAULT_PITCH = 57; // Minami指示：55〜60の中間
const DEFAULT_ZOOM = 9;
const DEFAULT_EXAGGERATION = 2; // Minami指示：2〜2.5倍から開始

let protocolRegistered = false; // addProtocolは多重登録を避ける（2回目以降は上書きになるだけだが、意図を明示するためフラグで一度だけに絞る）

/** 動的<script>/<link>読み込み。読み込み済みなら何もしない。失敗時はreject。 */
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

/**
 * 重いライブラリを読み込む前の軽いWebGL対応チェック（maplibreglがまだ無い前提）。
 * failIfMajorPerformanceCaveatで、ソフトウェアレンダリングのみ（事実上使い物に
 * ならない）の環境もここで弾く。
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

export class TerrainMapView {
  constructor(containerId) {
    this.containerId = containerId;
    this.map = null;
    this.markers = [];
    this.onDetailRequest = null;
    this._lastDepartureStation = null;
    this._lastSpots = null;
  }

  /**
   * ライブラリの動的読み込み＋WebGL対応チェック。対応していなければ例外を投げる。
   * 【2026-10-10】当初はmaplibregl.supported()も二重チェックとして呼ぶ想定だったが、
   * 実機確認でvendor化したv5.6.1にはこの関数が存在しないことが判明した（実装を
   * 確認したところ公開APIから削除されている）。isWebglLikelySupported()による
   * 生のcanvas.getContext('webgl'/'webgl2', {failIfMajorPerformanceCaveat:true})
   * チェックのみで判定する（ライブラリ読み込み前に行うため、非対応環境では
   * 243KB gzipのスクリプト自体を読み込まずに済む）。
   */
  async ensureLibraryLoaded() {
    if (typeof maplibregl !== 'undefined') return;
    if (!isWebglLikelySupported()) {
      throw new Error('WebGLが利用できない環境のため3D地図は使用できません');
    }
    loadStylesheetOnce(MAPLIBRE_CSS_URL);
    await loadScriptOnce(MAPLIBRE_JS_URL);
    if (typeof maplibregl === 'undefined') {
      throw new Error('MapLibre GL JSの読み込みに失敗しました');
    }
  }

  /**
   * 3D地図を初期化する（初回のみ。2回目以降・多重呼び出し時は同じPromiseを
   * 返す。連打等での二重初期化によるWebGLコンテキストの無駄遣いを防ぐ）。
   * @param {{lat:number, lon:number}} center - 出発駅の緯度経度
   */
  ensureMap(center) {
    if (this.map) return Promise.resolve();
    if (this._ensureMapPromise) return this._ensureMapPromise;
    this._ensureMapPromise = this._createMap(center).finally(() => {
      this._ensureMapPromise = null;
    });
    return this._ensureMapPromise;
  }

  async _createMap(center) {
    await this.ensureLibraryLoaded();
    if (this.map) return;

    if (!protocolRegistered) {
      registerGsiDemProtocol(maplibregl, 'gsidem');
      protocolRegistered = true;
    }

    this.map = new maplibregl.Map({
      container: this.containerId,
      style: {
        version: 8,
        sources: {
          'gsi-std': {
            type: 'raster',
            tiles: [GSI_STD_TILE_URL],
            tileSize: 256,
            maxzoom: 18,
            attribution: GSI_STD_ATTRIBUTION,
          },
          'gsi-dem': {
            type: 'raster-dem',
            tiles: [GSI_DEM_PROTOCOL_TILE_URL],
            tileSize: 256,
            maxzoom: 14,
            encoding: 'terrarium',
            attribution: GSI_DEM_ATTRIBUTION,
          },
        },
        layers: [{ id: 'gsi-std-layer', type: 'raster', source: 'gsi-std' }],
        terrain: { source: 'gsi-dem', exaggeration: DEFAULT_EXAGGERATION },
      },
      center: [center.lon, center.lat],
      zoom: DEFAULT_ZOOM,
      pitch: DEFAULT_PITCH,
      bearing: 0,
      maxPitch: 75,
    });

    // 個別タイルの取得失敗（圏外・海上のdem_png未整備域など）はログに残すのみで
    // 地図自体は壊さない（MapLibreは失敗したタイルを単に描画しないだけ）。
    // mapレベルの致命的エラー（スタイル自体の不正等）はここでは区別せず、
    // 初期化シーケンス全体の失敗は呼び出し元のtry/catchに委ねる。

    // 検証用の参照（queryTerrainElevationでの標高確認・Playwrightでのカメラ操作など）。
    // アプリ自体はこれを使わない。本番でも害はないため条件分岐は入れていない。
    window.__terrainMapForDebug = this.map;

    this.map.on('popupopen', (e) => {
      const el = e.popup.getElement();
      const btn = el && el.querySelector('.popup-detail-btn');
      if (!btn) return;
      btn.addEventListener('click', () => {
        const spotId = btn.getAttribute('data-spot-id');
        if (this.onDetailRequest) this.onDetailRequest(spotId);
      });
    });

    await new Promise((resolve, reject) => {
      this.map.once('load', resolve);
      this.map.once('error', (e) => reject(e.error || new Error('3D地図の初期化に失敗しました')));
    });

    if (this._lastDepartureStation || this._lastSpots) {
      this.render(this._lastDepartureStation, this._lastSpots || []);
    }
  }

  /**
   * @param {{display_name:string, stop_lat:number, stop_lon:number}} departureStation
   * @param {Array} spots
   */
  render(departureStation, spots) {
    this._lastDepartureStation = departureStation;
    this._lastSpots = spots;
    if (!this.map) return; // ensureMap前に呼ばれた場合は、座標だけ保持して後でensureMapから反映する

    this.markers.forEach((m) => m.remove());
    this.markers = [];

    if (departureStation && isFiniteNumber(departureStation.stop_lat) && isFiniteNumber(departureStation.stop_lon)) {
      const marker = new maplibregl.Marker({ color: '#e06c2c' })
        .setLngLat([departureStation.stop_lon, departureStation.stop_lat])
        .setPopup(new maplibregl.Popup({ offset: 20 }).setText(`${departureStation.display_name}（出発駅）`))
        .addTo(this.map);
      this.markers.push(marker);
    }

    (spots || []).forEach((spot) => {
      if (!isFiniteNumber(spot.latitude) || !isFiniteNumber(spot.longitude)) return;
      const marker = new maplibregl.Marker({ color: '#3a8f3a' })
        .setLngLat([spot.longitude, spot.latitude])
        .setPopup(new maplibregl.Popup({ offset: 20 }).setHTML(buildSpotPopupHtml(spot)))
        .addTo(this.map);
      this.markers.push(marker);
    });
  }

  resize() {
    if (this.map) this.map.resize();
  }

  /** 2D切替時・再試行時にWebGLコンテキストを確実に解放する（上限超過による失敗を防ぐ） */
  destroy() {
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
    this.markers = [];
  }
}
