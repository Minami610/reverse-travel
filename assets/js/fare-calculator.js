/**
 * fare-calculator.js - 運賃計算エンジン（フェーズ1）
 *
 * 運賃データ（od_fares）は stop_id 単位のOD運賃表（駅・バス停の全事業者を横断してフラットに統合済み）。
 * 同一駅名でもプラットフォーム単位でstop_idが分かれているため、駅名単位に集約して扱う。
 *
 * フェーズ1スコープ：
 * 1. OD運賃表から「出発駅から¥X以内の到達駅」を駅名単位で直接検索（鉄道・バスとも同じOD表として扱う）
 * 2. 鉄道で直接到達した駅から、その駅に併設するバス停（同一駅名の別事業者stop_id）経由で
 *    さらにバスのOD運賃を1回分加算し、ラストワンマイルを探索
 * 3. 乗り継ぎは最大1回に限定
 *
 * フェーズ2以降：汎用グラフ探索（ダイクストラ法）へ移行予定
 */

import { estimateSelectionMinutes, estimateRideMinutes } from './route-duration.js';

const RAIL_OPERATOR_ID = 'kotoden';
const BUS_OPERATOR_ID = 'kotoden-bus';

export class FareCalculator {
  constructor(data) {
    this.fareData = data.fareData;
    this.stopsMetadata = data.stopsMetadata;
    this.routeInfo = data.routeInfo;
    this.routeDetails = data.routeDetails;
    this.stationsByName = data.stationsByName;
    this.stopIdToName = new Map(
      this.stopsMetadata.map((s) => [s.stop_id, s.stop_name])
    );
  }

