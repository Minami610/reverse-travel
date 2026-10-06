/**
 * parse-and-transform.js - GTFS パース・派生JSON生成
 * 
 * 生GTFSファイル（CSVs）を解析し、運賃ルックアップ用の派生JSONを生成
 * 
 * 出力：
 * - fare-lookup-tables.json    : {od_fares: {...}, bus_fares: {...}}
 * - stops-metadata.json        : [{stop_id, stop_name, stop_lat, stop_lon, mode, station_id, ...}]
 * - stations.json              : {station_id: {display_name, stop_lat, stop_lon, stops:[...]}}
 * - route-info.json            : {route_id: {route_short_name, ...}}
 */

import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { fileURLToPath } from 'url';
import { namespacedId } from './gtfs-id.js';
import { buildMunicipalityPolygonFinder } from './municipality-polygon-lookup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// パス定義（デフォルト。build-prefecture.js経由ではoptionsで上書きされる）
const dataDir = path.join(__dirname, '../../data');
const defaultRawGtfsDir = path.join(dataDir, 'raw-gtfs');
const defaultDerivedDir = path.join(dataDir, 'derived');
const configPath = path.join(__dirname, '../../config/target-operators.json');

/**
 * GTFS パース・派生JSON生成のメイン処理
 * @param {{operators?: Array, rawGtfsDir?: string, outputDir?: string}} options
 *   operators/rawGtfsDir/outputDir省略時は従来どおりconfig/target-operators.jsonと
 *   data/raw-gtfs・data/derivedを使う（fetch-and-build.jsの挙動を変えないため）。
 */
