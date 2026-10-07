/**
 * gtfs-loader.js - GTFS派生データのロード
 *
 * 【2026-10-02】県ごとに分割したdocs/data/pref/{コード}/を、出発駅の県＋隣接県
 * だけfetchする構成に変更した（段階1(c)の土台）。以前は全データを単一HTMLに
 * 埋め込んでいたが、香川だけで埋め込みデータがバンドル全体の92%（2.7MB）を
 * 占めており、県が増えるほどページが肥大化する構造だった。
 *
 * ロードは2段階：
 * 1. loadStationIndex() - 起動時に一度だけ。全都道府県の軽量駅一覧
 *    （docs/data/national/station-index.json、駅ID・座標を持たない
 *    [表示名, 県コード, 県内通し番号]の配列）・隣接県表・スポットランキング設定
 *    （都道府県に依存しないため、ここで一度だけ取得する）を取得する。
 *    出発駅のオートコンプリートはこれだけで動く。
 * 2. loadPrefectures(prefIds) - 出発駅が決まってから。その県＋隣接県の
 *    フルデータ（運賃・停留所・路線・経路・スポット）をfetchし、
 *    これまでのloadAll()と同じ形のデータにまとめて返す。
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
      // 【2026-10-07】座標を複数持つ項目（川等）では、停留所ごとに「一番近い座標」が
      // spots[]の代表点と異なることがあり、その場合だけ配列が
      // [index, distance, latitude, longitude] の4要素になっている
      // （generate-spots-by-region.jsのbuildIndexedSpotsOutput参照）。
      spotsByStation[stopId] = stations[stopId].map(([index, distance, latitude, longitude]) => {
        const qid = spotsIndex[index];
        if (spots[qid] === undefined) {
          spots[qid] = spotDetails[index];
        }
        const ref = { qid, distance };
        if (latitude !== undefined) {
          ref.latitude = latitude;
          ref.longitude = longitude;
        }
        return ref;
      });
    }
  }

  return { spots, spotsByStation };
}

/**
 * route-details.jsonの圧縮形式（{routeIndex: [...], data: {...}}、route_idが
 * 整数インデックスになっている）を、従来の{originId: {destId: {operatorId: RouteEntry}}}
 * 形式（route_idが文字列のまま）へ復元する。これにより、以降のコード
 * （fare-calculator.js・route-formatter.js・route-duration.js）は一切変更しない。
 */
function decodeRouteDetails(indexed) {
  const { routeIndex, data } = indexed;
  const decoded = {};
  for (const [originId, destMap] of Object.entries(data)) {
    decoded[originId] = {};
    for (const [destId, byOperator] of Object.entries(destMap)) {
      decoded[originId][destId] = {};
      for (const [operatorId, entry] of Object.entries(byOperator)) {
        // 2026-10-06: wait_minを削除した新形式。直行は長さ2、乗換1回は長さ5（旧: 3/7）。
        decoded[originId][destId][operatorId] = entry.length === 2
          ? [routeIndex[entry[0]], entry[1]]
          : [entry[0], routeIndex[entry[1]], entry[2], routeIndex[entry[3]], entry[4]];
      }
    }
  }
  return decoded;
}

function prefCodeStr(code) {
  return String(code).padStart(2, '0');
}

export class GTFSLoader {
  constructor() {
    this.stationIndex = null; // [[表示名, 県コード, 県内通し番号], ...]（公開中の都道府県分のみ）
    this.prefectureAdjacency = null; // { "16": ["15","17",...], ... }（全47都道府県分、地理的事実）
    this.publishedPrefectures = null; // ["37", ...] docs/data/pref/配下に実在する＝公開中の都道府県コード
    this.loadedPrefCodes = new Set(); // 既にfetch済みの県コード（再フェッチを避ける）
    this.fareData = null;
    this.stopsMetadata = null;
    this.routeInfo = null;
    this.routeDetails = null; // 出発駅ID → {到着駅ID: {事業者ID: RouteEntry}}（経路・所要時間、詳細はgenerate-route-details.js）
    this.stations = null; // 駅ID → {display_name, stop_lat, stop_lon, stops: [{stop_id, operator_id, mode}]}
    this.spots = null; // QID → スポット詳細の辞書
    this.spotsByStation = null; // stop_id → [{qid, distance}, ...] の参照配列
  }

  /**
   * 起動時に一度だけ呼ぶ。全国の軽量駅一覧・隣接県表・公開中都道府県一覧・
   * スポットランキング設定（都道府県に依存しないため、ここで一度だけ取得すればよい）
   * を取得する。ランキング設定の取得に失敗しても検索自体は継続できるため、失敗は
   * 警告に留める（spot-finder.jsのloadRankingConfig()がデフォルト値で補う）。
   *
   * 【2026-10-03追記】publishedPrefecturesは、隣接県読み込み時に「公開していない県へは
   * 404を出しに行かない」フィルタに使う（main.jsのloadPrefecturesForDeparture()参照）。
   * stationIndex自体はgenerate-site-data.jsが公開中の都道府県分しか出力しないため、
   * 出発駅として選べる時点で既に公開中の県に絞られている。
   */
  async loadStationIndex() {
    const [stationIndex, adjacency, publishedPrefectures, rankingConfig] = await Promise.all([
      this.fetchJson('data/national/station-index.json'),
      this.fetchJson('data/national/prefecture-adjacency.json'),
      this.fetchJson('data/national/published-prefectures.json'),
      this.fetchJson('data/national/spot-ranking-config.json').catch((error) => {
        console.warn(`⚠️ スポットランキング設定の取得に失敗しました（${error.message}）。デフォルト値を使用します`);
        return null;
      }),
    ]);
    this.stationIndex = stationIndex;
    this.prefectureAdjacency = adjacency;
    this.publishedPrefectures = publishedPrefectures;
    if (rankingConfig) {
      window.EMBEDDED_SPOT_RANKING_CONFIG = rankingConfig;
    }
    console.log(`✅ 駅一覧をロード（${stationIndex.length}駅、公開中${publishedPrefectures.length}都道府県分）`);
    return { stationIndex, adjacency, publishedPrefectures };
  }

