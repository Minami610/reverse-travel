/**
 * main.js - みちどころ UIロジック
 * 検索画面、結果表示、スポット詳細を管理
 */

import { GTFSLoader } from './gtfs-loader.js';
import { FareCalculator } from './fare-calculator.js';
import { SpotFinder } from './spot-finder.js';
import { RouteFormatter } from './route-formatter.js';
import { estimateTripFrequency, formatDayLabel, operatorLabelWord, sameRouteWord } from './route-duration.js';
import { buildOnwardCandidates } from './onward-candidates.js';
import { MapView, isFiniteNumber, formatReachRadiusKm, pinCategory } from './map-view.js';
import { isWebglLikelySupported, loadTerrainModule, preloadTerrainModuleWhenIdle } from './terrain-loader.js';
import { LayoutController } from './layout-controller.js';
import {
  loadFavorites, isFavorite, toggleFavorite, removeFavorite, upsertFavorite,
  buildSpotShareUrl, parseSpotShareParams, buildListShareUrl, parseListParam,
  buildSpotShareText, shareOrCopy,
} from './favorites.js';

// 予算の帯の幅（¥）。表示するのは「予算−BAND_WIDTHより高く、予算以下」の場所だけ
// （2026-10-06、Minamiさんの判断により「予算以下すべて」から変更）。
const BAND_WIDTH = 200;
const MIN_BUDGET = 200;
const MAX_BUDGET = 2000; // 2026-10-06、Minamiさんの判断により¥1000から変更
const BUDGET_STEP = 100;
// 【2026-10-21、41本目】最初の見え方に戻るボタン（#map-reset-view-btn）で戻るときの
// なめらかな動きの長さ（以前の「全体を見る」と同じ1.5秒前後、Minami指示）。
const RESET_VIEW_DURATION_MS = 1500;
// 【2026-10-13、10本目②】scheduleMaxBudgetPrefetch()参照。map-view.js・
// terrain-map-view.jsのWAVE_DURATION_MS（1000ms、検索後に点が波のように出る
// 演出の所要時間）より確実に後になるよう、裏取得の反映を遅らせるための余裕時間。
const WAVE_REVEAL_SAFE_DELAY_MS = 1200;
// 【56本目】検索ボタンの文言（見本のトップ画面）
const SEARCH_BUTTON_LABEL = 'この条件で探す';

/**
 * 【2026-10-24、51本目、Minami決定】一覧の上の見出し（例: budget=800・12件 → "¥601〜¥800 の場所　12か所"）。
 * 一覧に今出ている金額帯と、その中の数。
 * 【58本目】PCの一覧パネルでは金額帯を左、数を右に出す（見本②）ため、2つのspanに分ける（文字は51本目のまま）。
 */
function bandHeadingHtml(budget, count) {
  return `<span class="band-heading-range">¥${formatThousands(budget - BAND_WIDTH + 1)}〜¥${formatThousands(budget)} の場所</span><span class="band-heading-count">　${count}か所</span>`;
}

/** 数字を3桁区切りにする（例: 1740 → "1,740"。「この先へ」の運賃表記用） */
function formatThousands(n) {
  return n.toLocaleString('ja-JP');
}

const MAP_MODE_STORAGE_KEY = 'reverse-travel-map-mode';
// 【2026-10-25、56本目、Minami決定：C】検索前の地図は、前回検索した出発駅のあたりを2Dで出す（端末に覚える）。
// 初めての人は富山駅前のあたり（見本①と同じ見え方）。
const LAST_DEPARTURE_STORAGE_KEY = 'michidokoro-last-departure';
const INITIAL_MAP_VIEW = { lat: 36.7016, lon: 137.2131, zoom: 10 };

function loadLastDeparture() {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_DEPARTURE_STORAGE_KEY) || 'null');
    if (v && Number.isFinite(v.lat) && Number.isFinite(v.lon)) return v;
  } catch { /* 読めないときは初めての人と同じ */ }
  return null;
}

function saveLastDeparture(lat, lon) {
  try {
    localStorage.setItem(LAST_DEPARTURE_STORAGE_KEY, JSON.stringify({ lat, lon }));
  } catch { /* 保存できなくても動作には影響しない */ }
}

/** 3Dを一度選んだ端末では次回も3Dにする（4本目①、Minami指示）。読み書きはtry/catch。 */
function loadMapModePreference() {
  try {
    return localStorage.getItem(MAP_MODE_STORAGE_KEY) === '3d' ? '3d' : '2d';
  } catch {
    return '2d';
  }
}

function saveMapModePreference(mode) {
  try {
    localStorage.setItem(MAP_MODE_STORAGE_KEY, mode);
  } catch {
    // プライベートブラウジング等でlocalStorageが例外を投げても無視する
  }
}

// ☆（マイリスト）・共有ボタンの線画アイコン（2026-10-09、文字"★"/"☆"/"⇧"から
// SVGに変更。Minamiさんの指示：カード・詳細画面・マイリストの3か所とも揃える）。
// 色はアイコンを包む<span>自身のcolorで決める（fill="currentColor"がボタンの
// 文字色を継承して意図しない色になるのを避けるため、.icon-starクラス側で
// color を明示的に指定し直している。CSS側を参照）。
const STAR_OUTLINE_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
const STAR_FILLED_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
const SHARE_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v13"/><path d="m8 6 4-4 4 4"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7"/></svg>';
// 応援マーク（塗りのハート）。押せるボタンに見えないよう、cursor:defaultなどは
// CSS側（.support-badge）で担保する（2026-10-10、2本目「便の少ない路線を応援」）。
const HEART_FILLED_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 21s-6.7-4.3-9.3-8.1C.8 10.1 1.4 6.6 4.3 5 6.4 3.8 9 4.3 12 7.1 15 4.3 17.6 3.8 19.7 5c2.9 1.6 3.5 5.1 1.6 7.9C18.7 16.7 12 21 12 21z"/></svg>';
// 応援マークの線（1日何便以下で付けるか）。config/support-badge.jsonから読む
// （フロントにはビルド時にdocs/data/national/support-badge.jsonとしてコピーされる）。
// 取得前・取得失敗時のフォールバック値は、config/support-badge.jsonの初期値と揃えてある。
const DEFAULT_SUPPORT_BADGE_MAX_TRIPS = 3;

/** ☆アイコンのspan（未保存=線だけ、保存済み=黄色の塗り）を組み立てる */
function starIconHtml(active) {
  return `<span class="icon icon-star${active ? ' icon-star-filled' : ''}">${active ? STAR_FILLED_SVG : STAR_OUTLINE_SVG}</span>`;
}

/** 共有アイコンのspanを組み立てる（状態による見た目の変化なし） */
function shareIconHtml() {
  return `<span class="icon icon-share">${SHARE_SVG}</span>`;
}

class ReverseTravel {
  constructor() {
    this.loader = new GTFSLoader();
    this.fareCalc = null;
    this.spotFinder = null;
    this.routeFormatter = null;
    this.mapView = new MapView('spots-map');
    // 【2026-10-13、22本目修正、Cowork指摘】選ばれたピンは、2D・3Dそれぞれが
    // 自分の selectedSpotId を持つのではなく、アプリ全体で1つだけ持つ
    // （以前はscrollSelectedCardIntoView()がthis.mapView.selectedSpotId
    // （2D側）しか見ておらず、3Dでピンを選んでも一覧がスクロールしなかった）。
    // 2D・3Dを切り替えても同じピンが選ばれたままになるよう、この値を正として
    // 両方のビューに反映する（applyMapMode()参照）。
    this.selectedSpotId = null;
    // 【2026-10-15、11本目①】吹き出し（ポップアップ）を廃止し、地図の下の
    // 固定情報枠に統一した（Minami決定：A）。ピン選択の通知（onSelectionChange）
    // は既存のまま流用し、一覧のハイライトに加えて情報枠も開く。
    this.mapView.onSelectionChange = (spotId) => {
      this.selectedSpotId = spotId;
      this.highlightCard(spotId);
      this.onPinSelected(spotId);
    };
    // 3D地図のインスタンスは3D切替が実際に行われるまで作らない（4本目②：
    // terrain-map-view.jsはMapLibre本体と同じく遅延読込のため、クラス自体が
    // まだ存在しない。activateTerrainMap()がloadTerrainModule()経由で
    // 初めて生成する）。
    this.terrainMapView = null;
    this.mapMode = loadMapModePreference(); // '2d' | '3d'（4本目①、localStorage）
    this.data = null;
    this.dataLoadFailed = false;
    this.cache = new Map(); // 検索結果のメモリキャッシュ（駅ID×予算）
    this.currentDepartureStationId = null;
    this.currentDepartureStationName = null;
    this.currentDeparturePrefCode = null; // お気に入り保存・共有URL組み立てに使う（prefCodeそのものは検索結果に含まれないため別途保持）
    this.currentSpots = []; // 検索結果（おすすめ順、地図のピンもこの集合のまま）
    this.detailHistory = []; // 「この先へ」で辿った詳細画面の履歴（スポットオブジェクトのスタック）。
    // 戻るボタンは、これが空でなければ直前のスポット詳細に戻し、空なら一覧に戻す
    // （3本目「この先へ」機能。openSpotDetailById/openSharedSpotForStationなど、
    // 一覧・共有リンクから新規に詳細を開く経路ではこのスタックをリセットする）。
    this.currentReachableCount = 0; // 帯内の到達駅数（デバッグ・将来利用のため保持。表示の分岐には使わない）
    this.currentBudget = null; // 直近の検索予算（地図のピンの色の「検索した金額」）
    // 【59本目】一覧（見出しの金額帯・カード）が今出している金額。結果画面で＋−を押すと、検索し直さずにこれだけ変わる
    // （「¥◯で探す」はやめた）。0件時の案内文もこの金額で出す。
    this.listBudget = null;
    // 【59本目】¥2,000分の裏取得（scheduleMaxBudgetPrefetch()）が、どの出発駅の分まで終わっているか。
    // 終わるまでは検索した金額の帯の場所しか持っていないため、＋−で一覧を合わせるのを待つ。
    this._allSpotsStationId = null;
    // 【61本目】今地図に渡している場所（「◯か所」「NEW +N」を地図と同じ数え方にするため。updateNewSpotMarks()）
    this._mapSpots = null;
    this.currentSortOrder = 'recommended';
    // 直近に検索した条件（出発駅欄の文字列＋予算）。nullは「まだ一度も検索していない」。
    // 検索ボタンの見た目（updateSearchButtonState）は、現在の入力がこれと一致するかで決める。
    this.lastSearchedDepartureText = null;
    this.lastSearchedBudget = null;

    this.initUI();
    // initStationIndex()のPromiseを保持し、読み込み中にperformSearch()が
    // 呼ばれた場合はこれをawaitしてから続行する（「読み込み中」と「失敗」を
    // 区別するため。以前はthis.loader.stationIndexがまだnullというだけで
    // 「読み込みに失敗しました」を出してしまっていた）。
    this.stationIndexPromise = this.initStationIndex();
    // 駅一覧のロード完了を待ってから、共有リンク（?spot=.../?list=...）を処理する。
    this.stationIndexPromise.then(() => this.handleInitialUrl());
  }

