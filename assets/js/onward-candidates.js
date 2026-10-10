/**
 * onward-candidates.js - 「この先へ」候補の計算（2026-10-10、3本目。feature/kono-sakiブランチ）
 *
 * 詳細画面の下に出す3件の候補を、優先順位 2)→1)→3) で選ぶ。
 * 1) すぐ近く：今と同じ到達駅（station_id）から行ける別のスポットのうち、
 *    徒歩20分以内（直線距離÷時速4km）のもの。20分を超える候補はこの種類に入れない。
 * 2) 同じ路線の先：今の最後の区間と同じ事業者・同じ路線・同じ向きで、さらに先の駅から
 *    行けるスポット（route-sequences.json＝路線ごとの停車パターンが必要。無ければ
 *    0件扱いになるだけで、1)・3)で埋まる＝壊れない）。候補自身の最後の区間も同じ
 *    事業者・路線であることを確認する（候補への一番安い行き方が別路線経由なら対象外）。
 * 3) 少し足せば：直線5km以内・運賃が今より高く上限（¥2000）以下のスポット。
 *
 * 「+¥X」は「出発駅から候補への往復運賃－出発駅から今の場所への往復運賃」
 * （今の場所から乗り直す運賃ではない。Minamiさんの定義どおり）。
 * 候補の運賃は常に¥2000以下（allSpots自体がMAX_BUDGET=2000のcalculateReachable()から
 * 作られているため自然に満たされるが、呼び出し元の前提が変わっても壊れないよう
 * ここでも明示的に上限チェックする）。
 * 候補にも応援マーク判定（route-duration.jsのestimateTripFrequency）をそのまま使う
 * （main.js側）。
 *
 * 計算にはallSpots（計算済み、検索1回につき1回でよい）だけを使い、
 * GTFS生データの読み込みは行わない（型は全てビルド時生成の軽量JSON）。
 * 実測：allSpots計算済みの状態からの候補計算は1ms未満〜数ms程度（スマホ相当で50ms以内の目安を満たす）。
 */
import { resolveLastLeg, lookupRouteEntry, parseRouteEntry } from './route-duration.js';