  /**
   * 指定した都道府県コードの駅一覧上のエントリ（[表示名, 県コード, 県内通し番号]）から、
   * 実際のstation_idを復元する。生成側（generate-site-data.jsのgenerateStationIndex）と
   * 同じ規則（その県のstations.jsonのキーを昇順ソートしたときのインデックス）で
   * 引くため、既にその県のstations.jsonがロード済みであることが前提。
   */
  resolveStationId(prefCode, localIndex) {
    const codeStr = prefCodeStr(prefCode);
    const stationsForPref = this._stationsByPref?.[codeStr];
    if (!stationsForPref) {
      throw new Error(`都道府県コード${codeStr}のデータが未ロードです。先にloadPrefectures()でロードしてください`);
    }
    return stationsForPref[localIndex];
  }

  /**
   * 指定した都道府県コード（複数可）のフルデータをfetchし、既存のloadAll()と
   * 同じ形のデータにまとめて返す。隣接県データがまだ公開されていない場合
   * （docs/data/pref/配下に存在しない＝404）は、警告を出してその県だけ
   * スキップする（全体を失敗させない）。
   * @param {Array<number|string>} prefCodes
   */
  async loadPrefectures(prefCodes) {
    const codesToFetch = [...new Set(prefCodes.map(prefCodeStr))].filter(
      (code) => !this.loadedPrefCodes.has(code)
    );

    const results = await Promise.all(
      codesToFetch.map(async (codeStr) => {
        try {
          const base = `data/pref/${codeStr}/`;
          const [fareData, stopsMetadata, stations, routeInfo, routeDetailsIndexed, spotsData] =
            await Promise.all([
              this.fetchJson(`${base}fare-lookup-tables.json`),
              this.fetchJson(`${base}stops-metadata.json`),
              this.fetchJson(`${base}stations.json`),
              this.fetchJson(`${base}route-info.json`),
              this.fetchJson(`${base}route-details.json`),
              this.fetchJson(`${base}spots-by-station.json`),
            ]);
          return {
            codeStr, fareData, stopsMetadata, stations,
            routeInfo, routeDetails: decodeRouteDetails(routeDetailsIndexed),
            spotsData,
          };
        } catch (error) {
          console.warn(`⚠️ 都道府県コード${codeStr}のデータ取得に失敗しました（${error.message}）。この県はスキップします`);
          return null;
        }
      })
    );

    this._stationsByPref = this._stationsByPref || {};
    this.fareData = this.fareData || { od_fares: {}, bus_fares: {} };
    this.stopsMetadata = this.stopsMetadata || [];
    this.routeInfo = this.routeInfo || {};
    this.routeDetails = this.routeDetails || {};
    this.stations = this.stations || {};
    const spotRegions = [];
    if (this._loadedSpotRegions) spotRegions.push(...this._loadedSpotRegions);

    for (const result of results) {
      if (!result) continue;
      const { codeStr, fareData, stopsMetadata, stations, routeInfo, routeDetails, spotsData } = result;
      this.loadedPrefCodes.add(codeStr);

      // 県内通し番号→station_idの復元に使う（resolveStationId参照）。
      // 生成側（generate-site-data.js）と同じ規則：station_idを昇順ソート。
      this._stationsByPref[codeStr] = Object.keys(stations).sort();

      Object.assign(this.fareData.od_fares, fareData.od_fares);
      Object.assign(this.fareData.bus_fares, fareData.bus_fares);
      this.stopsMetadata.push(...stopsMetadata);
      Object.assign(this.routeInfo, routeInfo);
      Object.assign(this.routeDetails, routeDetails);
      Object.assign(this.stations, stations);
      spotRegions.push(spotsData);
    }
    this._loadedSpotRegions = spotRegions;

    const merged = mergeIndexedSpotRegions(spotRegions);
    this.spots = merged.spots;
    this.spotsByStation = merged.spotsByStation;

    console.log(`✅ ${codesToFetch.length}都道府県分のデータをロード（累計: ${[...this.loadedPrefCodes].join(', ')}）`);
    console.log(`  - ${this.stopsMetadata.length} 駅のメタデータ`);
    console.log(`  - ${Object.keys(this.stations).length} 駅（クラスタリング後）`);
    console.log(`  - ${Object.keys(this.routeInfo).length} 路線の情報`);
    console.log(`  - ${Object.keys(this.spots).length} 件のスポット辞書`);
    console.log(`  - ${Object.keys(this.spotsByStation).length} 駅のスポット参照`);

    return {
      fareData: this.fareData,
      stopsMetadata: this.stopsMetadata,
      routeInfo: this.routeInfo,
      routeDetails: this.routeDetails,
      stations: this.stations,
      spots: this.spots,
      spotsByStation: this.spotsByStation,
    };
  }

  /**
   * JSON を fetch して取得
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
