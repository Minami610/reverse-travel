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
    this.currentSpots = []; // 検索結果（おすすめ順、地図のピンもこの集合のまま）
    this.currentReachableCount = 0; // 帯内の到達駅数（デバッグ・将来利用のため保持。表示の分岐には使わない）
    this.currentBudget = null; // 帯の見出し・0件時のボタン計算に使う直近の検索予算
    this.currentSortOrder = 'recommended';

    this.initUI();
    // initStationIndex()のPromiseを保持し、読み込み中にperformSearch()が
    // 呼ばれた場合はこれをawaitしてから続行する（「読み込み中」と「失敗」を
    // 区別するため。以前はthis.loader.stationIndexがまだnullというだけで
    // 「読み込みに失敗しました」を出してしまっていた）。
    this.stationIndexPromise = this.initStationIndex();
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
    };

    this.initModal(this.elements.aboutBtn, this.elements.aboutModal, this.elements.aboutModalClose);
    this.initModal(this.elements.howtoBtn, this.elements.howtoModal, this.elements.howtoModalClose);
    this.renderDataSources();

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
      this.showDepartureSuggestions(e.target.value);
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
   * フッターのボタンから開く軽量モーダル（出典・免責・問い合わせ／使い方）
   * 共通の開閉ロジック。hidden属性で表示/非表示を切り替える
   * （[hidden]{display:none!important}）。
   */
  initModal(triggerBtn, modal, closeBtn) {
    if (!triggerBtn || !modal) return;

    const open = () => {
      modal.hidden = false;
    };
    const close = () => {
      modal.hidden = true;
    };

    triggerBtn.addEventListener('click', open);
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
      });
    });
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

    const prefCode = this.elements.departureInput.dataset.prefCode;
    const localIndex = this.elements.departureInput.dataset.localIndex;
    const budget = parseInt(this.elements.budgetInput.value, 10);

    if (!prefCode || localIndex === undefined || !budget) {
      alert('出発駅と予算を選択してください');
      return;
    }

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

    // キャッシュチェック（メモリ上のMapのみ。ページを離れると消える軽量キャッシュで足りる）
    const cacheKey = `route_${stationId}_${budget}`;
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      this.displayResults(cached.spots, stationId, cached.reachableCount, budget);
      return;
    }

    try {
      // 到達可能な駅を計算（calculateReachable自体は従来どおり「予算以下すべて」を返す。
      // 乗換候補の選定がこの集合全体を見て行われるため、ここでは絞り込まない）
      const reachableStations = await this.fareCalc.calculateReachable(stationId, budget);
      console.log('到達可能駅:', reachableStations);

      // 【2026-10-06 帯表示】表示・スポット検索の対象は「予算−¥200より高く、
      // 予算以下」の帯だけに絞る。乗換の到達も、fare-calculator.js側で
      // roundTripFareに乗換2区間の合計往復運賃が入っているため、この1行の
      // 比較だけで直行・乗換の両方を正しく帯判定できる。
      const bandStations = reachableStations.filter((r) => r.roundTripFare > budget - BAND_WIDTH);
      console.log(`帯（¥${budget - BAND_WIDTH + 1}〜¥${budget}）内の到達駅:`, bandStations);

      // 周辺スポット検索（帯の中の到達駅だけを起点にする）
      const spots = await this.spotFinder.findSpots(bandStations);
      console.log('発見スポット:', spots);

      // キャッシュ保存（0件時の案内文の出し分けに到達駅数も使うため、spotsと一緒に保存する）
      this.cache.set(cacheKey, { spots, reachableCount: bandStations.length });

      this.displayResults(spots, stationId, bandStations.length, budget);
    } catch (error) {
      console.error('検索失敗:', error);
      alert('検索中にエラーが発生しました');
    }
  }

  displayResults(spots, departureStationId, reachableCount, budget) {
    this.currentDepartureStationId = departureStationId;
    this.currentDepartureStationName = this.data.stations?.[departureStationId]?.display_name || departureStationId;
    this.currentSpots = spots;
    this.currentReachableCount = reachableCount;
    this.currentBudget = budget;
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
   */
  async hasBandResults(budget) {
    const reachable = await this.fareCalc.calculateReachable(this.currentDepartureStationId, budget);
    const band = reachable.filter((r) => r.roundTripFare > budget - BAND_WIDTH);
    if (band.length === 0) return false;
    const spots = await this.spotFinder.findSpots(band);
    return spots.length > 0;
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
   */
  async buildNoResultsMessage() {
    const budget = this.currentBudget;
    const { lower, higher } = await this.findNearestBudgetsWithResults(budget);

    let html = `<p class="no-results">往復${formatBandLabel(budget)}で行ける場所は見つかりませんでした。</p>`;
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
      .map(spot => `
        <div class="spot-card" data-spot-id="${spot.id}">
          ${spot.image
            ? `<img src="${spot.image}" alt="${spot.name}" class="spot-image">`
            : `<div class="spot-image spot-image-placeholder" aria-hidden="true">🏞️</div>`}
          <h3>${spot.name}</h3>
          <p class="spot-description">${this.formatDescription(spot)}</p>
          <p class="spot-summary">${this.formatSpotSummary(spot)}</p>
          <button class="detail-btn" data-spot-id="${spot.id}">詳細を見る</button>
        </div>
      `)
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
    const routeInfoHtml = this.routeFormatter && this.currentDepartureStationId
      ? this.routeFormatter.format(this.currentDepartureStationId, spot)
      : '';

    const html = `
      <h2>${spot.name}</h2>
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
