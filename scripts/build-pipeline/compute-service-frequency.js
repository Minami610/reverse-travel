/**
 * compute-service-frequency.js - route-details.json の各経路に「便数」を付与する
 * （2026-10-10、2本目「便の少ない路線を応援」マーク機能の本実装）
 *
 * 【数え方の方針（Minami確定、調査①②より）】
 * - 便数は「路線（route_id）単位」ではなく「乗る区間単位」で数える。同じ区間を
 *   複数のroute_id（曜日違い・支線バリエーション等）が重複してカバーすることが
 *   あり、route_id単位だと実際に乗れる本数を過小評価するため、同一事業者内で
 *   route_idをまたいで「この区間を実際に両方停まって正しい順に通る便」を数える
 *   （generate-route-details.jsのstationDirect構築と同じ発想の総当たりを、
 *   カレンダーでアクティブなtripだけに絞って行う）。
 * - 代表日は「祝日でない水曜日」を基本とし、その区間が実際に走っていなければ
 *   近い曜日（火→木→月→金）へ探索を広げ、平日が1日も無ければ週末（日→土）を試す。
 *   運行する曜日はビットフラグ（月=bit0…金=bit4）として保持し、「火・金のみ」等の
 *   表示をフロント側で組み立てられるようにする。平日が1つも無い区間は週末日の
 *   便数を採用し、dayCode=32（weekendの目印）とする。
 * - 予約制（pickup_type=2が全停留所に付くtrip）も便数に含めて数えつつ、そのうち
 *   予約制が何便かを別途保持する。
 * - 行き（origin→dest）と帰り（dest→origin、同一事業者）の両方を解決し、
 *   小さい方をそのエントリの最終値として採用する（帰れない旅を勧めないため）。
 *
 * 【保存形式（Minami確定：素朴案）】route-details.jsonの各RouteEntry配列の末尾に
 * 3整数 [tripCount, dayCode, demandCount] を追加する。
 *   dayCode: 0〜31 = 平日の運行曜日ビットフラグ（bit0=月…bit4=金）、32 = 週末代表（土休日）
 * 富山の実測でgzip増加は県全体+3.14%（目安+5%以内）。
 *
 * 【解決できないエントリ（代表日なし等）】tripCount=-1（dayCode=-1、demandCount=-1も
 * 同様）の3整数を付ける。常に直行=長さ5・乗換1回=長さ8になるようにするため
 * （「常に3整数を追加」をやめて未解決時だけ元の長さ2/5に戻す設計も検討したが、
 * それだと乗換1回の「便数情報なし」（長さ5）と直行の「便数情報あり」（長さ5）が
 * 長さだけでは区別できなくなる。長さを固定し、tripCount<0で「未解決」と判定する
 * 設計にして、このあいまいさを避けた）。
 */
import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { namespacedId } from './gtfs-id.js';
import { findFirstNonHolidayWeekdayOnOrAfter } from './jp-holidays.js';

function parseGtfsFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return parse(fs.readFileSync(filePath, 'utf-8'), { bom: true, columns: true });
}

const DOW_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function loadOperatorCalendar(operatorId, rawGtfsDir) {
  const dir = path.join(rawGtfsDir, operatorId);
  const calendar = parseGtfsFile(path.join(dir, 'calendar.txt'));
  const calendarDates = parseGtfsFile(path.join(dir, 'calendar_dates.txt'));
  const feedInfoRows = parseGtfsFile(path.join(dir, 'feed_info.txt'));
  const feedInfo = feedInfoRows[0] || {};

  const weekly = new Map();
  for (const row of calendar) {
    weekly.set(row.service_id, {
      days: DOW_KEYS.map((k) => row[k] === '1'),
      start: row.start_date,
      end: row.end_date,
    });
  }
  const exceptions = new Map();
  for (const row of calendarDates) {
    if (!exceptions.has(row.service_id)) exceptions.set(row.service_id, new Map());
    exceptions.get(row.service_id).set(row.date, row.exception_type);
  }
  return { weekly, exceptions, feedStartDate: feedInfo.feed_start_date };
}

function isServiceActiveOnDate(calendar, serviceId, dateStr) {
  const exception = calendar.exceptions.get(serviceId)?.get(dateStr);
  if (exception === '1') return true;
  if (exception === '2') return false;

  const weekly = calendar.weekly.get(serviceId);
  if (!weekly) return false;
  if (dateStr < weekly.start || dateStr > weekly.end) return false;
  const dow = new Date(`${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}T00:00:00Z`).getUTCDay();
  return weekly.days[dow];
}

