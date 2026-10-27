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

// 【2026-10-21、43本目D（44本目で差し替え）、Minami決定】下地の地図は、どの縮尺でも
// 国土地理院のベクトル地図（地理院地図Vector）を、地図記号なし・アプリの色にしたもの
// （scripts/build-map-style.jsが作るvendor/gsi-vector/app-style.json、2Dと共通）。
// 以前の「全体は淡色地図の画像タイル、寄ると航空写真」（7本目のスタイルD）はやめた
// （Minami：2Dの標準地図は情報が多くごちゃごちゃ、3Dで寄ると航空写真に変わるのもスマートで
// ない。Googleマップのように、情報の少ない同じ地図をどの縮尺でも使いたい）。
// ページ（index.html）からの相対URL（このモジュール自体はvendor/maplibre/に置かれるが、
// fetch()はページの場所を基準に解決する）。
const APP_MAP_STYLE_URL = './vendor/gsi-vector/app-style.json';
const GSI_DEM_PROTOCOL_TILE_URL = 'gsidem://https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png';
const GSI_DEM_ATTRIBUTION = '国土地理院の標高タイルを加工して3D地形として表示';
// 【2026-10-25、56本目、Minami決定：A'】応募条件で必須の表示3点（データの出典・正確性の非保証・問い合わせ先）。
// フッターをやめたため、地図の右下の出典（ⓘ）を開いたときにこの短い文を出し、「出典の詳細・免責・お問い合わせ」
// から出典画面（#about-modal）を開けるようにする。トップの検索カードの下と結果の入れ物の一番下にも、
// 「データ出典・免責」の1行をいつも置いている。2D（map-view.js）と同じ文。
const REQUIRED_NOTICE_HTML =
  '交通データ：GTFSデータリポジトリ・公共交通オープンデータセンターほか（各公開元） ｜ ' +
  '表示内容の正確性・完全性は保証されません ｜ ' +
  'お問い合わせは開発者へ（交通事業者へは問い合わせないでください） ｜ ' +
  '<a href="#" class="open-about-data">出典の詳細・免責・お問い合わせ</a>';

// 【43本目D】地形に貼り付ける層の表示範囲を下へずらす段数（_createMap()のshiftZoomRange参照）。
const TERRAIN_DRAPE_ZOOM_SHIFT = 1;

let appMapStylePromise = null;
/** 下地の地図のスタイル（JSON）を読み込む（1回だけ）。 */
function loadAppMapStyle() {
  if (!appMapStylePromise) {
    appMapStylePromise = fetch(APP_MAP_STYLE_URL).then((res) => {
      if (!res.ok) throw new Error(`地図のスタイルの読み込みに失敗しました（${res.status}）`);
      return res.json();
    }).catch((e) => {
      appMapStylePromise = null; // 次の3D切替でやり直せるようにする
      throw e;
    });
  }
  return appMapStylePromise;
}

const DEFAULT_PITCH = 57; // Minami指示：55〜60の中間
// 【2026-10-21、41本目、Minami決定：案1】全体の見え方（検索した直後・最初の見え方に戻る
// ボタン・「← 一覧に戻る」）のときだけ、傾きを57°より浅い45°にする。57°では円の奥側が
// 遠近でつぶれ、画面の上の約4割に出発駅から6〜44km先の遠景が写り（富山駅北口なら
// 富山湾）、円が下の方に小さく見えていた（40本目の計測）。場所に寄ったときの傾き
// （SPOT_FOCUS_PITCH）は変えない。ハンドルで傾きを変えた人が金額を変えたときも、
// 傾きは勝手に戻さない（＋−の地図合わせfitAfterBudgetChange()は今の傾きのまま）。
const OVERVIEW_PITCH = 45;
const DEFAULT_ZOOM = 9;
const DEFAULT_EXAGGERATION = 2; // Minami指示：2〜2.5倍から開始
const DEM_MAXZOOM = 12; // Minami指示：DEM10Bの範囲に抑え、それ以上は自動オーバーズーム

// 【43本目D】以下の7本目の「淡色地図→航空写真」の切り替え（BG_*）は廃止した。陰影の強さ・色を
// ズームで変える式（全体は強め・寄ったら弱め）だけは、地形の立体感のために残している。
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
const HILLSHADE_EXAGGERATION_EXPR = ['interpolate', ['linear'], ['zoom'], BG_CROSSFADE_ZOOM_START, 0.7, BG_CROSSFADE_ZOOM_END, 0.15];
const HILLSHADE_SHADOW_COLOR_EXPR = ['interpolate', ['linear'], ['zoom'], BG_CROSSFADE_ZOOM_START, '#2a2a1a', BG_CROSSFADE_ZOOM_END, '#6b6b5f'];
const HILLSHADE_HIGHLIGHT_COLOR_EXPR = ['interpolate', ['linear'], ['zoom'], BG_CROSSFADE_ZOOM_START, '#fff8e0', BG_CROSSFADE_ZOOM_END, '#fffdf5'];

// 【2026-10-19、34本目、Minami決定：B】円を合わせるとき（fitCircleToView()）の最低ズーム。
// 小さいスマホ（400×464）の3Dで円が枠からはみ出したまま戻らないことがあったため、
// 旧「全体表示」（fitToBudget()、最低ズーム9.5）より、ゆるい下限（8.5）にした。
// 8.5でも収まらないときだけ、はみ出しを許す（Minami指示：「入りきらない点は画面の
// 外に出てよい」）。【39本目】検索直後・「全体を見る」・「← 一覧に戻る」・金額操作の
// すべてがfitCircleToView()に揃い、旧fitToBudget()と9.5は削除した。
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
// 【45本目】まとめた丸の位置を「今描いているズームの段」から拾うための、見えない円のレイヤー。
const SPOTS_CLUSTER_HIT_LAYER_ID = 'spots-cluster-hit';
// 【47本目、Minami決定：1】まとめない点（オレンジがあるときの紺）を描くソースとレイヤー（49本目で灰色はやめた）。
// まとめる機能（cluster）はソース単位でしか効かないため、まとめる点（オレンジがあればオレンジ、
// なければ紺）はSPOTS_SOURCE_IDに、まとめない点はこちらに分けて入れる。
const SPOTS_PLAIN_SOURCE_ID = 'spots-plain';
const SPOTS_PLAIN_LAYER_ID = 'spots-plain-circle';
const DEM_SOURCE_ID = 'gsi-dem';
const HILLSHADE_LAYER_ID = 'hillshade-layer';
// 【2026-10-13、10本目②】予算の到達範囲の円（出発駅中心）。
const REACH_CIRCLE_SOURCE_ID = 'reach-circle';
const REACH_CIRCLE_FILL_LAYER_ID = 'reach-circle-fill';
const REACH_CIRCLE_LINE_LAYER_ID = 'reach-circle-line';
const REACH_CIRCLE_POINTS = 72; // 円を近似する多角形の頂点数（5°刻み）
// 【2026-10-20、37本目、Minami決定：B2】＋で円が広がるときの波（前の縁→新しい縁へ1本）。
// 2D（map-view.js）のMAP_CIRCLE_WAVE_*と同じ値・考え方。円の縁と同じ青・太さ3px・0.5秒、
// はじめ少し濃く→広がりながらうすくなる。白い光・ぼかし・点滅は使わない。
const REACH_WAVE_SOURCE_ID = 'reach-wave';
const REACH_WAVE_LINE_LAYER_ID = 'reach-wave-line';
// 【2026-10-27、64本目、Minami決定】波は地図合わせが終わってから出す。0.5秒→0.3秒。
const CIRCLE_WAVE_DURATION_MS = 300;
const CIRCLE_WAVE_START_OPACITY = 0.7;
// 【62本目】波の時間が終わったとき、最後に描いた濃さがこれをこえていたら、CIRCLE_WAVE_TAIL_OPACITYで1コマ描いてから消す
const CIRCLE_WAVE_TAIL_MAX_OPACITY = 0.1;
const CIRCLE_WAVE_TAIL_OPACITY = 0.03;
const CIRCLE_WAVE_WIDTH = 3;
const WAVE_DURATION_MS = 1000; // Minami指示：検索後、点を波のように出す所要時間（全体で1秒前後）
// 【2026-10-15、11本目①】選んだピンの強調（吹き出し廃止の代わり）。circleレイヤーは
// 単一のpaintプロパティしか持てないため、選択中の1件だけ別ソース・別レイヤーで
// 上から重ねて描く（到達範囲の円と同じ考え方）。
const SELECTED_SOURCE_ID = 'selected-spot';
const SELECTED_LAYER_ID = 'selected-spot-circle';
const SELECTED_GLOW_LAYER_ID = 'selected-spot-glow';
// 【41本目】「全体を見る」で使っていた戻りの所要時間（1.5秒）は、最初の見え方に戻る
// ボタンの処理と一緒にmain.js（RESET_VIEW_DURATION_MS）へ移した。

// 【2026-10-17、32本目B、Minami決定】予算の±・スライダー操作：まず円の半径を
// なめらかに変え、最後の操作から少し止まったら、円「全体」が収まるよう
// 地図を合わせる。今までの「予算を触ったら全体表示に戻る」（fitToBudget()
// ベースのreturnToOverview()）を置き換える。
// 【2026-10-20、35本目、Minami決定】待ち時間が長すぎる（読み込みが遅いのかと
// 思うほど）との指摘により、円0.25秒→0.2秒・デバウンス0.4秒→0.15秒・
// 地図を合わせる動き0.7秒→0.45秒に短縮した（合計1.35秒→0.8秒）。
// 【2026-10-27、64本目、Minami決定】＋−を押したら待たずに地図を合わせる（0.15秒の待ちはやめた）。
const CIRCLE_RADIUS_ANIM_MS = 200;
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
// 【2026-10-21、41本目、Minami決定：C】0.75→0.6（2Dのmap-view.jsと同じ）。金額が大きく
// なって地図が引いたあと、＋を押しても円の広がりが小さく見えた（40本目の計測）ため、
// 地図を合わせたときの円を小さめにして広がる余地を残す。
// 【2026-10-23、47本目、Minami決定：2】0.6→0.85（2Dと同じ）。検索した直後の縮尺では、結局
// 近づいて確認することになるため、最初からもっと寄る。横方向で測るのは35本目のまま。
// 【2026-10-27、64本目、Minami決定】0.85・横方向で測るのをやめ、円が見えている範囲いっぱいになるまで寄る。斜めから
// 見た円は横長の楕円に写るため、楕円の見た目の幅と高さで測り、縦か横のどちらかが見えている範囲の端から
// CIRCLE_FIT_EDGE_GAP_PX（8px）のところに来るまで寄る（_zoomForCircleFill()）。
const CIRCLE_FIT_EDGE_GAP_PX = 8;
// 【2026-10-20、37本目、Minami決定：A】金額操作のあとは、円の直径÷短辺（3Dは35本目と
// 同じく横方向で測る）が0.9をこえたときだけ0.75へ引き、0.35を下回ったときだけ0.6へ
// 寄る。その間は地図を動かさず円だけが広がる・縮む（2Dのmap-view.jsと同じ値）。
// 【41本目】9割をこえたときの行き先も0.75→0.6（CIRCLE_FIT_TARGET_DIAMETER_RATIO）。
// 【47本目、Minami決定：2】引く境目0.9→0.95、寄る先0.6→0.85（2Dと同じ）。寄る境目0.35は変えない。
// 【2026-10-27、64本目、Minami決定】0.95／0.35の決まりはやめた。＋−を押したら、いつも「いっぱい」に合わせる（2Dと同じ）。
// 【47本目、Minami指示】0.85にすると円の縁が地図の上の部品（方位磁針・戻るボタン・ハンドル等）に
// かかりやすい（実測：375×667の3Dで、円の右上の縁がハンドルの下を通った）。円に合わせるときは、
// 縁が部品（とのすき間CIRCLE_OBSTACLE_GAP_PX）にかからないズームまでだけ寄る（2Dのmap-view.jsと同じ部品）。
// 3Dの円は傾きで上側が縮んだ形に写るため、行き先のカメラ（MapLibreのtransformの複製）で縁の点を
// 実際に画面へ写して確かめ、かかっていれば少しずつ引く。
// 名前の帯（#spot-info-panel）は見ない（map-view.jsのMAP_CIRCLE_OBSTACLE_SELECTORSと同じ理由）。
// 【57本目、Minami決定：ア】予算操作帯（#mobile-budget-overlay）は結果の入れ物の一部として扱い、ここからは外した
// （入れ物ごと「見えている範囲」から除く。visibleMapRect()）。ここに残す部品は、見えている範囲の中で4px避ける。
// 【58本目】PCで一覧を閉じたときの細いバー・「☰ 一覧を開く」、開いているときのパネルの右の縁の「◀」も避ける。
const CIRCLE_OBSTACLE_SELECTORS = [
  '#map-compass-btn', '#map-reset-view-btn', '#map-rotate-handle', '#map-dimension-toggle',
  '#map-zoom-controls', '[data-map-overlay="bar"]', '#results-list-open-btn', '#results-list-close-btn',
];
// 【64本目】部品とのすき間は4px＋8px（CIRCLE_FIT_EDGE_GAP_PX）。
const CIRCLE_OBSTACLE_GAP_PX = 4;

