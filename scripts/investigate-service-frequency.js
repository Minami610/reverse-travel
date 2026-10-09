/**
 * investigate-service-frequency.js - 「便数」調査スクリプト（2026-10-09、調査専用）
 *
 * 2本目「カードの刷新＋便の少ない路線を応援マーク」の実装前調査（1(a)〜(e)）のための
 * 読み取り専用スクリプト。本番ビルド・docs/・data/derived/ の内容は一切変更しない。
 * `scripts/survey-national-coverage.js` と同じ「調査専用・標準経路には繋がない」方針。
 *
 * 出力は標準出力のみ（必要ならリダイレクトしてファイルに保存する）。
 *
 * 【本番ビルドからは呼ばれない】このスクリプトは調査専用であり、
 * npm run build / build-prefecture.js のどこからもimportされない。
 * 便数の実装は scripts/build-pipeline/compute-service-frequency.js
 * （generate-route-details.jsから呼ばれる）に切り出した。
 *
 * 【注意】このスクリプトは「route-details.jsonにまだ便数情報が無い」調査時点の
 * 前提で書かれている（RouteEntryの長さを直行=2・乗換=5として解析する）。
 * 2026-10-10の実装後はroute-details.json自体に便数が埋め込まれる（直行=5・乗換=8）ため、
 * このスクリプトを再実行する場合は、assets/js/route-duration.jsの新しい長さに
 * 合わせて読み替えること（当時の調査結果の再現が目的なら、便数情報が無い
 * 旧データ・旧ビルド成果物に対して実行する想定）。
 *
 * 実行: node scripts/investigate-service-frequency.js [--only=16,17,37]
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { parse } from 'csv-parse/sync';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  isHoliday,
  findFirstNonHolidayWeekdayOnOrAfter,
} from './build-pipeline/jp-holidays.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const rawGtfsDir = path.join(rootDir, 'data/raw-gtfs');

function toUrl(relativePath) {
  return pathToFileURL(path.join(rootDir, relativePath)).href;
}

function readPrefJson(codeStr, name) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, 'data/derived/pref', codeStr, name), 'utf-8'));
}

function parseGtfsFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return parse(fs.readFileSync(filePath, 'utf-8'), { bom: true, columns: true });
}

function timeToMinutes(hms) {
  const [h, m, s] = hms.split(':').map(Number);
  return h * 60 + (m || 0) + (s || 0) / 60;
}

function namespacedId(operatorId, rawId) {
  return `${operatorId}:${rawId}`;
}

// ---------------------------------------------------------------------------
// カレンダー解決（calendar.txt + calendar_dates.txt → 任意の日付でのservice_id有効判定）
// ---------------------------------------------------------------------------

const DOW_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function loadOperatorCalendar(operatorId) {
  const dir = path.join(rawGtfsDir, operatorId);
  const calendar = parseGtfsFile(path.join(dir, 'calendar.txt'));
  const calendarDates = parseGtfsFile(path.join(dir, 'calendar_dates.txt'));
  const feedInfoRows = parseGtfsFile(path.join(dir, 'feed_info.txt'));
  const feedInfo = feedInfoRows[0] || {};

  const weekly = new Map(); // service_id -> {days[7], start, end}
  for (const row of calendar) {
    weekly.set(row.service_id, {
      days: DOW_KEYS.map((k) => row[k] === '1'),
      start: row.start_date,
      end: row.end_date,
    });
  }

  const exceptions = new Map(); // service_id -> Map<date, '1'|'2'>
  for (const row of calendarDates) {
    if (!exceptions.has(row.service_id)) exceptions.set(row.service_id, new Map());
    exceptions.get(row.service_id).set(row.date, row.exception_type);
  }

  return { weekly, exceptions, feedStartDate: feedInfo.feed_start_date, feedEndDate: feedInfo.feed_end_date };
}

function isServiceActiveOnDate(calendar, serviceId, dateStr) {
  const exception = calendar.exceptions.get(serviceId)?.get(dateStr);
  if (exception === '1') return true;
  if (exception === '2') return false;

  const weekly = calendar.weekly.get(serviceId);
  if (!weekly) return false; // calendar.txtに無くcalendar_dates.txtにも例外がない=非該当
  if (dateStr < weekly.start || dateStr > weekly.end) return false;
  const dow = new Date(`${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}T00:00:00Z`).getUTCDay();
  return weekly.days[dow];
}

/**
 * 運行期間内（feed_start_date起点）で、祝日でない7曜日それぞれの代表候補日を決める。
 * 戻り値: {mon,tue,wed,thu,fri,sat,sun: 'YYYYMMDD'}
 * 水曜・日曜は従来どおりの参考表示用に残す。
 */
function pickRepresentativeDates(calendar) {
  const anchor = calendar.feedStartDate;
  if (!anchor) return null;
  return {
    weekday: findFirstNonHolidayWeekdayOnOrAfter(anchor, 3), // 水曜
    weekend: findFirstNonHolidayWeekdayOnOrAfter(anchor, 0), // 日曜
  };
}

// 曜日ビットフラグの並び（月=bit0 … 日=bit6）。表示側（フロント）が
// 「火・金のみ」のような文言を組み立てられるよう、曜日ごとの実際の運行有無を保持する。
const WEEKDAY_ORDER = [1, 2, 3, 4, 5]; // 月,火,水,木,金（Date#getUTCDay()の値）
const WEEKDAY_BIT_LABELS = ['月', '火', '水', '木', '金'];
const WEEKEND_ORDER = [0, 6]; // 日,土
// 平日の代表日（表示カウントに使う1日）を選ぶ優先順：水曜を最優先、無ければ近い曜日へ
const WEEKDAY_PRIORITY = [3, 2, 4, 1, 5];