  /**
   * 出発駅（駅名）から予算内で到達可能な駅を計算
   * @param {string} departureStationName - 出発駅名
   * @param {number} budget - 予算（円）。**往復**の交通費（2026-09-12決定）。
   *                  GTFSの運賃データには往復運賃・往復割引の概念がなく、片道の
   *                  運賃商品しか存在しないため、帰りも往路と同額と仮定して判定する。
   * @returns {Array} [{stop_id, stop_name, stop_ids, fare, roundTripFare, reachBy}, ...]
   *                  stop_id/stop_name は駅名（呼び出し側の互換性のため）
   *                  stop_ids はその駅名に属する実際のstop_id一覧（スポット検索用）
   *                  fare は片道総額、roundTripFare は fare*2（予算と比較すべき実際の負担額）
   *                  reachBy: 'direct'(直接), 'transfer'(鉄道→バス1回乗換)
   */
  async calculateReachable(departureStationName, budget) {
    try {
      const departureStation = this.stationsByName?.[departureStationName];
      if (!departureStation) {
        console.warn(`⚠️ 出発駅が見つかりません: ${departureStationName}`);
        return [];
      }

      // ステップ1：出発駅の全stop_id（全事業者）を起点にOD運賃表を直接検索し、駅名単位に集約
      const reachable = new Map(); // stationName -> {fare, reachBy, viaOperator}

      for (const { stop_id: originStopId, operator_id: originOperator } of departureStation.stops) {
        const destinations = this.fareData.od_fares?.[originStopId];
        if (!destinations) continue;

        for (const [destStopId, fare] of Object.entries(destinations)) {
          if (fare > budget) continue;
          const destName = this.stopIdToName.get(destStopId);
          if (!destName || destName === departureStationName) continue;

          const existing = reachable.get(destName);
          if (!existing || existing.fare > fare) {
            reachable.set(destName, { fare, reachBy: 'direct', viaOperator: originOperator });
          }
        }
      }

      const directCount = reachable.size;
      console.log(`✅ 直接到達駅: ${directCount}駅`);

      // ステップ2：鉄道で直接到達した駅から、併設バス停経由でラストワンマイル
      let transferCount = 0;
      const directRailStations = Array.from(reachable.entries()).filter(
        ([, info]) => info.reachBy === 'direct' && info.viaOperator === RAIL_OPERATOR_ID
      );

      for (const [railStationName, railInfo] of directRailStations) {
        const remainingBudget = budget - railInfo.fare;
        if (remainingBudget <= 0) continue;

        const railStation = this.stationsByName[railStationName];
        if (!railStation) continue;

        const busStopIds = railStation.stops
          .filter((s) => s.operator_id === BUS_OPERATOR_ID)
          .map((s) => s.stop_id);
        if (busStopIds.length === 0) continue; // この駅にはバス乗換拠点がない

        for (const busStopId of busStopIds) {
          const busDestinations = this.fareData.od_fares?.[busStopId];
          if (!busDestinations) continue;

          for (const [destStopId, busFare] of Object.entries(busDestinations)) {
            if (busFare > remainingBudget) continue;
            const destName = this.stopIdToName.get(destStopId);
            if (!destName || destName === departureStationName || destName === railStationName) continue;

            const totalFare = railInfo.fare + busFare;
            const existing = reachable.get(destName);
            if (!existing || existing.fare > totalFare) {
              reachable.set(destName, {
                fare: totalFare,
                reachBy: 'transfer',
                viaOperator: BUS_OPERATOR_ID,
                transferAt: railStationName,
                legFares: [railInfo.fare, busFare],
              });
              transferCount += 1;
            }
          }
        }
      }

      console.log(`✅ 乗り継ぎ到達駅: ${transferCount}駅`);

      // 最終判定：このアプリの予算は往復の交通費（2026-09-12決定、CLAUDE.md参照）。
      // GTFSの運賃データに往復運賃・往復割引という概念自体が存在しないため、
      // 帰りも往路と同額と仮定し、往路総額（info.fare、上記のkeep-min処理により
      // 既にその駅への最安値）を2倍した額で判定する。
      // 区間ごとに半額の予算を割り振って積み上げる方式（探索の途中でbudget/2を
      // 使う）は、乗り継ぎが増えたときの端数処理や残額配分で事故りやすいため
      // 採用しない。探索フェーズの枝刈り（上記のbudget比較）は「往路総額は
      // budgetを超えない」という往復判定より常に緩い条件のままにしておき、
      // 有効な候補を誤って捨てないようにした上で、ここで一度だけ厳密に判定する。
      for (const [stationName, info] of reachable) {
        if (info.fare * 2 > budget) {
          reachable.delete(stationName);
        }
      }
      console.log(`✅ 往復予算内（片道総額×2 ≦ ¥${budget}）: ${reachable.size}駅`);

      // 結果をリスト化（各駅名に属する全stop_idを付与＝スポット検索用）
      // selectionTimeMin は「乗車時間＋期待待ち時間」（分）。アクセス駅選定（SpotFinder）で
      // 「選定時間＋徒歩時間」の総所要時間を比較するために使う。
      // rideDurationMin は乗車時間のみ（待ち時間を含まない）。カード・詳細画面の
      // 所要時間表示に使う。どちらも経路が確定できない場合はnull。
      // fare は片道総額（詳細画面の区間内訳・合計と整合させるためそのまま維持）、
      // roundTripFare は予算と比較すべき実際の負担額（往復・帰りは同額と仮定）。
      const result = Array.from(reachable.entries()).map(([stationName, info]) => {
        const station = this.stationsByName[stationName];
        const stationEntry = {
          stop_id: stationName,
          stop_name: stationName,
          stop_ids: station ? station.stops.map((s) => s.stop_id) : [],
          fare: info.fare,
          roundTripFare: info.fare * 2,
          reachBy: info.reachBy,
          transferAt: info.transferAt || null,
          legFares: info.legFares || null,
        };
        stationEntry.selectionTimeMin = estimateSelectionMinutes(this.routeDetails, departureStationName, stationEntry);
        stationEntry.rideDurationMin = estimateRideMinutes(this.routeDetails, departureStationName, stationEntry);
        return stationEntry;
      });

      return result;
    } catch (error) {
      console.error('❌ 運賃計算失敗:', error);
      throw error;
    }
  }
}
