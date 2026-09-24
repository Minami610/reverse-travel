/**
 * generate-route-details.js - 経路（使用路線・所要時間）情報の生成
 *
 * fare-lookup-tables.json の od_fares（停留所単位のOD運賃表）に登場する
 * 「駅名→駅名」の組み合わせについて、trips.txt + stop_times.txt から
 * 実際にその区間を直通する便があるかを検証し、使用路線と所要時間を確定する。
 *
 * 【方針】
 * - 「両端を通る路線の積集合」だけでは判定しない。GTFSの各tripのstop_times
 *   を停留所順序どおりに走査し、出発停留所→到着停留所を「この順序で」
 *   通る便が実在する場合のみ、その路線を「直行」として確定する。
 * - 直行が確定できないOD区間（例：琴電の異なる路線をまたぐ区間）は、
 *   出発駅から直行できる駅（乗換候補地）を経由し、そこから目的駅へ
 *   直行できるかを1回まで試す（乗換候補が複数ある場合は合計所要時間が
 *   最短のものを採用）。
 * - それでも確定できない区間は route-details.json に含めず、件数を報告する。
 * - 所要時間の代表値は「中央値」を採用（同一路線・同一区間で複数便がある場合）。
 *   最短値ではなく中央値を選んだのは、始発・終電などの外れ値に引っ張られず
 *   「実際に乗るとだいたいこのくらい」という値になるため。
 *
 * 各区間には「期待待ち時間」（expected_wait_min）も付与する。これは
 * アクセス駅選定（fare-calculator.js / spot-finder.js）が「乗車時間だけが
 * 短い低頻度路線」を不当に優先しないようにするための指標で、
 *   平均運行間隔 = 運行時間帯の幅（最終便の出発時刻－始発便の出発時刻） ÷ 便数
 *   期待待ち時間 = 平均運行間隔 ÷ 2
 * という簡易な推定（精密な時刻表探索ではない）。表示（route-formatter.js）は
 * 引き続き乗車時間のみを使い、期待待ち時間は選定ロジックにのみ使う。
 * 便数が1便しかない区間は運行間隔を算出できないため、フォールバック値
 * FALLBACK_INTERVAL_FOR_SINGLE_TRIP_MIN を運行間隔とみなす（＝実質的に
 * 「他に選択肢があればまず選ばれない」程度の大きなペナルティを与える）。
 *
 * 出力：
 * - route-details.json : {出発駅名: {到着駅名: RouteEntry}}
 *   RouteEntry は配列で、長さでdirect/transferを判別する（キー名の繰り返しを避けて
 *   ファイルサイズを抑えるため）：
 *     - 直行:   [route_id, duration_min, expected_wait_min]                                        （長さ3）
 *     - 乗換1回: [via, route_id_1, duration_min_1, wait_min_1, route_id_2, duration_min_2, wait_min_2] （長さ7）
 */

import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { fileURLToPath } from 'url';
import { namespacedId } from './gtfs-id.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.join(__dirname, '../../data');
const rawGtfsDir = path.join(dataDir, 'raw-gtfs');
const derivedDir = path.join(dataDir, 'derived');
const configPath = path.join(__dirname, '../../config/target-operators.json');

function parseGtfsFile(filePath) {
  return parse(fs.readFileSync(filePath, 'utf-8'), { bom: true, columns: true });
}

