/**
 * gtfs-loader.js - GTFS派生データのロード
 * ビルド時に生成された JSON をブラウザメモリにロード
 */

/**
 * 1つ以上の地域（都道府県）のインデックス化済みスポットデータ
 * （{spotsIndex, spots, stations}、generate-spots-by-region.jsのbuildIndexedSpotsOutput参照）を
 * QIDで重複排除しながら1つの{spots:{qid:詳細}, spotsByStation:{stop_id:[{qid,distance}]}}にまとめる。
 *
 * 【背景】隣接県を同時ロードする設計のため、同じQIDが複数回登場しうる：
 * (1) 山脈等、地理的に複数県にまたがり意図的に両県のファイルへ重複登録されている
 *     スポット（実測: 全体の0.9%程度）
 * (2) 県判定（P131）を誤ってどちらかの県ファイルへフォールバック配置された項目
 * どちらもQIDで一意化すれば実害なく解決するため（最初に読み込んだ地域の詳細情報を
 * 正として採用、後続で同じQIDが来ても上書きしない）、県判定の精度そのものは
 * 「多少ずれても実害がない」問題に格下げされる。
 * regionsが1件（単一県のみロード）の場合は単純な形式変換として働く。
 */
export function mergeIndexedSpotRegions(regions) {
  const spots = {};
  const spotsByStation = {};

  for (const region of regions) {
    const { spotsIndex, spots: spotDetails, stations } = region;
    for (const stopId of Object.keys(stations)) {
      spotsByStation[stopId] = stations[stopId].map(([index, distance]) => {
        const qid = spotsIndex[index];
        if (spots[qid] === undefined) {
          spots[qid] = spotDetails[index];
        }
        return { qid, distance };
      });
    }
  }

  return { spots, spotsByStation };
}

export class GTFSLoader {
  constructor() {
    this.fareData = null;
    this.stopsMetadata = null;
    this.routeInfo = null;
    this.routeDetails = null; // 出発駅名 → {到着駅名: RouteEntry}（経路・所要時間、詳細はgenerate-route-details.js）
    this.stationsByName = null; // 駅名 → {stop_name, stop_lat, stop_lon, stops: [{stop_id, operator_id}]}
    this.spots = null; // QID → スポット詳細の辞書
    this.spotsByStation = null; // stop_id → [{qid, distance}, ...] の参照配列
  }

  async loadAll() {
    try {
      const hasEmbeddedData = typeof window.EMBEDDED_FARE_DATA !== 'undefined';

      if (hasEmbeddedData) {
        // 本番ビルド：index.html の <script> タグに埋め込まれたデータを参照
        this.fareData = window.EMBEDDED_FARE_DATA;
        this.stopsMetadata = window.EMBEDDED_STOPS_METADATA;
        this.routeInfo = window.EMBEDDED_ROUTE_INFO;
        this.routeDetails = window.EMBEDDED_ROUTE_DETAILS;
        this.stationsByName = window.EMBEDDED_STATIONS_BY_NAME;
        // EMBEDDED_SPOTS_BY_STATIONは{spotsIndex, spots, stations}のインデックス化済み形式
        // （県ごとに1つ）。将来、隣接県を同時ロードする際は配列で複数地域分渡す。
        const merged = mergeIndexedSpotRegions([window.EMBEDDED_SPOTS_BY_STATION]);
        this.spots = merged.spots;
        this.spotsByStation = merged.spotsByStation;
      } else {
        // 開発時：埋め込みデータがないため data/derived/*.json を fetch で読み込む
        console.log('ℹ️ 埋め込みデータなし。data/derived/*.json を fetch で読み込みます（開発モード）');
        const derivedBase = 'data/derived/';
        const [fareData, stopsMetadata, stationsByName, routeInfo, routeDetails, spotsData, rankingConfig] =
          await Promise.all([
            this.fetchJson(`${derivedBase}fare-lookup-tables.json`),
            this.fetchJson(`${derivedBase}stops-metadata.json`),
            this.fetchJson(`${derivedBase}stations-by-name.json`),
            this.fetchJson(`${derivedBase}route-info.json`),
            this.fetchJson(`${derivedBase}route-details.json`),
            this.fetchJson(`${derivedBase}spots-by-station.json`),
            this.fetchJson('config/spot-ranking-config.json'),
          ]);

        this.fareData = fareData;
        this.stopsMetadata = stopsMetadata;
        this.routeInfo = routeInfo;
        this.routeDetails = routeDetails;
        this.stationsByName = stationsByName;
        // spots-by-station.jsonは{spotsIndex, spots, stations}のインデックス化済み形式
        const merged = mergeIndexedSpotRegions([spotsData]);
        this.spots = merged.spots;
        this.spotsByStation = merged.spotsByStation;
        // spot-finder.js は window.EMBEDDED_SPOT_RANKING_CONFIG を同期的に参照するため、
        // 本番ビルドと同じ経路で読めるようにここでセットしておく
        window.EMBEDDED_SPOT_RANKING_CONFIG = rankingConfig;
      }

      console.log('✅ GTFS派生データをロード');
      console.log(`  - ${this.stopsMetadata.length} 駅のメタデータ`);
      console.log(`  - ${Object.keys(this.stationsByName).length} 駅名（集約後）`);
      console.log(`  - ${Object.keys(this.routeInfo).length} 路線の情報`);
      console.log(`  - ${Object.keys(this.spots).length} 件のスポット辞書`);
      console.log(`  - ${Object.keys(this.spotsByStation).length} 駅のスポット参照`);

      return {
        fareData: this.fareData,
        stopsMetadata: this.stopsMetadata,
        routeInfo: this.routeInfo,
        routeDetails: this.routeDetails,
        stationsByName: this.stationsByName,
        spots: this.spots,
        spotsByStation: this.spotsByStation,
      };
    } catch (error) {
      console.error('❌ GTFS データロード失敗:', error);
      throw error;
    }
  }

  /**
   * JSON を fetch して取得（開発モード用）
   * @private
   */
  async fetchJson(path) {
    const response = await fetch(path);
    if (!response.ok) {
      throw new Error(`${path} の取得に失敗しました（HTTP ${response.status}）`);
    }
    return response.json();
  }

  /**
   * 停留所情報を ID から検索
   */
  getStop(stopId) {
    return this.stopsMetadata.find(s => s.stop_id === stopId);
  }

  /**
   * 停留所名から ID を検索（部分一致）
   */
  searchStopsByName(name) {
    return this.stopsMetadata.filter(s =>
      s.stop_name.toLowerCase().includes(name.toLowerCase())
    );
  }

  /**
   * 路線情報を取得
   */
  getRoute(routeId) {
    return this.routeInfo[routeId];
  }

  /**
   * 駅周辺のスポットを取得（QID参照をスポット詳細に解決して返す）
   */
  getSpotsByStop(stopId) {
    const refs = this.spotsByStation[stopId] || [];
    return refs
      .map((ref) => {
        const detail = this.spots[ref.qid];
        return detail ? { ...detail, id: ref.qid, distance: ref.distance } : null;
      })
      .filter(Boolean);
  }
}