/**
 * 【2026-10-25、57本目、Minami決定：ア】地図の上に重ねた入れ物（data-map-overlayの付いた、見えている要素：PCの左の
 * 入れ物、スマホの下の入れ物、検索カード）を除いた「見えている範囲」（地図の入れ物の左上を基準にしたpx）。
 * 入れ物は画面の端に寄せて置くため、入れ物ごとに、地図の左・右・上・下のどれかの側を入れ物の手前まで削り、
 * 残る広さが一番大きい削り方を選ぶ（PCの左の入れ物なら左を、スマホの下の入れ物なら下を削る）。
 * 残りが小さすぎるとき（80px未満）は、地図全体を見えている範囲とする。
 * 円の合わせ方（円の直径を見えている範囲の短辺の0.85にし、出発駅を見えている範囲の真ん中に置く）・ピンや
 * まとめた丸へ寄るときの中心に使う。2D（map-view.js）と3D（terrain-map-view.js）に同じ関数がある
 * （3Dは別に読み込むため）。
 * @param {Element} container 地図の入れ物
 * @returns {{left: number, top: number, right: number, bottom: number}}
 */
function visibleMapRect(container) {
  const c = container.getBoundingClientRect();
  const full = { left: 0, top: 0, right: c.width, bottom: c.height };
  let vis = { ...full };
  const area = (v) => Math.max(0, v.right - v.left) * Math.max(0, v.bottom - v.top);
  document.querySelectorAll('[data-map-overlay]').forEach((el) => {
    if (el.hidden) return;
    // 【58本目】PCで一覧を閉じたときの細いバー（data-map-overlay="bar"）は、覆う入れ物ではなく円が避ける部品
    if (el.getAttribute('data-map-overlay') === 'bar') return;
    // 【59本目】入れ物の中の入れ物（PCの一覧パネルの中の上の部分・下の部分）は、外の入れ物で数える。
    // スマホでは外の入れ物（.results-panel）がdisplay: contentsで箱を持たないため、中の2つを数える。
    const outer = el.parentElement && el.parentElement.closest('[data-map-overlay]');
    if (outer && getComputedStyle(outer).display !== 'contents') return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const b = el.getBoundingClientRect();
    if (!(b.width > 0 && b.height > 0)) return;
    const r = { left: b.left - c.left, top: b.top - c.top, right: b.right - c.left, bottom: b.bottom - c.top };
    if (r.right <= vis.left || r.left >= vis.right || r.bottom <= vis.top || r.top >= vis.bottom) return;
    const candidates = [
      { ...vis, left: Math.max(vis.left, r.right) },
      { ...vis, right: Math.min(vis.right, r.left) },
      { ...vis, top: Math.max(vis.top, r.bottom) },
      { ...vis, bottom: Math.min(vis.bottom, r.top) },
    ];
    vis = candidates.reduce((best, v) => (area(v) > area(best) ? v : best));
  });
  if (vis.right - vis.left < 80 || vis.bottom - vis.top < 80) return full;
  return vis;
}

/**
 * 【57本目】見えている範囲（visibleMapRect()）をMapLibreのpadding（地図の各辺からの余白）にしたもの。
 * カメラの中心（easeTo()のcenter）は、このpaddingの内側の真ん中に来る。
 */
function visiblePadding(container) {
  const vis = visibleMapRect(container);
  return {
    top: Math.round(vis.top),
    left: Math.round(vis.left),
    right: Math.max(0, Math.round(container.clientWidth - vis.right)),
    bottom: Math.max(0, Math.round(container.clientHeight - vis.bottom)),
  };
}

/** 【47本目】地図の上に見えている部品の形（地図の入れ物の左上を基準にしたpx。丸い部品はround・中心・半径つき）。 */
function circleObstacleRects(container) {
  const c = container.getBoundingClientRect();
  const out = [];
  CIRCLE_OBSTACLE_SELECTORS.forEach((sel) => {
    const el = document.querySelector(sel);
    if (!el || el.hidden) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return;
    if (r.right <= c.left || r.left >= c.right || r.bottom <= c.top || r.top >= c.bottom) return;
    // 丸い部品（方位磁針・戻るボタン・ハンドル）は丸として扱う（四角で見ると隅の分だけ余計に避ける）。
    const radius = cs.borderTopLeftRadius;
    // 大きさは回転（ハンドルはtransform: rotate()で回る）前の幅で見る（回った四角の外枠は大きくなるため）。
    const w = el.offsetWidth || r.width;
    const round = Math.abs(w - (el.offsetHeight || r.height)) < 1
      && (radius.endsWith('%') ? parseFloat(radius) >= 50 : parseFloat(radius) >= w / 2 - 0.5);
    out.push({
      left: r.left - c.left, top: r.top - c.top, right: r.right - c.left, bottom: r.bottom - c.top,
      round, cx: r.left - c.left + r.width / 2, cy: r.top - c.top + r.height / 2, radius: w / 2,
    });
  });
  return out;
}

// 【2026-10-21、43本目、Minami決定：B-1】ピンの色（2Dのassets/css/style.cssの.map-pin-blue等と
// 同じ値）。青＝検索した金額帯で行ける場所（円の青#2F6FB2より濃い紺に近い青）、オレンジ＝金額を
// 変えて新しく金額帯に入った場所。選んだピンは青でひと回り大きく、白い太いふちと影。以前の光の
// にじみ（circle-blur）はやめた。【49本目】灰色（金額帯より安く行ける場所）はやめた（紺とオレンジの2色）。
const PIN_COLOR_BLUE = '#1F3C88';
// 【2026-10-25、54本目、Minami決定】オレンジ（NEW）があるときの紺（まとめない点のレイヤーSPOTS_PLAIN_LAYER_ID）の
// うすさ。このレイヤーに紺が入るのはオレンジがあるときだけ（なければ紺はまとめる側のSPOTS_LAYER_IDに入る）
// のため、決まった値でよい。大きさは変えない。選んだピンは別のレイヤー・HTMLの印で元の濃さ。2Dのstyle.cssと同じ値。
const PLAIN_PIN_OPACITY = 0.45;
// マウスを乗せている点（feature-stateのhover）は元の濃さ。
const PLAIN_PIN_OPACITY_EXPR = ['case', ['boolean', ['feature-state', 'hover'], false], 1, PLAIN_PIN_OPACITY];
const PIN_COLOR_ORANGE = '#FF6B2B';
const COLOR_SELECTED = PIN_COLOR_BLUE;
// 【43本目、Minami決定：B-2】近いピンを数字の入った丸にまとめる（MapLibreのGeoJSONソースの
// cluster機能）。このズームより寄るとまとめない（場所に寄ったとき＝ズーム14では1つずつ見える）。
// 【2026-10-23、48本目、Minami決定：1】40→14（2Dのmap-view.jsと同じ考え方）。まとめるのはピン同士が
// 重なるときだけにし、重ならないピンは1つずつ点で見せる（MapLibreのclusterRadiusは、タイルの幅を
// 512とした単位で、ズームの整数の段ではちょうど画面のpx）。
const PIN_CLUSTER_RADIUS = 14;
const PIN_CLUSTER_MAX_ZOOM = 13;
// 【51本目】数字の丸と重なるかを見るときの1つずつの点の半径（白いふちを含む。SPOTS_LAYER_IDの
// circle-radius＋circle-stroke-widthと同じ値）と、丸どうしに残すすき間（2Dのmap-view.jsと同じ）。
const PIN_ORANGE_RADIUS_WITH_STROKE = 5.5;
const PIN_BLUE_RADIUS_WITH_STROKE = 8.5;
const CLUSTER_OVERLAP_GAP_PX = 1;

/**
 * 【2026-10-24、51本目、Minami決定】数字の丸どうし、または数字の丸と1つずつの点が画面上で重なる
 * ときは、重ならなくなるまで1つの丸にまとめる。2Dのmap-view.jsのmergeOverlappingClusters()と同じ
 * （このファイルは別に読み込むため、ここにも置く）。items：{members, x, y, count}（countが2以上なら
 * 数字の丸）。返すのは数字の丸として出すものだけ。
 */
function mergeOverlappingClusters(items, singleRadius) {
  const list = items.map((it) => ({ ...it }));
  const isCluster = (it) => it.count >= 2;
  const radius = (it) => (isCluster(it) ? (it.count < 10 ? 28 : it.count < 50 ? 32 : 38) / 2 : singleRadius);
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < list.length && !merged; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (!isCluster(a) && !isCluster(b)) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) >= radius(a) + radius(b) + CLUSTER_OVERLAP_GAP_PX) continue;
        const count = a.count + b.count;
        list[i] = {
          members: [...a.members, ...b.members],
          x: (a.x * a.count + b.x * b.count) / count,
          y: (a.y * a.count + b.y * b.count) / count,
          count,
        };
        list.splice(j, 1);
        merged = true;
        break;
      }
    }
  }
  return list.filter(isCluster);
}
// 【48本目、Minami決定：2】＋で新しく増えたオレンジを、波（CIRCLE_WAVE_DURATION_MS、ease-out）が
// その場所の距離を通り過ぎた瞬間に「ぽん」と出す（小さく出て少しふくらみ元の大きさへ、0.2秒。
// 2DのCSS .map-pin-popと同じ動き）。出そろって「ぽん」が終わってから、いつものソースへ戻してまとめ直す。
// 【2026-10-27、64本目、Minami決定】「ぽん」→「ぽよん」（しずくのように上から落ちて刺さり、つぶれて戻る。0.3秒）。
// 地図に描く円は形を変えられない（つぶせない）ため、落ちてくる間だけHTMLの印（.map-pin-drop-3d、2Dと同じCSSの動き）で
// 描き、出そろって落ち終わったら地図に描く点へ戻す（以前の「ぽん」用のソースspots-popはやめた）。
const PIN_DROP_DURATION_MS = 300;
// まとめた丸（数字入り、HTMLの印）の位置・数字を更新する間隔の下限（描画のたびに作り直さない）。
const PIN_CLUSTER_UPDATE_INTERVAL_MS = 100;

let protocolRegistered = false; // addProtocolは多重登録を避ける（2回目以降は上書きになるだけだが、意図を明示するためフラグで一度だけに絞る）

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 【2026-10-21、43本目B-1／C、45本目で見直し、Minami決定】ピンの色の決まり（2Dのmap-view.jsの
 * pinCategory()と同じ規則）。
 * 【2026-10-23、49本目、Minami決定】灰色をやめ、紺とオレンジの2色にした。'blue'：紺の上限以下の場所／
 * 'orange'：紺の上限をこえて今の金額までに届く場所／'hidden'：今の金額をこえる場所（出さない）。
 * 紺の上限は、＋で上げている（今の金額＞最後に検索した金額）ときは最後に検索した金額、そうでないときは
 * 直前の検索の金額（prevSearchedBudget、2Dのmap-view.jsの説明を参照）。
 */