function getOperatorCandidateDates(operatorId) {
  const cal = getCalendar(operatorId);
  const anchor = cal.feedStartDate;
  if (!anchor) return null;
  const weekdayDates = WEEKDAY_ORDER.map((dow) => findFirstNonHolidayWeekdayOnOrAfter(anchor, dow));
  const weekendDates = WEEKEND_ORDER.map((dow) => findFirstNonHolidayWeekdayOnOrAfter(anchor, dow));
  return { weekdayDates, weekendDates }; // weekdayDates[i] は月,火,水,木,金の順
}

const candidateDateCache = new Map();
function getCandidateDates(operatorId) {
  if (!candidateDateCache.has(operatorId)) candidateDateCache.set(operatorId, getOperatorCandidateDates(operatorId));
  return candidateDateCache.get(operatorId);
}

// ---------------------------------------------------------------------------
// trips.txt + stop_times.txt のロード（operator単位でキャッシュ）
// ---------------------------------------------------------------------------

const operatorTripCache = new Map();

function loadOperatorTrips(operatorId) {
  if (operatorTripCache.has(operatorId)) return operatorTripCache.get(operatorId);
  const dir = path.join(rawGtfsDir, operatorId);
  const trips = parseGtfsFile(path.join(dir, 'trips.txt'));
  const stopTimes = parseGtfsFile(path.join(dir, 'stop_times.txt'));
  const routes = parseGtfsFile(path.join(dir, 'routes.txt'));

  const routeNameById = new Map(routes.map((r) => [
    namespacedId(operatorId, r.route_id),
    r.route_long_name || r.route_short_name || r.route_id,
  ]));

  const tripMeta = new Map(); // trip_id -> {routeId, serviceId}
  for (const t of trips) {
    tripMeta.set(t.trip_id, {
      routeId: namespacedId(operatorId, t.route_id),
      serviceId: t.service_id,
    });
  }

  const tripStops = new Map(); // trip_id -> [{stop_id(namespaced), seq, pickup_type}]
  for (const st of stopTimes) {
    if (!tripStops.has(st.trip_id)) tripStops.set(st.trip_id, []);
    tripStops.get(st.trip_id).push({
      stopId: namespacedId(operatorId, st.stop_id),
      seq: parseInt(st.stop_sequence, 10),
      pickupType: st.pickup_type,
    });
  }
  for (const stops of tripStops.values()) stops.sort((a, b) => a.seq - b.seq);

  const result = { tripMeta, tripStops, routeNameById };
  operatorTripCache.set(operatorId, result);
  return result;
}

// ---------------------------------------------------------------------------
// 便数カウント（2026-10-10改訂：route_idをまたぐ「区間」単位に変更）
//
// 【Minami指示】路線（route_id）単位の便数では、同じ路線が曜日ごとに別route_idに
// 分かれているケース（南砺市nanbus等）で、実際に乗る区間の便数とずれる。
// 「乗る停留所→降りる停留所」を、同一事業者内であればroute_idをまたいで実際に
// 両方停まって正しい順に通る便を数える（generate-route-details.jsのstationDirect
// 構築と同じ総当たりを、日付でフィルタして行う）。
// ---------------------------------------------------------------------------

const calendarCache = new Map();
function getCalendar(operatorId) {
  if (!calendarCache.has(operatorId)) calendarCache.set(operatorId, loadOperatorCalendar(operatorId));
  return calendarCache.get(operatorId);
}

function getRepresentativeDates(operatorId) {
  return pickRepresentativeDates(getCalendar(operatorId));
}

/**
 * 指定operatorの指定日に走る、全station_idペア×区間の便数インデックスを構築する
 * （route_idをまたいで集計。generate-route-details.jsのstationDirect構築と同じ
 * 「同一trip内で先に通る停留所→後に通る停留所」の総当たりを、日付でアクティブな
 * tripだけに絞って行う）。
 * @returns {Map<string, {count:number, demandCount:number}>} キーは`${originStationId}\t${destStationId}`
 */
const segmentIndexCache = new Map(); // `${mapId}\t${operatorId}\t${dateStr}` -> Map
function buildSegmentIndexForDate(operatorId, dateStr, stopIdToStationId, mapId) {
  const cacheKey = `${mapId}\t${operatorId}\t${dateStr}`;
  if (segmentIndexCache.has(cacheKey)) return segmentIndexCache.get(cacheKey);

  const calendar = getCalendar(operatorId);
  const { tripMeta, tripStops } = loadOperatorTrips(operatorId);
  const index = new Map();

  for (const [tripId, meta] of tripMeta.entries()) {
    if (!isServiceActiveOnDate(calendar, meta.serviceId, dateStr)) continue;
    const stops = tripStops.get(tripId) || [];
    const isDemandTrip = stops.length > 0 && stops.every((s) => s.pickupType === '2');

    // station_idへマップしつつ、同一station_idの連続重複は最初の出現のみ残す
    const stationSeq = [];
    for (const s of stops) {
      const stationId = stopIdToStationId.get(s.stopId);
      if (stationId === undefined) continue;
      stationSeq.push(stationId);
    }
    for (let i = 0; i < stationSeq.length; i++) {
      for (let j = i + 1; j < stationSeq.length; j++) {
        if (stationSeq[i] === stationSeq[j]) continue;
        const key = `${stationSeq[i]}\t${stationSeq[j]}`;
        if (!index.has(key)) index.set(key, { count: 0, demandCount: 0 });
        const rec = index.get(key);
        rec.count += 1;
        if (isDemandTrip) rec.demandCount += 1;
      }
    }
  }
  segmentIndexCache.set(cacheKey, index);
  return index;
}

