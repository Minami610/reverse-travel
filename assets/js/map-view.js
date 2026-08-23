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

export class MapView {
  constructor(containerId) {
    this.containerId = containerId;
    this.map = null;
    this.markersLayer = null;
    this.markersBySpotId = new Map();
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
   * @param {{stop_name: string, stop_lat: number, stop_lon: number}} departureStation
   * @param {Array} spots - latitude/longitude を持つスポット配列
   */
  render(departureStation, spots) {
    this.ensureMap();
    this.markersLayer.clearLayers();
    this.markersBySpotId.clear();
    this.selectedSpotId = null;

    const bounds = [];

    if (departureStation && isFiniteNumber(departureStation.stop_lat) && isFiniteNumber(departureStation.stop_lon)) {
      L.marker([departureStation.stop_lat, departureStation.stop_lon], {
        icon: createPinIcon('departure'),
        zIndexOffset: 2000,
      })
        .addTo(this.markersLayer)
        .bindTooltip(departureStation.stop_name, {
          permanent: true,
          direction: 'top',
          offset: [0, -16],
          className: 'map-departure-tooltip',
        })
        .bindPopup(`${departureStation.stop_name}（出発駅）`);
      bounds.push([departureStation.stop_lat, departureStation.stop_lon]);
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
      bounds.push([spot.latitude, spot.longitude]);
    });

    this.lastBounds = bounds;
    if (bounds.length > 0) {
      this.map.fitBounds(bounds, { padding: [36, 36], maxZoom: 16 });
    }

    // PC/スマホの切り替えやタブが非表示（display:none）のタイミングで
    // 呼ばれるとコンテナ寸法が0のままfitBoundsが不正確になるため、
    // 表示反映後（次フレーム）にサイズ再計算とfitBoundsのやり直しを行う
    requestAnimationFrame(() => {
      if (this.map) this.map.invalidateSize();
      this.refitBounds();
    });
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

function isFiniteNumber(value) {
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

function buildSpotPopupHtml(spot) {
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
