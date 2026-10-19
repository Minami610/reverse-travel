/**
 * terrain-map-view.js - 検索結果を俯瞰する3D地形地図（MapLibre GL JS + 国土地理院
 * 標準地図・標高タイル）。4本目「3D地図」。feature/3d-mapブランチ。
 *
 * 【2026-10-10、4本目②】このファイル自体はdist/index.htmlにインライン化せず、
 * MapLibre本体と同じくvendor/maplibre/配下の別ファイルとして3D切替時にのみ
 * 動的importされる（terrain-loader.js参照。2Dの人のページを重くしないため）。
 * そのため、他のアプリJS（inlined）が使うmap-view.jsとは実行時に別スコープで、
 * importで繋ぐとどちらかが二重に読み込まれる・束ねられないため、共通処理が
 * 必要な場合はこのファイル内に小さく複製する方針にしている。
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

const GSI_PALE_TILE_URL = 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png';
const GSI_SEAMLESSPHOTO_TILE_URL = 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg';
const GSI_DEM_PROTOCOL_TILE_URL = 'gsidem://https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png';
const GSI_STD_ATTRIBUTION =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>';
const GSI_DEM_ATTRIBUTION = '国土地理院の標高タイルを加工して3D地形として表示';

const DEFAULT_PITCH = 57; // Minami指示：55〜60の中間
const DEFAULT_ZOOM = 9;
const DEFAULT_EXAGGERATION = 2; // Minami指示：2〜2.5倍から開始
const DEM_MAXZOOM = 12; // Minami指示：DEM10Bの範囲に抑え、それ以上は自動オーバーズーム

// 【2026-10-12、7本目、Minami決定】3Dの既定の見た目を「D」にする
// （6本目Cで比較したa/b/d/bdのうち、全体=淡色地図＋強め陰影、寄り=航空写真＋
// 弱い陰影、のbd相当のもの。理由：航空写真だけだと重く、高低差も読めない
// ため、全体は軽い淡色地図、寄ったら周りの景色が分かる航空写真）。比較用に
// 残していたa/b/d単体パターンの切替コードは使わないため削除した。
// 【Minami指示】パッと切り替わらないよう、ズーム12.5〜13.5の間で淡色地図→
// 航空写真へ滑らかに重ねる。MapLibreの['interpolate','linear',['zoom'],...]
// 式はペイントのたびに現在のズームで再評価されるため、setLayoutProperty+
// 'zoom'イベントでの離散切替（6本目の実装）と違って本質的に連続的になる
// （flyTo中の毎フレームでも自動的に追従する）。
// 淡色地図（gsi-bg-pale）は常にvisibility:'visible'・不透明のまま下に敷き、
// 航空写真（gsi-bg-aerial）だけraster-opacityを0→1で重ねる。これにより、
// 航空写真のタイルがまだ読み込めていない箇所は下の淡色地図がそのまま
// 見える（6本目Cのbdパターンで白く抜けていた問題の対策。原因は
// visibility:'none'での切替があり得ないほど完全だったこと＝切替後に
// 旧背景が消え、新背景の未読込部分が何も無い状態になっていたため）。
// 陰影の強さ・色もあわせてズームで補間する（強め陰影の値は6本目Cの
// パターンd、弱め陰影の値はパターンbの値をそのまま流用。見比べた結果の
// 採用値）。
const BG_CROSSFADE_ZOOM_START = 12.5;
const BG_CROSSFADE_ZOOM_END = 13.5;
const AERIAL_OPACITY_EXPR = ['interpolate', ['linear'], ['zoom'], BG_CROSSFADE_ZOOM_START, 0, BG_CROSSFADE_ZOOM_END, 1];
const HILLSHADE_EXAGGERATION_EXPR = ['interpolate', ['linear'], ['zoom'], BG_CROSSFADE_ZOOM_START, 0.7, BG_CROSSFADE_ZOOM_END, 0.15];
const HILLSHADE_SHADOW_COLOR_EXPR = ['interpolate', ['linear'], ['zoom'], BG_CROSSFADE_ZOOM_START, '#2a2a1a', BG_CROSSFADE_ZOOM_END, '#6b6b5f'];
const HILLSHADE_HIGHLIGHT_COLOR_EXPR = ['interpolate', ['linear'], ['zoom'], BG_CROSSFADE_ZOOM_START, '#fff8e0', BG_CROSSFADE_ZOOM_END, '#fffdf5'];
const BG_PALE_LAYER_ID = 'gsi-bg-pale';
const BG_AERIAL_LAYER_ID = 'gsi-bg-aerial';

// 【2026-10-11、5本目】俯瞰（fitToBudget）の引きすぎ対策：余白は地図の大きさの
// 比率（短辺の8%）にし、ズームの下限（9.5）を設ける。maxZoomではなく下限で
// 抑えるのは、Minami指示「上限で入りきらない点は画面の外に出てよい」ため
// （fitBoundsのmaxZoomは「寄りすぎ」を防ぐ上限であり、「引きすぎ」を防ぐ
// 下限が無いのが今回の不具合だった）。
const OVERVIEW_PADDING_RATIO = 0.08;
const OVERVIEW_MIN_ZOOM = 9.5;
// 【2026-10-19、34本目、Minami決定：B】「全体を見る」・検索直後の全体表示
// （fitToBudget()）は今までどおりOVERVIEW_MIN_ZOOM(9.5)のまま変えない。
// 一方、32本目Bの「金額を変えて円を合わせる」（fitCircleToView()）だけは、
// 小さいスマホ（400×464）の3Dで円が枠からはみ出したまま戻らないことがある
// （9.5にかかって、それ以上は引けないため）。円を合わせるときだけ、より
// ゆるい下限（8.5）を使う。8.5でも収まらないときだけ、はみ出しを許す
// （Minami指示：従来どおり「入りきらない点は画面の外に出てよい」）。
const CIRCLE_FIT_MIN_ZOOM = 8.5;
// 場所に寄ったときの見え方（Minami指示：ズーム14前後、pitch60前後）。
const SPOT_FOCUS_ZOOM = 14;
const SPOT_FOCUS_PITCH = 60;
const SPOT_FOCUS_DURATION_MS = 2600; // Minami指示：2〜3秒
// 【2026-10-13、20本目修正、Minami指示】選んだピンが下の情報帯（高さ40px前後）に
// 隠れないよう、寄るときの中心を画面上寄りにずらす。以前はMapLibreのoffsetを
// 使っていたが、offsetは「centerを画面中央からどれだけずらして描くか」という
// 見た目だけのずらしで、回転（bearing）の中心は画面の真の中心のままになる。
// PCは右ドラッグで回転できるため、選んだピンが帯より上に出ている状態で回転すると、
// ピンだけが画面中央を中心に振れて画面外へ飛んでしまう不具合があった
// （verify-layout.jsの旧コメントに実測値「回転後はx=-78と画面外に出た」と残っていた）。
// paddingは「この分だけ外側を見えない余白として扱う」設定で、回転の中心も
// 「帯より上の見える範囲の中心」に変わるため、回転してもピンは見える範囲の
// 中心に留まり続ける。bottomパディングぶん、中心は画面中央よりbottom/2だけ
// 上にずれる（MapLibreの仕様）。旧offset[0,-90]と同じ見え方になるようbottom=180にした。
// 【2026-10-13、22本目修正、Minami指示】これは地図が十分高いときの理想値。
// スマホで地図の高さが70px程度まで潰れる不具合があったとき、この固定180pxが
// 地図の高さの半分をはるかに超えてしまい、MapLibreが
// 「Map cannot fit within canvas with the given bounds, padding, and/or offset」
// という警告を出していた（Minami実機確認）。地図に最低240pxの高さを設ける
// CSS側の対策（style.css #map-slot-mobile）と合わせて、ここでも地図の高さの
// 半分を超えないよう動的に小さくする（getRevealPadding()参照）。
const REVEAL_ABOVE_BAND_PADDING_MAX = { top: 0, right: 0, bottom: 180, left: 0 };
// 帯を閉じた後（全体表示・予算操作での復帰）は、上のpaddingを明示的に0へ戻す
// （MapLibreのpaddingは次のカメラ操作でpaddingを指定しない限りそのまま残り続ける
// ため、戻し忘れると全体表示の「短い辺の8%・最小ズーム9.5」の構図が狂う）。
const CLEAR_PADDING = { top: 0, right: 0, bottom: 0, left: 0 };
// 【2026-10-13、8本目③】真上(pitch0)から降りた後、傾けて立体にするまでの時間。
const TILT_DURATION_MS = 2000; // Minami指示：2秒前後
const REDUCED_MOTION_FLY_DURATION_MS = 300; // prefers-reduced-motion時：降りる・傾けるを1回の短い移動にまとめる
// 【2026-10-15、26本目、不具合修正】flyTo()/easeTo()が別のアニメーションに
// 割り込む際、MapLibre内部の競合によりpitchが途中の値で止まったままeaseTo()
// が完了してしまうことがある（実機相当のPlaywright計測で複数回確認：中心・
// ズームが同じeaseTo()同士の割り込みでも発生した）。この許容差を超えていたら
// 「傾け終わった」とみなさず、もう一度だけ傾け直す。
const PITCH_CORRECTION_TOLERANCE_DEG = 2;

// 【2026-10-16、27本目、Minami決定：A】ハンドル中央のつまみを上下に引いたときの
// 傾き（pitch）の可動域。SPOT_FOCUS_PITCH(60)・DEFAULT_PITCH(57)は「いつもの
// 斜めの表示」の既定値であり、ここで変えない。つまみ操作はそれとは別に
// 0〜75度まで連続的に動かせる（Minami指示）。
const HANDLE_PITCH_MIN = 0;
const HANDLE_PITCH_MAX = 75;
// つまみの上下ドラッグ量(px)→pitch変化量(度)の係数。約125px引くと可動域
// 全体（75度）を動かせる見積もり（Minami指示「上に40pxで傾きが大きくなる」の
// 手触りを確かめた上での値）。
const HANDLE_PITCH_DEG_PER_PX = 0.6;
// キーボード↑↓の1コマ分の傾き変化量。
const HANDLE_PITCH_KEY_STEP_DEG = 5;
// キーボード←→の1コマ分の回転角度（【23】から変更なし）。
const HANDLE_BEARING_KEY_STEP_DEG = 15;
// 【2026-10-17、32本目A】方位磁針を押したときに北（bearing0）へ戻る、
// なめらかな所要時間（【27】の「つまみを押すと戻る」と同じ値を踏襲）。
const HANDLE_RESET_DURATION_MS = 400;
// 【2026-10-16、27本目】初めて3Dに切り替えたときの案内吹き出しを表示したか
// どうかのlocalStorageキー。一度出したら次回以降は出さない（Minami指示）。
const ROTATE_HINT_STORAGE_KEY = 'reverse-travel-rotate-hint-seen';
const ROTATE_HINT_AUTO_HIDE_MS = 3000; // Minami指示：3秒ほど

const BAND_WIDTH = 200; // 予算の帯の幅（既存の2D検索・一覧と同じ定義）
const SPOTS_SOURCE_ID = 'spots';
const SPOTS_LAYER_ID = 'spots-circle';
const DEM_SOURCE_ID = 'gsi-dem';
const HILLSHADE_LAYER_ID = 'hillshade-layer';
// 【2026-10-13、10本目②】予算の到達範囲の円（出発駅中心）。
const REACH_CIRCLE_SOURCE_ID = 'reach-circle';
const REACH_CIRCLE_FILL_LAYER_ID = 'reach-circle-fill';
const REACH_CIRCLE_LINE_LAYER_ID = 'reach-circle-line';
const REACH_CIRCLE_POINTS = 72; // 円を近似する多角形の頂点数（5°刻み）
const WAVE_DURATION_MS = 1000; // Minami指示：検索後、点を波のように出す所要時間（全体で1秒前後）
// 【2026-10-15、11本目①】選んだピンの強調（吹き出し廃止の代わり）。circleレイヤーは
// 単一のpaintプロパティしか持てないため、選択中の1件だけ別ソース・別レイヤーで
// 上から重ねて描く（到達範囲の円と同じ考え方）。
const SELECTED_SOURCE_ID = 'selected-spot';
const SELECTED_LAYER_ID = 'selected-spot-circle';
const SELECTED_GLOW_LAYER_ID = 'selected-spot-glow';
// 【2026-10-15、11本目②】「全体を見る」ボタン・予算操作時の自動復帰に使う
// なめらかな引きの所要時間（Minami指示：1.5秒前後）。
const RETURN_TO_OVERVIEW_DURATION_MS = 1500;

// 【2026-10-17、32本目B、Minami決定】予算の±・スライダー操作：まず円の半径を
// なめらかに変え、最後の操作から少し止まったら、円「全体」が収まるよう
// 地図を合わせる。今までの「予算を触ったら全体表示に戻る」（fitToBudget()
// ベースのreturnToOverview()）を置き換える。
// 【2026-10-20、35本目、Minami決定】待ち時間が長すぎる（読み込みが遅いのかと
// 思うほど）との指摘により、円0.25秒→0.2秒・デバウンス0.4秒→0.15秒・
// 地図を合わせる動き0.7秒→0.45秒に短縮した（合計1.35秒→0.8秒）。
const CIRCLE_RADIUS_ANIM_MS = 200;
const CIRCLE_FIT_DEBOUNCE_MS = 150;
const CIRCLE_FIT_DURATION_MS = 450;
// 【2026-10-20、35本目、Minami決定：A、不具合修正】以前は「短辺の8%」と
// 「方位磁針・ハンドルに隠れない右側の余白（90px固定）」のうち大きい方を
// 全方向の余白として使っていたが、400×464等の小さい画面ではshortSide自体が
// 240px前後しかなく、90px×2（上下または左右の合計）だけで短辺の75%を
// 占めてしまい、円が極端に小さくなる不具合があった（Minami実機確認：
// 「円が地図の中で小さくなってしまう」）。90px固定の余白とOVERVIEW_PADDING_RATIO
// 由来の余白を max() で二重に持つ設計自体が「引きすぎ」の原因だったため、
// 固定90pxの特別扱いをやめ、「地図を合わせたあと、円の直径が見えている
// 範囲の短い辺の7〜8割になるように」という目標から直接、余白の比率を
// 逆算する一本の式にした（CIRCLE_FIT_TARGET_DIAMETER_RATIO参照）。
const CIRCLE_FIT_TARGET_DIAMETER_RATIO = 0.75; // 目標7〜8割の中間値

// 帯に入る点＝明るいオレンジ＋光の輪、それより安い点＝緑がかった灰色の小さい点
// （2026-10-10、Minami指摘：スクリーンショットで見分けづらかったため色を変更。
// 2D(map-view.js)と揃える）。
const COLOR_IN_BAND = '#FF6B2B';
const COLOR_CHEAPER = '#8a9a86';
const COLOR_SELECTED = '#1B5E9E'; // 2D(map-view.js)の--color-selectedと揃える

let protocolRegistered = false; // addProtocolは多重登録を避ける（2回目以降は上書きになるだけだが、意図を明示するためフラグで一度だけに絞る）

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 現在の予算に応じた塗り分け式（circle-radius等）。予算を超える点はfilter側で出さない。 */
function inBandExpr(budget) {
  return ['>', ['get', 'fare'], budget - BAND_WIDTH];
}

