/**
 * main.js - 逆引き旅行アプリ UIロジック
 * 検索画面、結果表示、スポット詳細を管理
 */

import { GTFSLoader } from './gtfs-loader.js';
import { FareCalculator } from './fare-calculator.js';
import { SpotFinder } from './spot-finder.js';
import { RouteFormatter } from './route-formatter.js';
import { MapView } from './map-view.js';
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

/** 予算→帯の表示ラベル（例: budget=1000 → "¥801〜¥1000"） */
function formatBandLabel(budget) {
  return `¥${budget - BAND_WIDTH + 1}〜¥${budget}`;
}

// ☆（マイリスト）・共有ボタンの線画アイコン（2026-10-09、文字"★"/"☆"/"⇧"から
// SVGに変更。Minamiさんの指示：カード・詳細画面・マイリストの3か所とも揃える）。
// 色はアイコンを包む<span>自身のcolorで決める（fill="currentColor"がボタンの
// 文字色を継承して意図しない色になるのを避けるため、.icon-starクラス側で
// color を明示的に指定し直している。CSS側を参照）。
const STAR_OUTLINE_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
const STAR_FILLED_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
const SHARE_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v13"/><path d="m8 6 4-4 4 4"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7"/></svg>';

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
    this.mapView.onDetailRequest = (spotId) => this.openSpotDetailById(spotId);
    this.mapView.onSelectionChange = (spotId) => this.highlightCard(spotId);
    this.data = null;
    this.dataLoadFailed = false;
    this.cache = new Map(); // 検索結果のメモリキャッシュ（駅ID×予算）
    this.currentDepartureStationId = null;
    this.currentDepartureStationName = null;
    this.currentDeparturePrefCode = null; // お気に入り保存・共有URL組み立てに使う（prefCodeそのものは検索結果に含まれないため別途保持）
    this.currentSpots = []; // 検索結果（おすすめ順、地図のピンもこの集合のまま）
    this.currentReachableCount = 0; // 帯内の到達駅数（デバッグ・将来利用のため保持。表示の分岐には使わない）
    this.currentBudget = null; // 帯の見出し・0件時のボタン計算に使う直近の検索予算
    this.currentHasCheaperSpots = false; // 帯は0件だが、予算以下にはスポットがあるか（0件案内文の出し分けに使う）
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
      searchForm: document.getElementById('search-form'),
      departureInput: document.getElementById('departure-input'),
      departureSuggestions: document.getElementById('departure-suggestions'),
      budgetInput: document.getElementById('budget-input'),
      budgetDisplay: document.getElementById('budget-display'),
      budgetDecrement: document.getElementById('budget-decrement'),
      budgetIncrement: document.getElementById('budget-increment'),
      searchBtn: document.getElementById('search-btn'),
      appLayout: document.getElementById('app-layout'),
      sortSelect: document.getElementById('sort-select'),
      departureGuidance: document.getElementById('departure-guidance'),
      bandHeading: document.getElementById('results-band-heading'),
      resultsList: document.getElementById('results-list'),
      detailContent: document.getElementById('detail-content'),
      backBtn: document.getElementById('back-btn'),
      aboutBtn: document.getElementById('about-data-btn'),
      aboutModal: document.getElementById('about-modal'),
      aboutModalClose: document.getElementById('about-modal-close'),
      howtoBtn: document.getElementById('howto-btn'),
      howtoModal: document.getElementById('howto-modal'),
      howtoModalClose: document.getElementById('howto-modal-close'),
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

    this.layoutController = new LayoutController({
      mapEl: document.getElementById('spots-map'),
      desktopSlot: document.getElementById('map-slot-desktop'),
      mobileSlot: document.getElementById('map-slot-mobile'),
      tabButtons: document.querySelectorAll('.tab-btn'),
      tabPanels: document.querySelectorAll('.tab-panel'),
      mapView: this.mapView,
      // スマホで地図タブ→一覧タブに切り替えたとき、選択中のカードが
      // 見える位置に来るようにする（地図タブ表示中はパネルがdisplay:noneで
      // 位置計算ができないため、タブが有効化された時点で改めて実行する）
      onListTabActivated: () => this.scrollSelectedCardIntoView(),
    });

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

    this.updateBudgetUI();

    this.elements.backBtn.addEventListener('click', () => {
      this.showResultsList();
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
      // 0件のときに出す「往復¥Xで探す」ボタン（findNearestBudgetsWithResults参照）。
      // 押された予算で予算欄を更新し、そのまま再検索する。
      const retryBtn = e.target.closest('.budget-retry-btn');
      if (retryBtn) {
        const budget = parseInt(retryBtn.getAttribute('data-budget'), 10);
        this.elements.budgetInput.value = budget;
        this.updateBudgetUI();
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
          ? `現在は${prefectures.join('・')}に対応しています。対応している路線は「出典の詳細」で確認できます。`
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

        return `
          <li>
            <strong>${publisher}</strong>（${feed.source_category_label}）
            <span class="feed-meta">公開元サイト：${publisherLink}</span>
            <span class="feed-meta">フィード版：${feed.feed_version || '不明'} ／ 対象期間：${period}</span>
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
  }

  updateBudgetUI() {
    const input = this.elements.budgetInput;
    const min = parseInt(input.min, 10);
    const max = parseInt(input.max, 10);
    const value = parseInt(input.value, 10);

    this.elements.budgetDisplay.textContent = `¥${value}`;
    this.elements.budgetDecrement.disabled = value <= min;
    this.elements.budgetIncrement.disabled = value >= max;
    this.updateSearchButtonState();
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
      btn.textContent = '検索';
      return;
    }
    const currentText = this.elements.departureInput.value;
    const currentBudget = parseInt(this.elements.budgetInput.value, 10);
    const changed = currentText !== this.lastSearchedDepartureText || currentBudget !== this.lastSearchedBudget;
    btn.classList.toggle('search-btn-pending', changed);
    btn.textContent = changed ? 'この条件で検索' : '検索';
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
    this.elements.departureSuggestions.style.left = `${rect.left}px`;
    this.elements.departureSuggestions.style.top = `${rect.bottom}px`;
    this.elements.departureSuggestions.style.width = `${rect.width}px`;
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
    const text = buildSpotShareText(
      spot.name,
      this.currentDepartureStationName,
      spot.source_round_trip_fare,
      typeof spot.source_ride_duration_min === 'number' ? spot.source_ride_duration_min : null,
      url
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
   * 【2026-10-03修正】以前は`!this.loader.stationIndex`（駅一覧がまだ読み込み中、
   * ＝失敗ではない）を「読み込みに失敗しました」と同じ扱いにしていた。
   * 「読み込み中」と「失敗」を区別し、読み込み中なら完了を待って自動的に
   * 検索を続行する（もう一度ボタンを押させない）。失敗の文言は実際に
   * fetchが失敗したとき（dataLoadFailed===true）だけ出す。
   */
  async performSearch() {
    if (this.dataLoadFailed) {
      alert('データの読み込みに失敗しました。ページを再読み込みしてください。');
      return;
    }
    if (!this.loader.stationIndex) {
      this.showLoadingMessage();
      await this.stationIndexPromise;
      if (this.dataLoadFailed) {
        alert('データの読み込みに失敗しました。ページを再読み込みしてください。');
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
      alert('データの読み込みに失敗しました。ページを再読み込みしてください。');
      return;
    }

    try {
      const result = await this.computeSearchResult(stationId, budget);
      this.displayResults(result.bandSpots, stationId, prefCode, result.reachableCount, budget, result.hasCheaperSpots);
    } catch (error) {
      console.error('検索失敗:', error);
      alert('検索中にエラーが発生しました');
    }
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
    console.log('到達可能駅:', reachableStations);

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
    console.log('発見スポット（予算以下すべて、各スポットの最安運賃を採用）:', allSpots);

    const bandSpots = allSpots.filter((s) => s.source_round_trip_fare > budget - BAND_WIDTH);
    console.log(`帯（¥${budget - BAND_WIDTH + 1}〜¥${budget}）内のスポット:`, bandSpots);

    // 【2026-10-07追加】帯が0件のときの案内文を出し分けるため、「予算以下には
    // 何かあるが、この帯には無い」のか「予算以下に何も無い」のかを覚えておく
    // （buildNoResultsMessage()参照）。
    const hasCheaperSpots = allSpots.length > bandSpots.length;

    const result = { allSpots, bandSpots, reachableCount: reachableStations.length, hasCheaperSpots };
    this.cache.set(cacheKey, result);
    return result;
  }

  displayResults(spots, departureStationId, prefCode, reachableCount, budget, hasCheaperSpots) {
    this.currentDepartureStationId = departureStationId;
    this.currentDeparturePrefCode = prefCode ? String(prefCode).padStart(2, '0') : null;
    this.currentDepartureStationName = this.data.stations?.[departureStationId]?.display_name || departureStationId;
    this.currentSpots = spots;
    this.currentReachableCount = reachableCount;
    this.currentBudget = budget;
    this.currentHasCheaperSpots = !!hasCheaperSpots;
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
      this.elements.bandHeading.textContent = `往復${formatBandLabel(budget)}で行ける場所`;
      this.elements.bandHeading.hidden = false;
    }

    const departureStation = this.data.stations?.[departureStationId];
    this.mapView.render(departureStation, spots);

    this.renderResultsList();
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
      const { allSpots } = await this.computeSearchResult(stationId, MAX_BUDGET);
      const spot = allSpots.find((s) => s.id === qid);
      if (!spot) return false;

      const alignedBudget = Math.min(
        MAX_BUDGET,
        Math.max(MIN_BUDGET, Math.ceil(spot.source_round_trip_fare / BUDGET_STEP) * BUDGET_STEP)
      );
      const { bandSpots, reachableCount, hasCheaperSpots } = await this.computeSearchResult(stationId, alignedBudget);
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

      this.displayResults(bandSpots, stationId, prefCode, reachableCount, alignedBudget, hasCheaperSpots);
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
   * this.currentHasCheaperSpots（performSearch()が設定）で両者を出し分ける。
   */
  async buildNoResultsMessage() {
    const budget = this.currentBudget;
    const { lower, higher } = await this.findNearestBudgetsWithResults(budget);

    let html = this.currentHasCheaperSpots
      ? `<p class="no-results">この駅からは、往復¥${budget - BAND_WIDTH}以下で行ける場所しかありません。</p>`
      : `<p class="no-results">往復${formatBandLabel(budget)}で行ける場所は見つかりませんでした。</p>`;
    if (lower !== null || higher !== null) {
      html += '<div class="no-results-actions">';
      if (lower !== null) {
        html += `<button type="button" class="budget-retry-btn" data-budget="${lower}">往復¥${lower}で探す</button>`;
      }
      if (higher !== null) {
        html += `<button type="button" class="budget-retry-btn" data-budget="${higher}">往復¥${higher}で探す</button>`;
      }
      html += '</div>';
    }
    return html;
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
    if (this.currentSpots.length === 0) {
      this.elements.resultsList.innerHTML = await this.buildNoResultsMessage();
      return;
    }

    const spots = this.getSortedSpots();

    const html = spots
      .map(spot => {
        const fav = isFavorite(spot.id);
        return `
        <div class="spot-card" data-spot-id="${spot.id}">
          <div class="spot-card-actions">
            <button type="button" class="favorite-btn${fav ? ' favorite-btn-active' : ''}" data-spot-id="${spot.id}" aria-pressed="${fav}" aria-label="${fav ? 'マイリストから外す' : 'マイリストに保存'}">${starIconHtml(fav)}</button>
            <button type="button" class="share-btn" data-spot-id="${spot.id}" aria-label="共有">${shareIconHtml()}</button>
          </div>
          ${spot.image
            ? `<img src="${spot.image}" alt="${spot.name}" class="spot-image">`
            : `<div class="spot-image spot-image-placeholder" aria-hidden="true">🏞️</div>`}
          <h3>${spot.name}</h3>
          <p class="spot-description">${this.formatDescription(spot)}</p>
          <p class="spot-summary">${this.formatSpotSummary(spot)}</p>
          <button class="detail-btn" data-spot-id="${spot.id}">詳細を見る</button>
        </div>
      `;
      })
      .join('');

    this.elements.resultsList.innerHTML = html;

    // 一覧の再描画でカードのDOMが作り直されるため、選択中のスポットが
    // あれば（地図側の状態を正として）ハイライトを再適用する
    if (this.mapView.selectedSpotId) {
      this.highlightCard(this.mapView.selectedSpotId);
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
   */
  scrollSelectedCardIntoView() {
    const spotId = this.mapView.selectedSpotId;
    if (!spotId) return;

    const list = this.elements.resultsList;
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

  /** spotIdからスポット詳細画面を開く（地図ポップアップの「詳細を見る」ボタン用） */
  openSpotDetailById(spotId) {
    const spot = this.currentSpots.find((s) => s.id === spotId);
    if (spot) this.showSpotDetail(spot);
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
  }

  showSpotDetail(spot) {
    this._currentDetailSpot = spot; // 詳細画面の☆・共有ボタンから参照する
    const routeInfoHtml = this.routeFormatter && this.currentDepartureStationId
      ? this.routeFormatter.format(this.currentDepartureStationId, spot)
      : '';
    const fav = isFavorite(spot.id);

    const html = `
      <h2>${spot.name}</h2>
      <div class="detail-actions">
        <button type="button" class="favorite-btn detail-favorite-btn${fav ? ' favorite-btn-active' : ''}" data-spot-id="${spot.id}" aria-pressed="${fav}" aria-label="${fav ? 'マイリストから外す' : 'マイリストに保存'}">${starIconHtml(fav)}<span class="btn-label">${fav ? '保存済み' : 'マイリストに保存'}</span></button>
        <button type="button" class="share-btn detail-share-btn" data-spot-id="${spot.id}" aria-label="共有">${shareIconHtml()}<span class="btn-label">共有</span></button>
      </div>
      ${spot.image
        ? `<img src="${spot.image}" alt="${spot.name}" class="detail-image">`
        : `<div class="detail-image spot-image-placeholder" aria-hidden="true">🏞️</div>`}
      <p>${spot.description || (spot.wikipedia_url ? '詳細はWikipediaの記事を参照してください' : 'より詳しい情報がありません')}</p>
      <p class="spot-pageviews">月間ページビュー数: ${spot.pageviews || 'データなし'}</p>
      <p class="spot-distance">最寄駅からの距離: ${spot.distance?.toFixed(1) || '不明'}km</p>
      ${routeInfoHtml}
      ${spot.wikidata_url ? `<a href="${spot.wikidata_url}" target="_blank">Wikidataで見る</a>` : ''}
      ${spot.wikipedia_url ? `<a href="${spot.wikipedia_url}" target="_blank">Wikipediaで見る</a>` : ''}
    `;

    this.elements.detailContent.innerHTML = html;
    this.elements.appLayout.setAttribute('data-view', 'detail');

    this.elements.detailContent.querySelector('.detail-favorite-btn')?.addEventListener('click', () => {
      // toggleFavoriteForSpot()内でrefreshFavoriteButtons()が呼ばれ、
      // このボタン自体の見た目（押下状態・文言）も更新される。
      const saved = this.toggleFavoriteForSpot(spot);
      this.showToast(saved ? 'マイリストに保存しました' : 'マイリストから外しました');
    });
    this.elements.detailContent.querySelector('.detail-share-btn')?.addEventListener('click', () => {
      this.shareSpot(spot);
    });
  }
}

/** GTFSの日付形式（YYYYMMDD）を "YYYY-MM-DD" に整形する */
function formatGtfsDate(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) return yyyymmdd || '不明';
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
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
