/**
 * fare-calculator.js - 運賃計算エンジン（フェーズ1）
 *
 * 運賃データ（od_fares）は stop_id 単位のOD運賃表（駅・バス停の全事業者を横断してフラットに統合済み）。
 * 同一プラットフォームのstop_idは駅ID（station_id）単位に集約して扱う。
 *
 * フェーズ1スコープ：
 * 1. OD運賃表から「出発駅から¥X以内の到達駅」を駅ID単位で直接検索（鉄道・バスとも同じOD表として扱う）
 * 2. 直接到達した駅（鉄道・バスいずれでも可）から、その駅に併設するバス系の停留所経由で
 *    さらにバスのOD運賃を1回分加算し、ラストワンマイルを探索
 *    【2026-10-02】起点を鉄道系に限定していたが、富山・石川（ほぼバスのみ）で
 *    実測したところ、起点をバスにも広げることで到達駅数が最大+57%増える例があり、
 *    起点の制限を鉄道・バス問わずに広げた（併設停留所側は引き続きバス限定＝
 *    「ラストワンマイル」の趣旨のまま）。
 * 3. 乗り継ぎは最大1回に限定
 *
 * 【鉄道／バスの判定はstop_idのmode（route_typeベース、parse-and-transform.js産）を使う。
 * 以前はRAIL_OPERATOR_ID='kotoden'/BUS_OPERATOR_ID='kotoden-bus'という事業者IDの固定値
 * だったが、これは事業者ごとに単一モードの香川でしか成立せず、鉄道とバスの両方を
 * 運行する事業者（例：富山地方鉄道）で破綻するため、停留所ごとの実データ判定に変えた。】
 *
 * フェーズ2以降：汎用グラフ探索（ダイクストラ法）へ移行予定
 */

import { estimateSelectionMinutes, estimateRideMinutes } from './route-duration.js';

function isBusEligible(mode) {
  return mode === 'bus' || mode === 'mixed';
}

/**
 * keep-min（「より安いときだけ上書き」）は運賃が同額のとき、処理順で先に
 * 見つかった候補が残ってしまう（事業者の列挙順・停留所の列挙順まかせ）。
 * 同額なら「乗車時間＋待ち時間が短い方」を明示的に優先する決定的な規則にする。
 * 所要時間が片方だけ確定している場合は確定している方を優先する（未確定のまま
 * 残すと、詳細画面で「経路情報を確定できませんでした」になる候補を選んで
 * しまいうるため）。両方未確定なら既存を維持する。
 */
function isBetterCandidate(candidateFare, candidateMinutes, existing) {
  if (!existing) return true;
  if (candidateFare !== existing.fare) return candidateFare < existing.fare;
  if (existing.selectionMinutes === null) return candidateMinutes !== null;
  if (candidateMinutes === null) return false;
  return candidateMinutes < existing.selectionMinutes;
}

export class FareCalculator {
  constructor(data) {
    this.fareData = data.fareData;
    this.stopsMetadata = data.stopsMetadata;
    this.routeInfo = data.routeInfo;
    this.routeDetails = data.routeDetails;
    this.stations = data.stations;
    this.stopIdToStationId = new Map(
      this.stopsMetadata.map((s) => [s.stop_id, s.station_id])
    );
  }

