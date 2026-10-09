/**
 * route-duration.js - route-details.json（駅ID→駅ID→事業者IDの直行/乗換情報）から
 * 実際の乗車所要時間を導出する共通ロジック。
 * fare-calculator.js（アクセス駅の選定）と route-formatter.js（経路表示）の
 * 両方から使う。
 *
 * route-details.json の RouteEntry はファイルサイズ抑制のため配列形式：
 *   直行:   [route_id, duration_min, tripCount, dayCode, demandCount]（長さ5）
 *   乗換1回: [via, route_id_1, duration_min_1, route_id_2, duration_min_2,
 *            tripCount, dayCode, demandCount]（長さ8）
 *
 * 【2026-10-10追記】末尾3要素は便数情報（2本目「便の少ない路線を応援」マーク機能、
 * scripts/build-pipeline/compute-service-frequency.js参照）。
 *   tripCount: その区間のボトルネック便数（行き・帰りの小さい方、route_idをまたいで集計）。
 *              -1は「代表日が見つからず便数を解決できなかった」ことを示す。
 *   dayCode: 0〜31は運行する平日の曜日ビットフラグ（bit0=月…bit4=金）、32は週末代表
 *            （土休日のみ運行）、-1はtripCount同様「解決できなかった」。
 *   demandCount: tripCountのうち予約制（pickup_type=2）の便数。
 * 直行・乗換1回のどちらも常にこの3要素を持つ（長さを固定することで、
 * 「乗換1回・便数情報なし」(旧:長さ5)と「直行・便数情報あり」(長さ5)が
 * 長さだけで区別できなくなる問題を避けている）。
 *
 * 【2026-10-06追記】期待待ち時間（wait_min）はRouteEntryに含めない。以前は
 * 「駅ペア×路線」ごとに埋め込んでいたが、富山でroute-details.jsonが肥大化した
 * （均一運賃展開で経路数が倍増）ことを受け、路線単位の1つの値にまとめて
 * route-info.json（route_id→expected_wait_min）へ持たせた。そのため
 * estimateSelectionMinutes()はrouteInfoを追加引数として受け取り、route_idから
 * 期待待ち時間を引く。表示（route-formatter.js）はduration_minのみを使い、
 * 期待待ち時間はアクセス駅選定（fare-calculator.js）でのみ使う。
 *
 * 【事業者IDが必須引数になっている理由】運賃を決めた事業者と表示する経路の事業者が
 * 食い違うと、存在しない運賃×経路の組み合わせを表示してしまう（香川の高松築港で
 * 実測6件）。route-details.jsonは駅IDペアごとに事業者別の経路を持つため、
 * 呼び出し側は必ず「運賃を決めた事業者」のIDを渡すこと。
 */

/** RouteEntry配列 → {type, route_id, duration_min, tripCount, dayCode, demandCount} または {type, via, legs, tripCount, dayCode, demandCount} */
export function parseRouteEntry(entry) {
  if (!entry) return null;
  if (entry.length === 5) {
    return {
      type: 'direct', route_id: entry[0], duration_min: entry[1],
      tripCount: entry[2], dayCode: entry[3], demandCount: entry[4],
    };
  }
  return {
    type: 'transfer',
    via: entry[0],
    legs: [
      { route_id: entry[1], duration_min: entry[2] },
      { route_id: entry[3], duration_min: entry[4] },
    ],
    tripCount: entry[5], dayCode: entry[6], demandCount: entry[7],
  };
}

/** dayCode: 0〜31=平日ビットフラグ、32=週末代表、-1=解決できなかった */
const WEEKEND_DAY_CODE = 32;
const WEEKDAY_BIT_LABELS = ['月', '火', '水', '木', '金'];

/**
 * 便数情報（{tripCount, dayCode, demandCount}）を人間が読める曜日の文言にする。
 * @returns {string} 例: "平日"・"火・金のみ"・"土休日"・"（運行曜日不明）"
 */
export function formatDayLabel(dayCode) {
  if (dayCode === WEEKEND_DAY_CODE) return '土休日';
  if (dayCode === 31) return '平日'; // 0b11111 = 月〜金すべて
  if (dayCode >= 0 && dayCode < 31) {
    const days = [];
    for (let i = 0; i < 5; i++) if (dayCode & (1 << i)) days.push(WEEKDAY_BIT_LABELS[i]);
    return days.length > 0 ? `${days.join('・')}のみ` : '（運行曜日不明）';
  }
  return '（運行曜日不明）';
}

