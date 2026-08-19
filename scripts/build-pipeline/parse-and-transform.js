/**
 * parse-and-transform.js - GTFS パース・派生JSON生成
 * 
 * 生GTFSファイル（CSVs）を解析し、運賃ルックアップ用の派生JSONを生成
 * 
 * 出力：
 * - fare-lookup-tables.json    : {od_fares: {...}, bus_fares: {...}}
 * - stops-metadata.json        : [{stop_id, stop_name, stop_lat, stop_lon, ...}]
 * - route-info.json            : {route_id: {route_short_name, ...}}
 */

import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// パス定義
const dataDir = path.join(__dirname, '../../data');
const rawGtfsDir = path.join(dataDir, 'raw-gtfs');
const derivedDir = path.join(dataDir, 'derived');
const configPath = path.join(__dirname, '../../config/target-operators.json');

/**
 * GTFS パース・派生JSON生成のメイン処理
 */
export async function parseAndTransform() {
  console.log('🔄 GTFS パース開始...\n');

  // 出力ディレクトリ作成
  if (!fs.existsSync(derivedDir)) {
    fs.mkdirSync(derivedDir, { recursive: true });
  }

  // configを読み込む
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  // 集約用オブジェクト
  const aggregated = {
    od_fares: {},      // {departure_stop_id: {arrival_stop_id: fare}} ※stop_idはフラット、事業者を横断して統合
    bus_fares: {},     // {route_id: {stops: [], fare: X}}
    stops: {},         // {stop_id: {stop_name, lat, lon, zone_id, parent_station}}
    routes: {},        // {route_id: {route_short_name, ...}}
  };
  let totalInputRows = 0;
  let totalGeneratedRecords = 0;

  // 各事業者のGTFSを処理
  for (const operator of config.phase1_operators) {
    const operatorDir = path.join(rawGtfsDir, operator.id);

    if (!fs.existsSync(operatorDir)) {
      console.warn(`⚠️  ${operator.name} - ディレクトリなし（未ダウンロード？）`);
      continue;
    }

    console.log(`📖 ${operator.name} をパース中...`);
    const stats = await processOperator(operator, operatorDir, aggregated);
    totalInputRows += stats.inputRows;
    totalGeneratedRecords += stats.generatedRecords;
    console.log(`✅ ${operator.name} 完了\n`);
  }

  console.log(`📊 パース集計: 入力 ${totalInputRows} 行 / 生成 ${totalGeneratedRecords} レコード`);
  if (totalInputRows === 0 || totalGeneratedRecords === 0) {
    throw new Error('GTFSパース結果が0件です。入力ファイルと展開状態を確認してください');
  }

  // 派生JSONを生成
  saveDerivedData(aggregated);

  console.log('✅ GTFS パース完了\n');
}

function parseGtfsFile(filePath, label) {
  const records = parse(fs.readFileSync(filePath, 'utf-8'), {
    bom: true,
    columns: true,
  });
  console.log(`  - ${label}: 入力 ${records.length} 行`);

  if (records.length === 0) {
    throw new Error(`${label} の入力行数が0件です`);
  }

  return records;
}

/**
 * 各事業者のGTFSをパース
 */
async function processOperator(operator, operatorDir, aggregated) {
  const stats = { inputRows: 0, generatedRecords: 0 };

  try {
    // CSVファイルパス
    const stopsPath = path.join(operatorDir, 'stops.txt');
    const routesPath = path.join(operatorDir, 'routes.txt');
    const fareAttributesPath = path.join(operatorDir, 'fare_attributes.txt');
    const fareRulesPath = path.join(operatorDir, 'fare_rules.txt');
    const stopTimesPath = path.join(operatorDir, 'stop_times.txt');
    const tripsPath = path.join(operatorDir, 'trips.txt');

    // 1. stops.txt をパース
    let operatorStops = [];
    if (fs.existsSync(stopsPath)) {
      operatorStops = parseGtfsFile(stopsPath, 'stops.txt');
      stats.inputRows += operatorStops.length;

      for (const stop of operatorStops) {
        aggregated.stops[stop.stop_id] = {
          stop_id: stop.stop_id,
          stop_name: stop.stop_name,
          stop_lat: parseFloat(stop.stop_lat),
          stop_lon: parseFloat(stop.stop_lon),
          zone_id: stop.zone_id || null,
          parent_station: stop.parent_station || null,
          operator_id: operator.id,
        };
      }

      stats.generatedRecords += operatorStops.length;
      console.log(`    生成レコード: ${operatorStops.length} 駅`);
    }

    // 2. routes.txt をパース
    if (fs.existsSync(routesPath)) {
      const routes = parseGtfsFile(routesPath, 'routes.txt');
      stats.inputRows += routes.length;

      for (const route of routes) {
        aggregated.routes[route.route_id] = {
          route_id: route.route_id,
          route_short_name: route.route_short_name || '',
          route_long_name: route.route_long_name || '',
          route_type: route.route_type,
          operator_id: operator.id,
        };
      }

      stats.generatedRecords += routes.length;
      console.log(`    生成レコード: ${routes.length} 路線`);
    }

    // 3. fare_rules.txt と fare_attributes.txt をパース（運賃計算用）
    if (fs.existsSync(fareRulesPath) && fs.existsSync(fareAttributesPath)) {
      const fareStats = await processFares(
        operatorDir,
        operator.id,
        aggregated,
        fareAttributesPath,
        fareRulesPath,
        stopTimesPath,
        tripsPath,
        operatorStops
      );
      stats.inputRows += fareStats.inputRows;
      stats.generatedRecords += fareStats.generatedRecords;
    } else {
      console.warn(`  ⚠️  運賃データなし（fare_rules.txt または fare_attributes.txt）`);
    }
    console.log(
      `  - ${operator.name} 集計: 入力 ${stats.inputRows} 行 / 生成 ${stats.generatedRecords} レコード`
    );
    if (stats.inputRows === 0 || stats.generatedRecords === 0) {
      throw new Error(`${operator.name}: パース結果が0件です`);
    }
    return stats;
  } catch (error) {
    console.error(`  ❌ パース失敗: ${error.message}`);
    throw error;
  }
}

