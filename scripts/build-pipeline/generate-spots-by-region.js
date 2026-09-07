/**
 * generate-spots-by-region.js - 観光スポット情報生成（地域一括取得方式）
 *
 * generate-spots.json.js の「停留所ごとに半径3km検索」方式は、
 * クエリ数が停留所数に比例するため全国規模では非現実的（試算：数日オーダー）。
 * 本モジュールは地域（都道府県など）単位でバウンディングボックス一括検索を行い、
 * 停留所との距離判定はすべてローカルで行うことでWikidataへのクエリ数を
 * 「停留所数」ではなく「地域の分割数」に比例させる。
 *
 * 除外クラスリスト・地図画像フィルタ・サイトリンク方式（Wikipedia全文検索を使わず
 * Wikidataのサイトリンクから直接記事タイトルを得る）は generate-spots.json.js と共通。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  enrichSpotsBatchWithWikipedia,
  calculateDistance,
  isProblematicImage,
} from './generate-spots.json.js';

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * 高速バス等、実在するが他都道府県に所在する停留所（例：高知県の事業者が運行する
 * 「バスタ新宿」「梅田」等の高速バス停留所）をbbox計算から除外する。
 *
 * 【背景】GTFSフィードは feed_pref_id で1つの都道府県に丸ごと割り当てられるが、
 * 高速バスは実際に他県の停留所を含む。これをそのままbbox計算に含めると、
 * 県全体のはずのbboxが日本の広範囲（実測：高知県で東京・大阪まで拡大）に
 * 膨れ上がり、WDQSが確実にタイムアウトする。
 *
 * 【方式】中央値（外れ値に強い）を中心点とし、そこからの距離の90パーセンタイル値の
 * 3倍（最低50km）を閾値とする。都道府県内の停留所は中央値付近に密集するため
 * 90パーセンタイルは小さい値になり、他県の飛び地だけが閾値を大きく超えて弾かれる。
 */
