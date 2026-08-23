/**
 * route-formatter.js - 経路情報（使用路線・所要時間）の表示文言を組み立てる
 *
 * route-info.json（路線名）と route-details.json（駅名→駅名の直行/乗換情報、
 * generate-route-details.js で生成）を突き合わせて、スポット詳細画面用の
 * 経路説明HTMLを作る。
 *
 * RouteEntryのパース・所要時間算出は route-duration.js（fare-calculator.js の
 * アクセス駅選定とも共有）に切り出してある。
 */

import { parseRouteEntry, routeEntryMinutes, lookupRouteEntry } from './route-duration.js';

export class RouteFormatter {
  constructor(routeInfo, routeDetails) {
    this.routeInfo = routeInfo || {};
    this.routeDetails = routeDetails || {};
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

  /** 路線IDから交通手段を判定（色分け・アイコン用） */
  routeMode(routeId) {
    const route = this.routeInfo[routeId];
    return route?.operator_id === 'kotoden-bus' ? 'bus' : 'rail';
  }

  lookup(originName, destName) {
    return lookupRouteEntry(this.routeDetails, originName, destName);
  }

  parseEntry(entry) {
    return parseRouteEntry(entry);
  }

  totalMinutes(parsed) {
    return routeEntryMinutes(parsed);
  }

  /**
   * @param {string} departureStationName
   * @param {object} spot - source_station / source_fare / source_reach_by /
   *                         source_transfer_at / source_leg_fares を持つスポット候補
   * @returns {string} 経路情報HTML
   */
  format(departureStationName, spot) {
    const destName = spot.source_station;
    const fare = spot.source_fare;

    if (spot.source_reach_by === 'transfer' && spot.source_transfer_at) {
      return this.formatCrossOperatorTransfer(departureStationName, spot);
    }

    const parsed = this.parseEntry(this.lookup(departureStationName, destName));
    if (!parsed) {
      return this.renderUnresolved(fare);
    }

    if (parsed.type === 'direct') {
      return `<div class="route-info">${this.renderLegLine(parsed.route_id, departureStationName, destName, parsed.duration_min, fare)}</div>`;
    }

    // 運賃表上は「直接到達」だが、実際には同一事業者内で乗換が必要な区間。
    // 運賃はゾーン制の通し運賃のため、区間ごとには分割せず合計を1回だけ表示する。
    const totalMinutes = this.totalMinutes(parsed);
    return `
      <div class="route-info">
        ${this.renderLegLine(parsed.legs[0].route_id, departureStationName, parsed.via, parsed.legs[0].duration_min, null)}
        <div class="route-transfer-note">↓ ${parsed.via}で乗換</div>
        ${this.renderLegLine(parsed.legs[1].route_id, parsed.via, destName, parsed.legs[1].duration_min, null)}
        <div class="route-total">合計 ¥${fare}（通し運賃）・約${totalMinutes}分</div>
        <p class="route-disclaimer">※乗換の待ち時間は考慮していません</p>
      </div>
    `;
  }

  /** 鉄道→バスなど、事業者をまたぐ乗換（運賃は区間ごとに別建て） */
  formatCrossOperatorTransfer(departureStationName, spot) {
    const transferAt = spot.source_transfer_at;
    const destName = spot.source_station;
    const [fare1, fare2] = spot.source_leg_fares || [null, null];
    const fare = spot.source_fare;

    const leg1 = this.parseEntry(this.lookup(departureStationName, transferAt));
    const leg2 = this.parseEntry(this.lookup(transferAt, destName));

    const leg1Minutes = this.totalMinutes(leg1);
    const leg2Minutes = this.totalMinutes(leg2);
    const totalMinutes = leg1Minutes !== null && leg2Minutes !== null ? leg1Minutes + leg2Minutes : null;

    return `
      <div class="route-info">
        ${this.renderLegOrSegment(departureStationName, transferAt, leg1, fare1)}
        <div class="route-transfer-note">↓ ${transferAt}で乗換</div>
        ${this.renderLegOrSegment(transferAt, destName, leg2, fare2)}
        <div class="route-total">合計 ¥${fare}${totalMinutes !== null ? `・約${totalMinutes}分` : ''}</div>
        <p class="route-disclaimer">※乗換の待ち時間は考慮していません</p>
      </div>
    `;
  }

  /** 1区間分の表示。その区間自体がさらに乗換を要する場合はまとめて展開する */
  renderLegOrSegment(originName, destName, parsed, fare) {
    if (!parsed) {
      return `<p class="route-unresolved">${originName} → ${destName}（経路情報を確定できませんでした）</p>`;
    }
    if (parsed.type === 'direct') {
      return this.renderLegLine(parsed.route_id, originName, destName, parsed.duration_min, fare);
    }
    return `
      ${this.renderLegLine(parsed.legs[0].route_id, originName, parsed.via, parsed.legs[0].duration_min, null)}
      <div class="route-transfer-note">↓ ${parsed.via}で乗換</div>
      ${this.renderLegLine(parsed.legs[1].route_id, parsed.via, destName, parsed.legs[1].duration_min, fare)}
    `;
  }

  renderLegLine(routeId, originName, destName, durationMin, fare) {
    const label = this.routeLabel(routeId);
    const mode = this.routeMode(routeId);
    const icon = mode === 'bus' ? '🚌' : '🚃';
    const farePart = fare !== null && fare !== undefined ? `¥${fare}・` : '';
    return `<p class="route-leg route-leg-${mode}">${icon} ${label}　${originName} → ${destName}（${farePart}約${durationMin}分）</p>`;
  }

  renderUnresolved(fare) {
    return `
      <div class="route-info">
        <p class="route-unresolved">経路情報を確定できませんでした（¥${fare}で到達可能です）</p>
      </div>
    `;
  }
}