/**
 * 区間（同一事業者内、origin→dest、station_id単位）の便数を、曜日ビットフラグ付きで解決する。
 * 平日（月〜金）のうち1日でも便があればdayType='weekday'とし、実際に運行する曜日の
 * ビットフラグ（月=bit0…金=bit4）を持たせる。代表件数は水曜優先・近い曜日へのフォール
 * バックで1日分を選ぶ（複数の曜日で便数が異なる場合はその代表日の値を採用）。
 * 平日が1日も無ければ週末（日優先）を試し、dayType='weekend'とする。
 * @returns {{count:number, demandCount:number, dayType:'weekday'|'weekend', weekdayBits:number}|null}
 */
function resolveSegmentFrequencyV2(operatorId, originStationId, destStationId, stopIdToStationId, mapId) {
  const candidates = getCandidateDates(operatorId);
  if (!candidates) return null;
  const key = `${originStationId}\t${destStationId}`;

  let weekdayBits = 0;
  const weekdayResults = []; // {dow, count, demandCount}
  WEEKDAY_ORDER.forEach((dow, idx) => {
    const date = candidates.weekdayDates[idx];
    const index = buildSegmentIndexForDate(operatorId, date, stopIdToStationId, mapId);
    const rec = index.get(key);
    if (rec && rec.count > 0) {
      weekdayBits |= (1 << idx);
      weekdayResults.push({ dow, count: rec.count, demandCount: rec.demandCount });
    }
  });

  if (weekdayResults.length > 0) {
    let chosen = null;
    for (const dow of WEEKDAY_PRIORITY) {
      chosen = weekdayResults.find((r) => r.dow === dow);
      if (chosen) break;
    }
    return { count: chosen.count, demandCount: chosen.demandCount, dayType: 'weekday', weekdayBits };
  }

  for (const dow of WEEKEND_ORDER) {
    const idx = WEEKEND_ORDER.indexOf(dow);
    const date = candidates.weekendDates[idx];
    const index = buildSegmentIndexForDate(operatorId, date, stopIdToStationId, mapId);
    const rec = index.get(key);
    if (rec && rec.count > 0) {
      return { count: rec.count, demandCount: rec.demandCount, dayType: 'weekend', weekdayBits: 0 };
    }
  }
  return null;
}

/**
 * route-details.jsonの1エントリ（direct/transfer）の便数を、内部区間のボトルネック
 * （直行なら1区間、乗換1回なら2区間の小さい方）として解決する。さらに逆方向
 * （dest→origin、同じoperatorId）のエントリも同様に解決し、行き・帰りの小さい方を
 * 最終値として返す（Minami指示「帰りの向きもここで実装し、行きと帰りの少ない方を使う」）。
 */
function resolveEntryFrequency(routeDetails, originId, destId, operatorId, stopIdToStationId, mapId) {
  function resolveDirection(fromId, toId) {
    const entry = routeDetails?.[fromId]?.[toId]?.[operatorId];
    const parsed = parseRouteEntryLocal(entry);
    if (!parsed) return null;
    if (parsed.type === 'direct') {
      return resolveSegmentFrequencyV2(operatorId, fromId, toId, stopIdToStationId, mapId);
    }
    const leg1 = resolveSegmentFrequencyV2(operatorId, fromId, parsed.via, stopIdToStationId, mapId);
    const leg2 = resolveSegmentFrequencyV2(operatorId, parsed.via, toId, stopIdToStationId, mapId);
    if (!leg1 || !leg2) return null;
    return leg1.count <= leg2.count ? leg1 : leg2;
  }

  const outbound = resolveDirection(originId, destId);
  const inbound = resolveDirection(destId, originId);
  if (!outbound && !inbound) return null;
  if (!outbound) return inbound;
  if (!inbound) return outbound;
  return outbound.count <= inbound.count ? outbound : inbound;
}

function weekdayBitsToLabel(weekdayBits) {
  if (weekdayBits === 0b11111) return '平日';
  const days = [];
  for (let i = 0; i < 5; i++) if (weekdayBits & (1 << i)) days.push(WEEKDAY_BIT_LABELS[i]);
  return days.length > 0 ? `${days.join('・')}のみ` : '（運行曜日不明）';
}

// ---------------------------------------------------------------------------
// route-details.json のRouteEntryを「物理区間のリスト」へ分解する
// （route-duration.jsのparseRouteEntry/estimateRideMinutesと同じ考え方を踏襲。
//   このスクリプトはそのファイルをimportせず独立実装にしている理由：
//   route-duration.jsはブラウザ向けの軽量関数で、ここではoperatorId付きの
//   フルレッグ情報が必要なため）
// ---------------------------------------------------------------------------

function parseRouteEntryLocal(entry) {
  if (!entry) return null;
  if (entry.length === 2) return { type: 'direct', routeId: entry[0], durationMin: entry[1] };
  return {
    type: 'transfer',
    via: entry[0],
    legs: [
      { routeId: entry[1], durationMin: entry[2] },
      { routeId: entry[3], durationMin: entry[4] },
    ],
  };
}

/**
 * fare-calculatorの到達駅情報（reachBy='direct'|'transfer'）を、route-details.jsonを
 * 引くための「エントリ記述子」（1個または2個）に分解する。各記述子は
 * resolveEntryFrequency()にそのまま渡せる（direct/transfer-via・往復とも
 * resolveEntryFrequency側が吸収するため、ここでは物理区間まで分解しない）。
 * @returns {Array<{operatorId, originId, destId}>|null}
 */
function resolveFareCalcEntries(departureStationId, station) {
  if (station.reachBy === 'transfer' && station.transferAt) {
    const [op1, op2] = station.legOperators;
    return [
      { operatorId: op1, originId: departureStationId, destId: station.transferAt },
      { operatorId: op2, originId: station.transferAt, destId: station.station_id },
    ];
  }
  return [{ operatorId: station.viaOperator, originId: departureStationId, destId: station.station_id }];
}