const EARTH_RADIUS_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** 2点間の直線距離（km）。円の半径・波の演出の遅延計算に使う（10本目）。 */
function haversineKm(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lon2 - lon1);
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 始点から指定の方位角・距離(km)だけ進んだ地点を返す（円のリング描画・ラベル位置に使う）。 */
function destinationPoint(lat, lon, bearingDeg, distanceKm) {
  const delta = distanceKm / EARTH_RADIUS_KM;
  const theta = toRad(bearingDeg);
  const phi1 = toRad(lat);
  const lambda1 = toRad(lon);
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
  const lambda2 = lambda1 + Math.atan2(
    Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
    Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2)
  );
  return { lat: toDeg(phi2), lon: toDeg(lambda2) };
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 【2026-10-14、23本目】点(px,py)が中心(cx,cy)から見てどの向きにあるかを、
 * 12時方向を0度とした時計回りの角度（度）で返す。CSSのrotate()と同じ向きの
 * 規約（_setupRotateHandle()参照）。
 */
function screenAngleDeg(px, py, cx, cy) {
  return (Math.atan2(px - cx, -(py - cy)) * 180) / Math.PI;
}

/** 角度を0〜359度の範囲に正規化する（aria-valuenow表示用）。 */
function normalizeRotateAngle(deg) {
  let d = deg % 360;
  if (d < 0) d += 360;
  return d;
}

/** 値を[min, max]の範囲に収める。 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 【2026-10-16、27本目】回転ハンドルの案内吹き出しを既に見せたかどうか。
 * main.jsのloadMapModePreference()と同じく、プライベートブラウジング等で
 * localStorageが例外を投げても無視する（出さない側に倒す＝try/catchの
 * 外側でfalseを返す）。
 */
function hasSeenRotateHint() {
  try {
    return localStorage.getItem(ROTATE_HINT_STORAGE_KEY) === 'true';
  } catch {
    return true; // 読めない環境では「見せない」側に倒す（毎回出ると煩わしいため）
  }
}

function markRotateHintSeen() {
  try {
    localStorage.setItem(ROTATE_HINT_STORAGE_KEY, 'true');
  } catch {
    // 無視する（書き込めなくても吹き出し自体は表示・非表示できる）
  }
}

/** 標準的なスリッピータイル座標（z/x/y）。経緯度を含むタイルを求める。 */
function tileXYAt(lng, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y };
}

/**
 * 【2026-10-12、7本目】指定ソースについて、経緯度（通常は画面中央）を覆う
 * タイルのうち最も高いズームのものが読み込み済み（またはエラー確定。404等で
 * 永遠に待たないため）かを見る。waitForTerrainLoaded()のようなソース全体の
 * 完了待ちとは違い、「その1点を覆う最高解像度のタイル」だけを見るため、
 * 画面の端・地平線側のタイルがまだでも中央さえ揃っていればtrueになる
 * （Minami指示：「見える」は中央付近が揃った時点とし、遠くのタイルまで
 * 待たない）。
 * タイルの読み込み状態はMapLibreの公開API areTilesLoaded()と同じ内部参照
 * （map.style.sourceCaches[id]._tiles）を使う。
 */
function isCenterTileReady(map, sourceId, lng, lat) {
  const cache = map.style && map.style.sourceCaches && map.style.sourceCaches[sourceId];
  if (!cache) return false;
  let bestZ = -1;
  let bestReady = false;
  for (const key in cache._tiles) {
    const tile = cache._tiles[key];
    const canonical = tile.tileID && tile.tileID.canonical;
    if (!canonical) continue;
    const { x, y } = tileXYAt(lng, lat, canonical.z);
    if (canonical.x !== x || canonical.y !== y) continue;
    if (canonical.z > bestZ) {
      bestZ = canonical.z;
      bestReady = tile.state === 'loaded' || tile.state === 'errored';
    }
  }
  return bestZ >= 0 && bestReady;
}