const WEEKDAY_ORDER = [1, 2, 3, 4, 5]; // 月,火,水,木,金（getUTCDay()の値）
const WEEKEND_ORDER = [0, 6]; // 日,土
const WEEKDAY_PRIORITY = [3, 2, 4, 1, 5]; // 代表1日を選ぶ優先順：水曜最優先

function getOperatorCandidateDates(operatorId, rawGtfsDir, calendar) {
  const anchor = calendar.feedStartDate;
  if (!anchor) return null;
  return {
    weekdayDates: WEEKDAY_ORDER.map((dow) => findFirstNonHolidayWeekdayOnOrAfter(anchor, dow)),
    weekendDates: WEEKEND_ORDER.map((dow) => findFirstNonHolidayWeekdayOnOrAfter(anchor, dow)),
  };
}

function loadOperatorTrips(operatorId, rawGtfsDir) {
  const dir = path.join(rawGtfsDir, operatorId);
  const trips = parseGtfsFile(path.join(dir, 'trips.txt'));
  const stopTimes = parseGtfsFile(path.join(dir, 'stop_times.txt'));

  const tripMeta = new Map();
  for (const t of trips) {
    tripMeta.set(t.trip_id, { serviceId: t.service_id });
  }
  const tripStops = new Map();
  for (const st of stopTimes) {
    if (!tripStops.has(st.trip_id)) tripStops.set(st.trip_id, []);
    tripStops.get(st.trip_id).push({
      stopId: namespacedId(operatorId, st.stop_id),
      seq: parseInt(st.stop_sequence, 10),
      pickupType: st.pickup_type,
    });
  }
  for (const stops of tripStops.values()) stops.sort((a, b) => a.seq - b.seq);
  return { tripMeta, tripStops };
}

/**
 * 指定operatorの指定日に走る、全station_idペア×区間の便数インデックスを構築する
 * （route_idをまたいで集計。generate-route-details.jsのstationDirect構築と同じ
 * 総当たりを、日付でアクティブなtripだけに絞って行う）。
 * @returns {Map<string, {count:number, demandCount:number}>} キーは`${originStationId}\t${destStationId}`
 */