// ---------------------------------------------------------------------------
// プレフェクチャごとの調査本体
// ---------------------------------------------------------------------------

async function loadModules() {
  global.window = {
    EMBEDDED_SPOT_RANKING_CONFIG: JSON.parse(
      fs.readFileSync(path.join(rootDir, 'config/spot-ranking-config.json'), 'utf-8')
    ),
  };
  return {
    FareCalculator: (await import(toUrl('assets/js/fare-calculator.js'))).FareCalculator,
    SpotFinder: (await import(toUrl('assets/js/spot-finder.js'))).SpotFinder,
    mergeIndexedSpotRegions: (await import(toUrl('assets/js/gtfs-loader.js'))).mergeIndexedSpotRegions,
  };
}

const PREF_NAMES = { 16: '富山', 17: '石川', 37: '香川' };
const BASELINE_STATIONS = {
  16: '富山駅前',
  37: '高松築港',
  17: '金沢駅',
};

function bucketLabel(freq) {
  if (freq <= 2) return '1-2便';
  if (freq <= 5) return '3-5便';
  if (freq <= 10) return '6-10便';
  if (freq <= 20) return '11-20便';
  return '21便以上';
}

const THRESHOLDS = [1, 2, 3, 4, 5];

/** route-details.jsonの1エントリから「代表route_id」（表示用の名前解決に使う）を取り出す */
function representativeRouteIdOfEntry(entry) {
  const parsed = parseRouteEntryLocal(entry);
  if (!parsed) return null;
  return parsed.type === 'direct' ? parsed.routeId : parsed.legs[0].routeId;
}