export function filterGeographicOutliers(stops) {
  if (stops.length < 3) return { kept: stops, excluded: [] };

  const medianLat = median(stops.map((s) => s.stop_lat));
  const medianLon = median(stops.map((s) => s.stop_lon));
  const distances = stops.map((s) => calculateDistance(medianLat, medianLon, s.stop_lat, s.stop_lon));
  const sortedDist = [...distances].sort((a, b) => a - b);
  const p90 = sortedDist[Math.floor(sortedDist.length * 0.9)];
  const threshold = Math.max(p90 * 3, 50);

  const kept = [];
  const excluded = [];
  stops.forEach((s, i) => {
    (distances[i] <= threshold ? kept : excluded).push(s);
  });
  return { kept, excluded, medianLat, medianLon, threshold };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const spotConfigPath = path.join(__dirname, '../../config/spot-config.json');
const spotConfig = JSON.parse(fs.readFileSync(spotConfigPath, 'utf-8'));
const excludedClassQids = spotConfig.excluded_classes.qids
  .map((qid) => `wd:${qid}`)
  .join(' ');
const protectedClassQids = (spotConfig.protected_classes?.qids || [])
  .map((qid) => `wd:${qid}`)
  .join(' ');
const individualOverrideQids = (spotConfig.individual_overrides?.qids || []).map((entry) => entry.qid);
const individualOverrideValues = individualOverrideQids.map((qid) => `wd:${qid}`).join(', ');
const guardTestApprovedConflicts = spotConfig.guard_test_approved_conflicts?.entries || [];
const noiseFilterQidSet = new Set(
  (spotConfig.suspicious_exclusion_noise_filter?.qids || []).map((entry) => entry.qid)
);

const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
const WIKIDATA_USER_AGENT =
  'reverse-travel/0.1.0 (contact: reverse-travel-maintainer)';

// 市区町村→都道府県 対応表（scripts/build-pipeline/generate-municipality-table.js で生成）。
// 未生成の場合はnullのまま扱い、resolvePrefecture()は常にフォールバックを返す。
const municipalityTablePath = path.join(
  __dirname,
  '../../data/derived/national/municipality-to-pref.json'
);
const municipalityTable = fs.existsSync(municipalityTablePath)
  ? JSON.parse(fs.readFileSync(municipalityTablePath, 'utf-8'))
  : null;

/**
 * P131の1〜2ホップ先の地名ラベルから都道府県を判定する。
 *
 * 【背景】bboxクエリのP131は直接値のみ（非再帰）で取得している。実測（富山県、
 * 1,379件）では、直接P131が都道府県そのものなのは7.5%、市区町村名として
 * 解決できるのが74.8%、町丁・大字など市区町村より下位の粒度（例:
 * 「石引」金沢市内の町丁）が5.4%、P131自体が0件が12.4%だった。
 * 町丁レベルの5.4%は市区町村テーブルでは解決できないが、そのP131をもう1段
 * 辿れば市区町村に到達する（石引→金沢市）ため、hop2まで見ることで
 * フォールバック率を17.8%（5.4%+12.4%）から12.4%まで下げられる。
 *
 * @returns {{ pref: string|null, hops: 0|1|2|null }}
 *   hops=0: P131自体が都道府県そのもの
 *   hops=1: P131（1段目）が市区町村テーブルで解決
 *   hops=2: P131の1段目が町丁等で不明、2段目で市区町村テーブルにより解決
 *   pref=null: いずれも解決できず、呼び出し側でbboxベースにフォールバックする
 */
export function resolvePrefecture(item) {
  const PREF_NAME_SET = new Set([
    '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
    '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
    '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
    '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
    '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
    '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
    '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
  ]);

  for (const label of item.loc1Labels || []) {
    if (PREF_NAME_SET.has(label)) return { pref: label, hops: 0 };
  }
  if (municipalityTable) {
    for (const label of item.loc1Labels || []) {
      if (municipalityTable[label]) return { pref: municipalityTable[label], hops: 1 };
    }
    for (const label of item.loc2Labels || []) {
      if (municipalityTable[label]) return { pref: municipalityTable[label], hops: 2 };
    }
  }
  return { pref: null, hops: null };
}

// WDQSのサーバー側クエリタイムアウトは60秒。それより長めに取り、
// 純粋なネットワーク/クライアント都合のタイムアウトと区別する。
const BOX_QUERY_TIMEOUT_MS = 70000;
const BOX_QUERY_MAX_RETRIES = 2; // 分割前に同じ範囲で最大2回リトライ（WDQS側の負荷変動対策）
const BOX_QUERY_RETRY_BACKOFF_MS = [5000, 15000];
const MAX_SPLIT_DEPTH = 4; // 4回分割＝最大256分割で打ち切り
const SIBLING_QUERY_INTERVAL_MS = 800; // 兄弟クエリ間の間隔（WDQSへの配慮）
// WDQSの応答時間は日によって変動する（同じクエリが1回目504・2回目26秒等）。
// 成功しても40秒を超えた範囲は「今回はたまたま間に合っただけ」とみなし、
// 一度きりのバッチの安定性を優先して予防的に分割する。
const SLOW_RESPONSE_THRESHOLD_MS = 40000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 停留所群からバウンディングボックスを計算する（検索半径分のバッファ込み）。
 */
export function computeBoundingBox(stops, radiusKm) {
  const lats = stops.map((s) => s.stop_lat);
  const lons = stops.map((s) => s.stop_lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const centerLatRad = (((minLat + maxLat) / 2) * Math.PI) / 180;

  const latBuffer = radiusKm / 111;
  const lonBuffer = radiusKm / (111 * Math.cos(centerLatRad));

  return {
    west: minLon - lonBuffer,
    east: maxLon + lonBuffer,
    south: minLat - latBuffer,
    north: maxLat + latBuffer,
  };
}

function splitBboxInto4(bbox) {
  const midLon = (bbox.west + bbox.east) / 2;
  const midLat = (bbox.south + bbox.north) / 2;
  return [
    { west: bbox.west, east: midLon, south: bbox.south, north: midLat },
    { west: midLon, east: bbox.east, south: bbox.south, north: midLat },
    { west: bbox.west, east: midLon, south: midLat, north: bbox.north },
    { west: midLon, east: bbox.east, south: midLat, north: bbox.north },
  ];
}

// SPARQLのクエリ本文で共通する部分（bbox指定・sitelinks・記事存在・Categoryページ除外・ja label）
function boxQueryCommonPattern(bbox) {
  return `
      SERVICE wikibase:box {
        ?item wdt:P625 ?coordinate.
        bd:serviceParam wikibase:cornerWest "Point(${bbox.west} ${bbox.south})"^^geo:wktLiteral;
          wikibase:cornerEast "Point(${bbox.east} ${bbox.north})"^^geo:wktLiteral.
      }
      ?item wikibase:sitelinks ?sitelinks.
      ?article schema:about ?item;
        schema:isPartOf <https://ja.wikipedia.org/>.
      FILTER NOT EXISTS {
        ?item wdt:P31 ?anyClass.
        ?anyClass rdfs:label ?anyClassLabel.
        FILTER (LANG(?anyClassLabel) = "en" && STRSTARTS(?anyClassLabel, "Category:"))
      }
      ?item rdfs:label ?itemLabel.
      FILTER (LANG(?itemLabel) = "ja")
      OPTIONAL { ?item wdt:P18 ?image. }
      OPTIONAL { ?item wdt:P31 ?instanceOf. }
      OPTIONAL {
        ?item wdt:P131 ?loc1.
        ?loc1 rdfs:label ?loc1Label. FILTER(LANG(?loc1Label) = "ja")
        OPTIONAL {
          ?loc1 wdt:P131 ?loc2.
          ?loc2 rdfs:label ?loc2Label. FILTER(LANG(?loc2Label) = "ja")
        }
      }
  `;
}

const QUERY_PREFIXES = `
    PREFIX bd: <http://www.bigdata.com/rdf#>
    PREFIX geo: <http://www.opengis.net/ont/geosparql#>
    PREFIX wdt: <http://www.wikidata.org/prop/direct/>
    PREFIX wikibase: <http://wikiba.se/ontology#>
    PREFIX schema: <http://schema.org/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    PREFIX wd: <http://www.wikidata.org/entity/>
`;

/**
 * 実際に採用するスポット一覧を取得するクエリ（本番用）。
 *
 * ?coordinate/?image/?article/?instanceOfはWikidata上で多値になりうるため、
 * GROUP BYで?itemに集約しGROUP_CONCATで全候補を持たせる。値の採用（座標1件・
 * 画像1件への決定）はSPARQL側のSAMPLE()（非決定的）ではなく、パース後にJS側で
 * 決定的なルール（緯度→経度昇順、画像URL文字列昇順）で行う。同じ入力から
 * 必ず同じ出力を得るため（ビルドのたびに採用座標がぶれるとdiffが汚れる問題の対策）。
 *
 * 除外は「除外クラスに該当し、かつ守護クラスに該当しない」場合のみ行う
 * （protected_classesが除外に優先する）。ビルド時ガードテストはクラス階層同士の
 * 静的な矛盾（発電所×発電用ダム等）しか検出できず、個別インスタンスが除外クラスと
 * 守護クラスを両方持つ実データ側の混在（実測: 富山県で「砂子坂道場」が仏教寺院＝守護
 * かつ日本の城経由で行政区画＝除外に該当、「富崎千里古墳群」が古墳＝守護かつ
 * 考古学＝除外に該当、計7件）は検出できない。この優先順位により、そうした
 * インスタンス単位の混在があっても守護クラス側が自動的に生き残る。
 */
function buildBoxQuery(bbox) {
  const individualOverrideClause =
    individualOverrideQids.length > 0 ? `|| ?item IN (${individualOverrideValues})` : '';
  return `
    ${QUERY_PREFIXES}
    SELECT ?item ?itemLabel ?sitelinks
      (GROUP_CONCAT(DISTINCT ?coordinate; separator="|") AS ?coordinates)
      (GROUP_CONCAT(DISTINCT ?image; separator="|") AS ?images)
      (GROUP_CONCAT(DISTINCT ?article; separator="|") AS ?articles)
      (GROUP_CONCAT(DISTINCT ?instanceOf; separator="|") AS ?instanceOfs)
      (GROUP_CONCAT(DISTINCT ?loc1Label; separator="|") AS ?loc1Labels)
      (GROUP_CONCAT(DISTINCT ?loc2Label; separator="|") AS ?loc2Labels)
    WHERE {
      ${boxQueryCommonPattern(bbox)}
      FILTER (
        !EXISTS {
          ?item wdt:P31/wdt:P279* ?excludedType.
          VALUES ?excludedType { ${excludedClassQids} }
        }
        ||
        EXISTS {
          ?item wdt:P31/wdt:P279* ?protectedType.
          VALUES ?protectedType { ${protectedClassQids} }
        }
        ${individualOverrideClause}
      )
    }
    GROUP BY ?item ?itemLabel ?sitelinks
  `;
}

/**
 * 除外集計・ガード検証ログ用に「本来なら除外されたはずの項目」を取得するクエリ。
 * buildBoxQuery()とeligibility条件（bbox・sitelinks・記事存在・Categoryページ除外）は
 * 完全に揃え、クラス除外条件だけをNOT EXISTS→EXISTSに反転する。守護クラス・個別許可に
 * 該当するものはbuildBoxQuery()側で既に採用（kept）されているため、ここでは除外する
 * （kept/excludedが互いに排他的な集合になるようにするため）。
 * どの除外指定QIDにマッチしたかもGROUP_CONCATで持たせ、除外理由の内訳を出せるようにする。
 *
 * suspiciousOnly: 「観光地らしいのに除外されている疑いが強い」項目だけに絞る追加条件
 * （記事＋画像＋sitelinks>=3）。駅・行政区画・大学等の具体的サブクラス
 * （config: suspicious_exclusion_noise_filter）は意図通り除外されているだけで
 * ノイズになるため、ここでは絞り込まずJS側（filterOutKnownNoise）でノイズ除去前後の
 * 件数を両方ログに残す。
 */
function buildExcludedItemsQuery(bbox, { suspiciousOnly = false } = {}) {
  const individualOverrideExclusion =
    individualOverrideQids.length > 0
      ? `FILTER (?item NOT IN (${individualOverrideValues}))`
      : '';
  const suspiciousFilter = suspiciousOnly
    ? `
      FILTER EXISTS { ?item wdt:P18 ?anyImage. }
      FILTER (?sitelinks >= 3)
    `
    : '';
  return `
    ${QUERY_PREFIXES}
    SELECT ?item ?itemLabel ?sitelinks
      (GROUP_CONCAT(DISTINCT ?instanceOf; separator="|") AS ?instanceOfs)
      (GROUP_CONCAT(DISTINCT ?excludedType; separator="|") AS ?matchedExcludedTypes)
    WHERE {
      ${boxQueryCommonPattern(bbox)}
      ?item wdt:P31/wdt:P279* ?excludedType.
      VALUES ?excludedType { ${excludedClassQids} }
      FILTER NOT EXISTS {
        ?item wdt:P31/wdt:P279* ?protectedType.
        VALUES ?protectedType { ${protectedClassQids} }
      }
      ${individualOverrideExclusion}
      ${suspiciousFilter}
    }
    GROUP BY ?item ?itemLabel ?sitelinks
  `;
}

function splitConcat(value) {
  return value ? value.split('|').filter(Boolean) : [];
}

function qidFromUri(uri) {
  return uri.split('/').pop();
}

/**
 * GROUP_CONCATで集約された座標候補（複数ありうる）から、決定的に1件を選ぶ。
 * 緯度→経度の昇順でソートし先頭を採用する。順序規則そのものに意味はないが、
 * 同じ入力に対して常に同じ座標を選ぶことが目的（実測: 富山県で医王山が
 * 約1km離れた2座標を持ち、非決定的な選択だとビルドのたびに採用座標が変わっていた）。
 */
function pickCoordinateDeterministic(coordinateStrings) {
  const parsed = [];
  for (const value of coordinateStrings) {
    const match = value.match(/Point\(([^ ]+) ([^ ]+)\)/);
    if (match) parsed.push({ longitude: parseFloat(match[1]), latitude: parseFloat(match[2]) });
  }
  if (parsed.length === 0) return { latitude: null, longitude: null };
  parsed.sort((a, b) => a.latitude - b.latitude || a.longitude - b.longitude);
  return parsed[0];
}

/**
 * GROUP_CONCATで集約された画像候補（複数ありうる）から、決定的に1件を選ぶ。
 * 問題画像（位置図・汎用アイコン等）を除いた上で、画像URL文字列の昇順で
 * 先頭を採用する（実測: 富山県のクロスランドおやべが画像3枚を持っていた）。
 */
function pickImageDeterministic(imageStrings) {
  const candidates = imageStrings.filter((url) => !isProblematicImage(url)).sort();
  return candidates.length > 0 ? candidates[0] : null;
}

/**
 * bboxクエリの結果（?itemでGROUP BY済み、多値プロパティはGROUP_CONCAT済み）をパースする。
 */
function parseBoxResultItems(bindings) {
  const items = [];
  for (const binding of bindings) {
    const qid = qidFromUri(binding.item.value);
    const { latitude, longitude } = pickCoordinateDeterministic(splitConcat(binding.coordinates?.value));
    const image = pickImageDeterministic(splitConcat(binding.images?.value));
    const articles = splitConcat(binding.articles?.value).sort();
    const instanceOfQids = splitConcat(binding.instanceOfs?.value).map(qidFromUri);
    const loc1Labels = splitConcat(binding.loc1Labels?.value);
    const loc2Labels = splitConcat(binding.loc2Labels?.value);

    items.push({
      id: qid,
      name: binding.itemLabel?.value || '（名称不明）',
      wikidata_url: binding.item.value,
      wikipedia_url: articles.length > 0 ? articles[0] : null,
      image,
      sitelinks: binding.sitelinks?.value ? parseInt(binding.sitelinks.value, 10) : null,
      instanceOfQids,
      loc1Labels,
      loc2Labels,
      latitude,
      longitude,
    });
  }
  return items;
}

/**
 * buildExcludedItemsQuery()の結果（除外ログ・ガード検証用）をパースする。
 */
function parseExcludedItems(bindings) {
  return bindings.map((binding) => ({
    id: qidFromUri(binding.item.value),
    name: binding.itemLabel?.value || '（名称不明）',
    sitelinks: binding.sitelinks?.value ? parseInt(binding.sitelinks.value, 10) : null,
    instanceOfQids: [...new Set(splitConcat(binding.instanceOfs?.value).map(qidFromUri))],
    matchedExcludedQids: [...new Set(splitConcat(binding.matchedExcludedTypes?.value).map(qidFromUri))],
  }));
}

/**
 * 1回分のbboxクエリをリトライ付きで実行する。
 * タイムアウト/5xxはリトライ対象。リトライを使い切っても失敗した場合は ok:false を返す
 * （呼び出し側で分割にエスカレーションする）。
 */
async function fetchBoxQueryWithRetry(bbox) {
  for (let attempt = 0; attempt <= BOX_QUERY_MAX_RETRIES; attempt += 1) {
    const query = buildBoxQuery(bbox);
    const params = new URLSearchParams({ query, format: 'json' });
    const url = `${WIKIDATA_SPARQL}?${params}`;
    const t0 = Date.now();
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/sparql-results+json',
          'User-Agent': WIKIDATA_USER_AGENT,
        },
        signal: AbortSignal.timeout(BOX_QUERY_TIMEOUT_MS),
      });
      const bodyText = await response.text();
      const elapsedMs = Date.now() - t0;
      const retryableStatus = [429, 500, 502, 503, 504].includes(response.status);
      if (response.ok) {
        const data = JSON.parse(bodyText);
        return { ok: true, elapsedMs, items: parseBoxResultItems(data.results?.bindings || []) };
      }
      if (!retryableStatus || attempt === BOX_QUERY_MAX_RETRIES) {
        return { ok: false, reason: `HTTP ${response.status}` };
      }
      console.warn(
        `    ⚠️  WDQS ${response.status}（${BOX_QUERY_RETRY_BACKOFF_MS[attempt]}ms 待機後にリトライ ${attempt + 1}/${BOX_QUERY_MAX_RETRIES}）`
      );
      await sleep(BOX_QUERY_RETRY_BACKOFF_MS[attempt]);
    } catch (error) {
      if (attempt === BOX_QUERY_MAX_RETRIES) {
        return { ok: false, reason: error.message };
      }
      console.warn(
        `    ⚠️  WDQS ${error.name}（${BOX_QUERY_RETRY_BACKOFF_MS[attempt]}ms 待機後にリトライ ${attempt + 1}/${BOX_QUERY_MAX_RETRIES}）: ${error.message}`
      );
      await sleep(BOX_QUERY_RETRY_BACKOFF_MS[attempt]);
    }
  }
  return { ok: false, reason: 'unreachable' };
}

