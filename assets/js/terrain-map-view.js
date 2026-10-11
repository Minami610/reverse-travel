/**
 * terrain-map-view.js - 検索結果を俯瞰する3D地形地図（MapLibre GL JS + 国土地理院
 * 標準地図・標高タイル）。4本目「3D地図」。feature/3d-mapブランチ。
 *
 * 【2026-10-10、4本目②】このファイル自体はdist/index.htmlにインライン化せず、
 * MapLibre本体と同じくvendor/maplibre/配下の別ファイルとして3D切替時にのみ
 * 動的importされる（terrain-loader.js参照。2Dの人のページを重くしないため）。
 * そのため、他のアプリJS（inlined）が使うmap-view.jsのbuildSpotPopupHtml等は
 * importせず、同等のものをこのファイル内に小さく複製している
 * （inline化されたバンドルとこのファイルは実行時に別スコープのため、
 * importで繋ぐとどちらかが二重に読み込まれる・束ねられない）。
 *
 * 標高タイルはgsi-dem-protocol.js（maplibregl.addProtocol）経由で読み、
 * 本来の区分式で標高を復元した上でterrarium符号化に変換してMapLibreへ渡す。
 *
 * 【2026-10-10、4本目②】初回表示を速く感じさせるため、地形(terrain)は
 * スタイルの初期値に含めず、背景の平らな地図が表示し終わってから
 * setTerrain()で付け足す（Minami指示）。標高タイルのmaxzoomは12に抑え、
 * それより深いズームはMapLibreの自動オーバーズーム（z12タイルの拡大）に
 * 任せる（DEM10Bの整備範囲がz2〜12であることに合わせ、変換対象タイル数も
 * 抑えられる）。
 *
 * 【2026-10-10、4本目③】検索結果の点は、予算スライダーの動きに合わせて
 * 再取得・再構築せずに塗り直せるよう、個々のmaplibregl.Markerではなく
 * 1つのGeoJSONソース＋circleレイヤーで描く（setFilter/setPaintPropertyの
 * 更新だけで済み、スライダー1コマごとにDOM/オブジェクトを作り直さない）。
 */

const GSI_STD_TILE_URL = 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png';
const GSI_DEM_PROTOCOL_TILE_URL = 'gsidem://https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png';
const GSI_STD_ATTRIBUTION =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>';
const GSI_DEM_ATTRIBUTION = '国土地理院の標高タイルを加工して3D地形として表示';

const DEFAULT_PITCH = 57; // Minami指示：55〜60の中間
const DEFAULT_ZOOM = 9;
const DEFAULT_EXAGGERATION = 2; // Minami指示：2〜2.5倍から開始
const DEM_MAXZOOM = 12; // Minami指示：DEM10Bの範囲に抑え、それ以上は自動オーバーズーム

const BAND_WIDTH = 200; // 予算の帯の幅（既存の2D検索・一覧と同じ定義）
const SPOTS_SOURCE_ID = 'spots';
const SPOTS_LAYER_ID = 'spots-circle';
const DEM_SOURCE_ID = 'gsi-dem';
const HILLSHADE_LAYER_ID = 'hillshade-layer';

// 帯に入る点＝明るいオレンジ＋光の輪、それより安い点＝緑がかった灰色の小さい点
// （2026-10-10、Minami指摘：スクリーンショットで見分けづらかったため色を変更。
// 2D(map-view.js)と揃える）。
const COLOR_IN_BAND = '#FF6B2B';
const COLOR_CHEAPER = '#8a9a86';

let protocolRegistered = false; // addProtocolは多重登録を避ける（2回目以降は上書きになるだけだが、意図を明示するためフラグで一度だけに絞る）

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** map-view.js（inlined側）のbuildSpotPopupHtmlと同内容の複製（上部コメント参照）。 */
function buildSpotPopupHtml(spot) {
  const shortDescription = spot.description
    ? spot.description.length > 60
      ? `${spot.description.substring(0, 60)}...`
      : spot.description
    : '説明情報がありません';

  return `
    <div class="map-popup">
      <strong class="map-popup-title">${spot.name}</strong>
      <p class="map-popup-description">${shortDescription}</p>
      <button type="button" class="popup-detail-btn" data-spot-id="${spot.id}">詳細を見る</button>
    </div>
  `;
}