export class TerrainMapView {
  /**
   * @param {string} containerId
   */
  constructor(containerId) {
    this.containerId = containerId;
    this.map = null;
    this.departureMarker = null;
    this.onSelectionChange = null; // 【2026-10-11、6本目B】地図の点をタップしたとき、一覧のカードをスクロール＋光らせるため（2Dのmap-view.jsと同じ役割）
    this.onOverheadSettled = null; // 【2026-10-13、8本目】(spot) => void、真上から見た状態の読み込みが済んだ瞬間（計測・テスト用）
    this.onTiltComplete = null; // 同上。傾け終わった瞬間（計測・テスト用）
    this.onFocusChange = null; // 【2026-10-15、11本目②】(focused: boolean) => void … 「全体を見る」ボタンの表示切替用
    this.selectedSpotId = null; // 【2026-10-15、11本目①】情報枠・PC一覧ハイライトとの連動用
    this._lastDepartureStation = null;
    this._lastSpots = null;
    this._lastBudget = null;
    this._flySpotToken = 0; // 【2026-10-13、8本目】flyToSpot()の「降りる→傾ける」演出を、ユーザー操作や次のflyToSpot呼び出しで無効化するための世代カウンタ
    this._focusedOnSpot = false; // 【2026-10-15、11本目②】flyToSpot()で寄っている間true。fitToBudget()で全体に戻るとfalse
    this._flyFocusedSpotId = null; // 【2026-10-15、26本目】_focusedOnSpotがtrueのとき、今寄っているspot.id
    this._reachCircleRadiusKm = 0; // 【2026-10-13、10本目②】現在描画中の円の半径（なめらかな変化の起点）
    this._pendingCircleStyle = 'live';
    this._circleAnimFrame = null; // 【2026-10-17、32本目B】半径を0.25秒ほどでなめらかに変えるrequestAnimationFrameのID
    this._circleAnimToken = 0; // 進行中の半径アニメーションを無効化する世代カウンタ
    this._circleFitTimer = null; // 【2026-10-17、32本目B】円が収まるよう地図を合わせる、0.4秒デバウンスのsetTimeout ID
    this._waveFrame = null; // requestAnimationFrameのID（検索後の点の波の演出）
    this._waveToken = 0; // 保留中の波の演出を無効化する世代カウンタ（新しい検索・render()で進める）
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
          // 【2026-10-12、7本目】既定の見た目「D」（Minami決定）：淡色地図を
          // 常に敷き、航空写真をズームで重ねる。どちらも地理院タイル。
          [BG_PALE_LAYER_ID]: {
            type: 'raster',
            tiles: [GSI_PALE_TILE_URL],
            tileSize: 256,
            maxzoom: 18,
            attribution: GSI_STD_ATTRIBUTION,
          },
          [BG_AERIAL_LAYER_ID]: {
            type: 'raster',
            tiles: [GSI_SEAMLESSPHOTO_TILE_URL],
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
          [REACH_CIRCLE_SOURCE_ID]: {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          },
          [SELECTED_SOURCE_ID]: {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          },
        },
        layers: [
          // 淡色地図は常に不透明で下に敷く（航空写真の未読込部分はここが
          // そのまま透けて見える＝白く抜けない）。
          { id: BG_PALE_LAYER_ID, type: 'raster', source: BG_PALE_LAYER_ID },
          // 航空写真はraster-opacityをズームで0→1に補間し、パッと切り替わらず
          // 重なっていく（Minami指示）。
          {
            id: BG_AERIAL_LAYER_ID,
            type: 'raster',
            source: BG_AERIAL_LAYER_ID,
            paint: { 'raster-opacity': AERIAL_OPACITY_EXPR },
          },
          // 起伏を見えやすくする陰影（Minami指示）。同じ標高データから計算するため
          // 標高タイルの変換自体は1回で済む（追加のネットワーク取得は発生しない）。
          // 【2026-10-12、7本目】濃さ・色も同じズーム区間で補間し、背景の
          // 切替と連動して「全体は強め・寄ったら弱め」に自然に変わる。
          {
            id: HILLSHADE_LAYER_ID,
            type: 'hillshade',
            source: DEM_SOURCE_ID,
            paint: {
              'hillshade-exaggeration': HILLSHADE_EXAGGERATION_EXPR,
              'hillshade-illumination-direction': 315,
              'hillshade-shadow-color': HILLSHADE_SHADOW_COLOR_EXPR,
              'hillshade-highlight-color': HILLSHADE_HIGHLIGHT_COLOR_EXPR,
            },
          },
          // 【2026-10-13、10本目②】予算の到達範囲の円。地形の上に塗る通常のfill/line
          // レイヤーのため、特別な指定なしに地形の起伏へ自然に貼り付く（MapLibreは
          // fill/lineレイヤーを既定で地形にドレープする）。スポットの点より目立たない
          // 色（青系）にし、点より下に描く。
          {
            id: REACH_CIRCLE_FILL_LAYER_ID,
            type: 'fill',
            source: REACH_CIRCLE_SOURCE_ID,
            paint: { 'fill-color': '#2F6FB2', 'fill-opacity': 0.12 },
          },
          {
            id: REACH_CIRCLE_LINE_LAYER_ID,
            type: 'line',
            source: REACH_CIRCLE_SOURCE_ID,
            paint: { 'line-color': '#2F6FB2', 'line-opacity': 0.55, 'line-width': 1.5 },
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
          // 【2026-10-15、11本目①】選んだピンの強調（吹き出し廃止の代わり、
          // Minami指示：一回り大きく＋白い縁取り＋光の輪）。spotsレイヤーより
          // 後ろ（＝画面上は上）に描くことで、帯の塗り分けより目立たせる。
          // 光の輪はぼかした少し大きい円を先に敷き、本体の円を上に重ねて作る。
          {
            id: SELECTED_GLOW_LAYER_ID,
            type: 'circle',
            source: SELECTED_SOURCE_ID,
            paint: {
              'circle-radius': 18,
              'circle-color': COLOR_SELECTED,
              'circle-opacity': 0.45,
              'circle-blur': 1,
            },
          },
          {
            id: SELECTED_LAYER_ID,
            type: 'circle',
            source: SELECTED_SOURCE_ID,
            paint: {
              'circle-radius': 10,
              'circle-color': COLOR_SELECTED,
              'circle-opacity': 1,
              'circle-stroke-width': 2.5,
              'circle-stroke-color': '#ffffff',
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
      // 【2026-10-13、10本目①、Minami決定：B】回転を減らす。PCの右ドラッグ
      // （Ctrl＋ドラッグ）での回転・傾きは残す（dragRotate）。スマホの2本指で
      // ひねる回転は、酔う・向きが分からなくなるとのMinami指摘により止める
      // （下のtouchZoomRotate.disableRotation()参照）。2本指ズーム・2本指上下の
      // 傾きは残すため、touchZoomRotate自体は有効のままにする。
      dragRotate: true,
      touchZoomRotate: true,
      touchPitch: true,
      pitchWithRotate: true,
    });

    // 【2026-10-13、10本目①】touchZoomRotateは2本指ピンチズームと2本指回転の
    // 両方を束ねたハンドラのため、有効のまま回転部分だけを無効化する
    // （Minami指示：2本指ズームは残し、2本指でひねる回転だけ止める）。
    this.map.touchZoomRotate.disableRotation();

    // 【2026-10-14、23本目、Minami決定：B】方位磁針（MapLibreのNavigationControl）
    // を「つかんで回すハンドル」に置き換える（右上、3Dのみ）。PCの右ドラッグでの
    // 回転操作は無関係に残るため（dragRotate、上記参照）、ここでは追加しない。
    // 【2026-10-17、32本目A】「北へ戻す」操作をハンドルから分離した方位磁針も
    // ここで一緒にセットアップする。
    this._setupRotateHandle();
    this._setupCompassButton();

    // 【2026-10-13、8本目③】ユーザーが手で地図を操作したら、「降りる→傾ける」
    // 演出を止める（ユーザー操作を優先）。zoomstart・pitchstartは、flyTo()や
    // easeTo()によるプログラム側の変更でも発火するため、e.originalEvent
    // （実際のDOMイベント。ユーザー操作由来のときだけ存在する）で判別する
    // （実機確認で確定）。
    // 【2026-10-13、10本目①】Minami指示によりゆっくり回る演出（自動回転）を
    // まるごと廃止したため、ここで止めていた_stopAutoRotate()呼び出しは削除した。
    ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart', 'wheel'].forEach((evt) => {
      this.map.on(evt, (e) => {
        if (e.originalEvent) this._flySpotToken++; // プログラム側（flyTo/easeTo由来）では「降りる→傾ける」演出を止めない
      });
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
    // 【不具合修正、2026-10-13、12本目③】ここでwaitForTerrainLoaded()を呼ぶと、
    // まだ下のmap.once('load', ...)より前＝スタイルの読み込みが終わっておらず
    // 'gsi-dem'ソース自体がmap.style.sourceCachesにまだ登録されていないことが
    // あり、isSourceLoaded('gsi-dem')が「そのようなソースは無い」という
    // コンソールエラーを出していた（Minami実機確認：赤いエラーとして発見）。
    // setTerrain()の直後（ソースが確実に存在する時点）に呼ぶよう後ろへ移した
    // （下記参照）。ここでは保険のsetTimeoutだけ残す。
    setTimeout(stopCollapsing, 20000); // 読み込みが長引く・失敗する場合の保険

    // 検証用の参照（queryTerrainElevationでの標高確認・Playwrightでのカメラ操作など）。
    // アプリ自体はこれを使わない。本番でも害はないため条件分岐は入れていない。
    window.__terrainMapForDebug = this.map;
    window.__terrainViewForDebug = this; // waitForTerrainLoaded()等、ラッパー側のメソッドの検証用

    // 【2026-10-15、11本目①、Minami決定：A】地図の吹き出し（ポップアップ）は
    // 廃止し、地図の下の固定情報枠（main.js側のDOM）に統一した。ここでは
    // ピンの強調（setSelectedSpot）とmain.js連携用のコールバックだけ行う。
    this.map.on('click', SPOTS_LAYER_ID, (e) => {
      const feature = e.features && e.features[0];
      if (!feature) return;
      this.setSelectedSpot(feature.properties);
      // 【2026-10-11、5本目】地図の点をタップしたら、その場所へ寄る（Minami指示）。
      this.flyToSpot(feature.properties, this._lastDepartureStation);
      // 【2026-10-11、6本目B】2Dと同じ動き：PCでは対応する一覧のカードまで
      // スクロールして光らせる（main.js側のhighlightCard）。スマホは
      // 一覧が別画面のため、呼び出し先が自然に何もしない
      // （#results-listの高さが0のときはscrollSelectedCardIntoView()が
      // 早期returnする、map-view.jsと同じ仕組み）。
      if (this.onSelectionChange) this.onSelectionChange(feature.properties.id);
    });
    this.map.on('mouseenter', SPOTS_LAYER_ID, () => { this.map.getCanvas().style.cursor = 'pointer'; });
    this.map.on('mouseleave', SPOTS_LAYER_ID, () => { this.map.getCanvas().style.cursor = ''; });

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
    // 【不具合修正、12本目③】'gsi-dem'ソースが確実に存在するこの時点で呼ぶ
    // （上のcollapseAttribution設定箇所のコメント参照）。
    this.waitForTerrainLoaded().then(stopCollapsing);
    // 【2026-10-16、27本目、不具合修正】当初はwaitForTerrainLoaded()完了直後に
    // 吹き出しを出していたが、waitForTerrainLoaded()は標高タイル（DEM）の
    // 読み込みだけを見ており、淡色地図・航空写真の背景タイルはそれとは別に
    // まだ読み込み中のことがある（実機相当のPlaywright計測で確認：DEM読み込み
    // 完了は実際の表示が落ち着くよりかなり早く、3秒の自動非表示タイマーが
    // 「ユーザーがまだ途中の画面しか見ていない」うちに切れてしまっていた）。
    // waitForSceneSettled()と同じ「地形読み込み＋MapLibreの'idle'（描画・
    // タイル読み込みが完全に落ち着いた）」まで待ってから出すことで、ユーザーが
    // 実際に落ち着いた3D画面を見ている間に3秒間出るようにする。
    this.waitForTerrainLoaded()
      .then(() => new Promise((resolve) => {
        if (!this.map) { resolve(); return; }
        this.map.once('idle', resolve);
        setTimeout(resolve, 8000); // 保険（'idle'が来ない環境でも吹き出し自体は出す）
      }))
      .then(() => this._maybeShowRotateHint());

    if (this._lastDepartureStation || this._lastSpots) {
      this.render(this._lastDepartureStation, this._lastSpots || [], this._lastBudget);
    }
  }

  /**
   * @param {{display_name:string, stop_lat:number, stop_lon:number}} departureStation
   * @param {Array} spots - 予算¥2000で一度取得したallSpots全体（予算の絞り込みはapplyBudget側で行う）
   * @param {number} [budget] - 初期表示の予算。省略時は2000（全件が「少し薄い」状態で見える）
   * @param {{reveal?: boolean}} [opts] - 【2026-10-13、10本目②】reveal:trueで、出発駅から
   *   近い順に波が広がるように点を出す（Minami指示：「この条件で検索」を押したときだけ）。
   *   それ以外（予算操作の裏取得・3D初回有効化など）は従来どおり即座に全部出す。
   */
  render(departureStation, spots, budget, { reveal = false } = {}) {
    this._cancelFitCircleToView(); // 新しい検索で、前の予算操作から保留中の地図合わせは無効化する
    this._lastDepartureStation = departureStation;
    this._lastSpots = spots;
    this._lastBudget = budget;
    if (!this.map) return; // ensureMap前に呼ばれた場合は、座標だけ保持して後でensureMapから反映する

    this.clearSelected(); // 【2026-10-15、11本目①】検索し直したら枠・強調を外す

    if (this.departureMarker) {
      this.departureMarker.remove();
      this.departureMarker = null;
    }
    if (departureStation && isFiniteNumber(departureStation.stop_lat) && isFiniteNumber(departureStation.stop_lon)) {
      // 【2026-10-15、11本目①】吹き出し（ポップアップ）は廃止（Minami決定：A）。
      this.departureMarker = new maplibregl.Marker({ color: '#e06c2c' })
        .setLngLat([departureStation.stop_lon, departureStation.stop_lat])
        .addTo(this.map);
    }

    // 出発駅からの直線距離（km）を各スポットに付与する。予算の到達円の半径
    // （updateReachCircle）と、波の演出の遅延（nearest-first）の両方がこの値を使う。
    const hasDeparture = departureStation
      && isFiniteNumber(departureStation.stop_lat) && isFiniteNumber(departureStation.stop_lon);
    const features = (spots || [])
      .filter((spot) => isFiniteNumber(spot.latitude) && isFiniteNumber(spot.longitude))
      .map((spot) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [spot.longitude, spot.latitude] },
        properties: {
          ...spot,
          fare: spot.source_round_trip_fare,
          distance_km: hasDeparture
            ? haversineKm(departureStation.stop_lat, departureStation.stop_lon, spot.latitude, spot.longitude)
            : 0,
        },
      }));
    const source = this.map.getSource(SPOTS_SOURCE_ID);
    if (source) source.setData({ type: 'FeatureCollection', features });