let guardsVerified = false;

/**
 * ビルド時ガードテスト。excluded_classes.qidsの各QIDについて、
 * protected_classes.qidsのいずれかがそのP279*下位クラスになっていないかを検証する。
 * 1件でも該当すればビルドを停止する（発電所×発電用ダムのような、除外リストへの
 * 追加が意図せず観光資源を巻き込む事故を機械的に防ぐ）。プロセス内で一度だけ実行する。
 */
export async function verifyExclusionGuards() {
  if (guardsVerified) return;

  const excludedQids = spotConfig.excluded_classes.qids;
  const protectedQids = spotConfig.protected_classes?.qids || [];
  if (protectedQids.length === 0) {
    console.warn('⚠️  protected_classes が空のため、ガードテストをスキップします');
    guardsVerified = true;
    return;
  }
  const protectedValues = protectedQids.map((q) => `wd:${q}`).join(' ');

  console.log(`🛡️  ガードテスト実行中... (除外QID${excludedQids.length}件 × 守護QID${protectedQids.length}件)`);
  const GUARD_QUERY_MAX_RETRIES = 3;
  const conflicts = [];
  for (const excludedQid of excludedQids) {
    const query = `
      PREFIX wdt: <http://www.wikidata.org/prop/direct/>
      PREFIX wd: <http://www.wikidata.org/entity/>
      SELECT ?guard WHERE {
        VALUES ?guard { ${protectedValues} }
        ?guard wdt:P279* wd:${excludedQid}.
      }
    `;
    const params = new URLSearchParams({ query, format: 'json' });

    let data = null;
    for (let attempt = 0; attempt <= GUARD_QUERY_MAX_RETRIES; attempt += 1) {
      try {
        const response = await fetch(`${WIKIDATA_SPARQL}?${params}`, {
          headers: { Accept: 'application/sparql-results+json', 'User-Agent': WIKIDATA_USER_AGENT },
          signal: AbortSignal.timeout(30000),
        });
        if (response.ok) {
          data = await response.json();
          break;
        }
        if (attempt === GUARD_QUERY_MAX_RETRIES) {
          throw new Error(`ガードテストのクエリに失敗しました: HTTP ${response.status}（excludedQid=${excludedQid}）`);
        }
      } catch (error) {
        if (attempt === GUARD_QUERY_MAX_RETRIES) {
          throw new Error(`ガードテストのクエリに失敗しました: ${error.message}（excludedQid=${excludedQid}）`);
        }
        console.warn(`   ⚠️  ガードテスト ${error.message}（${excludedQid}）: リトライ ${attempt + 1}/${GUARD_QUERY_MAX_RETRIES}`);
        await sleep(3000 * (attempt + 1));
      }
    }
    for (const binding of data.results.bindings) {
      conflicts.push({ excludedQid, guardQid: qidFromUri(binding.guard.value) });
    }
    await sleep(300); // WDQSへの配慮
  }

  // lintのベースラインと同じ考え方: 承認済み（config: guard_test_approved_conflicts）の
  // 組み合わせは情報ログのみで続行し、未承認の新規衝突だけをエラーで停止する。
  // 承認の前提は「除外優先ルール（除外クラスに該当し、かつ守護クラスに該当しない
  // 場合のみ除外）によりデータ上は守護クラス側が保護される」ことなので、
  // そのルール自体を変更する場合はguard_test_approved_conflictsを全件再検証すること。
  const approvedSet = new Set(guardTestApprovedConflicts.map((c) => `${c.excludedQid}|${c.protectedQid}`));
  const approved = conflicts.filter((c) => approvedSet.has(`${c.excludedQid}|${c.guardQid}`));
  const unapproved = conflicts.filter((c) => !approvedSet.has(`${c.excludedQid}|${c.guardQid}`));

  if (approved.length > 0) {
    console.log(`ℹ️  承認済みの既知の衝突（除外優先ルールで保護済み、続行）: ${approved.length}件`);
    for (const c of approved) {
      const reason = guardTestApprovedConflicts.find(
        (e) => e.excludedQid === c.excludedQid && e.protectedQid === c.guardQid
      )?.reason;
      console.log(`     除外QID ${c.excludedQid} × 守護QID ${c.guardQid}: ${reason || '(理由未記載)'}`);
    }
  }

  if (unapproved.length > 0) {
    const detail = unapproved
      .map((c) => `  除外QID ${c.excludedQid} が守護QID ${c.guardQid} の上位クラスです（未承認の新規衝突）`)
      .join('\n');
    throw new Error(
      `【ガードテスト失敗】除外リストが守護リストと衝突しています:\n${detail}\n` +
        `除外優先ルールで保護される前提が成り立つなら、config/spot-config.jsonのguard_test_approved_conflictsに理由を添えて追加してください。`
    );
  }
  console.log(`✅ ガードテスト通過（新規の未承認衝突なし）`);
  guardsVerified = true;
}