export async function parseAndTransform(options = {}) {
  console.log('🔄 GTFS パース開始...\n');

  const operators = options.operators
    || JSON.parse(fs.readFileSync(configPath, 'utf-8')).phase1_operators;
  const rawGtfsDir = options.rawGtfsDir || defaultRawGtfsDir;
  const outputDir = options.outputDir || defaultDerivedDir;
  const prefCode = options.prefCode || null;

  // 出力ディレクトリ作成
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

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
  for (const operator of operators) {
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

  // 駅名文字列ではなく安定したIDで駅をまとめる（同名かつ近接のときだけ1駅とみなす）
  const operatorIdToName = new Map(operators.map((op) => [op.id, op.name]));
  const findMunicipality = await loadMunicipalityFinder(prefCode);
  const stationClusters = buildStationClusters(aggregated, operatorIdToName, findMunicipality);

  // 派生JSONを生成
  const stats = saveDerivedData(aggregated, stationClusters, outputDir);

  console.log('✅ GTFS パース完了\n');
  return stats;
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

/**
 * 「ことでん」「琴電」「ＪＲ」プレフィックス、「駅」「駅前」サフィックスを除いた基底名。
 *
 * 【2026-10-06追記】「N番のりば」（全角・半角の数字の両方）を末尾に持つ停留所名が
 * あり、これを先に取り除かないと「高岡駅前3番のりば」が「高岡駅前」「高岡駅」
 * （加越能バス一般路線の別の停留所）と同じ基底名にならず、mergeDuplicateStationNames()
 * による統合（＝同じ駅としてまとめる）が働かなかった。実際に富山で、
 * 「高岡駅前」（stop 101_10）がfare_rules上は行き先専用（destinationとしてのみ登場、
 * originとしては0件）、実際に出発できるのは別名の「高岡駅前3番のりば」等（stop
 * 1013_03等）という食い違いがあり、「高岡駅」を選んでも加越能バスでは出発できない
 * 状態になっていた（新高岡駅・高岡駅南口でも同様）。
 */
function stationBaseName(name) {
  let n = name.replace(/[0-9０-９]+番のりば$/, '');
  n = n.replace(/^(ことでん|琴電|ＪＲ)/, '');
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

      // 【2026-10-07修正】「末広町3番のりば」のように、基底名(base)と完全一致する
      // 表記（「末広町」）がクラスタ内に存在しない場合、以前はフォールバックの
      // 「最短の名前」がそのまま採用され、「N番のりば」付きの名前が表示名として
      // 残ってしまっていた（Minamiさんが公開ページで発見）。基底名そのものに
      // 駅・駅前を付けた表記（「末広町駅」「末広町駅前」）があればそれを優先し、
      // どれも無い場合だけ「最短の名前」から「N番のりば」を取り除いて使う。
      const namesInComponent = component.map((idx) => centroids[idx].name);
      const canonical =
        namesInComponent.find((name) => name === base) ||
        namesInComponent.find((name) => name === `${base}駅`) ||
        namesInComponent.find((name) => name === `${base}駅前`) ||
        [...namesInComponent].sort((a, b) => a.length - b.length || a.localeCompare(b))[0].replace(/[0-9０-９]+番のりば$/, '');
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

// 同名かつこの距離（メートル）以内のときだけ1駅とみなす（単連結・single-link）。
// 【根拠】香川で現在1つの駅として扱われているグループの中で最大の広がりは
// 春日川駅（鉄道3停留所＋バス2停留所、最大821.6m）。この値を下回ると香川の
// 既存駅が分裂するため、安全マージンを見て1000mに設定した。
// 一方、富山・石川の候補9フィードで見つかった「別の町の同名停留所」は
// 最短でも数km、大半は数十km離れており、1000mなら確実に誤結合を防げる。
//
// 【直径の上限（同じ値を使う）】単連結クラスタリングは「A-Bが900m、B-Cが900m」
// のような連鎖で、1.8km離れたAとCを同じ駅にしてしまう（同名の停留所が多い
// 都市部の「駅前」「市役所前」等で起きうる）。このクラスタの実際の直径
// （全ペア間の最大距離）がこの閾値を超えていたら、後段のsplitClusterByDiameter()
// で分割する。閾値を分けなかったのは、「離れていても同名ならまとめてよい距離」と
// 「そもそも別駅とみなすべき距離」を別々の値にする根拠がないため。
const STATION_CLUSTER_THRESHOLD_METERS = 1000;

/** クラスタ内の全ペア間の最大距離（直径、メートル） */
function clusterDiameterMeters(stops) {
  let max = 0;
  for (let i = 0; i < stops.length; i++) {
    for (let j = i + 1; j < stops.length; j++) {
      const d = haversineMeters(stops[i].stop_lat, stops[i].stop_lon, stops[j].stop_lat, stops[j].stop_lon);
      if (d > max) max = d;
    }
  }
  return max;
}

/**
 * クラスタの直径が閾値を超えていたら、直径の両端点（最も離れた2停留所）を
 * 種として最近傍割り当てで2分割し、それぞれについて直径が閾値以下になるまで
 * 再帰する（決定的：種は「最大距離を与える点対」という一意の基準で選ぶ）。
 * 単連結クラスタリング（buildStationClusters）が生む「鎖状の分裂した駅」対策。
 */
function splitClusterByDiameter(stops, thresholdMeters) {
  if (stops.length <= 1) return [stops];

  let maxD = 0, pi = 0, pj = 1;
  for (let i = 0; i < stops.length; i++) {
    for (let j = i + 1; j < stops.length; j++) {
      const d = haversineMeters(stops[i].stop_lat, stops[i].stop_lon, stops[j].stop_lat, stops[j].stop_lon);
      if (d > maxD) { maxD = d; pi = i; pj = j; }
    }
  }
  if (maxD <= thresholdMeters) return [stops];

  const seedA = stops[pi];
  const seedB = stops[pj];
  const groupA = [];
  const groupB = [];
  for (const s of stops) {
    const dA = haversineMeters(s.stop_lat, s.stop_lon, seedA.stop_lat, seedA.stop_lon);
    const dB = haversineMeters(s.stop_lat, s.stop_lon, seedB.stop_lat, seedB.stop_lon);
    (dA <= dB ? groupA : groupB).push(s);
  }
  // seedA/seedBはそれぞれ自分自身への距離0で必ず別グループに入るため、
  // groupA/groupBは常に非空かつstops全体の真部分集合になる（再帰は必ず停止する）。
  return [...splitClusterByDiameter(groupA, thresholdMeters), ...splitClusterByDiameter(groupB, thresholdMeters)];
}

/**
 * 都道府県コードから、国土数値情報N03ポリゴン判定の市区町村検索関数を構築する。
 * 【2026-10-02修正】以前はWikidataの市区町村代表座標への最近傍探索だったが、
 * 富山市のように市域が広い自治体では代表点が市街地から離れた場所（南部の山間部）
 * にあり、市中心部の停留所が隣接する小さな自治体に誤判定される実例が出た
 * （例：富山市中心部の「永楽町」「中田」等が隣の舟橋村と誤判定）。さらに
 * Wikidataの母集団には上市町・朝日町の欠落、合併で消滅した旧大山町の残存
 * といった抜け漏れもあった。「代表点に近いか」ではなく「市区町村の境界
 * ポリゴンの中に実際に入っているか」で判定する（municipality-polygon-lookup.js
 * 参照、出典：国土交通省 国土数値情報「行政区域データ」N03）。
 * ネットワーク障害等でN03が取得できない場合はnullを返し、呼び出し側が
 * 事業者名・番号での曖昧さ回避にフォールバックする。
 */
async function loadMunicipalityFinder(prefCode) {
  if (!prefCode) {
    console.warn('    ⚠️  prefCodeが指定されていないため、駅名の曖昧さ回避はN03市区町村判定を使わず事業者名・番号にフォールバックします。');
    return null;
  }
  try {
    return await buildMunicipalityPolygonFinder([prefCode]);
  } catch (error) {
    console.warn(
      `    ⚠️  国土数値情報N03の取得に失敗しました（${error.message}）。駅名の曖昧さ回避は市区町村名を使わず` +
      '事業者名・番号にフォールバックします。'
    );
    return null;
  }
}

/**
 * 駅名文字列だけをキーにするのをやめ、「同名かつ閾値以内の距離」でクラスタリングし、
 * 安定したstation_id（クラスタ内の名前空間化済みstop_idのうち辞書順最小のもの）を
 * 割り当てる。表示名（display_name）は駅名と別に持ち、同名の駅が複数クラスタに
 * 分裂した場合は3段階で曖昧さ回避する：
 *   1. 現存する市区町村名（例：「西町（小松市）」）
 *   2. それでも区別できない場合は運行事業者名（例：「中田（地鉄バス）」）
 *   3. それでも区別できない場合だけ番号
 * 【2026-10-01修正】municipality-locations.jsonは以前「日本の廃止市区町村」も
 * 候補に含んでいたため、1940年に富山市へ合併した「東岩瀬町」のような、今の
 * 利用者には伝わらない地名で曖昧さ回避されることがあった（generate-municipality-
 * table.jsがP576=廃止日を持つ市区町村を除外するよう修正済み。本関数側は
 * 「市区町村名が引けてもそれで一意にならない」ケースへの対応として事業者名の
 * 段を追加した）。
 *
 * 【このクラスタリングが解決する範囲】同一都道府県（＝同一ビルド）内での
 * 同名衝突のみ。stop_id由来の安定IDを使うため、遠く離れた同名停留所が
 * 誤って合体することはない（名前だけがキーだった旧実装の問題は解消済み）。
 * 段階1で本当に注意が必要なのは逆に、県境をまたぐ同一の駅が県ごとに別ビルドで
 * 作られると別々の駅（別々のstation_id）になり、乗換が失われる問題（CLAUDE.md
 * 「データ構造」参照。県をまたぐ駅統合は別途、複数県ロード時の処理として必要）。
 *
 * stop_name が空文字列の停留所（出入口・改札等、乗車できないGTFS要素）は
 * クラスタリング対象から除外する（駅としての意味を持たないため）。
 *
 * @param {object} aggregated
 * @param {Map<string,string>} operatorIdToName - 事業者ID→表示名（曖昧さ回避の第2段で使う）
 * @param {((lat:number, lon:number)=>string|null)|null} findMunicipality - N03ポリゴン判定関数
 *   （loadMunicipalityFinder()参照）。nullなら市区町村名の段をスキップする。
 */
function buildStationClusters(aggregated, operatorIdToName, findMunicipality) {
  let municipalityUnresolvedCount = 0;
  const municipalityUnresolvedSamples = [];

  const stopsArray = Object.values(aggregated.stops);
  const byName = new Map();
  for (const stop of stopsArray) {
    if (!stop.stop_name) continue;
    if (!byName.has(stop.stop_name)) byName.set(stop.stop_name, []);
    byName.get(stop.stop_name).push(stop);
  }

  const clusters = [];
  let splitNameCount = 0;
  let diameterSplitCount = 0;
  const diameters = []; // {name, diameter} 全クラスタ分。ビルドログの上位10件表示用

  for (const [name, group] of byName.entries()) {
    const n = group.length;
    const adjacency = Array.from({ length: n }, () => new Set());
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const distance = haversineMeters(
          group[i].stop_lat, group[i].stop_lon, group[j].stop_lat, group[j].stop_lon
        );
        if (distance <= STATION_CLUSTER_THRESHOLD_METERS) {
          adjacency[i].add(j);
          adjacency[j].add(i);
        }
      }
    }

    const visited = new Array(n).fill(false);
    let singleLinkClusters = [];
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
      singleLinkClusters.push(component.map((idx) => group[idx]));
    }

    // 直径が閾値を超える単連結クラスタ（鎖状の分裂駅）を検出し、分割する
    const finalClusters = [];
    for (const clusterStops of singleLinkClusters) {
      const diameter = clusterDiameterMeters(clusterStops);
      if (diameter > STATION_CLUSTER_THRESHOLD_METERS) {
        diameterSplitCount += 1;
        console.warn(
          `    ⚠️  駅名「${name}」のクラスタ直径が${Math.round(diameter)}mで閾値` +
          `${STATION_CLUSTER_THRESHOLD_METERS}mを超過（鎖状の連結）。分割します。`
        );
        finalClusters.push(...splitClusterByDiameter(clusterStops, STATION_CLUSTER_THRESHOLD_METERS));
      } else {
        finalClusters.push(clusterStops);
      }
    }
    for (const clusterStops of finalClusters) {
      diameters.push({ name, diameter: clusterDiameterMeters(clusterStops) });
    }

    if (finalClusters.length > 1) {
      splitNameCount += 1;
    }

    // 曖昧さ回避：①現存する市区町村名 → ②運行事業者名 → ③番号、の3段階で試す
    const withMeta = finalClusters.map((clusterStops) => {
      const lat = clusterStops.reduce((sum, s) => sum + s.stop_lat, 0) / clusterStops.length;
      const lon = clusterStops.reduce((sum, s) => sum + s.stop_lon, 0) / clusterStops.length;
      const municipality = finalClusters.length > 1 && findMunicipality
        ? findMunicipality(lat, lon)
        : null;
      if (finalClusters.length > 1 && findMunicipality && !municipality) {
        municipalityUnresolvedCount += 1;
        if (municipalityUnresolvedSamples.length < 10) {
          municipalityUnresolvedSamples.push(`${name}(${lat.toFixed(4)},${lon.toFixed(4)})`);
        }
      }
      const operatorIds = new Set(clusterStops.map((s) => s.operator_id));
      // クラスタ内の停留所が単一事業者のときだけ事業者名での区別を試す
      // （複数事業者が混在するクラスタは「事業者名」1つでは区別の意味をなさない）。
      const operatorLabel = operatorIds.size === 1
        ? operatorIdToName?.get([...operatorIds][0]) || null
        : null;
      return { clusterStops, lat, lon, municipality, operatorLabel };
    });
    const municipalityCounts = new Map();
    for (const c of withMeta) {
      if (!c.municipality) continue;
      municipalityCounts.set(c.municipality, (municipalityCounts.get(c.municipality) || 0) + 1);
    }
    const operatorLabelCounts = new Map();
    for (const c of withMeta) {
      if (!c.operatorLabel) continue;
      operatorLabelCounts.set(c.operatorLabel, (operatorLabelCounts.get(c.operatorLabel) || 0) + 1);
    }
    let numberedIndex = 0;
    withMeta.forEach(({ clusterStops, lat, lon, municipality, operatorLabel }) => {
      let displayName = name;
      if (finalClusters.length > 1) {
        if (municipality && municipalityCounts.get(municipality) === 1) {
          displayName = `${name}（${municipality}）`;
        } else if (operatorLabel && operatorLabelCounts.get(operatorLabel) === 1) {
          displayName = `${name}（${operatorLabel}）`;
        } else {
          numberedIndex += 1;
          displayName = `${name}（${numberedIndex}）`;
        }
        console.warn(`       → 表示名: ${displayName}`);
      }

      const stationId = [...clusterStops].map((s) => s.stop_id).sort()[0];
      for (const stop of clusterStops) {
        stop.station_id = stationId;
      }

      clusters.push({
        station_id: stationId,
        display_name: displayName,
        stop_lat: lat,
        stop_lon: lon,
        stops: clusterStops,
      });
    });
  }

  console.log(
    `  - 駅クラスタリング: ${byName.size}駅名 → ${clusters.length}駅` +
    `（分裂した駅名: ${splitNameCount}件、うち直径超過による分割: ${diameterSplitCount}件）`
  );
  if (findMunicipality && municipalityUnresolvedCount > 0) {
    console.log(
      `  - N03のどのポリゴンにも入らなかった停留所クラスタ: ${municipalityUnresolvedCount}件` +
      `（例: ${municipalityUnresolvedSamples.join('、')}）`
    );
  }

  // 各県のビルドで、クラスタ直径の最大値と上位10件をログに出す（B-8）
  const multiStopDiameters = diameters.filter((d) => d.diameter > 0).sort((a, b) => b.diameter - a.diameter);
  if (multiStopDiameters.length > 0) {
    console.log(`  - クラスタ直径の最大値: ${Math.round(multiStopDiameters[0].diameter)}m（${multiStopDiameters[0].name}）`);
    console.log('  - クラスタ直径 上位10件:');
    for (const d of multiStopDiameters.slice(0, 10)) {
      console.log(`      ${d.name}: ${Math.round(d.diameter)}m`);
    }
  }

  return clusters;
}

