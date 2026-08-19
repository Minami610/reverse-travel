/**
 * main.js - 逆引き旅行アプリ UIロジック
 * 検索画面、結果表示、スポット詳細を管理
 */

import { GTFSLoader } from './gtfs-loader.js';
import { FareCalculator } from './fare-calculator.js';
import { SpotFinder } from './spot-finder.js';

class ReverseTravel {
  constructor() {
    this.loader = new GTFSLoader();
    this.fareCalc = null;
    this.spotFinder = null;
    this.data = null;
    this.dataLoadFailed = false;
    this.cache = new Map(); // localStorageの前段キャッシュ
    
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
      searchBtn: document.getElementById('search-btn'),
      resultsContainer: document.getElementById('results-container'),
      resultsList: document.getElementById('results-list'),
      detailContainer: document.getElementById('detail-container'),
      detailContent: document.getElementById('detail-content'),
      backBtn: document.getElementById('back-btn'),
    };

    // イベントリスナー設定
    this.elements.searchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.performSearch();
    });

    this.elements.departureInput.addEventListener('input', (e) => {
      this.showDepartureSuggestions(e.target.value);
    });

    this.elements.budgetInput.addEventListener('input', (e) => {
      this.elements.budgetDisplay.textContent = `¥${e.target.value}`;
    });

    this.elements.backBtn.addEventListener('click', () => {
      this.showResultsList();
    });
  }

  async loadData() {
    try {
      this.data = await this.loader.loadAll();
      this.fareCalc = new FareCalculator(this.data);
      this.spotFinder = new SpotFinder(this.data);
      console.log('✅ 全データロード完了');
    } catch (error) {
      console.error('❌ データロード失敗:', error);
      this.dataLoadFailed = true;
      this.elements.resultsContainer.innerHTML =
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

  displayResults(spots, departureStopId) {
    // 結果表示エリアをクリア
    this.elements.resultsContainer.style.display = 'block';
    this.elements.detailContainer.style.display = 'none';

    if (spots.length === 0) {
      this.elements.resultsList.innerHTML = '<p class="no-results">該当するスポットが見つかりません</p>';
      return;
    }

    const html = spots
      .map(spot => `
        <div class="spot-card" data-spot-id="${spot.id}">
          ${spot.image
            ? `<img src="${spot.image}" alt="${spot.name}" class="spot-image">`
            : `<div class="spot-image spot-image-placeholder" aria-hidden="true">🏞️</div>`}
          <h3>${spot.name}</h3>
          <p class="spot-description">${this.formatDescription(spot)}</p>
          <p class="spot-pageviews">月間PV: ${spot.pageviews || 'データなし'}</p>
          <p class="spot-distance">距離: ${spot.distance?.toFixed(1) || '不明'}km</p>
          <button class="detail-btn" data-spot-id="${spot.id}">詳細を見る</button>
        </div>
      `)
      .join('');

    this.elements.resultsList.innerHTML = html;

    // 詳細ボタンリスナー
    this.elements.resultsList.querySelectorAll('.detail-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const spotId = e.target.getAttribute('data-spot-id');
        const spot = spots.find(s => s.id === spotId);
        this.showSpotDetail(spot);
      });
    });
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
    this.elements.resultsContainer.style.display = 'block';
    this.elements.detailContainer.style.display = 'none';
  }

  showSpotDetail(spot) {
    const html = `
      <h2>${spot.name}</h2>
      ${spot.image
        ? `<img src="${spot.image}" alt="${spot.name}" class="detail-image">`
        : `<div class="detail-image spot-image-placeholder" aria-hidden="true">🏞️</div>`}
      <p>${spot.description || (spot.wikipedia_url ? '詳細はWikipediaの記事を参照してください' : 'より詳しい情報がありません')}</p>
      <p class="spot-pageviews">月間ページビュー数: ${spot.pageviews || 'データなし'}</p>
      <p class="spot-distance">最寄駅からの距離: ${spot.distance?.toFixed(1) || '不明'}km</p>
      ${spot.wikidata_url ? `<a href="${spot.wikidata_url}" target="_blank">Wikidataで見る</a>` : ''}
      ${spot.wikipedia_url ? `<a href="${spot.wikipedia_url}" target="_blank">Wikipediaで見る</a>` : ''}
    `;

    this.elements.detailContent.innerHTML = html;
    this.elements.resultsContainer.style.display = 'none';
    this.elements.detailContainer.style.display = 'block';
  }
}

// アプリ起動
window.addEventListener('DOMContentLoaded', () => {
  new ReverseTravel();
});
