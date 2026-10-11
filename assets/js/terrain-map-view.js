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

// 【2026-10-11、5本目】俯瞰（fitToBudget）の引きすぎ対策：余白は地図の大きさの
// 比率（短辺の8%）にし、ズームの下限（9.5）を設ける。maxZoomではなく下限で
// 抑えるのは、Minami指示「上限で入りきらない点は画面の外に出てよい」ため
// （fitBoundsのmaxZoomは「寄りすぎ」を防ぐ上限であり、「引きすぎ」を防ぐ
// 下限が無いのが今回の不具合だった）。
const OVERVIEW_PADDING_RATIO = 0.08;
const OVERVIEW_MIN_ZOOM = 9.5;
// 場所に寄ったときの見え方（Minami指示：ズーム14前後、pitch60前後）。
const SPOT_FOCUS_ZOOM = 14;
const SPOT_FOCUS_PITCH = 60;
const SPOT_FOCUS_DURATION_MS = 2600; // Minami指示：2〜3秒
// 寄ったあと操作が無ければゆっくり回る演出（Minami指示：1周40秒程度）。
const AUTO_ROTATE_MS_PER_REV = 40000;
const AUTO_ROTATE_START_DELAY_MS = 500; // flyTo完了後、少し間を置いてから回り始める

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

/**
 * 2点間の方位角（北=0°、時計回り）を返す。地点1→地点2の向き。
 * MapLibreのbearingは「その方位が画面奥（遠景）に来る」向き（4本目④、立山方向
 * カメラの実機確認で確定済み）のため、出発駅→スポットの方位角をそのまま
 * bearingに使えば「出発駅が手前、スポットが奥」になる（Minami指示）。
 */
