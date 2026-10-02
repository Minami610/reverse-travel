/**
 * route-formatter.js - 経路情報（使用路線・所要時間）の表示文言を組み立てる
 *
 * route-info.json（路線名）と route-details.json（駅ID→駅ID→事業者IDの直行/乗換情報、
 * generate-route-details.js で生成）を突き合わせて、スポット詳細画面用の
 * 経路説明HTMLを作る。表示用の駅名はstations.json（stations）から引く
 * （route-details.jsonのキーは駅名ではなく安定した駅IDのため）。
 *
 * RouteEntryのパース・所要時間算出は route-duration.js（fare-calculator.js の
 * アクセス駅選定とも共有）に切り出してある。
 *
 * 【運賃を決めた事業者と表示経路の事業者を一致させる】以前は駅名ペアの経路を
 * 「頻度下限＋最短」で1つだけ選んでいたため、運賃が最安の事業者と経路表示が
 * 最速の事業者で食い違うことがあった（香川の高松築港で実測6件：¥250はバスの
 * 運賃なのにことでん線の経路を表示）。route-details.jsonは事業者別に経路を
 * 持つため、必ずspot側が記録している「運賃を決めた事業者」のIDを渡して引く。
 */

import { parseRouteEntry, routeEntryMinutes, lookupRouteEntry } from './route-duration.js';

export class RouteFormatter {
  constructor(routeInfo, routeDetails, stations) {
    this.routeInfo = routeInfo || {};
    this.routeDetails = routeDetails || {};
    this.stations = stations || {};
  }

  /** 駅IDから表示名を引く（見つからなければIDをそのまま出す＝フェイルセーフ） */
  displayName(stationId) {
    return this.stations[stationId]?.display_name || stationId;
  }

  /** 路線IDから表示名を作る（バス路線には「ことでんバス」を補う） */
  routeLabel(routeId) {
    const route = this.routeInfo[routeId];
    if (!route) return routeId;

    const name = route.route_long_name || route.route_short_name || routeId;
    const needsBusPrefix =
      route.operator_id === 'kotoden-bus' && !name.includes('バス') && !name.includes('ことでん');

    return needsBusPrefix ? `ことでんバス ${name}` : name;
  }

  /**
   * 路線IDから交通手段を判定（色分け・アイコン用）。
   * route_type（GTFS標準、0/1/2=鉄道系、3=バス）を見る。事業者IDの固定値では
   * 判定しない（鉄道とバス両方を運行する事業者で不正確になるため）。
   */
  routeMode(routeId) {
    const route = this.routeInfo[routeId];
    const type = route ? parseInt(route.route_type, 10) : NaN;
    return type === 3 ? 'bus' : 'rail';
  }

  lookup(originId, destId, operatorId) {
    return lookupRouteEntry(this.routeDetails, originId, destId, operatorId);
  }

  parseEntry(entry) {
    return parseRouteEntry(entry);
  }

  totalMinutes(parsed) {
    return routeEntryMinutes(parsed);
  }

  /**
   * @param {string} departureStationId
   * @param {object} spot - source_station / source_station_id / source_fare /
   *                         source_round_trip_fare / source_reach_by / source_via_operator /
   *                         source_transfer_at / source_leg_operators / source_leg_fares を持つスポット候補
   * @returns {string} 経路情報HTML
   */
  format(departureStationId, spot) {
    if (spot.source_reach_by === 'transfer' && spot.source_transfer_at) {
      return this.formatCrossOperatorTransfer(departureStationId, spot);
    }

    const destId = spot.source_station_id;
    const destName = spot.source_station;
    const departureName = this.displayName(departureStationId);
    const fare = spot.source_fare;
    const roundTripNote = this.renderRoundTripNote(spot.source_round_trip_fare);

    const parsed = this.parseEntry(this.lookup(departureStationId, destId, spot.source_via_operator));
    if (!parsed) {
      return this.renderUnresolved(spot);
    }

    if (parsed.type === 'direct') {
      return `<div class="route-info">${this.renderLegLine(parsed.route_id, departureName, destName, parsed.duration_min, fare)}${roundTripNote}</div>`;
    }

    // 運賃表上は「直接到達」だが、実際には同一事業者内で乗換が必要な区間。
    // 運賃はゾーン制の通し運賃のため、区間ごとには分割せず合計を1回だけ表示する。
    const viaName = this.displayName(parsed.via);
    const totalMinutes = this.totalMinutes(parsed);
    return `
      <div class="route-info">
        ${this.renderLegLine(parsed.legs[0].route_id, departureName, viaName, parsed.legs[0].duration_min, null)}
        <div class="route-transfer-note">↓ ${viaName}で乗換</div>
        ${this.renderLegLine(parsed.legs[1].route_id, viaName, destName, parsed.legs[1].duration_min, null)}
        <div class="route-total">合計（片道） ¥${fare}（通し運賃）・約${totalMinutes}分</div>
        <p class="route-disclaimer">※乗換の待ち時間は考慮していません</p>
        ${roundTripNote}
      </div>
    `;
  }

