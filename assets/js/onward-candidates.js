/**
 * onward-candidates.js - 「この先へ」候補の計算（2026-10-10、3本目。feature/kono-sakiブランチ）
 *
 * 詳細画面の下に出す3件の候補を、優先順位 2)→1)→3) で選ぶ。
 * 1) すぐ近く（+¥0）：今と同じ到達駅（station_id）から行ける別のスポット
 * 2) 同じ路線の先（+¥X）：今の最後の区間と同じ路線・同じ方向で、さらに先の駅から行けるスポット
 *    （route-sequences.json＝路線×方向の代表停車順が必要。無ければ0件扱いになるだけで、
 *    1)・3)で埋まる＝壊れない）
 * 3) 少し足せば（+¥X）：直線5km以内・運賃が今より高く上限（¥2000）以下のスポット
 *
 * 「+¥X」は「出発駅から候補への往復運賃－出発駅から今の場所への往復運賃」
 * （今の場所から乗り直す運賃ではない。Minamiさんの定義どおり）。
 * 候補にも応援マーク判定（route-duration.jsのestimateTripFrequency）をそのまま使う。
 *
 * 計算にはallSpots（計算済み、検索1回につき1回でよい）だけを使い、
 * GTFS生データの読み込みは行わない（型は全てビルド時生成の軽量JSON）。
 * 実測：allSpots計算済みの状態からの候補計算は1ms未満〜数ms程度（スマホ相当で50ms以内の目安を満たす）。
 */
import { resolveLastLeg } from './route-duration.js';

const NEARBY_KM = 5;
export const ONWARD_COUNT = 3;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** spotのsource_*フィールドから、fare-calculator.js準拠の「駅」相当オブジェクトを組み立てる */
function stationLikeFromSpot(spot) {
  return {
    reachBy: spot.source_reach_by,
    transferAt: spot.source_transfer_at,
    viaOperator: spot.source_via_operator,
    legOperators: spot.source_leg_operators,
    station_id: spot.source_station_id,
  };
}

/**
 * route-sequences.json（route_id→{direction_id:[station_id,...]}）から、
 * legOriginIdがlegDestIdより手前にある方向を選び、legDestIdより後ろのstation_id集合を返す。
 * 【重要】legOriginId（共通の乗車駅）だけでは前後どちらの駅も拾ってしまう
 * （双方向が同じroute_idを使う鉄道路線で、手前の駅を「先」と誤判定するバグが
 * 調査で見つかった）。必ずlegOriginId→legDestIdの順で先に出てくる方向を選ぶこと。
 */
function stationsAfter(routeSequences, routeId, legOriginId, legDestId) {
  const directions = routeSequences?.[routeId];
  if (!directions) return new Set();
  for (const seq of Object.values(directions)) {
    const originIdx = seq.indexOf(legOriginId);
    const destIdx = seq.indexOf(legDestId);
    if (originIdx !== -1 && destIdx !== -1 && originIdx < destIdx) {
      return new Set(seq.slice(destIdx + 1));
    }
  }
  return new Set();
}

/**
 * @param {object} context - {routeDetails, routeSequences, departureStationId, allSpots, maxBudget}
 * @param {object} currentSpot - 今見ている詳細画面のスポット（allSpots由来のオブジェクト）
 * @returns {Array<{spot:object, type:'same-route'|'nearby'|'stretch', extraFare:number}>} 最大ONWARD_COUNT件
 */
export function buildOnwardCandidates(context, currentSpot) {
  const { routeDetails, routeSequences, departureStationId, allSpots, maxBudget = 2000 } = context;
  const others = allSpots.filter((s) => s.id !== currentSpot.id);

  // 1) すぐ近く（+¥0）
  const type1 = others.filter((s) => s.source_station_id === currentSpot.source_station_id);

  // 2) 同じ路線の先（+¥X）
  let type2 = [];
  const lastLeg = resolveLastLeg(routeDetails, departureStationId, stationLikeFromSpot(currentSpot));
  if (lastLeg) {
    const after = stationsAfter(routeSequences, lastLeg.routeId, lastLeg.legOriginId, lastLeg.legDestId);
    if (after.size > 0) {
      type2 = others.filter((s) => {
        if (!after.has(s.source_station_id)) return false;
        const sLast = resolveLastLeg(routeDetails, departureStationId, stationLikeFromSpot(s));
        return sLast && sLast.routeId === lastLeg.routeId && sLast.operatorId === lastLeg.operatorId;
      });
    }
  }

  // 3) 少し足せば（+¥X）：運賃の安い順（追加額が小さい順）
  const type3 = others.filter((s) => {
    if (s.latitude == null || s.longitude == null || currentSpot.latitude == null || currentSpot.longitude == null) return false;
    const km = haversineKm(currentSpot.latitude, currentSpot.longitude, s.latitude, s.longitude);
    return km <= NEARBY_KM
      && s.source_round_trip_fare > currentSpot.source_round_trip_fare
      && s.source_round_trip_fare <= maxBudget;
  }).sort((a, b) => a.source_round_trip_fare - b.source_round_trip_fare);

  const chosen = [];
  const pushUnique = (list, type) => {
    for (const s of list) {
      if (chosen.length >= ONWARD_COUNT) break;
      if (chosen.some((c) => c.spot.id === s.id)) continue;
      chosen.push({ spot: s, type, extraFare: s.source_round_trip_fare - currentSpot.source_round_trip_fare });
    }
  };
  pushUnique(type2, 'same-route');
  pushUnique(type1, 'nearby');
  pushUnique(type3, 'stretch');

  return chosen;
}