function computeBearing(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaLambda = toRad(lon2 - lon1);
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
    this._autoRotateFrame = null; // requestAnimationFrameのID（ゆっくり回る演出）
    this._autoRotateStartTimer = null;
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
      // 【2026-10-11、5本目】視点を回せるようにする（Minami指示：PC=右ドラッグ
      // /Ctrl+ドラッグ、スマホ=2本指でひねって回転・2本指の上下で傾き、
      // 1本指は今までどおり移動）。MapLibreの既定ハンドラがこの組み合わせを
      // そのまま提供する（dragRotateが右ドラッグ/Ctrl+ドラッグ、
      // touchZoomRotateが2本指ひねり、touchPitchが2本指上下）ため、明示的に
      // 有効化するだけで追加の実装は不要。
      dragRotate: true,
      touchZoomRotate: true,
      touchPitch: true,
      pitchWithRotate: true,
    });

    // 方角コンパス（Minami指示：地図右上、押すと北向きに戻る＝
    // NavigationControlの既定動作）。ズームボタンは出さない（+/-は別UIで
    // 既にある）。
    this.map.addControl(
      new maplibregl.NavigationControl({ showCompass: true, showZoom: false, visualizePitch: false }),
      'top-right'
    );

    // 【2026-10-11】ユーザーが手で地図を動かしたら、ゆっくり回る演出を止める
    // （Minami指示）。*startイベントはユーザー操作（ドラッグ・ピンチ等）の
    // ハンドラ起点でのみ発火し、プログラム側のjumpTo/easeTo/flyToや
    // このクラス自身のsetBearing()連打（_runAutoRotateStep）では発火しない
    // （MapLibreの既定動作。実装を確認して確定）。
    ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart', 'wheel'].forEach((evt) => {
      this.map.on(evt, () => this._stopAutoRotate());
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
      // 【2026-10-11、5本目】地図の点をタップしたら、その場所へ寄る
      // （Minami指示）。ポップアップ自体は従来どおり出す（「詳細を見る」導線は残す）。
      this.flyToSpot(feature.properties, this._lastDepartureStation);
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
   *
   * 【2026-10-11修正、5本目】固定96pxの余白・maxZoom13のみ（下限無し）だと、
   * 予算を上げて対象範囲が北陸全体規模に広がったとき、画面に対して相対的に
   * 余白が小さすぎる・引きの下限が無いため「斜めになっただけの遠景」まで
   * 引いてしまい、3Dの良さが見えなくなっていた（Minami実機確認）。
   * 余白を地図の大きさの比率（短辺の8%）にし、引きの下限（ズーム9.5）を
   * 設けた。下限はMapLibreのfitBounds自体には無い（maxZoomは寄りすぎを防ぐ
   * 上限専用）ため、cameraForBounds()で計算だけ行い、結果のズームが下限を
   * 下回ったら9.5に引き上げてeaseToで適用する。下限で全点が入りきらない
   * 場合は出発駅を中心にする（Minami指示：入りきらない点は画面の外に出てよい）。
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

    const container = this.map.getContainer();
    const shortSide = Math.max(1, Math.min(container.clientWidth, container.clientHeight));
    const padding = Math.round(shortSide * OVERVIEW_PADDING_RATIO);

    const camera = this.map.cameraForBounds(bounds, { padding, pitch: DEFAULT_PITCH });
    if (!camera) return;
    const zoomBelowFloor = camera.zoom < OVERVIEW_MIN_ZOOM;
    const zoom = zoomBelowFloor ? OVERVIEW_MIN_ZOOM : camera.zoom;
    const center = zoomBelowFloor && this._lastDepartureStation
      ? [this._lastDepartureStation.stop_lon, this._lastDepartureStation.stop_lat]
      : camera.center;

    this._stopAutoRotate();
    this.map.easeTo({ center, zoom, pitch: DEFAULT_PITCH, bearing: this.map.getBearing(), duration: 600 });
  }

  /**
   * 指定したスポットへ寄る（Minami指示、5本目：地図の点をタップした/一覧の
   * カードを選んだ/詳細画面を開いたとき）。向き（bearing）は出発駅→スポットの
   * 方位角そのまま（出発駅が手前、スポットが奥になる。4本目④の立山方向
   * カメラで確定済みのbearingの向き）。
   * @param {{latitude:number, longitude:number}} spot
   * @param {{stop_lat:number, stop_lon:number}} [departureStation]
   */
  flyToSpot(spot, departureStation) {
    if (!this.map || !isFiniteNumber(spot?.latitude) || !isFiniteNumber(spot?.longitude)) return;
    let bearing = this.map.getBearing();
    if (departureStation && isFiniteNumber(departureStation.stop_lat) && isFiniteNumber(departureStation.stop_lon)) {
      bearing = computeBearing(departureStation.stop_lat, departureStation.stop_lon, spot.latitude, spot.longitude);
    }
    this._stopAutoRotate();
    this.map.flyTo({
      center: [spot.longitude, spot.latitude],
      zoom: SPOT_FOCUS_ZOOM,
      pitch: SPOT_FOCUS_PITCH,
      bearing,
      duration: SPOT_FOCUS_DURATION_MS,
      essential: true,
    });
    this._scheduleAutoRotateAfterFlight();
  }

  /** flyTo完了（'moveend'）後、少し間を置いてゆっくり回る演出を始める。 */
  _scheduleAutoRotateAfterFlight() {
    if (!this.map || prefersReducedMotion()) return;
    this.map.once('moveend', () => {
      if (this._autoRotateStartTimer) clearTimeout(this._autoRotateStartTimer);
      this._autoRotateStartTimer = setTimeout(() => this._startAutoRotate(), AUTO_ROTATE_START_DELAY_MS);
    });
  }

  _startAutoRotate() {
    if (!this.map || this._autoRotateFrame || prefersReducedMotion()) return;
    let previousTime = null;
    const step = (time) => {
      if (!this.map) { this._autoRotateFrame = null; return; }
      if (previousTime != null) {
        const deltaMs = time - previousTime;
        this.map.setBearing(this.map.getBearing() + (360 / AUTO_ROTATE_MS_PER_REV) * deltaMs);
      }
      previousTime = time;
      this._autoRotateFrame = requestAnimationFrame(step);
    };
    this._autoRotateFrame = requestAnimationFrame(step);
  }

  /** ユーザー操作（ドラッグ・ズーム・回転・傾き・ホイール）で呼ばれ、演出を止める。 */
  _stopAutoRotate() {
    if (this._autoRotateStartTimer) {
      clearTimeout(this._autoRotateStartTimer);
      this._autoRotateStartTimer = null;
    }
    if (this._autoRotateFrame) {
      cancelAnimationFrame(this._autoRotateFrame);
      this._autoRotateFrame = null;
    }
  }

  /**
   * 標高タイル（gsi-dem）の、現在の表示範囲に必要なタイルの読み込みが
   * 完了するまで待つ（2026-10-10、Minami指摘：地形が立ち上がる前に
   * スクリーンショットを撮ってしまい、平らなままかすみがかかったように
   * 見えていた）。
   *
   * 【2026-10-11修正】「地形読み込み完了」が「平らな地図」より速く終わる
   * （setTerrain()は平らな地図のload後にしか呼ばないため、原理的に
   * 起こり得ない）という矛盾をMinamiが指摘。原因を推測せず実機トレースで
   * 確認したところ、以下が判明した：
   * - MapLibreはdemタイルを1回の要求にまとめず、複数バッチに分けて要求する
   *   （実測：富山駅前で最初のバッチ約13枚が片付いた時点でisSourceLoaded()が
   *   一瞬trueになるが、44ms後には次のバッチの要求（'dataloading'）が始まり、
   *   最終的に計34枚・3つ以上のバッチに分かれて1秒以上かけて完了していた）。
   * - 旧実装は最初の'sourcedata'（isSourceLoaded===true）だけを見て即resolve
   *   していたため、最初のバッチだけで「完了」と誤判定していた。
   * - Minami指摘の「demソース未追加／タイル0枚要求時点でtrueになっている」説も
   *   確認したが、これは実際には起きていなかった（最初にtrueになった時点で
   *   既に12〜13枚が要求・変換済みだった）。「タイルを1枚以上要求済み」を
   *   条件に加えるだけでは、この多バッチ問題は防げない（trueになる時点で
   *   既に1枚以上要求済みのため、条件を満たしてしまう）。
   * 対策：isSourceLoaded()がtrueになってから一定時間（settleMs）、新しい
   * タイル要求（'dataloading'）が来ないことを確認してから完了とする
   * （新しいバッチが来ればsettleタイマーを取り消し、再度仕切り直す）。
   * これにより、Minamiが挙げた3条件（demソース追加済み／タイル1枚以上
   * 要求済み／isSourceLoaded()==true）に加えて「それ以上バッチが来ない」
   * という第4の条件を満たした時点で初めて完了とする。
   * @param {number} [timeoutMs]
   * @param {number} [settleMs] - isSourceLoaded()==true後、新規タイル要求が
   *   来ないことを確認する猶予（実測の最短バッチ間隔44msに対し十分な余裕を見た）
   * @returns {Promise<boolean>} 読み込み完了ならtrue、タイムアウトならfalse
   */
  waitForTerrainLoaded(timeoutMs = 20000, settleMs = 400) {
    if (!this.map) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settleTimer = null;
      const finish = (result) => {
        clearTimeout(timeout);
        if (settleTimer) clearTimeout(settleTimer);
        this.map.off('sourcedata', onSourceData);
        this.map.off('dataloading', onDataLoading);
        resolve(result);
      };
      const timeout = setTimeout(() => finish(false), timeoutMs);
      const scheduleSettleCheck = () => {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          settleTimer = null;
          if (this.map.isSourceLoaded(DEM_SOURCE_ID)) finish(true);
        }, settleMs);
      };
      const onDataLoading = (e) => {
        if (e.sourceId !== DEM_SOURCE_ID) return;
        // 新しいタイルの読み込みが始まった＝まだ完了していない。保留中の
        // settle確認があれば取り消す（新バッチの到着で仕切り直す）。
        if (settleTimer) {
          clearTimeout(settleTimer);
          settleTimer = null;
        }
      };
      const onSourceData = (e) => {
        if (e.sourceId !== DEM_SOURCE_ID) return;
        if (this.map.isSourceLoaded(DEM_SOURCE_ID)) scheduleSettleCheck();
        else if (settleTimer) {
          clearTimeout(settleTimer);
          settleTimer = null;
        }
      };
      this.map.on('dataloading', onDataLoading);
      this.map.on('sourcedata', onSourceData);
      // 呼び出し時点で既にtrueの場合も、新規バッチが来ないかsettle確認する
      // （タイルが0枚要求の時点でtrueになっている場合も、直後に要求が始まれば
      // onDataLoadingがsettleタイマーを取り消すため、正しく未完了扱いになる）。
      if (this.map.isSourceLoaded(DEM_SOURCE_ID)) scheduleSettleCheck();
    });
  }

  resize() {
    if (this.map) this.map.resize();
  }

  /** 2D切替時・再試行時にWebGLコンテキストを確実に解放する（上限超過による失敗を防ぐ） */
  destroy() {
    this._stopAutoRotate();
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
    this.departureMarker = null;
    this.popup = null;
  }
}
