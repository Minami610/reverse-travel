/**
 * map-view.js - 検索結果を俯瞰する地図（Leaflet + 国土地理院のベクトル地図）
 *
 * 【2026-10-21、43本目D（44本目で差し替え）、Minami決定】下地の地図は、国土地理院のベクトル地図
 * （地理院地図Vector）を地図記号なし・アプリの色にしたもの（3Dと共通。scripts/build-map-style.js）。
 * Leafletはベクトル地図を描けないため、MapLibreをLeafletの層の1枚として重ねる（L.maplibreGL）。
 * MapLibreの読み込みが終わるまでと、WebGLが使えない環境では、淡色地図の画像タイルを出す
 * （以前の標準地図は情報が多くごちゃごちゃしていた、Minami実機確認）。
 *
 * Google Maps 等の商用APIは使わず、地理院タイル（無料・出典明示のみで利用可）を
 * 採用している。Leaflet本体はバンドル時にインライン化されるため、地図の
 * タイル画像取得のみがネットワーク通信を要する（オフライン時は地図が
 * 表示されないが、それ以外の機能には影響しない）。
 *
 * 出典：国土地理院（https://maps.gsi.go.jp/development/ichiran.html）。
 * 利用規約上、ウェブサイト上でのリアルタイム読み込みは出典明示のみで
 * 申請不要（大量一括ダウンロード等は対象外）。
 */
import { loadVectorBaseMapForLeaflet } from './terrain-loader.js';

// 【43本目D】ベクトル地図を読み込むまで・WebGLが使えない環境で出す、淡色地図の画像タイル
// （以前は標準地図std）。
const GSI_TILE_URL = 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png';
const GSI_ATTRIBUTION =
  '<a href="https://maps.gsi.go.jp/vector/" target="_blank" rel="noopener">国土地理院</a>'; // 【43本目】ベクトル地図の出典と同じ短い表記（同じ文字列ならLeafletは1つにまとめて出す）
// 【43本目】地図の上の出典は短くする（scripts/build-map-style.jsのsources.attributionと同じ。
// 長いとPCの地図の下の情報枠が狭まり、場所の名前が見えなくなるため）。
const GSI_VECTOR_ATTRIBUTION =
  '<a href="https://maps.gsi.go.jp/vector/" target="_blank" rel="noopener">国土地理院</a>';
// 予算の帯の幅（既存の検索・一覧と同じ定義）。main.jsにも同名の定数があるが、
// バンドル後は同じスクリプトスコープに連結されるため、名前が衝突しないよう
// このファイルだけMAP_BAND_WIDTHという別名にしている。
const MAP_BAND_WIDTH = 200;
// 【2026-10-13、10本目②】予算の到達範囲の円・波の演出用の定数・関数。
// 同じ理由（バンドル後は同一スクリプトスコープ）で、他ファイル（onward-candidates.js
// 等）の同種の関数と衝突しない名前にしている。
const WAVE_DURATION_MS = 1000; // Minami指示：検索後、点を波のように出す所要時間（全体で1秒前後）
// 【2026-10-13、12本目①】選んだピンが下の情報帯（高さ40px前後）に隠れないよう、
// 地図をずらす量（px）。帯はスマホでは地図下端から48px浮かせて出すため
// （style.css参照）、帯の高さ＋余白を見込んだ値にする（PCは帯が地図の下端
// 近くに収まるため、この値より少なく済むが、同じ値でも実害はない）。
const REVEAL_ABOVE_BAND_OFFSET_PX = 90;
const EARTH_RADIUS_KM = 6371;
const toRadReach = (d) => (d * Math.PI) / 180;
const toDegReach = (r) => (r * 180) / Math.PI;

function reachHaversineKm(lat1, lon1, lat2, lon2) {
  const phi1 = toRadReach(lat1);
  const phi2 = toRadReach(lat2);
  const dPhi = toRadReach(lat2 - lat1);
  const dLambda = toRadReach(lon2 - lon1);
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 始点から指定の方位角・距離(km)だけ進んだ地点を返す（3D側のdestinationPoint()と
 * 同じ球面三角法。Leaflet流に[lat, lon]で返す）。到達円「全体」を画面に収める
 * fitCircleToView()の外接範囲（N/E/S/W）の計算に使う。 */
function reachDestinationPoint(lat, lon, bearingDeg, distanceKm) {
  const delta = distanceKm / EARTH_RADIUS_KM;
  const theta = toRadReach(bearingDeg);
  const phi1 = toRadReach(lat);
  const lambda1 = toRadReach(lon);
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
  const lambda2 = lambda1 + Math.atan2(
    Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
    Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2)
  );
  return [toDegReach(phi2), toDegReach(lambda2)];
}

// 【2026-10-17、32本目B、Minami決定】予算の±・スライダー操作：まず円の半径を
// なめらかに変え、最後の操作から少し止まったら、円「全体」が収まるよう
// 地図を合わせる。3D（terrain-map-view.js）の同名の定数と同じ値・考え方だが、
// バンドル後は別スクリプトとして遅延読込される3D側と違い、2D（map-view.js）は
// main.js等と同じグローバルスコープに連結されるため、名前の衝突を避けて
// MAP_接頭辞を付けている（MAP_BAND_WIDTHと同じ理由）。
// 【2026-10-20、35本目、Minami決定】待ち時間短縮：円0.25秒→0.2秒・
// デバウンス0.4秒→0.15秒・地図を合わせる動き0.7秒→0.45秒。
const MAP_CIRCLE_RADIUS_ANIM_MS = 200;
const MAP_CIRCLE_FIT_DEBOUNCE_MS = 150;
const MAP_CIRCLE_FIT_DURATION_SEC = 0.45;
// 【2026-10-20、35本目、Minami決定：A】「地図を合わせたあと、円の直径が
// 見えている範囲の短い辺の7〜8割になるように」という目標から、3D側の
// CIRCLE_FIT_TARGET_DIAMETER_RATIOと同じ考え方で余白の比率を決める
// （2Dは方位磁針・ハンドルが無いため、3D側のような右側の追加余白は不要）。
// 【2026-10-21、41本目、Minami決定：C】0.75→0.6。金額が大きくなって地図が引いたあと、
// ＋を押しても円の広がりが小さく見えた（40本目の計測：＋1回で縁が動くのはPCで30px前後、
// 400×464で15px前後）。地図を合わせたときの円を小さめにして、広がる余地を残す。
// 金額操作で9割をこえたときも、3.5割を下回ったときも、この0.6に合わせる。
const MAP_CIRCLE_FIT_TARGET_DIAMETER_RATIO = 0.6;
// 【2026-10-19、34本目、Minami決定：B】「全体を見る」・検索直後の全体表示
// （fitToBudget()、2Dはこの定数を使わず別途maxZoom:16のみで下限なし）は
// 変えない。円を合わせるとき（fitCircleToView()）だけ、小さいスマホで
// 円が枠に収まらないことがあるため、3D側のCIRCLE_FIT_MIN_ZOOMと同じ
// 考え方でゆるい下限（8.5）にする。
// 【37本目】検索直後（36本目）・「全体を見る」（37本目）もfitCircleToView()に
// 揃えたため、今は円に合わせるすべての場面でこの8.5が下限になる。
const MAP_CIRCLE_FIT_MIN_ZOOM = 8.5;
// 【2026-10-20、37本目、Minami決定：A】金額操作のあと、地図を動かすのは
// 「円がはみ出しそう」「小さくなりすぎた」ときだけにする（35本目は毎回0.75へ
// 合わせ直していたため、金額を足しても画面上の円がほとんど大きくならず、
// 新しいエリアが開けた感じが無かった）。円の直径÷見えている範囲の短辺が
// 上限（0.9）をこえたら0.75へ引き、下限（0.35）を下回ったら0.6へ寄る。
// その間は地図を動かさず、円だけが広がる・縮む。
// 【41本目】9割をこえたときの行き先も0.75→0.6（MAP_CIRCLE_FIT_TARGET_DIAMETER_RATIO）。
const MAP_CIRCLE_REFIT_UPPER_RATIO = 0.9;
const MAP_CIRCLE_REFIT_LOWER_RATIO = 0.35;
const MAP_CIRCLE_ZOOM_IN_TARGET_RATIO = 0.6;
// 【2026-10-20、37本目、Minami決定：B2】＋で円が広がるとき、前の縁から新しい縁へ
// うすい青の線（波）を1本だけ広げて消す。色は円の縁と同じ青、太さ3px、
// 0.5秒で、はじめ少し濃く→広がりながらうすくなる。白い光・ぼかし・点滅は使わない。
const MAP_CIRCLE_WAVE_DURATION_MS = 500;
const MAP_CIRCLE_WAVE_START_OPACITY = 0.7;
const MAP_CIRCLE_WAVE_WEIGHT = 3;
const MAP_REACH_CIRCLE_COLOR = '#2F6FB2';

