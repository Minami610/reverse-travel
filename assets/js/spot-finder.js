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
   * @param {Array} reachableStations - [{stop_id, stop_name, fare}, ...]
   * @returns {Array} フィルタ済みスポットの配列（知名度順）
   */
  async findSpots(reachableStations) {
    try {
      // スポットはQID単位で最終的に1件だけ表示する。
      // 同じスポットが複数の到達駅の半径内に入ることがあるため、
      // どの到達駅をアクセス駅として採用するかを決める必要がある。
      // 運賃は「予算内かどうか」の制約としてすでにfare-calculator側で
      // フィルタ済みのため、ここでの優劣判定は総所要時間
      // （乗車時間＋徒歩時間）で行う。乗車時間が長くても徒歩0.1kmの駅が
      // 乗車7分・徒歩0.5kmの駅に勝ってしまう、という問題を避けるため。
      const bestSpotByQid = new Map();

      for (const station of reachableStations) {
        // 駅は複数のstop_id（プラットフォーム単位）を持ちうるため、
        // 全stop_id分のスポット参照を駅内でQID重複排除する（最短距離を採用）
        const stopIds = station.stop_ids?.length ? station.stop_ids : [station.stop_id];
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
            source_station: station.stop_name,
            source_stop_id: station.stop_id,
            source_fare: station.fare,
            source_reach_by: station.reachBy,
            source_transfer_at: station.transferAt,
            source_leg_fares: station.legFares,
            source_ride_duration_min: station.rideDurationMin,
            source_total_time_min:
              (station.selectionTimeMin ?? Infinity) + walkMinutes(ref.distance),
          };

          const existing = bestSpotByQid.get(qid);
          const isFaster = !existing || candidate.source_total_time_min < existing.source_total_time_min;

          if (isFaster) {
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
