/**
 * map-view.js - 検索結果を俯瞰する地図（Leaflet + 国土地理院タイル）
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

const GSI_TILE_URL = 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png';
const GSI_ATTRIBUTION =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>';
// 予算の帯の幅（既存の検索・一覧と同じ定義）。main.jsにも同名の定数があるが、
// バンドル後は同じスクリプトスコープに連結されるため、名前が衝突しないよう
// このファイルだけMAP_BAND_WIDTHという別名にしている。
const MAP_BAND_WIDTH = 200;

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

    this.onDetailRequest = null; // (spotId) => void … ポップアップの「詳細を見る」ボタン
    this.onSelectionChange = null; // (spotId) => void … ピン選択と一覧パネルの連動用
  }

  ensureMap() {
    if (this.map) return;

    this.map = L.map(this.containerId, {
      scrollWheelZoom: true,
    });
    L.tileLayer(GSI_TILE_URL, {
      attribution: GSI_ATTRIBUTION,
      maxZoom: 18,
    }).addTo(this.map);
    this.markersLayer = L.layerGroup().addTo(this.map);

    // ポップアップ内の「詳細を見る」ボタンはHTML文字列として渡すため、
    // 開いたタイミングでイベントを後付けする
    this.map.on('popupopen', (e) => {
      const el = e.popup.getElement();
      const btn = el && el.querySelector('.popup-detail-btn');
      if (!btn) return;
      btn.addEventListener('click', () => {
        const spotId = btn.getAttribute('data-spot-id');
        if (this.onDetailRequest) this.onDetailRequest(spotId);
      });
    });
  }

  /**
   * @param {{display_name: string, stop_lat: number, stop_lon: number}} departureStation
   * @param {Array} spots - latitude/longitude を持つスポット配列（¥2000で一度取得したallSpots全体。
   *   予算の絞り込み・塗り分けはapplyBudget側で行うため、ここでは帯を絞らずそのまま渡す）
   * @param {number} [budget] - 初期表示の予算。省略時は2000
   */
  render(departureStation, spots, budget = 2000) {
    this.ensureMap();
    this.markersLayer.clearLayers();
    this.markersBySpotId.clear();
    this.fareBySpotId.clear();
    this.spotsLatLngById.clear();
    this.selectedSpotId = null;

    this.departureLatLng = null;
    if (departureStation && isFiniteNumber(departureStation.stop_lat) && isFiniteNumber(departureStation.stop_lon)) {
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
        })
        .bindPopup(`${departureStation.display_name}（出発駅）`);
      this.departureLatLng = [departureStation.stop_lat, departureStation.stop_lon];
    }

    spots.forEach((spot) => {
      if (!isFiniteNumber(spot.latitude) || !isFiniteNumber(spot.longitude)) return;

      const marker = L.marker([spot.latitude, spot.longitude], {
        icon: createPinIcon('spot'),
      })
        .addTo(this.markersLayer)
        .bindPopup(buildSpotPopupHtml(spot));

      marker.on('click', () => this.setSelected(spot.id));

      this.markersBySpotId.set(spot.id, marker);
      this.fareBySpotId.set(spot.id, spot.source_round_trip_fare);
      this.spotsLatLngById.set(spot.id, [spot.latitude, spot.longitude]);
    });

    this.applyBudget(budget);
    this.fitToBudget(budget, { animate: false });

    // PC/スマホの切り替えやタブが非表示（display:none）のタイミングで
    // 呼ばれるとコンテナ寸法が0のままfitBoundsが不正確になるため、
    // 表示反映後（次フレーム）にサイズ再計算とfitBoundsのやり直しを行う
    requestAnimationFrame(() => {
      if (this.map) this.map.invalidateSize();
      this.refitBounds();
    });
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
    if (!this.map || this.map.getSize().x === 0 || this.map.getSize().y === 0) {
      return bandCount;
    }

    this.markersBySpotId.forEach((marker, spotId) => {
      const fare = this.fareBySpotId.get(spotId);
      const el = marker.getElement();
      const pin = el && el.querySelector('.map-pin');
      if (!pin) return;
      const overBudget = fare > budget;
      const inBand = !overBudget && fare > budget - MAP_BAND_WIDTH;
      el.style.display = overBudget ? 'none' : '';
      pin.classList.toggle('map-pin-spot-in-band', inBand);
      pin.classList.toggle('map-pin-spot-cheaper', !overBudget && !inBand);
    });
    return bandCount;
  }

  /**
   * 予算以下（帯＋それより安い点）が全部入るよう、地図をなめらかに引く/寄せる。
   * スライダーを指から離したときに呼ぶ想定（Minami指示：動かしている間は
   * カメラを動かさない）。新規検索時（animate:false）は瞬時に合わせる。
   * @param {number} budget
   * @param {{animate?: boolean}} [opts]
   */
  fitToBudget(budget, { animate = true } = {}) {
    if (!this.map) return;
    const bounds = [];
    if (this.departureLatLng) bounds.push(this.departureLatLng);
    this.fareBySpotId.forEach((fare, spotId) => {
      if (fare <= budget) bounds.push(this.spotsLatLngById.get(spotId));
    });
    this.lastBounds = bounds;
    if (bounds.length === 0) return;
    // コンテナが0×0（地図タブを一度も開いていないスマホ等）の間は呼ばない
    // （applyBudget()と同じ理由。lastBoundsは保存済みのため、タブが開かれて
    // invalidateMapSize()のrefitBounds()が呼ばれた時点で正しく反映される）。
    if (this.map.getSize().x === 0 || this.map.getSize().y === 0) return;
    const options = { padding: [36, 36], maxZoom: 16 };
    if (animate) {
      this.map.flyToBounds(bounds, { ...options, duration: 0.6 });
    } else {
      this.map.fitBounds(bounds, options);
    }
  }

  /** 直近のbounds（出発駅＋スポット）に再フィットする。地図が非表示の間に
   * 描画された場合や、レイアウト切り替えでコンテナサイズが変わった際に使う */
  refitBounds() {
    if (this.map && this.lastBounds.length > 0) {
      this.map.fitBounds(this.lastBounds, { padding: [36, 36], maxZoom: 16 });
    }
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
    if (this.onSelectionChange) this.onSelectionChange(spotId);
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
  return L.divIcon({
    className: 'map-pin-wrapper',
    html: '<span class="map-pin map-pin-spot"></span>',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
    popupAnchor: [0, -7],
  });
}

export function buildSpotPopupHtml(spot) {
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
