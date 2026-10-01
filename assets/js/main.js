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
    this.currentReachableCount = 0; // 0件時の案内文の出し分けに使う（到達駅0件/スポット0件を区別）
    this.currentSortOrder = 'recommended';

    this.initUI();
    this.loadData();
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
   * data-sources.json（generate-data-sources-manifest.js参照）から描画する。
   * ここに固定文言をハードコードしない。実際に使ったフィードの情報だけを
   * そのまま表示することで、表示内容と実データの食い違いを構造的に防ぐ。
   *
   * 本番ビルドは window.EMBEDDED_DATA_SOURCES に埋め込み済み（同期）。
   * 開発モード（index.htmlを直接開く場合）はデータが埋め込まれないため
   * fetchでフォールバックする（gtfs-loader.js の開発モード分岐と同じ考え方）。
   */
  renderDataSources() {
    if (typeof window.EMBEDDED_DATA_SOURCES !== 'undefined') {
      this.populateDataSources(window.EMBEDDED_DATA_SOURCES);
      return;
    }
    fetch('data/derived/data-sources.json')
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

    // 対応地域（使い方モーダル）はフィード一覧と独立した項目のため、
    // フィードが読めなかった場合でも可能な限り描画する。
    if (coverageEl) {
      const prefectures = manifest?.coverage?.prefectures;
      coverageEl.textContent =
        Array.isArray(prefectures) && prefectures.length > 0
          ? `現在は${prefectures.join('・')}に対応しています（全国対応へ拡大予定）。`
          : '対応地域の情報を取得できませんでした。';
    }

    const feeds = manifest?.feeds;
    if (!Array.isArray(feeds) || feeds.length === 0) {
      if (summaryEl) summaryEl.textContent = '';
      if (listEl) listEl.innerHTML = '<li>データ出典情報を生成できませんでした。ビルドをご確認ください。</li>';
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

  async loadData() {
    try {
      this.data = await this.loader.loadAll();
      this.fareCalc = new FareCalculator(this.data);
      this.spotFinder = new SpotFinder(this.data);
      this.routeFormatter = new RouteFormatter(this.data.routeInfo, this.data.routeDetails, this.data.stations);
      console.log('✅ 全データロード完了');
    } catch (error) {
      console.error('❌ データロード失敗:', error);
      this.dataLoadFailed = true;
      // #results-container は検索前は非表示のままなので、エラー表示自体を
      // 隠さないよう明示的に表示状態へ切り替える
      this.elements.appLayout.classList.add('has-results');
      this.elements.resultsList.innerHTML =
        '<p class="error">データの読み込みに失敗しました。ページを再読み込みしてください。</p>';
    }
  }

  showDepartureSuggestions(input) {
    if (!input || !this.data) {
      this.elements.departureSuggestions.innerHTML = '';
      return;
    }

    // プラットフォーム単位のstop_idではなく、駅ID単位で候補を出す。
    // 検索・表示は display_name で行うが、選択後に内部で使う識別子は
    // 駅名文字列ではなく安定した駅ID（同名衝突の心配がない）にする。
    const entries = Object.entries(this.data.stations || {});
    const filtered = entries
      .filter(([, station]) => station.display_name.toLowerCase().includes(input.toLowerCase()))
      .slice(0, 10);

    const html = filtered
      .map(([stationId, station]) => `<div class="suggestion-item" data-station-id="${stationId}" data-station-name="${station.display_name}">${station.display_name}</div>`)
      .join('');

    this.elements.departureSuggestions.innerHTML = html;

    // クリックリスナー
    this.elements.departureSuggestions.querySelectorAll('.suggestion-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const stationId = e.target.getAttribute('data-station-id');
        const stationName = e.target.getAttribute('data-station-name');
        this.elements.departureInput.value = stationName;
        this.elements.departureInput.dataset.stationId = stationId;
        this.elements.departureSuggestions.innerHTML = '';
      });
    });
  }

  async performSearch() {
    if (this.dataLoadFailed || !this.data) {
      alert('データの読み込みに失敗しました。ページを再読み込みしてください。');
      return;
    }

    const stationId = this.elements.departureInput.dataset.stationId;
    const budget = parseInt(this.elements.budgetInput.value, 10);

    if (!stationId || !budget) {
      alert('出発駅と予算を選択してください');
      return;
    }

    // キャッシュチェック（メモリ上のMapのみ。ページを離れると消える軽量キャッシュで足りる）
    const cacheKey = `route_${stationId}_${budget}`;
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      this.displayResults(cached.spots, stationId, cached.reachableCount);
      return;
    }

    try {
      // 到達可能な駅を計算
      const reachableStations = await this.fareCalc.calculateReachable(stationId, budget);
      console.log('到達可能駅:', reachableStations);

      // 周辺スポット検索
      const spots = await this.spotFinder.findSpots(reachableStations);
      console.log('発見スポット:', spots);

      // キャッシュ保存（0件時の案内文の出し分けに到達駅数も使うため、spotsと一緒に保存する）
      this.cache.set(cacheKey, { spots, reachableCount: reachableStations.length });

      this.displayResults(spots, stationId, reachableStations.length);
    } catch (error) {
      console.error('検索失敗:', error);
      alert('検索中にエラーが発生しました');
    }
  }

  displayResults(spots, departureStationId, reachableCount) {
    this.currentDepartureStationId = departureStationId;
    this.currentDepartureStationName = this.data.stations?.[departureStationId]?.display_name || departureStationId;
    this.currentSpots = spots;
    this.currentReachableCount = reachableCount;
    this.currentSortOrder = 'recommended';
    this.elements.sortSelect.value = 'recommended';

    // 結果表示エリアをクリア（検索フォーム・地図の左カラムは常時表示のため触らない）。
    // 表示/非表示はすべてCSS（data-view属性・has-resultsクラス）に任せ、
    // ここではinline styleを直接いじらない（flex/blockの食い違いを防ぐため）
    this.elements.appLayout.setAttribute('data-view', 'results');
    this.elements.appLayout.classList.add('has-results');

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
   * 到達駅はあるがスポットが0件のとき、予算を¥100刻みで上げていき、実際に
   * スポットが1件以上見つかる最小の予算を探す（上限¥1000まで）。
   *
   * 【背景】最安運賃×2をそのまま提示すると、その最安の行き先の周りに
   * スポットが1件もない場合、案内した金額で検索してもやはり0件になり、
   * 案内が嘘になる。「実際に検索して1件以上出ることを確認した金額」だけを
   * 案内する。計算はすべてローカルデータ参照のため、ブラウザ内で軽い。
   * @returns {Promise<number|null>} 案内すべき往復予算。¥1000まで探しても
   *   見つからなければnull
   */
  async findSmallestBudgetWithSpots() {
    const MAX_BUDGET = 1000;
    const STEP = 100;
    const currentBudget = parseInt(this.elements.budgetInput.value, 10) || 0;
    const start = Math.max(200, (Math.floor(currentBudget / STEP) + 1) * STEP);

    for (let budget = start; budget <= MAX_BUDGET; budget += STEP) {
      const reachable = await this.fareCalc.calculateReachable(this.currentDepartureStationId, budget);
      if (reachable.length === 0) continue;
      const spots = await this.spotFinder.findSpots(reachable);
      if (spots.length > 0) return budget;
    }
    return null;
  }

  /**
   * 検索結果0件のときの案内文を組み立てる。
   *
   * 【背景】2026-10-01のことでんバス運賃改定で、ＪＲ栗林駅から往復¥400で検索すると
   * 実際に0件になるケースが発生した（最低運賃が¥200→¥210になり、往復¥400を
   * 超えたため）。これは値上げの正しい結果であり、予算の上限・刻み幅（CLAUDE.md
   * 「予算の上限が低いことは仕様」参照）を変える理由にはならない。一方で
   * 「該当するスポットが見つかりません」とだけ出て終わる画面は不親切なため、
   * 原因を「予算内に到達できる駅がない」場合と「到達できる駅はあるが近くに
   * スポットがない」場合とで出し分ける。
   */
  async buildNoResultsMessage() {
    if (this.currentReachableCount === 0) {
      const suggestedBudget = await this.findSmallestBudgetWithSpots();
      if (suggestedBudget !== null) {
        return `<p class="no-results">この予算では行ける場所がありません。${this.currentDepartureStationName}からは往復¥${suggestedBudget}から行けます。</p>`;
      }
      return `<p class="no-results">${this.currentDepartureStationName}からは往復¥1000以内で行ける場所が見つかりませんでした</p>`;
    }
    return '<p class="no-results">到達できる駅は見つかりましたが、近くに観光スポットが見つかりませんでした</p>';
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