/**
 * 運賃データをパース・判定
 */
async function processFares(
  operatorDir,
  operatorId,
  aggregated,
  fareAttributesPath,
  fareRulesPath,
  stopTimesPath,
  tripsPath,
  operatorStops
) {
  const stats = { inputRows: 0, generatedRecords: 0 };

  try {
    const fareAttrs = parseGtfsFile(fareAttributesPath, 'fare_attributes.txt');
    const fareRules = parseGtfsFile(fareRulesPath, 'fare_rules.txt');
    stats.inputRows += fareAttrs.length + fareRules.length;

    // 運賃方式を自動判定
    const isOdTable = fareRules.some(
      (rule) => rule.origin_id && rule.destination_id
    );
    const isUniform = fareRules.some(
      (rule) => rule.route_id && !rule.origin_id && !rule.destination_id
    );

    console.log(
      `  - 運賃方式: ${isOdTable ? 'OD運賃表型' : ''}${isUniform ? '均一運賃型' : ''}${!isOdTable && !isUniform ? '不明' : ''}`
    );

    if (isOdTable) {
      // ===== OD運賃表型 =====
      // fare_rules.txt の origin_id/destination_id は stop_id ではなく zone_id（GTFS仕様）。
      // stops.txt 上では、ホーム単位の子停留所（location_type=0）に zone_id が設定され、
      // 駅代表（location_type=1, parent_station を持たれる側）には設定されない。
      // そのため zone_id → stop_id の変換では、子停留所自身に加えてその parent_station も対象に含める。
      const zoneToStopIds = {};
      for (const stop of operatorStops) {
        if (!stop.zone_id) continue;
        if (!zoneToStopIds[stop.zone_id]) zoneToStopIds[stop.zone_id] = new Set();
        zoneToStopIds[stop.zone_id].add(stop.stop_id);
        if (stop.parent_station) {
          zoneToStopIds[stop.zone_id].add(stop.parent_station);
        }
      }

      let odPairCount = 0;
      let unresolvedZones = new Set();

      for (const rule of fareRules) {
        if (!rule.origin_id || !rule.destination_id) continue;

        const fareId = rule.fare_id;
        const fare = fareAttrs.find((attr) => attr.fare_id === fareId);

        if (!fare) continue;

        const price = parseInt(fare.price, 10);

        const originStopIds = zoneToStopIds[rule.origin_id];
        const destStopIds = zoneToStopIds[rule.destination_id];

        if (!originStopIds) unresolvedZones.add(rule.origin_id);
        if (!destStopIds) unresolvedZones.add(rule.destination_id);
        if (!originStopIds || !destStopIds) continue;

        for (const originStopId of originStopIds) {
          if (!aggregated.od_fares[originStopId]) {
            aggregated.od_fares[originStopId] = {};
          }
          for (const destStopId of destStopIds) {
            if (originStopId === destStopId) continue;
            aggregated.od_fares[originStopId][destStopId] = price;
            odPairCount += 1;
          }
        }
        stats.generatedRecords += 1;
      }

      console.log(`    OD運賃ペア（stop_id展開後）: ${odPairCount}`);
      if (unresolvedZones.size > 0) {
        console.warn(
          `    ⚠️  zone_id を stop_id に解決できなかった件数: ${unresolvedZones.size}（例: ${[...unresolvedZones].slice(0, 5).join(', ')}）`
        );
      }
    }

    if (isUniform) {
      // ===== 均一運賃型 =====
      if (!fs.existsSync(stopTimesPath) || !fs.existsSync(tripsPath)) {
        console.warn(`    ⚠️  stop_times.txt/trips.txt がないため、均一運賃の停留所を取得できません`);
        return;
      }

      const trips = parseGtfsFile(tripsPath, 'trips.txt');
      const stopTimes = parseGtfsFile(stopTimesPath, 'stop_times.txt');
      stats.inputRows += trips.length + stopTimes.length;

      // route_id ごとに停留所を集める
      const routeStops = {};
      for (const trip of trips) {
        if (!routeStops[trip.route_id]) {
          routeStops[trip.route_id] = new Set();
        }
      }

      for (const stopTime of stopTimes) {
        const trip = trips.find((t) => t.trip_id === stopTime.trip_id);
        if (trip && routeStops[trip.route_id]) {
          routeStops[trip.route_id].add(stopTime.stop_id);
        }
      }

      // 運賃を設定
      for (const rule of fareRules) {
        if (!rule.route_id || rule.origin_id || rule.destination_id) continue;

        const fareId = rule.fare_id;
        const fare = fareAttrs.find((attr) => attr.fare_id === fareId);

        if (!fare) continue;

        const price = parseInt(fare.price, 10);
        const stops = Array.from(routeStops[rule.route_id] || []);

        aggregated.bus_fares[rule.route_id] = {
          route_id: rule.route_id,
          fare: price,
          stops: stops,
          operator_id: operatorId,
        };
        stats.generatedRecords += 1;
      }

      console.log(
        `    均一運賃路線: ${Object.keys(aggregated.bus_fares).length}`
      );
    }

    console.log(
      `    運賃データ集計: 入力 ${stats.inputRows} 行 / 生成 ${stats.generatedRecords} レコード`
    );
    return stats;
  } catch (error) {
    console.error(`  ❌ 運賃データパース失敗: ${error.message}`);
    throw error;
  }
}