/** "HH:MM:SS" を分に変換（GTFSは24時を超える表記（例: 25:10:00）を許容するため単純加算） */
function timeToMinutes(hms) {
  const [h, m, s] = hms.split(':').map(Number);
  return h * 60 + m + s / 60;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export async function generateRouteDetails() {
  console.log('🔄 経路情報（路線・所要時間）を生成中...\n');

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const stopsMeta = JSON.parse(
    fs.readFileSync(path.join(derivedDir, 'stops-metadata.json'), 'utf-8')
  );
  const fareLookup = JSON.parse(
    fs.readFileSync(path.join(derivedDir, 'fare-lookup-tables.json'), 'utf-8')
  );
  const stopIdToName = new Map(stopsMeta.map((s) => [s.stop_id, s.stop_name]));

  // 1. 「停留所→その停留所を通る路線」相当の情報を、tripごとのstop_times順序を
  //    走査することで「駅名→駅名の直行ペア（路線別・所要時間サンプル付き）」として構築する
  //    Map<originName, Map<destName, Map<routeId, minutes[]>>>
  const stationDirect = new Map();
  let totalTrips = 0;

  for (const operator of config.phase1_operators) {
    const operatorDir = path.join(rawGtfsDir, operator.id);
    const tripsPath = path.join(operatorDir, 'trips.txt');
    const stopTimesPath = path.join(operatorDir, 'stop_times.txt');
    if (!fs.existsSync(tripsPath) || !fs.existsSync(stopTimesPath)) {
      console.warn(`  ⚠️  ${operator.name}: trips.txt/stop_times.txt が見つかりません（スキップ）`);
      continue;
    }

    const trips = parseGtfsFile(tripsPath);
    const stopTimes = parseGtfsFile(stopTimesPath);
    // route_id/stop_idはparse-and-transform.jsの出力（stops-metadata.json/
    // route-info.json）と同じ名前空間化を適用しないと、生のGTFSファイルを
    // 直接読んでいるこのスクリプト側だけIDが一致しなくなる。
    const tripToRoute = new Map(trips.map((t) => [t.trip_id, namespacedId(operator.id, t.route_id)]));

    const tripStopsMap = new Map();
    for (const st of stopTimes) {
      if (!tripStopsMap.has(st.trip_id)) tripStopsMap.set(st.trip_id, []);
      tripStopsMap.get(st.trip_id).push({ ...st, stop_id: namespacedId(operator.id, st.stop_id) });
    }

    for (const [tripId, stops] of tripStopsMap.entries()) {
      stops.sort((a, b) => parseInt(a.stop_sequence, 10) - parseInt(b.stop_sequence, 10));
      const routeId = tripToRoute.get(tripId);
      if (!routeId) continue;
      totalTrips += 1;

      // 同一trip内で「先に通る停留所→後に通る停留所」の全組み合わせが
      // 「この順序で通る＝直通する」ペアの正解データになる
      for (let i = 0; i < stops.length; i++) {
        const nameI = stopIdToName.get(stops[i].stop_id);
        if (!nameI) continue;
        for (let j = i + 1; j < stops.length; j++) {
          const nameJ = stopIdToName.get(stops[j].stop_id);
          if (!nameJ || nameJ === nameI) continue;

          const departureMin = timeToMinutes(stops[i].departure_time);
          const duration = timeToMinutes(stops[j].arrival_time) - departureMin;
          if (duration < 0) continue; // 異常データガード

          if (!stationDirect.has(nameI)) stationDirect.set(nameI, new Map());
          const destMap = stationDirect.get(nameI);
          if (!destMap.has(nameJ)) destMap.set(nameJ, new Map());
          const routeMap = destMap.get(nameJ);
          if (!routeMap.has(routeId)) routeMap.set(routeId, []);
          routeMap.get(routeId).push({ duration, departureMin });
        }
      }
    }
  }

  console.log(`  - 処理trip数: ${totalTrips}`);
  console.log(`  - 直行ペアを持つ出発駅数: ${stationDirect.size}`);

  // 候補路線が複数ある場合の選択基準：
  // 「便数最多」を単純採用すると、循環バスの遠回り方向のように便数は多いが
  // 大幅に遠回りな路線が選ばれてしまうことがある（実測：高松築港→栗林公園前で
  // 中央値48分の路線が選ばれ、実際に最短の路線は中央値10分だった）。
  // 一方で単純な「最短」採用は、1日数便しかない稀な便を拾ってしまうリスクがある
  // （実測：全15,770直行ペア中、最短基準では便数2以下の路線が選ばれるペアが
  // 496→905件に倍増した）。
  // そのため「一定便数以上ある候補の中で最短」を採る折衷案を採用する。
  // 実測では、この方式は所要時間短縮の効果をほぼ最短基準と同程度に保ちながら
  // （合計所要時間 -5,270分、便数最多基準は-6,497分）、便数2以下の路線が
  // 選ばれるペア数を最短基準の905件から便数最多基準と同じ496件まで戻せた。
  const MIN_TRIPS_FOR_SPEED_PREFERENCE = 3;

  // 便数1本だけの区間は運行間隔を実測できないため、大きめの固定値で代用し、
  // 「他に選択肢があればまず選ばれない」程度のペナルティを与える
  const FALLBACK_INTERVAL_FOR_SINGLE_TRIP_MIN = 720; // 12時間 → 期待待ち時間360分

  function resolveDirect(originName, destName) {
    const routeMap = stationDirect.get(originName)?.get(destName);
    if (!routeMap || routeMap.size === 0) return null;

    const candidates = [];
    for (const [routeId, entries] of routeMap.entries()) {
      const durations = entries.map((e) => e.duration);
      const departureMins = entries.map((e) => e.departureMin);
      const tripCount = entries.length;
      const span = Math.max(...departureMins) - Math.min(...departureMins);
      const avgIntervalMin = tripCount >= 2 ? span / tripCount : FALLBACK_INTERVAL_FOR_SINGLE_TRIP_MIN;

      candidates.push({
        route_id: routeId,
        duration_min: Math.round(median(durations)),
        sample_size: tripCount,
        expected_wait_min: Math.round(avgIntervalMin / 2),
      });
    }

    // 便数が一定以上ある候補があればその中から最短を選ぶ。
    // なければ（そもそも便数の少ない候補しかない区間）全候補中の最短にフォールバックする。
    const qualified = candidates.filter((c) => c.sample_size >= MIN_TRIPS_FOR_SPEED_PREFERENCE);
    const pool = qualified.length > 0 ? qualified : candidates;

    let best = null;
    for (const candidate of pool) {
      if (
        !best ||
        candidate.duration_min < best.duration_min ||
        (candidate.duration_min === best.duration_min && candidate.sample_size > best.sample_size)
      ) {
        best = candidate;
      }
    }
    return best;
  }

  // 2. od_fares に登場する「駅名→駅名」ペアについて経路を確定する
  const odStationPairs = new Set();
  for (const [originStopId, dests] of Object.entries(fareLookup.od_fares)) {
    const originName = stopIdToName.get(originStopId);
    if (!originName) continue;
    for (const destStopId of Object.keys(dests)) {
      const destName = stopIdToName.get(destStopId);
      if (!destName || destName === originName) continue;
      odStationPairs.add(`${originName}\t${destName}`);
    }
  }

  const routeDetails = {};
  let directCount = 0;
  let transferCount = 0;
  let unresolvedCount = 0;
  const unresolvedSamples = [];

  for (const pairKey of odStationPairs) {
    const [originName, destName] = pairKey.split('\t');

    const direct = resolveDirect(originName, destName);
    if (direct) {
      if (!routeDetails[originName]) routeDetails[originName] = {};
      routeDetails[originName][destName] = [direct.route_id, direct.duration_min, direct.expected_wait_min];
      directCount += 1;
      continue;
    }

    // 直行不可 → 1回の乗換を試行。
    // originから直行できる駅を経由候補とし、そこからdestへ直行できるものの中で
    // 合計所要時間が最短のものを採用する。
    const originDests = stationDirect.get(originName);
    let bestTransfer = null;
    if (originDests) {
      for (const hubName of originDests.keys()) {
        if (hubName === destName) continue;
        const leg2 = resolveDirect(hubName, destName);
        if (!leg2) continue;
        const leg1 = resolveDirect(originName, hubName);
        if (!leg1) continue;
        const total = leg1.duration_min + leg2.duration_min;
        if (!bestTransfer || total < bestTransfer.total) {
          bestTransfer = { via: hubName, leg1, leg2, total };
        }
      }
    }

    if (bestTransfer) {
      if (!routeDetails[originName]) routeDetails[originName] = {};
      routeDetails[originName][destName] = [
        bestTransfer.via,
        bestTransfer.leg1.route_id,
        bestTransfer.leg1.duration_min,
        bestTransfer.leg1.expected_wait_min,
        bestTransfer.leg2.route_id,
        bestTransfer.leg2.duration_min,
        bestTransfer.leg2.expected_wait_min,
      ];
      transferCount += 1;
    } else {
      unresolvedCount += 1;
      if (unresolvedSamples.length < 20) unresolvedSamples.push(pairKey.replace('\t', ' → '));
    }
  }

  console.log(`\n📊 経路確定の内訳（駅名ペア単位、全${odStationPairs.size}件）`);
  console.log(`  - 直行: ${directCount}`);
  console.log(`  - 乗換1回で確定: ${transferCount}`);
  console.log(`  - 確定できず: ${unresolvedCount}`);
  if (unresolvedSamples.length > 0) {
    console.log(`  - 確定できなかった例: ${unresolvedSamples.join(', ')}`);
  }
  if (unresolvedCount === 0) {
    console.log('  - すべてのOD区間で経路を確定できました');
  }

  // サイズ抑制のためcompact出力（pretty-printしない）
  fs.writeFileSync(path.join(derivedDir, 'route-details.json'), JSON.stringify(routeDetails));
  const fileSize = fs.statSync(path.join(derivedDir, 'route-details.json')).size;
  console.log(`\n✅ route-details.json (${(fileSize / 1024).toFixed(1)} KB, ${directCount + transferCount}件の経路情報)`);

  return { directCount, transferCount, unresolvedCount, total: odStationPairs.size };
}

// 実行
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  generateRouteDetails().catch((error) => {
    console.error('❌ 致命的エラー:', error);
    process.exit(1);
  });
}