function buildSegmentIndexForDate(operatorId, dateStr, stopIdToStationId, calendar, tripsData) {
  const { tripMeta, tripStops } = tripsData;
  const index = new Map();

  for (const [tripId, meta] of tripMeta.entries()) {
    if (!isServiceActiveOnDate(calendar, meta.serviceId, dateStr)) continue;
    const stops = tripStops.get(tripId) || [];
    const isDemandTrip = stops.length > 0 && stops.every((s) => s.pickupType === '2');

    const stationSeq = [];
    for (const s of stops) {
      const stationId = stopIdToStationId.get(s.stopId);
      if (stationId !== undefined) stationSeq.push(stationId);
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
  return index;
}

/**
 * 便数計算の本体。operatorごとに一度だけGTFS・カレンダーを読み込み、
 * 必要な代表日ぶんだけ区間インデックスを遅延構築してキャッシュする。
 */
class FrequencyResolver {
  constructor(rawGtfsDir, stopIdToStationId) {
    this.rawGtfsDir = rawGtfsDir;
    this.stopIdToStationId = stopIdToStationId;
    this.calendarCache = new Map();
    this.tripsCache = new Map();
    this.candidateDateCache = new Map();
    this.segmentIndexCache = new Map(); // `${operatorId}\t${date}` -> Map
  }

  getCalendar(operatorId) {
    if (!this.calendarCache.has(operatorId)) {
      this.calendarCache.set(operatorId, loadOperatorCalendar(operatorId, this.rawGtfsDir));
    }
    return this.calendarCache.get(operatorId);
  }

  getTrips(operatorId) {
    if (!this.tripsCache.has(operatorId)) {
      this.tripsCache.set(operatorId, loadOperatorTrips(operatorId, this.rawGtfsDir));
    }
    return this.tripsCache.get(operatorId);
  }

  getCandidateDates(operatorId) {
    if (!this.candidateDateCache.has(operatorId)) {
      this.candidateDateCache.set(operatorId, getOperatorCandidateDates(operatorId, this.rawGtfsDir, this.getCalendar(operatorId)));
    }
    return this.candidateDateCache.get(operatorId);
  }

  getSegmentIndex(operatorId, dateStr) {
    const key = `${operatorId}\t${dateStr}`;
    if (!this.segmentIndexCache.has(key)) {
      const calendar = this.getCalendar(operatorId);
      const tripsData = this.getTrips(operatorId);
      this.segmentIndexCache.set(key, buildSegmentIndexForDate(operatorId, dateStr, this.stopIdToStationId, calendar, tripsData));
    }
    return this.segmentIndexCache.get(key);
  }

  /**
   * 区間（同一事業者内、origin→dest、station_id単位）の便数を、曜日ビットフラグ付きで解決する。
   * @returns {{count:number, demandCount:number, dayType:'weekday'|'weekend', weekdayBits:number}|null}
   */
  resolveSegment(operatorId, originStationId, destStationId) {
    const candidates = this.getCandidateDates(operatorId);
    if (!candidates) return null;
    const key = `${originStationId}\t${destStationId}`;

    let weekdayBits = 0;
    const weekdayResults = [];
    WEEKDAY_ORDER.forEach((dow, idx) => {
      const date = candidates.weekdayDates[idx];
      const index = this.getSegmentIndex(operatorId, date);
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
      const index = this.getSegmentIndex(operatorId, date);
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
   * （dest→origin、同じoperatorId）のエントリも解決し、行き・帰りの小さい方を返す。
   * @param {object} routeDetails - 全エントリ（他のOD対の逆方向entryを引くために必要）
   */
  resolveEntry(routeDetails, originId, destId, operatorId) {
    const resolveDirection = (fromId, toId) => {
      const entry = routeDetails?.[fromId]?.[toId]?.[operatorId];
      if (!entry) return null;
      if (entry.length === 2) {
        return this.resolveSegment(operatorId, fromId, toId);
      }
      if (entry.length === 5) {
        const via = entry[0];
        const leg1 = this.resolveSegment(operatorId, fromId, via);
        const leg2 = this.resolveSegment(operatorId, via, toId);
        if (!leg1 || !leg2) return null;
        return leg1.count <= leg2.count ? leg1 : leg2;
      }
      return null; // 想定外の長さ（既に便数付与済み等）
    };

    const outbound = resolveDirection(originId, destId);
    const inbound = resolveDirection(destId, originId);
    if (!outbound && !inbound) return null;
    if (!outbound) return inbound;
    if (!inbound) return outbound;
    return outbound.count <= inbound.count ? outbound : inbound;
  }
}

/**
 * route-details.jsonを便数付きに拡張する（破壊的に書き換えず、新しいオブジェクトを返す）。
 * 対象事業者はrouteDetailsのエントリから自然に決まるため、事業者一覧を別途渡す必要はない。
 * @param {object} routeDetails - {originId: {destId: {operatorId: RouteEntry}}}
 * @param {string} rawGtfsDir
 * @param {Map<string,string>} stopIdToStationId
 * @returns {{routeDetails: object, resolvedCount:number, unresolvedCount:number}}
 */
export function augmentRouteDetailsWithFrequency(routeDetails, rawGtfsDir, stopIdToStationId) {
  const resolver = new FrequencyResolver(rawGtfsDir, stopIdToStationId);
  const augmented = {};
  let resolvedCount = 0;
  let unresolvedCount = 0;

  for (const [originId, destMap] of Object.entries(routeDetails)) {
    augmented[originId] = {};
    for (const [destId, opMap] of Object.entries(destMap)) {
      augmented[originId][destId] = {};
      for (const [operatorId, entry] of Object.entries(opMap)) {
        const freq = resolver.resolveEntry(routeDetails, originId, destId, operatorId);
        if (!freq) {
          unresolvedCount += 1;
          augmented[originId][destId][operatorId] = [...entry, -1, -1, -1];
          continue;
        }
        resolvedCount += 1;
        const dayCode = freq.dayType === 'weekend' ? 32 : freq.weekdayBits;
        augmented[originId][destId][operatorId] = [...entry, freq.count, dayCode, freq.demandCount];
      }
    }
  }

  return { routeDetails: augmented, resolvedCount, unresolvedCount };
}
