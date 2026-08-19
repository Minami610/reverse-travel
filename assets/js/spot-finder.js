/**
 * spot-finder.js - 観光スポット検索・フィルタリング
 * 到達可能な駅から周辺スポットを検索、知名度順にソート
 */

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
        pageview_thresholds: {
          absolute_threshold: 25000,
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
      // 「¥Xで行ける」が前提のこのアプリでは運賃が最も安い到達駅を採用する
      // （同額の場合は距離が近い方を優先）。
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
          };

          const existing = bestSpotByQid.get(qid);
          const isCheaper = !existing || candidate.source_fare < existing.source_fare;
          const isSameFareButCloser =
            existing &&
            candidate.source_fare === existing.source_fare &&
            candidate.distance < existing.distance;

          if (isCheaper || isSameFareButCloser) {
            bestSpotByQid.set(qid, candidate);
          }
        });
      }

      const allSpots = Array.from(bestSpotByQid.values());
      console.log(`📍 収集スポット数（QID重複排除後）: ${allSpots.length}`);

      // フィルタリング：知名度が高すぎるものを除外
      const filtered = this.filterByPageviews(allSpots);
      console.log(`✂️ フィルタ後: ${filtered.length}スポット`);

      // 知名度の低い順（「隠れた」スポット優先）にソート
      const sorted = this.sortByPageviews(filtered);

      return sorted;
    } catch (error) {
      console.error('❌ スポット検索失敗:', error);
      throw error;
    }
  }

  /**
   * 絶対値閾値で超有名スポットを除外
   * @private
   */
  filterByPageviews(spots) {
    const threshold =
      this.rankingConfig.pageview_thresholds.absolute_threshold || 25000;

    return spots.filter((spot) => {
      if (!spot.pageviews) {
        // ページビューデータがない場合は「隠れている」と見なして通す
        return true;
      }
      return spot.pageviews < threshold;
    });
  }

  /**
   * 情報充実度（説明文＋写真の有無）を優先グループとし、
   * 各グループ内でページビュー数が低い順にソートする。
   * 「知られていないが、ちゃんと魅力が伝わる場所」を上位に出すための措置。
   * 説明文・写真が両方揃っているスポットが記事未整備のスポットより先に来る。
   * @private
   */
  sortByPageviews(spots) {
    const isWellDocumented = (spot) => Boolean(spot.description) && Boolean(spot.image);

    return spots.sort((a, b) => {
      const aDocumented = isWellDocumented(a);
      const bDocumented = isWellDocumented(b);
      if (aDocumented !== bDocumented) {
        return aDocumented ? -1 : 1;
      }

      // ページビューデータなし → 優先（0として扱う）
      const aPageviews = a.pageviews || 0;
      const bPageviews = b.pageviews || 0;

      return aPageviews - bPageviews;
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
