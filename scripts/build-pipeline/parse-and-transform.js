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

  // 実質同一地点だが表記が異なる停留所名を統合（鉄道↔バスの乗換拠点を増やすため）
  mergeDuplicateStationNames(aggregated);

  // 派生JSONを生成
  saveDerivedData(aggregated);

  console.log('✅ GTFS パース完了\n');
}

/** 2点間の距離をメートルで返す（Haversine公式） */
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** 「ことでん」「琴電」「ＪＲ」プレフィックス、「駅」「駅前」サフィックスを除いた基底名 */
function stationBaseName(name) {
  let n = name.replace(/^(ことでん|琴電|ＪＲ)/, '');
  n = n.replace(/(駅前|駅)$/, '');
  return n;
}

/**
 * 実質同一地点なのに表記が異なる停留所名を統合する（例：「伏石」⇔「ことでん伏石駅」）。
 *
 * 【背景】鉄道駅とバス停で名前の付け方が異なるため、同じ場所でも別の停留所名として
 * 扱われ、経路探索・アクセス駅選定の両方で本来の候補（例：鉄道ルート）が
 * 名前の不一致だけで除外されてしまう問題があった。
 *
 * 【統合条件（意図的に厳しくしている）】
 * 1. 基底名（上記プレフィックス/サフィックスを除いた名前）が完全一致すること
 *    （部分一致・包含は使わない＝「東室新町」と「室新町」のような別停留所を
 *    誤って同一視しないため）
 * 2. かつ、実際の座標間の距離が200m以内であること
 *    （基底名が同じでも、離れた場所にある別施設は統合しない。
 *    例：「琴電屋島」「ことでん屋島駅」は40mで統合対象だが、
 *    同じ「屋島」グループの「ＪＲ屋島駅」は約610m離れておりどちらとも
 *    統合されない＝ペア単位で判定するため一部だけ統合できる）
 *
 * 正規名（統合後にどちらの表記を残すか）は、基底名そのままの表記があれば
 * それを優先し、なければ文字数が短い方を採用する。
 */
function mergeDuplicateStationNames(aggregated) {
  const stopsArray = Object.values(aggregated.stops);

  const byBase = new Map();
  for (const stop of stopsArray) {
    const base = stationBaseName(stop.stop_name);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(stop);
  }

  let mergedGroupCount = 0;
  let mergedStopCount = 0;

  for (const [base, group] of byBase.entries()) {
    const distinctNames = [...new Set(group.map((s) => s.stop_name))];
    if (distinctNames.length < 2) continue;

    const byName = new Map();
    for (const stop of group) {
      if (!byName.has(stop.stop_name)) byName.set(stop.stop_name, []);
      byName.get(stop.stop_name).push(stop);
    }
    const centroids = [...byName.entries()].map(([name, stops]) => ({
      name,
      lat: stops.reduce((sum, s) => sum + s.stop_lat, 0) / stops.length,
      lon: stops.reduce((sum, s) => sum + s.stop_lon, 0) / stops.length,
    }));

    // 200m以内のペアのみを辺として連結成分を求める（グループ内の全ペアではなく、
    // ペア単位で判定することで「一部だけ統合」を可能にする）
    const n = centroids.length;
    const adjacency = Array.from({ length: n }, () => new Set());
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const distance = haversineMeters(
          centroids[i].lat, centroids[i].lon, centroids[j].lat, centroids[j].lon
        );
        if (distance <= 200) {
          adjacency[i].add(j);
          adjacency[j].add(i);
        }
      }
    }

    const visited = new Array(n).fill(false);
    for (let start = 0; start < n; start++) {
      if (visited[start]) continue;
      const component = [];
      const queue = [start];
      visited[start] = true;
      while (queue.length > 0) {
        const current = queue.shift();
        component.push(current);
        for (const next of adjacency[current]) {
          if (!visited[next]) {
            visited[next] = true;
            queue.push(next);
          }
        }
      }
      if (component.length < 2) continue; // 統合相手なし

      const namesInComponent = component.map((idx) => centroids[idx].name);
      const canonical =
        namesInComponent.find((name) => name === base) ||
        [...namesInComponent].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
      const aliases = namesInComponent.filter((name) => name !== canonical);

      for (const stop of group) {
        if (aliases.includes(stop.stop_name)) {
          console.log(`    🔗 停留所名統合: ${stop.stop_name} → ${canonical} (${stop.stop_id}, ${stop.operator_id})`);
          stop.stop_name = canonical;
          mergedStopCount += 1;
        }
      }
      mergedGroupCount += 1;
    }
  }

  console.log(`  - 統合した停留所名グループ: ${mergedGroupCount}件（${mergedStopCount}停留所の表記を統合）`);
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