  /** 事業者をまたぐ乗換（鉄道→バス・バス→バスいずれも対象、運賃は区間ごとに別建て） */
  formatCrossOperatorTransfer(departureStationId, spot) {
    const transferAtId = spot.source_transfer_at;
    const destId = spot.source_station_id;
    const [operator1, operator2] = spot.source_leg_operators || [null, null];
    const departureName = this.displayName(departureStationId);
    const transferAtName = this.displayName(transferAtId);
    const destName = spot.source_station;
    const [fare1, fare2] = spot.source_leg_fares || [null, null];
    const fare = spot.source_fare;
    const roundTripNote = this.renderRoundTripNote(spot.source_round_trip_fare);

    const leg1 = this.parseEntry(this.lookup(departureStationId, transferAtId, operator1));
    const leg2 = this.parseEntry(this.lookup(transferAtId, destId, operator2));

    const leg1Minutes = this.totalMinutes(leg1);
    const leg2Minutes = this.totalMinutes(leg2);
    const totalMinutes = leg1Minutes !== null && leg2Minutes !== null ? leg1Minutes + leg2Minutes : null;

    return `
      <div class="route-info">
        ${this.renderLegOrSegment(departureName, transferAtName, leg1, fare1)}
        <div class="route-transfer-note">↓ ${transferAtName}で乗換</div>
        ${this.renderLegOrSegment(transferAtName, destName, leg2, fare2)}
        <div class="route-total">合計（片道） ¥${fare}${totalMinutes !== null ? `・約${totalMinutes}分` : ''}</div>
        <p class="route-disclaimer">※乗換の待ち時間は考慮していません</p>
        ${roundTripNote}
      </div>
    `;
  }

  /**
   * 往復運賃の注記。予算は往復基準（帰りも同額と仮定）なので、片道の内訳・合計とは
   * 別立てで常に表示する。GTFSの運賃データには往復運賃・往復割引という概念自体が
   * 存在しないため「同額と仮定」と明記する。
   */
  renderRoundTripNote(roundTripFare) {
    if (roundTripFare === null || roundTripFare === undefined) return '';
    return `<p class="route-round-trip">往復運賃（帰りも同額と仮定）：<strong>¥${roundTripFare}</strong></p>`;
  }

  /** 1区間分の表示（駅名は表示用にすでに解決済みのものを受け取る）。その区間自体が
   * さらに乗換を要する場合はまとめて展開する */
  renderLegOrSegment(originName, destName, parsed, fare) {
    if (!parsed) {
      return `<p class="route-unresolved">${originName} → ${destName}（経路情報を確定できませんでした）</p>`;
    }
    if (parsed.type === 'direct') {
      return this.renderLegLine(parsed.route_id, originName, destName, parsed.duration_min, fare);
    }
    const viaName = this.displayName(parsed.via);
    return `
      ${this.renderLegLine(parsed.legs[0].route_id, originName, viaName, parsed.legs[0].duration_min, null)}
      <div class="route-transfer-note">↓ ${viaName}で乗換</div>
      ${this.renderLegLine(parsed.legs[1].route_id, viaName, destName, parsed.legs[1].duration_min, fare)}
    `;
  }

  renderLegLine(routeId, originName, destName, durationMin, fare) {
    const label = this.routeLabel(routeId);
    const mode = this.routeMode(routeId);
    const icon = mode === 'bus' ? '🚌' : '🚃';
    const farePart = fare !== null && fare !== undefined ? `¥${fare}・` : '';
    return `<p class="route-leg route-leg-${mode}">${icon} ${label}　${originName} → ${destName}（${farePart}約${durationMin}分）</p>`;
  }

  renderUnresolved(spot) {
    return `
      <div class="route-info">
        <p class="route-unresolved">経路情報を確定できませんでした（片道¥${spot.source_fare}・往復¥${spot.source_round_trip_fare}で到達可能です）</p>
      </div>
    `;
  }
}