async function investigatePrefecture(codeStr, modules) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`📍 都道府県コード${codeStr}（${PREF_NAMES[codeStr]}）`);
  console.log('='.repeat(70));

  const dataSources = readPrefJson(codeStr, 'data-sources.json');
  const stopsMetadata = readPrefJson(codeStr, 'stops-metadata.json');
  const routeDetails = readPrefJson(codeStr, 'route-details.json');
  const routeInfo = readPrefJson(codeStr, 'route-info.json');
  const stations = readPrefJson(codeStr, 'stations.json');
  const fareData = readPrefJson(codeStr, 'fare-lookup-tables.json');
  const merged = modules.mergeIndexedSpotRegions([readPrefJson(codeStr, 'spots-by-station.json')]);

  const stopIdToStationId = new Map(stopsMetadata.map((s) => [s.stop_id, s.station_id]).filter(([, id]) => id !== undefined));

  console.log(`\n--- フィードの運行開始日（代表日の起点） ---`);
  for (const feed of dataSources.feeds) {
    const cal = getCalendar(feed.operator_id);
    const rep = getRepresentativeDates(feed.operator_id);
    console.log(`  ${feed.operator_id}: feed_start=${feed.feed_start_date} feed_end=${feed.feed_end_date}` +
      (rep ? ` → 代表水曜=${rep.weekday} 代表日曜=${rep.weekend}` : ' → feed_start_date不明のためスキップ'));
  }

  const data = { fareData, stopsMetadata, routeInfo, routeDetails, stations, spots: merged.spots, spotsByStation: merged.spotsByStation };
  const fareCalc = new modules.FareCalculator(data);
  const spotFinder = new modules.SpotFinder(data);

  function findStationId(displayName) {
    const entry = Object.entries(stations).find(([, s]) => s.display_name === displayName);
    return entry ? entry[0] : null;
  }

  // ---- (d) 便数の分布（12基準駅サンプル、往復¥1000）----
  let baselineStations;
  try {
    const baseline = JSON.parse(fs.readFileSync(path.join(rootDir, 'config/regression-baseline.json'), 'utf-8'));
    baselineStations = (baseline.prefectures?.[codeStr]?.departures || []).map((d) => d.display_name);
  } catch {
    baselineStations = [];
  }
  if (baselineStations.length === 0) baselineStations = [BASELINE_STATIONS[codeStr]].filter(Boolean);

  const spotFrequencyByQid = new Map(); // qid -> {minFreq, dayType, weekdayBits, demandCount, sampleStation}

  const budget = 1000;
  const perStationResults = [];
  for (const displayName of baselineStations) {
    const stationId = findStationId(displayName);
    if (!stationId) {
      console.log(`  ⚠️ 基準駅「${displayName}」がstations.jsonに見つかりません`);
      continue;
    }
    const reachable = await fareCalc.calculateReachable(stationId, 2000); // 帯判定はspot側で行う
    const allSpots = await spotFinder.findSpots(reachable);
    const bandSpots = allSpots.filter((s) => s.source_round_trip_fare > budget - 200 && s.source_round_trip_fare <= budget);

    const badgeEligibleCounts = {};
    for (const t of THRESHOLDS) badgeEligibleCounts[t] = 0;
    let resolvedCount = 0;
    let unresolvedCount = 0;
    const perSpotDetail = [];

    for (const spot of bandSpots) {
      const station = reachable.find((s) => s.station_id === spot.source_station_id);
      if (!station) { unresolvedCount += 1; continue; }
      const entries = resolveFareCalcEntries(stationId, station);
      if (!entries || entries.length === 0) { unresolvedCount += 1; continue; }

      let minFreq = Infinity;
      let chosenFreq = null;
      let unresolvedEntry = false;
      for (const e of entries) {
        const freq = resolveEntryFrequency(routeDetails, e.originId, e.destId, e.operatorId, stopIdToStationId, codeStr);
        if (!freq) { unresolvedEntry = true; break; }
        if (freq.count < minFreq) { minFreq = freq.count; chosenFreq = freq; }
      }
      if (unresolvedEntry) { unresolvedCount += 1; continue; }
      resolvedCount += 1;

      const existing = spotFrequencyByQid.get(spot.id);
      if (!existing || minFreq < existing.minFreq) {
        spotFrequencyByQid.set(spot.id, {
          minFreq, dayType: chosenFreq.dayType, weekdayBits: chosenFreq.weekdayBits,
          demandCount: chosenFreq.demandCount, sampleStation: displayName, name: spot.name,
        });
      }

      for (const t of THRESHOLDS) if (minFreq <= t) badgeEligibleCounts[t] += 1;
      perSpotDetail.push({ name: spot.name, minFreq, dayType: chosenFreq.dayType, weekdayBits: chosenFreq.weekdayBits });
    }

    perStationResults.push({ displayName, bandTotal: bandSpots.length, resolvedCount, unresolvedCount, badgeEligibleCounts, perSpotDetail });
  }

  console.log(`\n--- (d) 基準駅（この県の基準駅${baselineStations.length}駅、往復¥1000の帯）---`);
  for (const r of perStationResults) {
    console.log(`  ${r.displayName}: 帯内スポット${r.bandTotal}件（便数解決${r.resolvedCount}件／未解決${r.unresolvedCount}件）`);
    for (const t of THRESHOLDS) {
      console.log(`    ${t}便以下: ${r.badgeEligibleCounts[t]}/${r.resolvedCount}件`);
    }
  }

  // ---- 区間（route-details.jsonの全エントリ）単位の便数ヒストグラム ----
  const segmentHistogramSpots = []; // 帯内スポットのminFreq（全基準駅の和集合、QID重複排除）
  for (const [, freqInfo] of spotFrequencyByQid) segmentHistogramSpots.push(freqInfo.minFreq);

  const entryFreqList = []; // {originId, destId, operatorId, routeName, freq, dayType, weekdayBits, demandCount}
  for (const [originId, destMap] of Object.entries(routeDetails)) {
    for (const [destId, opMap] of Object.entries(destMap)) {
      for (const [operatorId, entry] of Object.entries(opMap)) {
        const freq = resolveEntryFrequency(routeDetails, originId, destId, operatorId, stopIdToStationId, codeStr);
        if (!freq) continue;
        const routeId = representativeRouteIdOfEntry(entry);
        const routeName = routeId ? (loadOperatorTrips(operatorId).routeNameById.get(routeId) || routeId) : operatorId;
        entryFreqList.push({
          originId, destId, operatorId, routeName,
          freq: freq.count, dayType: freq.dayType, weekdayBits: freq.weekdayBits, demandCount: freq.demandCount,
        });
      }
    }
  }

  function printHistogram(label, values) {
    const buckets = { '1-2便': 0, '3-5便': 0, '6-10便': 0, '11-20便': 0, '21便以上': 0 };
    for (const v of values) buckets[bucketLabel(v)] += 1;
    console.log(`  ${label}（総数${values.length}）:`);
    for (const [k, v] of Object.entries(buckets)) {
      const pct = values.length ? ((v / values.length) * 100).toFixed(1) : '0.0';
      console.log(`    ${k}: ${v}件 (${pct}%)`);
    }
  }

  console.log(`\n--- 便数ヒストグラム（区間数、この県のroute-details.jsonの全エントリ${entryFreqList.length}件）---`);
  printHistogram('区間数', entryFreqList.map((r) => r.freq));

  console.log(`\n--- 便数ヒストグラム（スポット件数、基準駅${baselineStations.length}駅の和集合・QID重複排除後${segmentHistogramSpots.length}件）---`);
  printHistogram('スポット件数', segmentHistogramSpots);

  console.log(`\n--- 閾値候補ごとのバッジ付与割合（スポット件数ベース） ---`);
  for (const t of THRESHOLDS) {
    const n = segmentHistogramSpots.filter((v) => v <= t).length;
    const pct = segmentHistogramSpots.length ? ((n / segmentHistogramSpots.length) * 100).toFixed(1) : '0.0';
    console.log(`  ${t}便以下: ${n}/${segmentHistogramSpots.length}件 (${pct}%)`);
  }

  console.log(`\n--- 3便以下の路線一覧（路線名で重複排除、上位20件）---`);
  const lowFreqEntries = entryFreqList.filter((r) => r.freq <= 3).sort((a, b) => a.freq - b.freq);
  const byRouteName = new Map(); // routeName -> 最小便数のレコード
  for (const r of lowFreqEntries) {
    const existing = byRouteName.get(r.routeName);
    if (!existing || r.freq < existing.freq) byRouteName.set(r.routeName, r);
  }
  const distinctLowFreq = [...byRouteName.values()].sort((a, b) => a.freq - b.freq);
  for (const r of distinctLowFreq.slice(0, 20)) {
    console.log(`  ${r.routeName}（${r.operatorId}）: ${r.freq}便/日・${r.dayType === 'weekend' ? '土休日' : weekdayBitsToLabel(r.weekdayBits)}` +
      (r.demandCount > 0 ? ` ※うち${r.demandCount}便は予約制` : ''));
  }
  console.log(`  （3便以下の区間は全${lowFreqEntries.length}件、路線名で重複排除すると${distinctLowFreq.length}路線）`);

  // 【Coworkより追加】富山の3→4便の崖の正体確認用：4便ちょうどの区間を上位5件、
  // どの駅からどの駅への区間かまで出す（時刻表どおりか確認できるように）
  const exactlyFour = entryFreqList.filter((r) => r.freq === 4);
  if (exactlyFour.length > 0) {
    console.log(`\n--- 4便ちょうどの区間（上位5件、計${exactlyFour.length}件）---`);
    for (const r of exactlyFour.slice(0, 5)) {
      const originName = stations[r.originId]?.display_name || r.originId;
      const destName = stations[r.destId]?.display_name || r.destId;
      console.log(`  ${originName} → ${destName}：${r.routeName}（${r.operatorId}）4便/日・${r.dayType === 'weekend' ? '土休日' : weekdayBitsToLabel(r.weekdayBits)}`);
    }
  }

  // デマンド交通の全体集計
  let demandAffectedEntries = 0;
  for (const r of entryFreqList) if (r.demandCount > 0) demandAffectedEntries += 1;
  console.log(`\n--- デマンド交通（pickup_type=2）影響のある区間数: ${demandAffectedEntries}/${entryFreqList.length} ---`);

  return { entryFreqList, segmentHistogramSpots, perStationResults };
}