/**
 * 派生JSONを保存
 */
function saveDerivedData(aggregated) {
  console.log('💾 派生JSONを生成中...\n');

  // 1. fare-lookup-tables.json
  // od_fares は {departure_stop_id: {arrival_stop_id: fare}} のフラット構造（事業者を横断して統合済み）
  const fareLookup = {
    od_fares: aggregated.od_fares,
    bus_fares: aggregated.bus_fares,
  };

  fs.writeFileSync(
    path.join(derivedDir, 'fare-lookup-tables.json'),
    JSON.stringify(fareLookup, null, 2)
  );
  console.log(`✅ fare-lookup-tables.json (${JSON.stringify(fareLookup).length} bytes)`);

  // 2. stops-metadata.json
  const stopsArray = Object.values(aggregated.stops);
  fs.writeFileSync(
    path.join(derivedDir, 'stops-metadata.json'),
    JSON.stringify(stopsArray, null, 2)
  );
  console.log(`✅ stops-metadata.json (${stopsArray.length} 駅)`);

  // 2b. stations-by-name.json
  // プラットフォーム単位で分かれているstop_idを駅名単位に集約。
  // 同じ駅名に複数事業者のstop_idが含まれる場合、それが鉄道⇔バスの乗換拠点になる
  // （例: 「高松築港」に琴電の駅stop_idとことでんバスの停留所stop_idが両方存在）。
  const stationsByName = {};
  for (const stop of stopsArray) {
    if (!stationsByName[stop.stop_name]) {
      stationsByName[stop.stop_name] = {
        stop_name: stop.stop_name,
        stop_lat: stop.stop_lat,
        stop_lon: stop.stop_lon,
        stops: [],
      };
    }
    stationsByName[stop.stop_name].stops.push({
      stop_id: stop.stop_id,
      operator_id: stop.operator_id,
    });
  }
  fs.writeFileSync(
    path.join(derivedDir, 'stations-by-name.json'),
    JSON.stringify(stationsByName, null, 2)
  );
  const transferPoints = Object.values(stationsByName).filter(
    (s) => new Set(s.stops.map((st) => st.operator_id)).size > 1
  ).length;
  console.log(
    `✅ stations-by-name.json (${Object.keys(stationsByName).length} 駅名、うち複数事業者の乗換拠点 ${transferPoints}件)`
  );

  // 3. route-info.json
  fs.writeFileSync(
    path.join(derivedDir, 'route-info.json'),
    JSON.stringify(aggregated.routes, null, 2)
  );
  console.log(
    `✅ route-info.json (${Object.keys(aggregated.routes).length} 路線)`
  );

  // 4. spots-by-station.json（スタブ）
  const spotsByStation = {};
  for (const stopId of Object.keys(aggregated.stops)) {
    spotsByStation[stopId] = [];
  }

  fs.writeFileSync(
    path.join(derivedDir, 'spots-by-station.json'),
    JSON.stringify(spotsByStation, null, 2)
  );
  console.log(`✅ spots-by-station.json (スタブ、generate-spots.json.js で上書き予定)`);
}

// 実行
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  parseAndTransform().catch((error) => {
    console.error('❌ 致命的エラー:', error);
    process.exit(1);
  });
}