async function fetchExcludedItemsQueryOnce(bbox, suspiciousOnly) {
  const query = buildExcludedItemsQuery(bbox, { suspiciousOnly });
  const params = new URLSearchParams({ query, format: 'json' });
  const t0 = Date.now();
  const response = await fetch(`${WIKIDATA_SPARQL}?${params}`, {
    headers: { Accept: 'application/sparql-results+json', 'User-Agent': WIKIDATA_USER_AGENT },
    signal: AbortSignal.timeout(BOX_QUERY_TIMEOUT_MS),
  });
  const elapsedMs = Date.now() - t0;
  if (!response.ok) {
    return { ok: false, elapsedMs, reason: `HTTP ${response.status}` };
  }
  const data = await response.json();
  return { ok: true, elapsedMs, items: parseExcludedItems(data.results?.bindings || []) };
}

/**
 * 除外統計・ガード実行時チェック用に「本来なら除外されたはずの項目」を取得する。
 *
 * 【背景】除外セットは母集団全体から観光地候補だけを除いた「残り全部」であるため、
 * 採用セットよりずっと大きく重くなりうる（実測: 富山県で採用セット1,081件は21秒で
 * 完了する一方、除外セットは単純取得で504タイムアウトした）。ログ専用機能だが、
 * 採用セット取得と同じ適応的分割ロジック（40秒超で予防的分割、失敗したら分割して
 * 再試行、最大深度で諦める）を流用して安全に取得する。この関数はログ専用のため、
 * 上位階層からのフォールバック（itemsWithinBbox）は行わず、諦めた範囲は単に
 * 欠落として警告するだけに留める（本体データには一切影響しない）。
 */