/**
 * 【Coworkより追加】基準駅サンプルだけでなく、県内の全駅を出発駅とみなして
 * 往復¥2000以内で届く全スポット（帯で絞らない累積）を集め、スポットごとの
 * 最小便数で閾値割合を出す。「県全体のスポット」という、より広い母集団での集計。
 * 同じスポットが複数の出発駅から別々の便数で解決されうるが、ここでは
 * 「どこかの出発駅から見たときの最小便数（最も厳しい評価）」を採用する。
 */
async function investigateCountyWideSpotFrequency(codeStr, modules) {
  const stopsMetadata = readPrefJson(codeStr, 'stops-metadata.json');
  const routeDetails = readPrefJson(codeStr, 'route-details.json');
  const routeInfo = readPrefJson(codeStr, 'route-info.json');
  const stations = readPrefJson(codeStr, 'stations.json');
  const fareData = readPrefJson(codeStr, 'fare-lookup-tables.json');
  const merged = modules.mergeIndexedSpotRegions([readPrefJson(codeStr, 'spots-by-station.json')]);
  const stopIdToStationId = new Map(stopsMetadata.map((s) => [s.stop_id, s.station_id]).filter(([, id]) => id !== undefined));

  const data = { fareData, stopsMetadata, routeInfo, routeDetails, stations, spots: merged.spots, spotsByStation: merged.spotsByStation };
  const fareCalc = new modules.FareCalculator(data);
  const spotFinder = new modules.SpotFinder(data);

  // 【重要】「ある出発駅から見た最小便数」ではなく、spot-finder.js自身の採用基準
  // （往復運賃が最安、同額なら総所要時間が短い方）で「この県でこのスポットが実際に
  // 表示されるときの、その経路の便数」を求める。単純な最小値（2775駅の中から
  // たまたま見つかる最悪の1経路）を採ると、実際にはほとんどの利用者が高頻度の
  // 幹線経由で到達するスポットまで「低頻度」と誤判定してしまうため。
  const canonicalByQid = new Map(); // qid -> {fare, totalTime, freq}
  let unresolvedSpotInstances = 0;
  for (const stationId of Object.keys(stations)) {
    const reachable = await fareCalc.calculateReachable(stationId, 2000);
    const spots = await spotFinder.findSpots(reachable);
    for (const spot of spots) {
      const station = reachable.find((s) => s.station_id === spot.source_station_id);
      if (!station) { unresolvedSpotInstances += 1; continue; }
      const entries = resolveFareCalcEntries(stationId, station);
      if (!entries) { unresolvedSpotInstances += 1; continue; }
      let minFreq = Infinity;
      let ok = true;
      for (const e of entries) {
        const freq = resolveEntryFrequency(routeDetails, e.originId, e.destId, e.operatorId, stopIdToStationId, codeStr);
        if (!freq) { ok = false; break; }
        if (freq.count < minFreq) minFreq = freq.count;
      }
      if (!ok) { unresolvedSpotInstances += 1; continue; }

      const fare = spot.source_round_trip_fare;
      const totalTime = spot.source_total_time_min ?? Infinity;
      const existing = canonicalByQid.get(spot.id);
      const isBetter = !existing || fare < existing.fare || (fare === existing.fare && totalTime < existing.totalTime);
      if (isBetter) canonicalByQid.set(spot.id, { fare, totalTime, freq: minFreq });
    }
  }

  const allFreqs = [...canonicalByQid.values()].map((v) => v.freq);
  console.log(`\n--- 県全体のスポット（往復¥2000以内のどこかの出発駅から届く全スポット、都道府県コード${codeStr}）---`);
  console.log(`  スポット数: ${allFreqs.length}件（便数未解決の出現${unresolvedSpotInstances}件）`);
  for (const t of THRESHOLDS) {
    const n = allFreqs.filter((v) => v <= t).length;
    const pct = allFreqs.length ? ((n / allFreqs.length) * 100).toFixed(1) : '0.0';
    console.log(`  ${t}便以下: ${n}/${allFreqs.length}件 (${pct}%)`);
  }
  return allFreqs;
}

/**
 * 金沢駅は石川単独ビルドのstations.jsonには存在しない（CLAUDE.md
 * 「石川側のフィードは金沢中心部をカバーしておらず、金沢中心部は富山側の
 * 加越能バス経由でだけ出てくる」を参照）。本番フロントエンド（gtfs-loader.js
 * のloadPrefectures()）と同じ方式で富山・石川を併合しないと「金沢駅」を
 * 起点にした調査ができないため、この関数で専用に併合する。
 */