  initUI() {
    // DOM 要素取得
    this.elements = {
      layoutLeft: document.getElementById('layout-left'),
      searchSummary: document.getElementById('search-summary'),
      searchSummaryText: document.getElementById('search-summary-text'),
      searchSummaryToggle: document.getElementById('search-summary-toggle'),
      formCloseBtn: document.getElementById('form-close-btn'),
      searchForm: document.getElementById('search-form'),
      mapDimensionToggle: document.getElementById('map-dimension-toggle'),
      terrainLoadingIndicator: document.getElementById('terrain-loading-indicator'),
      sheetSpotCard: document.getElementById('sheet-spot-card'), // 【64本目】スマホでピンを押したときのカード
      mapResetViewBtn: document.getElementById('map-reset-view-btn'),
      mapZoomIn: document.getElementById('map-zoom-in'),
      mapZoomOut: document.getElementById('map-zoom-out'),
      appHeader: document.getElementById('app-header'),
      headerMenuBtn: document.getElementById('header-menu-btn'),
      headerNav: document.getElementById('header-nav'),
      departureInput: document.getElementById('departure-input'),
      departureSuggestions: document.getElementById('departure-suggestions'),
      budgetInput: document.getElementById('budget-input'),
      budgetSlider: document.getElementById('budget-slider'),
      budgetDisplay: document.getElementById('budget-display'),
      budgetBandPreview: document.getElementById('budget-band-preview'),
      budgetDecrement: document.getElementById('budget-decrement'),
      mobileBudgetOverlay: document.getElementById('mobile-budget-overlay'),
      mobileBudgetSlider: document.getElementById('mobile-budget-slider'),
      mobileBudgetDecrement: document.getElementById('mobile-budget-decrement'),
      mobileBudgetIncrement: document.getElementById('mobile-budget-increment'),
      resultsSheetHandle: document.getElementById('results-sheet-handle'),
      budgetIncrement: document.getElementById('budget-increment'),
      searchBtn: document.getElementById('search-btn'),
      searchPendingNote: document.getElementById('search-pending-note'),
      appLayout: document.getElementById('app-layout'),
      sortSelect: document.getElementById('sort-select'),
      departureGuidance: document.getElementById('departure-guidance'),
      bandHeading: document.getElementById('results-band-heading'),
      mapLegend: document.getElementById('map-legend'),
      mapNewCount: document.getElementById('map-new-count'),
      // 【58本目】PCの結果画面（左の一覧パネル・閉じたときの細いバー）
      resultsListCloseBtn: document.getElementById('results-list-close-btn'),
      resultsListOpenBtn: document.getElementById('results-list-open-btn'),
      resultsDeparture: document.getElementById('results-departure'),
      resultsBudgetValue: document.getElementById('results-budget-value'),
      resultsMapCount: document.getElementById('results-map-count'),
      resultsNewCount: document.getElementById('results-new-count'),
      resultsList: document.getElementById('results-list'),
      detailContent: document.getElementById('detail-content'),
      detailContainer: document.getElementById('detail-container'),
      detailBreadcrumb: document.getElementById('detail-breadcrumb'),
      aboutBtn: document.getElementById('about-data-btn'),
      aboutModal: document.getElementById('about-modal'),
      aboutModalClose: document.getElementById('about-modal-close'),
      howtoBtn: document.getElementById('howto-btn'),
      howtoModal: document.getElementById('howto-modal'),
      howtoModalClose: document.getElementById('howto-modal-close'),
      howtoBtnMobile: document.getElementById('howto-btn-mobile'),
      aboutBtnMobile: document.getElementById('about-data-btn-mobile'),
      mylistBtn: document.getElementById('mylist-btn'),
      mylistCount: document.getElementById('mylist-count'),
      mylistModal: document.getElementById('mylist-modal'),
      mylistModalClose: document.getElementById('mylist-modal-close'),
      mylistBody: document.getElementById('mylist-body'),
      mylistSortSelect: document.getElementById('mylist-sort-select'),
      mylistShareAllBtn: document.getElementById('mylist-share-all-btn'),
      sharedListModal: document.getElementById('shared-list-modal'),
      sharedListModalClose: document.getElementById('shared-list-modal-close'),
      sharedListBody: document.getElementById('shared-list-body'),
      sharedListAddBtn: document.getElementById('shared-list-add-btn'),
      shareToast: document.getElementById('share-toast'),
    };

    this.initModal(this.elements.aboutBtn, this.elements.aboutModal, this.elements.aboutModalClose);
    this.initModal(this.elements.howtoBtn, this.elements.howtoModal, this.elements.howtoModalClose);
    this.initModal(this.elements.mylistBtn, this.elements.mylistModal, this.elements.mylistModalClose, {
      onOpen: () => this.renderMylist(),
    });
    this.initModal(null, this.elements.sharedListModal, this.elements.sharedListModalClose);
    this.renderDataSources();
    this.updateMylistCount();

    // 【2026-10-13、12本目②C】スマホ版フッターの「使い方」「データ出典・免責」
    // リンク。中身はPC版と同じモーダルを開く（initModal()がmodal._openに
    // 保存した開く関数をそのまま使い、2つ目のトリガーのために同じ要素を
    // 2回初期化しない）。
    this.elements.howtoBtnMobile?.addEventListener('click', () => this.elements.howtoModal?._open?.());
    this.elements.aboutBtnMobile?.addEventListener('click', () => this.elements.aboutModal?._open?.());

    // 【2026-10-13、12本目②A】検索後、スマホでは要約バーを押すとフォームが開く。
    // 【2026-10-17、32本目A、不具合修正】以前はこのボタン1つで開閉両方を
    // 担っていたが、ボタン自体が#search-summaryの中にあり、フォームを開くと
    // #search-summaryごとCSSでdisplay:noneになるため「閉じる」側（文言が
    // 「▲閉じる」に変わっていた）は実際には押せなかった（Cowork指摘）。
    // 閉じる操作は専用の#form-close-btn（フォームの中、開いている間だけ
    // 見える）に分離し、このボタンは「開く」専用にする。
    this.elements.searchSummaryToggle?.addEventListener('click', () => {
      // 【2026-10-20、35本目、不具合修正】フォームを開く時点の地図カメラを
      // 覚えておく（closeFormDiscardingEdits()参照）。編集を捨てて閉じたとき、
      // ここへ戻すことで「開く前の状態と完全に同じ」に戻せるようにする。
      this._cameraSnapshotBeforeFormEdit = this.captureCameraSnapshot();
      this.setFormCollapsed(false);
    });

    // 【2026-10-17、32本目A、不具合修正】フォームを開いている間に閉じる手段。
    // 検索はせず、最後に検索した条件に戻してから畳む（入力しかけた出発駅・
    // 予算は捨てる、Minami指示）。
    this.elements.formCloseBtn?.addEventListener('click', () => {
      this.closeFormDiscardingEdits();
    });

    // 【2026-10-20、35本目、Minami指示】「条件を変える」でフォームを開いている
    // ときに、下の地図（またはタブ・一覧などフォームの外）をタップしたら、
    // 「▲閉じる」と同じく閉じる。document全体のcapture段階で拾うことで、
    // 地図のピン選択（MapLibre/Leafletがcanvas要素に直接付けているクリック
    // ハンドラ）やタブ切替より先に・確実に割り込み、stopPropagation()で
    // それらへイベントが届く前に止める（＝「そのタップでは、ピンを選んだり、
    // 地図を動かしたりしない」をイベント配送そのもので保証する）。
    // #search-form（出発駅の候補一覧#departure-suggestionsを含む）の内側は
    // 対象外（入力・候補選択は今までどおり）。#form-close-btn自身も
    // #search-formの子のため自然に対象外になり、二重発火しない。
    document.addEventListener('click', (e) => {
      const closeBtn = this.elements.formCloseBtn;
      // フォームが「開いている」状態かどうかは、#form-close-btn自体が
      // 見えているかどうかで判定する（CSS側がPC・畳んだ状態・検索前を
      // 自然に除外しているため、ここで改めてメディアクエリ等を再実装しない）。
      if (!closeBtn || closeBtn.offsetParent === null) return;
      const searchForm = document.getElementById('search-form');
      if (searchForm && searchForm.contains(e.target)) return;
      // 【56本目】検索カード（#layout-left）の中・ヘッダー・モーダルの中は対象外（「条件を変える」で開いた
      // 検索カードの「データ出典・免責」や、ヘッダーの使い方・2D/3D・マイリストを押しても閉じないように）。
      if (e.target.closest && e.target.closest('#layout-left, #app-header, .modal-overlay')) return;
      e.stopPropagation();
      e.preventDefault();
      this.closeFormDiscardingEdits();
    }, true);

    this.elements.mylistSortSelect?.addEventListener('change', () => this.renderMylist());

    // マイリスト本体のクリック委譲（開く／削除／共有）
    this.elements.mylistBody?.addEventListener('click', (e) => this.handleMylistClick(e));
    this.elements.sharedListBody?.addEventListener('click', (e) => this.handleMylistClick(e));
    this.elements.sharedListAddBtn?.addEventListener('click', () => this.addSharedListToMylist());
    this.elements.mylistShareAllBtn?.addEventListener('click', () => this.shareAllFavorites());

    // 全国の軽量駅一覧（起動時に一度だけfetch）の読み込みが終わるまで、
    // 入力欄のプレースホルダーで読み込み中であることを伝える（入力自体は
    // 最初から可能）。読み込み完了・失敗時にinitStationIndex()が元に戻す。
    this.elements.departureInput.placeholder = '駅の一覧を読み込んでいます…';

    // 【2026-10-25、56本目】地図を画面いっぱいに出す（layout-controller.js参照）。以前のPC二段組・スマホの
    // 一覧／地図タブと、地図の置き場所の付け替えはやめた。
    this.layoutController = new LayoutController({
      mapEl: document.getElementById('map-area'),
      layoutEl: this.elements.appLayout,
      mapView: this.mapView,
      terrainMapView: this.terrainMapView,
      onListTabActivated: () => this.scrollSelectedCardIntoView(),
    });

    // 2D/3D切替（4本目①「3D地図の土台」、feature/3d-mapブランチ）。
    // 失敗時（WebGL非対応・ライブラリ/タイル取得失敗）はエラー文言を出さず、
    // 2Dのまま据え置く（Minami指示）。出発駅が決まる前（検索前）は中心座標が
    // 無いため3Dを開始できない。起動時に前回3Dだった場合の自動復元は、
    // 最初の検索結果が出た直後（renderSearchResults）で行う。
    this.elements.mapDimensionToggle?.addEventListener('click', () => {
      this.closeHeaderMenu();
      this.toggleMapDimension();
    });
    this.updateDimensionToggleLabel();
    this.setupMapStageControls();
    this.showInitialMapView();
    // 【64本目】スマホで場所のカードを出しているとき、地図の何もないところを押したら元の小に戻す
    this.mapView.onBackgroundClick = () => this.onMapBackgroundClick();
    // 【2026-10-21、41本目、Minami決定】最初の見え方に戻るボタン（地図の右上、方位磁針の
    // すぐ下。2Dは右上）。検索した直後と同じ見え方（円が短辺の0.85（47本目）、3Dは傾き45°・向きは
    // 変えない）へなめらかに戻す。以前の「全体を見る」（寄っているときだけ出る文字ボタン）の
    // 役目を引き継ぎ、いつでも押せるようにした（一度も検索していないときは出さない）。
    this.elements.mapResetViewBtn?.addEventListener('click', () => {
      if (this.mapMode === '3d') this.terrainMapView?.returnToSearchView({ durationMs: RESET_VIEW_DURATION_MS });
      else this.mapView.returnToSearchView({ durationSec: RESET_VIEW_DURATION_MS / 1000 });
    });
    // 【4本目②】前回3Dを選んだ端末でだけ、ページの読み込みが落ち着いたあと
    // MapLibre一式を先読みする（2Dの人には一切先読みしない。Minami指示）。
    if (this.mapMode === '3d') preloadTerrainModuleWhenIdle();

    // イベントリスナー設定
    this.elements.searchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.performSearch();
    });

    this.elements.departureInput.addEventListener('input', (e) => {
      // 【2026-10-07修正】入力欄の文字が変わったら、選んでいた駅をいったん
      // 解除する。以前はここでdatasetをクリアしていなかったため、候補を
      // クリックして駅を選んだ後に文字だけ書き換えて検索すると、選択済みの
      // 古い駅（別の都道府県の駅のことすらある）のまま検索されてしまう
      // 不具合があった（Minamiさんが公開ページで発見）。候補クリック時は
      // この直後にdataset.prefCode/localIndexを改めて設定し直すため、
      // ここで一度クリアしても選択操作自体は壊れない。
      delete this.elements.departureInput.dataset.prefCode;
      delete this.elements.departureInput.dataset.localIndex;
      this.hideDepartureGuidance();
      this.showDepartureSuggestions(e.target.value);
      this.updateSearchButtonState();
    });

    // 【64本目、不具合修正】候補を選ばずにEnterを押すと「候補から出発駅を選んでください」になり候補一覧が閉じるが、
    // 入力欄にはフォーカスが残るため、押しても何も起きず、一度文字を消さないと候補が出なかった。入力欄を押したとき
    // （フォーカスしたとき、すでにフォーカスがあるときはクリック）に、入っている文字で候補をすぐ出す。
    const reopenSuggestions = () => {
      if (this.elements.departureSuggestions.innerHTML) return;
      this.showDepartureSuggestions(this.elements.departureInput.value);
    };
    this.elements.departureInput.addEventListener('focus', reopenSuggestions);
    this.elements.departureInput.addEventListener('click', reopenSuggestions);

    // 【56本目】候補一覧の外（入力欄・候補一覧以外）を押したら、候補一覧を閉じる。スマホでは候補一覧が入力欄の
    // 上に開き、検索カードの「▲閉じる」などに重なることがあるため、外を押せば閉じられるようにする。
    document.addEventListener('click', (e) => {
      if (!this.elements.departureSuggestions.innerHTML) return;
      if (e.target === this.elements.departureInput) return;
      if (this.elements.departureSuggestions.contains(e.target)) return;
      this.elements.departureSuggestions.innerHTML = '';
    });

    // position:fixedの候補一覧は画面リサイズ（スマホの回転等）に追従しないため、
    // 表示中であれば位置を再計算する
    window.addEventListener('resize', () => {
      if (this.elements.departureSuggestions.innerHTML !== '') {
        this.positionDepartureSuggestions();
      }
    });

    this.elements.budgetDecrement.addEventListener('click', () => {
      this.stepBudget(-100);
    });

    this.elements.budgetIncrement.addEventListener('click', () => {
      this.stepBudget(100);
    });

    // 予算スライダー（4本目③、2026-10-13 10本目①で変更）。'input'はドラッグ中に
    // 連続発火＝到達範囲の円だけ広げる（Minami決定：A。点・カメラは「この条件で
    // 検索」を押すまで変えない）。指を離したとき（change）に別途行うことは
    // 無くなったため、changeのリスナーは廃止した。
    this.elements.budgetSlider.addEventListener('input', () => {
      const value = parseInt(this.elements.budgetSlider.value, 10);
      this.elements.budgetInput.value = value;
      this.updateBudgetUI();
      this.updateMapBudgetLive(value);
    });

    // 【2026-10-13、22本目、Minami決定：B】スマホの検索後は、予算の操作を
    // 地図の下に重ねた帯（#mobile-budget-overlay）で行う。±・スライダーとも
    // PC版と同じ#budget-inputを更新するだけで、以降の表示反映は
    // updateBudgetUI()に一本化する（二重に状態を持たない）。
    this.elements.mobileBudgetDecrement?.addEventListener('click', () => {
      this.stepBudget(-100);
    });
    this.elements.mobileBudgetIncrement?.addEventListener('click', () => {
      this.stepBudget(100);
    });
    this.elements.mobileBudgetSlider?.addEventListener('input', () => {
      const value = parseInt(this.elements.mobileBudgetSlider.value, 10);
      this.elements.budgetInput.value = value;
      this.updateBudgetUI();
      this.updateMapBudgetLive(value);
    });
    this.updateBudgetUI();

    // 【2026-10-10追記】スマホ本体の戻る操作（ジェスチャー・物理ボタン）の
    // 画面切り替えはpopstateハンドラ（goBackInDetail()）に一本化する。
    // 共有リンクのURLパラメータと干渉しないよう、pushState/replaceStateは
    // URLを変えず（第3引数を省略）状態オブジェクトだけを積む。
    window.addEventListener('popstate', () => {
      this.goBackInDetail();
    });

    // 【2026-10-11、6本目E】「見てきた場所」の足あと（旧「← 一覧に戻る」
    // ボタンを置き換え）。クリック委譲：「一覧」またはそれより前の場所を
    // 押すと、そこまで一気に戻る（今いる場所・ボタンでない「…」は
    // data-history-indexを持たない）。
    this.elements.detailBreadcrumb.addEventListener('click', (e) => {
      const ellipsisBtn = e.target.closest('.breadcrumb-ellipsis');
      if (ellipsisBtn) {
        this.elements.detailBreadcrumb.querySelector('.breadcrumb-trail')?.classList.add('breadcrumb-expanded');
        return;
      }
      const btn = e.target.closest('[data-history-index]');
      if (!btn) return;
      const index = parseInt(btn.getAttribute('data-history-index'), 10);
      this.goToBreadcrumb(index);
    });

    this.elements.sortSelect.addEventListener('change', (e) => {
      this.currentSortOrder = e.target.value;
      // 並び替えはリストの表示順のみ変更する。表示対象スポットの集合は
      // 変わらないため地図（ピン）は再描画しない。
      this.renderResultsList();
    });

    // 結果カードのクリック／ホバーを一覧全体で委譲し、地図のピンと連動させる。
    // 一覧は並び替えのたびに再描画されるため、個々のカードにリスナーを
    // 付け直す必要がないよう、常に存在する親要素に1度だけ登録する。
    // カードのどこをクリックしても詳細画面へ遷移する（「詳細を見る」ボタンは
    // 視覚的な手がかりとして残しつつ、クリック判定はカード全体に拡大）。
    // 一覧からの「選択」操作は行わない（選択状態は地図のピンクリック起点のみ）
    this.elements.resultsList.addEventListener('click', (e) => {
      // 検索失敗時の「もう一度試す」は、予算を変えずそのまま同じ条件で再検索する。
      // 【67本目】0件のときの「往復¥Xで探す」ボタンはやめた（buildNoResultsMessage()参照）。
      if (e.target.closest('.search-retry-btn')) {
        this.performSearch();
        return;
      }
      // カード右上の☆（お気に入り）・共有ボタンは、カード全体のクリック
      // （詳細画面へ遷移）より先に判定して処理を止める（巻き込み防止）。
      const favBtn = e.target.closest('.favorite-btn');
      if (favBtn) {
        const spot = this.currentSpots.find((s) => s.id === favBtn.getAttribute('data-spot-id'));
        if (spot) {
          const saved = this.toggleFavoriteForSpot(spot);
          this.showToast(saved ? 'マイリストに保存しました' : 'マイリストから外しました');
        }
        return;
      }
      const shareBtn = e.target.closest('.share-btn');
      if (shareBtn) {
        const spot = this.currentSpots.find((s) => s.id === shareBtn.getAttribute('data-spot-id'));
        if (spot) this.shareSpot(spot);
        return;
      }
      const card = e.target.closest('.spot-card');
      if (card) {
        this.openSpotDetailById(card.getAttribute('data-spot-id'));
      }
    });

    this.elements.resultsList.addEventListener('mouseover', (e) => {
      const card = e.target.closest('.spot-card');
      if (card) this.mapView.highlightSpot(card.getAttribute('data-spot-id'));
    });

    this.elements.resultsList.addEventListener('mouseout', (e) => {
      const card = e.target.closest('.spot-card');
      if (card && !card.contains(e.relatedTarget)) {
        this.mapView.unhighlightSpot(card.getAttribute('data-spot-id'));
      }
    });
  }

  /**
   * フッター・ヘッダーのボタンから開く軽量モーダル（出典・免責・問い合わせ／使い方／
   * マイリスト／共有されたリスト）共通の開閉ロジック。hidden属性で表示/非表示を
   * 切り替える（[hidden]{display:none!important}）。
   * triggerBtnがnullの場合（共有されたリストのように、URLパラメータ経由でのみ
   * 開くモーダル）は、openModal()を別途呼び出すためのclose/Escape処理だけ登録する。
   * onOpenを渡すと、開くたびに呼ばれる（マイリストの内容を毎回最新化するため）。
   */
  initModal(triggerBtn, modal, closeBtn, { onOpen } = {}) {
    if (!modal) return;

    const open = () => {
      modal.hidden = false;
      onOpen?.();
    };
    const close = () => {
      modal.hidden = true;
    };
    modal._open = open; // 他のメソッドからプログラム的に開くため

    triggerBtn?.addEventListener('click', open);
    closeBtn?.addEventListener('click', close);
    // オーバーレイ背景クリックで閉じる（パネル内クリックは伝播で除外）
    modal.addEventListener('click', (e) => {
      if (e.target === modal) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) close();
    });
  }

  /**
   * フィード出典一覧（#about-feed-list）を、ビルド時生成の
   * docs/data/national/data-sources.json（generate-site-data.jsの
   * generateNationalDataSources()参照）から描画する。ここに固定文言を
   * ハードコードしない。実際に使ったフィードの情報だけをそのまま表示することで、
   * 表示内容と実データの食い違いを構造的に防ぐ。
   *
   * 【2026-10-02】県ごとにデータを分割した段階1(c)により、ページ起動直後
   * （＝まだどの県のデータもロードしていない状態）でも出典画面を開ける必要がある。
   * 「今ロード済みの県」のdata-sources.jsonではなく、全県分を統合した
   * 全国版（generateNationalDataSources()が事業者IDで重複排除して生成）を
   * 常に表示する。
   */
  renderDataSources() {
    fetch('data/national/data-sources.json')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => this.populateDataSources(data))
      .catch((error) => {
        console.error('データ出典マニフェストの取得に失敗:', error);
        this.populateDataSources(null);
      });
  }

  populateDataSources(manifest) {
    const listEl = document.getElementById('about-feed-list');
    const summaryEl = document.getElementById('about-feed-summary');
    const footerEl = document.getElementById('footer-data-sources');
    const coverageEl = document.getElementById('howto-coverage');
    const excludedWrapEl = document.getElementById('about-excluded-feeds');
    const excludedListEl = document.getElementById('about-excluded-feed-list');
    const buildTimeListEl = document.getElementById('about-build-time-data-list');

    // GTFSフィード以外に「ビルド時にのみ使用したデータ」（例：国土数値情報N03、
    // 同名駅の市区町村判定に使用。検索結果には一切含まれない）があれば表示する。
    // 以前はindex.htmlに出典を手書きしていたが、出典はハードコードせずマニフェストから
    // 出すという方針（#about-feed-listと同じ考え方）に合わせた。
    if (buildTimeListEl) {
      const buildTimeSources = manifest?.build_time_data_sources;
      if (Array.isArray(buildTimeSources) && buildTimeSources.length > 0) {
        buildTimeListEl.innerHTML = buildTimeSources
          .map((src) => {
            const datasetLink = src.dataset_url
              ? `<a href="${src.dataset_url}" target="_blank" rel="noopener">${src.dataset_name}</a>`
              : src.dataset_name;
            const licenseText = src.license_url
              ? `<a href="${src.license_url}" target="_blank" rel="noopener">${src.license_label}</a>`
              : src.license_label;
            return `
              <li>
                <strong>${src.provider_name} ${datasetLink}</strong>（${src.category_label}）
                <span class="feed-meta">${src.usage_note || ''}</span>
                <span class="feed-meta">ライセンス：${licenseText}</span>
              </li>
            `;
          })
          .join('');
      } else {
        buildTimeListEl.innerHTML = '';
      }
    }

    // 検索対象から除外したフィード（運賃データなし・ライセンス非許可等）があれば、
    // 「対象外としたデータ」として理由ごと表示する。例：富山地方鉄道市内電車は
    // 運賃データが公開されていないため対象外（運賃を手で書き足して含めることはしない）。
    const excludedFeeds = manifest?.excluded_feeds;
    if (excludedWrapEl && excludedListEl) {
      if (Array.isArray(excludedFeeds) && excludedFeeds.length > 0) {
        excludedWrapEl.hidden = false;
        excludedListEl.innerHTML = excludedFeeds
          .map((f) => `<li><strong>${f.operator_name}</strong>：${f.reason}のため、検索の対象外</li>`)
          .join('');
      } else {
        excludedWrapEl.hidden = true;
        excludedListEl.innerHTML = '';
      }
    }

    // 対応地域（使い方モーダル）はフィード一覧と独立した項目のため、
    // フィードが読めなかった場合でも可能な限り描画する。
    if (coverageEl) {
      const prefectures = manifest?.coverage?.prefectures;
      coverageEl.textContent =
        Array.isArray(prefectures) && prefectures.length > 0
          ? `出発地に選べるのは${prefectures.join('・')}の駅・停留所です。行き先は県外になることもあります。対応している路線は「データ出典・免責」で確認できます。`
          : '対応地域の情報を取得できませんでした。';
    }

    const feeds = manifest?.feeds;
    if (!Array.isArray(feeds) || feeds.length === 0) {
      if (summaryEl) summaryEl.textContent = '';
      if (listEl) listEl.innerHTML = '<li>出典情報を読み込めませんでした。時間をおいて、もう一度お試しください。</li>';
      if (footerEl) footerEl.textContent = '出典情報を取得できませんでした';
      return;
    }

    if (footerEl) footerEl.textContent = formatPublisherList(feeds);
    if (!listEl || !summaryEl) return;

    summaryEl.textContent = `現在このアプリが使用しているフィードは${feeds.length}件です。`;

    listEl.innerHTML = feeds
      .map((feed) => {
        const publisher = feed.feed_publisher_name || feed.operator_name;
        const period =
          feed.feed_start_date && feed.feed_end_date
            ? `${formatGtfsDate(feed.feed_start_date)}〜${formatGtfsDate(feed.feed_end_date)}`
            : '不明';
        const fetchedAt = feed.fetched_at
          ? new Date(feed.fetched_at).toLocaleDateString('ja-JP')
          : '不明';
        const publisherLink = feed.feed_publisher_url
          ? `<a href="${feed.feed_publisher_url}" target="_blank" rel="noopener">${feed.feed_publisher_url}</a>`
          : '不明';
        const licenseText = feed.license_url
          ? `<a href="${feed.license_url}" target="_blank" rel="noopener">${feed.license_label}</a>`
          : feed.license_label;

        // 【2026-10-13、19本目修正】版名から日付が取れないフィード（例：万葉線
        // 「20260825_01」）は、formatFeedVersionShort()がnullを返す。その場合は
        // 「フィード版」の項目自体を出さず「対象期間」だけにする（期間で代わりに
        // 表示すると同じ期間が2回並んで出ていたため）。
        const feedVersionShort = formatFeedVersionShort(feed.feed_version);
        const feedVersionLine = feedVersionShort ? `フィード版：${feedVersionShort} ／ ` : '';

        return `
          <li>
            <strong>${publisher}</strong>（${feed.source_category_label}）
            <span class="feed-meta">公開元サイト：${publisherLink}</span>
            <span class="feed-meta">${feedVersionLine}対象期間：${period}</span>
            <span class="feed-meta">取得日：${fetchedAt} ／ ライセンス：${licenseText}</span>
          </li>
        `;
      })
      .join('');
  }

  stepBudget(delta) {
    const input = this.elements.budgetInput;
    const min = parseInt(input.min, 10);
    const max = parseInt(input.max, 10);
    const next = parseInt(input.value, 10) + delta;

    if (next < min || next > max) {
      return;
    }

    input.value = next;
    this.updateBudgetUI();
    // 【2026-10-13、10本目①、Minami決定：A】±ボタンもスライダーと同じく
    // 円だけを広げる。点・カメラは「この条件で検索」を押すまで変えない
    // （Minami指示：点がすぐ変わると検索ボタンを押す動機が薄れるため）。
    this.updateMapBudgetLive(next);
  }

  updateBudgetUI() {
    const input = this.elements.budgetInput;
    const min = parseInt(input.min, 10);
    const max = parseInt(input.max, 10);
    const value = parseInt(input.value, 10);

    this.elements.budgetDisplay.textContent = `¥${value}`;
    this.elements.budgetSlider.value = value; // ±ボタン・共有リンク復元等どの経路で変わっても表示を揃える
    this.elements.budgetDecrement.disabled = value <= min;
    this.elements.budgetIncrement.disabled = value >= max;
    // 【2026-10-13、22本目】スマホの地図下の予算操作帯も、#budget-inputを
    // 正としてここで揃える（どちらの操作（PC欄・スマホ帯）で変えても同期する）。
    if (this.elements.mobileBudgetSlider) this.elements.mobileBudgetSlider.value = value;
    if (this.elements.mobileBudgetDecrement) this.elements.mobileBudgetDecrement.disabled = value <= min;
    if (this.elements.mobileBudgetIncrement) this.elements.mobileBudgetIncrement.disabled = value >= max;
    this.updateMobileBudgetOverlay(value);
    this.updateSearchButtonState();
  }

  /**
   * 結果画面の＋−の間の金額（今の金額）。
   * 【2026-10-26、59本目、Minami決定】以前はここで「¥800・16件・最大7.7km」「¥900で探す」のボタン
   * （#mobile-budget-search-btn、22本目・25本目）の文言を出し分けていたが、結果画面では＋−を押すと一覧も
   * 一緒に変わるようにした（syncListToBudget()）ため、ボタンごとやめた（PC・スマホ共通）。
   */
  updateMobileBudgetOverlay(budget) {
    if (this.elements.resultsBudgetValue) this.elements.resultsBudgetValue.textContent = `¥${formatThousands(budget)}`;
  }

  /**
   * 【2026-10-26、59本目、Minami決定】結果画面で＋−を押したら、一覧（見出しの金額帯・カード）も今の金額に
   * 合わせる（地図・「◯か所」「NEW +N」と一緒に変わる。押すボタンは＋−だけ）。検索し直しはしない（地図の
   * 合わせ方・＋の波・ピンの色は今までの＋−の決まりのまま。ピンの色の「検索した金額」も変えない）。
   * ¥2,000分の裏取得が終わるまでは検索した金額の帯の場所しか持っていないため、終わってから合わせる
   * （裏取得の反映でupdateMapBudgetLive()が呼ばれ直す）。
   * 一覧が今の金額を出しているので、「この条件で探す」の比べる相手（lastSearchedBudget）もこの金額にする
   * （「条件を変える」で開いたとき「条件が変わりました」と出さない・「▲閉じる」でこの金額に戻す）。
   * @param {number} budget
   */
  syncListToBudget(budget) {
    const layout = this.elements.appLayout;
    if (!layout.classList.contains('has-results') || !layout.classList.contains('form-collapsed')) return;
    if (this.listBudget === null || budget === this.listBudget) return;
    if (this._allSpotsStationId === null || this._allSpotsStationId !== this.currentDepartureStationId) return;
    const { bandSpots } = this.filterBandFromAllSpots(this.currentAllSpots, budget);
    this.listBudget = budget;
    this.currentSpots = bandSpots;
    this.lastSearchedBudget = budget;
    if (this.elements.bandHeading) this.elements.bandHeading.innerHTML = bandHeadingHtml(budget, bandSpots.length);
    this.renderResultsList();
    this.updateSearchButtonState();
  }

  /**
   * 予算スライダー・±ボタンの1コマ分  /**
   * 予算スライダー・±ボタンの1コマ分（4本目③、2026-10-13 10本目①で全面変更）。
   * 【10本目、Minami決定：A】地図の点（光る点・薄い点）は変えない。点は、
   * 最後に検索したときの状態のまま。代わりに、出発駅を中心にした到達範囲の円
   * だけを広げる・縮める（2D・3D共通）。帯の件数プレビューはこれまでどおり
   * 動かしながら変えてよい（検索の目安になるため、Minami指示）。
   * 【2026-10-21、43本目、Minami決定：C】上の「点は変えない」を見直し、地図のピンは
   * その場で新しい金額帯に合わせて入れ替える（金額帯に入ったまま＝青・新しく入った＝
   * オレンジ・金額帯より安くなった＝灰色・予算をこえる＝出さない。map-view.js・
   * terrain-map-view.jsのpinCategory()）。円が同じ大きさの区間（例：大池の¥1,100〜¥1,500）
   * でも、ピンの色が変わることで変化が見えるようにするため。一覧（カード）は今までどおり
   * 「¥◯で探す」「この条件で検索」を押したときに更新し、そのときオレンジは青になる。
   * 金額を検索した金額に戻すと、ピンも検索した直後と同じ状態に戻る。
   * 【49本目、Minami決定】灰色はやめ、紺とオレンジの2色にした（決まりはmap-view.jsのpinCategory()）。
   * 検索し直したときも、直前の検索から新しく増えた場所はオレンジのまま残る。
   * まだ検索していない（this.currentAllSpotsが空）ときは円・件数プレビューとも出さない。
   * 【2026-10-15、11本目②、Minami決定：C】実際にユーザーが予算を触った
   * （userTouch:true、既定）ときだけ、情報枠を閉じる・寄っていれば全体に戻す。
   * scheduleMaxBudgetPrefetch()の裏取得はこのメソッドを円・件数更新だけの目的で
   * 呼ぶため、userTouch:falseを渡してユーザー操作と誤認しないようにする。
   * @param {number} budget
   * @param {{userTouch?: boolean}} [opts]
   */
  updateMapBudgetLive(budget, { userTouch = true } = {}) {
    if (userTouch) {
      this.clearPinSelection();
    }
    // 【37本目、Minami決定：B2／41本目で変更】ユーザーが金額を上げたときだけ、出発駅
    // （円の中心）から新しい縁へ波を1本出す。41本目から、円が広がらなかった（半径が
    // 同じ）ときも出す（「ここまで届く」を見せるため）。下げたとき・裏取得による更新
    // では出さない。上げたかどうかは、直前にこのメソッドへ渡された金額と比べる。
    const raised = userTouch && this._liveMapBudget != null && budget > this._liveMapBudget;
    this._liveMapBudget = budget;
    // 【43本目C】ピンを今の金額に合わせて塗り直す（裏取得・フォームを閉じて元に戻すときも同じ）。
    // 【48本目、Minami決定：2】上げたとき（波を出すときと同じ判断）は、新しく増えたオレンジを波に合わせて「ぽん」と出す。
    this.mapView.setLiveBudget(budget, { pop: raised });
    this.terrainMapView?.setLiveBudget(budget, { pop: raised });
    this.updateNewSpotMarks(budget);
    this.mapView.updateReachCircle(budget, { style: 'live' });
    this.terrainMapView?.updateReachCircle(budget, { style: 'live' });
    if (userTouch) {
      // 【2026-10-17、32本目B、Minami決定】今までの「予算を触ったら全体表示（fitToBudget）に戻る」
      // （returnToOverview()）は、円全体が収まる大きさへ合わせる動きに置き換えた。
      // 【2026-10-27、64本目、Minami決定】待たずに（0.15秒の待ち・0.95／0.35の決まりはやめた）、押したらすぐ
      // 円の半径を変え、地図を「いっぱい」に合わせる。＋のときだけ、合わせ終わってから波とぽよんを出す。
      this.mapView.fitAfterBudgetChange({ raised });
      this.terrainMapView?.fitAfterBudgetChange({ raised });
    }
    // 【59本目】結果画面では一覧も一緒に今の金額に合わせる
    this.syncListToBudget(budget);
    if (!this.currentAllSpots || this.currentAllSpots.length === 0) {
      this.elements.budgetBandPreview.hidden = true;
      return;
    }
    const { bandSpots } = this.filterBandFromAllSpots(this.currentAllSpots, budget);
    this.updateBudgetBandPreview(budget, bandSpots.length);
  }

  /**
   * 【2026-10-24、51本目、Minami決定】紺のピンを「みちどころ」、オレンジのピンを「NEW」と呼ぶ。
   * 地図の色の説明の横に、今オレンジで出ている場所の数を「NEW +8」の形で出す（0のときは出さない）。
   * 一覧のカードにも、地図でオレンジになっている場所には「NEW」の印を付ける（地図の色と同じ決まり：
   * map-view.jsのpinCategory()。金額を＋−するたびに、地図のピンと一緒に入れ替わる）。
   * @param {number} liveBudget 今の金額（＋−・スライダーで変えた値）
   */
  updateNewSpotMarks(liveBudget) {
    // 【61本目】地図に今渡している場所で数える（裏取得の結果は、地図に渡すまで数に入れない。scheduleMaxBudgetPrefetch()）
    const spots = this._mapSpots || this.currentAllSpots || [];
    const searched = this.currentBudget;
    const prev = this._mapPrevSearchedBudget ?? searched;
    const isNew = (spot) => pinCategory(spot.source_round_trip_fare, liveBudget, searched, prev) === 'orange';
    const newCount = spots.filter((s) => isFiniteNumber(s.latitude) && isFiniteNumber(s.longitude) && isNew(s)).length;
    const tag = this.elements.mapNewCount;
    if (tag) {
      tag.textContent = `NEW +${newCount}`;
      tag.hidden = newCount === 0;
    }
    // 【58本目】PCの一覧パネル・細いバーの「42か所」（今地図に出ている場所＝今の金額までの場所）と「NEW +8」
    if (this.elements.resultsMapCount) {
      const shown = spots.filter((s) => isFiniteNumber(s.latitude) && isFiniteNumber(s.longitude) && s.source_round_trip_fare <= liveBudget).length;
      this.elements.resultsMapCount.textContent = `${shown}か所`;
    }
    if (this.elements.resultsNewCount) {
      this.elements.resultsNewCount.textContent = `NEW +${newCount}`;
      this.elements.resultsNewCount.hidden = newCount === 0;
    }
    const spotById = new Map(spots.map((s) => [s.id, s]));
    this.elements.resultsList.querySelectorAll('.spot-card').forEach((card) => {
      const spot = spotById.get(card.getAttribute('data-spot-id'));
      const mark = card.querySelector('.spot-card-new');
      if (mark) mark.hidden = !(spot && isNew(spot));
    });
  }

  updateBudgetBandPreview(budget, count) {
    const el = this.elements.budgetBandPreview;
    if (!el) return;
    if (!this.currentAllSpots || this.currentAllSpots.length === 0) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    // 【2026-10-14、25本目、Minami決定：B】地図上の「最大◯km先まで」ラベルを
    // 廃止した代わりに、PCのこのプレビュー文言の末尾に出す。スライダーに
    // 合わせて変わる（呼び出し元のupdateMapBudgetLive()がスライダー操作の
    // たびに呼ぶため）。
    const radiusKm = this.mapView.computeReachRadiusKm(budget);
    el.textContent = `往復¥${formatThousands(budget - BAND_WIDTH + 1)}〜¥${formatThousands(budget)}で行ける場所 ${count}件・最大${formatReachRadiusKm(radiusKm)}先まで`;
  }

  /**
   * 検索ボタンの見た目を「現在の入力が直近の検索条件と同じか」で切り替える。
   * 予算を変えても検索ボタンを押すまでは前回の結果・見出しが残り続け、
   * 画面の予算欄と結果の帯がずれて見える不具合があったため
   * （2026-10-07、Minamiさんが公開ページで発見）。自動再検索にはせず
   * （＋／−連打のたびに検索が重なって遅くなるのを避けるMinamiさんの判断）、
   * ボタンの色と文言だけで「まだこの条件で検索していない」ことを知らせる。
   */
  updateSearchButtonState() {
    const btn = this.elements.searchBtn;
    if (this.lastSearchedBudget === null) {
      // まだ一度も検索していない＝比較対象がないため、常に既定の表示にする
      btn.classList.remove('search-btn-pending');
      btn.textContent = SEARCH_BUTTON_LABEL;
      if (this.elements.searchPendingNote) this.elements.searchPendingNote.hidden = true;
      return;
    }
    const currentText = this.elements.departureInput.value;
    const currentBudget = parseInt(this.elements.budgetInput.value, 10);
    const changed = currentText !== this.lastSearchedDepartureText || currentBudget !== this.lastSearchedBudget;
    // 【56本目】文言は見本どおりいつも「この条件で探す」。まだこの条件で検索していないことは色（.search-btn-pending）で伝える。
    // 【57本目、Minami指示】色だけで伝えないよう、ボタンのすぐ上に「条件が変わりました」の小さな文字も出す（検索すると消える）。
    btn.classList.toggle('search-btn-pending', changed);
    btn.textContent = SEARCH_BUTTON_LABEL;
    if (this.elements.searchPendingNote) this.elements.searchPendingNote.hidden = !changed;
  }

  /**
   * 起動時に一度だけ、全国の軽量駅一覧（docs/data/national/station-index.json）を
   * ロードする。出発駅のオートコンプリートはこれだけで動く。県ごとのフルデータ
   * （運賃・経路・スポット等）は、出発駅が決まってからperformSearch()内で
   * ロードする（loadPrefecturesForDeparture参照）。
   */
  async initStationIndex() {
    try {
      await this.loader.loadStationIndex();
      this.elements.departureInput.placeholder = '駅名を入力...';
      // 読み込み中に何か入力されていた場合、今ロードされた駅一覧で候補を
      // 出し直す（入力時点ではthis.loader.stationIndexがまだnullで
      // 候補が出ていなかったため）。
      this.showDepartureSuggestions(this.elements.departureInput.value);
    } catch (error) {
      console.error('❌ 駅一覧ロード失敗:', error);
      this.dataLoadFailed = true;
      this.elements.departureInput.placeholder = '駅名を入力...';
      // #results-container は検索前は非表示のままなので、エラー表示自体を
      // 隠さないよう明示的に表示状態へ切り替える
      this.elements.appLayout.classList.add('has-results');
      this.elements.resultsList.innerHTML =
        '<p class="error">データの読み込みに失敗しました。ページを再読み込みしてください。</p>';
    }
  }

  /**
   * 出発駅の都道府県＋隣接都道府県のフルデータをロードし、FareCalculator等を
   * 作り直す。既にロード済みの県はGTFSLoader側でスキップされるため、
   * 同じ県からの再検索では実質何もフェッチしない。
   *
   * 隣接県表（prefectureAdjacency）は47都道府県すべてを網羅した地理的事実の表で、
   * 公開状況とは無関係。公開していない隣接県まで律儀にfetchすると、ほぼ確実に
   * 404になるだけの無駄なリクエストが毎回走るため、公開中都道府県一覧
   * （publishedPrefectures、generate-site-data.jsが生成）で絞り込む。
   */
  async loadPrefecturesForDeparture(prefCode) {
    const allAdjacent = this.loader.prefectureAdjacency?.[String(prefCode).padStart(2, '0')] || [];
    const published = new Set(this.loader.publishedPrefectures || []);
    const adjacent = allAdjacent.filter((code) => published.has(code));
    this.data = await this.loader.loadPrefectures([prefCode, ...adjacent]);
    this.fareCalc = new FareCalculator(this.data);
    this.spotFinder = new SpotFinder(this.data);
    this.routeFormatter = new RouteFormatter(this.data.routeInfo, this.data.routeDetails, this.data.stations, this.data.stopsMetadata);
  }

  showDepartureSuggestions(input) {
    if (!input || !this.loader.stationIndex) {
      this.elements.departureSuggestions.innerHTML = '';
      return;
    }

    // station-index.jsonは[表示名, 県コード, 県内通し番号]の軽量配列（駅ID・座標は
    // 持たない）。県コード・通し番号はデータ属性に積んでおき、検索実行時
    // （performSearch）に該当県のフルデータをロードしてから実際のstation_idへ解決する。
    const lower = input.toLowerCase();
    const filtered = this.loader.stationIndex
      .filter((entry) => entry[0].toLowerCase().includes(lower))
      .slice(0, 10);

    const html = filtered
      .map(([name, prefCode, localIndex]) =>
        `<div class="suggestion-item" data-pref-code="${prefCode}" data-local-index="${localIndex}" data-station-name="${name}">${name}</div>`
      )
      .join('');

    this.elements.departureSuggestions.innerHTML = html;
    this.positionDepartureSuggestions();

    // クリックリスナー
    this.elements.departureSuggestions.querySelectorAll('.suggestion-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const prefCode = e.target.getAttribute('data-pref-code');
        const localIndex = e.target.getAttribute('data-local-index');
        const stationName = e.target.getAttribute('data-station-name');
        this.elements.departureInput.value = stationName;
        this.elements.departureInput.dataset.prefCode = prefCode;
        this.elements.departureInput.dataset.localIndex = localIndex;
        delete this.elements.departureInput.dataset.stationId;
        this.elements.departureSuggestions.innerHTML = '';
        this.hideDepartureGuidance();
        this.updateSearchButtonState();
      });
    });
  }

  /**
   * #departure-suggestions（position:fixed）を入力欄の直下・同じ幅に配置する。
   * .layout-left（overflow-y:auto）の内側にposition:absoluteで置くと祖先の
   * overflowに切り詰められるため、fixedにした上でJSで毎回位置を計算し直す
   * 必要がある（CSS側のコメント参照）。
   */
  positionDepartureSuggestions() {
    const rect = this.elements.departureInput.getBoundingClientRect();
    const box = this.elements.departureSuggestions;
    box.style.left = `${rect.left}px`;
    box.style.width = `${rect.width}px`;
    // 【56本目】スマホでは検索カードが画面の下にあり、入力欄の下に候補を出すと画面の外にはみ出す。
    // 下に十分な余地が無く、上のほうが広いときは、入力欄の上に出す。
    const below = window.innerHeight - rect.bottom - 8;
    // 上に出すときは、ヘッダーの下まで（ヘッダーは検索カードより上に描くため、重なると候補が隠れる）
    const ceiling = this.elements.appHeader ? this.elements.appHeader.getBoundingClientRect().bottom : 0;
    const above = rect.top - ceiling - 8;
    // 候補の箱（最大300px）が下に収まらず、上のほうが広いときは上に出す。
    if (below < 300 && above > below) {
      box.style.top = 'auto';
      box.style.bottom = `${window.innerHeight - rect.top}px`;
      box.style.maxHeight = `${Math.min(300, above)}px`;
    } else {
      box.style.bottom = 'auto';
      box.style.top = `${rect.bottom}px`;
      box.style.maxHeight = `${Math.min(300, Math.max(120, below))}px`;
    }
  }

  showDepartureGuidance(message) {
    if (!this.elements.departureGuidance) return;
    this.elements.departureGuidance.textContent = message;
    this.elements.departureGuidance.hidden = false;
  }

  hideDepartureGuidance() {
    if (!this.elements.departureGuidance) return;
    this.elements.departureGuidance.hidden = true;
  }

  // ========================================
  // お気に入り（マイリスト）・共有
  // ========================================

  /** ヘッダーの「☆ マイリスト」件数バッジを更新する。0件でも表示する。 */
  updateMylistCount() {
    if (!this.elements.mylistCount) return;
    this.elements.mylistCount.textContent = String(loadFavorites().length);
  }

  /**
   * カード・詳細画面共通の☆トグル処理。スポットオブジェクト（source_*を持つ、
   * 検索結果またはopenSharedSpotForStation()で解決した1件）から保存項目を組み立てる。
   */
  toggleFavoriteForSpot(spot) {
    const entry = {
      qid: spot.id,
      name: spot.name,
      prefCode: String(this.currentDeparturePrefCode || ''),
      departureStationId: this.currentDepartureStationId || '',
      departureName: this.currentDepartureStationName || '',
      roundTripFare: spot.source_round_trip_fare,
      durationMin: typeof spot.source_ride_duration_min === 'number' ? spot.source_ride_duration_min : null,
      savedAt: new Date().toISOString(),
    };
    const saved = toggleFavorite(entry);
    this.updateMylistCount();
    this.refreshFavoriteButtons();
    return saved;
  }

  /**
   * 画面上の☆ボタンの見た目（押下状態）を、localStorageの現在値に合わせて一括更新する。
   * 「削除」という語は、マイリスト画面の×ボタンだけに使う（Minamiさんの指示）ため、
   * ここではaria-label・トースト・詳細画面の文言のいずれも「外す」を使う。
   * 詳細画面のボタン（.detail-favorite-btn）はアイコン＋文言（「マイリストに保存」/
   * 「保存済み」）を表示するため、ここでアイコン・文言の両方を更新する。
   * カード側はアイコンとaria-labelのみ更新する（文言表示が無いため）。
   */
  refreshFavoriteButtons() {
    document.querySelectorAll('.favorite-btn').forEach((btn) => {
      const qid = btn.getAttribute('data-spot-id');
      const active = isFavorite(qid);
      btn.classList.toggle('favorite-btn-active', active);
      btn.setAttribute('aria-pressed', String(active));
      btn.setAttribute('aria-label', active ? 'マイリストから外す' : 'マイリストに保存');

      const iconEl = btn.querySelector('.icon-star');
      if (iconEl) {
        iconEl.classList.toggle('icon-star-filled', active);
        iconEl.innerHTML = active ? STAR_FILLED_SVG : STAR_OUTLINE_SVG;
      }
      const labelEl = btn.querySelector('.btn-label');
      if (labelEl) {
        labelEl.textContent = active ? '保存済み' : 'マイリストに保存';
      }
    });
  }

  /** 景勝地1件を共有する（navigator.shareかクリップボードコピー、結果をトーストで知らせる） */
  async shareSpot(spot) {
    if (!this.currentDeparturePrefCode || !this.currentDepartureStationId) return;
    const url = buildSpotShareUrl(location.href, {
      qid: spot.id,
      prefCode: this.currentDeparturePrefCode,
      stationId: this.currentDepartureStationId,
      departureName: this.currentDepartureStationName,
    });
    const freqInfo = this.buildFrequencyDisplay(spot);
    const frequencyText = freqInfo ? `${freqInfo.dayLabel}1日${freqInfo.tripCount}便の${freqInfo.word}です。` : null;
    const text = buildSpotShareText(
      spot.name,
      this.currentDepartureStationName,
      spot.source_round_trip_fare,
      typeof spot.source_ride_duration_min === 'number' ? spot.source_ride_duration_min : null,
      url,
      spot.municipality,
      frequencyText
    );
    const result = await shareOrCopy(text, url);
    if (result === 'copied') this.showToast('コピーしました');
    else if (result === 'failed') this.showToast('共有できませんでした');
  }

  /** マイリストの内容を1本のURLで共有する（先頭20件まで。超過分は含めない）。 */
  async shareAllFavorites() {
    const favorites = loadFavorites();
    if (favorites.length === 0) return;
    const items = favorites.map((f) => ({ qid: f.qid, prefCode: f.prefCode, stationId: f.departureStationId }));
    const url = buildListShareUrl(location.href, items);
    const text = `マイリスト（${Math.min(favorites.length, 20)}件）／${url}`;
    const result = await shareOrCopy(text, url);
    if (result === 'copied') this.showToast('コピーしました');
    else if (result === 'failed') this.showToast('共有できませんでした');
  }

  /**
   * 共有結果等の軽量な通知を表示する。
   * 【2026-10-09修正】固定のbottom値（1rem）だと、フッター（出典・免責表示）の
   * 実際の高さがスマホ幅の折り返し等で変わったときに重なってしまっていた
   * （Minamiさんがスクリーンショットで発見）。フッターの実際の高さを毎回
   * 測り直し、その上に出す（フッターが見つからない場合は安全マージンのみ）。
   */
  showToast(message) {
    const toast = this.elements.shareToast;
    if (!toast) return;
    toast.textContent = message;

    const footerEl = document.getElementById('app-footer');
    const footerHeight = footerEl ? footerEl.getBoundingClientRect().height : 0;
    toast.style.bottom = `calc(${footerHeight}px + 0.75rem + env(safe-area-inset-bottom, 0px))`;

    toast.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 2500);
  }

  /**
   * 検索実行中（県データのfetch待ち）に結果欄へ出す一時メッセージ。
   * displayResults()と同じ表示切り替え（data-view/has-results）を使い、
   * 検索前のレイアウトのまま隠れて見えなくなることを防ぐ。
   */
  showLoadingMessage() {
    this.elements.appLayout.setAttribute('data-view', 'results');
    this.elements.appLayout.classList.add('has-results');
    this.elements.resultsList.innerHTML = '<p class="loading">データを読み込んでいます…</p>';
  }

  /**
   * 検索に失敗したとき（データ読み込み・検索処理いずれの失敗も）の表示。
   * 【2026-10-11修正】以前はブラウザのalert()でポップアップを出していたが、
   * Minami指示によりやめ、結果欄に穏やかな文言＋再試行ボタンを出す形に変えた
   * （開発都合の文言は出さない。「データの読み込みに失敗しました」等の
   * 内部的な原因は書かず、利用者が次にできる行動だけを示す）。
   */
  showSearchErrorMessage() {
    this.elements.appLayout.setAttribute('data-view', 'results');
    this.elements.appLayout.classList.add('has-results');
    this.elements.resultsList.innerHTML = `
      <p class="no-results">うまく読み込めませんでした。少し待ってからもう一度お試しください。</p>
      <div class="no-results-actions">
        <button type="button" class="budget-retry-btn search-retry-btn">もう一度試す</button>
      </div>
    `;
  }

  /**
   * 【2026-10-03修正】以前は`!this.loader.stationIndex`（駅一覧がまだ読み込み中、
   * ＝失敗ではない）を「読み込みに失敗しました」と同じ扱いにしていた。
   * 「読み込み中」と「失敗」を区別し、読み込み中なら完了を待って自動的に
   * 検索を続行する（もう一度ボタンを押させない）。失敗の文言は実際に
   * fetchが失敗したとき（dataLoadFailed===true）だけ出す。
   */
  async performSearch() {
    if (this.dataLoadFailed) {
      this.showSearchErrorMessage();
      return;
    }
    if (!this.loader.stationIndex) {
      this.showLoadingMessage();
      await this.stationIndexPromise;
      if (this.dataLoadFailed) {
        this.showSearchErrorMessage();
        return;
      }
    }

    // 候補を選ばずに検索したときの案内・候補一覧は、検索を試みた時点で一度閉じる
    // （前回の検索結果に対する古い候補・案内が残り続けないようにする）。
    this.elements.departureSuggestions.innerHTML = '';
    this.hideDepartureGuidance();

    let prefCode = this.elements.departureInput.dataset.prefCode;
    let localIndex = this.elements.departureInput.dataset.localIndex;

    // 【2026-10-07修正】候補をクリックしていない（＝dataset未設定）場合、
    // 入力欄の文字が駅名と完全に一致する駅がちょうど1つだけあれば、それで
    // 検索する。候補クリックを経ずに駅名をそのまま打って検索する使い方を
    // 許容しつつ、一致が0件・複数件（同名駅が複数都道府県にある場合）の
    // ときは誤った駅で検索しないよう、検索せず案内を出す。
    if (!prefCode || localIndex === undefined) {
      const inputValue = this.elements.departureInput.value;
      const exactMatches = (this.loader.stationIndex || []).filter(([name]) => name === inputValue);
      if (exactMatches.length === 1) {
        // dataset経由（候補クリック）のときと型を揃えるため文字列化する
        // （DOMのdatasetは常に文字列であり、呼び出し先はそれを前提にしている）
        prefCode = String(exactMatches[0][1]);
        localIndex = String(exactMatches[0][2]);
      } else {
        this.showDepartureGuidance('候補から出発駅を選んでください');
        return;
      }
    }

    const budget = parseInt(this.elements.budgetInput.value, 10);
    if (!budget) {
      alert('出発駅と予算を選択してください');
      return;
    }

    // この時点の入力内容を「直近に検索した条件」として記録し、ボタンを
    // 既定の見た目（「検索」）に戻す。guidance等で早期returnした場合は
    // ここまで来ないため、ボタンは「この条件で検索」のままになる。
    this.lastSearchedDepartureText = this.elements.departureInput.value;
    this.lastSearchedBudget = budget;
    this.updateSearchButtonState();

    // 出発駅の県＋隣接県のフルデータをロード（既にロード済みなら実質待ち時間なし）してから、
    // 県内通し番号から実際のstation_idを解決する。ロード中は結果欄に専用メッセージを出す。
    let stationId;
    try {
      this.showLoadingMessage();
      await this.loadPrefecturesForDeparture(prefCode);
      stationId = this.loader.resolveStationId(prefCode, parseInt(localIndex, 10));
    } catch (error) {
      console.error('県データの読み込み失敗:', error);
      this.showSearchErrorMessage();
      return;
    }

    try {
      // 【4本目④修正】4本目③では毎回MAX_BUDGET(¥2000)で検索しており、
      // 富山駅前（通常CPU）で630ms→1151msに延びていた（Coworkがスクリーン
      // ショット・計測で指摘）。まず今の予算だけで一覧を出す（従来の速さ）。
      // ¥2000全域（スライダーで帯外の安い点を塗り分けるためのデータ）は
      // 一覧を出した後、裏で計算する（scheduleMaxBudgetPrefetch）。
      const result = await this.computeSearchResult(stationId, budget);
      this.displayResults(result.bandSpots, stationId, prefCode, result.reachableCount, budget, result.hasCheaperSpots, result.bandSpots);
      this.scheduleMaxBudgetPrefetch(stationId);
    } catch (error) {
      console.error('検索失敗:', error);
      this.showSearchErrorMessage();
    }
  }

  /**
   * 【4本目④】一覧を先に出した後、裏でMAX_BUDGET(¥2000)全域を計算し、
   * 終わり次第スライダー用のallSpotsを差し替える（Minami指示）。この計算が
   * 終わるまで、スライダーは「今の帯の点だけ」を塗り分ける（displayResults()が
   * 渡すallSpotsが最初はbandSpotsのままのため、自然とそうなる）。
   * requestIdleCallback（無ければsetTimeout）で、一覧の描画を妨げない
   * タイミングに後回しにする。
   */
  scheduleMaxBudgetPrefetch(stationId) {
    // 【43本目、不具合修正】requestIdleCallbackは、ページが暇になるまで後回しにする。期限を付けないと、
    // 地図の描画が重い間（下地がベクトル地図になり、3Dでは特に）いつまでも実行されず、地図の点が
    // 検索した金額の分だけのまま「¥2000分」に差し替わらないことがあった（金額を上げても円が
    // 広がらない。実機相当の長時間の確認で発覚）。遅くとも1.5秒後には実行する。
    const schedule = window.requestIdleCallback
      ? (cb) => window.requestIdleCallback(cb, { timeout: 1500 })
      : (cb) => setTimeout(cb, 50);
    schedule(async () => {
      // 裏の計算が終わるまでの間に別の駅で検索し直されていたら、
      // 今の表示とは無関係なデータのため何もしない。
      if (this.currentDepartureStationId !== stationId) return;
      try {
        const { allSpots } = await this.computeSearchResult(stationId, MAX_BUDGET);
        if (this.currentDepartureStationId !== stationId) return;
        // 検索カードの金額帯の案内（スライダーの件数）は、ここで¥2,000分を使い始めてよい（地図・一覧は変えない表示）。
        this.currentAllSpots = allSpots;
        // 【2026-10-26、61本目、不具合修正】¥2,000分で一覧を合わせ始める（_allSpotsStationId）のは、地図へ渡すのと
        // 同じとき（下のsetTimeoutの中）にする。「◯か所」「NEW +N」も地図に渡した場所で数える（_mapSpots）。以前は
        // ここ（地図へ渡す1.2秒前）から一覧・数を合わせていたため、検索した直後（約1秒以内）に＋を押すと、一覧の
        // 見出し・カード・「◯か所」「NEW +N」だけが先に新しい金額になり、地図のピン（新しく届くオレンジ）は
        // 1.0〜1.2秒遅れて出ていた（59本目の「地図・か所数・見出し・一覧が一緒に変わる」に反する。61本目の計測で
        // 発覚）。そろえた分、早く押したときは地図と一緒に遅れて変わる。
        // 【2026-10-13、10本目②修正】ここで即render()し直すと、検索直後に
        // 始まったばかりの「波のように出る」演出を、マーカーの作り直しで
        // 無言のまま中断・リセットしてしまう（render()はwaveの進行中かどうかに
        // 関わらず常に演出をキャンセルして作り直す設計のため）。requestIdleCallback
        // は環境によってはほぼ即座に発火するため、波の所要時間（WAVE_DURATION_MS、
        // map-view.js/terrain-map-view.js参照）より確実に後になるまで、
        // 反映そのものを遅らせる（実機・verify-layoutで、検索直後に点の
        // 隠れている数を見たらすでに0件＝演出が始まる前に終わっていたことで発覚）。
        setTimeout(() => {
          if (this.currentDepartureStationId !== stationId) return;
          this._mapSpots = allSpots;
          this._allSpotsStationId = stationId; // 【59本目】これで＋−の一覧合わせができる
          const departureStation = this.data.stations?.[stationId];
          // 【2026-10-13、10本目①修正】裏の計算中にスライダーが動かされていても、
          // 点は検索したときの予算（this.currentBudget）のまま据え置く（Minami指示：
          // 点は「この条件で検索」を押すまで変えない。以前はスライダーの今の値を
          // 使っていたが、それは「点がすぐ変わる」挙動そのものだった）。
          // 【2026-10-27、62本目、Minami指示】検索したあと利用者が自分で地図を動かしていたら（拡大・縮小・移動・
          // 回転・傾け・ピンで寄る）、この描き直しでは円に合わせ直さない（ピン・円・数・一覧は今までどおり変える）。
          // 動かす前なら今までどおり合わせ直す。＋−の地図合わせの保留も消さない（background）。
          // 【2026-10-27、64本目】＋−で金額を変えてあったら（今の金額≠検索した金額）、検索した金額の円には合わせ直さず、
          // 下で今の金額の円へ「いっぱい」に合わせる（裏取得が終わって円が今の金額の大きさに広がるため。合わせないと、
          // 円が見えている範囲からはみ出す・小さいままになる）。利用者が地図を動かしていたら、どちらも合わせない。
          const liveBudget = parseInt(this.elements.budgetInput.value, 10);
          const moved2d = this.mapView.hasUserMovedSinceFit();
          const moved3d = !!this.terrainMapView?.hasUserMovedSinceFit?.();
          this.mapView.render(departureStation, allSpots, this.currentBudget, {
            background: true,
            keepView: moved2d || liveBudget !== this.currentBudget,
          });
          if (this.terrainMapView) this.terrainMapView.render(departureStation, allSpots, this.currentBudget, { background: true });
          // 【43本目、不具合修正】render()は地図のピンを作り直して選択を外すため、検索直後にピンを
          // 選んでいた（情報枠を開いていた）場合、この裏取得の反映で選択だけが外れ、情報枠は開いた
          // まま選んだピンの強調が消えていた。選んでいたピンを、情報枠などはそのままに地図側だけ選び直す。
          this.restoreMapSelectionAfterRerender();
          // 円・帯の件数プレビューはスライダーの今の値で出してよい（動かしながら
          // 変えてよい表示のため）。allSpotsが揃ったことで、半径・件数とも
          // より正確になる。
          // 【2026-10-15、11本目②】裏取得はユーザーの予算操作ではないため、
          // 情報枠を閉じたり全体に戻したりしない（userTouch:false）。
          this.updateMapBudgetLive(liveBudget, { userTouch: false });
          if (liveBudget !== this.currentBudget) {
            if (!moved2d) this.mapView.fitAfterBudgetChange();
            if (this.terrainMapView && !moved3d) this.terrainMapView.fitAfterBudgetChange();
          }
          // 【2026-10-17、32本目B、検証用】¥2000全域の裏取得が実際に反映された
          // 回数。verify-layout.jsが「裏取得が終わるまで待つ」ために使う
          // （_lastSpots.lengthの安定待ちだけだと、安定したように見える瞬間が
          // 実際の完了より先に来ることがあり、不十分だった）。アプリ本体は読まない。
          window.__maxBudgetPrefetchAppliedCount = (window.__maxBudgetPrefetchAppliedCount || 0) + 1;
        }, WAVE_REVEAL_SAFE_DELAY_MS);
      } catch (e) {
        console.warn('¥2000範囲の裏取得に失敗しました（一覧・現在の帯の表示には影響しません）:', e);
      }
    });
  }

  /**
   * MAX_BUDGETで取得済みのallSpotsから、指定予算の帯・帯外の安い点の有無を
   * 同期的に計算する（4本目③）。computeSearchResult()内部の帯判定（2026-10-07
   * 修正：スポット単位で最安運賃を決めてから帯判定する）と同じ規則を踏襲する。
   */
  filterBandFromAllSpots(allSpots, budget) {
    const withinBudget = allSpots.filter((s) => s.source_round_trip_fare <= budget);
    const bandSpots = withinBudget.filter((s) => s.source_round_trip_fare > budget - BAND_WIDTH);
    const hasCheaperSpots = withinBudget.length > bandSpots.length;
    return { bandSpots, hasCheaperSpots };
  }

  /**
   * 指定した出発駅・予算で、到達可能駅・全スポット（帯フィルタ前）・帯内スポットを
   * 計算する。performSearch()と、共有リンク・マイリストから詳細を開く処理
   * （openSharedSpotForStation）の両方から呼ぶ共通ロジック（2026-10-08、1本目の
   * お気に入り機能で抽出）。
   * メモリキャッシュ（this.cache）も扱う。以前はperformSearch()内で帯内スポットだけ
   * キャッシュしていたが、共有リンクを開く処理は「帯で絞る前の全スポット」
   * （allSpots）も必要なため、両方キャッシュする形に変えた。
   */
  async computeSearchResult(stationId, budget) {
    const cacheKey = `route_${stationId}_${budget}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    // 到達可能な駅を計算（予算以下すべて）。
    const reachableStations = await this.fareCalc.calculateReachable(stationId, budget);

    // 【2026-10-07修正】帯の判定は「駅単位」ではなく「スポット単位」で行う。
    // 以前は駅を先に帯（予算−¥200より高く、予算以下）で絞り込んでから
    // spotFinder.findSpots()に渡していたが、同じスポットが複数の到達駅の
    // 圏内にある場合、検索した予算によって「どちらの駅経由と判定されるか」が
    // 変わり、同じスポットが往復¥400の帯にも往復¥1000の帯にも別々の運賃で
    // 出てしまう不具合があった（TOYAMAキラリ等でMinamiさんが公開ページで発見）。
    // 正しい手順は「予算以下で行ける駅をすべてspotFinderに渡し、スポットごとに
    // 一番安い往復運賃を決めてから、その運賃で帯判定する」こと
    // （spotFinder.findSpots()側の優劣判定もこれに合わせて運賃優先に変更済み）。
    const allSpots = await this.spotFinder.findSpots(reachableStations);

    const bandSpots = allSpots.filter((s) => s.source_round_trip_fare > budget - BAND_WIDTH);

    // 【2026-10-07追加】帯が0件のときの案内文を出し分けるため、「予算以下には
    // 何かあるが、この帯には無い」のか「予算以下に何も無い」のかを覚えておく
    // （buildNoResultsMessage()参照）。
    const hasCheaperSpots = allSpots.length > bandSpots.length;

    const result = { allSpots, bandSpots, reachableCount: reachableStations.length, hasCheaperSpots };
    this.cache.set(cacheKey, result);
    return result;
  }

  /**
   * @param {Array} spots - 帯（budget-200〜budget）内のスポット。一覧・「この先へ」等、
   *   既存の帯ベースのロジックはすべてこれ（this.currentSpots）を見る。
   * @param {Array} [allSpots] - 予算MAX_BUDGET(2000)で取得した全スポット。地図
   *   （2D/3D）はこちらを受け取り、予算スライダーの操作をデータ再取得なしで
   *   反映できるようにする（4本目③）。省略時はspotsで代用する（呼び出し元が
   *   まだ対応していない場合の後方互換）。
   */
  displayResults(spots, departureStationId, prefCode, reachableCount, budget, hasCheaperSpots, allSpots) {
    this.currentDepartureStationId = departureStationId;
    this.currentDeparturePrefCode = prefCode ? String(prefCode).padStart(2, '0') : null;
    this.currentDepartureStationName = this.data.stations?.[departureStationId]?.display_name || departureStationId;
    this.currentSpots = spots;
    this.currentAllSpots = allSpots || spots;
    this._mapSpots = this.currentAllSpots; // 【61本目】地図に渡す場所（下のrender()）。「◯か所」「NEW +N」はこれで数える
    this.currentReachableCount = reachableCount;
    this.currentBudget = budget;
    this.listBudget = budget;
    // 渡されたallSpotsが¥2,000分かどうかはここでは分からないため、いったん「まだ」にする（裏取得・共有リンクで付け直す）
    this._allSpotsStationId = null;
    this.currentSortOrder = 'recommended';
    this.elements.sortSelect.value = 'recommended';

    // 結果表示エリアをクリア（検索フォーム・地図の左カラムは常時表示のため触らない）。
    // 表示/非表示はすべてCSS（data-view属性・has-resultsクラス）に任せ、
    // ここではinline styleを直接いじらない（flex/blockの食い違いを防ぐため）
    this.elements.appLayout.setAttribute('data-view', 'results');
    this.elements.appLayout.classList.add('has-results');

    // 帯の見出し（「往復¥801〜¥1000で行ける場所」）。0件のときも、何の帯を
    // 検索した結果が0件なのかが分かるよう常に表示する。
    if (this.elements.bandHeading) {
      // 【51本目、Minami決定】「¥601〜¥800 の場所　12か所」（一覧に今出ている金額帯と、その中の数）。
      this.elements.bandHeading.innerHTML = bandHeadingHtml(budget, spots.length);
      this.elements.bandHeading.hidden = false;
    }

    // 【2026-10-15、11本目①】検索し直したら情報枠を閉じる・ピンの強調も外す
    // （Minami指示）。render()自体も内部でピン選択をクリアするが、枠のDOMは
    // main.js側にあるため、ここで明示的に閉じる必要がある。
    this.clearPinSelection();

    // 【2026-10-13、12本目②A、Minami決定：A＋C】検索成功時に要約バーの文言を
    // 更新し、スマホではフォームをたたむ（PCはCSS側で要約バー自体を出さない
    // ため実害なし）。要約バーはここで初めてhidden属性を外す
    // （「まだ一度も検索していないときは畳まない」の一度きりのゲート。
    // 以降はform-collapsedクラスだけで開閉を制御する）。
    if (this.elements.searchSummary) this.elements.searchSummary.hidden = false;
    this.updateSearchSummaryText(departureStationId, budget);
    this.setFormCollapsed(true);
    // 【2026-10-13、22本目、Minami決定：B】スマホの予算操作帯も、要約バーと
    // 同じく初回検索で初めてhidden属性を外す（以降は常に出し続ける）。
    if (this.elements.mobileBudgetOverlay) this.elements.mobileBudgetOverlay.hidden = false;
    // 【2026-10-17、32本目A、不具合修正】フォームを閉じるボタンも同じく、
    // 初回検索で初めてhidden属性を外す（以降はCSS側の.form-collapsed有無・
    // .has-resultsだけで表示を制御する）。[hidden]はdisplay:none!importantの
    // ため、属性を外さないままだとCSSの表示切替がどれだけ合っていても
    // 永遠に表示されない（実機相当のテストで発覚）。
    if (this.elements.formCloseBtn) this.elements.formCloseBtn.hidden = false;

    // 【2026-10-13、10本目②】「この条件で検索」を押した結果の表示なので、
    // 出発駅から近い順に点が波のように広がって出る演出を行う（Minami指示）。
    const departureStation = this.data.stations?.[departureStationId];
    if (departureStation && isFiniteNumber(departureStation.stop_lat) && isFiniteNumber(departureStation.stop_lon)) {
      saveLastDeparture(departureStation.stop_lat, departureStation.stop_lon); // 【56本目】検索前の地図の見え方
    }
    this._liveMapBudget = budget; // 【41本目】＋の波の「上げたか」の基準（updateMapBudgetLive()参照）
    // 【2026-10-23、49本目、Minami決定】地図のピンは紺とオレンジの2色。検索し直したとき（同じ出発駅）は、
    // 直前の検索から新しく増えた場所をオレンジのまま残すため、直前の検索の金額（小さい方）を紺の上限に
    // 渡す。初めての検索・出発駅を変えたときは、検索した金額までがすべて紺。裏取得の描き直し・3Dの
    // 初回切り替えでは変えない（ここ＝実際に検索した結果を出すときだけ決める）。
    const prevSearch = this._lastMapSearch;
    this._mapPrevSearchedBudget = prevSearch && prevSearch.stationId === departureStationId
      ? Math.min(prevSearch.budget, budget)
      : budget;
    this._lastMapSearch = { stationId: departureStationId, budget };
    this.mapView.setPrevSearchedBudget(this._mapPrevSearchedBudget);
    this.terrainMapView?.setPrevSearchedBudget(this._mapPrevSearchedBudget);
    // 【41本目】最初の見え方に戻るボタンは、一度検索したら出す。
    if (this.elements.mapResetViewBtn) this.elements.mapResetViewBtn.hidden = false;
    // 【51本目】色の説明・「NEW +◯」も、一度検索したら出す。
    if (this.elements.mapLegend) this.elements.mapLegend.hidden = false;
    // 【2026-10-26、61本目、不具合修正】円に合わせる前に（下のrender()）、検索カードを閉じた・結果の入れ物を出した・
    // 戻るボタンを出したあとの大きさを測り直す（右下の部品の列の隠し方・位置も決まる）。以前は測り直しが
    // 後回し（MutationObserver・ResizeObserverの次の回）だったため、検索した直後の円合わせは、閉じる前の
    // 検索カードの都合で隠していた部品（61本目のfitSearchCard()）や、まだ出ていない戻るボタンのまま
    // 部品を避けていた。そのため「最初の見え方に戻る」で合わせ直すと部品の避け方が変わり、400×464の3Dで
    // ズームが0.06（避ける1段0.03の2段分）ずれた。戻るボタンなどを出してから測るため、上の2つを先にした。
    this.layoutController?.updateInsets();
    this.mapView.render(departureStation, this.currentAllSpots, budget, { reveal: true });
    this.updateNewSpotMarks(budget);
    // 3D地図は3D切替が一度も行われるまでインスタンス自体が無い（遅延読込、4本目②）。
    // 作成済みならrender()を呼ぶ（未初期化でも座標だけ保持する設計のため、
    // activateTerrainMap()が後から呼ばれたときに自動で反映される）。
    if (this.terrainMapView) {
      this.terrainMapView.render(departureStation, this.currentAllSpots, budget, { reveal: true });
      // 【2026-10-20、36本目、Minami指示】検索直後の地図合わせを、金額操作時と
      // 同じ「円に合わせる」計算（fitCircleToView、最低ズーム8.5）に揃える。
      // 以前はfitToBudget()（スポット座標基準・最低ズーム9.5）のままで、
      // 予算によっては円がごく一部にしか見えない／画面からはみ出すことがあった
      // （Minami実機確認：富山駅前・往復¥500で円が小さすぎる、¥1,500ではみ出す）。
      // 【41本目】最初の見え方に戻るボタン・「← 一覧に戻る」と同じreturnToSearchView()
      // （円が短辺の0.85（47本目）、傾き45°、向きは変えない）を使う。3Dが見えていない（2D表示中）
      // ときは、3Dに切り替えたとき（resize()）に合わせる。
      this.terrainMapView.returnToSearchView({ durationMs: 0 });
    }

    // 【2026-10-14、25本目、不具合修正】updateMobileBudgetOverlay()・
    // updateBudgetBandPreview()はどちらもthis.mapView.computeReachRadiusKm()
    // （mapView._lastSpots・departureLatLngを参照）で距離を出すため、
    // 必ずmapView.render()のあとに呼ぶ。以前はrender()より前に呼んでおり、
    // 検索直後だけ前回の検索結果の距離を一瞬表示してしまっていた。
    this.updateMobileBudgetOverlay(budget);
    this.updateBudgetBandPreview(budget, spots.length);

    // 起動時点では出発駅が無く3Dを開始できなかったため、最初の検索結果が
    // 出たこのタイミングで「前回3Dだった」場合の自動復元を行う
    // （4本目①、Minami指示：3Dを一度選んだ端末では次回も3D）。
    if (this.mapMode === '3d' && (!this.terrainMapView || !this.terrainMapView.map)) {
      this.activateTerrainMap();
    }

    this.renderResultsList();
    // 【2026-10-27、64本目、不具合修正】スマホでは、一覧を描いたあとで下の一覧の高さが変わり（390×844で156px→193px）、
    // 見えている範囲が変わる。3Dは上のreturnToSearchView()が一覧を描く前の高さで合わせていたため、出発駅が見えている
    // 範囲の真ん中から18pxずれていた（2Dはrender()の次のコマのrefitBounds()で合わせ直している）。高さが変わるのは
    // 次のコマとは限らない（写真・文字の読み込みしだい）ため、検索してから1秒のあいだ毎コマ見て、見えている範囲が
    // 合わせたときと変わっていて、まだ合わせたままなら（利用者が動かしていなければ）一瞬で合わせ直す。
    // ＋−を押したら（_budgetFitTokenが進む）やめる（＋−の地図合わせ・波を取り消さないため）。
    const refitUntil = performance.now() + 1000;
    let fitToken = this.terrainMapView?._budgetFitToken;
    const refitIfAreaChanged = () => {
      const tv = this.terrainMapView;
      if (!tv || tv._budgetFitToken !== fitToken) return;
      if (tv.map && !tv.map.isMoving() && tv.visibleAreaChangedSinceFit?.() && tv.isAtLastCircleFit?.()) {
        tv.returnToSearchView({ durationMs: 0 });
        fitToken = tv._budgetFitToken;
      }
      if (performance.now() < refitUntil) requestAnimationFrame(refitIfAreaChanged);
    };
    requestAnimationFrame(refitIfAreaChanged);
  }

  /**
   * 2D/3D切替ボタンのクリックハンドラ（4本目①「3D地図の土台」）。
   * 3Dへの切替に失敗した場合はエラー文言を出さず、2Dのまま何も起きない
   * （Minami指示）。
   */
  async toggleMapDimension() {
    if (this.mapMode === '3d') {
      this.mapMode = '2d';
      saveMapModePreference('2d');
      this.applyMapMode();
      return;
    }
    await this.activateTerrainMap();
  }

  /**
   * 3D地図を有効化する。出発駅が未確定（検索前）のときは中心座標が無いため
   * 何もしない。WebGL対応チェック・ライブラリ読み込み・地図初期化のいずれかに
   * 失敗した場合も、例外を握りつぶして2Dのまま据え置く（エラー文言なし）。
   * 2Dの地図は消さず、読み込み中は「3D地図を準備しています」を小さく出す
   * （4本目②、Minami指示）。
   * @returns {Promise<boolean>} 3D化に成功したか
   */
  async activateTerrainMap() {
    const station = this.data?.stations?.[this.currentDepartureStationId];
    if (!station || typeof station.stop_lat !== 'number' || typeof station.stop_lon !== 'number') {
      return false;
    }
    if (!isWebglLikelySupported()) return false; // ライブラリすら読み込まない

    this.setTerrainLoadingIndicator(true);
    try {
      if (!this.terrainMapView) {
        const { TerrainMapView } = await loadTerrainModule();
        this.terrainMapView = new TerrainMapView('spots-map-3d');
        // 【2026-10-11、6本目B】2Dと同じ動き：地図の点を押したら該当カードを
        // スクロール＋光らせる（highlightCardはスマホで一覧が非表示のときは
        // 自然に何もしない）。【2026-10-15、11本目①】吹き出しは廃止し、
        // 同じ通知で情報枠も開く。【64本目】情報枠（名前の帯）はやめ、PCは詳細・スマホは場所のカードを出す（onPinSelected()）。
        this.terrainMapView.onSelectionChange = (spotId) => {
          this.selectedSpotId = spotId;
          this.highlightCard(spotId);
          this.onPinSelected(spotId);
        };
        this.terrainMapView.onBackgroundClick = () => this.onMapBackgroundClick();
        this.layoutController.terrainMapView = this.terrainMapView; // 遅延生成のため後から差し替える
      }
      await this.terrainMapView.ensureMap({ lat: station.stop_lat, lon: station.stop_lon });
      // ensureMap()内部のバックフィルは「3D生成前にrender()が一度でも呼ばれていた」
      // 場合にしか効かない（TerrainMapView自体がここで初めて生成されるこの経路では
      // 効かない）。検索済みなら、今の帯・allSpotsをここで明示的に反映する。
      if (this.currentDepartureStationId) {
        // 【49本目】あとから作った3Dにも、直前の検索の金額（紺の上限）を渡しておく。
        if (this._mapPrevSearchedBudget != null) this.terrainMapView.setPrevSearchedBudget(this._mapPrevSearchedBudget);
        this.terrainMapView.render(station, this.currentAllSpots, this.currentBudget);
        // 【2026-10-21、43本目、Minami決定：A-2】検索したあとに初めて3Dへ切り替えたときも、
        // 検索した直後と同じ見え方（円が短辺の0.85（47本目）、傾き45°、向きは北）にする。以前は
        // ズーム9・傾き57°のまま（下の11本目②の判断でカメラを触らなかった）だった。
        // 2回目以降の切り替えでは、3Dで見ていた位置のまま（見えていない間に検索が
        // あったときだけ、returnToSearchView()の保留→resize()で合わせ直される）。
        // まだ一度も検索していないとき（currentDepartureStationIdが無い）は従来どおり。
        // 3Dのコンテナはこの時点ではまだ表示前のため、returnToSearchView()は保留し、
        // 直後のapplyMapMode()→resize()で合わせる。
        if (!this._terrainShownAfterSearch) {
          this._terrainShownAfterSearch = true;
          this.terrainMapView.returnToSearchView({ durationMs: 0 });
        }
      }
      this.mapMode = '3d';
      saveMapModePreference('3d');
      this.applyMapMode();
      // 【2026-10-15、11本目②で検討】当初はここでfitToBudget()も呼び、3Dを
      // 開いた直後から「全体」をきちんと計算済みの位置にしていた。しかし
      // これが原因で、立山方向への検証用jumpTo()の直後にqueryTerrainElevationが
      // 低い値を返す不具合が起きた（verify-layoutで標高2000m以上の地点が
      // 入っているはずの画面で1902m程度しか読めなかったことで発覚。
      // fitToBudgetを無効化すると再現しなくなることを実機で確認済み）。
      // 原因はDEMタイルの取得競合と見られる：fitToBudget()が「全体」領域の
      // 標高タイルを先に要求し始め、直後のjumpTo()が立山方向に必要な高ズーム
      // タイルを要求しても、取得待ちの列で後回しにされ、waitForTerrainLoaded()
      // 自体は（別の低優先度タイルの完了をもって）先に「完了」と報告してしまう
      // ため、実際にはまだ粗いタイルのまま標高を読んでいた。
      // returnToOverview()は呼ばれるたびに_lastSpots/_lastDepartureStationから
      // 毎回その場でbounds・ズームを計算し直す設計（キャッシュに依存しない）
      // ため、3Dを開いた時点で前もってfitToBudget()しておく必要は無いと判断し、
      // この呼び出し自体を削除した（render()だけ行い、カメラは触らない。
      // 寄る前の初期位置がズーム9・出発駅中心のままなのは10本目以前と同じ）。
      return true;
    } catch (e) {
      console.warn('3D地図の有効化に失敗したため2Dのまま継続します:', e);
      this.terrainMapView?.destroy(); // 中途半端に生成されたWebGLコンテキストを解放する
      this.mapMode = '2d';
      saveMapModePreference('2d');
      return false;
    } finally {
      this.setTerrainLoadingIndicator(false);
    }
  }

  setTerrainLoadingIndicator(visible) {
    this.elements.terrainLoadingIndicator?.toggleAttribute('hidden', !visible);
  }

  /**
   * 【2026-10-25、56本目】ヘッダーの「2D / 3D」で、今出ている側を濃くする（以前は地図の上のボタンの文字を
   * 「3D表示」「2D表示」と書き換えていた）。検索前は、前回3Dを選んだ端末でも2Dで出す（決定3）ため、
   * this.mapModeではなく実際の表示（#map-area.mode-3d）を見る。
   */
  updateDimensionToggleLabel() {
    const toggle = this.elements.mapDimensionToggle;
    if (!toggle) return;
    const is3d = !!document.getElementById('map-area')?.classList.contains('mode-3d');
    toggle.classList.toggle('is-3d', is3d);
    toggle.setAttribute('aria-pressed', String(is3d));
  }

  /**
   * 【2026-10-25、56本目】地図の上の部品と、ヘッダーのメニュー・検索カードの例・「データ出典・免責」の配線。
   */
  setupMapStageControls() {
    // 地図のズーム＋−（右下の部品の列の一番上。2D・3D共通で、今出ている側の地図を動かす）
    const zoomBy = (delta) => {
      if (this.mapMode === '3d' && this.terrainMapView?.map && document.getElementById('map-area')?.classList.contains('mode-3d')) {
        if (delta > 0) this.terrainMapView.map.zoomIn(); else this.terrainMapView.map.zoomOut();
      } else if (this.mapView.map) {
        if (delta > 0) this.mapView.map.zoomIn(); else this.mapView.map.zoomOut();
      }
    };
    this.elements.mapZoomIn?.addEventListener('click', () => zoomBy(1));
    this.elements.mapZoomOut?.addEventListener('click', () => zoomBy(-1));

    // 【58本目】PCの結果画面：パネルの右の縁の「◀」で一覧を閉じ、細いバーの下の「☰ 一覧を開く」で開く
    this.elements.resultsListCloseBtn?.addEventListener('click', () => this.setResultsListOpen(false));
    this.elements.resultsListOpenBtn?.addEventListener('click', () => this.setResultsListOpen(true));

    // 【59本目】スマホの下の一覧のつまみ：押すと小⇔大、上にドラッグすると大、下にドラッグすると小
    // （30px以上動かしたときだけドラッグとして扱い、そのあとのclickは無視する）。
    const handle = this.elements.resultsSheetHandle;
    if (handle) {
      let dragStartY = null;
      let dragged = false;
      handle.addEventListener('pointerdown', (e) => {
        dragStartY = e.clientY;
        dragged = false;
        handle.setPointerCapture?.(e.pointerId);
      });
      handle.addEventListener('pointermove', (e) => {
        if (dragStartY === null) return;
        const dy = e.clientY - dragStartY;
        if (Math.abs(dy) < 30) return;
        dragged = true;
        dragStartY = null;
        this.setSheetLarge(dy < 0);
      });
      const end = () => { dragStartY = null; };
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
      handle.addEventListener('click', () => {
        if (dragged) { dragged = false; return; }
        this.setSheetLarge(!this.layoutController?.isSheetLarge());
      });
    }

    // スマホのヘッダーの「☰」：使い方・2D / 3D・マイリストを出す。メニューの外を押したら閉じる。
    this.elements.headerMenuBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !this.elements.appHeader.classList.contains('header-menu-open');
      this.elements.appHeader.classList.toggle('header-menu-open', open);
      this.elements.headerMenuBtn.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', (e) => {
      if (!this.elements.appHeader?.classList.contains('header-menu-open')) return;
      if (this.elements.headerNav?.contains(e.target) && !e.target.closest('button')) return;
      if (e.target.closest && e.target.closest('#header-nav button')) {
        this.closeHeaderMenu();
        return;
      }
      if (!this.elements.appHeader.contains(e.target)) this.closeHeaderMenu();
    });

    // 検索カードの例（香川・高松／富山／石川・松任）：押すと出発駅をその駅にする（候補を選んだときと同じ）
    document.querySelectorAll('.example-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const input = this.elements.departureInput;
        input.value = chip.dataset.stationName;
        input.dataset.prefCode = chip.dataset.prefCode;
        input.dataset.localIndex = chip.dataset.localIndex;
        this.elements.departureSuggestions.innerHTML = '';
        this.hideDepartureGuidance();
        this.updateSearchButtonState();
      });
    });

    // 「データ出典・免責」の1行（結果の入れ物の中）と、地図の出典（ⓘ）の中の「出典の詳細・免責・お問い合わせ」
    document.addEventListener('michidokoro:open-about', () => this.elements.aboutModal?._open?.());
    document.addEventListener('click', (e) => {
      const trigger = e.target.closest && e.target.closest('[data-open-about], .open-about-data');
      if (!trigger) return;
      e.preventDefault();
      this.elements.aboutModal?._open?.();
    });
  }

  closeHeaderMenu() {
    if (!this.elements.appHeader?.classList.contains('header-menu-open')) return;
    this.elements.appHeader.classList.remove('header-menu-open');
    this.elements.headerMenuBtn?.setAttribute('aria-expanded', 'false');
  }

  /**
   * 【2026-10-25、56本目、Minami決定：C】検索前から地図を出す。前回検索した出発駅のあたり（端末に覚えたもの）、
   * 初めての人は富山駅前のあたり。2Dで出す（前回3Dを選んだ端末でも、3Dは最初の検索のあとに出す）。
   */
  showInitialMapView() {
    const last = loadLastDeparture();
    const view = last ? { lat: last.lat, lon: last.lon, zoom: INITIAL_MAP_VIEW.zoom } : INITIAL_MAP_VIEW;
    this.mapView.showInitialView(view.lat, view.lon, view.zoom);
  }

  applyMapMode() {
    const mapArea = document.getElementById('map-area');
    if (mapArea) mapArea.classList.toggle('mode-3d', this.mapMode === '3d');
    this.updateDimensionToggleLabel();
    // 直前までdisplay:noneだった側が実寸を持つよう、表示反映後にリサイズする
    requestAnimationFrame(() => {
      if (this.mapMode === '3d') {
        this.terrainMapView?.resize();
      } else if (this.mapView.map) {
        // 【2026-10-13、22本目、不具合修正】display:noneから復帰した直後、
        // 既存マーカー（#spots-mapのL.marker群）の画面上の位置が直らない
        // ことがPlaywrightでの実機相当検証で判明した（136件中44件が、
        // 本来の位置から数千px単位でずれた場所に表示されたまま＝実際に
        // クリックすると無関係な別の場所を押してしまう）。根本原因・調査の
        // 経緯はmap-view.jsのforceMarkerReposition()参照（render()完了後にも
        // 同じ問題が起きるため、そちらと処理を共通化した）。
        // 【2026-10-21、40本目、不具合修正】3D表示中に検索していた場合、2D側の地図合わせ・
        // ピンの塗り分け・円の描き直しが保留されたままになっていた（MapView.handleShown()
        // 参照）。forceMarkerReposition()に加えて、それらもここでやり直す。
        this.mapView.handleShown();
      }
    });
    // 【2026-10-13、22本目、Minami決定】2D・3Dを切り替えても選んでいたピンは
    // 選ばれたままにする。
    this.reapplySelectionAfterModeSwitch();
  }

  /**
   * 【2026-10-13、22本目、Minami決定】2D・3Dの切り替え後、選択中のピン
   * （this.selectedSpotId、アプリ全体で1つだけ持つ）を、これから表示される
   * 側のビューへ反映し直す。薄い色のピン（帯より安い）でもcurrentAllSpotsには
   * あるため選択自体は引き継げる。検索し直し直後等でcurrentAllSpotsに見つから
   * ない場合は選択を諦める（エラーにしない。Minami指示）。
   */
  /**
   * 【2026-10-21、43本目、不具合修正】地図を作り直したあと（裏取得の反映）、選んでいたピンを
   * 2D・3Dの地図の上だけで選び直す（一覧のハイライト・情報枠は変えない＝コールバックを呼ばない）。
   */
  restoreMapSelectionAfterRerender() {
    if (!this.selectedSpotId) return;
    const spot = this.currentAllSpots?.find((s) => s.id === this.selectedSpotId);
    if (!spot) return;
    this.mapView.selectedSpotId = spot.id;
    this.mapView.setMarkerState(spot.id, 'selected', true);
    this.mapView._recluster();
    this.terrainMapView?.setSelectedSpot(spot);
  }

  reapplySelectionAfterModeSwitch() {
    if (!this.selectedSpotId) return;
    const spot = this.currentAllSpots?.find((s) => s.id === this.selectedSpotId);
    if (!spot) {
      this.selectedSpotId = null;
      return;
    }
    if (this.mapMode === '3d') {
      // 3D側はsetSelectedSpot()自体がonSelectionChangeを呼ばない設計
      // （実際のクリック操作時はクリックハンドラ側で別途呼んでいる）ため、
      // ここで一覧ハイライトも明示的に行う。
      // 【64本目】詳細・場所のカードは出し直さない（onPinSelected()は呼ばない）：PCで詳細から一覧に戻ったあとも
      // 選択は残るため、切り替えるたびに詳細が開き直ってしまう。スマホの場所のカードは地図と別のDOMのため、
      // 切り替えても出たまま。
      this.terrainMapView?.setSelectedSpot(spot);
      this.highlightCard(spot.id);
    } else {
      // 2D側のsetSelected()はonSelectionChange経由でhighlightCardを行う（onPinSelectedは上と同じ理由で止める）。
      this._reapplyingSelection = true;
      try {
        this.mapView.setSelected(spot.id);
      } finally {
        this._reapplyingSelection = false;
      }
    }
  }

  // ========================================
  // 共有リンク（?spot=.../?list=...）
  // ========================================

  /**
   * ページ読み込み時にURLパラメータを読み、共有リンクであれば該当画面を開く。
   * 駅一覧（stationIndexPromise）の解決後に呼ばれる。不正なパラメータ・
   * 届かない・駅が解決できない場合は、エラー文言を出さず何もしない
   * （＝通常のトップ画面のまま）。
   */
  async handleInitialUrl() {
    if (this.dataLoadFailed) return;
    const params = new URLSearchParams(location.search);

    const listParam = params.get('list');
    if (listParam) {
      await this.openSharedList(parseListParam(listParam));
      return;
    }

    const spotParams = parseSpotShareParams(params);
    if (spotParams) {
      await this.openSharedSpotLink(spotParams);
    }
  }

  /**
   * 共有URLの県コード・station_id・駅名から、実際のstation_idを解決する。
   * 1. sidがその県のstations.jsonに実在し、表示名がdepと一致 → 採用
   * 2. ダメならdepの完全一致を、その県内のstation-index.jsonエントリだけで探し、
   *    1件だけならそれを採用（station_idが再ビルドで変わっていても駅名が同じなら
   *    復元できるようにするため。stations.jsonは出発県＋隣接県が合併済みのため、
   *    単純な名前検索だと隣接県の同名駅と衝突しうる。station-index.jsonは
   *    県コードを持つため、ここで絞り込める）
   * どちらも失敗したらnullを返す。
   */
  resolveStationFromShareParams(prefCode, sid, depName) {
    const codeStr = String(prefCode).padStart(2, '0');
    if (sid && this.data.stations?.[sid]?.display_name === depName) {
      return sid;
    }
    if (depName && this.loader.stationIndex) {
      const matches = this.loader.stationIndex.filter(
        ([name, pc]) => name === depName && String(pc).padStart(2, '0') === codeStr
      );
      if (matches.length === 1) {
        return this.loader.resolveStationId(codeStr, matches[0][2]);
      }
    }
    return null;
  }

  /**
   * 共有リンク・マイリストから景勝地の詳細を直接開く（Minamiさんの判断：帯では
   * 絞らず、出発駅から上限¥2000で届くスポットの中からQIDで探す。帯で切ると、
   * 共有されたスポットがちょうどその帯の外のとき開けなくなるため）。
   * 見つかったら、予算欄をそのスポットの往復運賃が収まる帯の上端
   * （¥100刻みで切り上げ）に合わせ、その条件で一覧も作っておく
   * （「← 一覧に戻る」で、このスポットを含む一覧に戻れるようにするため）。
   * @returns {boolean} 開けたか
   */
  async openSharedSpotForStation(qid, stationId, prefCode) {
    try {
      const { allSpots, reachableCount } = await this.computeSearchResult(stationId, MAX_BUDGET);
      const spot = allSpots.find((s) => s.id === qid);
      if (!spot) return false;

      const alignedBudget = Math.min(
        MAX_BUDGET,
        Math.max(MIN_BUDGET, Math.ceil(spot.source_round_trip_fare / BUDGET_STEP) * BUDGET_STEP)
      );
      // 【4本目③】既に取得済みのallSpots（MAX_BUDGET）から同期的に帯を絞り込む
      // （computeSearchResultをalignedBudgetで呼び直さない。地図に渡すallSpots自体も
      // このMAX_BUDGET版をそのまま使う）。
      const { bandSpots, hasCheaperSpots } = this.filterBandFromAllSpots(allSpots, alignedBudget);
      // bandSpots側の同一QIDのオブジェクトを使う（this.currentSpots＝displayResults()が
      // 設定する集合と、詳細画面に渡すオブジェクトの参照を一致させるため）。
      // 内容自体はallSpots側と同じになるはずだが、念のためbandSpotsに無ければ
      // allSpots側のspotにフォールバックする。
      const spotForDetail = bandSpots.find((s) => s.id === qid) || spot;

      this.elements.budgetInput.value = alignedBudget;
      this.updateBudgetUI();
      this.lastSearchedDepartureText = this.data.stations?.[stationId]?.display_name || '';
      this.elements.departureInput.value = this.lastSearchedDepartureText;
      this.lastSearchedBudget = alignedBudget;
      this.updateSearchButtonState();

      this.displayResults(bandSpots, stationId, prefCode, reachableCount, alignedBudget, hasCheaperSpots, allSpots);
      this._allSpotsStationId = stationId; // 【59本目】ここで渡したallSpotsは¥2,000分
      this.detailHistory = []; // 共有リンク・マイリストからの新規の詳細表示なので履歴をリセットする
      history.pushState({}, ''); // スマホの戻る操作で一覧に戻れるよう、履歴を1つ積む（URLは変えない）
      this.showSpotDetail(spotForDetail);
      return true;
    } catch (error) {
      console.error('共有リンクの表示に失敗:', error);
      return false;
    }
  }

  /** 景勝地1件の共有リンク（?spot=...）を開く */
  async openSharedSpotLink({ qid, prefCode, stationId, departureName }) {
    try {
      await this.loadPrefecturesForDeparture(prefCode);
    } catch (error) {
      console.error('共有リンクの県データ読み込みに失敗:', error);
      return;
    }
    const resolvedStationId = this.resolveStationFromShareParams(prefCode, stationId, departureName);
    if (!resolvedStationId) return;
    await this.openSharedSpotForStation(qid, resolvedStationId, prefCode);
  }

  /**
   * リストの共有（?list=...）を開く。各項目は出発地が別々のことがあるため、
   * 読み取り専用の「共有されたリスト」モーダルに表示する（ローカル保存＝マイリストへの
   * 追加はボタンで明示的に行う）。
   * 【実装メモ】resolveListItemDisplay()がloadPrefecturesForDeparture()経由で
   * this.data/this.fareCalc等を書き換える（GTFSLoaderの累積ロードの仕組み上、
   * 複数県を跨いでも既存データは消えず合算されるため、表示用の情報解決自体は
   * 正しく動く）。ページ読み込み時（まだ検索していない状態）にしか呼ばれない
   * 前提のため実害はないが、将来「検索結果を見ながら共有リストを開く」導線を
   * 足す場合は、この副作用に注意すること。
   */
  async openSharedList(items) {
    if (items.length === 0) return;
    this._sharedListItems = items;
    this.elements.sharedListModal?._open?.();
    await this.renderSharedList(items);
  }

  /**
   * リスト項目それぞれについて、その県＋隣接県のデータをロードし（累積ロードのため
   * 他項目の県を読み込んでも既存データは消えない）、現在の検索状態
   * （this.data/this.fareCalc等）を使って表示用の情報（名前・運賃・所要時間・
   * 出発駅名）を解決する。station_idが解決できない場合は、スポット辞書
   * （this.data.spots）からスポット名だけ拾って表示する。
   */
  async resolveListItemDisplay(item) {
    try {
      await this.loadPrefecturesForDeparture(item.prefCode);
    } catch {
      return { ...item, resolved: false, name: null };
    }
    const spotDict = this.data.spots?.[item.qid];
    const station = this.data.stations?.[item.stationId];
    if (!station) {
      return { ...item, resolved: false, name: spotDict?.name || null };
    }
    try {
      const { allSpots } = await this.computeSearchResult(item.stationId, MAX_BUDGET);
      const spot = allSpots.find((s) => s.id === item.qid);
      if (!spot) return { ...item, resolved: false, name: spotDict?.name || null };
      return {
        ...item,
        resolved: true,
        name: spot.name,
        departureName: station.display_name,
        roundTripFare: spot.source_round_trip_fare,
        durationMin: typeof spot.source_ride_duration_min === 'number' ? spot.source_ride_duration_min : null,
      };
    } catch {
      return { ...item, resolved: false, name: spotDict?.name || null };
    }
  }

  /** 「共有されたリスト」モーダルの中身を描画する（読み取り専用）。 */
  async renderSharedList(items) {
    const body = this.elements.sharedListBody;
    if (!body) return;
    body.innerHTML = '<p class="loading">読み込んでいます…</p>';
    const resolved = await Promise.all(items.map((it) => this.resolveListItemDisplay(it)));
    this._sharedListResolved = resolved;
    body.innerHTML = resolved.map((item, i) => this.renderMylistRowHtml(item, i, { shared: true })).join('')
      || '<p class="no-results">表示できる項目がありませんでした。</p>';
  }

  /** 「共有されたリスト」の解決できた項目を、すべてマイリストに追加する（既存なら内容を更新） */
  addSharedListToMylist() {
    const resolved = this._sharedListResolved || [];
    let addedCount = 0;
    for (const item of resolved) {
      if (!item.resolved) continue;
      upsertFavorite({
        qid: item.qid,
        name: item.name,
        prefCode: String(item.prefCode).padStart(2, '0'),
        departureStationId: item.stationId,
        departureName: item.departureName,
        roundTripFare: item.roundTripFare,
        durationMin: item.durationMin,
        savedAt: new Date().toISOString(),
      });
      addedCount++;
    }
    this.updateMylistCount();
    this.refreshFavoriteButtons();
    this.showToast(`マイリストに${addedCount}件追加しました`);
  }

  /**
   * マイリスト（保存済みのお気に入り）モーダルの中身を描画する。開くたびに
   * 呼ばれ、保存済みの各項目について運賃を再計算し、保存時と違えば
   * 「運賃が変わりました」を出す。今は検索結果に出ない（到達不可・スポットが
   * 見つからない）場所は「この場所は現在検索結果に出ません。」を出し、削除できるようにする。
   */
  async renderMylist() {
    const body = this.elements.mylistBody;
    if (!body) return;
    const favorites = loadFavorites();
    if (favorites.length === 0) {
      body.innerHTML = '<p class="no-results">まだ何も保存されていません。</p>';
      return;
    }
    body.innerHTML = '<p class="loading">読み込んでいます…</p>';

    const recomputed = await Promise.all(
      favorites.map(async (fav) => {
        try {
          await this.loadPrefecturesForDeparture(fav.prefCode);
        } catch {
          return { ...fav, resolved: false, fareChanged: false };
        }
        const station = this.data.stations?.[fav.departureStationId];
        if (!station) {
          return { ...fav, resolved: false, fareChanged: false };
        }
        try {
          const { allSpots } = await this.computeSearchResult(fav.departureStationId, MAX_BUDGET);
          const spot = allSpots.find((s) => s.id === fav.qid);
          if (!spot) return { ...fav, resolved: false, fareChanged: false };
          const fareChanged = spot.source_round_trip_fare !== fav.roundTripFare;
          return {
            ...fav,
            resolved: true,
            currentFare: spot.source_round_trip_fare,
            fareChanged,
          };
        } catch {
          return { ...fav, resolved: false, fareChanged: false };
        }
      })
    );

    const sortOrder = this.elements.mylistSortSelect?.value || 'saved';
    const sorted = this.sortMylistItems(recomputed, sortOrder);
    // handleMylistClick()が同じ配列をインデックスで引けるよう保持しておく
    // （クリックのたびに再計算すると、表示とクリック時で運賃が食い違いうる上に無駄が多い）。
    this._mylistResolved = sorted;

    body.innerHTML = sorted.map((item, i) => this.renderMylistRowHtml(item, i, { shared: false })).join('');
  }

  sortMylistItems(items, sortOrder) {
    const list = [...items];
    switch (sortOrder) {
      case 'price':
        return list.sort((a, b) => (a.currentFare ?? a.roundTripFare) - (b.currentFare ?? b.roundTripFare));
      case 'departure':
        return list.sort((a, b) => (a.departureName || '').localeCompare(b.departureName || '', 'ja'));
      case 'saved':
      default:
        return list.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
    }
  }

  /** マイリスト／共有されたリストの1行分のHTMLを組み立てる */
  renderMylistRowHtml(item, index, { shared }) {
    const savedDate = item.savedAt ? new Date(item.savedAt) : null;
    const savedLabel = savedDate && !Number.isNaN(savedDate.getTime())
      ? `${savedDate.getMonth() + 1}/${savedDate.getDate()}に保存`
      : '';

    if (shared && !item.resolved && !item.name) {
      return `
        <div class="mylist-row mylist-row-unresolved" data-index="${index}">
          <p class="mylist-row-name">この場所は表示できませんでした</p>
        </div>
      `;
    }

    const name = item.name || '（名称不明）';
    const fareToShow = item.currentFare ?? item.roundTripFare;
    const fareChangedHtml = item.fareChanged
      ? `<p class="mylist-fare-changed">運賃が変わりました（¥${item.roundTripFare}→¥${item.currentFare}）</p>`
      : '';
    const unresolvedHtml = !shared && !item.resolved
      ? '<p class="mylist-unresolved">この場所は現在検索結果に出ません。</p>'
      : '';
    const departureLine = item.departureName
      ? `<p class="mylist-row-summary">${item.departureName}から 往復¥${fareToShow}${typeof item.durationMin === 'number' ? `・約${item.durationMin}分` : ''}</p>`
      : '';

    const actionsHtml = shared
      ? ''
      : `
        <button type="button" class="mylist-share-btn" data-action="mylist-share" data-index="${index}" aria-label="共有">${shareIconHtml()}</button>
        <button type="button" class="mylist-remove-btn" data-action="mylist-remove" data-index="${index}" aria-label="マイリストから削除">×</button>
      `;

    return `
      <div class="mylist-row" data-index="${index}" data-qid="${item.qid}">
        <button type="button" class="mylist-row-open" data-action="mylist-open" data-index="${index}">
          <p class="mylist-row-name">${name}</p>
          ${departureLine}
          ${fareChangedHtml}
          ${unresolvedHtml}
          ${savedLabel ? `<p class="mylist-saved-at">${savedLabel}</p>` : ''}
        </button>
        <div class="mylist-row-actions">${actionsHtml}</div>
      </div>
    `;
  }

  /**
   * マイリスト／共有されたリストの行クリックを委譲処理する（開く／削除／共有）。
   * renderMylist()・renderSharedList()がそれぞれ描画時に保持した解決済み配列
   * （this._mylistResolved / this._sharedListResolved）をインデックスで引く
   * （クリックのたびに運賃を再計算し直すと、表示とクリック時で値が食い違いうる上に
   * 二重に通信が走るため、描画結果をそのまま使う）。
   */
  async handleMylistClick(e) {
    const removeBtn = e.target.closest('[data-action="mylist-remove"]');
    const shareBtn = e.target.closest('[data-action="mylist-share"]');
    const openBtn = e.target.closest('[data-action="mylist-open"]');
    if (!removeBtn && !shareBtn && !openBtn) return;

    const row = e.target.closest('.mylist-row');
    const index = parseInt(row?.getAttribute('data-index'), 10);
    const isShared = row?.closest('#shared-list-body') != null;
    const items = isShared ? this._sharedListResolved : this._mylistResolved;
    const item = items?.[index];
    if (!item) return;

    if (removeBtn) {
      removeFavorite(item.qid);
      this.updateMylistCount();
      this.refreshFavoriteButtons();
      this.renderMylist();
      return;
    }
    if (shareBtn) {
      const url = buildSpotShareUrl(location.href, {
        qid: item.qid, prefCode: item.prefCode, stationId: item.departureStationId, departureName: item.departureName,
      });
      const text = buildSpotShareText(item.name, item.departureName, item.currentFare ?? item.roundTripFare, item.durationMin, url);
      const result = await shareOrCopy(text, url);
      if (result === 'copied') this.showToast('コピーしました');
      else if (result === 'failed') this.showToast('共有できませんでした');
      return;
    }
    if (openBtn) {
      if (!item.resolved) return;
      const stationId = isShared ? item.stationId : item.departureStationId;
      this.elements.mylistModal.hidden = true;
      this.elements.sharedListModal.hidden = true;
      await this.openSharedSpotForStation(item.qid, stationId, item.prefCode);
    }
  }

  /**
   * 並び替え設定（this.currentSortOrder）に従ってスポット一覧を並べ替えて返す。
   * 「おすすめ順」は SpotFinder が既に算出した順序（情報充実度→知名度が低い順）
   * をそのまま使うため、this.currentSpots の元の順序を並べ替え元とする。
   */
  getSortedSpots() {
    const spots = [...this.currentSpots];
    switch (this.currentSortOrder) {
      case 'price':
        return spots.sort((a, b) => a.source_round_trip_fare - b.source_round_trip_fare);
      case 'duration':
        return spots.sort(
          (a, b) => (a.source_ride_duration_min ?? Infinity) - (b.source_ride_duration_min ?? Infinity)
        );
      case 'distance':
        return spots.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
      case 'recommended':
      default:
        return spots;
    }
  }

  /**
   * 指定した予算の帯（予算−¥200より高く、予算以下）に、スポットが1件以上
   * 見つかるかを判定する。findNearestBudgetsWithResults()の内部ヘルパー。
   * 帯判定はスポット単位（各スポットの最安往復運賃）で行う（performSearch()と同じ規則）。
   */
  async hasBandResults(budget) {
    const { bandSpots } = await this.computeSearchResult(this.currentDepartureStationId, budget);
    return bandSpots.length > 0;
  }

  /**
   * 指定した予算の帯が0件だったとき、上下それぞれ一番近い「結果がある予算」を探す
   * （2026-10-06、帯表示への変更に伴い旧findSmallestBudgetWithSpots()を置き換え）。
   *
   * 【背景】帯表示では「予算以下すべて」ではなく「予算−¥200より高く、予算以下」
   * だけを見せるため、ある予算の帯がたまたま0件でも、隣の帯には結果があることが
   * ある。上下どちらも¥100刻みで独立に探索し、見つかった方（片方だけのこともある）
   * をボタンとして提示する。計算はすべてローカルデータ参照のため、ブラウザ内で軽い。
   * @returns {Promise<{lower: number|null, higher: number|null}>}
   */
  async findNearestBudgetsWithResults(currentBudget) {
    let lower = null;
    for (let budget = currentBudget - BUDGET_STEP; budget >= MIN_BUDGET; budget -= BUDGET_STEP) {
      if (await this.hasBandResults(budget)) {
        lower = budget;
        break;
      }
    }
    let higher = null;
    for (let budget = currentBudget + BUDGET_STEP; budget <= MAX_BUDGET; budget += BUDGET_STEP) {
      if (await this.hasBandResults(budget)) {
        higher = budget;
        break;
      }
    }
    return { lower, higher };
  }

  /**
   * 検索結果0件のときの案内文を組み立てる。
   *
   * 【背景】2026-10-01のことでんバス運賃改定で、ＪＲ栗林駅から往復¥400で検索すると
   * 実際に0件になるケースが発生した（最低運賃が¥200→¥210になり、往復¥400を
   * 超えたため）。これは値上げの正しい結果であり、予算の上限・刻み幅（CLAUDE.md
   * 「予算の上限が低いことは仕様」参照）を変える理由にはならない。
   *
   * 【2026-10-06 帯表示への変更】帯表示では「到達駅はあるが帯の中にはない」と
   * 「到達駅自体がない」を利用者が区別する意味がなくなった（どちらも「この帯では
   * 行ける場所がない」という同じ結論になるため）ため、メッセージを一本化し、
   * 上下の次の帯をボタンで提示する形に変えた。
   *
   * 【2026-10-07修正】上の一本化は言い過ぎだった：予算以下にスポットが1件も
   * 無いとき（本当にどこにも行けない）と、予算以下にはスポットがあるが
   * この帯にだけ無いとき（もっと安く行ける場所しかない）を同じ文言で
   * 「見つかりませんでした」と言うと、後者が「どこにも行けない」と誤読される
   * （Minamiさんが公開ページで発見。例：魚津駅前の往復¥1000）。
   * （67本目で、この出し分けは「どちらの向きに結果があるか」の文に置き換えた）
   *
   * 【2026-10-29、67本目、Minami決定】結果画面の「¥◯で探す」は59本目でなくしたため、0件のときの「往復¥◯で探す」
   * ボタンもやめた。代わりに、結果がある向き（下・上）へ−・＋で金額を変えればよいことを文で伝える
   * （findNearestBudgetsWithResults()で、どちらの向きに結果があるかだけを使う）。
   */
  async buildNoResultsMessage() {
    // 【59本目】＋−で一覧が今の金額に合わせて変わるため、検索した金額ではなく一覧の金額で出す
    const budget = this.listBudget ?? this.currentBudget;
    const { lower, higher } = await this.findNearestBudgetsWithResults(budget);
    const band = `¥${formatThousands(budget - BAND_WIDTH + 1)}〜¥${formatThousands(budget)}`;
    let hint;
    if (lower !== null && higher !== null) hint = '−で金額を下げるか、＋で上げてみてください。';
    else if (lower !== null) hint = '−で金額を下げてみてください。';
    else if (higher !== null) hint = '＋で金額を上げてみてください。';
    else hint = `この駅からは、¥${formatThousands(MAX_BUDGET)}までで行ける場所が見つかりませんでした。`;
    return `<p class="no-results">${band} で行ける場所はありません。${hint}</p>`;
  }

  /**
   * config/support-badge.jsonから読んだ応援マークの閾値（1日◯便以下）。
   * 取得前・取得失敗時はDEFAULT_SUPPORT_BADGE_MAX_TRIPSにフォールバックする
   * （spot-finder.jsのsitelinks閾値フォールバックと同じ考え方）。
   */
  getSupportBadgeMaxTrips() {
    const value = window.EMBEDDED_SUPPORT_BADGE_CONFIG?.max_trips_per_day;
    return typeof value === 'number' ? value : DEFAULT_SUPPORT_BADGE_MAX_TRIPS;
  }

  /**
   * スポットのアクセス区間の便数情報を解決する（route-details.jsonに
   * ビルド時に埋め込み済みの値を引くだけ）。spotのsource_*フィールドから
   * fare-calculator.jsのcalculateReachable()が返す「駅」相当の形へ組み立て直す。
   * @returns {{tripCount:number, dayCode:number, demandCount:number, routeId:string}|null}
   */
  getSpotFrequency(spot) {
    if (!this.data?.routeDetails || !this.currentDepartureStationId) return null;
    const stationLike = {
      reachBy: spot.source_reach_by,
      transferAt: spot.source_transfer_at,
      viaOperator: spot.source_via_operator,
      legOperators: spot.source_leg_operators,
      station_id: spot.source_station_id,
    };
    return estimateTripFrequency(this.data.routeDetails, this.currentDepartureStationId, stationLike);
  }

  /**
   * カード・詳細画面・共有文で共通して使う、便数まわりの表示情報一式を組み立てる。
   * 便数が解決できない場合（経路未確定等）はnullを返し、呼び出し側は便数関連の
   * 表示を一切出さない（無言で0件等の誤った数字を出さないため）。
   */
  buildFrequencyDisplay(spot) {
    const freq = this.getSpotFrequency(spot);
    if (!freq) return null;
    const maxTrips = this.getSupportBadgeMaxTrips();
    const dayLabel = formatDayLabel(freq.dayCode);
    const word = operatorLabelWord(this.data.routeInfo, freq.routeId);
    return {
      tripCount: freq.tripCount,
      dayLabel,
      word,
      isBadgeEligible: freq.tripCount <= maxTrips,
      hasDemand: freq.demandCount > 0,
    };
  }

  /** カードの応援マーク＋説明枠（バッジ対象のときだけ） */
  renderSupportBadge(info) {
    if (!info || !info.isBadgeEligible) return '';
    return `
      <div class="support-badge" aria-hidden="false">
        <span class="support-badge-heart">${HEART_FILLED_SVG}この路線を応援</span>
      </div>
      <p class="support-badge-note">${info.dayLabel}1日${info.tripCount}便の${info.word}で行けます。あなたが乗ることが、この路線を支える力になります。${info.hasDemand ? '要予約の便があります。' : ''}</p>
    `;
  }

  /** バッジ対象でないカードにも小さく出す便数（例："平日1日12便"） */
  renderSmallFrequencyNote(info) {
    if (!info || info.isBadgeEligible) return '';
    return `<p class="spot-frequency-note">${info.dayLabel}1日${info.tripCount}便${info.hasDemand ? '・要予約の便あり' : ''}</p>`;
  }

  /**
   * 一覧部分のみを再描画する。並び替え時は表示対象スポットの集合が
   * 変わらないため地図は呼び出し元で再描画しない。
   * カードのクリック／ホバーは initUI で一覧全体に委譲済みのため、
   * ここでは個々のカードへのリスナー登録は不要。
   * 0件時の案内文組み立てが非同期（findSmallestBudgetWithSpots）のため、
   * このメソッド自体も非同期にしている。
   */
  async renderResultsList() {
    // 【2026-10-26、61本目、不具合修正】カードを作り直すと、マウスが乗っていたカードは「離れた」（mouseout）を
    // 出さないまま消えるため、そのピンの強調（大きく・一番上）が地図に残り続けた（59本目から＋−のたびに一覧を
    // 作り直すようになって表に出た。オレンジのピンが出発駅の印より上に出たままになる）。作り直す前に外す。
    this.mapView.clearHighlights?.();
    if (this.currentSpots.length === 0) {
      this.elements.resultsList.innerHTML = await this.buildNoResultsMessage();
      return;
    }

    const spots = this.getSortedSpots();

    const html = spots
      .map(spot => {
        const fav = isFavorite(spot.id);
        const freqInfo = this.buildFrequencyDisplay(spot);
        return `
        <div class="spot-card${freqInfo?.isBadgeEligible ? ' spot-card-supported' : ''}" data-spot-id="${spot.id}">
          <div class="spot-card-actions">
            <button type="button" class="favorite-btn${fav ? ' favorite-btn-active' : ''}" data-spot-id="${spot.id}" aria-pressed="${fav}" aria-label="${fav ? 'マイリストから外す' : 'マイリストに保存'}">${starIconHtml(fav)}</button>
            <button type="button" class="share-btn" data-spot-id="${spot.id}" aria-label="共有">${shareIconHtml()}</button>
          </div>
          <span class="new-tag spot-card-new" hidden>NEW</span>
          ${renderSpotImageHtml(spot, 'spot-image')}
          <h3>${spot.name}</h3>
          <p class="spot-description">${this.formatDescription(spot)}</p>
          <p class="spot-summary">${this.formatSpotSummary(spot)}</p>
          ${this.renderSupportBadge(freqInfo)}
          ${this.renderSmallFrequencyNote(freqInfo)}
          <button class="detail-btn" data-spot-id="${spot.id}">詳細を見る</button>
        </div>
      `;
      })
      .join('');

    this.elements.resultsList.innerHTML = html;
    // 【51本目】地図でオレンジになっている場所に「NEW」の印を付ける。
    this.updateNewSpotMarks(parseInt(this.elements.budgetInput.value, 10));

    // 一覧の再描画でカードのDOMが作り直されるため、選択中のスポットが
    // あれば（アプリ全体で1つだけ持つthis.selectedSpotIdを正として）
    // ハイライトを再適用する
    if (this.selectedSpotId) {
      this.highlightCard(this.selectedSpotId);
    }
  }

  /**
   * カードの「往復¥400・約12分・0.5km」形式の要約行。
   * 予算は往復の交通費（帰りも同額と仮定）なので、比較対象と揃えて往復額を表示する。
   * 所要時間が経路未確定でnullの場合は運賃・距離のみ表示する。
   */
  formatSpotSummary(spot) {
    const parts = [`往復¥${spot.source_round_trip_fare}`];
    if (typeof spot.source_ride_duration_min === 'number') {
      parts.push(`約${spot.source_ride_duration_min}分`);
    }
    parts.push(`${spot.distance?.toFixed(1) ?? '不明'}km`);
    return parts.join('・');
  }

  /** 一覧パネルの選択状態を更新（地図側のピン選択と連動） */
  highlightCard(spotId) {
    this.elements.resultsList.querySelectorAll('.spot-card').forEach((card) => {
      card.classList.toggle('spot-card-selected', card.getAttribute('data-spot-id') === spotId);
    });
    this.scrollSelectedCardIntoView();

    // 【2026-10-11、6本目B】地図の点を押したとき、該当カードを2秒ほど
    // 光らせる（Minami決定）。前の光りが終わる前に別のカードが押された
    // 場合に備え、既存のタイマー・クラスをまず片付けてから付け直す。
    if (this._glowTimer) {
      clearTimeout(this._glowTimer);
      this.elements.resultsList.querySelector('.spot-card-glow')?.classList.remove('spot-card-glow');
    }
    const card = this.elements.resultsList.querySelector(`.spot-card[data-spot-id="${spotId}"]`);
    if (card) {
      card.classList.add('spot-card-glow');
      this._glowTimer = setTimeout(() => {
        card.classList.remove('spot-card-glow');
        this._glowTimer = null;
      }, 2000);
    }
  }

  /**
   * 地図で選択中のスポットに対応するカードが見えるよう、#results-list の
   * 内部だけをスムーズスクロールする。ページ全体やレイアウトが動かないよう、
   * scrollIntoView（祖先要素を巻き込みうる）は使わず、#results-list自身の
   * scrollTo()で完結させている。
   *
   * スマホで「地図」タブを見ている間はこのタブパネルがdisplay:noneのため
   * サイズが0になり位置計算ができない。その場合は何もせず、
   * 「一覧」タブに切り替えられたタイミング（LayoutControllerの
   * onListTabActivated経由）で改めて呼び出される。
   *
   * 【2026-10-13、22本目修正、Cowork指摘】以前はthis.mapView.selectedSpotId
   * （2D側だけが持つ状態）を見ていたため、3Dでピンを選んだときは一覧が
   * スクロールしなかった。アプリ全体で1つだけ持つthis.selectedSpotIdを見る
   * （2D・3Dどちらの選択でもこの値が更新される。onSelectionChange参照）。
   */
  scrollSelectedCardIntoView() {
    const spotId = this.selectedSpotId;
    if (!spotId) return;

    const list = this.elements.resultsList;
    // 帯より安い「薄い色のピン」は一覧にカードが無いため、ここで静かに
    // 終わる（エラーにしない。Minami指示）。
    const card = list.querySelector(`.spot-card[data-spot-id="${spotId}"]`);
    if (!card) return;

    const listRect = list.getBoundingClientRect();
    if (listRect.height === 0) return; // 非表示中（地図タブ表示中など）

    const cardRect = card.getBoundingClientRect();
    const isFullyVisible = cardRect.top >= listRect.top && cardRect.bottom <= listRect.bottom;
    if (isFullyVisible) return;

    const offsetWithinList = cardRect.top - listRect.top;
    const centeredScrollTop =
      list.scrollTop + offsetWithinList - (listRect.height - cardRect.height) / 2;
    list.scrollTo({ top: Math.max(0, centeredScrollTop), behavior: 'smooth' });
  }

  /**
   * spotIdからスポット詳細画面を開く（地図ポップアップの「詳細を見る」ボタン用）。
   * 【2026-10-11、6本目A】地図のピンは帯の外（予算以下だが帯未満＝「cheaper」）の
   * スポットも薄い色で表示しており（map-view.js・terrain-map-view.jsのapplyBudget
   * 参照）、その場所を選んで「詳細を見る」を押しても、ここが帯だけのthis.currentSpots
   * しか探していなかったため該当スポットが見つからず、ボタンを押しても何も起きない
   * （実クリックのPlaywrightテストで発覚）不具合があった。帯の内外どちらも含む
   * this.currentAllSpots（地図のピン自体と同じ集合）から探すよう修正した。
   */
  openSpotDetailById(spotId) {
    const spot = this.currentAllSpots.find((s) => s.id === spotId);
    if (spot) {
      this.detailHistory = []; // 一覧からの新規の詳細表示なので「この先へ」の履歴をリセットする
      history.pushState({}, ''); // スマホの戻る操作で一覧に戻れるよう、履歴を1つ積む
      this.showSpotDetail(spot);
    }
  }

  /**
   * 【64本目、Minami決定】地図のピン（1つずつのピン）を押したとき。以前は地図の上に名前の帯（名前・往復運賃・
   * 「詳細を見る」）を出していたが、文字が小さく気づきにくかったためやめた。
   * - PC：左のパネルにその場所の詳細を出す（閉じていたら開く。showSpotDetail()）。一覧へ戻る道は今の足あとのまま。
   * - スマホ：下の一覧（小）を、その場所の大きめのカード1枚に入れ替える（showSheetSpotCard()）。大のときは、
   *   今までどおり一覧の中のカードを光らせるだけ（highlightCard()）。
   * 2D・3Dの切り替えで選び直したとき（reapplySelectionAfterModeSwitch()）は呼ばない（_reapplyingSelection）。
   * すでにその場所を出しているときは何もしない。
   */
  onPinSelected(spotId) {
    if (!spotId || this._reapplyingSelection) return;
    const spot = this.currentAllSpots?.find((s) => s.id === spotId);
    if (!spot) return;
    if (window.matchMedia('(min-width: 760px)').matches) {
      if (this.elements.appLayout.getAttribute('data-view') === 'detail' && this._currentDetailSpot?.id === spotId) return;
      this.detailHistory = []; // 地図から新しく開いたので「この先へ」の履歴はリセットする（一覧から開いたときと同じ）
      // 詳細を出している間にほかのピンを押したときは、戻る操作の履歴を積み増さない（戻る1回で一覧に戻る）
      if (this.elements.appLayout.getAttribute('data-view') !== 'detail') history.pushState({}, '');
      this.showSpotDetail(spot);
      return;
    }
    if (this.layoutController?.isSheetLarge()) return;
    if (this.elements.sheetSpotCard && !this.elements.sheetSpotCard.hidden
      && this.elements.sheetSpotCard.dataset.spotId === spotId) return;
    this.showSheetSpotCard(spot);
  }

  /**
   * 【64本目、Minami決定】スマホでピンを押したときの、下の一覧（小）に入れ替えて出す大きめのカード（写真・名前・
   * NEWの札・往復の金額・片道の時間・「詳細を見る」・×）。地図は狭くしない：入れ替える前の下の一覧の高さに
   * 固定し、その中に収める（低い画面＝.sheet-compactでは写真を省いて1行にする。style.css）。
   */
  showSheetSpotCard(spot) {
    const card = this.elements.sheetSpotCard;
    const sheet = document.querySelector('.results-sheet');
    const layout = this.elements.appLayout;
    if (!card || !sheet) return;
    if (!layout.classList.contains('sheet-spot')) {
      const h = sheet.getBoundingClientRect().height;
      if (h > 0) sheet.style.height = `${Math.round(h)}px`;
    }
    const fare = spot.source_round_trip_fare;
    const fareText = typeof fare === 'number' ? `往復¥${formatThousands(fare)}` : '運賃不明';
    const minutes = typeof spot.source_ride_duration_min === 'number' ? `片道 約${spot.source_ride_duration_min}分` : '';
    const searched = this.currentBudget;
    const isNew = pinCategory(fare, parseInt(this.elements.budgetInput.value, 10), searched, this._mapPrevSearchedBudget ?? searched) === 'orange';
    card.dataset.spotId = spot.id;
    card.innerHTML = `
      ${renderSpotImageHtml(spot, 'sheet-spot-image')}
      <div class="sheet-spot-body">
        <p class="sheet-spot-title"><strong class="sheet-spot-name" title="${spot.name}">${spot.name}</strong>${isNew ? '<span class="new-tag sheet-spot-new">NEW</span>' : ''}</p>
        <p class="sheet-spot-fare">${fareText}</p>
        ${minutes ? `<p class="sheet-spot-meta">${minutes}</p>` : ''}
        <button type="button" class="sheet-spot-detail-btn">詳細を見る</button>
      </div>
      <button type="button" class="sheet-spot-close" aria-label="閉じる">×</button>
    `;
    card.querySelector('.sheet-spot-detail-btn').addEventListener('click', () => {
      this.openSpotDetailById(spot.id); // 大にして詳細を出す（showSpotDetail()がsetSheetLarge(true)を呼び、カードは閉じる）
    });
    card.querySelector('.sheet-spot-close').addEventListener('click', () => this.clearPinSelection());
    card.hidden = false;
    layout.classList.add('sheet-spot');
  }

  /** 【64本目】スマホの場所のカードを閉じ、下の一覧（小）を元に戻す（ピンの選択はそのまま）。 */
  hideSheetSpotCard() {
    const card = this.elements.sheetSpotCard;
    if (!card || card.hidden) return;
    card.hidden = true;
    card.innerHTML = '';
    delete card.dataset.spotId;
    this.elements.appLayout.classList.remove('sheet-spot');
    const sheet = document.querySelector('.results-sheet');
    if (sheet) sheet.style.height = '';
  }

  /** 【64本目】地図の何もないところを押したとき：スマホで場所のカードを出していたら、元の小に戻す。 */
  onMapBackgroundClick() {
    if (window.matchMedia('(min-width: 760px)').matches) return;
    if (!this.elements.sheetSpotCard || this.elements.sheetSpotCard.hidden) return;
    this.clearPinSelection();
  }

  /**
   * ピンの選択をやめる（カードの×・地図の何もないところ・検索し直し・予算操作のいずれからも呼ぶ）。
   * スマホの場所のカードを閉じ、ピンの強調（2D・3D両方）も合わせて外す（Minami指示）。
   */
  clearPinSelection() {
    this.hideSheetSpotCard();
    this.mapView.clearSelected();
    this.terrainMapView?.clearSelected();
    this.selectedSpotId = null;
  }

  /**
   * 【2026-10-13、12本目②A、Minami決定：A＋C】検索成功時の要約バー文言
   * （例：「富山駅前・往復¥1,200」）。PCでは要約バー自体をCSSで常に非表示に
   * するため、ここでは出発駅名・予算の整形だけ行えばよい。
   */
  updateSearchSummaryText(departureStationId, budget) {
    if (!this.elements.searchSummaryText) return;
    const name = this.data.stations?.[departureStationId]?.display_name || this.lastSearchedDepartureText || '';
    this.elements.searchSummaryText.textContent = `${name}・往復¥${formatThousands(budget)}`;
    // 【58本目】PCの一覧パネルは「出発：○○」、閉じたときの細いバーは「○○から」（見本②③。CSSで出し分ける）
    const dep = this.elements.resultsDeparture;
    if (dep) {
      const openText = document.createElement('span');
      openText.className = 'results-departure-open';
      openText.append('出発：');
      const b = document.createElement('b');
      b.textContent = name;
      openText.append(b);
      const closedText = document.createElement('span');
      closedText.className = 'results-departure-closed';
      closedText.textContent = `${name}から`;
      dep.replaceChildren(openText, closedText);
    }
    // 【64本目】スマホの1行のカードでは、「出発地を変える」のボタンを駅名＋▾として見せる（style.css）
    const station = this.elements.searchSummaryToggle?.querySelector('.summary-toggle-station');
    if (station) station.textContent = name;
    this.elements.searchSummaryToggle?.setAttribute('aria-label', `出発地を変える（今は${name}）`);
  }

  /**
   * 【2026-10-13、12本目②A、Minami決定：A＋C】スマホの検索フォーム開閉。
   * .layout-leftへform-collapsedクラスを付け外しするだけで、実際の表示/
   * 非表示はCSS（@media (max-width: 759px)）側に任せる（PCはCSSが要約バー
   * 自体を常に非表示にするため、このクラスの有無に関わらず常にフォームが
   * 見える＝影響しない）。
   * @param {boolean} collapsed
   */
  /**
   * 【2026-10-20、35本目、不具合修正】フォームを開いた時点の地図カメラ
   * （2D：中心・ズーム、3D：中心・ズーム・傾き・向き）を覚えておく。
   * closeFormDiscardingEdits()で「編集前にまったく戻す」ために使う。
   * 【不具合修正】地図タブを一度も開いていない間（Leafletが一度も
   * setView()/fitBounds()されておらず_loadedがfalseの状態。
   * forceMarkerReposition()のコメント参照）にmap.getCenter()を呼ぶと
   * 「Set map center and zoom first.」を投げる。これが
   * #search-summary-toggleのクリックハンドラ内（setFormCollapsed(false)の
   * 直前）で起きると、以降の行が実行されずフォームが開かなくなる不具合が
   * 実機相当の検証で見つかった（0件検索後、地図タブを一度も開かずに
   * 「条件を変える」を押す経路で再現）。カメラのスナップショットは
   * 無くても動作に支障が無い付随機能のため、例外はtry/catchで吸収し
   * フォームが開かなくなる事態を避ける。
   */
  captureCameraSnapshot() {
    const snap = {};
    try {
      if (this.mapView?.map) {
        snap.map2d = { center: this.mapView.map.getCenter(), zoom: this.mapView.map.getZoom() };
      }
    } catch { /* 地図タブを一度も開いていない等、位置が未確定なら諦める */ }
    try {
      if (this.terrainMapView?.map) {
        snap.map3d = {
          center: this.terrainMapView.map.getCenter(),
          zoom: this.terrainMapView.map.getZoom(),
          pitch: this.terrainMapView.map.getPitch(),
          bearing: this.terrainMapView.map.getBearing(),
        };
      }
    } catch { /* 同上 */ }
    return snap;
  }

  /** captureCameraSnapshot()で覚えた状態へ、アニメーションなしで即座に戻す。 */
  restoreCameraSnapshot(snap) {
    if (!snap) return;
    if (snap.map2d && this.mapView?.map) {
      this.mapView.map.setView(snap.map2d.center, snap.map2d.zoom, { animate: false });
    }
    if (snap.map3d && this.terrainMapView?.map) {
      this.terrainMapView.map.jumpTo(snap.map3d);
    }
  }

  /**
   * 【2026-10-17、32本目A／2026-10-20、35本目】フォームを開いている間に
   * 閉じる共通処理。検索はせず、最後に検索した条件に戻してから畳む
   * （入力しかけた出発駅・予算は捨てる、Minami指示）。「▲閉じる」ボタンと、
   * フォームの外（地図・タブ・一覧等）をタップしたときの両方から呼ぶ。
   */
  closeFormDiscardingEdits() {
    if (this.lastSearchedDepartureText !== null) {
      this.elements.departureInput.value = this.lastSearchedDepartureText;
    }
    this.elements.departureSuggestions.innerHTML = '';
    if (this.lastSearchedBudget !== null) {
      this.elements.budgetInput.value = this.lastSearchedBudget;
      this.updateBudgetUI();
      // 【2026-10-20、35本目、不具合修正】編集中の予算操作（スライダー等）が
      // 到達円のライブプレビューと「地図を合わせる」予約
      // （scheduleFitCircleToView()、32本目B）を既に動かしていることがある。
      // 入力欄の表示を戻すだけではこれらは戻らず、フォームを閉じた後（地図を
      // タップして閉じた場合も含む）、捨てたはずの編集の予算に合わせて地図が
      // 遅れて動いてしまう不具合があった（地図タップでフォームを閉じる検証で
      // 発覚：「そのタップでは地図を動かさない」はずなのに、タップ自体とは
      // 無関係な保留中のタイマーが後から発火し、地図が動いていた）。
      // 【不具合修正】保留中のタイマーをキャンセルするだけでは、デバウンスの
      // 猶予（0.15秒）が既に経過して地図合わせが始まって（あるいは完了して）
      // しまっていた場合に直せない（捨てたい編集の予算に向けて、既に地図が
      // 動き始めている／動き終わっている）。円の見た目を最後に検索した予算へ
      // 戻すこと（userTouch:falseで新たな地図合わせの予約はしない）と、
      // 保留中タイマーのキャンセルに加えて、フォームを開いた時点のカメラへ
      // 無アニメーションで戻すことで、進行中・完了済みのどちらの場合も
      // 確実に「編集前と同じ」に戻す。
      this.updateMapBudgetLive(this.lastSearchedBudget, { userTouch: false });
      this.mapView._cancelFitCircleToView();
      this.terrainMapView?._cancelFitCircleToView();
    }
    this.restoreCameraSnapshot(this._cameraSnapshotBeforeFormEdit);
    this._cameraSnapshotBeforeFormEdit = null;
    this.setFormCollapsed(true);
  }

  /**
   * 【2026-10-26、58本目】PCの結果画面で、左の一覧パネルを開く・閉じる（閉じると地図の左上の細いバー、見本②③）。
   * 見えている範囲（57本目のア）が変わるため、地図が最後に円に合わせたときのままなら、新しい見えている範囲の
   * 真ん中へ出発駅を合わせ直す（map-view.js・terrain-map-view.jsのhandleVisibleAreaChanged()）。
   * ＋−・検索し直し・「条件を変える」をまたいで状態は変えない（layout-controller.jsが覚えている）。
   * @param {boolean} open
   */
  setResultsListOpen(open) {
    this.changeVisibleArea(() => this.layoutController?.setResultsListOpen(open));
  }

  /**
   * 【2026-10-26、59本目】スマホの結果画面の下の一覧を大・小にする（見本⑤⑥）。見えている範囲が変わるため、
   * 一覧の開け閉めと同じ決まり（A）で地図を合わせ直す。PCでは何もしない。
   * @param {boolean} large
   */
  setSheetLarge(large) {
    // 【64本目】大にするときは場所のカードを閉じる（大では一覧の中のカードで見せる。ピンの選択はそのまま）
    this.changeVisibleArea(() => {
      if (large) this.hideSheetSpotCard();
      // 【66本目、不具合修正】詳細を出したまま（大）つまみで小に戻すと、詳細は小では出さないため下の一覧がつまみだけ
      // （22px）になり、そこでピンを押しても場所のカードがその中に隠れて見えなかった（411×473）。小に戻すときは一覧の
      // 表示へ戻す（ピンの選択・地図の位置はそのまま。「地図で見る」と同じ）。
      else if (this.elements.appLayout.getAttribute('data-view') === 'detail' && !window.matchMedia('(min-width: 760px)').matches) {
        this.elements.appLayout.setAttribute('data-view', 'results');
      }
      return this.layoutController?.setSheetLarge(large);
    });
  }

  /**
   * 【59本目】見えている範囲が変わる操作（applyがtrueを返したら変わった）。変わる前の見えている範囲の真ん中を
   * 覚えておき、2D・3Dに知らせる（handleVisibleAreaChanged()：円に合わせたままなら合わせ直す、利用者が
   * 動かしたあとなら、それまで真ん中にあった場所を新しい真ん中へ横にずらす。59本目、Minami決定：A）。
   * @param {() => boolean} apply
   */
  changeVisibleArea(apply) {
    const before2d = this.mapView.captureVisibleCenter();
    const before3d = this.terrainMapView?.captureVisibleCenter() ?? null;
    if (!apply()) return;
    requestAnimationFrame(() => {
      this.mapView.handleVisibleAreaChanged(before2d);
      this.terrainMapView?.handleVisibleAreaChanged(before3d);
    });
  }

  setFormCollapsed(collapsed) {
    if (!this.elements.layoutLeft) return;
    this.elements.layoutLeft.classList.toggle('form-collapsed', collapsed);
    // 【56本目】検索カードと結果の入れ物は兄弟のため、出し分けは#app-layoutのクラスで行う。
    this.elements.appLayout?.classList.toggle('form-collapsed', collapsed);
    // 【2026-10-17、32本目A】#search-summary-toggleは「開く」専用（常に
    // 「▼条件を変える」）になったため、文言の付け替えはしない。「閉じる」は
    // #form-close-btn（常に「▲閉じる」、CSS側でcollapsed時のみ非表示）が担う。
    this.elements.searchSummaryToggle?.setAttribute('aria-expanded', String(!collapsed));
  }

  /**
   * スマホ本体の戻る操作（popstate）から呼ばれる。「この先へ」で辿った履歴が
   * あれば直前のスポット詳細に戻す（1回で1つ前に戻る。足あとのクリックと同じ
   * 「この先へ」の位置までスクロール）。履歴が無ければ一覧に戻す。
   */
  goBackInDetail() {
    if (this.detailHistory.length > 0) {
      const previousSpot = this.detailHistory.pop();
      this.showSpotDetail(previousSpot, { scrollTo: 'onward' });
    } else {
      this.showResultsList();
    }
  }

  /**
   * 「見てきた場所」の足あと（6本目E、Minami決定）。旧「← 一覧に戻る」
   * ボタンを置き換える。this.detailHistory（古い順）＋現在のスポットを
   * つなげた「一覧 ＞ A ＞ B ＞ 今の場所」を組み立てる。今の場所だけ
   * 太字・押せない。スマホ幅で3件を超えるときは中間を省略し「…」で開ける
   * （CSS側で.breadcrumb-middleを隠し、.breadcrumb-expandedで解除する）。
   */
  renderBreadcrumb() {
    const el = this.elements.detailBreadcrumb;
    if (!el) return;
    const trail = [...this.detailHistory, this._currentDetailSpot]; // 古い順、最後が今の場所
    const listItem = `<button type="button" class="breadcrumb-item breadcrumb-list-link" data-history-index="-1"><span aria-hidden="true">←</span> 一覧</button>`;
    const sep = '<span class="breadcrumb-sep" aria-hidden="true">＞</span>';

    // 中間（一覧の直後〜「1つ前」の手前まで）。スマホ幅ではここを省略する。
    const middleCount = trail.length - 2; // 現在地と「1つ前」を除いた件数
    const middleItems = [];
    for (let i = 0; i < trail.length - 2; i++) {
      middleItems.push(
        `<span class="breadcrumb-middle">${sep}<button type="button" class="breadcrumb-item" data-history-index="${i}">${trail[i].name}</button></span>`
      );
    }
    const ellipsis = middleCount > 0
      ? `<span class="breadcrumb-middle breadcrumb-middle-collapsed">${sep}<button type="button" class="breadcrumb-ellipsis" aria-label="途中の場所を表示">…</button></span>`
      : '';

    // 「1つ前」（現在地のひとつ前。中間を省略しても常に表示する）
    const prevItem = trail.length >= 2
      ? `${sep}<button type="button" class="breadcrumb-item" data-history-index="${trail.length - 2}">${trail[trail.length - 2].name}</button>`
      : '';

    // 【66本目、Minami決定】「見てきた場所」の見出しと今の場所の名前はやめ、1行の小さな「← 一覧」にする（名前はすぐ下の
    // 見出しで分かるため重ねない）。「この先へ」でたどった前の場所は、今までどおり「＞ 前の場所」として後ろに並べる。
    el.innerHTML = `<div class="breadcrumb-trail">${listItem}${ellipsis}${middleItems.join('')}${prevItem}</div>`;
  }

  /**
   * 足あとの「一覧」または途中の場所をクリックしたときに、そこまで一気に
   * 戻る（6本目E、Minami決定：2つ以上前に戻ったら後ろの足あとは消す）。
   * @param {number} index -1なら一覧、0以上ならdetailHistoryの該当位置
   */
  goToBreadcrumb(index) {
    if (index < 0) {
      this.detailHistory = [];
      history.pushState({}, '');
      this.showResultsList();
      return;
    }
    const targetSpot = this.detailHistory[index];
    if (!targetSpot) return;
    this.detailHistory = this.detailHistory.slice(0, index);
    history.pushState({}, '');
    this.showSpotDetail(targetSpot, { scrollTo: 'onward' });
  }

  /**
   * カード用の説明文を整形。100文字を超える場合のみ「...」を付与し、
   * 説明文が空の記事（スタブ記事）はWikipedia参照を促すフォールバックを表示する。
   */
  formatDescription(spot) {
    if (!spot.description) {
      return spot.wikipedia_url
        ? '詳細はWikipediaの記事を参照してください'
        : '詳細情報がありません';
    }
    return spot.description.length > 100
      ? `${spot.description.substring(0, 100)}...`
      : spot.description;
  }

  showResultsList() {
    this.elements.appLayout.setAttribute('data-view', 'results');
    // 【2026-10-11、5本目】「← 一覧に戻る」で、3Dのときは帯の点が見える
    // 俯瞰位置に戻す（Minami指示。fitToBudget自体の引きすぎ対策は
    // terrain-map-view.js参照）。2Dは元々寄らないため変化なし。
    // 【2026-10-20、39本目、Minami決定】以前はfitToBudget()（スポット座標基準・
    // 最低ズーム9.5）で戻していたが、「全体を見る」（37本目）と同じく検索した直後と
    // 同じ見え方（fitCircleToView()、0.75・傾き57°・向きは変えない）へ戻す。
    // 動きの長さは今までどおり0.6秒（「全体を見る」の1.5秒より短い、画面切替に伴う戻り）。
    // 2Dは詳細画面を開いても地図の中心・ズームを変えない（ピンを押したときの
    // revealAboveBand()も、ズームはそのままずらすだけ）ため、ここでは何もしない。
    // 【58本目】一覧を閉じているときはパネルを開く（3Dの合わせ直しより前に開き、開いた見えている範囲で合わせる）。
    this.setResultsListOpen(true);
    if (this.terrainMapView?.map) {
      this.terrainMapView.returnToSearchView({ durationMs: 600 });
    }
  }

  /**
   * 「この先へ」カードの運賃表記：「往復¥1,740（+¥120）」。差が0のときは
   * 「往復¥980（追加なし）」（Minami指示：「+¥0」という表記をやめる）。
   * スマホ幅では運賃欄の横幅が限られるため2行で折り返すが、金額と差額をそれぞれ
   * nowrapのspanに分けることで「（追加な」「し）」のような文字の途中での
   * 折り返しを防ぐ（2026-10-10、375px幅のスクリーンショット確認で発覚）。
   */
  formatOnwardFare(cand) {
    const fareText = `往復¥${formatThousands(cand.spot.source_round_trip_fare)}`;
    const diffText = cand.extraFare === 0 ? '追加なし' : `+¥${formatThousands(cand.extraFare)}`;
    return `<span class="onward-fare-amount">${fareText}</span><span class="onward-fare-diff">（${diffText}）</span>`;
  }

  /**
   * 「この先へ」カードの一言。種類ごとに文言を変える（Minami指示）。
   * - 同じ路線の先：「同じ電車/バス/便で約◯分先」（今の停留所→候補の停留所の所要時間。
   *   出せなければ「同じ電車/バス/便でその先」）。呼び方はGTFSのroute_typeで言い分ける
   *   （route-duration.jsのsameRouteWord()。0・1・2=電車、3=バス、それ以外=便）。
   *   【2026-10-10修正】ことでん志度線（route_type=2、鉄道）の候補が「同じバスで」と
   *   表示されていたのをMinamiが指摘、事業者名ではなくroute_typeで判定するよう修正。
   * - すぐ近く：「ここから歩いて約◯分」（直線距離÷時速4km。座標が無ければ空）
   * - 少し足せば：「ここから約◯km」
   */
  formatOnwardBlurb(cand) {
    if (cand.type === 'same-route') {
      const word = sameRouteWord(this.data.routeInfo, cand.routeId);
      return cand.sameRouteMinutes != null
        ? `同じ${word}で約${Math.round(cand.sameRouteMinutes)}分先`
        : `同じ${word}でその先`;
    }
    if (cand.type === 'nearby') {
      return cand.walkMinutes != null ? `ここから歩いて約${Math.round(cand.walkMinutes)}分` : '';
    }
    if (cand.type === 'stretch') {
      return cand.straightKm != null ? `ここから約${cand.straightKm.toFixed(1)}km` : '';
    }
    return '';
  }

  /**
   * 「この先へ」セクションのHTML（3本目機能）。暗い枠に、1件を横長1行にして3件
   * （デザイン③）：左に56px四方の小さい写真、中央に名前・一言、右に運賃。
   * 応援マーク対象の候補には小さいハートを名前の横に添える（2本目のオレンジ説明枠は
   * ここでは出さない。タップ後の詳細画面で確認できる）。
   * 候補が1件も無いとき（計算失敗・出発駅未確定時含む）はセクションごと省く。
   */
  renderOnwardSection(candidates) {
    if (!candidates || candidates.length === 0) return '';
    const cards = candidates.map((cand) => {
      const freqInfo = this.buildFrequencyDisplay(cand.spot);
      const heart = freqInfo?.isBadgeEligible ? `<span class="onward-heart">${HEART_FILLED_SVG}</span>` : '';
      return `
        <div class="onward-card" data-spot-id="${cand.spot.id}" role="button" tabindex="0">
          ${cand.spot.image
            ? `<img src="${cand.spot.image}" alt="${cand.spot.name}" class="onward-image">`
            : `<div class="onward-image spot-image-placeholder" aria-hidden="true">🏞️</div>`}
          <div class="onward-body">
            <div class="onward-name">${heart}${cand.spot.name}</div>
            <p class="onward-blurb">${this.formatOnwardBlurb(cand)}</p>
          </div>
          <p class="onward-fare">${this.formatOnwardFare(cand)}</p>
        </div>
      `;
    }).join('');
    return `
      <div class="onward-section">
        <h3 class="onward-title">この先へ</h3>
        <div class="onward-cards">${cards}</div>
      </div>
    `;
  }

  /**
   * @param {object} spot
   * @param {{scrollTo?: 'top'|'onward'}} [opts] - 'onward'は「この先へ」の
   *   位置までスクロールする（6本目E、Minami決定：前の場所に戻ったときは
   *   そこで辿った「この先へ」の位置を見せる）。新しい場所を開くとき
   *   （一覧から・この先へカードから・共有リンクから）は常に既定の'top'。
   */
  async showSpotDetail(spot, { scrollTo = 'top' } = {}) {
    this._currentDetailSpot = spot; // 詳細画面の☆・共有ボタンから参照する
    // 【58本目】詳細は一覧パネルの中に出すため、PCで一覧を閉じているときは開く
    this.setResultsListOpen(true);
    // 【59本目】スマホでは下の一覧を大にする（詳細は一覧の中に出すため）
    this.setSheetLarge(true);
    const routeInfoHtml = this.routeFormatter && this.currentDepartureStationId
      ? this.routeFormatter.format(this.currentDepartureStationId, spot)
      : '';
    const fav = isFavorite(spot.id);

    // 「この先へ」候補（3本目機能）。allSpots自体は検索時に計算済み・キャッシュ済みのため、
    // ここでの追加計算はルート・駅名等の軽量JSONを読むだけで済む（GTFS生データは読まない）。
    let onwardHtml = '';
    if (this.currentDepartureStationId && this.data?.routeDetails) {
      try {
        const { allSpots } = await this.computeSearchResult(this.currentDepartureStationId, MAX_BUDGET);
        const candidates = buildOnwardCandidates({
          routeDetails: this.data.routeDetails,
          routeSequences: this.data.routeSequences,
          departureStationId: this.currentDepartureStationId,
          allSpots,
          maxBudget: MAX_BUDGET,
        }, spot);
        onwardHtml = this.renderOnwardSection(candidates);
      } catch (error) {
        console.error('「この先へ」候補の計算に失敗:', error);
      }
    }

    // 【66本目、Minami決定】スクロールしなくても名前・写真・紹介文の最初の数行が見えるよう詰める：名前の行（右に☆・共有の
    // 小さなアイコンボタン、44px四方）→ 往復の金額・片道の時間・距離の1行 → 横幅いっぱいで低めの写真（押すと大きく見られる）
    // → 紹介文 → 「地図で見る」（スマホだけ）・ページビュー・行き方などの残り。
    const fare = spot.source_round_trip_fare;
    const metaParts = [
      typeof fare === 'number' ? `往復¥${formatThousands(fare)}` : null,
      typeof spot.source_ride_duration_min === 'number' ? `片道 約${spot.source_ride_duration_min}分` : null,
      isFiniteNumber(spot.distance) ? `駅から${spot.distance.toFixed(1)}km` : null,
    ].filter(Boolean);
    const imageHtml = spot.image
      ? `<button type="button" class="detail-image-btn" aria-label="写真を大きく見る">${renderSpotImageHtml(spot, 'detail-image')}</button>`
      : renderSpotImageHtml(spot, 'detail-image');
    const html = `
      <div class="detail-head">
        <div class="detail-head-text">
          <h2 class="detail-title">${spot.name}</h2>
          ${metaParts.length ? `<p class="detail-meta">${metaParts.map((t) => `<span>${t}</span>`).join('<span class="detail-meta-sep" aria-hidden="true">・</span>')}</p>` : ''}
        </div>
        <div class="detail-actions">
          <button type="button" class="favorite-btn detail-favorite-btn${fav ? ' favorite-btn-active' : ''}" data-spot-id="${spot.id}" aria-pressed="${fav}" aria-label="${fav ? 'マイリストから外す' : 'マイリストに保存'}" title="マイリスト">${starIconHtml(fav)}</button>
          <button type="button" class="share-btn detail-share-btn" data-spot-id="${spot.id}" aria-label="共有" title="共有">${shareIconHtml()}</button>
        </div>
      </div>
      ${imageHtml}
      <p class="detail-description">${spot.description || (spot.wikipedia_url ? '詳細はWikipediaの記事を参照してください' : 'より詳しい情報がありません')}</p>
      <button type="button" class="map-view-btn detail-map-btn" data-spot-id="${spot.id}">地図で見る</button>
      <p class="spot-pageviews">月間ページビュー数: ${spot.pageviews || 'データなし'}</p>
      ${routeInfoHtml}
      ${spot.wikipedia_url ? `<a href="${spot.wikipedia_url}" target="_blank" class="detail-wikipedia-btn">Wikipediaで詳しく見る</a>` : ''}
      ${onwardHtml}
      ${spot.wikidata_url ? `<a href="${spot.wikidata_url}" target="_blank" class="detail-wikidata-link">データの出典（Wikidata）</a>` : ''}
    `;

    this.elements.detailContent.innerHTML = html;
    this.elements.appLayout.setAttribute('data-view', 'detail');
    this.renderBreadcrumb();
    // 【2026-10-11、5本目→6本目Eで変更】新しい場所を開いたときは詳細画面の
    // 一番上（写真）から、前の場所に戻ったときはそこで辿った「この先へ」の
    // 位置から見せる（Minami決定）。showSpotDetail()はopenSpotDetailById・
    // goBackInDetail・openOnwardCandidate・goToBreadcrumbのすべてから
    // 呼ばれる唯一の入口のため、ここ1箇所で全経路をカバーできる。
    if (this.elements.detailContainer) {
      if (scrollTo === 'onward') {
        const onwardEl = this.elements.detailContent.querySelector('.onward-section');
        if (onwardEl) onwardEl.scrollIntoView({ block: 'start' });
        else this.elements.detailContainer.scrollTop = 0;
      } else {
        this.elements.detailContainer.scrollTop = 0;
      }
    }

    // 【2026-10-11、5本目】3Dのときだけ、詳細画面を開いたらその場所へ寄る
    // （Minami指示。2Dは今の動きのまま変えない）。
    if (this.terrainMapView?.map && isFiniteNumber(spot.latitude) && isFiniteNumber(spot.longitude)) {
      const departureStation = this.data?.stations?.[this.currentDepartureStationId];
      this.terrainMapView.flyToSpot(spot, departureStation);
    }

    this.elements.detailContent.querySelector('.detail-map-btn')?.addEventListener('click', () => {
      // スマホの「地図で見る」：地図タブへ切り替え、3Dが有効ならその場所へ寄る
      // （Minami指示）。2Dのときはタブ切替のみ（今の動きのまま）。
      // 【2026-10-11修正】#app-layout[data-view="detail"]のCSSはタブパネル
      // （#map-areaを含む）自体をdisplay:noneで隠すため、activateTab('map')
      // だけではタブの状態は切り替わっても地図は見えないままだった
      // （実機確認：boundingBoxがnullになる）。data-viewを"results"へ
      // 戻してから地図タブを有効にする。
      this.elements.appLayout.setAttribute('data-view', 'results');
      this.layoutController.activateTab('map');
      // 【64本目】スマホでは、詳細を出すときに大にした下の一覧を小に戻す（地図を見るための操作のため。大のままだと
      // 地図の6割が隠れ、ピンを押しても場所のカードが出ない）。このあと寄る（flyToSpot()）ため、開け閉めのときの
      // 地図の合わせ直し（changeVisibleArea()）は通さず、小に戻した見えている範囲で寄る。
      this.layoutController?.setSheetLarge(false);
      if (this.terrainMapView?.map) {
        const departureStation = this.data?.stations?.[this.currentDepartureStationId];
        this.terrainMapView.flyToSpot(spot, departureStation);
      }
    });

    this.elements.detailContent.querySelector('.detail-favorite-btn')?.addEventListener('click', () => {
      // toggleFavoriteForSpot()内でrefreshFavoriteButtons()が呼ばれ、
      // このボタン自体の見た目（押下状態・文言）も更新される。
      const saved = this.toggleFavoriteForSpot(spot);
      this.showToast(saved ? 'マイリストに保存しました' : 'マイリストから外しました');
    });
    this.elements.detailContent.querySelector('.detail-share-btn')?.addEventListener('click', () => {
      this.shareSpot(spot);
    });
    this.elements.detailContent.querySelector('.detail-image-btn')?.addEventListener('click', (ev) => {
      // 読み込みに失敗して写真の代わりの絵になっていたら開かない
      if (!ev.currentTarget.querySelector('img')) return;
      this.openPhotoViewer(spot);
    });

    // 「この先へ」カードのタップ：今のスポットを履歴に積んでから、候補の詳細へ移る
    // （戻るボタンでこのスポットの詳細に1タップで戻れるようにするため）。
    this.elements.detailContent.querySelectorAll('.onward-card').forEach((card) => {
      card.addEventListener('click', () => {
        const candidateId = card.getAttribute('data-spot-id');
        this.openOnwardCandidate(candidateId);
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.openOnwardCandidate(card.getAttribute('data-spot-id'));
        }
      });
    });
  }

  /**
   * 【66本目、Minami決定】詳細の写真を押したとき、画面いっぱいに大きく見せる（×・背景・Escで閉じる）。
   * 閉じたら写真のボタンへフォーカスを戻す。
   */
  openPhotoViewer(spot) {
    let viewer = document.getElementById('photo-viewer');
    if (!viewer) {
      viewer = document.createElement('div');
      viewer.id = 'photo-viewer';
      viewer.className = 'photo-viewer';
      viewer.hidden = true;
      viewer.setAttribute('role', 'dialog');
      viewer.setAttribute('aria-modal', 'true');
      viewer.innerHTML = '<img class="photo-viewer-image" alt=""><button type="button" class="photo-viewer-close" aria-label="閉じる">×</button>';
      document.body.appendChild(viewer);
      const close = () => {
        if (viewer.hidden) return;
        viewer.hidden = true;
        viewer.querySelector('.photo-viewer-image').removeAttribute('src');
        document.removeEventListener('keydown', viewer._onKey);
        this.elements.detailContent.querySelector('.detail-image-btn')?.focus();
      };
      viewer._close = close;
      viewer._onKey = (ev) => { if (ev.key === 'Escape') close(); };
      viewer.addEventListener('click', (ev) => { if (ev.target === viewer) close(); });
      viewer.querySelector('.photo-viewer-close').addEventListener('click', close);
    }
    const img = viewer.querySelector('.photo-viewer-image');
    img.src = spot.image;
    img.alt = spot.name;
    viewer.setAttribute('aria-label', `${spot.name}の写真`);
    viewer.hidden = false;
    document.addEventListener('keydown', viewer._onKey);
    viewer.querySelector('.photo-viewer-close').focus();
  }

  /**
   * 「この先へ」カードのタップ時に、候補スポットの詳細画面へ移る。
   * 今表示中のスポットを履歴に積んでから、allSpots（計算済み）からQIDで探して開く。
   */
  async openOnwardCandidate(candidateId) {
    if (!candidateId || !this.currentDepartureStationId) return;
    try {
      const { allSpots } = await this.computeSearchResult(this.currentDepartureStationId, MAX_BUDGET);
      const candidate = allSpots.find((s) => s.id === candidateId);
      if (!candidate) return;
      if (this._currentDetailSpot) this.detailHistory.push(this._currentDetailSpot);
      history.pushState({}, ''); // スマホの戻る操作で1つ前の詳細に戻れるよう、履歴を1つ積む
      this.showSpotDetail(candidate);
    } catch (error) {
      console.error('「この先へ」候補の表示に失敗:', error);
    }
  }
}

/**
 * 景勝地の写真<img>を、読み込み失敗時のフォールバック付きで組み立てる。
 * 【2026-10-13、19本目修正、18本目の調査で判明】spot.imageのURLが存在しても
 * 実際の読み込みに失敗することがあり、従来はonerrorハンドラが無かったため
 * ブラウザ標準の壊れた画像アイコンになっていた（spot.imageが元々無い場合の
 * 「写真がないときの絵」プレースホルダーとは別経路で、そちらには出ない）。
 * onerrorで同じプレースホルダーに差し替える。
 * カード・詳細画面・マイリストとも同じカードHTML組み立て経路を通るため、
 * ここ1箇所を直せば全箇所に効く。
 * @param {{image: string|null, name: string}} spot
 * @param {string} className - "spot-image" または "detail-image"
 */
function renderSpotImageHtml(spot, className) {
  if (!spot.image) {
    return `<div class="${className} spot-image-placeholder" aria-hidden="true">🏞️</div>`;
  }
  return `<img src="${spot.image}" alt="${spot.name}" class="${className}" onerror="this.outerHTML='<div class=&quot;${className} spot-image-placeholder&quot; aria-hidden=&quot;true&quot;>🏞️</div>'">`;
}

/** GTFSの日付形式（YYYYMMDD）を "YYYY-MM-DD" に整形する */
export function formatGtfsDate(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) return yyyymmdd || '不明';
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/**
 * 【2026-10-13、18本目、Minami決定：A】出典画面の「フィード版」を短く表示する。
 * GTFS変換ソフト「その筋屋」が付与する利用条件の注意書き（日本バス情報協会の
 * 関係者・支持者は利用禁止、CCライセンスでの登録禁止、等）が、一部の事業者の
 * feed_versionにそのまま含まれていることがある（対象7件、詳細はCLAUDE.md
 * 「その筋屋の注意書きの扱い」参照）。データは使い続けると判断したが、画面には
 * 原文を出さず日付（＋改正と分かる語があればそれ）だけを短く示す。
 * data-sources.json自体のfeed_versionは変更しない（表示だけで短くする）。
 *
 * 抽出規則：
 * 1. 先頭が「YYYY/MM/DD」（GTFS出力日時の形式）→ その日付をそのまま使う
 * 2. 文中に「YYYY年MM月DD日」（その筋屋の説明欄の形式）→ その日付を使う
 * 3. どちらにも一致しなければ null を返す（「フィード版」の項目自体を
 *    呼び出し側で出さない。【19本目修正】期間で代わりに表示すると
 *    「フィード版：2026-09-01〜2027-08-31 ／ 対象期間：2026-09-01〜2027-08-31」
 *    のように同じ期間が2回並んで出ていたため）
 * 日付が取れた場合、feed_version中に「改正」の語があれば末尾に付ける
 * （「運賃改定」等、"改正"を含まない語は付けない＝原文の言い回しを増幅しない）。
 * @returns {string|null}
 */
export function formatFeedVersionShort(feedVersion) {
  if (!feedVersion) return null;
  const slashMatch = feedVersion.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  const kanjiMatch = !slashMatch && feedVersion.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  const m = slashMatch || kanjiMatch;
  if (!m) return null;
  const [, y, mo, d] = m;
  const dateStr = `${y}/${mo.padStart(2, '0')}/${d.padStart(2, '0')}`;
  return feedVersion.includes('改正') ? `${dateStr}改正` : dateStr;
}

/**
 * フッターの「データ出典：」に載せる公開元名の一覧を、実際に使用したフィードの
 * feed_publisher_name から重複除去して組み立てる（固定文言のハードコード禁止）。
 * 3件を超える場合は「A、B、C ほかN件」に省略する。
 */
function formatPublisherList(feeds) {
  const names = [];
  for (const feed of feeds) {
    const name = feed.feed_publisher_name || feed.operator_name;
    if (name && !names.includes(name)) names.push(name);
  }
  if (names.length === 0) return '出典情報を取得できませんでした';
  if (names.length <= 3) return names.join('、');
  return `${names.slice(0, 3).join('、')} ほか${names.length - 3}件`;
}

// アプリ起動
window.addEventListener('DOMContentLoaded', () => {
  new ReverseTravel();
});