function pinCategory(fare, liveBudget, searchedBudget, prevSearchedBudget = searchedBudget) {
  if (!(fare <= liveBudget)) return 'hidden';
  const blueLimit = liveBudget > searchedBudget ? searchedBudget : Math.min(prevSearchedBudget, searchedBudget);
  return fare > blueLimit ? 'orange' : 'blue';
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

/** 出発駅中心・半径radiusKmの円周（[lon, lat]の閉じたリング）。到達円と＋の波で共用する。 */
function buildCircleRing(dep, radiusKm) {
  const ring = [];
  for (let i = 0; i <= REACH_CIRCLE_POINTS; i++) {
    const bearingDeg = (360 / REACH_CIRCLE_POINTS) * i;
    const { lat, lon } = destinationPoint(dep.stop_lat, dep.stop_lon, bearingDeg, radiusKm);
    ring.push([lon, lat]);
  }
  return ring;
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
    this.onBackgroundClick = null; // 【64本目】地図の何もないところを押したとき（main.js）
    this.onSelectionChange = null; // 【2026-10-11、6本目B】地図の点をタップしたとき、一覧のカードをスクロール＋光らせるため（2Dのmap-view.jsと同じ役割）
    this.onOverheadSettled = null; // 【2026-10-13、8本目】(spot) => void、真上から見た状態の読み込みが済んだ瞬間（計測・テスト用）
    this.onTiltComplete = null; // 同上。傾け終わった瞬間（計測・テスト用）
    this.selectedSpotId = null; // 【2026-10-15、11本目①】情報枠・PC一覧ハイライトとの連動用
    this._lastDepartureStation = null;
    this._lastSpots = null;
    this._lastBudget = null;
    this._flySpotToken = 0; // 【2026-10-13、8本目】flyToSpot()の「降りる→傾ける」演出を、ユーザー操作や次のflyToSpot呼び出しで無効化するための世代カウンタ
    this._focusedOnSpot = false; // 【2026-10-15、11本目②】flyToSpot()で寄っている間true。fitCircleToView()で円に合わせるとfalse
    this._flyFocusedSpotId = null; // 【2026-10-15、26本目】_focusedOnSpotがtrueのとき、今寄っているspot.id
    this._reachCircleRadiusKm = 0; // 【2026-10-13、10本目②】現在描画中の円の半径（なめらかな変化の起点）
    this._pendingCircleStyle = 'live';
    this._circleAnimFrame = null; // 【2026-10-17、32本目B】半径を0.25秒ほどでなめらかに変えるrequestAnimationFrameのID
    this._circleAnimToken = 0; // 進行中の半径アニメーションを無効化する世代カウンタ
    this._fillRefinePending = false; // 【64本目】_scheduleFillRefine()が地図の落ち着くのを待っている間true（verify-layoutが待つ）
    this._fillRefineToken = 0; // 【64本目】地形が読み込めたあとの「いっぱい」の合わせ直し（_scheduleFillRefine()）の世代
    this._budgetFitToken = 0; // 【64本目】＋−の地図合わせの世代（新しく押したら、前の「合わせ終わったら波」を無効にする）
    this._budgetFitWait = null; // 【64本目】＋−の地図合わせが終わるのを待っているmoveendの関数
    this._reachCircleTargetKm = 0; // 【37本目】半径アニメーションの行き先（地図合わせの判断は途中の値ではなくこれを使う）
    this._circleFitAnim = null; // 【37本目】{zoom}：fitCircleToView()が動かしている最中の行き先ズーム（moveendで消す）
    this._circleWave = null; // 【37本目】＋の波：{fromKm, toKm, radiusKm, opacity, frame}
    this._pendingReturnToSearchView = false; // 【39本目】地図が見えていない間に「← 一覧に戻る」が押された
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

    // 【43本目D】下地の地図（ベクトル）のスタイル。読み込めないときは3D化自体を失敗させ、
    // 呼び出し元（main.jsのactivateTerrainMap()）が2Dのまま続ける（従来のWebGL失敗時と同じ）。
    const baseStyle = await loadAppMapStyle();
    this._baseSourceId = Object.keys(baseStyle.sources)[0];
    // 地・水面・建物の塗り → 地形の陰影 → 道路・鉄道・川などの線 → 地名などの文字 → 到達円・ピン、
    // の順に重ねる。陰影を線より上に置くと、白い道路や細い線路が陰影に薄められてほとんど
    // 見えなくなった（実機相当の確認で発覚）ため、陰影は塗りの直後に置く。文字はピンより下
    // （ピンが文字に隠れない）。
    // 【43本目D】地形に貼り付ける層（塗り・線）は、表示するズームの範囲（minzoom/maxzoom）を
    // 1段下へずらす。MapLibreは地形に貼り付けるとき、地図より1段粗いズーム（地形のタイル、
    // TerrainSourceCacheのdeltaZoom=1）でレイヤーの表示範囲を判定するため、国土地理院のスタイル
    // のようにズームごとに細かく表示範囲が決まっている道路・鉄道のレイヤーが、傾き45°の全体の
    // 見え方でほとんど描かれなかった（地形を外すと出る・表示範囲を下げると出ることを確かめた）。
    // 文字（symbol）は地形に貼り付けないため、ずらさない。
    const shiftZoomRange = (l) => ({
      ...l,
      ...(l.minzoom !== undefined ? { minzoom: Math.max(0, l.minzoom - TERRAIN_DRAPE_ZOOM_SHIFT) } : {}),
      ...(l.maxzoom !== undefined ? { maxzoom: Math.max(0, l.maxzoom - TERRAIN_DRAPE_ZOOM_SHIFT) } : {}),
    });
    const baseFillLayers = baseStyle.layers.filter((l) => l.type === 'background' || l.type === 'fill').map(shiftZoomRange);
    const baseLineLayers = baseStyle.layers.filter((l) => l.type === 'line').map(shiftZoomRange);
    const baseSymbolLayers = baseStyle.layers.filter((l) => l.type === 'symbol');

    this.map = new maplibregl.Map({
      container: this.containerId,
      // 出典はMapLibre標準の右下attributionではなく、compact（iボタンで開く）に
      // する（Minami指示：スマホで地図をふさいでいた）。位置は切替ボタン
      // （左下）と重ならないよう明示的に右下へ固定し、自前のAttributionControlを
      // 後から追加する（下のaddControl参照）。
      attributionControl: false,
      style: {
        version: 8,
        // 地名などの文字の形（字形）は国土地理院が配信しているもの（app-style.jsonと同じ）。
        glyphs: baseStyle.glyphs,
        sources: {
          ...baseStyle.sources,
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
            // 【43本目B-2】近いピンをまとめる。【47本目】入れるのは1つの色（オレンジがあればオレンジ、
            // なければ紺）だけのため、まとめた丸に入った色を数える必要はなくなった。
            cluster: true,
            clusterRadius: PIN_CLUSTER_RADIUS,
            clusterMaxZoom: PIN_CLUSTER_MAX_ZOOM,
          },
          [SPOTS_PLAIN_SOURCE_ID]: {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
            // 【54本目】マウスを乗せた点を元の濃さに戻すため、点ごとの状態（feature-state）を場所のIDで持つ。
            promoteId: 'id',
          },
          [REACH_CIRCLE_SOURCE_ID]: {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          },
          [SELECTED_SOURCE_ID]: {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          },
          [REACH_WAVE_SOURCE_ID]: {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          },
        },
        layers: [
          // 【43本目D】下地の地図（国土地理院のベクトル地図、地図記号なし・アプリの色）の塗り
          ...baseFillLayers,
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
          // 【43本目D】道路・鉄道・川などの線（陰影より上）と、地名・駅名などの文字（到達円・ピンより下）
          ...baseLineLayers,
          ...baseSymbolLayers,
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
          // 【37本目】＋の波。到達円と同じく地形にドレープする通常のlineレイヤーで、
          // 円の縁の上・スポットの点より下に描く。
          {
            id: REACH_WAVE_LINE_LAYER_ID,
            type: 'line',
            source: REACH_WAVE_SOURCE_ID,
            paint: { 'line-color': '#2F6FB2', 'line-opacity': 0, 'line-width': CIRCLE_WAVE_WIDTH },
          },
          // 【47本目、Minami決定：1】まとめない点（オレンジがあるときの紺、直径10px、白いふち）。
          // まとめる点・まとめた丸より下に描く。【49本目】灰色はやめた（紺とオレンジの2色）。
          {
            id: SPOTS_PLAIN_LAYER_ID,
            type: 'circle',
            source: SPOTS_PLAIN_SOURCE_ID,
            paint: {
              'circle-radius': 3.5,
              'circle-color': PIN_COLOR_BLUE,
              'circle-opacity': PLAIN_PIN_OPACITY_EXPR,
              'circle-stroke-width': 1.5,
              'circle-stroke-color': '#ffffff',
              'circle-stroke-opacity': PLAIN_PIN_OPACITY_EXPR,
              'circle-blur': 0,
            },
          },
          {
            id: SPOTS_LAYER_ID,
            type: 'circle',
            source: SPOTS_SOURCE_ID,
            // 【43本目】まとめた丸（point_countを持つ点）はHTMLの印で描くため、ここでは描かない。
            filter: ['!', ['has', 'point_count']],
            paint: {
              // 青は直径13px（半径6.5）＋白いふち2px。
              // 【48本目、Minami決定：1】オレンジは紺の点（まとめない点のレイヤー、直径10px）と同じくらいに
              // 小さくし（半径4＋白いふち1.5px＝直径11px）、紺よりひと回りだけ大きくして少し目立たせる。
              // 【49本目】灰色はやめた（紺とオレンジの2色）。
              'circle-radius': ['match', ['get', 'cat'], 'orange', 4, 6.5],
              'circle-color': ['match', ['get', 'cat'], 'orange', PIN_COLOR_ORANGE, PIN_COLOR_BLUE],
              'circle-opacity': 1,
              'circle-stroke-width': ['match', ['get', 'cat'], 'orange', 1.5, 2],
              'circle-stroke-color': '#ffffff',
              'circle-blur': 0,
            },
          },
          // 【45本目】まとめた丸（point_countを持つ点）の位置を拾うための見えない円（描くのはHTMLの印）。
          {
            id: SPOTS_CLUSTER_HIT_LAYER_ID,
            type: 'circle',
            source: SPOTS_SOURCE_ID,
            filter: ['has', 'point_count'],
            paint: { 'circle-radius': 14, 'circle-opacity': 0, 'circle-stroke-width': 0 },
          },
          // 【2026-10-15、11本目①】選んだピンの強調（吹き出し廃止の代わり、
          // Minami指示：一回り大きく＋白い縁取り＋光の輪）。spotsレイヤーより
          // 後ろ（＝画面上は上）に描くことで、帯の塗り分けより目立たせる。
          // 光の輪はぼかした少し大きい円を先に敷き、本体の円を上に重ねて作る。
          {
            id: SELECTED_GLOW_LAYER_ID,
            type: 'circle',
            source: SELECTED_SOURCE_ID,
            // 【43本目B-1】光の輪はやめ、少し下にずらした影にする。
            paint: {
              'circle-radius': 11.5,
              'circle-color': '#000000',
              'circle-opacity': 0.3,
              'circle-blur': 0.5,
              'circle-translate': [0, 2],
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
              'circle-stroke-width': 3.5,
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

    this.map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: REQUIRED_NOTICE_HTML }), 'bottom-right');
    // 【56本目】出典の中の「出典の詳細・免責・お問い合わせ」で出典画面を開く（main.jsへイベントで知らせる）。
    this.map.getContainer().addEventListener('click', (e) => {
      const about = e.target.closest && e.target.closest('.open-about-data');
      if (!about) return;
      e.preventDefault();
      e.stopPropagation();
      document.dispatchEvent(new CustomEvent('michidokoro:open-about'));
    }, true);
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
    // 【47本目】まとめない点（SPOTS_PLAIN_LAYER_ID）も同じく押せる（1つの場所はどちらか一方の
    // ソースにしか入らない）。
    const onSpotClick = (e) => {
      // 【51本目】数字の丸に入れて透明にしている点は押せない（丸のほうを押す）。
      const feature = (e.features || []).find((f) => !this._absorbedIds?.has(f.properties.id));
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
    };
    this.map.on('click', SPOTS_LAYER_ID, onSpotClick);
    this.map.on('click', SPOTS_PLAIN_LAYER_ID, onSpotClick);
    // 【64本目】地図の何もないところ（点の無いところ）を押したとき（main.jsが、スマホの場所のカードを閉じる）。
    // まとめた丸・選んだピン・出発駅の印（HTMLの印）を押したときは、押した先が地図の絵（canvas）でないため数えない。
    this.map.on('click', (e) => {
      if (e.originalEvent?.target !== this.map.getCanvas()) return;
      const layers = [SPOTS_LAYER_ID, SPOTS_PLAIN_LAYER_ID].filter((id) => this.map.getLayer(id));
      const hits = this.map.queryRenderedFeatures(e.point, { layers }).filter((ft) => !this._absorbedIds?.has(ft.properties.id));
      if (hits.length === 0) this.onBackgroundClick?.();
    });
    // 【43本目B-2】まとめた丸（HTMLの印）は、地図が動いたとき・データが変わったときに作り直す
    // （間引きあり）。【不具合修正】当初は'render'のたびに作り直していたが、印の位置を設定し直す
    // と次の描画が呼ばれ、地図が止まっていても描画が毎秒約18回続いて'idle'にならない輪になった
    // （実機相当の確認で発覚：地形の読み込み待ちの検証が終わらなくなった）。
    this.map.on('move', () => this._scheduleClusterMarkerUpdate());
    this.map.on('moveend', () => this._scheduleClusterMarkerUpdate());
    // 【45本目、不具合修正】寄った・引いた直後は、新しいズームの段のタイルが届くまで前の段のタイル
    // （まとめた丸も前の段のまま）が仮に描かれる。move/moveend/sourcedataの時点で拾うと、前の段の丸が
    // 残ったままになることがあった。描画が落ち着いたとき（idle）にもう一度拾い直す（印が変わらなければ
    // 何も書き換えないため、idle→描き直し→idleの繰り返しにはならない）。
    this.map.on('idle', () => this._updateClusterMarkers());
    this.map.on('sourcedata', (e) => { if (e.sourceId === SPOTS_SOURCE_ID) this._scheduleClusterMarkerUpdate(); });
    [SPOTS_LAYER_ID, SPOTS_PLAIN_LAYER_ID].forEach((layerId) => {
      this.map.on('mouseenter', layerId, () => { this.map.getCanvas().style.cursor = 'pointer'; });
      this.map.on('mouseleave', layerId, () => { this.map.getCanvas().style.cursor = ''; });
    });
    // 【54本目】うすくした紺（まとめない点）にマウスを乗せたら、その点を元の濃さに戻す。
    const setPlainHover = (id) => {
      if (this._plainHoverId === id) return;
      if (this._plainHoverId !== undefined && this._plainHoverId !== null) {
        this.map.setFeatureState({ source: SPOTS_PLAIN_SOURCE_ID, id: this._plainHoverId }, { hover: false });
      }
      this._plainHoverId = id;
      if (id !== null) this.map.setFeatureState({ source: SPOTS_PLAIN_SOURCE_ID, id }, { hover: true });
    };
    this.map.on('mousemove', SPOTS_PLAIN_LAYER_ID, (e) => setPlainHover(e.features?.[0]?.id ?? null));
    this.map.on('mouseleave', SPOTS_PLAIN_LAYER_ID, () => setPlainHover(null));

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
  render(departureStation, spots, budget, { reveal = false, background = false } = {}) {
    // 新しい検索で、前の予算操作から保留中の地図合わせは無効化する。
    // 【62本目】裏取得の描き直し（background）は新しい検索ではないため、＋−の地図合わせの保留は消さない。
    // （3Dのrender()はもともと円に合わせ直さないため、利用者が動かした地図はそのまま残る。）
    if (!background) this._cancelFitCircleToView();
    this._cancelCircleWave();
    // 【45本目、不具合修正】以前はここで「見えたら検索した直後の見え方に合わせる」保留
    // （_pendingReturnToSearchView）を消していた。しかしrender()は新しい検索のときだけでなく、
    // 検索の約1.5秒後に¥2000分の点を裏で取得して反映するとき（main.jsのscheduleMaxBudgetPrefetch()）
    // や、3Dへ切り替えたとき（activateTerrainMap()）にも呼ばれる。2D表示中に検索すると、
    // 3D側は見えていないため合わせるのを保留する→裏の反映のrender()がその保留を消す→3Dへ
    // 切り替えても前の検索の位置のまま、という順で、3Dにしたとき遠すぎる（香川・山下・往復¥500で
    // ¥2000の検索のあとだと、円が短辺の0.155）不具合になっていた。新しい検索では、呼び出し元
    // （main.jsのrenderSearchResults()）がrender()の直後に必ずreturnToSearchView()を呼び、
    // 保留を立て直すか、その場で合わせるため、ここで消す必要は無い。
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
      // 【2026-10-25、53本目、Minami決定】出発駅の印は、数字の丸（HTMLの印、z-index:1）・1つずつのピン（地図に
      // 描く円）より、いつも上に描く。選んだピンの印（z-index:3）よりは下（style.cssの.map-departure-3d）。
      this.departureMarker.getElement().classList.add('map-departure-3d');
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
    // 【43本目】まとめる機能（cluster）は「ソースのデータ」をまとめるため、レイヤーの絞り込み
    // （setFilter）では、出さない点もまとめた丸の数に入ってしまう。全件はここで覚えておき、
    // 出す点・色の決まり（cat）を付けたデータを_rebuildSpotData()で毎回作り直して渡す。
    this._spotFeatures = features;
    this._spotFeatureById = new Map(features.map((f) => [f.properties.id, f])); // 【48本目】「ぽん」で使う
    this._cancelPinPop();

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
    this._rebuildSpotData(); // 【43本目】選んだピンはまとめない（いつも見える）
    // 【2026-10-21、43本目、不具合修正A-1】選んだピンは、地形に隠れないHTMLの印でも描く。
    // MapLibre（5.6.1）の円のレイヤーは、カメラから見て尾根の向こう側にあると地形に隠れて
    // 描かれない（実測：400×464で大池からドングリランドへ寄ると、点が尾根の裏になり
    // queryRenderedFeatures()にも出てこない）。印（maplibregl.Marker）は既定では地形に隠れると
    // うすく（opacityWhenCovered:'0.2'）なるため、'1'にしていつも同じ濃さで見せる。
    // 見た目は円のレイヤーの選んだピンと同じ（紺に近い青・20px・白い太いふち・影）。
    const lngLat = [spot.longitude, spot.latitude];
    if (!this._selectedMarker) {
      const el = document.createElement('div');
      el.className = 'map-pin-selected-3d';
      this._selectedMarker = new maplibregl.Marker({ element: el, opacityWhenCovered: '1' });
    }
    this._selectedMarker.setLngLat(lngLat).addTo(this.map);
  }

  /** 情報枠を閉じたとき・検索し直したとき・予算を触ったときに、ピンの強調だけを外す。 */
  clearSelected() {
    const hadSelection = this.selectedSpotId != null;
    this.selectedSpotId = null;
    const source = this.map && this.map.getSource(SELECTED_SOURCE_ID);
    if (source) source.setData({ type: 'FeatureCollection', features: [] });
    if (this._selectedMarker) this._selectedMarker.remove();
    if (hadSelection) this._rebuildSpotData();
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
    this._cancelPinPop(); // 【48本目】検索したら「ぽん」はやめる（オレンジは紺になる）
    this._lastBudget = budget;
    this._liveBudget = budget; // 【43本目】検索したときは、今の金額＝検索した金額（オレンジは青になる）
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
    // 【43本目B-1】色と大きさはレイヤーの式（cat）で決まるため、ここではデータを作り直すだけ。
    if (reveal && !prefersReducedMotion()) {
      this._startWaveReveal(budget);
    } else {
      this._cancelWaveReveal();
      this._rebuildSpotData();
    }
  }

  /**
   * 【2026-10-21、43本目、Minami決定：C】金額を変えたら（＋−・スライダー）、その場で
   * ピンを新しい金額帯に合わせて入れ替える（検索した金額＝_lastBudgetは変えない）。
   * スライダーを動かしている間は何度も呼ばれるため、データの作り直しは1コマに1回へ間引く。
   * 検索直後の波の演出の途中なら、波のほうが最後にデータを作り直す（ここでは作り直さない）。
   * @param {number} budget 今の金額
   */
  /** 【49本目】直前の検索の金額（pinCategory()の紺の上限に使う。2Dのmap-view.jsと同じ）。 */
  setPrevSearchedBudget(budget) {
    this._prevSearchedBudget = budget;
  }

  setLiveBudget(budget, { pop = false } = {}) {
    const prevLive = this._liveBudget ?? this._lastBudget;
    this._liveBudget = budget;
    // 【48本目、Minami決定：2】金額を上げたとき（pop:true、main.jsが波を出すときと同じ判断）は、
    // 新しく増えたオレンジをいったん出さず、波に合わせて1つずつ「ぽん」と出す（2Dと同じ）。
    // 続けて押されたら、まだ出ていないものも新しい波に合わせて出し直す。下げたとき・動きを
    // 減らす設定のとき・地図が見えていないときは、すぐ出す・消す。
    const container = this.map && this.map.getContainer();
    const visible = !!container && container.clientWidth > 0 && container.clientHeight > 0;
    // 【64本目】出すのは、地図合わせが終わって波が通り過ぎたとき（fitAfterBudgetChange()が_startPinPop()を呼ぶ）。
    if (pop && visible && !prefersReducedMotion() && this._lastBudget != null && prevLive != null && budget > prevLive) {
      this._pausePinPop();
      this._addPinPopPending(prevLive, budget);
    } else {
      this._cancelPinPop();
    }
    if (this._liveRebuildScheduled) return;
    this._liveRebuildScheduled = true;
    requestAnimationFrame(() => {
      this._liveRebuildScheduled = false;
      if (this._waveFrame) return;
      this._rebuildSpotData();
    });
  }

  /** 【48本目】前の金額（prevLive）をこえて今の金額（budget）までに届く新しいオレンジを「まだ出していない」にする。 */
  _addPinPopPending(prevLive, budget) {
    if (!this._pinPop) this._pinPop = { pending: new Map(), shown: new Map(), frame: null };
    (this._spotFeatures || []).forEach((f) => {
      const { id, fare, distance_km: km } = f.properties;
      if (!(fare > prevLive && fare <= budget && fare > this._lastBudget)) return;
      if (id === this.selectedSpotId || this._pinPop.shown.has(id)) return;
      this._pinPop.pending.set(id, km);
    });
  }

  /**
   * 【48本目】波と同じ速さ（ease-out）で広がる半径を毎コマ計算し、その半径を通り過ぎた
   * まだ出していないオレンジを出す。全部出して落ち終わったら、いつものソースへ戻してまとめ直す。
   * 呼ばれるたびに時間を0からやり直す（続けて押したときは新しい波に合わせる）。
   * 【64本目】「ぽん」→「ぽよん」。呼ぶのは地図合わせが終わって波を出すとき（fitAfterBudgetChange()）。
   * 落ちてくる間はHTMLの印（_dropPin()）で描く。
   */
  _startPinPop(budget) {
    const state = this._pinPop;
    if (!state || !this.map) return;
    if (state.frame) cancelAnimationFrame(state.frame);
    state.startedAt = performance.now(); // 検証用（verify-layout.js）
    const totalKm = this.computeReachRadiusKm(budget);
    const startTime = performance.now();
    const step = (now) => {
      if (this._pinPop !== state || !this.map) return;
      const progress = Math.min(1, Math.max(0, (now - startTime) / CIRCLE_WAVE_DURATION_MS));
      const radiusKm = totalKm * (1 - (1 - progress) * (1 - progress));
      state.pending.forEach((km, id) => {
        if (progress < 1 && km > radiusKm) return;
        state.pending.delete(id);
        this._dropPin(state, id, now);
      });
      const dropping = [...state.shown.values()].some((d) => now - d.t < PIN_DROP_DURATION_MS);
      if (state.pending.size === 0 && !dropping) {
        state.frame = null;
        this._finishPinPop(state);
        return;
      }
      state.frame = requestAnimationFrame(step);
    };
    state.frame = requestAnimationFrame(step);
  }

  /** 【64本目】新しいオレンジを、落ちてくるHTMLの印（2Dと同じCSSの動き.map-pin-drop）で出す。 */
  _dropPin(state, id, now) {
    const f = (this._spotFeatureById || new Map()).get(id);
    if (!f || id === this.selectedSpotId) return;
    const el = document.createElement('div');
    el.className = 'map-pin-drop-3d';
    const dot = document.createElement('span');
    dot.className = 'map-pin-drop-dot';
    el.appendChild(dot);
    const marker = new maplibregl.Marker({ element: el }).setLngLat(f.geometry.coordinates).addTo(this.map);
    state.shown.set(id, { t: now, marker });
  }

  /** 【64本目】出そろって落ち終わったら、地図に描く点へ戻す（点を描き直してから印を外す。同じコマで外すと一瞬消える）。 */
  _finishPinPop(state) {
    if (this._pinPop === state) this._pinPop = null;
    this._rebuildSpotData(); // 出そろってから、本当に重なるものだけまとめる
    const markers = [...state.shown.values()].map((d) => d.marker);
    state.shown.clear();
    if (markers.length > 0) setTimeout(() => markers.forEach((m) => m.remove()), 120);
  }

  /**
   * 【64本目】続けて押したとき：弾んでいる最中の印はその場で止め（元の形で出したまま）、まだ出していないピンは
   * 隠したまま、次の地図合わせのあとの波で出す。
   */
  _pausePinPop() {
    const state = this._pinPop;
    if (!state) return;
    if (state.frame) cancelAnimationFrame(state.frame);
    state.frame = null;
    state.shown.forEach((d) => {
      d.t = -Infinity;
      d.marker.getElement().querySelector('.map-pin-drop-dot')?.style.setProperty('animation', 'none');
    });
  }

  /** 【48本目】「ぽん」を止める（呼び出し元がデータを作り直すと、まだ出していないピンもすぐ出る）。 */
  _cancelPinPop() {
    const state = this._pinPop;
    if (!state) return;
    this._pinPop = null;
    if (state.frame) cancelAnimationFrame(state.frame);
    state.shown.forEach((d) => d.marker.remove()); // 【64本目】落ちてくる印も外す
    state.shown.clear();
  }

  /**
   * 【2026-10-21、43本目、Minami決定：B／C】点のソースに渡すデータを作り直す。今の金額
   * （_liveBudget）をこえる点は入れない・選んだピンは入れない（別のレイヤーでいつも見える）・
   * 検索直後の波の途中なら出発駅から revealKm 以内の点だけ入れる。各点には色の決まり（cat、
   * pinCategory()）を付ける。まとめる機能（cluster）はこのデータだけをまとめる。
   * @param {{revealKm?: number}} [opts]
   */
  _rebuildSpotData({ revealKm } = {}) {
    if (!this.map) return;
    const source = this.map.getSource(SPOTS_SOURCE_ID);
    const plainSource = this.map.getSource(SPOTS_PLAIN_SOURCE_ID);
    if (!source || !plainSource) return;
    const searched = this._lastBudget;
    const live = this._liveBudget ?? searched;
    // 【47本目、Minami決定：1】オレンジが1つでもあれば、まとめるのはオレンジだけ（紺はまとめない
    // 小さな点）。なければ紺だけをまとめる。検索直後の波の途中でも、まとめる色は
    // 出し終えたときと同じにする（全件で判断する）。
    const hasOrange = (this._spotFeatures || []).some((f) => pinCategory(f.properties.fare, live, searched, this._prevSearchedBudget) === 'orange');
    const clusterKind = hasOrange ? 'orange' : 'blue';
    this._clusterKind = clusterKind;
    const features = [];
    const clustered = [];
    const plain = [];
    const pinPop = this._pinPop;
    (this._spotFeatures || []).forEach((f) => {
      if (f.properties.id === this.selectedSpotId) return;
      // 【48本目】波を待っている・「ぽん」と出している最中のオレンジは、いつものソースに入れない。
      if (pinPop && (pinPop.pending.has(f.properties.id) || pinPop.shown.has(f.properties.id))) return;
      if (revealKm !== undefined && !(f.properties.distance_km <= revealKm)) return;
      const cat = pinCategory(f.properties.fare, live, searched, this._prevSearchedBudget);
      if (cat === 'hidden') return;
      const feature = { type: 'Feature', geometry: f.geometry, properties: { ...f.properties, cat } };
      features.push(feature);
      (cat === clusterKind ? clustered : plain).push(feature);
    });
    source.setData({ type: 'FeatureCollection', features: clustered });
    plainSource.setData({ type: 'FeatureCollection', features: plain });
    // 検証用（verify-layout.js）：出している点の数と、点ごとの色の決まりの一覧
    this._spotDataCount = features.length;
    this._spotDataSignature = features.map((f) => `${f.properties.id}:${f.properties.cat}`).sort().join(',');
    this._scheduleClusterMarkerUpdate();
  }

  /** 【43本目B-2】まとめた丸（HTMLの印）の更新を、描画が落ち着くタイミングへまとめて予約する。 */
  _scheduleClusterMarkerUpdate() {
    if (this._clusterUpdateTimer) return;
    this._clusterUpdateTimer = setTimeout(() => {
      this._clusterUpdateTimer = null;
      this._updateClusterMarkers();
    }, PIN_CLUSTER_UPDATE_INTERVAL_MS);
  }

  /**
   * 【2026-10-21、43本目、Minami決定：B-2】まとめた丸を、数字の入った青い丸（HTMLの印、
   * maplibregl.Marker）で描く。このスタイルは文字の形（glyphs）を持たない（地図は画像タイルのみ）
   * ため、MapLibreのsymbolレイヤーでは数字を描けない。2Dと同じ見た目のDOM（.map-cluster）を使う。
   * 押すと、その丸が分かれるズームまで寄る。
   * 【47本目】まとめているのがオレンジ（_clusterKind）ならオレンジの丸にする（紺の丸の右上の
   * オレンジの点はやめた）。
   */
  _updateClusterMarkers() {
    if (!this.map) return;
    // 【51本目】＋の波・「ぽん」の最中はまとめ直さない（終わってから、まとめ直す）。重なりでのまとめ直しは
    // 点の絞り込み（setFilter）を変えるため描き直しが重く、波の最後のコマが間に合わなくなった
    // （verify-layoutの「波は広がりながらうすくなる」で実測）。
    if (this._circleWave || this._pinPop) {
      this._scheduleClusterMarkerUpdate();
      return;
    }
    if (!this._clusterMarkers) this._clusterMarkers = new Map();
    const source = this.map.getSource(SPOTS_SOURCE_ID);
    const seen = new Set();
    let absorbedIds = [];
    if (source && this.map.isSourceLoaded(SPOTS_SOURCE_ID)) {
      // 【45本目、不具合修正】以前はquerySourceFeatures()で拾っていたが、これは地図が覚えている
      // ほかのズームの段のタイル（縮小・拡大の直後に、なめらかに切り替えるため残しているもの）の
      // まとめた丸も返す。そのため、拡大して分かれたあとも前の段の丸（例：7件の丸）が、ばらの
      // ピンと一緒に残ることがあった（香川・山下・往復¥500、PCで実測）。今描いている段の丸だけを
      // 返すqueryRenderedFeatures()（見えない円のレイヤー）で拾う。
      // 【51本目、Minami決定】数字の丸どうし・数字の丸と1つずつの点が画面上で重なるときは、重ならなく
      // なるまで1つの丸にまとめる（丸の直径28px以上が、まとめる範囲14より大きいため）。丸に入れた点は
      // SPOTS_LAYER_IDで透明にする（絞り込み（setFilter）で消すと、そのソースのタイルを作り直すため重い。
      // 透明にするだけなら、次に拾うときもその点の位置が分かる）。丸と1つずつの点は1回の
      // queryRenderedFeatures()でまとめて拾う（地形ありでは1回あたり10〜16msかかり、件数にほとんどよらない。
      // 2回に分けると、地図を動かしている間の重さが倍になり、＋の波のコマが落ちた）。
      const items = [];
      const seenCluster = new Set();
      const seenSingle = new Set();
      this.map.queryRenderedFeatures({ layers: [SPOTS_CLUSTER_HIT_LAYER_ID, SPOTS_LAYER_ID] }).forEach((f) => {
        const isClusterFeature = f.properties.point_count !== undefined;
        const id = isClusterFeature ? f.properties.cluster_id : f.properties.id;
        const seenSet = isClusterFeature ? seenCluster : seenSingle;
        if (seenSet.has(id)) return; // タイルの境目で同じ丸・点が2回返ることがある
        seenSet.add(id);
        const p = this.map.project(f.geometry.coordinates);
        const count = isClusterFeature ? f.properties.point_count : 1;
        const member = isClusterFeature ? { clusterId: id, lngLat: f.geometry.coordinates, count } : { spotId: id, lngLat: f.geometry.coordinates, count };
        items.push({ members: [member], x: p.x, y: p.y, count });
      });
      items.sort((a, b) => (a.x - b.x) || (a.y - b.y));
      const singleRadius = this._clusterKind === 'orange' ? PIN_ORANGE_RADIUS_WITH_STROKE : PIN_BLUE_RADIUS_WITH_STROKE;
      mergeOverlappingClusters(items, singleRadius).forEach((group) => {
        const kind = this._clusterKind === 'orange' ? 'orange' : 'blue';
        const count = group.count;
        // 重なりでまとめ直していない丸は、今までどおりMapLibreのcluster_idで覚える（押したときに分かれる
        // ズームをMapLibreに聞ける）。まとめ直した丸は、中身から作った名前で覚える。
        const single = group.members.length === 1 ? group.members[0] : null;
        const id = single ? single.clusterId : `m:${group.members.map((m) => m.clusterId ?? `s${m.spotId}`).sort().join('+')}`;
        seen.add(id);
        group.members.forEach((m) => { if (m.spotId !== undefined) absorbedIds.push(m.spotId); });
        const lngLat = single ? single.lngLat : [
          group.members.reduce((sum, m) => sum + m.lngLat[0] * m.count, 0) / count,
          group.members.reduce((sum, m) => sum + m.lngLat[1] * m.count, 0) / count,
        ];
        const size = count < 10 ? 28 : count < 50 ? 32 : 38;
        const key = `${count}|${kind}`;
        let entry = this._clusterMarkers.get(id);
        if (!entry) {
          const el = document.createElement('div');
          el.className = 'map-cluster-wrapper map-cluster-3d';
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            if (single) this._zoomIntoCluster(id, entry.lngLat);
            else this._zoomIntoMergedCluster(entry.lngLat);
          });
          entry = { marker: new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(this.map), el, key: null, lngLat };
          this._clusterMarkers.set(id, entry);
        }
        const moved = !entry.lngLat || entry.lngLat[0] !== lngLat[0] || entry.lngLat[1] !== lngLat[1];
        entry.lngLat = lngLat;
        entry.count = count;
        entry.kind = kind;
        if (moved) entry.marker.setLngLat(lngLat); // 同じ位置なら設定し直さない（余計な描画を呼ばない）
        if (entry.key !== key) {
          entry.key = key;
          entry.el.innerHTML = `<span class="map-cluster${kind === 'orange' ? ' map-cluster-orange' : ''}" style="width:${size}px;height:${size}px"><span class="map-cluster-count">${count}</span></span>`;
        }
      });
    }
    this._clusterMarkers.forEach((entry, id) => {
      if (seen.has(id)) return;
      entry.marker.remove();
      this._clusterMarkers.delete(id);
    });
    // 丸に入れた点を透明にする。変わったときだけ設定し直す（同じなら何もしない。設定し直すと描き直し→idle→
    // ここ、となるため）。検証（verify-layout.js）・押したときの判定用に、丸に入れた点の一覧も覚えておく。
    absorbedIds = absorbedIds.sort();
    const signature = absorbedIds.join(',');
    if (signature !== (this._absorbedSignature || '') && this.map.getLayer(SPOTS_LAYER_ID)) {
      this._absorbedSignature = signature;
      this._absorbedIds = new Set(absorbedIds);
      const visible = absorbedIds.length === 0 ? 1 : ['case', ['in', ['get', 'id'], ['literal', absorbedIds]], 0, 1];
      this.map.setPaintProperty(SPOTS_LAYER_ID, 'circle-opacity', visible);
      this.map.setPaintProperty(SPOTS_LAYER_ID, 'circle-stroke-opacity', visible);
    }
  }

  /** 【51本目】重なりでまとめ直した丸を押したときは、その場所へ1段寄る（向き・傾きはそのまま）。 */
  _zoomIntoMergedCluster(lngLat) {
    if (!this.map) return;
    const target = Math.min(PIN_CLUSTER_MAX_ZOOM + 0.1, this.map.getZoom() + 1);
    // 【57本目】見えている範囲（重ねた入れ物を除く）の真ん中へ寄せる。
    this.map.easeTo({ center: lngLat, zoom: target, duration: prefersReducedMotion() ? 0 : 600, padding: visiblePadding(this.map.getContainer()) });
  }

  /** 【43本目B-2】まとめた丸を押したとき、その丸が分かれるズームまで寄る（向き・傾きはそのまま）。 */
  _zoomIntoCluster(clusterId, lngLat) {
    const source = this.map && this.map.getSource(SPOTS_SOURCE_ID);
    if (!source) return;
    Promise.resolve(source.getClusterExpansionZoom(clusterId)).then((zoom) => {
      if (!this.map) return;
      const target = Math.max(zoom + 0.1, this.map.getZoom() + 1);
      // 【57本目】見えている範囲（重ねた入れ物を除く）の真ん中へ寄せる。
      this.map.easeTo({ center: lngLat, zoom: target, duration: prefersReducedMotion() ? 0 : 600, padding: visiblePadding(this.map.getContainer()) });
    }).catch(() => {});
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
      this._rebuildSpotData();
      return;
    }
    const token = ++this._waveToken;
    const startTime = performance.now();
    let lastStage = -1;
    const step = (now) => {
      if (token !== this._waveToken || !this.map) return;
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / WAVE_DURATION_MS);
      const revealedKm = maxKm * progress;
      // 【43本目】まとめる機能はデータをまとめるため、絞り込み（setFilter）ではなくデータを
      // 作り直す。毎コマ作り直すと重いため、全体を12段階に分けて広げる（1秒で12回）。
      const stage = Math.floor(progress * 12);
      if (stage !== lastStage) {
        lastStage = stage;
        this._rebuildSpotData({ revealKm: revealedKm });
      }
      if (progress < 1) {
        this._waveFrame = requestAnimationFrame(step);
      } else {
        this._waveFrame = null;
        // 浮動小数点の端数で最遠点が漏れないよう、仕上げに距離条件を外す。
        this._rebuildSpotData();
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
    const targetKm = this.computeReachRadiusKm(budget);
    // 【41本目、Minami決定】ユーザーが金額を上げたとき、出発駅（円の中心）から新しい縁まで波を出す（2Dと同じ）。
    // 半径が同じでも出す。【64本目】波は地図合わせが終わってから出す（fitAfterBudgetChange()）。
    this._animateCircleRadius(targetKm, style);
  }

  /**
   * 【2026-10-20、37本目、Minami決定：B2】前の円の縁（fromKm）から新しい縁（toKm）へ、
   * うすい青の線を1本広げて消す（2Dのmap-view.jsと同じ動き）。地理座標上の
   * リングとして描くため、向き・傾きを変えたあとや地図が動いている途中でも、
   * 常に円の縁に沿って出る。続けて押されたら前の波は途中でも消して置き換える。
   * 動きを減らす設定のとき・地図が見えていないときは出さない。
   */
  _startCircleWave(fromKm, toKm) {
    this._cancelCircleWave();
    if (prefersReducedMotion() || !this.map) return;
    const dep = this._lastDepartureStation;
    const source = this.map.getSource(REACH_WAVE_SOURCE_ID);
    if (!source || !dep || !isFiniteNumber(dep.stop_lat) || !isFiniteNumber(dep.stop_lon)) return;
    const container = this.map.getContainer();
    if (container.clientWidth === 0 || container.clientHeight === 0) return;
    const wave = { fromKm, toKm, radiusKm: fromKm, opacity: CIRCLE_WAVE_START_OPACITY, frame: null, startedAt: performance.now() };
    this._circleWave = wave;
    const paint = () => {
      wave.ring = wave.radiusKm > 0 ? buildCircleRing(dep, wave.radiusKm) : null; // 検証用（verify-layout.js）にも残す
      source.setData({
        type: 'FeatureCollection',
        features: wave.ring
          ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: wave.ring }, properties: {} }]
          : [],
      });
      this.map.setPaintProperty(REACH_WAVE_LINE_LAYER_ID, 'line-opacity', wave.opacity);
    };
    paint();
    wave.paintedOpacity = wave.opacity;
    const startTime = performance.now();
    const step = (now) => {
      if (this._circleWave !== wave || !this.map) return;
      // 【37本目、不具合修正】requestAnimationFrameに渡される時刻はそのフレームの開始時刻で、
      // 直前にperformance.now()で取ったstartTimeより前になることがある（負の進み具合になり、
      // 最初の1コマだけ前の縁より内側・濃い色で描かれていた）。0未満にならないよう抑える。
      const progress = Math.min(1, Math.max(0, (now - startTime) / CIRCLE_WAVE_DURATION_MS));
      // 広がりは終わりに向けてゆるやかに（ease-out）、うすくなるのは一定の速さで。
      const eased = 1 - (1 - progress) * (1 - progress);
      wave.radiusKm = fromKm + (toKm - fromKm) * eased;
      wave.opacity = CIRCLE_WAVE_START_OPACITY * (1 - progress);
      if (progress >= 1 && !wave.tailPainted && wave.paintedOpacity > CIRCLE_WAVE_TAIL_MAX_OPACITY) {
        // 【2026-10-27、62本目、不具合修正】3Dは波を描くたびに地形ごと描き直すため、1コマが45〜60msかかり、
        // 終わり際に長い処理（実測84〜169ms）が1回挟まると、次のコマではもう時間切れになり、最後に描いた
        // 濃さ（0.12〜0.14）のまま波が消えていた（10/24のB：「うすくなりきらずに消える」がときどき残る件）。
        // 時間切れのとき、最後に描いた濃さがまだ0.1をこえていたら、うすい濃さで新しい縁に1コマだけ描いてから
        // 消す。普通の速さのコマ（35ms以下）では最後に描く濃さが0.05以下になるため、この1コマは描かない
        // （動きの時間0.5秒は変わらない）。止まったときだけ、波が1コマ分長く残る。
        wave.tailPainted = true;
        wave.radiusKm = toKm;
        wave.opacity = CIRCLE_WAVE_TAIL_OPACITY;
        paint();
        wave.paintedOpacity = wave.opacity;
        wave.frame = requestAnimationFrame(step);
        return;
      }
      paint();
      wave.paintedOpacity = wave.opacity;
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
    const source = this.map?.getSource(REACH_WAVE_SOURCE_ID);
    if (source) source.setData({ type: 'FeatureCollection', features: [] });
    if (this.map?.getLayer(REACH_WAVE_LINE_LAYER_ID)) {
      this.map.setPaintProperty(REACH_WAVE_LINE_LAYER_ID, 'line-opacity', 0);
    }
  }

  /**
   * 【2026-10-20、36本目】指定した予算以内で一番遠い場所までの直線距離（km）。
   * updateReachCircle()が円の半径アニメーションの目標として使うのと同じ計算を、
   * アニメーション中の値（_reachCircleRadiusKm）を介さず直接呼べるよう独立
   * させた（検索直後にfitCircleToView()へ渡す「最終的な」半径が必要なため。
   * map-view.jsのcomputeReachRadiusKm()と同じ役割・同じ名前）。
   * @param {number} budget
   * @returns {number}
   */
  computeReachRadiusKm(budget) {
    const dep = this._lastDepartureStation;
    if (!dep || !isFiniteNumber(dep.stop_lat) || !isFiniteNumber(dep.stop_lon)
      || !this._lastSpots || this._lastSpots.length === 0) {
      return 0;
    }
    return this._lastSpots.reduce((max, s) => {
      if (!isFiniteNumber(s.latitude) || !isFiniteNumber(s.longitude)) return max;
      if (s.source_round_trip_fare > budget) return max;
      return Math.max(max, haversineKm(dep.stop_lat, dep.stop_lon, s.latitude, s.longitude));
    }, 0);
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
    this._reachCircleTargetKm = targetKm;
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
      // 【37本目、不具合修正】requestAnimationFrameに渡される時刻はそのフレームの開始時刻で、
      // 直前にperformance.now()で取ったstartTimeより前になることがある（負の進み具合になり、
      // 最初の1コマだけ前の縁より内側・濃い色で描かれていた）。0未満にならないよう抑える。
      const progress = Math.min(1, Math.max(0, (now - startTime) / CIRCLE_RADIUS_ANIM_MS));
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
    const ring = buildCircleRing(dep, radiusKm);
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
   * 【2026-10-27、64本目、Minami決定】予算の±・スライダー操作のたびに呼ぶ（2Dのmap-view.jsと同じ）。押したらすぐ
   * （待たずに）地図を「いっぱい」（fitCircleToView()）に合わせる。−のときは寄る。利用者が地図を動かしたあとでも合わせる。
   * ＋のとき（raised）だけ、地図合わせが終わってから波を出し、波が通り過ぎた新しいオレンジを「ぽよん」と出す。
   * 続けて押したら、走っている波・ぽよんは消して、新しい地図合わせに移る。
   * 以前の「0.15秒待ってから、0.95をこえた・0.35を下回ったときだけ動かす」（32本目B・37本目・47本目）と、「波が
   * 終わってから地図合わせ」（52本目）はやめた。波と地図合わせを同時に動かさないため、52本目の「地図合わせの動き出しの
   * 1コマで画面が止まり、波が濃いまま消える」も起きない（波は地図合わせが終わってから出す）。
   * @param {{raised?: boolean}} [opts]
   */
  fitAfterBudgetChange({ raised = false } = {}) {
    this._cancelFitCircleToView();
    this._pausePinPop();
    if (!this.map) return;
    const token = this._budgetFitToken;
    const radiusKm = this._reachCircleTargetKm;
    this.fitCircleToView({ radiusKm });
    const afterFit = () => {
      if (token !== this._budgetFitToken) return;
      this._budgetFitWait = null;
      if (raised && radiusKm > 0) this._startCircleWave(0, radiusKm);
      if (this._pinPop) this._startPinPop(this._liveBudget);
    };
    if (this._circleFitAnim) {
      this._budgetFitWait = afterFit;
      this.map.once('moveend', afterFit);
    } else {
      afterFit();
    }
  }

  /** ＋−の地図合わせの「合わせ終わったら波」を取り消し、走っている波を消す。 */
  _cancelFitCircleToView() {
    this._budgetFitToken++;
    this._fillRefineToken++;
    this._fillRefinePending = false;
    if (this._budgetFitWait && this.map) this.map.off('moveend', this._budgetFitWait);
    this._budgetFitWait = null;
    this._cancelCircleWave();
  }

  /**
   * 【2026-10-17、32本目B、Minami決定】到達円「全体」が画面に収まるよう、滑らかにカメラを引く/寄せる。
   * 向き（bearing）・傾き（pitch）は今の値のまま変えない（Minami指示：ハンドルで向き・傾きを変えたあとに
   * ＋／−を押しても戻らない）。
   * 【2026-10-25、57本目、Minami決定：ア】地図から重ねた入れ物を除いた「見えている範囲」で測り、出発駅をその
   * 真ん中に置く。見えている範囲はカメラのpaddingとして渡す。
   * 【2026-10-27、64本目、Minami決定】円が見えている範囲いっぱいになるまで寄る（以前の「横方向の直径を短辺の0.85」・
   * 金額操作のあとの0.95／0.35はやめた）。斜めから見た円は横長の楕円に写るため、行き先のカメラで円の縁を画面に写し、
   * 楕円の見た目の幅と高さが見えている範囲の端から8px（CIRCLE_FIT_EDGE_GAP_PX）のところまでに入る一番大きいズームに
   * する（縦か横のどちらかが先に端にぶつかる）。地図の上の部品からは4px＋8pxのすき間を残す。
   * 検索した直後・最初の見え方に戻るボタン・「← 一覧に戻る」・初めて3Dにしたとき・開け閉め・＋−のどれも同じ合わせ方。
   * 【37本目】傾き（pitch）と動きの長さ（durationMs）も上書きできる（returnToSearchView()が傾きOVERVIEW_PITCHを渡す）。
   * @param {{radiusKm?: number, animate?: boolean, pitch?: number, durationMs?: number}} [opts]
   * @returns {number|null} 合わせた先のズーム（合わせられなかったときはnull）
   */
  fitCircleToView({
    radiusKm = this._reachCircleRadiusKm,
    animate = true,
    pitch: pitchOverride,
    durationMs = CIRCLE_FIT_DURATION_MS,
  } = {}) {
    if (!this.map) return null;
    const dep = this._lastDepartureStation;
    if (!dep || !isFiniteNumber(dep.stop_lat) || !isFiniteNumber(dep.stop_lon) || !radiusKm || radiusKm <= 0) {
      return null;
    }
    // 【不具合修正、32本目B】地図が見えていない（0×0）ときは何もしない（見えたときに合わせ直す）。
    const container = this.map.getContainer();
    if (container.clientWidth === 0 || container.clientHeight === 0) return null;
    const visPad = visiblePadding(container);
    const pitch = pitchOverride ?? this.map.getPitch();
    const bearing = this.map.getBearing();
    const duration = (prefersReducedMotion() || !animate) ? 0 : durationMs;
    const fillZoom = this._zoomForCircleFill(dep, radiusKm, pitch, bearing, visPad);
    if (fillZoom !== null) {
      this._easeToCircle(dep, fillZoom, pitch, bearing, duration, visPad);
      return fillZoom;
    }
    // transformを複製できない版だけ、cameraForBounds()で円の外接四角を見えている範囲に合わせる（見えている範囲は使わない）。
    const north = destinationPoint(dep.stop_lat, dep.stop_lon, 0, radiusKm);
    const east = destinationPoint(dep.stop_lat, dep.stop_lon, 90, radiusKm);
    const south = destinationPoint(dep.stop_lat, dep.stop_lon, 180, radiusKm);
    const west = destinationPoint(dep.stop_lat, dep.stop_lon, 270, radiusKm);
    const shortSide = Math.max(1, Math.min(container.clientWidth, container.clientHeight));
    const padding = Math.min(CIRCLE_FIT_EDGE_GAP_PX, Math.floor(shortSide / 2) - 1);
    // 【不具合修正、32本目B】cameraForBounds()は地図に残っているpaddingも合算して「収まるか」を見るため、先に0へ戻す。
    this.map.setPadding(CLEAR_PADDING);
    const camera = this.map.cameraForBounds([[west.lon, south.lat], [east.lon, north.lat]], { padding, pitch, bearing });
    if (!camera) return null;
    const zoom = Math.max(camera.zoom, CIRCLE_FIT_MIN_ZOOM);
    this._easeToCircle(dep, zoom, pitch, bearing, duration, CLEAR_PADDING);
    return zoom;
  }

  /**
   * 【64本目】出発駅を見えている範囲の真ん中（padding）に置き、傾きpitch・向きbearingにしたとき、半径radiusKmの円の縁
   * （5°ごとの72点）が、見えている範囲を8px内側に縮めた枠の中に入り、地図の上の部品（4px＋8px広げた形）にかからない、
   * 一番大きいズーム（最低ズーム8.5）。行き先のカメラはtransformの複製で作る（地図そのものは動かさない）。
   * ズームを上げるほど円は外へ広がるため、1ずつ上げて入らなくなる段を見つけ、その間を二分して求める。
   * 複製できない版ではnull。
   */
  _zoomForCircleFill(dep, radiusKm, pitch, bearing, padding) {
    let tr;
    try {
      tr = this.map.transform.clone();
      tr.setPadding(padding);
      tr.setCenter(new maplibregl.LngLat(dep.stop_lon, dep.stop_lat));
      tr.setPitch(pitch);
      tr.setBearing(bearing);
    } catch {
      return null;
    }
    const container = this.map.getContainer();
    const g = CIRCLE_FIT_EDGE_GAP_PX;
    const box = {
      left: padding.left + g,
      top: padding.top + g,
      right: container.clientWidth - padding.right - g,
      bottom: container.clientHeight - padding.bottom - g,
    };
    // 見えている範囲（padding）の外＝重ねた入れ物の下にある部品は見ない。真ん中（出発駅）にかぶっている部品も見ない（2Dと同じ）。
    const cx = (padding.left + container.clientWidth - padding.right) / 2;
    const cy = (padding.top + container.clientHeight - padding.bottom) / 2;
    const og = CIRCLE_OBSTACLE_GAP_PX + g;
    const rects = circleObstacleRects(container)
      .filter((r) => !(r.right <= padding.left || r.left >= container.clientWidth - padding.right
        || r.bottom <= padding.top || r.top >= container.clientHeight - padding.bottom))
      .filter((r) => (r.round
        ? Math.hypot(r.cx - cx, r.cy - cy) >= r.radius + og
        : !(cx > r.left - og && cx < r.right + og && cy > r.top - og && cy < r.bottom + og)));
    const edge = [];
    for (let i = 0; i < 72; i++) {
      const p = destinationPoint(dep.stop_lat, dep.stop_lon, i * 5, radiusKm);
      edge.push(new maplibregl.LngLat(p.lon, p.lat));
    }
    // 【64本目】地形の上の円の見た目で測る（map.project()と同じく地形の高さを入れて写す）。カメラの中心の高さは今のまま
    // （MapLibreが動き終わりにそろえるとは限らない。出発駅の高さにそろえて測ると、富山駅前・PCで2.4pxはみ出した）。
    const terrain = this.map.terrain || null;
    const fits = (z) => {
      tr.setZoom(z);
      return edge.every((ll) => {
        const pt = tr.locationToScreenPoint(ll, terrain || undefined);
        if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return false;
        if (pt.x < box.left || pt.x > box.right || pt.y < box.top || pt.y > box.bottom) return false;
        return !rects.some((r) => (r.round
          ? Math.hypot(pt.x - r.cx, pt.y - r.cy) < r.radius + og
          : pt.x > r.left - og && pt.x < r.right + og && pt.y > r.top - og && pt.y < r.bottom + og));
      });
    };
    const maxZoom = 22;
    let lo = CIRCLE_FIT_MIN_ZOOM;
    if (!fits(lo)) return lo;
    while (lo + 1 <= maxZoom && fits(lo + 1)) lo += 1;
    let hi = Math.min(lo + 1, maxZoom);
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** fitCircleToView()の実際のカメラ移動。動いている間は行き先のズームを
   * _circleFitAnimに覚えておき（37本目、途中で次の判断をするときに使う）、止まったら消す。 */
  _easeToCircle(dep, zoom, pitch, bearing, duration, padding = CLEAR_PADDING) {
    this._focusedOnSpot = false;
    this._flyFocusedSpotId = null;
    // 【64本目】もう合わせた位置にいるときは動かさない（同じ場所へ動き直す空の動きを出さない。＋−の波はすぐ出せる）。
    const p = this.map.getPadding();
    const samePadding = ['top', 'right', 'bottom', 'left'].every((k) => Math.abs((p[k] || 0) - (padding[k] || 0)) < 1);
    const a = this.map.project(this.map.getCenter());
    const b = this.map.project([dep.stop_lon, dep.stop_lat]);
    if (!this.map.isMoving() && samePadding && Math.abs(this.map.getZoom() - zoom) < 0.005
      && Math.abs(this.map.getPitch() - pitch) < 0.1 && Math.abs(((this.map.getBearing() - bearing + 540) % 360) - 180) < 0.1
      && Math.hypot(a.x - b.x, a.y - b.y) < 1) {
      this._circleFitAnim = null;
      this._rememberFitCamera();
      return;
    }
    const anim = duration > 0 ? { zoom } : null;
    this._circleFitAnim = anim;
    // 【58本目】合わせ終えたときのカメラを覚える。duration 0のときはeaseTo()の中でmoveendが出るため先に登録する。
    // 動かすときは後で登録する（動いている途中にeaseTo()を呼ぶと、前の動きのmoveendがeaseTo()の中で出るため）。
    const onEnd = () => {
      if (this._circleFitAnim === anim) this._circleFitAnim = null;
      this._rememberFitCamera();
    };
    // 【64本目、不具合修正】動いている途中に一瞬で合わせるときは、先に前の動きを止める（止めたときのmoveendで、
    // 途中のカメラを「合わせたカメラ」として覚えてしまい、利用者が動かした扱いになっていた）。
    if (!anim && this.map.isMoving()) this.map.stop();
    if (!anim) this.map.once('moveend', onEnd);
    this.map.easeTo({
      center: [dep.stop_lon, dep.stop_lat],
      zoom,
      pitch,
      bearing,
      duration,
      // 【57本目】出発駅を見えている範囲（重ねた入れ物を除く）の真ん中に置く。
      padding,
    });
    if (anim) this.map.once('moveend', onEnd);
  }

  /** 【58本目】円に合わせ終えたときのカメラ（開け閉めのとき、そのあと地図が動いたかを見るため）。 */
  _rememberFitCamera() {
    if (!this.map) return;
    this._lastFitCamera = { center: this.map.getCenter(), zoom: this.map.getZoom(), pitch: this.map.getPitch(), bearing: this.map.getBearing() };
  }

  /**
   * 【64本目】最後に円に合わせたあと、利用者が地図を動かしたか（2Dのmap-view.jsと同じ）。円に合わせる動きの途中・
   * まだ一度も合わせていない・見えたら合わせる保留があるときは、動かしていない扱い。
   */
  hasUserMovedSinceFit() {
    if (this._circleFitAnim) return false;
    return !!this.map && !!this._lastFitCamera && !this._pendingReturnToSearchView && !this.isAtLastCircleFit();
  }

  /** 【58本目】地図が、最後に円に合わせたときのまま（利用者が動かしていない・ピンへ寄っていない）か。 */
  /** 【64本目】最後に合わせたときの見えている範囲（padding）と、今の見えている範囲が1pxより違うか（main.jsが検索した直後に見る）。 */
  visibleAreaChangedSinceFit() {
    if (!this.map) return false;
    const now = visiblePadding(this.map.getContainer());
    const p = this.map.getPadding();
    return ['top', 'right', 'bottom', 'left'].some((k) => Math.abs((p[k] || 0) - (now[k] || 0)) > 1);
  }

  isAtLastCircleFit() {
    const f = this._lastFitCamera;
    if (!this.map || !f) return false;
    if (Math.abs(this.map.getZoom() - f.zoom) > 0.01) return false;
    if (Math.abs(this.map.getPitch() - f.pitch) > 0.5) return false;
    if (Math.abs(((this.map.getBearing() - f.bearing + 540) % 360) - 180) > 0.5) return false;
    const a = this.map.project(f.center);
    const b = this.map.project(this.map.getCenter());
    return Math.hypot(a.x - b.x, a.y - b.y) < 2;
  }

  /** 【59本目】今の見えている範囲の真ん中（地図の入れ物の左上を基準にしたpx）。見えていないときはnull。 */
  captureVisibleCenter() {
    if (!this.map) return null;
    const container = this.map.getContainer();
    if (container.clientWidth === 0 || container.clientHeight === 0) return null;
    const v = visibleMapRect(container);
    return { x: (v.left + v.right) / 2, y: (v.top + v.bottom) / 2 };
  }

  /**
   * 【58本目・59本目】見えている範囲が変わったとき（PCの一覧パネルの開け閉め、スマホの下の一覧の小・大）。
   * - 地図が最後に円に合わせたときのままなら、新しい見えている範囲の真ん中へ出発駅を合わせ直す（傾き・向きは
   *   そのまま。円の大きさの決め方・動きの時間は今までの地図合わせと同じ）。
   * - 利用者が地図を動かしたあと（ピンへ寄ったあとを含む）は、ズーム・傾き・向きはそのままで、それまで見えている
   *   範囲の真ん中にあった場所を、新しい見えている範囲の真ん中へ横にずらす（59本目、Minami決定：A）。
   * 地図が見えていない（2D表示中）ときは、円に合わせたままなら次に見えたとき（resize()）に合わせ直す。
   * @param {{x:number, y:number}|null} [prevCenter] 変わる前の見えている範囲の真ん中（captureVisibleCenter()）
   */
  handleVisibleAreaChanged(prevCenter = null) {
    if (!this.map || !this._lastDepartureStation || !(this._reachCircleRadiusKm > 0)) return;
    const container = this.map.getContainer();
    if (container.clientWidth === 0 || container.clientHeight === 0) {
      if (this.isAtLastCircleFit()) this._pendingVisibleAreaRefit = true;
      return;
    }
    this._pendingVisibleAreaRefit = false;
    if (this.isAtLastCircleFit()) {
      this._cancelFitCircleToView();
      this.fitCircleToView({ radiusKm: this._reachCircleRadiusKm });
      return;
    }
    if (!prevCenter) return;
    // それまで見えている範囲の真ん中にあった地面の場所を、新しい見えている範囲の真ん中（padding）に置く。
    this._flySpotToken++; // 寄る途中（降りる→傾ける）だったら、あとの傾けで位置を上書きしない
    this.map.easeTo({
      center: this.map.unproject([prevCenter.x, prevCenter.y]),
      zoom: this.map.getZoom(),
      pitch: this.map.getPitch(),
      bearing: this.map.getBearing(),
      padding: visiblePadding(container),
      duration: prefersReducedMotion() ? 0 : CIRCLE_FIT_DURATION_MS,
    });
  }

  // 【2026-10-20、39本目】ここにあった旧「全体表示」fitToBudget()（スポット座標基準・
  // 余白は短辺の8%・最低ズーム9.5）は、検索直後（36本目）・「全体を見る」（37本目）・
  // 「← 一覧に戻る」（39本目）がすべてfitCircleToView()に揃い、呼び出し元が無くなったため
  // 削除した（経緯はgit logの5本目・34本目・37本目・39本目を参照）。

  /**
   * 【2026-10-20、39本目、Minami決定】検索した直後と同じ見え方（最後に検索した金額の円に
   * fitCircleToView()で合わせる、向きは変えない）へ戻る。
   * 【41本目】円は短辺の0.6、傾きはOVERVIEW_PITCH（45°）。使う場面は、検索した直後
   * （main.jsのrenderSearchResults()、durationMs:0）・最初の見え方に戻るボタン
   * （#map-reset-view-btn、以前の「全体を見る」の役目）・「← 一覧に戻る」（main.jsの
   * showResultsList()）の3つ。
   * スマホで詳細画面から一覧タブへ戻ったときのように、地図が見えていない
   * （コンテナ0×0）ときは合わせられないため、次に地図が見えたとき（resize()）に
   * 合わせ直す（以前のfitToBudget()も、見えていない間に呼ばれた分のカメラ位置は
   * 地図タブを開いたときにそのまま残っていた）。
   * @param {{durationMs?: number}} [opts]
   */
  returnToSearchView({ durationMs = CIRCLE_FIT_DURATION_MS } = {}) {
    if (!this.map || this._lastBudget == null) return;
    const container = this.map.getContainer();
    if (container.clientWidth === 0 || container.clientHeight === 0) {
      this._pendingReturnToSearchView = true;
      return;
    }
    this._pendingReturnToSearchView = false;
    // 詳細画面のあいだ地図が非表示（display:none）だった直後は、MapLibreが内部に
    // 持つ地図の大きさがまだ古いまま（大きさの変化の検知は非同期）で、そのまま
    // 合わせると検索直後とズームがずれる（400×464で実測：0.4ずれた）。先に確定させる。
    this.map.resize();
    // 場所へ寄る途中（flyToSpot()の「降りる→傾ける」の後半が保留中）に戻ったとき、
    // あとから傾ける動きが始まって戻った位置を上書きしないよう無効化する。
    this._flySpotToken++;
    // 最後に検索した金額の円に合わせる。傾きはOVERVIEW_PITCH（41本目から45°）、向きは変えない。
    this._cancelFitCircleToView();
    // 【64本目】今描いている円（今の金額、＋−で変えたあとはその金額）に「いっぱい」で合わせる（2Dと同じ）。
    const radiusKm = this.computeReachRadiusKm(this._liveBudget ?? this._lastBudget);
    this.fitCircleToView({ radiusKm, pitch: OVERVIEW_PITCH, durationMs });
    this._scheduleFillRefine(radiusKm);
  }

  /**
   * 【64本目】「いっぱい」は地形の高さを入れて測るが、検索した直後・初めて3Dにした直後は、行き先の標高タイルが
   * まだ無く平らとして測ることになる（大池・PCで実測：平らなら下の端まで8px、標高が届くと手前の山で円の下の縁が
   * 持ち上がり26px）。そこで地図が落ち着いたら（idle＝タイルを読み終わった）測り直し、ずれていれば短く（0.25秒）
   * 合わせ直す。利用者が動かした・＋−を押した（_cancelFitCircleToView()が世代を進める）・波やぽよんの最中はしない。
   * idleは描き続けている間は来ないことがあるため、0.15秒ごとに「止まっていてタイルを読み終わった」かを見て、
   * 4秒たったら読み終わっていなくても測り直す。
   */
  _scheduleFillRefine(radiusKm) {
    if (!this.map) return;
    const token = ++this._fillRefineToken;
    const deadline = performance.now() + 4000;
    this._fillRefinePending = true;
    const check = () => {
      if (token !== this._fillRefineToken) return;
      if (!this.map) { this._fillRefinePending = false; return; }
      const late = performance.now() > deadline;
      if (this.map.isMoving() || this._circleFitAnim || (!late && !this.map.areTilesLoaded())) {
        setTimeout(check, 150);
        return;
      }
      this._fillRefinePending = false;
      if (this._circleWave || this._pinPop || this._budgetFitWait || !this.isAtLastCircleFit()) return;
      const dep = this._lastDepartureStation;
      const container = this.map.getContainer();
      if (!dep || container.clientWidth === 0 || container.clientHeight === 0) return;
      const pad = visiblePadding(container);
      const pitch = this.map.getPitch();
      const bearing = this.map.getBearing();
      const zoom = this._zoomForCircleFill(dep, radiusKm, pitch, bearing, pad);
      if (zoom === null || Math.abs(zoom - this.map.getZoom()) < 0.005) return;
      this._easeToCircle(dep, zoom, pitch, bearing, prefersReducedMotion() ? 0 : 250, pad);
    };
    setTimeout(check, 150);
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
    if (!container || height === 0 || container.clientWidth === 0) return { top: 0, right: 0, bottom, left: 0 };
    // 【57本目】重ねた入れ物（PCの左の入れ物・スマホの下の入れ物）の下に選んだピンが隠れないよう、見えている範囲を
    // paddingにし、下は帯よけの余白と入れ物の大きい方にする。上下・左右の合計が地図の辺の長さに近づくと
    // 「Map cannot fit within canvas」になるため、真ん中に80pxは残す。
    const vis = visiblePadding(container);
    const pad = { top: vis.top, right: vis.right, bottom: Math.max(bottom, vis.bottom), left: vis.left };
    pad.bottom = Math.max(0, Math.min(pad.bottom, height - 80 - pad.top));
    return pad;
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
    this._placeRotateHint(hint);
    hint.addEventListener('click', () => { hint.hidden = true; }, { once: true });
    setTimeout(() => { hint.hidden = true; }, ROTATE_HINT_AUTO_HIDE_MS);
  }

  /**
   * 【45本目、不具合修正】吹き出しを、ピン・まとめた丸・出発駅の印・地図の部品に重ならない場所に出す。
   * 以前はいつもハンドルの左（CSSの固定位置）に出していたため、地図の縦が短い画面（400×464では
   * 地図が376×240）では地図の真ん中にかかり、ピンやまとめた丸を隠していた。
   * 候補を順に試し（1. ハンドルの左〔矢印でハンドルを指す〕 2. 部品の列の下 3. 左上 4. 左下
   * 5. 右下）、どれも何かに重なるときは地図の外（地図の上の端のすぐ上、上に余地がなければ下）に出す。
   */
  _placeRotateHint(hint) {
    const area = document.getElementById('map-area');
    if (!area || !this.map) return;
    hint.classList.remove('map-rotate-hint-free', 'map-rotate-hint-outside');
    delete hint.dataset.placement;
    hint.style.position = '';
    hint.style.top = '';
    hint.style.left = '';
    hint.style.right = '';
    hint.style.bottom = '';
    const a = area.getBoundingClientRect();
    const w = hint.offsetWidth;
    const h = hint.offsetHeight;
    const MARGIN = 8; // 予算操作帯などとのすき間（27本目の吹き出しと同じ8px）
    const obstacles = [];
    const addRect = (r) => { if (r && r.width > 0 && r.height > 0) obstacles.push(r); };
    // 【61本目】地図に描く点（1つずつのピン）だけは別にも覚えておく（下の、どこにも置けないときの置き場所選び用）。
    const pinRects = [];
    // ピン（円のレイヤー）。画面上の位置から、白いふちを含めた大きさの四角にする。
    const mapRect = this.map.getContainer().getBoundingClientRect();
    try {
      this.map.queryRenderedFeatures({ layers: [SPOTS_LAYER_ID, SPOTS_PLAIN_LAYER_ID] }).forEach((f) => {
        const p = this.map.project(f.geometry.coordinates);
        const x = mapRect.left + p.x;
        const y = mapRect.top + p.y;
        const r = { left: x - 10, top: y - 10, right: x + 10, bottom: y + 10, width: 20, height: 20 };
        addRect(r);
        pinRects.push(r);
      });
    } catch {
      // レイヤーがまだ無いときは、ピンは無いものとして扱う
    }
    // まとめた丸・選んだピン・出発駅の印（HTMLの印）と、地図の部品
    // 【51本目】色の説明（#map-legend）は避けない。400×464の3Dでは、避けると地図の中に置ける場所が無くなり、
    // 地図の外（一覧／地図のタブの上）に出てしまうため。吹き出しは初めの1回・3秒だけなので、その間は上に重なってよい。
    this.map.getContainer().querySelectorAll('.maplibregl-marker').forEach((el) => addRect(el.getBoundingClientRect()));
    document.querySelectorAll('#map-controls-cluster, #map-dimension-toggle, #mobile-budget-overlay, #spot-info-panel, [data-map-overlay], #map-area .maplibregl-ctrl-attrib, #map-area .maplibregl-ctrl')
      .forEach((el) => { if (el.offsetParent !== null) addRect(el.getBoundingClientRect()); });
    const touches = (r, o) => r.left < o.right + MARGIN && r.right > o.left - MARGIN
      && r.top < o.bottom + MARGIN && r.bottom > o.top - MARGIN;
    const hits = (r) => obstacles.some((o) => touches(r, o));
    const inside = (r) => r.left >= a.left + 4 && r.right <= a.right - 4 && r.top >= a.top + 4 && r.bottom <= a.bottom - 4;

    const cluster = document.getElementById('map-controls-cluster')?.getBoundingClientRect();
    const handle = document.getElementById('map-rotate-handle')?.getBoundingClientRect();
    const toggle = document.getElementById('map-dimension-toggle')?.getBoundingClientRect();
    const candidates = [];
    if (handle && handle.width > 0) {
      // CSSの矢印（::after）は上から16pxの位置にある。矢印の先がハンドルの中心を指す高さ。
      const top = handle.top + handle.height / 2 - 22;
      candidates.push({ left: handle.left - 14 - w, top, arrow: true });
    }
    if (cluster && cluster.width > 0) candidates.push({ left: cluster.right - w, top: cluster.bottom + 8 });
    candidates.push({ left: a.left + 8, top: (toggle && toggle.width > 0 ? toggle.bottom : a.top) + 8 });
    candidates.push({ left: a.left + 8, top: a.bottom - 8 - h });
    candidates.push({ left: a.right - 8 - w, top: a.bottom - 8 - h });
    // 決まった候補がどれもふさがっているときは、地図の中を8pxきざみで探し、空いている場所のうち
    // ハンドルにいちばん近いところに出す（400×464のように地図が小さい画面向け）。
    const hx = handle && handle.width > 0 ? handle.left + handle.width / 2 : a.right;
    const hy = handle && handle.width > 0 ? handle.top + handle.height / 2 : a.top;
    const grid = [];
    for (let top = a.top + 4; top + h <= a.bottom - 4; top += 8) {
      for (let left = a.left + 4; left + w <= a.right - 4; left += 8) grid.push({ left, top, d: Math.hypot(left + w / 2 - hx, top + h / 2 - hy) });
    }
    grid.sort((p, q) => p.d - q.d);
    const placeAt = (c) => {
      if (!c.arrow) hint.classList.add('map-rotate-hint-free');
      hint.style.left = `${Math.round(c.left - a.left)}px`;
      hint.style.top = `${Math.round(c.top - a.top)}px`;
      hint.style.right = 'auto';
    };
    for (const c of [...candidates, ...grid]) {
      const r = { left: c.left, top: c.top, right: c.left + w, bottom: c.top + h };
      if (!inside(r) || hits(r)) continue;
      placeAt(c);
      return;
    }
    // 【2026-10-26、61本目、不具合修正】どこに置いても何かに重なるときは、地図に描く点（1つずつのピン）にだけは
    // 重なってよいことにし、重なる点がいちばん少ない場所（同じならハンドルに近い方）に出す。まとめた丸・出発駅の印・
    // 選んだピンの印・部品・重ねた入れ物には今までどおり重ねない。以前はここで「地図の外」に出していたが、56本目で
    // 地図が画面いっぱいになり、地図の下は画面の外になったため、400×464の3D（59本目で下の一覧と上の＋−カードが
    // 見えている範囲を狭めた）では吹き出しが画面の下にはみ出して見えなかった。
    const pinSet = new Set(pinRects);
    const hardObstacles = obstacles.filter((o) => !pinSet.has(o));
    let best = null;
    for (const c of grid) {
      const r = { left: c.left, top: c.top, right: c.left + w, bottom: c.top + h };
      if (!inside(r) || hardObstacles.some((o) => touches(r, o))) continue;
      const n = pinRects.filter((o) => touches(r, o)).length;
      if (!best || n < best.n) best = { c, n };
    }
    if (best) {
      placeAt(best.c);
      hint.dataset.placement = 'fewest-pins'; // 検証用（verify-layout.jsが、ピンに重なってよい置き方かを見分ける）
      return;
    }
    // それでも置けない：地図の外に出す（画面に対して固定。3秒で消える）。
    hint.classList.add('map-rotate-hint-free', 'map-rotate-hint-outside');
    hint.style.position = 'fixed';
    hint.style.right = 'auto';
    hint.style.left = `${Math.round(Math.max(4, a.right - w))}px`;
    hint.style.top = `${Math.round(a.top - h - 6 >= 0 ? a.top - h - 6 : a.bottom + 6)}px`;
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
    this._alignCenterElevationToSpot(spot);
    this.map.easeTo({
      pitch: SPOT_FOCUS_PITCH,
      zoom: SPOT_FOCUS_ZOOM,
      center: [spot.longitude, spot.latitude],
      freezeElevation: true,
      duration: TILT_DURATION_MS,
      padding: this.getRevealPadding(),
    });
    this.map.once('moveend', () => {
      if (token !== this._flySpotToken || !this.map) return;
      if (this.onTiltComplete) this.onTiltComplete(spot);
    });
  }

  /**
   * 【2026-10-21、43本目、不具合修正】選んだ場所へ寄る前に、カメラの中心の高さ（elevation）を
   * その場所の標高にそろえる。
   * 原因：MapLibre（5.6.1）は地形があるとき、寄る動き（flyTo/easeTo）のあいだ中心の高さを
   * 「帯よけの余白（padding）を含めない画面の真ん中」の地面の標高に合わせて動かし、
   * 終わりに地面の上で中心を計算し直す（_updateElevation・_finalizeElevation）。帯よけの
   * 下の余白で画面の真ん中は手前（谷側）にずれるため、山の上の場所に寄ると、中心の高さが
   * 谷の標高のままになる（実測：大池から前田山へ寄ると、中心の高さ16.8m、前田山の標高548m）。
   * その結果ピンは計算上の位置（余白を除いた範囲の真ん中）より約130px上に描かれ、PCでも
   * 地図の高さが低い画面（1280×720では地図の高さ385px・下の余白180px）や400×464では、
   * 選んだピンが地図の上の外に出て見えなくなっていた（Minami実機確認：大池・往復¥1,500）。
   * 対策：動き出す直前に中心の高さを選んだ場所の標高へ瞬時にそろえ（jumpTo({elevation})、
   * easeTo/flyToは"elevation"オプションを受け付けないため）、動きのあいだは
   * freezeElevation:trueで高さを固定する。標高が読めない（標高タイルが未読込）ときは何もしない。
   * 降り始める時点では粗い標高しか無いことがあるため、降りたあと（細かいタイル読込後）の
   * 傾けの前にもう一度そろえ直す。
   */
  _alignCenterElevationToSpot(spot) {
    if (!this.map || typeof this.map.queryTerrainElevation !== 'function') return;
    const elevation = this.map.queryTerrainElevation([spot.longitude, spot.latitude]);
    if (!isFiniteNumber(elevation)) return;
    this.map.jumpTo({ elevation });
  }

  flyToSpot(spot, departureStation) {
    if (!this.map || !isFiniteNumber(spot?.latitude) || !isFiniteNumber(spot?.longitude)) return;
    this._cancelFitCircleToView(); // スポットへ寄る操作を、保留中の円合わせに邪魔されないようにする
    // 【43本目、不具合修正】3Dが見えるまで保留している「全体の見え方へ合わせる」（A-2の初めての
    // 3D切替・見えていない間の検索）が、寄ったあとに実行されて寄った位置を上書きしないようにする
    // （実機相当の確認で発覚：動きを減らす設定で寄ったあと、傾きが45°に戻っていた）。
    this._pendingReturnToSearchView = false;
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
    // 寄っている間はtrue（同じ場所を続けて選んだかの判定に使う）。
    // 【41本目】以前はこれで「全体を見る」ボタンを出していたが、ボタンはいつでも出ている
    // 最初の見え方に戻るボタン（#map-reset-view-btn）に置き換えた。
    this._focusedOnSpot = true;
    const revealPadding = this.getRevealPadding();

    if (sameSpotAlreadyFocused && !prefersReducedMotion()) {
      this._alignCenterElevationToSpot(spot);
      this.map.easeTo({
        pitch: SPOT_FOCUS_PITCH,
        zoom: SPOT_FOCUS_ZOOM,
        center: [spot.longitude, spot.latitude],
        freezeElevation: true,
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
      this._alignCenterElevationToSpot(spot);
      this.map.flyTo({
        center: [spot.longitude, spot.latitude],
        freezeElevation: true,
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

    this._alignCenterElevationToSpot(spot);
    this.map.flyTo({
      center: [spot.longitude, spot.latitude],
      freezeElevation: true, // 中心の高さは直前の_alignCenterElevationToSpot()の値のまま動かさない
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
        this._alignCenterElevationToSpot(spot); // 降りたあとの細かい標高でそろえ直す
        // center・paddingを傾けのeaseToでも明示し直す（spotの座標＋情報帯よけの
        // ずらし幅を毎回同じに保つ。paddingだけ省略した場合の挙動に依存しない）。
        this.map.easeTo({
          pitch: SPOT_FOCUS_PITCH,
          duration: TILT_DURATION_MS,
          center: [spot.longitude, spot.latitude],
          freezeElevation: true,
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
    // 【43本目D】背景は、どのズームでもベクトル地図のタイル1種類だけになった。
    const backgroundIdsToCheck = () => [this._baseSourceId];
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
    if (!this.map) return;
    this.map.resize();
    // 【39本目】見えていない間に「← 一覧に戻る」が押されていたら、見えたここで合わせる。
    if (this._pendingReturnToSearchView) {
      this._pendingVisibleAreaRefit = false;
      this.returnToSearchView({ durationMs: 0 });
    } else if (this._pendingVisibleAreaRefit) {
      // 【58本目】見えていない間に一覧パネルを開け閉めしていたら、見えたここで合わせ直す
      this._pendingVisibleAreaRefit = false;
      this.fitCircleToView({ radiusKm: this._reachCircleRadiusKm, animate: false });
    }
  }

  /** 2D切替時・再試行時にWebGLコンテキストを確実に解放する（上限超過による失敗を防ぐ） */
  destroy() {
    this._absorbedSignature = '';
    this._absorbedIds = null;
    this._plainHoverId = null;
    this._cancelWaveReveal();
    this._cancelFitCircleToView();
    if (this._circleAnimFrame) {
      cancelAnimationFrame(this._circleAnimFrame);
      this._circleAnimFrame = null;
    }
    if (this._clusterUpdateTimer) {
      clearTimeout(this._clusterUpdateTimer);
      this._clusterUpdateTimer = null;
    }
    if (this._clusterMarkers) {
      this._clusterMarkers.forEach((entry) => entry.marker.remove());
      this._clusterMarkers.clear();
    }
    if (this._selectedMarker) {
      this._selectedMarker.remove();
      this._selectedMarker = null;
    }
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
    this.departureMarker = null;
  }
}