async function investigateMergedKanazawa(modules) {
  console.log(`\n${'='.repeat(70)}`);
  console.log('📍 金沢駅（富山＋石川の併合ビルド、本番のgtfs-loader.js同様の方式）');
  console.log('='.repeat(70));

  const codes = ['16', '17'];
  const fareData = { od_fares: {}, bus_fares: {} };
  const stopsMetadata = [];
  const routeInfo = {};
  const routeDetails = {};
  const stations = {};
  const spotRegions = [];
  for (const codeStr of codes) {
    const f = readPrefJson(codeStr, 'fare-lookup-tables.json');
    Object.assign(fareData.od_fares, f.od_fares);
    Object.assign(fareData.bus_fares, f.bus_fares);
    stopsMetadata.push(...readPrefJson(codeStr, 'stops-metadata.json'));
    Object.assign(routeInfo, readPrefJson(codeStr, 'route-info.json'));
    Object.assign(routeDetails, readPrefJson(codeStr, 'route-details.json'));
    Object.assign(stations, readPrefJson(codeStr, 'stations.json'));
    spotRegions.push(readPrefJson(codeStr, 'spots-by-station.json'));
  }
  const merged = modules.mergeIndexedSpotRegions(spotRegions);
  const stopIdToStationId = new Map(stopsMetadata.map((s) => [s.stop_id, s.station_id]).filter(([, id]) => id !== undefined));

  const data = { fareData, stopsMetadata, routeInfo, routeDetails, stations, spots: merged.spots, spotsByStation: merged.spotsByStation };
  const fareCalc = new modules.FareCalculator(data);
  const spotFinder = new modules.SpotFinder(data);

  // 【2026-10-09判明】富山・石川どちらのビルドにも「金沢駅」という表示名の駅は無い。
  // 金沢中心部で実在するのは富山側フィード（加越能バス）の「金沢駅西口」のみ
  // （CLAUDE.md「段階1の前提条件」に記載済みの既知の事実と整合）。
  const entry = Object.entries(stations).find(([, s]) => s.display_name === '金沢駅西口')
    || Object.entries(stations).find(([, s]) => s.display_name === '金沢駅');
  if (!entry) {
    console.log('  ❌ 併合後も「金沢駅西口」「金沢駅」が見つかりません（駅名が変わった可能性。stations.jsonを確認してください）');
    return;
  }
  console.log(`  ※「金沢駅」という表示名の駅は存在しないため、金沢中心部の代表として「${entry[1].display_name}」を使用`);
  const [stationId] = entry;
  console.log(`  station_id = ${stationId}`);

  const budget = 1000;
  const reachable = await fareCalc.calculateReachable(stationId, 2000);
  const allSpots = await spotFinder.findSpots(reachable);
  const bandSpots = allSpots.filter((s) => s.source_round_trip_fare > budget - 200 && s.source_round_trip_fare <= budget);
  console.log(`  往復¥2000累積到達駅: ${reachable.length}駅、往復¥1000帯のスポット: ${bandSpots.length}件`);

  let resolvedCount = 0;
  let unresolvedCount = 0;
  const badgeEligibleCounts = {};
  for (const t of THRESHOLDS) badgeEligibleCounts[t] = 0;
  for (const spot of bandSpots) {
    const station = reachable.find((s) => s.station_id === spot.source_station_id);
    if (!station) { unresolvedCount += 1; continue; }
    const entries = resolveFareCalcEntries(stationId, station);
    if (!entries || entries.length === 0) { unresolvedCount += 1; continue; }
    let minFreq = Infinity;
    let unresolvedEntry = false;
    for (const e of entries) {
      const freq = resolveEntryFrequency(routeDetails, e.originId, e.destId, e.operatorId, stopIdToStationId, 'kanazawa-merged');
      if (!freq) { unresolvedEntry = true; break; }
      if (freq.count < minFreq) minFreq = freq.count;
    }
    if (unresolvedEntry) { unresolvedCount += 1; continue; }
    resolvedCount += 1;
    for (const t of THRESHOLDS) if (minFreq <= t) badgeEligibleCounts[t] += 1;
  }
  console.log(`  便数解決${resolvedCount}件／未解決${unresolvedCount}件`);
  for (const t of THRESHOLDS) {
    console.log(`    ${t}便以下: ${badgeEligibleCounts[t]}/${resolvedCount}件`);
  }
}

/**
 * (b) 便数データを route-details.json の各エントリ（区間単位）に追加した場合の
 * gzipサイズ増加を実測する。Minami指示により区間単位（route_idをまたぐ）に変更した
 * ため、route-info.json（路線単位、503件/富山）ではなくroute-details.json
 * （106,784エントリ/富山）側への追加になり、件数の桁が2桁以上増える。
 * 素朴な「エントリごとに3整数を追加」案と、重複が多いことを見込んだ辞書圧縮案
 * （route_idの既存のインデックス化と同じ考え方）の両方を実測して比較する。
 * 本番ファイルは一切書き換えない（メモリ上でコピーに追加してgzip比較するだけ）。
 */
