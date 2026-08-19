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

const RAIL_OPERATOR_ID = 'kotoden';
const BUS_OPERATOR_ID = 'kotoden-bus';

export class FareCalculator {
  constructor(data) {
    this.fareData = data.fareData;
    this.stopsMetadata = data.stopsMetadata;
    this.routeInfo = data.routeInfo;
    this.stationsByName = data.stationsByName;
    this.stopIdToName = new Map(
      this.stopsMetadata.map((s) => [s.stop_id, s.stop_name])
    );
  }

  /**
   * 出発駅（駅名）から予算内で到達可能な駅を計算
   * @param {string} departureStationName - 出発駅名
   * @param {number} budget - 予算（円）
   * @returns {Array} [{stop_id, stop_name, stop_ids, fare, reachBy}, ...]
   *                  stop_id/stop_name は駅名（呼び出し側の互換性のため）
   *                  stop_ids はその駅名に属する実際のstop_id一覧（スポット検索用）
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
              });
              transferCount += 1;
            }
          }
        }
      }

      console.log(`✅ 乗り継ぎ到達駅: ${transferCount}駅`);

      // 結果をリスト化（各駅名に属する全stop_idを付与＝スポット検索用）
      const result = Array.from(reachable.entries()).map(([stationName, info]) => {
        const station = this.stationsByName[stationName];
        return {
          stop_id: stationName,
          stop_name: stationName,
          stop_ids: station ? station.stops.map((s) => s.stop_id) : [],
          fare: info.fare,
          reachBy: info.reachBy,
          transferAt: info.transferAt || null,
        };
      });

      return result;
    } catch (error) {
      console.error('❌ 運賃計算失敗:', error);
      throw error;
    }
  }
}
