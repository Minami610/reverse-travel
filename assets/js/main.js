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
    this.cache = new Map(); // localStorageの前段キャッシュ
    this.currentDepartureStationName = null;
    this.currentSpots = []; // 検索結果（おすすめ順、地図のピンもこの集合のまま）
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
    };

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
      this.routeFormatter = new RouteFormatter(this.data.routeInfo, this.data.routeDetails);
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

    // プラットフォーム単位のstop_idではなく、駅名単位で候補を出す
    const stationNames = Object.keys(this.data.stationsByName || {});
    const filtered = stationNames
      .filter(name => name.toLowerCase().includes(input.toLowerCase()))
      .slice(0, 10);

    const html = filtered
      .map(name => `<div class="suggestion-item" data-station-name="${name}">${name}</div>`)
      .join('');

    this.elements.departureSuggestions.innerHTML = html;

    // クリックリスナー
    this.elements.departureSuggestions.querySelectorAll('.suggestion-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const stationName = e.target.getAttribute('data-station-name');
        this.elements.departureInput.value = stationName;
        this.elements.departureInput.dataset.stationName = stationName;
        this.elements.departureSuggestions.innerHTML = '';
      });
    });
  }

  async performSearch() {
    if (this.dataLoadFailed || !this.data) {
      alert('データの読み込みに失敗しました。ページを再読み込みしてください。');
      return;
    }

    const stationName = this.elements.departureInput.dataset.stationName;
    const budget = parseInt(this.elements.budgetInput.value, 10);

    if (!stationName || !budget) {
      alert('出発駅と予算を選択してください');
      return;
    }

    // キャッシュチェック
    const cacheKey = `route_${stationName}_${budget}`;
    if (this.cache.has(cacheKey)) {
      this.displayResults(this.cache.get(cacheKey), stationName);
      return;
    }

    try {
      // 到達可能な駅を計算
      const reachableStations = await this.fareCalc.calculateReachable(stationName, budget);
      console.log('到達可能駅:', reachableStations);

      // 周辺スポット検索
      const spots = await this.spotFinder.findSpots(reachableStations);
      console.log('発見スポット:', spots);

      // キャッシュ保存
      this.cache.set(cacheKey, spots);

      // localStorageにも保存
      try {
        localStorage.setItem(cacheKey, JSON.stringify(spots));
      } catch (e) {
        console.warn('localStorage保存失敗:', e);
      }

      this.displayResults(spots, stationName);
    } catch (error) {
      console.error('検索失敗:', error);
      alert('検索中にエラーが発生しました');
    }
  }

  displayResults(spots, departureStationName) {
    this.currentDepartureStationName = departureStationName;
    this.currentSpots = spots;
    this.currentSortOrder = 'recommended';
    this.elements.sortSelect.value = 'recommended';

    // 結果表示エリアをクリア（検索フォーム・地図の左カラムは常時表示のため触らない）。
    // 表示/非表示はすべてCSS（data-view属性・has-resultsクラス）に任せ、
    // ここではinline styleを直接いじらない（flex/blockの食い違いを防ぐため）
    this.elements.appLayout.setAttribute('data-view', 'results');
    this.elements.appLayout.classList.add('has-results');

    const departureStation = this.data.stationsByName?.[departureStationName];
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
        return spots.sort((a, b) => a.source_fare - b.source_fare);
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
   * 一覧部分のみを再描画する。並び替え時は表示対象スポットの集合が
   * 変わらないため地図は呼び出し元で再描画しない。
   * カードのクリック／ホバーは initUI で一覧全体に委譲済みのため、
   * ここでは個々のカードへのリスナー登録は不要。
   */
  renderResultsList() {
    if (this.currentSpots.length === 0) {
      this.elements.resultsList.innerHTML = '<p class="no-results">該当するスポットが見つかりません</p>';
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
   * カードの「¥200・約12分・0.5km」形式の要約行。
   * 所要時間が経路未確定でnullの場合は運賃・距離のみ表示する。
   */
  formatSpotSummary(spot) {
    const parts = [`¥${spot.source_fare}`];
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
    const routeInfoHtml = this.routeFormatter && this.currentDepartureStationName
      ? this.routeFormatter.format(this.currentDepartureStationName, spot)
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

// アプリ起動
window.addEventListener('DOMContentLoaded', () => {
  new ReverseTravel();
});
