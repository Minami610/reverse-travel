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
// 【2026-10-13、10本目②】予算の到達範囲の円・波の演出用の定数・関数。
// 同じ理由（バンドル後は同一スクリプトスコープ）で、他ファイル（onward-candidates.js
// 等）の同種の関数と衝突しない名前にしている。
const REACH_CIRCLE_LABEL_BEARING = 45; // ラベルを置く方位角（出発駅の吹き出しと重ならない向き）
const WAVE_DURATION_MS = 1000; // Minami指示：検索後、点を波のように出す所要時間（全体で1秒前後）
// 【2026-10-13、12本目①】選んだピンが下の情報帯（高さ40px前後）に隠れないよう、
// 地図をずらす量（px）。帯はスマホでは地図下端から48px浮かせて出すため
// （style.css参照）、帯の高さ＋余白を見込んだ値にする（PCは帯が地図の下端
// 近くに収まるため、この値より少なく済むが、同じ値でも実害はない）。
const REVEAL_ABOVE_BAND_OFFSET_PX = 90;
const EARTH_RADIUS_KM = 6371;
const toRadReach = (d) => (d * Math.PI) / 180;
const toDegReach = (r) => (r * 180) / Math.PI;

function reachHaversineKm(lat1, lon1, lat2, lon2) {
  const phi1 = toRadReach(lat1);
  const phi2 = toRadReach(lat2);
  const dPhi = toRadReach(lat2 - lat1);
  const dLambda = toRadReach(lon2 - lon1);
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function reachDestinationPoint(lat, lon, bearingDeg, distanceKm) {
  const delta = distanceKm / EARTH_RADIUS_KM;
  const theta = toRadReach(bearingDeg);
  const phi1 = toRadReach(lat);
  const lambda1 = toRadReach(lon);
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
  const lambda2 = lambda1 + Math.atan2(
    Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
    Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2)
  );
  return { lat: toDegReach(phi2), lon: toDegReach(lambda2) };
}

function formatReachRadiusKm(km) {
  if (!(km > 0)) return '0km';
  return km < 10 ? `${Math.round(km * 10) / 10}km` : `${Math.round(km)}km`;
}

function reachPrefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

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
    this._lastSpots = []; // 【2026-10-13、10本目②】到達円の半径計算用（出発駅からの距離はここから出す）
    this._departureStation = null;
    this._reachCircle = null;
    this._reachCircleLabel = null;
    this._reachCircleRadiusKm = 0;
    this._circlePaintScheduled = false;
    this._pendingCircleRadiusKm = null;
    this._pendingCircleStyle = 'live';
    this._waveToken = 0;
    this._waveTimers = [];
    this._pendingWaveReveal = false; // 【2026-10-13、10本目②】layout-controller.jsのinvalidateMapSize()参照
    this._overviewZoom = null; // 【2026-10-15、11本目②】直近のfitToBudget()が合わせたズーム（寄っているか判定用）

    this.onSelectionChange = null; // (spotId) => void … ピン選択と一覧パネルの連動用
    this.onFocusChange = null; // 【2026-10-15、11本目②】(focused: boolean) => void … 「全体を見る」ボタンの表示切替用
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

    // 検証用の参照（terrain-map-view.jsのwindow.__terrainViewForDebugと同じ考え方）。
    // アプリ自体はこれを使わない。本番でも害はないため条件分岐は入れていない。
    window.__mapViewForDebug = this;

    // 【2026-10-15、11本目②】ユーザーが手でズームした結果、全体（_overviewZoom）
    // より寄った状態になったかを「全体を見る」ボタンの表示判定に使う。
    this.map.on('zoomend', () => {
      if (this.onFocusChange) this.onFocusChange(this.isZoomedInPastOverview());
    });
  }

  /**
   * @param {{display_name: string, stop_lat: number, stop_lon: number}} departureStation
   * @param {Array} spots - latitude/longitude を持つスポット配列（¥2000で一度取得したallSpots全体。
   *   予算の絞り込み・塗り分けはapplyBudget側で行うため、ここでは帯を絞らずそのまま渡す）
   * @param {number} [budget] - 初期表示の予算。省略時は2000
   * @param {{reveal?: boolean}} [opts] - 【2026-10-13、10本目②】reveal:trueで、出発駅から
   *   近い順に波が広がるように点を出す（Minami指示：「この条件で検索」を押したときだけ）。
   */
  render(departureStation, spots, budget = 2000, { reveal = false } = {}) {
    this.ensureMap();
    this._cancelWaveReveal();
    this.markersLayer.clearLayers();
    this.markersBySpotId.clear();
    this.fareBySpotId.clear();
    this.spotsLatLngById.clear();
    this.selectedSpotId = null;
    this._lastSpots = spots || [];
    this._departureStation = departureStation || null;

    this.departureLatLng = null;
    if (departureStation && isFiniteNumber(departureStation.stop_lat) && isFiniteNumber(departureStation.stop_lon)) {
      // 【2026-10-15、11本目①】吹き出し（ポップアップ）は廃止（Minami決定：A、
      // 地図の下の固定枠に統一）。出発駅名は常時表示の吹き出し型ツールチップ
      // （permanent、ポップアップとは別物）のまま残す。
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
        });
      this.departureLatLng = [departureStation.stop_lat, departureStation.stop_lon];
    }

    spots.forEach((spot) => {
      if (!isFiniteNumber(spot.latitude) || !isFiniteNumber(spot.longitude)) return;

      const marker = L.marker([spot.latitude, spot.longitude], {
        icon: createPinIcon('spot'),
      }).addTo(this.markersLayer);

      marker.on('click', () => {
        this.setSelected(spot.id);
        // 【2026-10-13、12本目①、Minami決定：A＋C】選んだピンが下の情報帯に
        // 隠れないよう、帯の分だけ地図をずらす（向きは2Dに無いため変更不要）。
        this.revealAboveBand([spot.latitude, spot.longitude]);
      });

      this.markersBySpotId.set(spot.id, marker);
      this.fareBySpotId.set(spot.id, spot.source_round_trip_fare);
      this.spotsLatLngById.set(spot.id, [spot.latitude, spot.longitude]);
    });

    this.applyBudget(budget);
    this.fitToBudget(budget, { animate: false });
    this.updateReachCircle(budget, { style: 'settled' });
    if (reveal) this._startWaveReveal();

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
   * 【2026-10-15、11本目②】この「全体の位置」をreturnToOverview()・
   * isZoomedInPastOverview()の基準として_overviewZoomに覚えておく。
   * @param {number} budget
   * @param {{animate?: boolean, durationSec?: number}} [opts]
   */
  fitToBudget(budget, { animate = true, durationSec = 0.6 } = {}) {
    if (!this.map) return;
    this.lastBudget = budget;
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
    // 【2026-10-10】¥2000選択時に点が画面端からはみ出る不具合をMinamiが
    // スクリーンショットで発見（主に3D側だったが、余白は2Dも合わせて広げる）。
    const options = { padding: [48, 48], maxZoom: 16 };
    this._overviewZoom = Math.min(this.map.getBoundsZoom(bounds, false, L.point(48, 48)), options.maxZoom);
    if (reachPrefersReducedMotion()) {
      this.map.fitBounds(bounds, options);
    } else if (animate) {
      this.map.flyToBounds(bounds, { ...options, duration: durationSec });
    } else {
      this.map.fitBounds(bounds, options);
    }
    if (this.onFocusChange) this.onFocusChange(false);
  }

  /** 直近のbounds（出発駅＋スポット）に再フィットする。地図が非表示の間に
   * 描画された場合や、レイアウト切り替えでコンテナサイズが変わった際に使う */
  refitBounds() {
    if (this.map && this.lastBounds.length > 0) {
      this.map.fitBounds(this.lastBounds, { padding: [36, 36], maxZoom: 16 });
    }
  }

  /**
   * 【2026-10-15、11本目②、Minami決定：C】ユーザーが手でズームして、
   * 全体の位置（_overviewZoom）より寄っているかどうか。
   * 「全体を見る」ボタンの表示判定・予算操作時の自動復帰判定に使う。
   */
  isZoomedInPastOverview() {
    if (!this.map || this._overviewZoom == null) return false;
    return this.map.getZoom() > this._overviewZoom + 0.3;
  }

  /**
   * 「全体を見る」ボタン・予算操作時の自動復帰（Minami決定：C）。寄っている
   * ときに全体の位置へなめらかに引く。向き（bearing）は2Dに無いため変更不要。
   * @param {{durationSec?: number}} [opts]
   */
  returnToOverview({ durationSec = 1.5 } = {}) {
    if (!this.map || this.lastBudget == null || !this.isZoomedInPastOverview()) return;
    this.fitToBudget(this.lastBudget, { animate: true, durationSec });
  }

  /**
   * 【2026-10-13、12本目①、Minami決定：A＋C】選んだピンが下の情報帯の
   * 裏に隠れないよう、地図をずらす。latlngを画面中央そのものではなく、
   * REVEAL_ABOVE_BAND_OFFSET_PXぶん「南」に実質ずらした地点を中心にする
   * ことで、latlng自体は画面中央よりその分だけ上（帯より上の見える位置）に
   * 描画される。向き（bearing）は2Dに無いため変更不要。
   * @param {[number, number]} latlng
   */
  revealAboveBand(latlng) {
    if (!this.map) return;
    const zoom = this.map.getZoom();
    const targetPoint = this.map.project(latlng, zoom).add([0, REVEAL_ABOVE_BAND_OFFSET_PX]);
    const target = this.map.unproject(targetPoint, zoom);
    if (reachPrefersReducedMotion()) {
      this.map.panTo(target, { animate: false });
    } else {
      this.map.panTo(target, { animate: true, duration: 0.4 });
    }
  }

  /**
   * 【2026-10-13、10本目②、Minami決定：A】予算の±・スライダーを動かしている間は
   * 点を変えず、出発駅を中心にした到達範囲の円だけを広げる・縮める。
   * 半径は「今の予算以内（往復）で行ける場所のうち、一番遠い場所までの直線距離」
   * （¥2000で先に取得済みのallSpotsから実測。推測値にしない、Minami指示）。
   * まだ検索していない（allSpots無し）ときは円を出さない。
   * 塗り替えはrequestAnimationFrame 1コマに1回へ間引く（3D側のapplyBudget()と
   * 同じ理由。スライダーのinputは連続発火するため）。
   * @param {number} budget
   * @param {{style?: 'live'|'settled'}} [opts] - settled:検索確定後（薄くする）
   */
  updateReachCircle(budget, { style = 'live' } = {}) {
    if (!this.departureLatLng || !this._lastSpots || this._lastSpots.length === 0) {
      this._pendingCircleRadiusKm = 0;
    } else {
      const [lat, lon] = this.departureLatLng;
      this._pendingCircleRadiusKm = this._lastSpots.reduce((max, s) => {
        if (!isFiniteNumber(s.latitude) || !isFiniteNumber(s.longitude)) return max;
        if (s.source_round_trip_fare > budget) return max;
        return Math.max(max, reachHaversineKm(lat, lon, s.latitude, s.longitude));
      }, 0);
    }
    this._pendingCircleStyle = style;
    if (this._circlePaintScheduled) return;
    this._circlePaintScheduled = true;
    requestAnimationFrame(() => {
      this._circlePaintScheduled = false;
      this._paintReachCircle(this._pendingCircleRadiusKm, this._pendingCircleStyle);
    });
  }

  _paintReachCircle(radiusKm, style) {
    this.ensureMap();
    this._reachCircleRadiusKm = radiusKm; // 検証用（verify-layout.js参照）
    if (!this.map || !radiusKm || radiusKm <= 0 || !this.departureLatLng) {
      if (this._reachCircle) { this.map?.removeLayer(this._reachCircle); this._reachCircle = null; }
      if (this._reachCircleLabel) { this.map?.removeLayer(this._reachCircleLabel); this._reachCircleLabel = null; }
      return;
    }
    const opts = style === 'settled'
      ? { color: '#2F6FB2', weight: 1.5, opacity: 0.35, fillColor: '#2F6FB2', fillOpacity: 0.07 }
      : { color: '#2F6FB2', weight: 1.5, opacity: 0.55, fillColor: '#2F6FB2', fillOpacity: 0.12 };
    const radiusMeters = radiusKm * 1000;
    if (!this._reachCircle) {
      this._reachCircle = L.circle(this.departureLatLng, { ...opts, radius: radiusMeters, interactive: false }).addTo(this.map);
    } else {
      this._reachCircle.setLatLng(this.departureLatLng);
      this._reachCircle.setRadius(radiusMeters);
      this._reachCircle.setStyle(opts);
    }

    const edge = reachDestinationPoint(this.departureLatLng[0], this.departureLatLng[1], REACH_CIRCLE_LABEL_BEARING, radiusKm);
    const labelLatLng = [edge.lat, edge.lon];
    if (!this._reachCircleLabel) {
      this._reachCircleLabel = L.marker(labelLatLng, {
        icon: L.divIcon({ className: 'reach-circle-label-anchor', html: '', iconSize: [0, 0] }),
        interactive: false,
        zIndexOffset: -1000,
      })
        .addTo(this.map)
        .bindTooltip('', { permanent: true, direction: 'center', className: 'reach-circle-label' });
    } else {
      this._reachCircleLabel.setLatLng(labelLatLng);
    }
    this._reachCircleLabel.setTooltipContent(`最大${formatReachRadiusKm(radiusKm)}先まで`);
  }

  /**
   * 【2026-10-13、10本目②】検索を押した直後、出発駅から近い順に点が波のように
   * 広がって出る演出（Minami指示：全体で1秒前後）。帯内・帯外どちらの点も対象
   * （applyBudget()が既に非表示にした予算超の点は対象外）。
   * prefers-reduced-motionのときは即座に全部出す。
   *
   * 【不具合修正】スマホで「一覧」タブを見ながら検索した場合、地図のコンテナ
   * （#spots-map）はdisplay:noneでサイズ0のまま。Leafletはコンテナが未初期化
   * （サイズ0）の間はマーカーのアイコン要素を正しく生成しない
   * （marker.getElement()がundefinedを返す。applyBudget()も同じ理由で既に
   * コンテナサイズ0の間は塗り替えを保留する設計になっている）。この状態で
   * 波の演出を試みても対象の要素が1つも見つからず、演出が静かに空振りして
   * 終わっていた（verify-layoutで「検索直後に隠れている点が0件」として発覚）。
   * スポット自体はある（_lastSpots等で保持済み）のにコンテナが未準備なだけの
   * 場合は、後で地図タブが開かれたとき（layout-controller.jsのinvalidateMapSize()）
   * に改めて波の演出をやり直せるよう、保留フラグを立てる。
   */
  _startWaveReveal() {
    this._cancelWaveReveal();
    this._pendingWaveReveal = false;
    if (!this.departureLatLng) return;
    const [depLat, depLon] = this.departureLatLng;
    const entries = [];
    let maxKm = 0;
    this.markersBySpotId.forEach((marker, spotId) => {
      const el = marker.getElement();
      if (!el || el.style.display === 'none') return;
      const latlng = this.spotsLatLngById.get(spotId);
      if (!latlng) return;
      const km = reachHaversineKm(depLat, depLon, latlng[0], latlng[1]);
      maxKm = Math.max(maxKm, km);
      entries.push({ el, km });
    });
    if (entries.length === 0) {
      // コンテナが未準備（サイズ0）で要素が拾えなかった可能性がある場合だけ、
      // 後で地図タブが開かれたときにやり直せるよう保留する（スポット自体が
      // 0件のときは無意味なので、markersBySpotIdが空でない場合に限る）。
      if (this.markersBySpotId.size > 0 && this.map && (this.map.getSize().x === 0 || this.map.getSize().y === 0)) {
        this._pendingWaveReveal = true;
      }
      return;
    }
    if (reachPrefersReducedMotion() || maxKm <= 0) {
      entries.forEach(({ el }) => el.classList.remove('pin-wave-hidden'));
      return;
    }
    const token = ++this._waveToken;
    entries.forEach(({ el }) => el.classList.add('pin-wave-hidden'));
    entries.forEach(({ el, km }) => {
      const delay = (km / maxKm) * WAVE_DURATION_MS;
      const timer = setTimeout(() => {
        if (token !== this._waveToken) return;
        el.classList.remove('pin-wave-hidden');
      }, delay);
      this._waveTimers.push(timer);
    });
  }

  _cancelWaveReveal() {
    this._waveToken++;
    this._waveTimers.forEach((t) => clearTimeout(t));
    this._waveTimers = [];
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

  /**
   * 【2026-10-15、11本目①】情報枠を閉じたとき・検索し直したとき・予算を
   * 触ったときに、ピンの強調だけを外す（新しい選択はしない）。
   */
  clearSelected() {
    if (this.selectedSpotId) {
      this.setMarkerState(this.selectedSpotId, 'selected', false);
    }
    this.selectedSpotId = null;
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