    this.applyBudget(budget ?? 2000, { reveal });
    this.updateReachCircle(budget ?? 2000, { style: 'settled' });
  }

  /**
   * 【2026-10-15、11本目①】ピンの選択状態（吹き出し廃止の代わりの強調表示）。
   * 別ソース（selected-spot）に選択中の1件だけを描くことで、他の点の塗り分け
   * （spots-circleレイヤーの帯内/帯外）には触れずに済む。
   * @param {{id:string, latitude:number, longitude:number}} spot
   */
  setSelectedSpot(spot) {
    if (!this.map || !spot || !isFiniteNumber(spot.latitude) || !isFiniteNumber(spot.longitude)) return;
    this.selectedSpotId = spot.id;
    const source = this.map.getSource(SELECTED_SOURCE_ID);
    if (source) {
      source.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [spot.longitude, spot.latitude] }, properties: {} }],
      });
    }
  }

  /** 情報枠を閉じたとき・検索し直したとき・予算を触ったときに、ピンの強調だけを外す。 */
  clearSelected() {
    this.selectedSpotId = null;
    const source = this.map && this.map.getSource(SELECTED_SOURCE_ID);
    if (source) source.setData({ type: 'FeatureCollection', features: [] });
  }

  /**
   * 予算を確定させる（検索実行・裏取得等）。データの再取得は行わず、既存の
   * GeoJSONソースにsetFilter/setPaintPropertyを適用するだけ（Minami指示：計算は
   * ¥2000で一度出したallSpotsから帯で絞るだけで足りる）。
   * 【2026-10-13、10本目①】予算スライダー・±ボタンを動かしている間はこの
   * メソッドを呼ばない（Minami決定：円だけ広げる。点は検索を押すまで変えない）。
   * 呼ぶのは実際に検索した／裏で¥2000全域を取得し終えた／3Dを初めて有効化した
   * ときだけ（main.js参照）。
   * 帯（budget-200〜budget）の件数は毎回同期的に計算して返す（軽い配列操作のため
   * 間引く必要はない）。実際の塗り替え（setFilter/setPaintProperty）はMinami指示で
   * requestAnimationFrame 1コマに1回へ間引く（CPU4倍下で最大85msかかっていた
   * スライダー1コマを50ms以内に収めるため。10本目で予算操作自体がこのメソッドを
   * 呼ばなくなった今も、検索直後の塗り替え自体は引き続きこの間引きの恩恵を受ける）。
   * @param {number} budget
   * @param {{reveal?: boolean}} [opts]
   * @returns {number} 帯内の件数
   */
  applyBudget(budget, { reveal = false } = {}) {
    this._lastBudget = budget;
    const count = (this._lastSpots || []).filter(
      (s) => s.source_round_trip_fare <= budget && s.source_round_trip_fare > budget - BAND_WIDTH
    ).length;

    this._pendingPaintBudget = budget;
    this._pendingPaintReveal = reveal;
    if (!this._paintScheduled) {
      this._paintScheduled = true;
      requestAnimationFrame(() => {
        this._paintScheduled = false;
        this._paintBudget(this._pendingPaintBudget, this._pendingPaintReveal);
      });
    }
    return count;
  }

  _paintBudget(budget, reveal) {
    if (!this.map || !this.map.getLayer(SPOTS_LAYER_ID)) return;
    const inBand = inBandExpr(budget);
    // 帯に入る点＝大きめ＋光の輪（ぼかし+白縁）、それより安い点＝緑がかった灰色の
    // 小さい点（Minami指摘：見分けづらかったため色・形とも区別を強めた）。
    this.map.setPaintProperty(SPOTS_LAYER_ID, 'circle-radius', ['case', inBand, 10, 4]);
    this.map.setPaintProperty(SPOTS_LAYER_ID, 'circle-color', ['case', inBand, COLOR_IN_BAND, COLOR_CHEAPER]);
    this.map.setPaintProperty(SPOTS_LAYER_ID, 'circle-opacity', ['case', inBand, 0.95, 0.55]);
    this.map.setPaintProperty(SPOTS_LAYER_ID, 'circle-stroke-width', ['case', inBand, 3, 0]);
    this.map.setPaintProperty(SPOTS_LAYER_ID, 'circle-stroke-color', '#ffffff');
    this.map.setPaintProperty(SPOTS_LAYER_ID, 'circle-blur', ['case', inBand, 0.5, 0]);

    if (reveal && !prefersReducedMotion()) {
      this._startWaveReveal(budget);
    } else {
      this._cancelWaveReveal();
      this.map.setFilter(SPOTS_LAYER_ID, ['<=', ['get', 'fare'], budget]);
    }
  }

  /**
   * 【2026-10-13、10本目②】検索を押した直後、出発駅から近い順に点が波のように
   * 広がって出る演出（Minami指示：全体で1秒前後）。各スポットのdistance_km
   * （render()で付与済み）を使い、「予算内で一番遠い点までの距離」を1秒かけて
   * 0から広げるのと同じ考え方で、filterの距離条件を毎フレーム広げていく
   * （updateReachCircle()の半径計算と同じ最大距離を使うため、円が広がる速さと
   * 点が出る速さが自然に揃う）。prefers-reduced-motionのときは呼ばれない
   * （_paintBudget側で分岐済み）。
   */
  _startWaveReveal(budget) {
    this._cancelWaveReveal();
    const maxKm = (this._lastSpots || []).reduce((max, s) => {
      if (!isFiniteNumber(s.latitude) || !isFiniteNumber(s.longitude)) return max;
      if (s.source_round_trip_fare > budget) return max;
      const dep = this._lastDepartureStation;
      if (!dep || !isFiniteNumber(dep.stop_lat) || !isFiniteNumber(dep.stop_lon)) return max;
      return Math.max(max, haversineKm(dep.stop_lat, dep.stop_lon, s.latitude, s.longitude));
    }, 0);
    if (maxKm <= 0) {
      this.map.setFilter(SPOTS_LAYER_ID, ['<=', ['get', 'fare'], budget]);
      return;
    }
    const token = ++this._waveToken;
    const startTime = performance.now();
    const step = (now) => {
      if (token !== this._waveToken || !this.map) return;
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / WAVE_DURATION_MS);
      const revealedKm = maxKm * progress;
      this.map.setFilter(SPOTS_LAYER_ID, [
        'all',
        ['<=', ['get', 'fare'], budget],
        ['<=', ['get', 'distance_km'], revealedKm],
      ]);
      if (progress < 1) {
        this._waveFrame = requestAnimationFrame(step);
      } else {
        this._waveFrame = null;
        // 浮動小数点の端数で最遠点が漏れないよう、仕上げに距離条件を外す。
        this.map.setFilter(SPOTS_LAYER_ID, ['<=', ['get', 'fare'], budget]);
      }
    };
    this._waveFrame = requestAnimationFrame(step);
  }

  _cancelWaveReveal() {
    this._waveToken = (this._waveToken || 0) + 1;
    if (this._waveFrame) {
      cancelAnimationFrame(this._waveFrame);
      this._waveFrame = null;
    }
  }

  /**
   * 【2026-10-13、10本目②、Minami決定：A】予算の±・スライダーを動かしている間は
   * 点を変えず、出発駅を中心にした到達範囲の円だけを広げる・縮める。
   * 半径は「今の予算以内（往復）で行ける場所のうち、一番遠い場所までの直線距離」
   * （¥2000で先に取得済みのallSpotsから実測。推測値にしない、Minami指示）。
   * まだ検索していない（allSpots無し）ときは円を出さない。
   * 【2026-10-17、32本目B、Minami決定】半径の変化は瞬時に飛ばず、今の大きさから
   * 新しい大きさへ0.25秒ほどでなめらかに変える（_animateCircleRadius()）。
   * @param {number} budget
   * @param {{style?: 'live'|'settled'}} [opts] - settled:検索確定後（薄くする）
   */
  updateReachCircle(budget, { style = 'live' } = {}) {
    const dep = this._lastDepartureStation;
    let maxKm = 0;
    if (dep && isFiniteNumber(dep.stop_lat) && isFiniteNumber(dep.stop_lon)
      && this._lastSpots && this._lastSpots.length > 0) {
      maxKm = this._lastSpots.reduce((max, s) => {
        if (!isFiniteNumber(s.latitude) || !isFiniteNumber(s.longitude)) return max;
        if (s.source_round_trip_fare > budget) return max;
        return Math.max(max, haversineKm(dep.stop_lat, dep.stop_lon, s.latitude, s.longitude));
      }, 0);
    }
    this._animateCircleRadius(maxKm, style);
  }

  /**
   * 【2026-10-17、32本目B】円の半径を今の値（_reachCircleRadiusKm）から
   * targetKmへ、CIRCLE_RADIUS_ANIM_MSかけてなめらかに変える。呼ばれるたびに
   * 世代カウンタ（_circleAnimToken）を進めるため、スライダー操作中の連続呼び
   * 出しは「今アニメーション中の値」から新しい目標へ滑らかに繋ぎ直される
   * （瞬間移動せず、都度自然に方向転換する）。
   */
  _animateCircleRadius(targetKm, style) {
    this._pendingCircleStyle = style;
    if (this._circleAnimFrame) {
      cancelAnimationFrame(this._circleAnimFrame);
      this._circleAnimFrame = null;
    }
    const startKm = this._reachCircleRadiusKm;
    if (prefersReducedMotion() || Math.abs(targetKm - startKm) < 0.01) {
      this._paintReachCircle(targetKm, style);
      return;
    }
    const token = ++this._circleAnimToken;
    const startTime = performance.now();
    const step = (now) => {
      if (token !== this._circleAnimToken || !this.map) return;
      const progress = Math.min(1, (now - startTime) / CIRCLE_RADIUS_ANIM_MS);
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

  _paintReachCircle(radiusKm, style) {
    if (!this.map) return;
    this._reachCircleRadiusKm = radiusKm;
    const source = this.map.getSource(REACH_CIRCLE_SOURCE_ID);
    const dep = this._lastDepartureStation;
    if (!source || !dep || !radiusKm || radiusKm <= 0) {
      if (source) source.setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    const ring = [];
    for (let i = 0; i <= REACH_CIRCLE_POINTS; i++) {
      const bearingDeg = (360 / REACH_CIRCLE_POINTS) * i;
      const { lat, lon } = destinationPoint(dep.stop_lat, dep.stop_lon, bearingDeg, radiusKm);
      ring.push([lon, lat]);
    }
    source.setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} }],
    });
    const opacities = style === 'settled'
      ? { fill: 0.07, line: 0.35 }
      : { fill: 0.12, line: 0.55 };
    this.map.setPaintProperty(REACH_CIRCLE_FILL_LAYER_ID, 'fill-opacity', opacities.fill);
    this.map.setPaintProperty(REACH_CIRCLE_LINE_LAYER_ID, 'line-opacity', opacities.line);
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
      this.fitCircleToView();
    }, CIRCLE_FIT_DEBOUNCE_MS);
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
   * 出発駅からの半径で決まる円の外接範囲を使う）。
   * 向き（bearing）・傾き（pitch）は今の値のまま変えない（Minami指示：
   * ハンドルで向き・傾きを変えたあとに＋／−を押しても戻らない）。
   * 中心は出発駅に固定する（円は必ず出発駅中心のため、対称な余白
   * （padding）を使えば出発駅中心＝cameraForBounds()が計算する中心と一致する）。
   */
  fitCircleToView() {
    if (!this.map) return;
    const dep = this._lastDepartureStation;
    const radiusKm = this._reachCircleRadiusKm;
    if (!dep || !isFiniteNumber(dep.stop_lat) || !isFiniteNumber(dep.stop_lon) || !radiusKm || radiusKm <= 0) {
      return;
    }
    // 【不具合修正、32本目B】スマホの予算操作帯（#mobile-budget-overlay）は
    // 「一覧」タブを見ている間も操作できる（22本目）ため、0.4秒のデバウンス後に
    // この関数が発火する時点では、地図タブ側のコンテナ（#spots-map-3d）が
    // タブ切替でdisplay:none・0×0になっていることがある。0×0のまま
    // cameraForBounds()を呼ぶとMapLibreが「Map cannot fit within canvas」の
    // 警告を出す（verify-layoutの実機相当検証で実際に確認）。コンテナが
    // 見えていないときは何もしない（円自体は既に正しい半径で描画済みのため、
    // 地図タブへ戻って次に予算を操作したときに改めて合わせ直せば実害はない）。
    const container = this.map.getContainer();
    if (container.clientWidth === 0 || container.clientHeight === 0) return;
    const north = destinationPoint(dep.stop_lat, dep.stop_lon, 0, radiusKm);
    const east = destinationPoint(dep.stop_lat, dep.stop_lon, 90, radiusKm);
    const south = destinationPoint(dep.stop_lat, dep.stop_lon, 180, radiusKm);
    const west = destinationPoint(dep.stop_lat, dep.stop_lon, 270, radiusKm);
    const bounds = [
      [west.lon, south.lat],
      [east.lon, north.lat],
    ];

    const shortSide = Math.max(1, Math.min(container.clientWidth, container.clientHeight));
    // 【2026-10-20、35本目、Minami決定：A、不具合修正】「地図を合わせたあと、
    // 円の直径が見えている範囲の短い辺の7〜8割になるように」という目標から
    // 直接、余白の比率を逆算する（以前の「短辺の8%」と「固定90px」をmax()で
    // 二重に持つ設計をやめた）。bounds（円の外接矩形）の一辺＝円の直径と
    // ほぼ一致するため、cameraForBounds()が余白pxぶんを除いた残りに
    // boundsをぴったり収めるという性質を使い、
    // 余白(片側) = 短辺 × (1 - 目標直径比率) / 2 という単純な式で求める
    // （目標0.75なら余白は短辺の12.5%）。対称な（上下左右同じ）paddingを
    // 渡すことで、cameraForBounds()が計算する中心＝円の幾何中心（出発駅）に
    // なる（出発駅中心を保つため、上下左右で余白を変えない）。
    // 【不具合修正、32本目B】上下左右対称のpaddingは「左右の合計」「上下の合計」が
    // それぞれコンテナの幅・高さ未満でないと、MapLibreが「Map cannot fit
    // within canvas」という警告を出す（getRevealPadding()が同じ理由で既に
    // 動的にクランプしているのと同じ事情）。短い辺の半分未満（余裕を見て
    // 半分-1px）にクランプする（目標比率が0.75なら12.5%で収まるため、通常は
    // このクランプに当たらない）。
    const targetPadding = Math.round(shortSide * (1 - CIRCLE_FIT_TARGET_DIAMETER_RATIO) / 2);
    const padding = Math.min(targetPadding, Math.floor(shortSide / 2) - 1);
    // 【不具合修正、32本目B、根本原因特定】上のクランプだけでは「own」viewport
    // （400×464）で実際に警告が再現した。原因を追ったところ、cameraForBounds()は
    // 引数のpaddingだけでなく、地図に残っている現在のpadding状態
    // （flyToSpot()がgetRevealPadding()で設定したまま、戻るときに明示的に
    // 0へ戻していない場合がある）も合算して「収まるか」を判定していた
    // （MapLibre本体のソースで、引数のpadding合計＋地図の現在のpadding合計が
    // コンテナの辺の長さを超えるとkt()＝この警告を出す実装を確認）。
    // ピンを選んで寄ったあと（情報枠を帯よけのpaddingぶん開けたまま）
    // 予算を操作すると、この関数の引数paddingに地図の残存paddingが上乗せされ、
    // 小さい画面で合計がコンテナの辺を超えてしまっていた。cameraForBounds()を
    // 呼ぶ前に地図のpaddingを明示的に0へ戻し、引数のpaddingだけで判定させる。
    this.map.setPadding(CLEAR_PADDING);
    const pitch = this.map.getPitch();
    const bearing = this.map.getBearing();
    const camera = this.map.cameraForBounds(bounds, { padding, pitch, bearing });
    if (!camera) return;
    const zoom = Math.max(camera.zoom, CIRCLE_FIT_MIN_ZOOM);

    this.map.easeTo({
      center: [dep.stop_lon, dep.stop_lat],
      zoom,
      pitch,
      bearing,
      duration: prefersReducedMotion() ? 0 : CIRCLE_FIT_DURATION_MS,
      padding: CLEAR_PADDING,
    });
    this._focusedOnSpot = false;
    this._flyFocusedSpotId = null;
    if (this.onFocusChange) this.onFocusChange(false);
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
   * 【2026-10-15、11本目②】この「全体の位置」に戻すたびに_focusedOnSpotを
   * falseにし、onFocusChangeで「全体を見る」ボタンの表示を更新する。
   * @param {number} budget
   * @param {{durationMs?: number}} [opts] - 既定600ms。予算操作時の自動復帰・
   *   「全体を見る」ボタンではMinami指示の1.5秒前後（RETURN_TO_OVERVIEW_DURATION_MS）を渡す。
   */
  fitToBudget(budget, { durationMs = 600 } = {}) {
    if (!this.map) return;
    this._cancelFitCircleToView();
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

    // 【2026-10-13、10本目①】向き（bearing）は変えない（Minami指示）。現在の
    // bearingをそのまま渡すことで、実質「変えない」になる。
    // 【2026-10-13、20本目修正】flyToSpot()で設定した帯よけのpadding
    // （REVEAL_ABOVE_BAND_PADDING）が残ったままだと、MapLibreのpaddingは
    // 明示的に指定しない限り残り続けるため、全体表示の構図（短い辺の8%・
    // 最小ズーム9.5）が狂う。ここで明示的に0へ戻す。
    this.map.easeTo({
      center, zoom, pitch: DEFAULT_PITCH, bearing: this.map.getBearing(),
      duration: prefersReducedMotion() ? 0 : durationMs,
      padding: CLEAR_PADDING,
    });
    this._focusedOnSpot = false;
    this._flyFocusedSpotId = null;
    if (this.onFocusChange) this.onFocusChange(false);
  }

  /**
   * 【2026-10-15、11本目②、Minami決定：C】「全体を見る」ボタン・予算操作時の
   * 自動復帰。場所に寄っている（_focusedOnSpot）ときだけ全体の位置へなめらかに
   * 引く（1.5秒前後）。航空写真→淡色地図の切り替えは既存のズーム連動式
   * （AERIAL_OPACITY_EXPR）がそのまま効くため、ここで特別な処理は不要。
   */
  returnToOverview() {
    if (!this._focusedOnSpot || this._lastBudget == null) return;
    this.fitToBudget(this._lastBudget, { durationMs: RETURN_TO_OVERVIEW_DURATION_MS });
  }

  /**
   * 指定したスポットへ寄る（Minami指示、5本目：地図の点をタップした/一覧の
   * カードを選んだ/詳細画面を開いたとき）。
   *
   * 【2026-10-13、10本目①、Minami決定：B】向き（bearing）は変えない。以前は
   * 出発駅→スポットの方位角に合わせて回転していたが、「地図が勝手に回る・
   * 向きが大きく変わるのが無駄な動きに感じる、触り続けると酔う」という
   * Minami指摘により、回転をまるごと廃止した（自動回転・flyToSpotでの
   * bearing変更の両方）。寄るときは今のbearingのまま。
   *
   * 【2026-10-13、8本目③】7本目の調査で「寄ってから景色が見えるまで」の
   * 遅さの主因は背景タイルの読み込み量と判明した（原因そのものの深追いは
   * 今回せず、Minami指示で見せ方・読み込み量側の対策に切り替えた）。
   * 真上から見た向き（pitch0）はpitch60に比べ画面に地平線側の遠いタイルが
   * 入らないため、読み込む量が少なく航空写真がすぐ見える。そこでまず
   * pitch0・ズーム14へ降り、画面中央付近の地形・背景の読み込みが落ち着いたら
   * （waitForSceneSettled()）、pitch0→60へ2秒ほどで傾けて立体にする。
   * 傾けている最中・傾け終わった後に地平線側の遠いタイルが遅れて出るのは
   * 許容する（Minami指示）。
   * 降りている途中でユーザーが地図を操作すると、_flySpotTokenが進んで
   * 以降の演出（傾け）を行わない（上のdragstart等の購読箇所を参照。
   * ユーザー操作を優先）。
   * prefers-reduced-motionのときは、降りる・傾けるを1回の短い移動に
   * まとめる（Minami指示）。
   * @param {{latitude:number, longitude:number}} spot
   * @param {{stop_lat:number, stop_lon:number}} [departureStation] - 10本目で
   *   bearing計算に使わなくなったが、呼び出し元との互換のため引数は残す。
   */
  /**
   * 【2026-10-13、22本目、Minami指示】REVEAL_ABOVE_BAND_PADDING_MAX
   * （地図が十分高いときの理想値、bottom=180）を、今の地図の高さの半分を
   * 超えないよう動的に小さくする。超えたまま渡すとMapLibreが
   * 「Map cannot fit within canvas with the given bounds, padding, and/or
   * offset」という警告を出す（スマホで地図が70px程度まで潰れていたときに
   * 実際に発生していた）。CSS側で地図に最低240pxの高さを設けた今も、
   * 念のためここでも必ずクランプする（CSSが適用されない将来の呼び出し
   * 経路や、240px未満の極端な画面があっても警告を出さないため）。
   */
  getRevealPadding() {
    const container = this.map?.getContainer();
    const height = container?.clientHeight || 0;
    const maxBottom = REVEAL_ABOVE_BAND_PADDING_MAX.bottom;
    const bottom = height > 0 ? Math.min(maxBottom, Math.floor(height / 2)) : maxBottom;
    return { top: 0, right: 0, bottom, left: 0 };
  }

  /**
   * 【2026-10-17、32本目A、Minami決定】向き・傾きを変えるハンドル
   * （index.htmlの#map-rotate-handle）。外側のふち（#map-rotate-dial）を
   * なぞると向き（bearing）、真ん中のくぼみ（#map-rotate-knob）の中のたての
   * 溝を上下にドラッグすると傾き（pitch、0〜75度）が変わる。【27】にあった
   * 「つまみを押すと北・傾き60度に戻る」操作は廃止した（Minami決定：ハンドル
   * から伝えられる操作は「回す」「上下に動かす」の2つまでにし、「北へ戻す」は
   * 別の方位磁針（_setupCompassButton()）に分離する）。
   * 回す・傾ける中心（ピボット）は、MapLibreの既存のpadding機構
   * （flyToSpot()・getRevealPadding()参照。20本目で確立：paddingは「見える
   * 範囲」を再定義し、カメラ操作はそのpaddingの中心を軸にする）をそのまま
   * 使うため、ここで中心を計算し直す必要はない（選んだピンがあればそのピン、
   * 無ければ画面中心を軸に、自然に回る・傾く）。
   * 【不具合修正】destroy()→ensureMap()の再生成（WebGLコンテキスト確保
   * 失敗時のリトライ等）で_createMap()が複数回走っても、ハンドルのDOM要素
   * 自体は静的HTMLで使い回しのため、ポインタ・キーボードのリスナーを
   * 毎回追加すると二重発火する。これらはdataset目印で最初の1回だけ登録し、
   * 地図インスタンスに紐づくダイヤル・つまみの同期（'rotate'・'pitch'
   * イベント購読）だけを呼び出しのたびに付け直す。
   */
  _setupRotateHandle() {
    const handle = document.getElementById('map-rotate-handle');
    const knob = document.getElementById('map-rotate-knob');
    const dial = document.getElementById('map-rotate-dial');
    const thumb = document.getElementById('map-pitch-thumb');
    if (!handle || !knob || !dial || !thumb) return;

    const updateDial = () => {
      if (!this.map) return;
      const bearing = this.map.getBearing();
      const pitch = this.map.getPitch();
      // ダイヤル（ふち＋本体）ごと回す。実物のつまみと同じく、ふちの
      // ギザギザ・本体の金属光沢も一緒に回る（ふちの目印.map-rotate-tickは
      // ダイヤルの子要素のため、これだけで向きを示す位置が動く）。
      dial.style.transform = `rotate(${bearing}deg)`;
      handle.setAttribute('aria-valuenow', String(Math.round(normalizeRotateAngle(bearing))));
      // つまみの位置で傾きを示す（上＝斜めから＝pitch大、下＝真上から＝pitch0）。
      const track = thumb.parentElement;
      const trackHeight = track.clientHeight || 18;
      const thumbHeight = thumb.clientHeight || 7;
      const fraction = clamp(pitch, HANDLE_PITCH_MIN, HANDLE_PITCH_MAX) / HANDLE_PITCH_MAX;
      const topPx = (1 - fraction) * (trackHeight - thumbHeight);
      thumb.style.top = `${topPx}px`;
      thumb.style.transform = 'translateX(-50%)';
    };
    updateDial();
    this.map.on('rotate', updateDial);
    this.map.on('pitch', updateDial);

    if (handle.dataset.rotateHandleWired) return;
    handle.dataset.rotateHandleWired = 'true';

    const hideRotateHint = () => {
      const hint = document.getElementById('map-rotate-hint');
      if (hint && !hint.hidden) hint.hidden = true;
    };

    // --- 外側のふち：なぞって回す（【23】【27】と同じ仕組み。回す基準は
    //     ダイヤルの現在の回転角そのもの＝bearing、针の仮想角度は使わない） ---
    let grabOffset = 0;
    const onRingPointerMove = (e) => {
      if (!this.map) return;
      const rect = handle.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const angle = screenAngleDeg(e.clientX, e.clientY, cx, cy);
      this.map.setBearing(angle + grabOffset);
    };
    const onRingPointerUp = (e) => {
      handle.removeEventListener('pointermove', onRingPointerMove);
      handle.removeEventListener('pointerup', onRingPointerUp);
      handle.removeEventListener('pointercancel', onRingPointerUp);
      try { handle.releasePointerCapture(e.pointerId); } catch { /* 既に解放済みのブラウザがある */ }
    };
    handle.addEventListener('pointerdown', (e) => {
      if (!this.map) return;
      if (typeof e.button === 'number' && e.button !== 0) return; // 左クリック・タッチのみ
      e.preventDefault();
      hideRotateHint();
      this._flySpotToken++; // 「降りる→傾ける」演出の途中でも、ユーザー操作を優先して止める
      const rect = handle.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const grabAngle = screenAngleDeg(e.clientX, e.clientY, cx, cy);
      grabOffset = this.map.getBearing() - grabAngle;
      handle.setPointerCapture(e.pointerId);
      handle.addEventListener('pointermove', onRingPointerMove);
      handle.addEventListener('pointerup', onRingPointerUp);
      handle.addEventListener('pointercancel', onRingPointerUp);
    });

    // --- 真ん中のくぼみ：上下にドラッグすると傾きが変わる（押しても何も
    //     起きない。北へ戻すのは方位磁針の役目、Minami決定） ---
    // 【重要】.map-rotate-dialはpointer-events既定（auto）のままのため、
    // つまみの上に重なるこの要素自体のpointerdownでstopPropagation()しないと、
    // 親（#map-rotate-handle）のふちの回転処理も同時に走ってしまう
    // （【23】【27】から踏襲）。
    let knobStartY = 0;
    let knobStartPitch = 0;
    const onKnobPointerMove = (e) => {
      if (!this.map) return;
      const dy = knobStartY - e.clientY; // 上へ動かす＝正の値
      const newPitch = clamp(knobStartPitch + dy * HANDLE_PITCH_DEG_PER_PX, HANDLE_PITCH_MIN, HANDLE_PITCH_MAX);
      this.map.setPitch(newPitch);
    };
    const onKnobPointerUp = (e) => {
      knob.removeEventListener('pointermove', onKnobPointerMove);
      knob.removeEventListener('pointerup', onKnobPointerUp);
      knob.removeEventListener('pointercancel', onKnobPointerUp);
      try { knob.releasePointerCapture(e.pointerId); } catch { /* 既に解放済みのブラウザがある */ }
    };
    knob.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (!this.map) return;
      if (typeof e.button === 'number' && e.button !== 0) return;
      e.preventDefault();
      hideRotateHint();
      this._flySpotToken++;
      knobStartY = e.clientY;
      knobStartPitch = this.map.getPitch();
      knob.setPointerCapture(e.pointerId);
      knob.addEventListener('pointermove', onKnobPointerMove);
      knob.addEventListener('pointerup', onKnobPointerUp);
      knob.addEventListener('pointercancel', onKnobPointerUp);
    });

    // キーボード操作：←→で向きが少しずつ回る、↑↓で傾きが少しずつ変わる
    // （【27】にあったEnterでの復帰は、押しても北に戻らない仕様変更に合わせて
    // 廃止。北へ戻す操作は方位磁針のEnter/クリックが担う）。
    handle.addEventListener('keydown', (e) => {
      if (!this.map) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        hideRotateHint();
        this._flySpotToken++;
        this.map.setBearing(this.map.getBearing() - HANDLE_BEARING_KEY_STEP_DEG);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        hideRotateHint();
        this._flySpotToken++;
        this.map.setBearing(this.map.getBearing() + HANDLE_BEARING_KEY_STEP_DEG);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        hideRotateHint();
        this._flySpotToken++;
        this.map.setPitch(clamp(this.map.getPitch() + HANDLE_PITCH_KEY_STEP_DEG, HANDLE_PITCH_MIN, HANDLE_PITCH_MAX));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        hideRotateHint();
        this._flySpotToken++;
        this.map.setPitch(clamp(this.map.getPitch() - HANDLE_PITCH_KEY_STEP_DEG, HANDLE_PITCH_MIN, HANDLE_PITCH_MAX));
      }
    });
  }

  /**
   * 【2026-10-17、32本目A、Minami決定】方位磁針（index.htmlの
   * #map-compass-btn、ハンドルの上に別置き）。押すと北（bearing0）だけに
   * なめらかに戻る（傾きは変えない）。ハンドルから「押すと元に戻る」操作を
   * 外した代わり（ハンドルで伝えられる操作は「回す」「上下に動かす」の
   * 2つまでにする、というMinami決定に伴う分離）。
   */
  _setupCompassButton() {
    const btn = document.getElementById('map-compass-btn');
    const needle = document.getElementById('map-compass-needle');
    if (!btn || !needle) return;

    const updateCompassNeedle = () => {
      if (!this.map) return;
      const bearing = this.map.getBearing();
      // 【27】の針と同じ向きの規約（bearingの符号を反転して回す）。
      needle.style.transform = `rotate(${-bearing}deg)`;
    };
    updateCompassNeedle();
    this.map.on('rotate', updateCompassNeedle);

    if (btn.dataset.compassWired) return;
    btn.dataset.compassWired = 'true';

    btn.addEventListener('click', () => {
      if (!this.map) return;
      const hint = document.getElementById('map-rotate-hint');
      if (hint && !hint.hidden) hint.hidden = true;
      this._flySpotToken++;
      this.map.easeTo({ bearing: 0, duration: HANDLE_RESET_DURATION_MS });
    });
  }

  /**
   * 【2026-10-16、27本目】初めて3Dに切り替えたときだけ、ハンドルの使い方を
   * 示す小さな吹き出しを3秒ほど出す（Minami指示）。吹き出しを押すか
   * ハンドルに触ると消える（_setupRotateHandle()のhideRotateHint()参照）。
   * 一度出したら（出し終えるのを待たず、出した時点で）localStorageに記録し、
   * 次回以降は出さない。
   */
  _maybeShowRotateHint() {
    const hint = document.getElementById('map-rotate-hint');
    if (!hint || hasSeenRotateHint()) return;
    markRotateHintSeen();
    hint.hidden = false;
    hint.addEventListener('click', () => { hint.hidden = true; }, { once: true });
    setTimeout(() => { hint.hidden = true; }, ROTATE_HINT_AUTO_HIDE_MS);
  }

  /**
   * 【2026-10-15、26本目、不具合修正】flyToSpot()の「傾け」段階が終わった
   * （と判定された）時点で呼ぶ。実際のpitchが目標（SPOT_FOCUS_PITCH）から
   * 大きくずれていたら、MapLibreのアニメーション割り込みが競合し傾けが
   * 完了し切れなかったと判断し、もう一度だけ傾け直してから完了を報告する
   * （無限リトライはしない。この2回目はここまでの一連の呼び出しが終わった
   * 後の単独呼び出しのため、割り込み競合は起きずに最後まで走ることを
   * 確認済み）。
   * @param {object} spot
   * @param {number} token
   */
  _ensurePitchThenComplete(spot, token) {
    if (token !== this._flySpotToken || !this.map) return;
    if (Math.abs(this.map.getPitch() - SPOT_FOCUS_PITCH) <= PITCH_CORRECTION_TOLERANCE_DEG) {
      if (this.onTiltComplete) this.onTiltComplete(spot);
      return;
    }
    this.map.easeTo({
      pitch: SPOT_FOCUS_PITCH,
      zoom: SPOT_FOCUS_ZOOM,
      center: [spot.longitude, spot.latitude],
      duration: TILT_DURATION_MS,
      padding: this.getRevealPadding(),
    });
    this.map.once('moveend', () => {
      if (token !== this._flySpotToken || !this.map) return;
      if (this.onTiltComplete) this.onTiltComplete(spot);
    });
  }

  flyToSpot(spot, departureStation) {
    if (!this.map || !isFiniteNumber(spot?.latitude) || !isFiniteNumber(spot?.longitude)) return;
    this._cancelFitCircleToView(); // スポットへ寄る操作を、保留中の円合わせに邪魔されないようにする
    // 【2026-10-15、26本目、不具合修正】既にこの場所へ寄っている最中・寄り終えた
    // 状態で同じピンをもう一度押すと(読み込み待ちで画面が止まって見える間の
    // 連打等)、傾ける前の「降りる」flyTo()が「中心・ズームが現在と同じ＝移動
    // 距離ゼロ」と判定され、pitchのアニメーションを正しく行わないままmoveend
    // を発火させ、傾きが中途半端な値で止まる不具合があった（実機相当の
    // Playwright計測で確認：二度目のクリックで最終pitchが27.5のまま固まった）。
    // easeTo()同士（flyTo()を介さない）であれば同じ中心・ズームでも割り込み後に
    // pitchが正しく最後までアニメーションすることを別途確認済みのため、
    // 既にこの場所に寄っている場合は「降りる→傾ける」の2段階をやり直さず、
    // 傾けのeaseTo()だけを直接呼ぶ。
    const sameSpotAlreadyFocused = this._focusedOnSpot && this._flyFocusedSpotId === spot.id;
    const token = ++this._flySpotToken;
    this._flyFocusedSpotId = spot.id;
    // 【2026-10-15、11本目②】寄り始めた時点で「全体を見る」ボタンを出す
    // （Minami決定：C。途中でも全体へ戻れるようにする）。
    this._focusedOnSpot = true;
    if (this.onFocusChange) this.onFocusChange(true);
    const revealPadding = this.getRevealPadding();

    if (sameSpotAlreadyFocused && !prefersReducedMotion()) {
      this.map.easeTo({
        pitch: SPOT_FOCUS_PITCH,
        zoom: SPOT_FOCUS_ZOOM,
        center: [spot.longitude, spot.latitude],
        duration: TILT_DURATION_MS,
        padding: revealPadding,
      });
      this.map.once('moveend', () => {
        if (token !== this._flySpotToken || !this.map) return;
        this.waitForSceneSettled().then(() => {
          this._ensurePitchThenComplete(spot, token);
        });
      });
      return;
    }

    if (prefersReducedMotion()) {
      this.map.flyTo({
        center: [spot.longitude, spot.latitude],
        zoom: SPOT_FOCUS_ZOOM,
        pitch: SPOT_FOCUS_PITCH,
        duration: REDUCED_MOTION_FLY_DURATION_MS,
        padding: revealPadding,
        essential: true,
      });
      if (this.onOverheadSettled) this.onOverheadSettled(spot);
      if (this.onTiltComplete) this.onTiltComplete(spot);
      return;
    }

    this.map.flyTo({
      center: [spot.longitude, spot.latitude],
      zoom: SPOT_FOCUS_ZOOM,
      pitch: 0,
      duration: SPOT_FOCUS_DURATION_MS,
      padding: revealPadding,
      essential: true,
    });

    this.map.once('moveend', () => {
      if (token !== this._flySpotToken || !this.map) return; // ユーザー操作・次のflyToSpotで無効化済み
      this.waitForSceneSettled().then(() => {
        if (token !== this._flySpotToken || !this.map) return;
        if (this.onOverheadSettled) this.onOverheadSettled(spot);
        // center・paddingを傾けのeaseToでも明示し直す（spotの座標＋情報帯よけの
        // ずらし幅を毎回同じに保つ。paddingだけ省略した場合の挙動に依存しない）。
        this.map.easeTo({
          pitch: SPOT_FOCUS_PITCH,
          duration: TILT_DURATION_MS,
          center: [spot.longitude, spot.latitude],
          padding: revealPadding,
        });
        this.map.once('moveend', () => {
          if (token !== this._flySpotToken || !this.map) return;
          // 【2026-10-13、8本目③修正】傾け終わった直後にそのまま
          // onTiltCompleteを呼ぶと、画面がぼやけたまま「傾け終わった」と
          // 報告してしまう不具合があった。isCenterTileReady()は「現時点で
          // キャッシュにある、中央点を覆う最高ズームのタイル」を見るため、
          // pitch0の時点では中央付近に必要な低いズームのタイルしか要求
          // されておらず、それが読込済みというだけでwaitForSceneSettled()が
          // trueを返していた。ところがpitch60へ傾けると、同じ中央点でも
          // 遠近感補正のためより高いズームのタイルが新たに必要になり
          // （7本目の調査で確認済み：pitch0時より高いズームのタイルを要求
          // する）、傾け終わった時点ではまだそれらが読込中のことがある。
          // 傾けた後の視点に必要なタイルを改めて待つため、ここでも
          // waitForSceneSettled()を呼ぶ（降りた後と同じ理由）。
          this.waitForSceneSettled().then(() => {
            this._ensurePitchThenComplete(spot, token);
          });
        });
      });
    });
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

  /**
   * 【2026-10-12、7本目②】画面中央付近の地形・背景タイルの読み込みが
   * 済んだ時点を判定する（Minami指示：「見える」は中央付近が揃った時点とし、
   * 遠くのタイル・地平線側まで待たない）。waitForTerrainLoaded()はDEM
   * ソース全体（画面の端・地平線側を含む全タイル）の完了を待つため重く、
   * 実測で寄ってから20秒前後かかっていた。こちらは中央の経緯度を覆う
   * タイル（DEM・現在のズームに応じた背景レイヤー）だけを見るため、
   * 体感の「もう景色が見えている」に近い時点で解決する。
   * ズーム12.5〜13.5（航空写真への切り替え区間）の間は、淡色地図・航空写真
   * 両方が中央で読み込み済みであることを求める（どちらが主に見えているか
   * 確定していない区間のため）。
   *
   * 【2026-10-12、計測中に発覚した不具合の修正】flyTo()呼び出し直後（アニメー
   * ション開始直後）にこのメソッドを呼ぶと、map.getCenter()がまだ出発地点に
   * 近い値を返すため、そこを覆うタイル（俯瞰時に既読込）を見て即座に
   * 「揃っている」と誤判定していた（実測：新基準の経過時間が0〜1msという
   * 明らかにおかしい値になって発覚）。flyTo・easeTo等のカメラアニメーション
   * 中（map.isMoving()）は、最初の'moveend'まで判定を保留することで、
   * 必ず最終的な到着地点を基準に判定するようにした。
   * @param {number} [timeoutMs]
   * @returns {Promise<boolean>}
   */
  waitForSceneSettled(timeoutMs = 15000) {
    if (!this.map) return Promise.resolve(false);
    const map = this.map;
    const backgroundIdsToCheck = () => {
      const zoom = map.getZoom();
      if (zoom <= BG_CROSSFADE_ZOOM_START) return [BG_PALE_LAYER_ID];
      if (zoom >= BG_CROSSFADE_ZOOM_END) return [BG_AERIAL_LAYER_ID];
      return [BG_PALE_LAYER_ID, BG_AERIAL_LAYER_ID];
    };
    const isSettled = () => {
      if (map.isMoving()) return false; // カメラアニメーション中は到着地点が確定していない
      const center = map.getCenter();
      if (!isCenterTileReady(map, DEM_SOURCE_ID, center.lng, center.lat)) return false;
      return backgroundIdsToCheck().every((id) => isCenterTileReady(map, id, center.lng, center.lat));
    };
    return new Promise((resolve) => {
      if (isSettled()) {
        resolve(true);
        return;
      }
      const onData = () => {
        if (isSettled()) finish(true);
      };
      const onMoveEnd = () => {
        if (isSettled()) finish(true);
      };
      const finish = (result) => {
        clearTimeout(timeout);
        map.off('data', onData);
        map.off('moveend', onMoveEnd);
        resolve(result);
      };
      const timeout = setTimeout(() => finish(false), timeoutMs);
      map.on('data', onData);
      map.on('moveend', onMoveEnd);
    });
  }

  resize() {
    if (this.map) this.map.resize();
  }

  /** 2D切替時・再試行時にWebGLコンテキストを確実に解放する（上限超過による失敗を防ぐ） */
  destroy() {
    this._cancelWaveReveal();
    this._cancelFitCircleToView();
    if (this._circleAnimFrame) {
      cancelAnimationFrame(this._circleAnimFrame);
      this._circleAnimFrame = null;
    }
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
    this.departureMarker = null;
  }
}