/** 到達円の半径表記（例: 0.8km, 12km）。10km未満は小数第1位まで、以上は整数に丸める。
 * 【2026-10-14、25本目】地図上のラベルを廃止し、main.jsのスマホ予算操作帯・PCの
 * 帯件数プレビューで距離を出すため、main.jsからimportして使えるようexportする。 */
// 【2026-10-21、43本目、Minami決定：B】近いピンを数字の入った丸にまとめる。画面上で
// この距離（px）以内のピン同士を1つの丸にする（ピンの直径13px＋まとめた丸の大きさを見込んだ値）。
// このズーム以上ではまとめない（同じ場所に重なっている場所がいつまでも分かれないのを防ぐ）。
const MAP_PIN_CLUSTER_RADIUS_PX = 36;
const MAP_PIN_CLUSTER_MAX_ZOOM = 16;

/**
 * 【2026-10-21、43本目、Minami決定：B-1／C】ピンの色の決まり（2D・3D共通、3Dは
 * terrain-map-view.jsのpinCategory()と同じ規則）。
 * - 'blue'  ：今の金額帯（budget−¥200より高く、budget以下）に入り、検索した金額帯にも入っていた場所
 * - 'orange'：今の金額帯に入るが、検索した金額帯には入っていなかった場所（金額を変えて新しく入った）
 * - 'gray'  ：今の金額帯より安く行ける場所
 * - 'hidden'：今の金額をこえる場所（出さない）
 * 検索した直後は今の金額＝検索した金額のため、金額帯の場所はすべて青になる。
 * @param {number} fare 往復運賃
 * @param {number} liveBudget 今の金額（＋−・スライダーで変えた値）
 * @param {number} searchedBudget 最後に検索した金額
 */
export function pinCategory(fare, liveBudget, searchedBudget) {
  if (!(fare <= liveBudget)) return 'hidden';
  if (fare > liveBudget - MAP_BAND_WIDTH) {
    return (fare <= searchedBudget && fare > searchedBudget - MAP_BAND_WIDTH) ? 'blue' : 'orange';
  }
  return 'gray';
}

export function formatReachRadiusKm(km) {
  if (!(km > 0)) return '0km';
  return km < 10 ? `${Math.round(km * 10) / 10}km` : `${Math.round(km)}km`;
}

function reachPrefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export class MapView {
  constructor(containerId) {
    this.containerId = containerId;
    this.map = null;
    this.markersLayer = null;
    this.markersBySpotId = new Map();
    this.fareBySpotId = new Map(); // 予算スライダーの塗り分け用（source_round_trip_fare）
    this.spotsLatLngById = new Map(); // fitToBudget用
    this.selectedSpotId = null;
    this.lastBounds = [];
    this._lastSpots = []; // 【2026-10-13、10本目②】到達円の半径計算用（出発駅からの距離はここから出す）
    this._departureStation = null;
    this._reachCircle = null;
    this._reachCircleRadiusKm = 0;
    this._pendingCircleStyle = 'live';
    this._circleAnimFrame = null; // 【2026-10-17、32本目B】半径を0.25秒ほどでなめらかに変えるrequestAnimationFrameのID
    this._circleAnimToken = 0; // 進行中の半径アニメーションを無効化する世代カウンタ
    this._circleFitTimer = null; // 【2026-10-17、32本目B】円が収まるよう地図を合わせる、0.4秒デバウンスのsetTimeout ID
    this._reachCircleTargetKm = 0; // 【37本目】半径アニメーションの行き先（地図合わせの判断は途中の値ではなくこれを使う）
    this._circleFitAnim = null; // 【37本目】{zoom, endsAt}：fitCircleToView()が動かしている最中の行き先ズーム
    this._circleWave = null; // 【37本目】＋の波：{layer, fromKm, toKm, radiusKm, opacity, frame}
    this._waveToken = 0;
    this._waveTimers = [];
    this._pendingWaveReveal = false; // 【2026-10-13、10本目②】layout-controller.jsのinvalidateMapSize()参照
    this._needsSearchFit = false; // 【40本目】見えていない間に検索があり、見えたときに検索直後の見え方へ合わせ直す必要がある
    this._liveBudget = null; // 【43本目】今の金額（C：＋−・スライダーで変えた値。検索した直後はlastBudgetと同じ）
    this._clusterLayer = null; // 【43本目B-2】まとめた丸（数字入り）を置くレイヤー
    this._clusters = []; // 【43本目B-2】今出しているまとめた丸：{marker, members:[spotId], latlng, hasOrange}（検証用にも使う）

    this.onSelectionChange = null; // (spotId) => void … ピン選択と一覧パネルの連動用
  }

  ensureMap() {
    if (this.map) return;

    this.map = L.map(this.containerId, {
      scrollWheelZoom: true,
      // 【2026-10-20、35本目、不具合修正】Leafletのデフォルト（zoomSnap:1）は
      // 実際に使うズームを整数へ四捨五入する。fitCircleToView()は「円の直径が
      // 短辺の7〜8割になる」ズームを小数で計算するが、整数へスナップされると
      // 最大で0.5レベル分（スケールで最大約1.41倍）ずれることがあり、
      // 7〜8割の目標から外れる（実測：目標0.75に対し0.532＝約0.71倍になった
      // ケースを確認。2^(-0.5)≈0.71と一致し、0.5レベル分のスナップで説明が
      // つく）。3D（MapLibre）はそもそも整数スナップの概念を持たず、同じ
      // 検証が3Dでは問題なく通ったこととも整合する。小数ズームを許可し、
      // 計算どおりの比率になるようにする。
      zoomSnap: 0,
    });
    this._rasterBaseLayer = L.tileLayer(GSI_TILE_URL, {
      attribution: GSI_ATTRIBUTION,
      maxZoom: 18,
    }).addTo(this.map);
    this._loadVectorBaseMap();
    this.markersLayer = L.layerGroup().addTo(this.map);
    this._clusterLayer = L.layerGroup().addTo(this.map);
    // 【43本目B-2】画面上の距離でまとめるため、ズームが変わったらまとめ直す。
    this.map.on('zoomend', () => this._recluster());

    // 検証用の参照（terrain-map-view.jsのwindow.__terrainViewForDebugと同じ考え方）。
    // アプリ自体はこれを使わない。本番でも害はないため条件分岐は入れていない。
    window.__mapViewForDebug = this;
    // 【41本目】以前はここでzoomendを見て「全体を見る」ボタン（寄っているときだけ出る）の
    // 表示を切り替えていたが、ボタンをいつでも出ている「最初の見え方に戻るボタン」に
    // 置き換えたため不要になった。
  }

  /**
   * 【2026-10-21、43本目D】下地を国土地理院のベクトル地図（地図記号なし・アプリの色）に差し替える。
   * 読み込み（MapLibre・橋渡し・スタイル）が終わり、ベクトル地図の最初の描画が済んだら、
   * 淡色地図の画像タイルを外す（それまでは画像タイルを出しておき、地図が白く抜けない）。
   * WebGLが使えない・読み込みに失敗したときは、画像タイルのまま続ける（エラーは出さない）。
   */
  _loadVectorBaseMap() {
    loadVectorBaseMapForLeaflet().then((style) => {
      if (!this.map || this._vectorBaseLayer) return;
      const layer = L.maplibreGL({ style, interactive: false, attribution: GSI_VECTOR_ATTRIBUTION });
      this._vectorBaseLayer = layer;
      // 【不具合修正】Leafletは、地図がまだ最初の表示位置を持たない（_loadedがfalseの）うちに
      // 加えた層の準備（onAdd）を後回しにする。そのため加えた直後はGLの地図がまだ無く
      // （getMaplibreMap()がundefined）、差し替えの準備が例外で止まり、淡色地図の画像タイルが
      // 裏に残り続けた（実機相当の確認で発覚）。層の準備ができた合図（'add'）を待ってから行う。
      layer.once('add', () => this._watchVectorBaseLayerReady(layer));
      layer.addTo(this.map);
    }).catch(() => {});
  }

  /** 【43本目D】ベクトル地図の層の準備ができたら、描けたところで淡色地図の画像タイルを外す。 */
  _watchVectorBaseLayerReady(layer) {
    const glMap = layer.getMaplibreMap();
    if (!glMap) return;
    const swap = () => {
      if (this._rasterBaseLayer && this.map) {
        this.map.removeLayer(this._rasterBaseLayer);
        this._rasterBaseLayer = null;
      }
    };
    // 'load'だけを待つと、橋渡し（maplibre-gl-leaflet）の内部で地図が作られる順番によっては
    // 合図を取り逃し、淡色地図の画像タイルが裏に残り続けた（実機相当の確認で発覚：GLの地図は
    // loaded()がtrueなのに差し替わっていなかった）。描画が落ち着いた合図（'idle'）でも確かめる。
    const trySwap = () => {
      if (!glMap.loaded()) return;
      glMap.off('idle', trySwap);
      glMap.off('load', trySwap);
      swap();
    };
    glMap.on('idle', trySwap);
    glMap.on('load', trySwap);
    trySwap();
    // 予備：通信が混んでいてタイルを読み終わる（loaded()）まで時間がかかるときも、スタイルが
    // 読めて描き始めていれば数秒後に差し替える（そうしないと画像タイルがいつまでも裏に残り、
    // 不要な通信を続けた。実機相当の長時間の確認で発覚）。
    setTimeout(() => {
      if (this._rasterBaseLayer && glMap.isStyleLoaded()) {
        glMap.off('idle', trySwap);
        glMap.off('load', trySwap);
        swap();
      }
    }, 6000);
  }

  /**
   * @param {{display_name: string, stop_lat: number, stop_lon: number}} departureStation
   * @param {Array} spots - latitude/longitude を持つスポット配列（¥2000で一度取得したallSpots全体。
   *   予算の絞り込み・塗り分けはapplyBudget側で行うため、ここでは帯を絞らずそのまま渡す）
   * @param {number} [budget] - 初期表示の予算。省略時は2000
   * @param {{reveal?: boolean}} [opts] - 【2026-10-13、10本目②】reveal:trueで、出発駅から
   *   近い順に波が広がるように点を出す（Minami指示：「この条件で検索」を押したときだけ）。
   */
  render(departureStation, spots, budget = 2000, { reveal = false } = {}) {
    this.ensureMap();
    this._cancelWaveReveal();
    this._cancelFitCircleToView(); // 新しい検索で、前の予算操作から保留中の地図合わせは無効化する
    this.markersLayer.clearLayers();
    this._clusterLayer.clearLayers();
    this._clusters = [];
    this.markersBySpotId.clear();
    this.fareBySpotId.clear();
    this.spotsLatLngById.clear();
    this.selectedSpotId = null;
    this._lastSpots = spots || [];
    this._departureStation = departureStation || null;

    this.departureLatLng = null;
    if (departureStation && isFiniteNumber(departureStation.stop_lat) && isFiniteNumber(departureStation.stop_lon)) {
      // 【2026-10-15、11本目①】吹き出し（ポップアップ）は廃止（Minami決定：A、
      // 地図の下の固定枠に統一）。出発駅名は常時表示の吹き出し型ツールチップ
      // （permanent、ポップアップとは別物）のまま残す。
      L.marker([departureStation.stop_lat, departureStation.stop_lon], {
        icon: createPinIcon('departure'),
        zIndexOffset: 2000,
      })
        .addTo(this.markersLayer)
        .bindTooltip(departureStation.display_name, {
          permanent: true,
          direction: 'top',
          offset: [0, -16],
          className: 'map-departure-tooltip',
        });
      this.departureLatLng = [departureStation.stop_lat, departureStation.stop_lon];
    }

    spots.forEach((spot) => {
      if (!isFiniteNumber(spot.latitude) || !isFiniteNumber(spot.longitude)) return;

      const marker = L.marker([spot.latitude, spot.longitude], {
        icon: createPinIcon('spot'),
      }).addTo(this.markersLayer);

      marker.on('click', () => {
        this.setSelected(spot.id);
        // 【2026-10-13、12本目①、Minami決定：A＋C】選んだピンが下の情報帯に
        // 隠れないよう、帯の分だけ地図をずらす（向きは2Dに無いため変更不要）。
        this.revealAboveBand([spot.latitude, spot.longitude]);
      });

      this.markersBySpotId.set(spot.id, marker);
      this.fareBySpotId.set(spot.id, spot.source_round_trip_fare);
      this.spotsLatLngById.set(spot.id, [spot.latitude, spot.longitude]);
    });

    this.applyBudget(budget);
    this._cancelCircleWave();
    // 【2026-10-20、36本目、Minami指示】検索直後の地図合わせを、金額操作時と
    // 同じ「円に合わせる」計算（fitCircleToView、最低ズーム8.5）に揃える。
    // fitToBudget()自体はこのまま呼ぶ（lastBounds・lastBudgetの記録のため）が、
    // 実際にカメラを置く位置はfitCircleToView()で上書きする。
    // 【37本目・41本目】最初の見え方に戻るボタン（returnToSearchView()）も同じ
    // fitCircleToView()のため、検索直後と同じ見え方に戻る。
    this.fitToBudget(budget, { animate: false });
    this.updateReachCircle(budget, { style: 'settled' });
    const fittedZoom = this.fitCircleToView({ radiusKm: this.computeReachRadiusKm(budget), animate: false });
    // 【40本目、不具合修正】3D表示中など2Dが見えていない間の検索では、ここで合わせられない。
    // 見えたとき（handleShown()）に検索直後の見え方へ合わせ直すため覚えておく。
    this._needsSearchFit = fittedZoom == null;
    if (reveal) this._startWaveReveal();

    // PC/スマホの切り替えやタブが非表示（display:none）のタイミングで
    // 呼ばれるとコンテナ寸法が0のままfitBoundsが不正確になるため、
    // 表示反映後（次フレーム）にサイズ再計算とfitBoundsのやり直しを行う。
    // 【不具合修正】このrAFの時点でまだ非表示（2D/3D切替で#spots-mapが
    // display:noneのまま）なら、ここでinvalidateSize()等を呼んでも
    // 直せない（isContainerVisible()参照）どころか、Leaflet内部の投影情報を
    // かえって壊す。表示されるまで待つ必要はなく、表示されたとき
    // （main.jsのapplyMapMode()、layout-controller.jsのinvalidateMapSize()
    // 経由）に改めてforceMarkerReposition()・refitBounds()が呼ばれるため、
    // ここでは「今見えているときだけ」行えばよい。
    requestAnimationFrame(() => {
      if (!this.isContainerVisible()) return;
      this.forceMarkerReposition();
      this.refitBounds();
      // 【43本目、不具合修正】最初の検索では、地図がまだ表示前（検索結果の画面に切り替わる前）に
      // render()が呼ばれ、applyBudget()の塗り分け・まとめが保留されたままになっていた（裏取得の
      // 再描画まで約1.2秒、ピンが色分けされず、まとめた丸も出なかった。実機相当の確認で発覚）。
      // 見えるようになったこのコマでやり直す。
      if (this.lastBudget != null) {
        this._restyleMarkers();
        this._recluster();
      }
    });
  }

  /**
   * 【2026-10-13、22本目、不具合修正】コンテナが実際に画面上で表示されて
   * いるか（displayがnoneの祖先が無いか）を見る。Leafletのmap.getSize()は
   * invalidateSize()を呼ぶまで古い値をキャッシュし続けるため「今現在
   * 見えているか」の判定には使えない（非表示（2D/3D切替でdisplay:noneに
   * なった直後）にrender()のfitToBudget()が「前回の非ゼロサイズ」を信じて
   * 0サイズのDOMに対しfitBounds相当の処理を呼び、Leaflet内部の投影情報を
   * 壊していたことが根本原因だった。既存のapplyBudget()・fitToBudget()の
   * 「getSize()が0なら保留する」ガードは、タブを一度も開いていない
   * （invalidateSize()が一度も呼ばれておらずキャッシュ自体が0の）場合は
   * 機能するが、このケース（キャッシュは非ゼロのまま実体だけ非表示になった
   * 場合）は素通りしてしまっていた）。
   * 【不具合修正】当初はoffsetParent !== nullで判定していたが、
   * verify-render（jsdom）はレイアウトエンジンを持たずoffsetParentが常に
   * nullを返すため、jsdom環境では常に「非表示」と誤判定されてしまい、
   * 帯の反映・地図のフィット等が軒並み動かなくなる副作用が出た。
   * レイアウトに依存しない、祖先のcomputed display（CSSカスケードの結果。
   * jsdomでも計算できる）を直接たどる方式に変更した。
   */
  isContainerVisible() {
    if (!this.map) return false;
    let el = this.map.getContainer();
    while (el) {
      if (getComputedStyle(el).display === 'none') return false;
      el = el.parentElement;
    }
    return true;
  }

  /**
   * 【2026-10-13、22本目、不具合修正】display:noneから復帰した直後、または
   * コンテナのサイズがまだ安定していないタイミングでマーカーが作られた・
   * 更新されたとき、invalidateSize()を呼ぶだけでは一部のマーカーの画面上の
   * 位置が直らないことがPlaywrightでの実機相当検証で判明した（136件中44件が
   * 本来の位置から数千px単位でずれたまま＝実際にクリックすると無関係な
   * 別の場所を押してしまう）。コンテナサイズ自体はinvalidateSize()で
   * 正しく更新されるが、マーカーの再投影は別イベント（'viewreset'等）
   * 頼みらしく、発生しないことがあった（2D/3D切替直後・裏の¥2000全域
   * 先読み(scheduleMaxBudgetPrefetch)によるrender()のやり直しの両方で
   * 再現する、同じ根本原因）。
   * invalidateSize()でサイズを確定→setView()で中心・ズームを明示的に
   * 再設定してpixelOriginを作り直す→既存マーカー全件へmarker.update()で
   * 個々の位置を再計算させる、の3段階を間にフレームを挟まず同期的に呼ぶ
   * ことで、イベント発火のタイミングに依存せず確実に直す
   * （2D/3D切替（main.jsのapplyMapMode()）・このrender()完了後の両方で使う
   * 共通処理のためメソッド化した）。
   */
  forceMarkerReposition() {
    // 【不具合修正】map.setView(map.getCenter(), ...)は、地図がまだ一度も
    // 中心・ズームを与えられていない（Leaflet内部の_loadedがfalseの）場合に
    // 「Set map center and zoom first.」を投げる。共有リンクで開いた詳細が
    // 帯の外のスポットだった場合等、fitToBudget()がbounds空で早期returnし、
    // 地図がまだ一度もfitBounds/setViewされていない状態でこれが呼ばれる
    // ケースが実機相当の検証（verify-render）で見つかった。
    if (!this.map || !this.map._loaded) return;
    this.map.invalidateSize();
    this.map.setView(this.map.getCenter(), this.map.getZoom(), { animate: false });
    this.markersBySpotId.forEach((marker) => marker.update());
  }

  /**
   * 予算スライダーの1コマ分。データの再取得・マーカーの作り直しは行わず、
   * 既存マーカーのCSSクラス（帯内＝明るいオレンジ・それより安い＝薄く小さく・
   * 予算超＝非表示）を塗り替えるだけ（Minami指示）。
   * 帯（budget-200〜budget）の件数を返す。
   * @param {number} budget
   * @returns {number} 帯内の件数
   */
  applyBudget(budget) {
    this.lastBudget = budget;
    // 【43本目】検索したときは、今の金額＝検索した金額（オレンジは青になる）。
    this._liveBudget = budget;
    let bandCount = 0;
    this.fareBySpotId.forEach((fare) => {
      if (fare <= budget && fare > budget - MAP_BAND_WIDTH) bandCount++;
    });

    // 【2026-10-10】スマホで「地図」タブを一度も開いていない間（#spots-mapの
    // コンテナが0×0）にマーカーのスタイルを書き換えると、Leafletが内部の
    // ResizeObserverでコンテナの変化を検知し、まだ正しく初期化されていない
    // 投影情報（fitBoundsを0サイズで呼んだ直後の状態）を使って再投影しようとして
    // 「Invalid LatLng object: (NaN, NaN)」を投げる不具合を実機で確認した。
    // 件数（bandCount）の計算・返却はコンテナサイズに関係なく常に行うが、
    // マーカーの見た目の塗り替えはコンテナが実寸を持つまで保留する
    // （タブが開かれてinvalidateMapSize()が呼ばれた時点で、呼び出し元が
    // 改めてapplyBudget(this.lastBudget)を呼び直せば反映される）。
    // 【不具合修正、22本目】map.getSize()はinvalidateSize()を呼ぶまで古い
    // 非ゼロ値をキャッシュし続けるため、「タブを一度も開いていない」場合
    // （キャッシュ自体が0）は検出できるが、「2D/3D切替で今まさに非表示に
    // なった」場合（キャッシュは前回の非ゼロ値のまま）は検出できなかった。
    // isContainerVisible()（DOMのoffsetParentを直接見る）に変更した。
    if (!this.isContainerVisible()) {
      return bandCount;
    }

    this._restyleMarkers();
    this._recluster();
    return bandCount;
  }

  /**
   * 【2026-10-21、43本目、Minami決定：C】金額を変えたら（＋−・スライダー）、その場で
   * ピンを新しい金額帯に合わせて塗り直し、まとめ直す（検索した金額＝lastBudgetは変えない）。
   * 地図が見えていないときは、見えたとき（handleShown()）に今の金額で塗り直される。
   * @param {number} budget 今の金額
   */
  setLiveBudget(budget) {
    this._liveBudget = budget;
    if (this.lastBudget == null || !this.isContainerVisible()) return;
    this._restyleMarkers();
    this._recluster();
  }

  /**
   * 【2026-10-21、43本目、Minami決定：B-1】ピンの色と大きさを、今の金額（_liveBudget）と
   * 検索した金額（lastBudget）から塗り分ける（pinCategory()参照）。青・オレンジは直径13pxの
   * くっきりした丸に白いふち、灰色は小さな点。以前の光のにじみ（box-shadowのぼかし）はやめた。
   * 予算をこえる場所は出さない。見た目はCSSのクラス（map-pin-blue／-orange／-gray）で決める。
   */
  _restyleMarkers() {
    const live = this._liveBudget ?? this.lastBudget;
    const searched = this.lastBudget;
    this.markersBySpotId.forEach((marker, spotId) => {
      const el = marker.getElement();
      const pin = el && el.querySelector('.map-pin');
      if (!pin) return;
      const cat = pinCategory(this.fareBySpotId.get(spotId), live, searched);
      el.dataset.cat = cat;
      pin.classList.toggle('map-pin-blue', cat === 'blue');
      pin.classList.toggle('map-pin-orange', cat === 'orange');
      pin.classList.toggle('map-pin-gray', cat === 'gray');
      this._applyMarkerDisplay(el);
    });
  }

  /** 予算をこえる場所・まとめた丸に入った場所は出さない（選んだピンはいつも出す）。 */
  _applyMarkerDisplay(el) {
    el.style.display = (el.dataset.cat === 'hidden' || el.dataset.clustered === '1') ? 'none' : '';
  }

  /**
   * 【2026-10-21、43本目、Minami決定：B-2】引いているときは、画面上で近いピン（青・オレンジ・
   * 灰色）を数字の入った青い丸にまとめ、寄ると1つずつに分かれる。外の部品
   * （Leaflet.markercluster等）は使わず、ピン（最大で数百件）の画面上の位置から毎回まとめ直す
   * （ピンのDOMは消さずにdisplayだけ切り替えるため、選択・ホバー・一覧との連動・検索直後の
   * 波の演出をそのまま使える）。まとめ方：IDの順に1つずつ見て、まだどこにも入っていないピンから
   * MAP_PIN_CLUSTER_RADIUS_PX以内のピンを集める（毎回同じ結果になる決まった順序）。
   * 選んだピンはまとめない（いつも見える）。オレンジを含む丸には右上に小さなオレンジの点を付ける。
   */
  _recluster() {
    if (!this.map || !this._clusterLayer) return;
    this._clusterLayer.clearLayers();
    this._clusters = [];
    const points = [];
    this.markersBySpotId.forEach((marker, spotId) => {
      const el = marker.getElement();
      if (!el) return;
      el.dataset.clustered = '0';
      this._applyMarkerDisplay(el);
      if (el.dataset.cat === undefined || el.dataset.cat === 'hidden' || spotId === this.selectedSpotId) return;
      points.push({ spotId, el, latlng: marker.getLatLng() });
    });
    if (!this.isContainerVisible() || this.map.getZoom() >= MAP_PIN_CLUSTER_MAX_ZOOM) return;
    points.sort((a, b) => (a.spotId < b.spotId ? -1 : a.spotId > b.spotId ? 1 : 0));
    points.forEach((pt) => { pt.px = this.map.latLngToLayerPoint(pt.latlng); });
    const used = new Set();
    for (let i = 0; i < points.length; i++) {
      if (used.has(i)) continue;
      const group = [i];
      for (let j = i + 1; j < points.length; j++) {
        if (used.has(j)) continue;
        if (points[i].px.distanceTo(points[j].px) <= MAP_PIN_CLUSTER_RADIUS_PX) group.push(j);
      }
      if (group.length < 2) continue;
      group.forEach((k) => used.add(k));
      const members = group.map((k) => points[k]);
      members.forEach((m) => { m.el.dataset.clustered = '1'; this._applyMarkerDisplay(m.el); });
      const lat = members.reduce((sum, m) => sum + m.latlng.lat, 0) / members.length;
      const lng = members.reduce((sum, m) => sum + m.latlng.lng, 0) / members.length;
      const hasOrange = members.some((m) => m.el.dataset.cat === 'orange');
      const marker = L.marker([lat, lng], { icon: createClusterIcon(members.length, hasOrange), zIndexOffset: 500 })
        .addTo(this._clusterLayer);
      const memberIds = members.map((m) => m.spotId);
      marker.on('click', () => this._zoomIntoCluster(memberIds));
      this._clusters.push({ marker, members: memberIds, latlng: [lat, lng], hasOrange });
    }
  }

  /**
   * 【43本目B-2】まとめた丸を押したとき、その場所に寄って分かれる。中の場所どうしの画面上の
   * いちばん近い距離が、まとめる距離（MAP_PIN_CLUSTER_RADIUS_PX）をこえるズームまで寄る
   * （ズームが1上がると画面上の距離は2倍）。まとめなくなるズーム（MAP_PIN_CLUSTER_MAX_ZOOM）が上限。
   */
  _zoomIntoCluster(memberIds) {
    if (!this.map) return;
    const latlngs = memberIds.map((id) => this.spotsLatLngById.get(id)).filter(Boolean);
    if (latlngs.length === 0) return;
    const zoom = this.map.getZoom();
    const pts = latlngs.map((ll) => this.map.latLngToLayerPoint(ll));
    let dmin = Infinity;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) dmin = Math.min(dmin, pts[i].distanceTo(pts[j]));
    }
    const needed = dmin > 0 ? zoom + Math.log2((MAP_PIN_CLUSTER_RADIUS_PX * 1.2) / dmin) : MAP_PIN_CLUSTER_MAX_ZOOM;
    const target = Math.min(MAP_PIN_CLUSTER_MAX_ZOOM, Math.max(zoom + 1, needed));
    const center = [
      latlngs.reduce((sum, ll) => sum + ll[0], 0) / latlngs.length,
      latlngs.reduce((sum, ll) => sum + ll[1], 0) / latlngs.length,
    ];
    if (reachPrefersReducedMotion()) {
      this.map.setView(center, target, { animate: false });
    } else {
      this.map.flyTo(center, target, { duration: 0.6 });
    }
  }

  /**
   * 予算以下（帯＋それより安い点）が全部入るよう、地図をなめらかに引く/寄せる。
   * スライダーを指から離したときに呼ぶ想定（Minami指示：動かしている間は
   * カメラを動かさない）。新規検索時（animate:false）は瞬時に合わせる。
   * @param {number} budget
   * @param {{animate?: boolean, durationSec?: number}} [opts]
   */
  fitToBudget(budget, { animate = true, durationSec = 0.6 } = {}) {
    if (!this.map) return;
    this._cancelFitCircleToView();
    this.lastBudget = budget;
    const bounds = [];
    if (this.departureLatLng) bounds.push(this.departureLatLng);
    this.fareBySpotId.forEach((fare, spotId) => {
      if (fare <= budget) bounds.push(this.spotsLatLngById.get(spotId));
    });
    this.lastBounds = bounds;
    if (bounds.length === 0) return;
    // コンテナが非表示（地図タブを一度も開いていないスマホ・2D/3D切替で
    // 今まさにdisplay:noneになった直後等）の間は呼ばない（applyBudget()と
    // 同じ理由。lastBoundsは保存済みのため、表示されてinvalidateMapSize()の
    // refitBounds()が呼ばれた時点で正しく反映される）。
    // 【不具合修正、22本目】map.getSize()の古い非ゼロキャッシュを信じて
    // ここを素通りし、実体が0サイズのDOMに対してgetBoundsZoom()/
    // fitBounds()相当を呼んでしまい、Leaflet内部の投影情報を壊す
    // （render()の裏取得が2D/3D切替直後に走った場合に再現）不具合があった
    // ため、isContainerVisible()（DOMを直接見る）に変更した。
    if (!this.isContainerVisible()) return;
    // 【2026-10-10】¥2000選択時に点が画面端からはみ出る不具合をMinamiが
    // スクリーンショットで発見（主に3D側だったが、余白は2Dも合わせて広げる）。
    const options = { padding: [48, 48], maxZoom: 16 };
    if (reachPrefersReducedMotion()) {
      // 【2026-10-20、36本目、不具合修正】animate:falseをoptionsに含めず
      // this.map.fitBounds()を呼ぶと、Leafletが「animateを指定しない」場合の
      // 既定の挙動として、ズームの差が小さければ独自のCSSズームトランジション
      // （既定で約0.25秒）を内部的に開始してしまう。これはfitToBudget()の
      // 「animate:false（瞬時に合わせる）」という約束に反するだけでなく、
      // 直後に別の瞬時なsetView()（render()が続けて呼ぶfitCircleToView()、
      // 36本目）を呼んでも、先に始まっていたこのトランジションの完了イベント
      // （_onZoomTransitionEnd）が後から発火し、fitCircleToView()が設定した
      // ズームを無言で上書きしてしまう不具合があった（検索直後、円の比率が
      // 目標の7〜8割から大きくずれる形で実機相当の検証で発覚）。
      // animate:falseを明示し、Leaflet自身のトランジションも確実に無効化する。
      this.map.fitBounds(bounds, { ...options, animate: false });
    } else if (animate) {
      this.map.flyToBounds(bounds, { ...options, duration: durationSec });
    } else {
      // 上のreachPrefersReducedMotion()分岐と同じ理由でanimate:falseを明示する。
      this.map.fitBounds(bounds, { ...options, animate: false });
    }
  }

  /**
   * 【2026-10-21、40本目、不具合修正】2Dの地図が見えるようになったとき（2D/3D切替で
   * 2Dに戻ったとき・スマホで地図タブを開いたとき）に呼ぶ。
   * 3D表示中に検索した（または裏の¥2000取得がrender()をやり直した）場合、2Dは
   * 非表示（display:none）のため、render()の中の「地図合わせ」「ピンの塗り分け
   * （applyBudget）」「円の描き直し（_paintReachCircle）」がすべて保留されたままに
   * なる。以前は2D/3D切替（main.jsのapplyMapMode()）がforceMarkerReposition()しか
   * 呼ばず、これらを誰もやり直していなかった（Minami実機確認：富山駅北口・往復¥500で、
   * 2Dにすると地図が寄りすぎ・ピンで画面が埋まり円が見えない。再現：3Dで¥2000→¥500と
   * 検索してから2Dに戻すと、ズームは¥2000のまま・円は18.2kmのまま・¥500を超える
   * ピンも全部表示）。
   * @param {{forceRefit?: boolean}} [opts] - true：保留が無くても検索直後の見え方へ
   *   合わせ直す（スマホのタブ切替の従来の動き、layout-controller.js）。false（既定）：
   *   2D/3D切替。見えていない間に検索があったときだけ合わせ直し、そうでなければ
   *   ユーザーが2Dで見ていた位置のまま（従来どおり）にする。
   */
  handleShown({ forceRefit = false } = {}) {
    if (!this.map || !this.isContainerVisible()) return;
    this.map.invalidateSize();
    if (forceRefit || this._needsSearchFit) {
      this.refitBounds();
      this._needsSearchFit = false;
    }
    this.forceMarkerReposition();
    if (this.lastBudget != null) {
      this._restyleMarkers();
      this._recluster();
    }
    if (this._reachCircleRadiusKm > 0) this._paintReachCircle(this._reachCircleRadiusKm, this._pendingCircleStyle);
    if (this._pendingWaveReveal) {
      this._pendingWaveReveal = false;
      this._startWaveReveal();
    }
  }

  /** 直近の検索条件に再フィットする。地図が非表示の間に描画された場合や、
   * レイアウト切り替えでコンテナサイズが変わった際に使う。
   * 【2026-10-20、36本目、不具合修正】以前はthis.lastBounds（fitToBudget()が
   * 記録したスポット座標基準の範囲）へfitBounds()するだけだったため、
   * render()内でfitCircleToView()（円に合わせる計算）を呼んだ直後でも、
   * render()末尾のrequestAnimationFrame（コンテナがまだ非表示だった場合の
   * 保険）やlayout-controller.jsのタブ切替時にこれが呼ばれると、次のフレームで
   * 古いfitBounds()の結果に上書きされてしまっていた（PCで検索直後の円が
   * 目標比率（短辺の7〜8割）からずれる不具合として実機相当の検証で発覚：
   * ¥500で比率1.24、¥1000で1.28等）。検索直後と同じ「円に合わせる」計算へ
   * 揃える。 */
  refitBounds() {
    if (!this.map) return;
    // 【不具合修正、22本目】スマホで「一覧」タブを見ながら検索し、初めて
    // 「地図」タブを開いたとき、ピンの位置が画面外にずれる不具合が実機相当の
    // 検証で見つかった。原因はLeafletの実装そのもの：invalidateSize()は
    // `if (!this._loaded) return this;` を内部で持ち、地図がまだ一度も
    // fitBounds/setViewされていない（_loadedがfalse）間は何もしない。
    // さらにgetSize()は`this._size && !this._sizeChanged`の間はコンテナを
    // 再計測せず、作成時（非表示・0×0だった時点）にキャッシュした値を
    // 返し続ける。結果、invalidateSize()を呼んでもコンテナが正しい寸法に
    // なったことが地図に伝わらず、この直後のfitBounds()がgetBoundsZoom()を
    // 0×0基準で計算して最大ズーム（16）に張り付いてしまっていた。
    // _loadedがまだfalseのときだけ、Leaflet内部のキャッシュ（_size・
    // _sizeChanged）を直接リセットし、次の計測でコンテナの実寸を
    // 強制的に測り直させる（invalidateSize()では代替できないため、
    // Leaflet内部プロパティへの直接アクセスで対処する）。
    if (!this.map._loaded && this.lastBounds.length > 0) {
      this.map._size = null;
      this.map._sizeChanged = true;
    }
    const radiusKm = this.lastBudget != null ? this.computeReachRadiusKm(this.lastBudget) : 0;
    if (radiusKm > 0) {
      this.fitCircleToView({ radiusKm, animate: false });
    } else if (this.lastBounds.length > 0) {
      // 到達範囲0km（0件検索）等、円が無いときだけ以前どおりスポット座標
      // （実質は出発駅のみ）基準でフィットする。
      // 【36本目、不具合修正】fitToBudget()と同じ理由でanimate:falseを明示する。
      this.map.fitBounds(this.lastBounds, { padding: [36, 36], maxZoom: 16, animate: false });
    }
  }

  /**
   * 【2026-10-21、41本目、Minami決定】最初の見え方に戻るボタン（地図の右上、いつでも
   * 出ている）。検索した直後と同じ見え方（最後に検索した金額の円が短辺の0.6）へ
   * なめらかに戻す。以前の「全体を見る」（寄っているときだけ出る文字ボタン、
   * returnToOverview()）の役目を引き継いだため、寄っているかどうかの判定
   * （isZoomedInPastOverview()・_overviewZoom）は不要になり削除した。
   * 向き（bearing）は2Dに無いため変更不要。
   * @param {{durationSec?: number}} [opts]
   */
  returnToSearchView({ durationSec = 1.5 } = {}) {
    if (!this.map || this.lastBudget == null) return;
    this._cancelFitCircleToView();
    this.fitCircleToView({
      radiusKm: this.computeReachRadiusKm(this.lastBudget),
      animate: true,
      durationSec,
    });
  }

  /**
   * 【2026-10-13、12本目①、Minami決定：A＋C】選んだピンが下の情報帯の
   * 裏に隠れないよう、地図をずらす。latlngを画面中央そのものではなく、
   * REVEAL_ABOVE_BAND_OFFSET_PXぶん「南」に実質ずらした地点を中心にする
   * ことで、latlng自体は画面中央よりその分だけ上（帯より上の見える位置）に
   * 描画される。向き（bearing）は2Dに無いため変更不要。
   * @param {[number, number]} latlng
   */
  revealAboveBand(latlng) {
    if (!this.map) return;
    const zoom = this.map.getZoom();
    const targetPoint = this.map.project(latlng, zoom).add([0, REVEAL_ABOVE_BAND_OFFSET_PX]);
    const target = this.map.unproject(targetPoint, zoom);
    if (reachPrefersReducedMotion()) {
      this.map.panTo(target, { animate: false });
    } else {
      this.map.panTo(target, { animate: true, duration: 0.4 });
    }
  }

  /**
   * 【2026-10-13、10本目②、Minami決定：A】予算の±・スライダーを動かしている間は
   * 点を変えず、出発駅を中心にした到達範囲の円だけを広げる・縮める。
   * 半径は「今の予算以内（往復）で行ける場所のうち、一番遠い場所までの直線距離」
   * （¥2000で先に取得済みのallSpotsから実測。推測値にしない、Minami指示）。
   * まだ検索していない（allSpots無し）ときは円を出さない。
   * 【2026-10-17、32本目B、Minami決定】半径の変化は瞬時に飛ばず、今の大きさから
   * 新しい大きさへ0.25秒ほどでなめらかに変える（_animateCircleRadius()、
   * 3D側のterrain-map-view.jsと同じ考え方）。
   * @param {number} budget
   * @param {{style?: 'live'|'settled'}} [opts] - settled:検索確定後（薄くする）
   */
  updateReachCircle(budget, { style = 'live', wave = false } = {}) {
    const targetKm = this.computeReachRadiusKm(budget);
    // 【41本目、Minami決定】ユーザーが金額を上げたとき（呼び出し元のmain.jsがwave:trueを
    // 渡す）、出発駅（円の中心）から新しい縁まで波を出す。37本目は「前の縁から」で、
    // 円が広がらなかったときは出さなかったが、「ここまで届く」を見せるため、半径が
    // 同じでも出す。
    if (wave && targetKm > 0) {
      this._startCircleWave(0, targetKm);
    }
    this._animateCircleRadius(targetKm, style);
  }

  /**
   * 【2026-10-20、37本目、Minami決定：B2】前の円の縁（fromKm）から新しい縁（toKm）へ、
   * うすい青の線を1本広げて消す。地理座標上の円（L.circle）として描くため、
   * 地図が動いている途中でも常に円の縁と同じ位置に出る。続けて押されたら
   * 前の波は途中でも消して、新しい波に置き換える。動きを減らす設定のときは出さない。
   */
  _startCircleWave(fromKm, toKm) {
    this._cancelCircleWave();
    if (reachPrefersReducedMotion() || !this.map || !this.departureLatLng) return;
    if (!this.isContainerVisible()) return;
    const layer = L.circle(this.departureLatLng, {
      radius: Math.max(fromKm, 0) * 1000,
      color: MAP_REACH_CIRCLE_COLOR,
      weight: MAP_CIRCLE_WAVE_WEIGHT,
      opacity: MAP_CIRCLE_WAVE_START_OPACITY,
      fill: false,
      interactive: false,
    }).addTo(this.map);
    const wave = { layer, fromKm, toKm, radiusKm: fromKm, opacity: MAP_CIRCLE_WAVE_START_OPACITY, frame: null };
    this._circleWave = wave;
    const startTime = performance.now();
    const step = (now) => {
      if (this._circleWave !== wave) return;
      // 【37本目、不具合修正】requestAnimationFrameに渡される時刻はそのフレームの開始時刻で、
      // 直前にperformance.now()で取ったstartTimeより前になることがある（負の進み具合になり、
      // 最初の1コマだけ前の縁より内側・濃い色で描かれていた）。0未満にならないよう抑える。
      const progress = Math.min(1, Math.max(0, (now - startTime) / MAP_CIRCLE_WAVE_DURATION_MS));
      // 広がりは終わりに向けてゆるやかに（ease-out）、うすくなるのは一定の速さで。
      const eased = 1 - (1 - progress) * (1 - progress);
      wave.radiusKm = fromKm + (toKm - fromKm) * eased;
      wave.opacity = MAP_CIRCLE_WAVE_START_OPACITY * (1 - progress);
      layer.setRadius(wave.radiusKm * 1000);
      layer.setStyle({ opacity: wave.opacity });
      if (progress < 1) {
        wave.frame = requestAnimationFrame(step);
      } else {
        this._cancelCircleWave();
      }
    };
    wave.frame = requestAnimationFrame(step);
  }

  _cancelCircleWave() {
    const wave = this._circleWave;
    if (!wave) return;
    this._circleWave = null;
    if (wave.frame) cancelAnimationFrame(wave.frame);
    if (this.map) this.map.removeLayer(wave.layer);
  }

  /**
   * 【2026-10-17、32本目B】円の半径を今の値（_reachCircleRadiusKm）から
   * targetKmへ、MAP_CIRCLE_RADIUS_ANIM_MSかけてなめらかに変える。呼ばれるたびに
   * 世代カウンタ（_circleAnimToken）を進めるため、スライダー操作中の連続呼び
   * 出しは「今アニメーション中の値」から新しい目標へ滑らかに繋ぎ直される。
   */
  _animateCircleRadius(targetKm, style) {
    this._pendingCircleStyle = style;
    this._reachCircleTargetKm = targetKm;
    if (this._circleAnimFrame) {
      cancelAnimationFrame(this._circleAnimFrame);
      this._circleAnimFrame = null;
    }
    const startKm = this._reachCircleRadiusKm;
    if (reachPrefersReducedMotion() || Math.abs(targetKm - startKm) < 0.01) {
      this._paintReachCircle(targetKm, style);
      return;
    }
    const token = ++this._circleAnimToken;
    const startTime = performance.now();
    const step = (now) => {
      if (token !== this._circleAnimToken || !this.map) return;
      // 【37本目、不具合修正】requestAnimationFrameに渡される時刻はそのフレームの開始時刻で、
      // 直前にperformance.now()で取ったstartTimeより前になることがある（負の進み具合になり、
      // 最初の1コマだけ前の縁より内側・濃い色で描かれていた）。0未満にならないよう抑える。
      const progress = Math.min(1, Math.max(0, (now - startTime) / MAP_CIRCLE_RADIUS_ANIM_MS));
      const km = startKm + (targetKm - startKm) * progress;
      this._paintReachCircle(km, this._pendingCircleStyle);
      if (progress < 1) {
        this._circleAnimFrame = requestAnimationFrame(step);
      } else {
        this._circleAnimFrame = null;
      }
    };
    this._circleAnimFrame = requestAnimationFrame(step);
  }

  /**
   * 【2026-10-17、32本目B、Minami決定】予算の±・スライダー操作のたびに呼ぶ。
   * 円の半径変化（updateReachCircle()）はそのたびに起きるが、地図を合わせる
   * （fitCircleToView()）のは最後の呼び出しから0.4秒止まったときだけ
   * （連打・ドラッグ中に地図が何度も動いて酔わないようにするMinami指示）。
   */
  scheduleFitCircleToView() {
    this._cancelFitCircleToView();
    this._circleFitTimer = setTimeout(() => {
      this._circleFitTimer = null;
      // 【37本目、Minami決定：A】金額操作のあとは、はみ出しそう・小さすぎる
      // ときだけ動かす。半径は描画途中の値ではなく行き先（アニメーション
      // 0.2秒はデバウンス0.15秒より長く、まだ途中のことがあるため）で判断する。
      this.fitCircleToView({ radiusKm: this._reachCircleTargetKm, onlyIfNeeded: true });
    }, MAP_CIRCLE_FIT_DEBOUNCE_MS);
  }

  _cancelFitCircleToView() {
    if (this._circleFitTimer) {
      clearTimeout(this._circleFitTimer);
      this._circleFitTimer = null;
    }
  }

  /**
   * 【2026-10-17、32本目B、Minami決定】今描画中の到達円「全体」が画面に収まる
   * よう、滑らかにカメラを引く/寄せる。今までの「予算を触ったら全体表示に
   * 戻る」（fitToBudget()ベースのreturnToOverview()）をこれに置き換える
   * （円そのものを収める点がfitToBudget()と異なる：スポットの座標ではなく、
   * 出発駅からの半径で決まる円の外接範囲を使う）。2Dに向き（bearing）・
   * 傾き（pitch）は無いため変更不要。中心は出発駅に固定する（円は必ず
   * 出発駅中心のため、対称なpaddingを使えば出発駅中心のままで収まる）。
   * 【2026-10-20、36本目、Minami指示】検索直後の初回表示にも同じ計算を使う
   * ため、半径（radiusKm）・アニメーションの有無（animate）を上書きできる
   * ようにした。省略時は今まで通り_reachCircleRadiusKm（円の現在の描画値）・
   * animate:trueのまま（予算操作時の挙動は変えない）。検索直後は
   * _reachCircleRadiusKmがまだ0→目標値へアニメーション中（_animateCircleRadius()
   * 参照）のため、目標値（computeReachRadiusKm()）を直接渡す必要がある。
   * 【2026-10-20、37本目、Minami決定：A】onlyIfNeeded:true（金額操作のあと）のときは、
   * 今の円の直径÷短辺がMAP_CIRCLE_REFIT_UPPER_RATIO（0.9）をこえたときだけ0.75へ引き、
   * MAP_CIRCLE_REFIT_LOWER_RATIO（0.35）を下回ったときだけ0.6へ寄る。その間は動かさない。
   * 検索直後・最初の見え方に戻るボタンは常に合わせる（onlyIfNeeded:false）。
   * 【41本目】合わせる先はどの場面も短辺の0.6（MAP_CIRCLE_FIT_TARGET_DIAMETER_RATIO）。
   * @param {{radiusKm?: number, animate?: boolean, onlyIfNeeded?: boolean, durationSec?: number}} [opts]
   * @returns {number|null} 動かした先のズーム（動かさなかったときはnull）
   */
  fitCircleToView({
    radiusKm = this._reachCircleRadiusKm,
    animate = true,
    onlyIfNeeded = false,
    durationSec = MAP_CIRCLE_FIT_DURATION_SEC,
  } = {}) {
    if (!this.map || !this.departureLatLng) return null;
    if (!radiusKm || radiusKm <= 0) return null;
    if (!this.isContainerVisible()) return null;
    const [lat, lon] = this.departureLatLng;
    const bounds = L.latLngBounds([
      reachDestinationPoint(lat, lon, 0, radiusKm),
      reachDestinationPoint(lat, lon, 90, radiusKm),
      reachDestinationPoint(lat, lon, 180, radiusKm),
      reachDestinationPoint(lat, lon, 270, radiusKm),
    ]);
    const size = this.map.getSize();
    const shortSide = Math.max(1, Math.min(size.x, size.y));
    // 【2026-10-20、35本目、不具合修正】当初は3D側と同じ式（余白(片側) = 短辺 ×
    // (1 - 目標直径比率) / 2）をそのまま使ったが、実機相当の検証で比率が
    // 0.75の目標に対し0.899（約2割大きい）になる不具合が見つかった。
    // 原因はLeafletのgetBoundsZoom()の仕様差：fitBounds()経由で呼ぶときは
    // paddingTopLeft・paddingBottomRightをそれぞれ加算してgetBoundsZoom()へ
    // 渡すため、結果的に「片側の値」×2が効く。しかし、ここでは
    // （_overviewZoom用のfitToBudget()と同様に）getBoundsZoom()を直接呼んで
    // おり、内部では渡したpadding Pointを1回だけ（getSize().subtract(padding)）
    // 減算する——つまり「両側の合計」として扱われる。3D（MapLibre）の
    // cameraForBounds()は数値1つのpaddingを「各辺に同じ量」として扱う仕様の
    // ため3D側の式は正しいが、2DのgetBoundsZoom()直接呼びでは「片側の値」を
    // 2倍せずに渡すと、実際に効く余白が意図の半分になり、円が目標より
    // 大きくなる。ここでは直接呼びのため、合計分（片側×2）をそのまま渡す。
    const padding = Math.min(
      Math.round(shortSide * (1 - MAP_CIRCLE_FIT_TARGET_DIAMETER_RATIO)),
      Math.floor(shortSide / 2) - 1
    );
    // fitZoomは「円の直径が短辺のT（MAP_CIRCLE_FIT_TARGET_DIAMETER_RATIO、41本目から0.6）に
    // なるズーム」。2D（メルカトル）ではズームが1上がると画面上の長さがちょうど2倍になる
    // ため、任意のズームzでの比率は T × 2^(z − fitZoom)、比率rになるズームは
    // fitZoom + log2(r / T) で求まる。
    const fitZoom = this.map.getBoundsZoom(bounds, false, L.point(padding, padding));
    let targetZoom = fitZoom;
    let currentZoom = null;
    if (onlyIfNeeded) {
      // 前の地図合わせがまだ動いている途中なら、途中のズームではなく行き先で判断する。
      const anim = this._circleFitAnim;
      currentZoom = anim && performance.now() < anim.endsAt ? anim.zoom : this.map.getZoom();
      const ratio = MAP_CIRCLE_FIT_TARGET_DIAMETER_RATIO * Math.pow(2, currentZoom - fitZoom);
      if (ratio > MAP_CIRCLE_REFIT_UPPER_RATIO) {
        targetZoom = fitZoom;
      } else if (ratio < MAP_CIRCLE_REFIT_LOWER_RATIO) {
        targetZoom = fitZoom + Math.log2(MAP_CIRCLE_ZOOM_IN_TARGET_RATIO / MAP_CIRCLE_FIT_TARGET_DIAMETER_RATIO);
      } else {
        return null;
      }
    }
    const zoom = Math.min(Math.max(targetZoom, MAP_CIRCLE_FIT_MIN_ZOOM), 16);
    // 最低ズーム8.5（または最大16）に張り付いていて、もう動く余地が無いときは動かさない
    // （¥2000付近で＋を押すたびに同じ場所へ飛び直す空の動きを出さない）。
    if (onlyIfNeeded && Math.abs(zoom - currentZoom) < 0.02) return null;
    if (reachPrefersReducedMotion() || !animate) {
      this._circleFitAnim = null;
      this.map.setView(this.departureLatLng, zoom, { animate: false });
    } else {
      this._circleFitAnim = { zoom, endsAt: performance.now() + durationSec * 1000 + 100 };
      this.map.flyTo(this.departureLatLng, zoom, { duration: durationSec });
    }
    return zoom;
  }

  /**
   * 【2026-10-14、25本目】指定した予算以内で一番遠い場所までの直線距離（km）。
   * 円の半径そのものの計算で、地図上のラベルを廃止した代わりに
   * main.jsがスマホの予算操作帯・PCの帯件数プレビューの距離表示に使う
   * （円の描画と同じ値を使うことで、見た目の円と数字が必ず一致する）。
   * @param {number} budget
   * @returns {number}
   */
  computeReachRadiusKm(budget) {
    if (!this.departureLatLng || !this._lastSpots || this._lastSpots.length === 0) return 0;
    const [lat, lon] = this.departureLatLng;
    return this._lastSpots.reduce((max, s) => {
      if (!isFiniteNumber(s.latitude) || !isFiniteNumber(s.longitude)) return max;
      if (s.source_round_trip_fare > budget) return max;
      return Math.max(max, reachHaversineKm(lat, lon, s.latitude, s.longitude));
    }, 0);
  }

  _paintReachCircle(radiusKm, style) {
    this.ensureMap();
    this._reachCircleRadiusKm = radiusKm; // 検証用（verify-layout.js参照）・スマホ予算操作帯の距離表示
    if (!this.map || !radiusKm || radiusKm <= 0 || !this.departureLatLng) {
      if (this._reachCircle) { this.map?.removeLayer(this._reachCircle); this._reachCircle = null; }
      return;
    }
    // 【不具合修正、22本目】スマホで「一覧」タブを見ている間（#spots-mapが
    // display:none）に予算を動かすと、既存の円へsetLatLng/setRadius/
    // setStyle()を呼んだときに「Cannot read properties of undefined
    // (reading 'subtract')」を投げることがPlaywrightの実機相当検証で
    // 判明した（applyBudget()・fitToBudget()が既に同じ理由で持つ
    // 「コンテナが非表示の間は保留する」ガードが、この円の塗り替えには
    // 無かったため）。半径の値（_reachCircleRadiusKm、検証用）の更新だけは
    // 常に行い、実際の描画操作はコンテナが見えているときだけ行う（見えた
    // ときに改めてupdateReachCircle()が呼ばれれば反映される設計のため、
    // ここで保留しても表示が古いまま固定されることはない）。
    if (!this.isContainerVisible()) return;
    const opts = style === 'settled'
      ? { color: '#2F6FB2', weight: 1.5, opacity: 0.35, fillColor: '#2F6FB2', fillOpacity: 0.07 }
      : { color: '#2F6FB2', weight: 1.5, opacity: 0.55, fillColor: '#2F6FB2', fillOpacity: 0.12 };
    const radiusMeters = radiusKm * 1000;
    if (!this._reachCircle) {
      this._reachCircle = L.circle(this.departureLatLng, { ...opts, radius: radiusMeters, interactive: false }).addTo(this.map);
    } else {
      this._reachCircle.setLatLng(this.departureLatLng);
      this._reachCircle.setRadius(radiusMeters);
      this._reachCircle.setStyle(opts);
    }
  }

  /**
   * 【2026-10-13、10本目②】検索を押した直後、出発駅から近い順に点が波のように
   * 広がって出る演出（Minami指示：全体で1秒前後）。帯内・帯外どちらの点も対象
   * （applyBudget()が既に非表示にした予算超の点は対象外）。
   * prefers-reduced-motionのときは即座に全部出す。
   *
   * 【不具合修正】スマホで「一覧」タブを見ながら検索した場合、地図のコンテナ
   * （#spots-map）はdisplay:noneでサイズ0のまま。Leafletはコンテナが未初期化
   * （サイズ0）の間はマーカーのアイコン要素を正しく生成しない
   * （marker.getElement()がundefinedを返す。applyBudget()も同じ理由で既に
   * コンテナサイズ0の間は塗り替えを保留する設計になっている）。この状態で
   * 波の演出を試みても対象の要素が1つも見つからず、演出が静かに空振りして
   * 終わっていた（verify-layoutで「検索直後に隠れている点が0件」として発覚）。
   * スポット自体はある（_lastSpots等で保持済み）のにコンテナが未準備なだけの
   * 場合は、後で地図タブが開かれたとき（layout-controller.jsのinvalidateMapSize()）
   * に改めて波の演出をやり直せるよう、保留フラグを立てる。
   */
  _startWaveReveal() {
    this._cancelWaveReveal();
    this._pendingWaveReveal = false;
    if (!this.departureLatLng) return;
    const [depLat, depLon] = this.departureLatLng;
    const entries = [];
    let maxKm = 0;
    this.markersBySpotId.forEach((marker, spotId) => {
      const el = marker.getElement();
      if (!el || el.style.display === 'none') return;
      const latlng = this.spotsLatLngById.get(spotId);
      if (!latlng) return;
      const km = reachHaversineKm(depLat, depLon, latlng[0], latlng[1]);
      maxKm = Math.max(maxKm, km);
      entries.push({ el, km });
    });
    // 【43本目B-2】まとめた丸も、ピンと同じように出発駅から近い順に出す。
    this._clusters.forEach(({ marker, latlng }) => {
      const el = marker.getElement();
      if (!el) return;
      const km = reachHaversineKm(depLat, depLon, latlng[0], latlng[1]);
      maxKm = Math.max(maxKm, km);
      entries.push({ el, km });
    });
    if (entries.length === 0) {
      // コンテナが未準備（サイズ0）で要素が拾えなかった可能性がある場合だけ、
      // 後で地図タブが開かれたときにやり直せるよう保留する（スポット自体が
      // 0件のときは無意味なので、markersBySpotIdが空でない場合に限る）。
      if (this.markersBySpotId.size > 0 && this.map && (this.map.getSize().x === 0 || this.map.getSize().y === 0)) {
        this._pendingWaveReveal = true;
      }
      return;
    }
    if (reachPrefersReducedMotion() || maxKm <= 0) {
      entries.forEach(({ el }) => el.classList.remove('pin-wave-hidden'));
      return;
    }
    const token = ++this._waveToken;
    entries.forEach(({ el }) => el.classList.add('pin-wave-hidden'));
    entries.forEach(({ el, km }) => {
      const delay = (km / maxKm) * WAVE_DURATION_MS;
      const timer = setTimeout(() => {
        if (token !== this._waveToken) return;
        el.classList.remove('pin-wave-hidden');
      }, delay);
      this._waveTimers.push(timer);
    });
  }

  _cancelWaveReveal() {
    this._waveToken++;
    this._waveTimers.forEach((t) => clearTimeout(t));
    this._waveTimers = [];
  }

  /**
   * ピンを選択状態にする（一覧パネルとの連動ハイライト・複数事業者からの
   * クリック起点を統一）。ホバー状態とは完全に独立したクラス
   * （map-pin-selected）で管理するため、マウスの位置に関わらず維持される。
   */
  setSelected(spotId) {
    if (this.selectedSpotId && this.selectedSpotId !== spotId) {
      this.setMarkerState(this.selectedSpotId, 'selected', false);
    }
    this.selectedSpotId = spotId;
    this.setMarkerState(spotId, 'selected', true);
    this._recluster(); // 【43本目】選んだピンはまとめない（いつも見える）
    if (this.onSelectionChange) this.onSelectionChange(spotId);
  }

  /**
   * 【2026-10-15、11本目①】情報枠を閉じたとき・検索し直したとき・予算を
   * 触ったときに、ピンの強調だけを外す（新しい選択はしない）。
   */
  clearSelected() {
    if (this.selectedSpotId) {
      this.setMarkerState(this.selectedSpotId, 'selected', false);
    }
    const hadSelection = this.selectedSpotId != null;
    this.selectedSpotId = null;
    if (hadSelection) this._recluster();
  }

  /** ホバー時の一時ハイライト。選択状態（map-pin-selected）とは
   * 別クラス（map-pin-hover）を使うため、互いに競合・上書きしない。 */
  highlightSpot(spotId) {
    this.setMarkerState(spotId, 'hover', true);
  }

  unhighlightSpot(spotId) {
    this.setMarkerState(spotId, 'hover', false);
  }

  setMarkerState(spotId, kind, on) {
    const marker = this.markersBySpotId.get(spotId);
    const el = marker && marker.getElement();
    const pin = el && el.querySelector('.map-pin');
    if (!pin) return;
    const className = kind === 'selected' ? 'map-pin-selected' : 'map-pin-hover';
    pin.classList.toggle(className, on);

    const isSelected = pin.classList.contains('map-pin-selected');
    const isHover = pin.classList.contains('map-pin-hover');
    marker.setZIndexOffset(isSelected ? 2000 : isHover ? 1000 : 0);
  }
}

