/**
 * spot-finder.js - 観光スポット検索・フィルタリング
 * 到達可能な駅から周辺スポットを検索、知名度順にソート
 */

// 徒歩速度（分速80m）。徒歩時間 = 距離(km) * 1000 / WALK_SPEED_M_PER_MIN
const WALK_SPEED_M_PER_MIN = 80;

function walkMinutes(distanceKm) {
  return (distanceKm * 1000) / WALK_SPEED_M_PER_MIN;
}

export class SpotFinder {
  constructor(data) {
    this.spots = data.spots; // QID → スポット詳細の辞書
    this.spotsByStation = data.spotsByStation; // stop_id → [{qid, distance}, ...]
    this.stopsMetadata = data.stopsMetadata;
    this.rankingConfig = null;

    this.loadRankingConfig();
  }

  loadRankingConfig() {
    // ビルド時に埋め込まれたランキング設定を参照
    if (typeof window.EMBEDDED_SPOT_RANKING_CONFIG !== 'undefined') {
      this.rankingConfig = window.EMBEDDED_SPOT_RANKING_CONFIG;
    } else {
      console.warn('⚠️ スポットランキング設定が埋め込まれていません。デフォルト値を使用');
      this.rankingConfig = {
        sitelinks_threshold: {
          absolute_threshold: 10,
        },
      };
    }
  }

  /**
   * 到達可能な駅周辺のスポットをすべて収集・フィルタリング
   * @param {Array} reachableStations - [{stop_id, stop_name, fare}, ...]（予算以下すべて。
   *   呼び出し側で帯に絞り込まずに渡すこと。帯判定はスポット単位でmain.js側が行う）
   * @returns {Array} フィルタ済みスポットの配列（知名度順）
   */
  async findSpots(reachableStations) {
    try {
      // スポットはQID単位で最終的に1件だけ表示する。
      // 同じスポットが複数の到達駅の半径内に入ることがあるため、
      // どの到達駅をアクセス駅として採用するかを決める必要がある。
      //
      // 【2026-10-07修正】優劣判定を「総所要時間が短い方」から
      // 「往復運賃が安い方（同額なら総所要時間が短い方）」に変更した。
      // 背景：帯表示（main.js）が「駅を先に帯で絞ってからスポットを探す」
      // 実装だったため、同じスポットが複数の駅の圏内にある場合（例：
      // 富山駅前近くのTOYAMAキラリが、安いが遠回りの駅経由でも、高いが
      // 近い別駅経由でも到達可能）、検索した予算によって「どちらの駅経由か」
      // が変わり、同じスポットが往復¥400の帯にも往復¥1000の帯にも
      // 別々の運賃で出てしまう不具合が実際にあった（Minamiさんが公開ページで
      // 発見）。原因は「駅を帯で絞ってから探す」設計そのものにあった：
      // 呼び出し側が予算以下の到達駅をすべて渡し、ここで各スポットの
      // 「最安の往復運賃」を一意に決めてから、呼び出し側（main.js）が
      // その最安運賃で帯判定する設計に直した。これにより同じスポットは
      // どの予算で検索しても常に同じ駅・同じ運賃で1回だけ出る。
      const bestSpotByQid = new Map();

      for (const station of reachableStations) {
        // 駅は複数のstop_id（プラットフォーム単位）を持ちうるため、
        // 全stop_id分のスポット参照を駅内でQID重複排除する（最短距離を採用）
        const stopIds = station.stop_ids?.length ? station.stop_ids : [station.station_id];
        const bestRefByQidInStation = new Map();

        stopIds.forEach((stopId) => {
          const refs = this.spotsByStation[stopId] || [];
          refs.forEach((ref) => {
            const existing = bestRefByQidInStation.get(ref.qid);
            if (!existing || existing.distance > ref.distance) {
              bestRefByQidInStation.set(ref.qid, ref);
            }
          });
        });

        bestRefByQidInStation.forEach((ref, qid) => {
          const detail = this.spots[qid];
          if (!detail) return;

          const candidate = {
            ...detail,
            id: qid,
            distance: ref.distance,
            source_station: station.display_name,
            source_station_id: station.station_id,
            source_fare: station.fare,
            source_round_trip_fare: station.roundTripFare,
            source_reach_by: station.reachBy,
            source_via_operator: station.viaOperator,
            source_transfer_at: station.transferAt,
            source_leg_operators: station.legOperators,
            source_leg_fares: station.legFares,
            source_transfer_alight_stop_id: station.transferAlightStopId,
            source_transfer_board_stop_id: station.transferBoardStopId,
            source_ride_duration_min: station.rideDurationMin,
            source_total_time_min:
              (station.selectionTimeMin ?? Infinity) + walkMinutes(ref.distance),
          };

          const existing = bestSpotByQid.get(qid);
          const isBetter =
            !existing ||
            candidate.source_round_trip_fare < existing.source_round_trip_fare ||
            (candidate.source_round_trip_fare === existing.source_round_trip_fare &&
              candidate.source_total_time_min < existing.source_total_time_min);

          if (isBetter) {
            bestSpotByQid.set(qid, candidate);
          }
        });
      }

      const allSpots = Array.from(bestSpotByQid.values());
      console.log(`📍 収集スポット数（QID重複排除後）: ${allSpots.length}`);

      // フィルタリング：知名度が高すぎるものを除外
      const filtered = this.filterBySitelinks(allSpots);
      console.log(`✂️ フィルタ後: ${filtered.length}スポット`);

      // 情報充実度（説明文の長さ・画像有無）順にソート
      const sorted = this.sortByInformativeness(filtered);

      return sorted;
    } catch (error) {
      console.error('❌ スポット検索失敗:', error);
      throw error;
    }
  }

  /**
   * 絶対値閾値で超有名スポットを除外（Wikidataのsitelinks=他言語版記事数を使用）。
   * sitelinksは同順位が多発する（低い値に密集）ため足切り専用とし、順位付けには使わない。
   * @private
   */
  filterBySitelinks(spots) {
    const threshold = this.rankingConfig.sitelinks_threshold?.absolute_threshold ?? 10;

    return spots.filter((spot) => {
      if (spot.sitelinks === undefined || spot.sitelinks === null) {
        // sitelinksデータがない場合は「隠れている」と見なして通す
        return true;
      }
      return spot.sitelinks < threshold;
    });
  }

  /**
   * 情報充実度（説明文の文字数・画像の有無）順にソートする。
   * 「知られていないが、ちゃんと魅力が伝わる場所」を上位に出すための措置。
   * 主軸はWikipedia本文(description)の文字数（多い順）、同点の場合のみ画像の有無で判定する。
   * sitelinksは同順位が多発し順位付けの主軸にできないため、情報充実度そのものを主軸にする。
   * @private
   */
  sortByInformativeness(spots) {
    const descriptionLength = (spot) => (spot.description !== undefined && spot.description !== null ? spot.description.length : 0);
    const hasImage = (spot) => spot.image !== undefined && spot.image !== null;

    return spots.sort((a, b) => {
      const lengthDiff = descriptionLength(b) - descriptionLength(a);
      if (lengthDiff !== 0) return lengthDiff;

      const aHasImage = hasImage(a);
      const bHasImage = hasImage(b);
      if (aHasImage !== bHasImage) return aHasImage ? -1 : 1;

      return 0;
    });
  }

  /**
   * 最寄駅との距離を計算（Haversine公式）
   * @private
   */
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // 地球半径（km）
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
}
