/**
 * compute-route-sequences.js - 路線ごとの停車パターン（station_id配列）を生成する
 * （2026-10-10、3本目「この先へ」機能。feature/kono-sakiブランチ）
 *
 * 【背景】「この先へ」の候補のうち「2) 同じ路線の先」（今の区間と同じ路線で、
 * さらに先の停留所で降りて行ける場所）を正しく判定するには、「どちらの駅が
 * 先か」という方向の情報が要る。route-details.json（generate-route-details.js）は
 * 駅ID→駅IDのOD対ごとにrouteIdを持つだけで方向を区別せず、同じrouteIdが
 * 双方向で使われる路線（鉄道に多い。ことでん「琴平線」はGTFSのtrips.txtで
 * direction_id=0/1を同じroute_idの下に持つ）では、手前の駅を「先」と
 * 誤判定するバグが調査で実際に見つかった（高松築港→大麻山で、手前の仏生山が
 * 「+¥-740」になる＝運賃が今より安いのに「先」と表示してしまう）。
 *
 * 【2026-10-10修正（Minami指摘）】当初は「direction_idごとに最も停留所数が
 * 多いtrip1本だけを代表として採用」していたが、これだと循環線や枝分かれ
 * （同じroute_id・同じdirection_idでも、便によって停車パターンが異なる場合。
 * 例：一部の便だけ特定区間を通らない、系統によって終点が違う等）で、
 * 実際には別の停車パターンを通る候補を「先ではない」と誤って除外する
 * おそれがあった。方式を変更し、route_idごとに実際に出現した
 * 「重複排除後の停車パターン」をすべて保持する（direction_idというラベル
 * 自体は出力に含めない。2つの停留所がどちらかのパターンの中で正しい順序で
 * 両方出現すれば「先」と判定でき、direction_idの値そのものは判定に不要なため）。
 * バス事業者（ことでんバス・まいどはやバス・富山地鉄バス等）はこのデータでは
 * 方向ごとに別route_idを持つため、この問題は起きない（確認済み）。
 *
 * 出力: route-sequences.json: { [routeId]: [[station_id, ...], [station_id, ...], ...] }
 *   （route_idごとに、重複排除済みの停車パターンの配列）
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
 * @returns {object} { routeId: [[station_id, ...], ...] }
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

    // routeId -> Map<パターンの内容文字列, station_id配列>（同一内容は1件に重複排除）
    const patternsByRoute = new Map();
    for (const t of trips) {
      const routeId = namespacedId(operator.id, t.route_id);
      const stops = stopsByTrip.get(t.trip_id) || [];

      const stationSeq = [];
      for (const s of stops) {
        const stationId = stopIdToStationId.get(s.stopId);
        if (stationId === undefined) continue;
        if (stationSeq[stationSeq.length - 1] !== stationId) stationSeq.push(stationId);
      }
      if (stationSeq.length < 2) continue; // 1駅だけの断片は「先」の判定に使えないため捨てる

      if (!patternsByRoute.has(routeId)) patternsByRoute.set(routeId, new Map());
      const patternKey = stationSeq.join('\u0001');
      patternsByRoute.get(routeId).set(patternKey, stationSeq);
    }

    for (const [routeId, patternMap] of patternsByRoute.entries()) {
      if (!result[routeId]) result[routeId] = [];
      result[routeId].push(...patternMap.values());
    }
  }

  return result;
}