export async function fetchExcludedItemsForLogging(bbox, { depth = 0, suspiciousOnly = false, label = '除外ログ用クエリ' } = {}) {
  let result;
  try {
    result = await fetchExcludedItemsQueryOnce(bbox, suspiciousOnly);
  } catch (error) {
    result = { ok: false, reason: error.message };
  }

  if (result.ok && result.elapsedMs <= SLOW_RESPONSE_THRESHOLD_MS) {
    return result.items;
  }

  if (depth >= MAX_SPLIT_DEPTH) {
    console.warn(
      `   ⚠️  ${label}: 最大分割深度に到達、この範囲は統計から欠落します（${result.ok ? result.elapsedMs + 'ms' : result.reason}）`
    );
    return result.ok ? result.items : [];
  }

  if (result.ok) {
    console.warn(`   🐢 ${label}: ${result.elapsedMs}ms（40秒超）→ 予防的に4分割`);
  } else {
    console.warn(`   🔀 ${label}: ${result.reason} → 4分割して再試行`);
  }
  const quads = splitBboxInto4(bbox);
  const merged = new Map();
  for (let i = 0; i < quads.length; i += 1) {
    const items = await fetchExcludedItemsForLogging(quads[i], { depth: depth + 1, suspiciousOnly, label });
    for (const item of items) merged.set(item.id, item);
    if (i < quads.length - 1) await sleep(SIBLING_QUERY_INTERVAL_MS);
  }
  return Array.from(merged.values());
}