const NEARBY_KM = 5;
const WALK_KM_PER_HOUR = 4; // Minami指定：直線距離÷時速4km
const NEARBY_WALK_MAX_MIN = 20; // これを超える徒歩時間の候補は「すぐ近く」に入れない
export const ONWARD_COUNT = 3;
export const ONWARD_MAX_FARE = 2000;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function walkMinutesForKm(km) {
  return (km / WALK_KM_PER_HOUR) * 60;
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
 * route-sequences.json（route_id→[[station_id,...], ...]＝重複排除済みの停車パターンの配列）
 * から、legOriginIdがlegDestIdより手前にあるパターンを探し、legDestIdより後ろの
 * station_id集合を返す。
 * 【重要】1つの路線に複数の停車パターンがありうる（循環線・枝分かれ・便によって
 * 停車パターンが違う等）ため、全パターンを試す。legOriginId（共通の乗車駅）だけでは
 * 前後どちらの駅も拾ってしまう（双方向が同じroute_idを使う鉄道路線で、手前の駅を
 * 「先」と誤判定するバグが調査で見つかった）ため、必ずlegOriginId→legDestIdの順で
 * 先に出てくるパターンを選ぶこと。
 * 【2026-10-10追記、Minami指摘】循環線（最初と最後の停留所が同じ、または1つの
 * パターンの中で同じ停留所を2回通る）では、乗車駅・降車駅のどちらかにパターンが
 * 再び戻ってくる地点（＝一周してきた場合の再訪問）より先は「後ろ」に含めない。
 * そうしないと、一周後に再登場する乗車駅自身（＝利用者が実際に乗った場所）が
 * 「先にある場所」として誤って案内されてしまう。
 */
function stationsAfter(routeSequences, routeId, legOriginId, legDestId) {
  const patterns = routeSequences?.[routeId];
  if (!patterns) return new Set();
  const after = new Set();
  for (const seq of patterns) {
    const originIdx = seq.indexOf(legOriginId);
    const destIdx = seq.indexOf(legDestId);
    if (originIdx === -1 || destIdx === -1 || originIdx >= destIdx) continue;
    let endIdx = seq.length;
    const nextOriginIdx = seq.indexOf(legOriginId, destIdx + 1);
    const nextDestIdx = seq.indexOf(legDestId, destIdx + 1);
    if (nextOriginIdx !== -1) endIdx = Math.min(endIdx, nextOriginIdx);
    if (nextDestIdx !== -1) endIdx = Math.min(endIdx, nextDestIdx);
    for (const stationId of seq.slice(destIdx + 1, endIdx)) after.add(stationId);
  }
  return after;
}

/**
 * 今の停留所（legDestId）から候補の停留所まで、同じ事業者・同じ路線で直行した場合の
 * 所要時間（分）をroute-details.jsonから引く。解決できなければnull
 * （呼び出し側は一言を「同じバスでその先」にフォールバックする）。
 */
function sameRouteMinutes(routeDetails, operatorId, fromStationId, toStationId) {
  const parsed = parseRouteEntry(lookupRouteEntry(routeDetails, fromStationId, toStationId, operatorId));
  if (!parsed || parsed.type !== 'direct') return null;
  return parsed.duration_min;
}

/**
 * @param {object} context - {routeDetails, routeSequences, departureStationId, allSpots, maxBudget}
 * @param {object} currentSpot - 今見ている詳細画面のスポット（allSpots由来のオブジェクト）
 * @returns {Array<{spot:object, type:'same-route'|'nearby'|'stretch', extraFare:number,
 *   sameRouteMinutes?:number, walkMinutes?:number, straightKm?:number, routeId?:string}>}
 *   最大ONWARD_COUNT件。routeId（type='same-route'のみ）は一言「同じ電車/バス/便で」の
 *   呼び分け（route-duration.jsのsameRouteWord()）にroute-info.jsonを引くための路線ID。
 */
export function buildOnwardCandidates(context, currentSpot) {
  const { routeDetails, routeSequences, departureStationId, allSpots, maxBudget = ONWARD_MAX_FARE } = context;
  const effectiveMaxFare = Math.min(maxBudget, ONWARD_MAX_FARE);
  const others = allSpots.filter((s) => s.id !== currentSpot.id && s.source_round_trip_fare <= effectiveMaxFare);

  // 1) すぐ近く：同じ到達駅から行け、かつ徒歩20分以内（直線距離÷時速4km）
  const type1 = others
    .map((s) => {
      if (s.source_station_id !== currentSpot.source_station_id) return null;
      if (s.latitude == null || s.longitude == null || currentSpot.latitude == null || currentSpot.longitude == null) {
        return { spot: s, walkMinutes: null };
      }
      const km = haversineKm(currentSpot.latitude, currentSpot.longitude, s.latitude, s.longitude);
      return { spot: s, walkMinutes: walkMinutesForKm(km) };
    })
    .filter((entry) => entry && (entry.walkMinutes === null || entry.walkMinutes <= NEARBY_WALK_MAX_MIN));

  // 2) 同じ路線の先：今の最後の区間と同じ事業者・同じ路線・同じ向きで、さらに先の駅
  let type2 = [];
  const lastLeg = resolveLastLeg(routeDetails, departureStationId, stationLikeFromSpot(currentSpot));
  if (lastLeg) {
    const after = stationsAfter(routeSequences, lastLeg.routeId, lastLeg.legOriginId, lastLeg.legDestId);
    if (after.size > 0) {
      type2 = others
        .filter((s) => {
          if (!after.has(s.source_station_id)) return false;
          const sLast = resolveLastLeg(routeDetails, departureStationId, stationLikeFromSpot(s));
          return sLast && sLast.routeId === lastLeg.routeId && sLast.operatorId === lastLeg.operatorId;
        })
        .map((s) => ({
          spot: s,
          sameRouteMinutes: sameRouteMinutes(routeDetails, lastLeg.operatorId, lastLeg.legDestId, s.source_station_id),
          routeId: lastLeg.routeId,
        }));
    }
  }

  // 3) 少し足せば：直線5km以内・運賃が今より高く上限以下。追加額が小さい順
  const type3 = others
    .filter((s) => s.source_round_trip_fare > currentSpot.source_round_trip_fare)
    .map((s) => {
      if (s.latitude == null || s.longitude == null || currentSpot.latitude == null || currentSpot.longitude == null) return null;
      const km = haversineKm(currentSpot.latitude, currentSpot.longitude, s.latitude, s.longitude);
      return km <= NEARBY_KM ? { spot: s, straightKm: km } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.spot.source_round_trip_fare - b.spot.source_round_trip_fare);

  const chosen = [];
  const pushUnique = (list, type) => {
    for (const entry of list) {
      if (chosen.length >= ONWARD_COUNT) break;
      if (chosen.some((c) => c.spot.id === entry.spot.id)) continue;
      chosen.push({
        spot: entry.spot,
        type,
        extraFare: entry.spot.source_round_trip_fare - currentSpot.source_round_trip_fare,
        sameRouteMinutes: entry.sameRouteMinutes,
        walkMinutes: entry.walkMinutes,
        straightKm: entry.straightKm,
        routeId: entry.routeId,
      });
    }
  };
  pushUnique(type2, 'same-route');
  pushUnique(type1, 'nearby');
  pushUnique(type3, 'stretch');

  return chosen;
}