// GTFSのroute_type: 0=路面電車, 1=地下鉄, 2=鉄道 → 「鉄道系」として扱う。3=バス。
const RAIL_ROUTE_TYPES = new Set([0, 1, 2]);
const BUS_ROUTE_TYPE = 3;

/**
 * 停留所ごとに「鉄道系route_typeの便が来るか／バスの便が来るか」を判定し、
 * aggregated.stops の各エントリに mode（'rail'|'bus'|'mixed'|null）を付与する。
 *
 * 【なぜ事業者単位ではなく停留所単位か】fare-calculator.jsは以前
 * RAIL_OPERATOR_ID='kotoden'/BUS_OPERATOR_ID='kotoden-bus' という事業者IDの
 * 固定値で「乗換の起点は鉄道駅、終点はバス停」を判定していた。これは
 * 事業者ごとに単一モードの香川（ことでん=鉄道専業、ことでんバス=バス専業）
 * でしか成立せず、鉄道とバスの両方を運行する事業者（例：富山地方鉄道）や、
 * 1つのGTFSフィード内にroute_typeが混在するケースで破綻する。
 * route_typeは「その便がどの種別の路線を走るか」の実データなので、
 * 停留所ごとに「その停留所に実際に来る便の種別」を集計する方が正確。
 */
