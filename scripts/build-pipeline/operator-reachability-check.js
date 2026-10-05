/**
 * operator-reachability-check.js - 採用した事業者ごとに「どこにも行けない」事業者を検出する
 *
 * 【背景】これまでの0件チェックは県全体の到達駅数・経路情報数しか見ておらず、
 * 「事業者が丸ごと検索結果に出てこない」状態を見逃していた。実際に富山の
 * 再取得（gtfs-data.jpのフィード一覧をAPIから動的取得するよう修正した際）で、
 * 21事業者中13事業者が均一運賃型で、fare-calculator.jsがod_faresしか読まない
 * 設計のため検索結果に一切出てこない状態になっていたが、県全体の到達駅数は
 * 0ではなかったため既存のチェックでは検出できなかった。
 *
 * 採用した事業者ごとに「その事業者の駅の数」と「そこから1駅以上（別の駅）へ
 * 行ける駅の数」を数え、後者が0の事業者があればビルドを失敗させる。
 * config/zero-reach-operators-allowlist.json に理由付きで載っている事業者だけは
 * 例外として許容する（除外機構の「個別許可リスト」と同じ考え方。手書きで
 * チェックをすり抜けさせるのではなく、理由を記録した上で明示的に許容する）。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const allowlistPath = path.join(__dirname, '../../config/zero-reach-operators-allowlist.json');

function loadAllowlist() {
  if (!fs.existsSync(allowlistPath)) return new Map();
  const data = JSON.parse(fs.readFileSync(allowlistPath, 'utf-8'));
  return new Map((data.allowed || []).map((e) => [e.operator, e.reason]));
}

/**
 * @param {object} stations - stations.json相当（station_id -> {stops: [{stop_id, operator_id}, ...]}）
 * @param {object} odFares - fare-lookup-tables.jsonのod_fares（stop_id -> {destStopId: fare}）
 * @param {Array<{id: string, name: string}>} operators - 採用した事業者一覧
 * @returns {{
 *   perOperator: Array<{operator, name, stationCount, reachableCount}>,
 *   failing: Array<{operator, name, stationCount, reachableCount}>,
 *   allowlisted: Array<{operator, name, stationCount, reachableCount, reason}>,
 * }}
 */
export function checkOperatorReachability(stations, odFares, operators) {
  const stopIdToStationId = new Map();
  for (const [stationId, station] of Object.entries(stations)) {
    for (const stop of station.stops) {
      stopIdToStationId.set(stop.stop_id, stationId);
    }
  }

  const statsByOperator = new Map(
    operators.map((op) => [op.id, { operator: op.id, name: op.name, stationCount: 0, reachableCount: 0 }])
  );

  for (const [stationId, station] of Object.entries(stations)) {
    const operatorIdsHere = new Set(station.stops.map((s) => s.operator_id));
    for (const operatorId of operatorIdsHere) {
      const stat = statsByOperator.get(operatorId);
      if (!stat) continue; // 採用外の事業者（ありえないはずだが安全側）

      stat.stationCount += 1;

      // この駅に属する「その事業者自身の」stop_idのいずれかから、別の駅へ
      // 行けるod_fares登録が1件でもあれば「到達可能」とみなす。
      const hasReach = station.stops.some((stop) => {
        if (stop.operator_id !== operatorId) return false;
        const destinations = odFares[stop.stop_id];
        if (destinations === undefined) return false;
        return Object.keys(destinations).some(
          (destStopId) => stopIdToStationId.get(destStopId) !== stationId
        );
      });
      if (hasReach) stat.reachableCount += 1;
    }
  }

  const allowlist = loadAllowlist();
  const perOperator = [...statsByOperator.values()];
  const zeroReach = perOperator.filter((s) => s.stationCount > 0 && s.reachableCount === 0);
  const failing = zeroReach.filter((s) => !allowlist.has(s.operator));
  const allowlisted = zeroReach
    .filter((s) => allowlist.has(s.operator))
    .map((s) => ({ ...s, reason: allowlist.get(s.operator) }));

  return { perOperator, failing, allowlisted };
}