/** 現在の予算に応じた塗り分け式（circle-radius等）。予算を超える点はfilter側で出さない。 */
function inBandExpr(budget) {
  return ['>', ['get', 'fare'], budget - BAND_WIDTH];
}

export class TerrainMapView {
  constructor(containerId) {
    this.containerId = containerId;
    this.map = null;
    this.departureMarker = null;
    this.popup = null;
    this.onDetailRequest = null;
    this._lastDepartureStation = null;
    this._lastSpots = null;
    this._lastBudget = null;
  }

  /**
   * 3D地図を初期化する（初回のみ。2回目以降・多重呼び出し時は同じPromiseを
   * 返す。連打等での二重初期化によるWebGLコンテキストの無駄遣いを防ぐ）。
   * 返るPromiseは「平らな背景地図が表示し終わった」時点で解決する（Minami指示：
   * 地形は表示が終わってから付ける）。地形の読み込み自体は裏側で続く。
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
    if (!protocolRegistered) {
      const { registerGsiDemProtocol } = await import('./gsi-dem-protocol.js');
      registerGsiDemProtocol(maplibregl, 'gsidem');
      protocolRegistered = true;
    }

    this.map = new maplibregl.Map({
      container: this.containerId,
      // 出典はMapLibre標準の右下attributionではなく、compact（iボタンで開く）に
      // する（Minami指示：スマホで地図をふさいでいた）。位置は切替ボタン
      // （左下）と重ならないよう明示的に右下へ固定し、自前のAttributionControlを
      // 後から追加する（下のaddControl参照）。
      attributionControl: false,
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
          [DEM_SOURCE_ID]: {
            type: 'raster-dem',
            tiles: [GSI_DEM_PROTOCOL_TILE_URL],
            tileSize: 256,
            maxzoom: DEM_MAXZOOM,
            encoding: 'terrarium',
            attribution: GSI_DEM_ATTRIBUTION,
          },
          [SPOTS_SOURCE_ID]: {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          },
        },
        layers: [
          { id: 'gsi-std-layer', type: 'raster', source: 'gsi-std' },
          // 起伏を見えやすくする陰影（Minami指示）。同じ標高データから計算するため
          // 標高タイルの変換自体は1回で済む（追加のネットワーク取得は発生しない）。
          // 控えめな濃さにして、下の標準地図の色を潰さないようにする。
          {
            id: HILLSHADE_LAYER_ID,
            type: 'hillshade',
            source: DEM_SOURCE_ID,
            paint: {
              // 【2026-10-11修正】陰影が強く、地図全体が灰色にくすんで見えると
              // Coworkがスクリーンショットで指摘（exaggeration0.6・影#3a3a2aは
              // 平地の地理院地図の色まで暗く潰していた）。誇張を0.3に弱め、
              // 影の色も彩度を落として地図の色を邪魔しないようにした。
              'hillshade-exaggeration': 0.3,
              'hillshade-illumination-direction': 315,
              'hillshade-shadow-color': '#6b6b5f',
              'hillshade-highlight-color': '#fffdf5',
            },
          },
          {
            id: SPOTS_LAYER_ID,
            type: 'circle',
            source: SPOTS_SOURCE_ID,
            paint: {
              'circle-radius': 5,
              'circle-color': '#ffffff',
              'circle-opacity': 0.35,
              'circle-stroke-width': 0,
              'circle-stroke-color': '#ffffff',
              'circle-blur': 0,
            },
          },
        ],
        // 空と遠くの霞（控えめに）。Minami指示。MapLibre v5.6.1にはMapbox系の
        // 独立した「fog」APIが無い（実装を確認して確定。sky-horizon-blendが
        // 遠景を空の色へ溶け込ませる、霞に近い効果を持つ）。
        sky: {
          'sky-color': '#bcdcf2',
          'sky-horizon-blend': 0.5,
        },
        // 【Minami指示】地形は初期スタイルに含めない。平らな背景が表示し
        // 終わってからsetTerrain()で付け足す（下のmap.once('load', ...)参照）。
      },
      center: [center.lon, center.lat],
      zoom: DEFAULT_ZOOM,
      pitch: DEFAULT_PITCH,
      bearing: 0,
      maxPitch: 75,
    });

    this.map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    // 【2026-10-10】MapLibreのcompact属性は、出典の文字列が変わるたび
    // （'styledata'/'sourcedata'/'terrain'イベント。地図を生成した直後は
    // 標高タイルがterrainとして使われ始める等で何度も変わる）に、
    // ドラッグされるまで開いた状態（<details open>・maplibregl-compact-show
    // クラス）へ戻す作りになっている（実装を確認して確定）。1回だけ畳んでも
    // 次の属性変化で再び開いてしまうため、同じイベントで毎回畳み直す。
    // ただしこれを無期限に続けると、ユーザーが(i)ボタンを押して自分で
    // 開いた直後にもタイル読み込みイベントで強制的に畳んでしまい、
    // 出典を読めなくなる。初期表示が落ち着く（標高タイル読み込み完了）までの
    // 間だけ畳み直し、以降はユーザー操作に任せる。
    const collapseAttribution = () => {
      const attribEl = this.map.getContainer().querySelector('.maplibregl-ctrl-attrib');
      if (attribEl) {
        attribEl.removeAttribute('open');
        attribEl.classList.remove('maplibregl-compact-show');
      }
    };
    collapseAttribution();
    this.map.on('styledata', collapseAttribution);
    this.map.on('sourcedata', collapseAttribution);
    this.map.on('terrain', collapseAttribution);
    const stopCollapsing = () => {
      this.map.off('styledata', collapseAttribution);
      this.map.off('sourcedata', collapseAttribution);
      this.map.off('terrain', collapseAttribution);
    };
    this.waitForTerrainLoaded().then(stopCollapsing);
    setTimeout(stopCollapsing, 20000); // 読み込みが長引く・失敗する場合の保険

    // 検証用の参照（queryTerrainElevationでの標高確認・Playwrightでのカメラ操作など）。
    // アプリ自体はこれを使わない。本番でも害はないため条件分岐は入れていない。
    window.__terrainMapForDebug = this.map;
    window.__terrainViewForDebug = this; // waitForTerrainLoaded()等、ラッパー側のメソッドの検証用

    this.popup = new maplibregl.Popup({ offset: 12, closeButton: true });
    this.map.on('click', SPOTS_LAYER_ID, (e) => {
      const feature = e.features && e.features[0];
      if (!feature) return;
      this.popup.setLngLat(e.lngLat).setHTML(buildSpotPopupHtml(feature.properties)).addTo(this.map);
    });
    this.map.on('mouseenter', SPOTS_LAYER_ID, () => { this.map.getCanvas().style.cursor = 'pointer'; });
    this.map.on('mouseleave', SPOTS_LAYER_ID, () => { this.map.getCanvas().style.cursor = ''; });
    this.map.on('popupopen', (e) => {
      const el = e.popup.getElement();
      const btn = el && el.querySelector('.popup-detail-btn');
      if (!btn) return;
      btn.addEventListener('click', () => {
        const spotId = btn.getAttribute('data-spot-id');
        if (this.onDetailRequest) this.onDetailRequest(spotId);
      });
    });

    // 【2026-10-10修正】hillshadeレイヤーを追加したことで、初期表示の時点から
    // 標高タイルも取得されるようになった。標高タイルは地点によって存在しない
    // （海上・DEM10B未整備域）ことがあり、個々のタイルの取得失敗はMapLibreが
    // 'error'イベントとして出すが、これは「そのタイルが描画されないだけ」で
    // 地図全体の初期化失敗ではない。以前は'error'を1回受けただけで
    // ensureMap()全体を失敗扱いにしており、実際に1枚でも圏外タイルがあると
    // 3D化そのものが失敗する不具合があった（実機で発覚）。'load'イベント
    // （スタイル・ソース自体の初期化完了）だけを待ち、個々のタイル失敗では
    // 失敗させない。'load'が合理的な時間内に来ない場合だけタイムアウトで
    // 失敗させる。
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('3D地図の初期化がタイムアウトしました')), 30000);
      this.map.once('load', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    // 平らな地図の表示が終わった後に地形を付ける（Minami指示）。
    // addSourceでgsi-demは既に宣言済みのため、setTerrainは標高タイルの
    // 取得・変換を裏側で開始するだけで、この呼び出し自体は同期的に返る。
    this.map.setTerrain({ source: 'gsi-dem', exaggeration: DEFAULT_EXAGGERATION });

    if (this._lastDepartureStation || this._lastSpots) {
      this.render(this._lastDepartureStation, this._lastSpots || [], this._lastBudget);
    }
  }

  /**
   * @param {{display_name:string, stop_lat:number, stop_lon:number}} departureStation
   * @param {Array} spots - 予算¥2000で一度取得したallSpots全体（予算の絞り込みはapplyBudget側で行う）
   * @param {number} [budget] - 初期表示の予算。省略時は2000（全件が「少し薄い」状態で見える）
   */
  render(departureStation, spots, budget) {
    this._lastDepartureStation = departureStation;
    this._lastSpots = spots;
    this._lastBudget = budget;
    if (!this.map) return; // ensureMap前に呼ばれた場合は、座標だけ保持して後でensureMapから反映する

    if (this.departureMarker) {
      this.departureMarker.remove();
      this.departureMarker = null;
    }
    if (departureStation && isFiniteNumber(departureStation.stop_lat) && isFiniteNumber(departureStation.stop_lon)) {
      this.departureMarker = new maplibregl.Marker({ color: '#e06c2c' })
        .setLngLat([departureStation.stop_lon, departureStation.stop_lat])
        .setPopup(new maplibregl.Popup({ offset: 20 }).setText(`${departureStation.display_name}（出発駅）`))
        .addTo(this.map);
    }

    const features = (spots || [])
      .filter((spot) => isFiniteNumber(spot.latitude) && isFiniteNumber(spot.longitude))
      .map((spot) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [spot.longitude, spot.latitude] },
        properties: { ...spot, fare: spot.source_round_trip_fare },
      }));
    const source = this.map.getSource(SPOTS_SOURCE_ID);
    if (source) source.setData({ type: 'FeatureCollection', features });

    this.applyBudget(budget ?? 2000);
  }

  /**
   * 予算スライダーの1コマ分。データの再取得は行わず、既存のGeoJSONソースに
   * setFilter/setPaintPropertyを適用するだけ（Minami指示：計算は¥2000で
   * 一度出したallSpotsから帯で絞るだけで足りる）。
   * 帯（budget-200〜budget）の件数は毎回同期的に計算して返す（軽い配列操作のため
   * 間引く必要はない）。実際の塗り替え（setFilter/setPaintProperty）はMinami指示で
   * requestAnimationFrame 1コマに1回へ間引く（CPU4倍下で最大85msかかっていた
   * スライダー1コマを50ms以内に収めるため）。
   * @param {number} budget
   * @returns {number} 帯内の件数
   */
  applyBudget(budget) {
    this._lastBudget = budget;
    const count = (this._lastSpots || []).filter(
      (s) => s.source_round_trip_fare <= budget && s.source_round_trip_fare > budget - BAND_WIDTH
    ).length;

    this._pendingPaintBudget = budget;
    if (!this._paintScheduled) {
      this._paintScheduled = true;
      requestAnimationFrame(() => {
        this._paintScheduled = false;
        this._paintBudget(this._pendingPaintBudget);
      });
    }
    return count;
  }

  _paintBudget(budget) {
    if (!this.map || !this.map.getLayer(SPOTS_LAYER_ID)) return;
    const inBand = inBandExpr(budget);
    this.map.setFilter(SPOTS_LAYER_ID, ['<=', ['get', 'fare'], budget]);
    // 帯に入る点＝大きめ＋光の輪（ぼかし+白縁）、それより安い点＝緑がかった灰色の
    // 小さい点（Minami指摘：見分けづらかったため色・形とも区別を強めた）。
    this.map.setPaintProperty(SPOTS_LAYER_ID, 'circle-radius', ['case', inBand, 10, 4]);
    this.map.setPaintProperty(SPOTS_LAYER_ID, 'circle-color', ['case', inBand, COLOR_IN_BAND, COLOR_CHEAPER]);
    this.map.setPaintProperty(SPOTS_LAYER_ID, 'circle-opacity', ['case', inBand, 0.95, 0.55]);
    this.map.setPaintProperty(SPOTS_LAYER_ID, 'circle-stroke-width', ['case', inBand, 3, 0]);
    this.map.setPaintProperty(SPOTS_LAYER_ID, 'circle-stroke-color', '#ffffff');
    this.map.setPaintProperty(SPOTS_LAYER_ID, 'circle-blur', ['case', inBand, 0.5, 0]);
  }

  /**
   * スライダーを指から離したときに呼ぶ。帯に入る点・安い点（=budget以下すべて）が
   * 画面に収まるよう、滑らかにカメラを引く/寄せる（Minami指示）。
   * ドラッグ中は呼ばない（カクつき防止）。
   * 【2026-10-10修正】¥2000選択時に点が画面端からはみ出る不具合をMinamiが
   * スクリーンショットで発見。paddingを48→96に広げた（pitchを付けた3D視点では
   * 奥行き方向の圧縮で見かけ上の余白が足りなくなりやすいため、2Dより大きめに取る）。
   */
  fitToBudget(budget) {
    if (!this.map) return;
    const visible = (this._lastSpots || []).filter(
      (s) => isFiniteNumber(s.latitude) && isFiniteNumber(s.longitude) && s.source_round_trip_fare <= budget
    );
    if (visible.length === 0) return;
    const lngs = visible.map((s) => s.longitude);
    const lats = visible.map((s) => s.latitude);
    if (this._lastDepartureStation) {
      lngs.push(this._lastDepartureStation.stop_lon);
      lats.push(this._lastDepartureStation.stop_lat);
    }
    const bounds = [
      [Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)],
    ];
    this.map.fitBounds(bounds, { padding: 96, maxZoom: 13, duration: 600, pitch: DEFAULT_PITCH });
  }

  /**
   * 標高タイル（gsi-dem）の、現在の表示範囲に必要なタイルの読み込みが
   * 完了するまで待つ（2026-10-10、Minami指摘：地形が立ち上がる前に
   * スクリーンショットを撮ってしまい、平らなままかすみがかかったように
   * 見えていた）。'idle'（全タイル・周辺余白まで含めて待つ）より直接的で
   * 速く解決する、isSourceLoaded()＋'sourcedata'イベントを使う。
   * @param {number} [timeoutMs]
   * @returns {Promise<boolean>} 読み込み完了ならtrue、タイムアウトならfalse
   */
  waitForTerrainLoaded(timeoutMs = 20000) {
    if (!this.map) return Promise.resolve(false);
    if (this.map.isSourceLoaded(DEM_SOURCE_ID)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const onData = (e) => {
        if (e.sourceId !== DEM_SOURCE_ID) return;
        if (!this.map.isSourceLoaded(DEM_SOURCE_ID)) return;
        clearTimeout(timeout);
        this.map.off('sourcedata', onData);
        resolve(true);
      };
      const timeout = setTimeout(() => {
        this.map.off('sourcedata', onData);
        resolve(false);
      }, timeoutMs);
      this.map.on('sourcedata', onData);
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
    this.departureMarker = null;
    this.popup = null;
  }
}