function classifyStopModes(operator, operatorDir, aggregated) {
  const routesPath = path.join(operatorDir, 'routes.txt');
  const tripsPath = path.join(operatorDir, 'trips.txt');
  const stopTimesPath = path.join(operatorDir, 'stop_times.txt');
  if (!fs.existsSync(routesPath) || !fs.existsSync(tripsPath) || !fs.existsSync(stopTimesPath)) {
    console.warn(`  ⚠️  ${operator.name}: routes.txt/trips.txt/stop_times.txtが揃わずモード判定をスキップ`);
    return;
  }

  const routes = parseGtfsFile(routesPath, 'routes.txt（モード判定用）');
  const trips = parseGtfsFile(tripsPath, 'trips.txt（モード判定用）');
  const stopTimes = parseGtfsFile(stopTimesPath, 'stop_times.txt（モード判定用）');

  const routeTypeByRawRouteId = new Map(routes.map((r) => [r.route_id, parseInt(r.route_type, 10)]));
  const tripToRouteType = new Map();
  for (const trip of trips) {
    const type = routeTypeByRawRouteId.get(trip.route_id);
    if (type !== undefined) tripToRouteType.set(trip.trip_id, type);
  }

  const hasRail = new Set();
  const hasBus = new Set();
  for (const st of stopTimes) {
    const type = tripToRouteType.get(st.trip_id);
    if (type === undefined) continue;
    const stopId = namespacedId(operator.id, st.stop_id);
    if (RAIL_ROUTE_TYPES.has(type)) hasRail.add(stopId);
    else if (type === BUS_ROUTE_TYPE) hasBus.add(stopId);
  }

  // 駅の代表stop_id（location_type=1の親、例："○○_駅"）はGTFSの設計上
  // stop_times.txtに直接登場しないことが多く（実際に乗降するのはプラットフォーム
  // 単位の子停留所）、上記だけでは親にmodeが付かない。fare-calculator.jsは
  // od_fares（zone_id経由で親・子どちらのstop_idも登録される）から拾った
  // stop_idでmodeを判定するため、親が未分類のままだと「鉄道駅なのに
  // rail-eligibleと判定されない」事故になる（実測：香川で乗換到達駅が
  // 56駅→0駅に消えた）。子の判定結果を親（parent_station）にも伝播する。
  const classifiedStopIds = [...new Set([...hasRail, ...hasBus])];
  for (const stopId of classifiedStopIds) {
    const stop = aggregated.stops[stopId];
    if (!stop?.parent_station) continue;
    if (hasRail.has(stopId)) hasRail.add(stop.parent_station);
    if (hasBus.has(stopId)) hasBus.add(stop.parent_station);
  }

  let railCount = 0, busCount = 0, mixedCount = 0;
  for (const stopId of new Set([...hasRail, ...hasBus])) {
    const stop = aggregated.stops[stopId];
    if (!stop) continue; // stops.txtに存在しないstop_id（データ不整合）は無視
    const isRail = hasRail.has(stopId);
    const isBus = hasBus.has(stopId);
    stop.mode = isRail && isBus ? 'mixed' : isRail ? 'rail' : 'bus';
    if (stop.mode === 'mixed') mixedCount += 1;
    else if (stop.mode === 'rail') railCount += 1;
    else busCount += 1;
  }
  console.log(`    モード判定: 鉄道系${railCount}件 / バス${busCount}件 / 混在${mixedCount}件`);
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
        const stopId = namespacedId(operator.id, stop.stop_id);
        aggregated.stops[stopId] = {
          stop_id: stopId,
          stop_name: stop.stop_name,
          stop_lat: parseFloat(stop.stop_lat),
          stop_lon: parseFloat(stop.stop_lon),
          zone_id: stop.zone_id || null,
          parent_station: stop.parent_station ? namespacedId(operator.id, stop.parent_station) : null,
          operator_id: operator.id,
          mode: null, // route_typeから後述のclassifyStopModes()が判定して埋める
          station_id: null, // buildStationClusters()が後で埋める
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
        const routeId = namespacedId(operator.id, route.route_id);
        aggregated.routes[routeId] = {
          route_id: routeId,
          route_short_name: route.route_short_name || '',
          route_long_name: route.route_long_name || '',
          route_type: route.route_type,
          operator_id: operator.id,
        };
      }

      stats.generatedRecords += routes.length;
      console.log(`    生成レコード: ${routes.length} 路線`);
    }

    // 2b. 停留所ごとの鉄道／バス判定（route_typeベース、事業者単位の固定値をやめる）
    classifyStopModes(operator, operatorDir, aggregated);

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
        zoneToStopIds[stop.zone_id].add(namespacedId(operatorId, stop.stop_id));
        if (stop.parent_station) {
          zoneToStopIds[stop.zone_id].add(namespacedId(operatorId, stop.parent_station));
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

      // route_id ごとに停留所を集める（route_id/stop_idともに名前空間化する）
      const routeStops = {};
      for (const trip of trips) {
        const routeId = namespacedId(operatorId, trip.route_id);
        if (!routeStops[routeId]) {
          routeStops[routeId] = new Set();
        }
      }

      for (const stopTime of stopTimes) {
        const trip = trips.find((t) => t.trip_id === stopTime.trip_id);
        if (trip) {
          const routeId = namespacedId(operatorId, trip.route_id);
          if (routeStops[routeId]) {
            routeStops[routeId].add(namespacedId(operatorId, stopTime.stop_id));
          }
        }
      }

      // 運賃を設定
      for (const rule of fareRules) {
        if (!rule.route_id || rule.origin_id || rule.destination_id) continue;

        const fareId = rule.fare_id;
        const fare = fareAttrs.find((attr) => attr.fare_id === fareId);

        if (!fare) continue;

        const price = parseInt(fare.price, 10);
        const routeId = namespacedId(operatorId, rule.route_id);
        const stops = Array.from(routeStops[routeId] || []);

        aggregated.bus_fares[routeId] = {
          route_id: routeId,
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
function saveDerivedData(aggregated, stationClusters, outputDir) {
  console.log('💾 派生JSONを生成中...\n');

  // 1. fare-lookup-tables.json
  // od_fares は {departure_stop_id: {arrival_stop_id: fare}} のフラット構造（事業者を横断して統合済み）
  const fareLookup = {
    od_fares: aggregated.od_fares,
    bus_fares: aggregated.bus_fares,
  };

  fs.writeFileSync(
    path.join(outputDir, 'fare-lookup-tables.json'),
    JSON.stringify(fareLookup, null, 2)
  );
  console.log(`✅ fare-lookup-tables.json (${JSON.stringify(fareLookup).length} bytes)`);

  // 2. stops-metadata.json（プラットフォーム単位。station_id/modeが付与済み）
  const stopsArray = Object.values(aggregated.stops);
  fs.writeFileSync(
    path.join(outputDir, 'stops-metadata.json'),
    JSON.stringify(stopsArray, null, 2)
  );
  console.log(`✅ stops-metadata.json (${stopsArray.length} 駅)`);

  // 2b. stations.json（旧stations-by-name.json）
  // キーは駅名ではなくstation_id（buildStationClusters()が割り当てた安定ID）。
  // 駅名文字列はdisplay_nameとしてのみ保持する。同じ駅（station_id）に複数事業者の
  // stop_idが含まれる場合、それが鉄道⇔バスの乗換拠点になる
  // （例: 「高松築港」に琴電の駅stop_idとことでんバスの停留所stop_idが両方存在）。
  const stations = {};
  for (const cluster of stationClusters) {
    stations[cluster.station_id] = {
      display_name: cluster.display_name,
      stop_lat: cluster.stop_lat,
      stop_lon: cluster.stop_lon,
      stops: cluster.stops.map((s) => ({
        stop_id: s.stop_id,
        operator_id: s.operator_id,
        mode: s.mode,
      })),
    };
  }
  fs.writeFileSync(
    path.join(outputDir, 'stations.json'),
    JSON.stringify(stations, null, 2)
  );
  const transferPoints = Object.values(stations).filter(
    (s) => new Set(s.stops.map((st) => st.operator_id)).size > 1
  ).length;
  console.log(
    `✅ stations.json (${Object.keys(stations).length} 駅、うち複数事業者の乗換拠点 ${transferPoints}件)`
  );

  // 3. route-info.json
  fs.writeFileSync(
    path.join(outputDir, 'route-info.json'),
    JSON.stringify(aggregated.routes, null, 2)
  );
  console.log(
    `✅ route-info.json (${Object.keys(aggregated.routes).length} 路線)`
  );

  // 4. spots-by-station.json には触れない。
  // 【2026-09-29】以前はここで空のスタブを書き出し、generateSpots()（旧パイプライン）が
  // 後で上書きする前提だった。しかしgenerateSpots()は劣化データを生成するため無効化した
  // （generate-spots.json.jsのコメント参照）ので、このスタブ書き込みだけが実行され続け、
  // 本番配信中の良いデータ（新パイプライン=generate-spots-by-region.js産）を空データで
  // 無言で上書きしてしまう（実際にこの手順で2度事故った）。
  // スポットデータの生成・更新はgenerate-spots-by-region.jsの責務とし、parse-and-
  // transform.jsはGTFS由来の派生データ（運賃・停留所・路線）だけを扱う。
  console.log('ℹ️  spots-by-station.json は生成しません（generate-spots-by-region.jsの責務）');

  return {
    stopCount: stopsArray.length,
    stationCount: Object.keys(stations).length,
    routeCount: Object.keys(aggregated.routes).length,
    transferPoints,
  };
}

// 実行
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  parseAndTransform().catch((error) => {
    console.error('❌ 致命的エラー:', error);
    process.exit(1);
  });
}