  /**
   * 出発駅（駅ID）から予算内で到達可能な駅を計算
   * @param {string} departureStationId - 出発駅ID（stations.jsonのキー）
   * @param {number} budget - 予算（円）。**往復**の交通費（2026-09-12決定）。
   *                  GTFSの運賃データには往復運賃・往復割引の概念がなく、片道の
   *                  運賃商品しか存在しないため、帰りも往路と同額と仮定して判定する。
   * @returns {Array} [{station_id, display_name, stop_ids, fare, roundTripFare, reachBy, viaOperator, transferAt, legOperators, legFares}, ...]
   *                  fare は片道総額、roundTripFare は fare*2（予算と比較すべき実際の負担額）
   *                  reachBy: 'direct'(直接), 'transfer'(1回乗換。起点は鉄道・バスいずれも可)
   */
  async calculateReachable(departureStationId, budget) {
    try {
      const departureStation = this.stations?.[departureStationId];
      if (!departureStation) {
        console.warn(`⚠️ 出発駅が見つかりません: ${departureStationId}`);
        return [];
      }

      // ステップ1：出発駅の全stop_id（全事業者）を起点にOD運賃表を直接検索し、駅ID単位に集約
      const reachable = new Map(); // stationId -> {fare, reachBy, viaOperator, viaStopId}

      for (const { stop_id: originStopId, operator_id: originOperator } of departureStation.stops) {
        const destinations = this.fareData.od_fares?.[originStopId];
        if (!destinations) continue;

        for (const [destStopId, fare] of Object.entries(destinations)) {
          if (fare > budget) continue;
          const destStationId = this.stopIdToStationId.get(destStopId);
          if (!destStationId || destStationId === departureStationId) continue;

          const existing = reachable.get(destStationId);
          const selectionMinutes = estimateSelectionMinutes(this.routeDetails, departureStationId, {
            reachBy: 'direct',
            station_id: destStationId,
            viaOperator: originOperator,
          });
          if (isBetterCandidate(fare, selectionMinutes, existing)) {
            reachable.set(destStationId, {
              fare,
              selectionMinutes,
              reachBy: 'direct',
              viaOperator: originOperator,
              viaStopId: originStopId,
            });
          }
        }
      }

      const directCount = reachable.size;
      console.log(`✅ 直接到達駅: ${directCount}駅`);

      // ステップ2：直接到達した駅（鉄道・バスいずれでも可）から、併設するバス系
      // 停留所経由でラストワンマイルを1回だけ乗り継ぐ。
      // 【2026-10-02変更】以前は起点を鉄道系の停留所に限定していた（isRailEligible）。
      // 香川は鉄道があるため成り立っていたが、富山・石川はほぼバスのみで、起点を
      // 鉄道に限ると「1本で行ける範囲」しか出ない。富山・石川での実測
      // （松任駅、単一の小規模コミュニティバスにしか接続しない駅）では、起点を
      // バスにも広げることで往復¥1000の到達駅数が164→258駅（+57%）に増えた。
      // 小規模バスが市町村ごとに分かれる全国のgtfs-data.jpフィードでは、この
      // 効果は無視できない。所要時間・待ち時間はroute-details.json・
      // estimateSelectionMinutes()が駅ID×駅ID×事業者IDで汎用的に引く設計のため、
      // 起点の制限を外すだけで追加の仕組みなしに解決できる（実測で確認済み）。
      const directHubStations = Array.from(reachable.entries()).filter(
        ([, info]) => info.reachBy === 'direct'
      );

      for (const [hubStationId, hubInfo] of directHubStations) {
        const remainingBudget = budget - hubInfo.fare;
        if (remainingBudget <= 0) continue;

        const hubStation = this.stations[hubStationId];
        if (!hubStation) continue;

        const busStops = hubStation.stops.filter((s) => isBusEligible(s.mode));
        if (busStops.length === 0) continue; // この駅にはバス乗換拠点がない

        for (const busStop of busStops) {
          const busDestinations = this.fareData.od_fares?.[busStop.stop_id];
          if (!busDestinations) continue;

          for (const [destStopId, busFare] of Object.entries(busDestinations)) {
            if (busFare > remainingBudget) continue;
            const destStationId = this.stopIdToStationId.get(destStopId);
            if (!destStationId || destStationId === departureStationId || destStationId === hubStationId) continue;

            const totalFare = hubInfo.fare + busFare;
            const existing = reachable.get(destStationId);
            const legOperators = [hubInfo.viaOperator, busStop.operator_id];
            const selectionMinutes = estimateSelectionMinutes(this.routeDetails, departureStationId, {
              reachBy: 'transfer',
              station_id: destStationId,
              transferAt: hubStationId,
              legOperators,
            });
            if (isBetterCandidate(totalFare, selectionMinutes, existing)) {
              reachable.set(destStationId, {
                fare: totalFare,
                selectionMinutes,
                reachBy: 'transfer',
                transferAt: hubStationId,
                legOperators,
                legFares: [hubInfo.fare, busFare],
              });
            }
          }
        }
      }

      // 最終判定：このアプリの予算は往復の交通費（2026-09-12決定、CLAUDE.md参照）。
      // GTFSの運賃データに往復運賃・往復割引という概念自体が存在しないため、
      // 帰りも往路と同額と仮定し、往路総額（info.fare、上記のkeep-min処理により
      // 既にその駅への最安値）を2倍した額で判定する。
      // 区間ごとに半額の予算を割り振って積み上げる方式（探索の途中でbudget/2を
      // 使う）は、乗り継ぎが増えたときの端数処理や残額配分で事故りやすいため
      // 採用しない。探索フェーズの枝刈り（上記のbudget比較）は「往路総額は
      // budgetを超えない」という往復判定より常に緩い条件のままにしておき、
      // 有効な候補を誤って捨てないようにした上で、ここで一度だけ厳密に判定する。
      for (const [stationId, info] of reachable) {
        if (info.fare * 2 > budget) {
          reachable.delete(stationId);
        }
      }
      console.log(`✅ 往復予算内（片道総額×2 ≦ ¥${budget}）: ${reachable.size}駅`);

      const finalTransferCount = Array.from(reachable.values()).filter(
        (info) => info.reachBy === 'transfer'
      ).length;
      console.log(`✅ 乗り継ぎ到達駅: ${finalTransferCount}駅`);

      // 結果をリスト化（各駅IDに属する全stop_idを付与＝スポット検索用）
      // selectionTimeMin は「乗車時間＋期待待ち時間」（分）。アクセス駅選定（SpotFinder）で
      // 「選定時間＋徒歩時間」の総所要時間を比較するために使う。
      // rideDurationMin は乗車時間のみ（待ち時間を含まない）。カード・詳細画面の
      // 所要時間表示に使う。どちらも経路が確定できない場合はnull。
      // fare は片道総額（詳細画面の区間内訳・合計と整合させるためそのまま維持）、
      // roundTripFare は予算と比較すべき実際の負担額（往復・帰りは同額と仮定）。
      // viaOperator/legOperatorsは運賃を決めた事業者そのものを経路表示にも
      // 使わせるためのもの（運賃事業者と表示経路事業者を一致させる）。
      const result = Array.from(reachable.entries()).map(([stationId, info]) => {
        const station = this.stations[stationId];
        const stationEntry = {
          station_id: stationId,
          display_name: station ? station.display_name : stationId,
          stop_ids: station ? station.stops.map((s) => s.stop_id) : [],
          fare: info.fare,
          roundTripFare: info.fare * 2,
          reachBy: info.reachBy,
          viaOperator: info.reachBy === 'direct' ? info.viaOperator : null,
          transferAt: info.transferAt || null,
          legOperators: info.legOperators || null,
          legFares: info.legFares || null,
        };
        // タイブレークのために探索中に既に算出済み（isBetterCandidate参照）。
        // 再計算せず同じ値を使い回すことで、両者が食い違う余地をなくす。
        stationEntry.selectionTimeMin = info.selectionMinutes;
        stationEntry.rideDurationMin = estimateRideMinutes(this.routeDetails, departureStationId, stationEntry);
        return stationEntry;
      });

      return result;
    } catch (error) {
      console.error('❌ 運賃計算失敗:', error);
      throw error;
    }
  }

}