/**
 * 便数情報のroute_idから、カード・共有文で使う事業者の呼び方を決める。
 * 「コミュニティバス」の語は、route-info.jsonのis_community_operator
 * （build-prefecture.jsがfeed_info.txtのfeed_publisher_nameから機械的に判定、
 * scripts/build-pipeline/operator-classification.js参照）がtrueの事業者だけに使う。
 * それ以外はroute_type（0/1/2=鉄道系、3=バス）に応じて「バス」「路線」とする。
 * @param {object} routeInfo - route-info.json
 * @param {string|undefined} routeId
 * @returns {string} "コミュニティバス" | "バス" | "路線"
 */
export function operatorLabelWord(routeInfo, routeId) {
  const route = routeInfo?.[routeId];
  if (!route) return '路線';
  if (route.is_community_operator) return 'コミュニティバス';
  return parseInt(route.route_type, 10) === 3 ? 'バス' : '路線';
}

/**
 * 出発駅ID→到達駅IDの便数情報（行き・帰りの小さい方。ビルド時に確定済みの値を
 * そのまま引くだけ）を解決する。estimateRideMinutes/estimateSelectionMinutesと
 * 同じ、reachBy='direct'|'transfer'の分岐構造を踏襲する。
 * @returns {{tripCount:number, dayCode:number, demandCount:number}|null}
 *   解決できない場合（経路自体が無い、またはtripCount<0＝代表日なし）はnull
 */
export function estimateTripFrequency(routeDetails, departureStationId, station) {
  function fromParsed(parsed) {
    if (!parsed || parsed.tripCount < 0) return null;
    // route_idは「どの事業者の便か」を引くための代表値（コミュニティバス判定等に使う）。
    // 直行・乗換1回（同一事業者内）のどちらも1本目の区間のroute_idで代表させる
    // （乗換1回は両区間が同一事業者のため、どちらのroute_idでも事業者判定は変わらない）。
    const routeId = parsed.type === 'direct' ? parsed.route_id : parsed.legs[0].route_id;
    return { tripCount: parsed.tripCount, dayCode: parsed.dayCode, demandCount: parsed.demandCount, routeId };
  }

  if (station.reachBy === 'transfer' && station.transferAt) {
    const [op1, op2] = station.legOperators;
    const leg1 = fromParsed(parseRouteEntry(lookupRouteEntry(routeDetails, departureStationId, station.transferAt, op1)));
    const leg2 = fromParsed(parseRouteEntry(lookupRouteEntry(routeDetails, station.transferAt, station.station_id, op2)));
    if (!leg1 || !leg2) return null;
    return leg1.tripCount <= leg2.tripCount ? leg1 : leg2;
  }
  return fromParsed(parseRouteEntry(lookupRouteEntry(routeDetails, departureStationId, station.station_id, station.viaOperator)));
}

/** 表示用：乗車時間のみの合計（待ち時間は含めない） */
export function routeEntryMinutes(parsed) {
  if (!parsed) return null;
  return parsed.type === 'direct'
    ? parsed.duration_min
    : parsed.legs[0].duration_min + parsed.legs[1].duration_min;
}

/** route_idからroute-info.jsonのexpected_wait_minを引く。無ければ0分扱い。 */
function waitMinForRoute(routeInfo, routeId) {
  const waitMin = routeInfo?.[routeId]?.expected_wait_min;
  return waitMin === undefined ? 0 : waitMin;
}

/** 選定ロジック用：乗車時間＋期待待ち時間の合計（期待待ち時間はroute_id単位でroute-info.jsonから引く） */
export function routeEntryMinutesWithWait(parsed, routeInfo) {
  if (!parsed) return null;
  if (parsed.type === 'direct') {
    return parsed.duration_min + waitMinForRoute(routeInfo, parsed.route_id);
  }
  return (
    parsed.legs[0].duration_min + waitMinForRoute(routeInfo, parsed.legs[0].route_id) +
    parsed.legs[1].duration_min + waitMinForRoute(routeInfo, parsed.legs[1].route_id)
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
 * @param {object} routeInfo - route_id→{..., expected_wait_min}（route-info.json）
 */
export function estimateSelectionMinutes(routeDetails, departureStationId, station, routeInfo) {
  if (station.reachBy === 'transfer' && station.transferAt) {
    const [op1, op2] = station.legOperators;
    const leg1 = routeEntryMinutesWithWait(parseRouteEntry(lookupRouteEntry(routeDetails, departureStationId, station.transferAt, op1)), routeInfo);
    const leg2 = routeEntryMinutesWithWait(parseRouteEntry(lookupRouteEntry(routeDetails, station.transferAt, station.station_id, op2)), routeInfo);
    if (leg1 === null || leg2 === null) return null;
    return leg1 + leg2;
  }
  const parsed = parseRouteEntry(lookupRouteEntry(routeDetails, departureStationId, station.station_id, station.viaOperator));
  return routeEntryMinutesWithWait(parsed, routeInfo);
}
