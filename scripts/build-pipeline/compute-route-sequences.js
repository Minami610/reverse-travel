/**
 * compute-route-sequences.js - 路線×方向ごとの停車順（station_id配列）を生成する
 * （2026-10-10、3本目「この先へ」機能。feature/kono-sakiブランチ）
 *
 * 【背景】「この先へ」の候補のうち「2) 同じ路線の先」（今の区間と同じ路線で、
 * さらに先の停留所で降りて行ける場所）を正しく判定するには、「どちらの駅が
 * 先か」という方向の情報が要る。route-details.json（generate-route-details.js）は
 * 駅ID→駅IDのOD対ごとにrouteIdを持つだけで、同じrouteIdが双方向で使われる
 * 路線（鉄道に多い。ことでん「琴平線」はGTFSのtrips.txtでdirection_id=0/1を
 * 同じroute_idの下に持つ）では、手前の駅を「先」と誤判定するバグが
 * 調査で実際に見つかった（高松築港→大麻山で、手前の仏生山が
 * 「+¥-740」になる＝運賃が今より安いのに「先」と表示してしまう）。
 * バス事業者（ことでんバス・まいどはやバス・富山地鉄バス等）はこのデータでは
 * 方向ごとに別route_idを持つため、この問題は起きない（確認済み）。
 *
 * 【方式】trips.txtのdirection_id（0/1、無ければ'0'扱い）ごとに、最も停留所数が
 * 多いtrip（＝その方向の代表的な全区間パターン）1本を採用し、その停車順を
 * station_id配列にする。複数パターンがあるときに停車順が区々になりうるが、
 * 「この先に何があるか」のおおまかな判定には十分な精度（厳密な全パターン
 * 網羅はしない。route-details.jsonの運賃・経路解決とは独立した補助データのため、
 * 判定を誤っても運賃・経路表示自体は壊れない）。
 *
 * 出力: route-sequences.json: { [routeId]: { [direction_id]: [station_id, ...] } }
 */
import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { namespacedId } from './gtfs-id.js';

function parseGtfsFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return parse(fs.readFileSync(filePath, 'utf-8'), { bom: true, columns: true });
}

/**
 * @param {Array<{id:string}>} operators
 * @param {string} rawGtfsDir
 * @param {Map<string,string>} stopIdToStationId
 * @returns {object} { routeId: { directionId: [station_id, ...] } }
 */
export function computeRouteSequences(operators, rawGtfsDir, stopIdToStationId) {
  const result = {};

  for (const operator of operators) {
    const dir = path.join(rawGtfsDir, operator.id);
    const trips = parseGtfsFile(path.join(dir, 'trips.txt'));
    const stopTimes = parseGtfsFile(path.join(dir, 'stop_times.txt'));
    if (trips.length === 0 || stopTimes.length === 0) continue;

    const stopsByTrip = new Map();
    for (const st of stopTimes) {
      if (!stopsByTrip.has(st.trip_id)) stopsByTrip.set(st.trip_id, []);
      stopsByTrip.get(st.trip_id).push({
        stopId: namespacedId(operator.id, st.stop_id),
        seq: parseInt(st.stop_sequence, 10),
      });
    }
    for (const arr of stopsByTrip.values()) arr.sort((a, b) => a.seq - b.seq);

    // `${routeId}\t${direction}` -> その方向の代表停車順（station_id配列、連続重複は除く）
    const best = new Map();
    for (const t of trips) {
      const routeId = namespacedId(operator.id, t.route_id);
      const direction = t.direction_id !== undefined && t.direction_id !== '' ? t.direction_id : '0';
      const key = `${routeId}\t${direction}`;
      const stops = stopsByTrip.get(t.trip_id) || [];

      const stationSeq = [];
      for (const s of stops) {
        const stationId = stopIdToStationId.get(s.stopId);
        if (stationId === undefined) continue;
        if (stationSeq[stationSeq.length - 1] !== stationId) stationSeq.push(stationId);
      }
      const existing = best.get(key);
      if (!existing || stationSeq.length > existing.length) best.set(key, stationSeq);
    }

    for (const [key, stationSeq] of best.entries()) {
      const [routeId, direction] = key.split('\t');
      if (stationSeq.length < 2) continue; // 1駅だけの断片は「先」の判定に使えないため捨てる
      if (!result[routeId]) result[routeId] = {};
      result[routeId][direction] = stationSeq;
    }
  }

  return result;
}