export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function createPinIcon(kind) {
  if (kind === 'departure') {
    return L.divIcon({
      className: 'map-pin-wrapper',
      html: '<span class="map-pin map-pin-departure"></span>',
      iconSize: [26, 26],
      iconAnchor: [13, 13],
      popupAnchor: [0, -13],
    });
  }
  // 【43本目】ピンの大きさ（灰色の小さな点〜選んだピン20px）はCSSのクラスで変えるため、
  // 入れ物（.map-pin-wrapper-spot、22px四方）の真ん中に置く（大きさが変わっても位置がずれない）。
  return L.divIcon({
    className: 'map-pin-wrapper map-pin-wrapper-spot',
    html: '<span class="map-pin map-pin-spot"></span>',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    popupAnchor: [0, -11],
  });
}

/**
 * 【43本目B-2】まとめた丸のアイコン（数字入りの青い丸）。中の場所が多いほど少し大きくする。
 * オレンジ（金額を変えて新しく入った場所）を含むときは、右上に小さなオレンジの点を付ける。
 */
function createClusterIcon(count, hasOrange) {
  const size = count < 10 ? 28 : count < 50 ? 32 : 38;
  return L.divIcon({
    className: 'map-cluster-wrapper',
    html: `<span class="map-cluster" style="width:${size}px;height:${size}px"><span class="map-cluster-count">${count}</span>${hasOrange ? '<span class="map-cluster-orange-dot"></span>' : ''}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