function measureFileSizeImpact(codeStr, routeDetails, stopIdToStationId) {
  const before = JSON.stringify(routeDetails);
  const beforeGzip = zlib.gzipSync(before).length;

  // 素朴案：各エントリ配列の末尾に [freqCount, dayCode, demandCount] を追加
  // dayCode: 0-31は平日の曜日ビットフラグ、32は週末代表（土休日）
  const naiveDetails = {};
  // 辞書圧縮案：(freqCount,dayCode,demandCount)のユニークな組み合わせを別配列に持ち、
  // 各エントリはそのインデックス1個だけを追加する
  const freqDict = new Map(); // "count,dayCode,demand" -> index
  const freqDictList = [];
  const compressedDetails = {};

  let resolvedCount = 0;
  let unresolvedCount = 0;
  for (const [originId, destMap] of Object.entries(routeDetails)) {
    naiveDetails[originId] = {};
    compressedDetails[originId] = {};
    for (const [destId, opMap] of Object.entries(destMap)) {
      naiveDetails[originId][destId] = {};
      compressedDetails[originId][destId] = {};
      for (const [operatorId, entry] of Object.entries(opMap)) {
        const freq = resolveEntryFrequency(routeDetails, originId, destId, operatorId, stopIdToStationId, codeStr);
        if (!freq) {
          unresolvedCount += 1;
          naiveDetails[originId][destId][operatorId] = entry;
          compressedDetails[originId][destId][operatorId] = entry;
          continue;
        }
        resolvedCount += 1;
        const dayCode = freq.dayType === 'weekend' ? 32 : freq.weekdayBits;
        naiveDetails[originId][destId][operatorId] = [...entry, freq.count, dayCode, freq.demandCount];

        const dictKey = `${freq.count},${dayCode},${freq.demandCount}`;
        let idx = freqDict.get(dictKey);
        if (idx === undefined) {
          idx = freqDictList.length;
          freqDictList.push([freq.count, dayCode, freq.demandCount]);
          freqDict.set(dictKey, idx);
        }
        compressedDetails[originId][destId][operatorId] = [...entry, idx];
      }
    }
  }

  const naiveStr = JSON.stringify(naiveDetails);
  const naiveGzip = zlib.gzipSync(naiveStr).length;
  const compressedStr = JSON.stringify({ freqDict: freqDictList, data: compressedDetails });
  const compressedGzip = zlib.gzipSync(compressedStr).length;

  console.log(`\n--- (b) route-details.jsonへの便数追加によるサイズ影響（都道府県コード${codeStr}）---`);
  console.log(`  エントリ数: ${resolvedCount + unresolvedCount}（便数解決${resolvedCount}件／未解決${unresolvedCount}件）`);
  console.log(`  追加前: ${before.length}バイト（素） / ${beforeGzip}バイト（gzip）`);
  console.log(`  【素朴案】エントリごとに3整数追加: ${naiveStr.length}バイト（素） / ${naiveGzip}バイト（gzip）` +
    ` gzip増加+${naiveGzip - beforeGzip}バイト (+${(((naiveGzip - beforeGzip) / beforeGzip) * 100).toFixed(2)}%)`);
  console.log(`  【辞書圧縮案】ユニーク組み合わせ${freqDictList.length}種＋各エントリにインデックス1個: ` +
    `${compressedStr.length}バイト（素） / ${compressedGzip}バイト（gzip）` +
    ` gzip増加+${compressedGzip - beforeGzip}バイト (+${(((compressedGzip - beforeGzip) / beforeGzip) * 100).toFixed(2)}%)`);

  // 県全体（このプレフェクチャの全派生ファイル合計）に対する比率も参考値として出す（辞書圧縮案で計算）
  const allFiles = ['fare-lookup-tables.json', 'stops-metadata.json', 'route-info.json', 'route-details.json', 'stations.json', 'spots-by-station.json', 'data-sources.json'];
  let totalGzipBefore = 0;
  for (const name of allFiles) {
    const content = fs.readFileSync(path.join(rootDir, 'data/derived/pref', codeStr, name));
    totalGzipBefore += zlib.gzipSync(content).length;
  }
  const totalGzipAfterNaive = totalGzipBefore - beforeGzip + naiveGzip;
  const totalGzipAfterCompressed = totalGzipBefore - beforeGzip + compressedGzip;
  console.log(`  県全体派生ファイル合計gzip: ${totalGzipBefore}バイト`);
  console.log(`    → 素朴案適用後: ${totalGzipAfterNaive}バイト (+${(((totalGzipAfterNaive - totalGzipBefore) / totalGzipBefore) * 100).toFixed(2)}%)`);
  console.log(`    → 辞書圧縮案適用後: ${totalGzipAfterCompressed}バイト (+${(((totalGzipAfterCompressed - totalGzipBefore) / totalGzipBefore) * 100).toFixed(2)}%)`);
}

async function main() {
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.split('=')[1].split(',') : null;

  console.log('🔬 便数調査スクリプト（investigate-service-frequency.js）※読み取り専用、docs/・data/derivedは変更しません');

  // 自己チェック：祝日計算の妥当性（既知の2026年祝日と突き合わせ）
  const selfCheck = {
    '20260101': true, '20260112': true, '20260211': true, '20260320': true,
    '20260429': true, '20260503': true, '20260720': true, '20260921': true,
    '20260922': true, '20260923': true, '20261012': true, '20261103': true,
    '20260115': false, '20260401': false,
  };
  let selfCheckOk = true;
  for (const [date, expected] of Object.entries(selfCheck)) {
    const actual = isHoliday(date);
    if (actual !== expected) { selfCheckOk = false; console.log(`  ❌ 祝日自己チェック不一致: ${date} 期待=${expected} 実際=${actual}`); }
  }
  console.log(selfCheckOk ? '✅ 祝日計算の自己チェックОK' : '❌ 祝日計算に誤りがあります');

  const published = JSON.parse(fs.readFileSync(path.join(rootDir, 'config/published-prefectures.json'), 'utf-8')).published;
  const codes = (only || published);

  const modules = await loadModules();
  const results = {};
  for (const code of codes) {
    const codeStr = String(code).padStart(2, '0');
    results[codeStr] = await investigatePrefecture(codeStr, modules);
    const routeDetails = readPrefJson(codeStr, 'route-details.json');
    const stopsMetadata = readPrefJson(codeStr, 'stops-metadata.json');
    const stopIdToStationId = new Map(stopsMetadata.map((s) => [s.stop_id, s.station_id]).filter(([, id]) => id !== undefined));
    measureFileSizeImpact(codeStr, routeDetails, stopIdToStationId);
    await investigateCountyWideSpotFrequency(codeStr, modules);
  }

  if (!only || (codes.includes('16') && codes.includes('17'))) {
    await investigateMergedKanazawa(modules);
  }

  console.log('\n\n🏁 調査完了');
}

main().catch((err) => {
  console.error('❌ 調査スクリプト実行エラー:', err);
  process.exit(1);
});
