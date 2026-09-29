/**
 * route-duration.js - route-details.json（駅ID→駅ID→事業者IDの直行/乗換情報）から
 * 実際の乗車所要時間を導出する共通ロジック。
 * fare-calculator.js（アクセス駅の選定）と route-formatter.js（経路表示）の
 * 両方から使う。
 *
 * route-details.json の RouteEntry はファイルサイズ抑制のため配列形式：
 *   直行:   [route_id, duration_min, wait_min]                                              （長さ3）
 *   乗換1回: [via, route_id_1, duration_min_1, wait_min_1, route_id_2, duration_min_2, wait_min_2] （長さ7）
 * wait_min は期待待ち時間（平均運行間隔÷2の簡易推定）。表示（route-formatter.js）は
 * duration_minのみを使い、wait_minはアクセス駅選定（fare-calculator.js）でのみ使う。
 *
 * 【事業者IDが必須引数になっている理由】運賃を決めた事業者と表示する経路の事業者が
 * 食い違うと、存在しない運賃×経路の組み合わせを表示してしまう（香川の高松築港で
 * 実測6件）。route-details.jsonは駅IDペアごとに事業者別の経路を持つため、
 * 呼び出し側は必ず「運賃を決めた事業者」のIDを渡すこと。
 */

/** RouteEntry配列 → {type, route_id, duration_min, wait_min} または {type, via, legs} */
export function parseRouteEntry(entry) {
  if (!entry) return null;
  if (entry.length === 3) {
    return { type: 'direct', route_id: entry[0], duration_min: entry[1], wait_min: entry[2] };
  }
  return {
    type: 'transfer',
    via: entry[0],
    legs: [
      { route_id: entry[1], duration_min: entry[2], wait_min: entry[3] },
      { route_id: entry[4], duration_min: entry[5], wait_min: entry[6] },
    ],
  };
}

/** 表示用：乗車時間のみの合計（待ち時間は含めない） */
export function routeEntryMinutes(parsed) {
  if (!parsed) return null;
  return parsed.type === 'direct'
    ? parsed.duration_min
    : parsed.legs[0].duration_min + parsed.legs[1].duration_min;
}

/** 選定ロジック用：乗車時間＋期待待ち時間の合計 */
export function routeEntryMinutesWithWait(parsed) {
  if (!parsed) return null;
  if (parsed.type === 'direct') {
    return parsed.duration_min + parsed.wait_min;
  }
  return (
    parsed.legs[0].duration_min + parsed.legs[0].wait_min +
    parsed.legs[1].duration_min + parsed.legs[1].wait_min
  );
}

export function lookupRouteEntry(routeDetails, originId, destId, operatorId) {
  return (routeDetails?.[originId]?.[destId]?.[operatorId]) || null;
}

/**
 * 出発駅ID→到達駅IDの実乗車時間（分）を算出する（表示用、待ち時間は含めない）。
 * reachBy='transfer'（鉄道→バスなど事業者をまたぐ乗換）の場合は transferAt 経由の
 * 2区間を合算する。reachBy='direct'の場合でも、route-details側で同一事業者内の
 * 隠れた乗換が判明していればその合計時間を使う。
 * 解決できない場合はnullを返す。
 *
 * @param {object} routeDetails
 * @param {string} departureStationId
 * @param {{reachBy: string, transferAt: (string|null), station_id: string,
 *          viaOperator: (string|null), legOperators: (string[]|null)}} station
 */
export function estimateRideMinutes(routeDetails, departureStationId, station) {
  if (station.reachBy === 'transfer' && station.transferAt) {
    const [op1, op2] = station.legOperators;
    const leg1 = routeEntryMinutes(parseRouteEntry(lookupRouteEntry(routeDetails, departureStationId, station.transferAt, op1)));
    const leg2 = routeEntryMinutes(parseRouteEntry(lookupRouteEntry(routeDetails, station.transferAt, station.station_id, op2)));
    if (leg1 === null || leg2 === null) return null;
    return leg1 + leg2;
  }
  const parsed = parseRouteEntry(lookupRouteEntry(routeDetails, departureStationId, station.station_id, station.viaOperator));
  return routeEntryMinutes(parsed);
}

/**
 * 出発駅ID→到達駅IDの「乗車時間＋期待待ち時間」（分）を算出する（アクセス駅選定用）。
 * 待ち時間は「本数の少ない路線が乗車時間だけで不当に優位になる」のを防ぐための
 * 簡易な補正値であり、経路表示には使わない（estimateRideMinutesと使い分ける）。
 */
export function estimateSelectionMinutes(routeDetails, departureStationId, station) {
  if (station.reachBy === 'transfer' && station.transferAt) {
    const [op1, op2] = station.legOperators;
    const leg1 = routeEntryMinutesWithWait(parseRouteEntry(lookupRouteEntry(routeDetails, departureStationId, station.transferAt, op1)));
    const leg2 = routeEntryMinutesWithWait(parseRouteEntry(lookupRouteEntry(routeDetails, station.transferAt, station.station_id, op2)));
    if (leg1 === null || leg2 === null) return null;
    return leg1 + leg2;
  }
  const parsed = parseRouteEntry(lookupRouteEntry(routeDetails, departureStationId, station.station_id, station.viaOperator));
  return routeEntryMinutesWithWait(parsed);
}