/**
 * 除外前後の件数・QIDごとの内訳・ランダムサンプル・守護QIDの生存件数をログ出力し、
 * 守護対象クラスが除外セットに紛れ込んでいないかを検証する（違反時はビルドを停止する）。
 */
export function logExclusionStats(keptItems, excludedItems, label) {
  const protectedQids = spotConfig.protected_classes?.qids || [];
  const beforeCount = keptItems.length + excludedItems.length;
  const afterCount = keptItems.length;

  console.log(`\n📊 [${label}] 除外統計`);
  console.log(`   除外前: ${beforeCount}件 / 除外後: ${afterCount}件 / 除外: ${excludedItems.length}件`);

  const breakdown = new Map();
  for (const item of excludedItems) {
    for (const qid of item.matchedExcludedQids) {
      breakdown.set(qid, (breakdown.get(qid) || 0) + 1);
    }
  }
  console.log('   除外QIDごとの内訳:');
  for (const [qid, count] of [...breakdown.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${qid}: ${count}件`);
  }

  const shuffled = [...excludedItems].sort(() => Math.random() - 0.5);
  console.log('   除外サンプル(最大20件):');
  for (const item of shuffled.slice(0, 20)) {
    console.log(`     - ${item.name} [${item.instanceOfQids.join(', ')}]`);
  }

  // 実行時ガード違反チェック：守護QIDを持つ項目が除外セットに含まれていないか
  const violations = excludedItems.filter((item) => item.instanceOfQids.some((qid) => protectedQids.includes(qid)));
  if (violations.length > 0) {
    const detail = violations
      .slice(0, 10)
      .map((v) => `${v.name}(${v.instanceOfQids.filter((q) => protectedQids.includes(q)).join(',')})`)
      .join(', ');
    throw new Error(
      `【実行時ガード違反】守護対象クラスの項目が除外セットに含まれています: ${violations.length}件（例: ${detail}）`
    );
  }

  console.log('   守護QIDの生存件数（除外後データ側）:');
  for (const qid of protectedQids) {
    const survived = keptItems.filter((item) => (item.instanceOfQids || []).includes(qid)).length;
    console.log(`     ${qid}: ${survived}件`);
  }
}

// 誤除外の疑いが強い項目（記事＋画像＋sitelinks>=3を満たすのに除外されている、かつ
// KNOWN_DOCUMENTED_NOISE_QIDSのノイズを除いた）の割合がこれを超えたら警告する
// （停止はしない）。
// 根拠: 富山県（守護リスト拡充・ノイズ除去済み）での実測は10/1210件=0.83%。
// このうち本当に見るべき誤除外（白川郷・東山ひがし・主計町・長町武家屋敷跡）は
// 4件で、残り6件は大学・インターチェンジ・体育館・戦闘等ノイズリスト未収録の
// 想定内バリエーション。県ごとの地域差（温泉地が多い県、史跡が多い県等）による
// 自然な変動を吸収しつつ、城バグ相当の系統的事故（ノイズ除去前の実測で約30%相当）
// を確実に検知できる水準として、実測値の2倍強にあたる2%を閾値とする。
const SUSPICIOUS_EXCLUSION_WARNING_RATIO = 0.02;

/**
 * 除外セットの中から「観光地らしいのに除外されている」疑いが強い項目を機械的に
 * 検出する（記事あり・画像あり・sitelinks>=3。学校/変電所/郵便局/小字はまず
 * 画像を持たないため、この条件を満たすのに除外されているなら誤除外の可能性が高い）。
 * 守護リストを事前に思いつく方式には限界がある（城の発見は偶然ログを見ただけだった）
 * ため、逆方向から機械的に炙り出す常設チェックとして毎ビルドで実行する。
 * エラーでは止めない（全国展開後は県ごとに温泉旅館等が数件引っかかるのは正常）。
 */
/**
 * suspicious_exclusion_noise_filter（config）に該当する項目を取り除く。
 * item自身のP31がノイズQIDのいずれかと一致する場合に取り除く（駅・行政区画・
 * 大学等、意図通り除外されているが記事が充実しているために検出器へ混入する項目）。
 */
function filterOutKnownNoise(items) {
  return items.filter((item) => !item.instanceOfQids.some((qid) => noiseFilterQidSet.has(qid)));
}

export async function checkSuspiciousExclusions(bbox, label, keptCount) {
  const rawSuspiciousItems = await fetchExcludedItemsForLogging(bbox, {
    suspiciousOnly: true,
    label: `${label} 誤除外チェック`,
  });
  const suspiciousItems = filterOutKnownNoise(rawSuspiciousItems);
  const ratio = keptCount > 0 ? suspiciousItems.length / keptCount : 0;
  console.log(
    `\n🔍 [${label}] 誤除外疑いチェック: ノイズ除去前${rawSuspiciousItems.length}件 → 除去後${suspiciousItems.length}件` +
      `（抑制${rawSuspiciousItems.length - suspiciousItems.length}件、採用セット比${(ratio * 100).toFixed(1)}%、閾値${(SUSPICIOUS_EXCLUSION_WARNING_RATIO * 100).toFixed(1)}%）`
  );
  if (ratio > SUSPICIOUS_EXCLUSION_WARNING_RATIO) {
    const breakdown = new Map();
    for (const item of suspiciousItems) {
      for (const qid of item.instanceOfQids) breakdown.set(qid, (breakdown.get(qid) || 0) + 1);
    }
    const top = [...breakdown.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.warn(
      `   ⚠️  誤除外の疑いがある項目が閾値を超えています。除外リストの見直しを検討してください。`
    );
    console.warn(`   上位P31候補: ${top.map(([qid, count]) => `${qid}:${count}件`).join(', ')}`);
  }
  return suspiciousItems;
}

/**
 * 上位階層で取得済みの（低速でも成功した）結果から、指定bboxに収まる項目だけを抜き出す。
 * 子範囲が最終的に失敗した際のフォールバックに使う（再クエリ不要でデータ欠損を防ぐ）。
 */
function itemsWithinBbox(items, bbox) {
  return items.filter(
    (it) =>
      it.latitude !== null &&
      it.longitude !== null &&
      it.longitude >= bbox.west &&
      it.longitude <= bbox.east &&
      it.latitude >= bbox.south &&
      it.latitude <= bbox.north
  );
}

/**
 * 適応的分割つき地域一括取得。
 * 1) まず対象範囲をそのまま試す（内部でリトライ込み）
 * 2) 失敗（タイムアウト/5xx）、または成功はしたが40秒超（予防的分割）の場合は
 *    4分割して再帰的に再試行する
 * 3) MAX_SPLIT_DEPTH に達したら、上位階層の（低速でも成功した）結果があればそこから
 *    範囲を絞って採用し、なければ諦めて failLog に記録する
 */
export async function fetchRegionItemsAdaptive(bbox, options = {}) {
  const depth = options.depth || 0;
  const failLog = options.failLog || [];
  const label = options.label || 'region';
  // 直近の祖先で成功した（低速だったため分割に回された）結果。子が最終的に失敗した際の代替に使う。
  const fallbackItems = options.fallbackItems || null;

  const result = await fetchBoxQueryWithRetry(bbox);

  if (result.ok && result.elapsedMs <= SLOW_RESPONSE_THRESHOLD_MS) {
    console.log(`  ✅ ${label}（深さ${depth}）: ${result.items.length}件 (${result.elapsedMs}ms)`);
    return { items: result.items, failLog };
  }

  if (result.ok) {
    // 成功はしたが40秒超 → 安定性優先で予防的に分割（この結果は子の失敗時のフォールバックとして温存）
    if (depth >= MAX_SPLIT_DEPTH) {
      console.warn(
        `  ⚠️  ${label}（深さ${depth}）: ${result.elapsedMs}ms（40秒超）だが最大分割深度のためこのまま採用`
      );
      return { items: result.items, failLog };
    }
    console.warn(
      `  🐢 ${label}（深さ${depth}）: 成功したが${result.elapsedMs}ms（40秒超）→ 予防的に4分割`
    );
    return splitAndMerge(bbox, depth, label, failLog, result.items);
  }

  // 失敗（タイムアウト/5xx、リトライも尽きた）
  if (depth >= MAX_SPLIT_DEPTH) {
    failLog.push({ bbox, depth, reason: result.reason });
    if (fallbackItems) {
      const recovered = itemsWithinBbox(fallbackItems, bbox);
      console.warn(
        `  ❌ ${label}（深さ${depth}）: 最大分割深度に到達 - ${result.reason} → 上位階層の結果から${recovered.length}件を代替採用`
      );
      return { items: recovered, failLog };
    }
    console.error(
      `  ❌ ${label}（深さ${depth}）: 最大分割深度に到達、諦め - ${result.reason}（代替データなし）`
    );
    return { items: [], failLog };
  }

  console.warn(`  🔀 ${label}（深さ${depth}）: ${result.reason} → 4分割して再試行`);
  return splitAndMerge(bbox, depth, label, failLog, fallbackItems);
}

async function splitAndMerge(bbox, depth, label, failLog, fallbackItems) {
  const quads = splitBboxInto4(bbox);
  const merged = new Map();
  for (let i = 0; i < quads.length; i += 1) {
    const { items } = await fetchRegionItemsAdaptive(quads[i], {
      depth: depth + 1,
      failLog,
      fallbackItems,
      label: `${label}-${depth}-${i}`,
    });
    for (const item of items) merged.set(item.id, item);
    if (i < quads.length - 1) await sleep(SIBLING_QUERY_INTERVAL_MS);
  }
  return { items: Array.from(merged.values()), failLog };
}

/**
 * 地域一括取得した結果から、停留所ごとの近傍スポット一覧をローカルで組み立てる。
 * old方式（wikibase:around）の searchSpotsAroundStation と同じ出力形状を再現する。
 */
export function buildStopSpotsFromRegionItems(stops, regionItems, radiusKm) {
  const spotsByStation = {};
  for (const stop of stops) {
    const nearby = [];
    for (const item of regionItems) {
      if (item.latitude === null || item.longitude === null) continue;
      const distance = calculateDistance(
        stop.stop_lat,
        stop.stop_lon,
        item.latitude,
        item.longitude
      );
      if (distance <= radiusKm) {
        nearby.push({ ...item, distance });
      }
    }
    nearby.sort((a, b) => a.distance - b.distance);
    spotsByStation[stop.stop_id] = nearby;
  }
  return spotsByStation;
}

/**
 * 地域単位でスポット情報を生成するメイン処理。
 * 1. 停留所群からbboxを計算し、適応的分割つきで一括取得
 * 2. 停留所ごとの近傍判定をローカルで実施
 * 3. ユニークQIDごとに1回だけWikipedia/pageviews拡張（地域全体で重複排除）
 */
export async function generateSpotsForRegion(stops, options = {}) {
  await verifyExclusionGuards();

  const radiusKm = options.radiusKm ?? spotConfig.search_radius_km;
  const label = options.label || 'region';
  const spotDetailsCache = options.spotDetailsCache || {};

  console.log(`🌍 [${label}] bbox計算中... (${stops.length}停留所)`);
  const { kept: coreStops, excluded: outlierStops } = filterGeographicOutliers(stops);
  if (outlierStops.length > 0) {
    console.warn(
      `   ⚠️  他都道府県所在と判定して bbox 計算から除外: ${outlierStops.length}件（例: ${outlierStops.slice(0, 5).map((s) => s.stop_name).join(', ')}）`
    );
  }
  const bbox = computeBoundingBox(coreStops, radiusKm);
  console.log(
    `   bbox: lon[${bbox.west.toFixed(4)}, ${bbox.east.toFixed(4)}] lat[${bbox.south.toFixed(4)}, ${bbox.north.toFixed(4)}]`
  );

  const { items: regionItems, failLog } = await fetchRegionItemsAdaptive(bbox, { label });
  console.log(`   → 地域全体のユニークWikidata項目数: ${regionItems.length}件`);
  if (failLog.length > 0) {
    console.warn(`   ⚠️  取得を諦めた範囲: ${failLog.length}件（要確認）`);
  }

  const excludedItems = await fetchExcludedItemsForLogging(bbox, { label: `${label} 除外統計` });
  logExclusionStats(regionItems, excludedItems, label);
  await checkSuspiciousExclusions(bbox, label, regionItems.length);

  const spotsByStation = buildStopSpotsFromRegionItems(stops, regionItems, radiusKm);

  const uniqueIds = new Set();
  for (const stopId of Object.keys(spotsByStation)) {
    for (const spot of spotsByStation[stopId]) uniqueIds.add(spot.id);
  }
  const idsToEnrich = Array.from(uniqueIds).filter((id) => !spotDetailsCache[id]);
  console.log(
    `   → 停留所に紐づくユニークスポット数: ${uniqueIds.size}件（うち新規enrichment対象: ${idsToEnrich.length}件）`
  );

  // regionItemsは地域全体でQIDごとに1件しかないため、そのままバッチenrichmentの入力にできる
  // （spotsByStationを走査して代表オブジェクトを探す必要がない）
  const idSet = new Set(idsToEnrich);
  const spotsToEnrich = regionItems
    .filter((item) => idSet.has(item.id))
    .map((item) => ({ ...item, description: '' }));

  await enrichSpotsBatchWithWikipedia(spotsToEnrich);

  for (const spot of spotsToEnrich) {
    spotDetailsCache[spot.id] = {
      description: spot.description,
      image: spot.image,
      wikipedia_url: spot.wikipedia_url,
    };
  }

  for (const stopId of Object.keys(spotsByStation)) {
    spotsByStation[stopId] = spotsByStation[stopId].map((spot) => {
      const detail = spotDetailsCache[spot.id];
      return detail ? { ...spot, ...detail } : spot;
    });
  }

  const normalizedOutput = buildIndexedSpotsOutput(spotsByStation);
  return { normalizedOutput, spotsByStation, regionItems, failLog, spotDetailsCache };
}

/**
 * 停留所ごとのスポット一覧を、QID文字列の重複格納を避けた最終出力形式にまとめる。
 * {spots: {qid: 詳細}, stations: {stop_id: [{qid, distance}]}} という素朴な形式は
 * QID文字列とdistanceのフル精度浮動小数点が停留所×近傍スポットの組み合わせ分
 * （実測: 富山県で87,508件）繰り返し格納され、ファイルサイズを大きく圧迫する
 * （実測: 4,822.6KB → 1,551.4KB に圧縮、67.8%減）。
 * spotsIndex（QID配列）を県ごとに1つ持ち、spots/stationsはすべてその添字（整数）で参照する。
 * distanceは3桁（メートル精度）に丸める。
 */
export function buildIndexedSpotsOutput(spotsByStation) {
  const spotsIndex = [];
  const qidToInt = new Map();
  const spotDetails = new Map();

  for (const stopId of Object.keys(spotsByStation)) {
    for (const spot of spotsByStation[stopId]) {
      if (!qidToInt.has(spot.id)) {
        qidToInt.set(spot.id, spotsIndex.length);
        spotsIndex.push(spot.id);
        spotDetails.set(spot.id, {
          name: spot.name,
          description: spot.description,
          image: spot.image,
          wikidata_url: spot.wikidata_url,
          wikipedia_url: spot.wikipedia_url,
          latitude: spot.latitude,
          longitude: spot.longitude,
          sitelinks: spot.sitelinks,
        });
      }
    }
  }

  const spots = spotsIndex.map((qid) => spotDetails.get(qid));
  const stations = {};
  for (const stopId of Object.keys(spotsByStation)) {
    stations[stopId] = spotsByStation[stopId].map((spot) => [
      qidToInt.get(spot.id),
      Math.round(spot.distance * 1000) / 1000,
    ]);
  }

  return { spotsIndex, spots, stations };
}
