/**
 * generate-spots.json.js - 観光スポット情報生成
 * 
 * Wikidata SPARQL + Wikipedia REST API + Pageviews API を使用して、
 * 各駅の周辺スポット情報を取得・生成
 * 
 * 出力：
 * - spots-by-station.json (上書き): {stop_id: [{spot}, ...]}
 */

import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// パス定義
const derivedDir = path.join(__dirname, '../../data/derived');
const stopsMetadataPath = path.join(derivedDir, 'stops-metadata.json');
const spotsByStationPath = path.join(derivedDir, 'spots-by-station.json');
const spotsCachePath = path.join(derivedDir, 'spots-by-station.cache.json');
const spotDetailsCachePath = path.join(derivedDir, 'spot-details.cache.json');
const failedStationsPath = path.join(derivedDir, 'spots-by-station.failed.json');
const spotConfigPath = path.join(__dirname, '../../config/spot-config.json');
const spotConfig = JSON.parse(fs.readFileSync(spotConfigPath, 'utf-8'));
const excludedClassQids = spotConfig.excluded_classes.qids
  .map((qid) => `wd:${qid}`)
  .join(' ');

// API設定
const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
const WIKIPEDIA_API = 'https://ja.wikipedia.org/w/api.php';
const PAGEVIEWS_API = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/ja.wikipedia';
const WIKIDATA_USER_AGENT =
  'reverse-travel/0.1.0 (contact: reverse-travel-maintainer)';
const REQUEST_TIMEOUT_MS = 10000;
export const REQUEST_INTERVAL_MS = 1100;
const MAX_RETRIES = 4;

/**
 * Pageviews API の start/end は YYYYMMDD00 形式。直近12ヶ月（今月を除く）を対象とする。
 */
function getPageviewsDateRange(referenceDate = new Date()) {
  const end = new Date(
    Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), 1)
  );
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 12, 1));
  const fmt = (d) =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(
      d.getUTCDate()
    ).padStart(2, '0')}00`;
  return { start: fmt(start), end: fmt(end) };
}

const PAGEVIEWS_DATE_RANGE = getPageviewsDateRange();

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (attempt === MAX_RETRIES) throw error;
      const backoffMs = 2000 * 2 ** attempt;
      console.warn(
        `API ${error.name}: ${backoffMs}ms 待機後に再試行 (${attempt + 1}/${MAX_RETRIES})`
      );
      await sleep(backoffMs);
      continue;
    }

    const retryableStatus = [429, 500, 502, 503, 504].includes(response.status);
    if (!retryableStatus || attempt === MAX_RETRIES) {
      return response;
    }

    const retryAfter = Number(response.headers.get('retry-after'));
    const backoffMs = Number.isFinite(retryAfter)
      ? Math.min(retryAfter * 1000, 30000)
      : 2000 * 2 ** attempt;
    console.warn(
      `Wikidata ${response.status}: ${backoffMs}ms 待機後に再試行 (${attempt + 1}/${MAX_RETRIES})`
    );
    await sleep(backoffMs);
  }
}

export function buildWikidataQuery(stop, radiusKm) {
  return `
      PREFIX bd: <http://www.bigdata.com/rdf#>
      PREFIX geo: <http://www.opengis.net/ont/geosparql#>
      PREFIX wdt: <http://www.wikidata.org/prop/direct/>
      PREFIX wikibase: <http://wikiba.se/ontology#>
      SELECT ?item ?coordinate ?distance
      WHERE {
        SERVICE wikibase:around {
          ?item wdt:P625 ?coordinate.
          bd:serviceParam wikibase:center "Point(${stop.stop_lon} ${stop.stop_lat})"^^geo:wktLiteral;
            wikibase:radius "${radiusKm}";
            wikibase:distance ?distance.
        }
      }
      ORDER BY ?distance
      LIMIT 100
    `;
}

function buildWikidataDetailsQuery(items) {
  const values = items.map((item) => `<${item.value}>`).join(' ');
  return `
      PREFIX schema: <http://schema.org/>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      PREFIX wd: <http://www.wikidata.org/entity/>
      PREFIX wdt: <http://www.wikidata.org/prop/direct/>
      SELECT DISTINCT ?item ?itemLabel ?coordinate ?image ?article
      WHERE {
        VALUES ?item { ${values} }
        ?item wdt:P625 ?coordinate.
        ?article schema:about ?item;
          schema:isPartOf <https://ja.wikipedia.org/>.
        FILTER NOT EXISTS {
          ?item wdt:P31/wdt:P279* ?excludedType.
          VALUES ?excludedType { ${excludedClassQids} }
        }
        FILTER NOT EXISTS {
          ?item wdt:P31 ?anyClass.
          ?anyClass rdfs:label ?anyClassLabel.
          FILTER (LANG(?anyClassLabel) = "en" && STRSTARTS(?anyClassLabel, "Category:"))
        }
        ?item rdfs:label ?itemLabel.
        FILTER (LANG(?itemLabel) = "ja")
        OPTIONAL { ?item wdt:P18 ?image. }
      }
    `;
}

export async function fetchWikidataResponse(
  stop,
  radiusKm,
  timeoutMs = REQUEST_TIMEOUT_MS
) {
  const nearbyParams = new URLSearchParams({
    query: buildWikidataQuery(stop, radiusKm),
    format: 'json',
    language: 'ja',
  });
  const nearbyUrl = `${WIKIDATA_SPARQL}?${nearbyParams}`;
  const nearbyResponse = await fetchWithTimeout(nearbyUrl, {
    headers: {
      Accept: 'application/sparql-results+json',
      'User-Agent': WIKIDATA_USER_AGENT,
    },
  }, timeoutMs);
  const nearbyBody = await nearbyResponse.text();
  if (!nearbyResponse.ok) {
    return { url: nearbyUrl, status: nearbyResponse.status, ok: false, body: nearbyBody };
  }

  const nearbyData = JSON.parse(nearbyBody);
  const items = (nearbyData.results?.bindings || []).map((binding) => ({
    value: binding.item.value,
    distance: binding.distance?.value,
  }));
  if (items.length === 0) {
    return { url: nearbyUrl, status: nearbyResponse.status, ok: true, body: nearbyBody, nearbyItems: items };
  }

  const params = new URLSearchParams({
    query: buildWikidataDetailsQuery(items),
    format: 'json',
    language: 'ja',
  });
  const url = `${WIKIDATA_SPARQL}?${params}`;
  const response = await fetchWithTimeout(url, {
    headers: {
      Accept: 'application/sparql-results+json',
      'User-Agent': WIKIDATA_USER_AGENT,
    },
  }, timeoutMs);
  const body = await response.text();
  return { url, status: response.status, ok: response.ok, body, nearbyItems: items };
}

/**
 * スポット生成のメイン処理
 */
export async function generateSpots() {
  console.log('🌍 観光スポット情報生成開始...\n');

  // データを読み込む
  const stops = JSON.parse(fs.readFileSync(stopsMetadataPath, 'utf-8'));
  const spotConfig = JSON.parse(fs.readFileSync(spotConfigPath, 'utf-8'));

  const spotsByStation = fs.existsSync(spotsCachePath)
    ? JSON.parse(fs.readFileSync(spotsCachePath, 'utf-8'))
    : {};
  const spotDetailsCache = fs.existsSync(spotDetailsCachePath)
    ? JSON.parse(fs.readFileSync(spotDetailsCachePath, 'utf-8'))
    : {};
  const failedStations = fs.existsSync(failedStationsPath)
    ? JSON.parse(fs.readFileSync(failedStationsPath, 'utf-8'))
    : {};

  console.log(`📍 ${stops.length} 駅のスポット検索中...`);

  // サンプル実装：API呼び出しのテンプレートを示す
  // 実際のAPI呼び出しは、リアルタイムで行うと時間がかかるため、
  // 本実装ではバッチ処理としてスケジュール実行することを想定

  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    const progress = `[${i + 1}/${stops.length}]`;

    if (Object.prototype.hasOwnProperty.call(spotsByStation, stop.stop_id)) {
      console.log(`  ${progress} ${stop.stop_name}: キャッシュを再利用`);
      continue;
    }

    // Wikidata から駅周辺スポットを検索。失敗は空結果に変換しない。
    let spots;
    try {
      spots = await searchSpotsAroundStation(
        stop,
        spotConfig.search_radius_km,
        spotDetailsCache
      );
      delete failedStations[stop.stop_id];
    } catch (error) {
      failedStations[stop.stop_id] = {
        stop_name: stop.stop_name,
        error: error.message,
        failed_at: new Date().toISOString(),
      };
      fs.writeFileSync(failedStationsPath, JSON.stringify(failedStations, null, 2));
      console.error(`  ⚠️  ${progress} ${stop.stop_name}: 取得失敗、次駅へ進みます - ${error.message}`);
      continue;
    }
    spotsByStation[stop.stop_id] = spots;
    console.log(`  ${progress} ${stop.stop_name}: ${spots.length} スポット取得`);
    fs.writeFileSync(spotsCachePath, JSON.stringify(spotsByStation, null, 2));
    fs.writeFileSync(spotDetailsCachePath, JSON.stringify(spotDetailsCache, null, 2));
    fs.writeFileSync(failedStationsPath, JSON.stringify(failedStations, null, 2));

    if (i < stops.length - 1) {
      await sleep(REQUEST_INTERVAL_MS);
    }
  }

  // 結果を保存（QID辞書＋駅ごとの参照配列に正規化して重複を排除）
  const normalizedOutput = buildNormalizedSpotsOutput(spotsByStation);
  fs.writeFileSync(spotsByStationPath, JSON.stringify(normalizedOutput));
  console.log(
    `  スポット辞書: ${Object.keys(normalizedOutput.spots).length}件 / 駅参照: ${Object.keys(normalizedOutput.stations).length}駅`
  );

  console.log('\n✅ 観光スポット情報生成完了\n');
}

/**
 * 駅ごとに重複格納されているスポット詳細を QID 辞書へ正規化する。
 * { spots: {qid: {詳細}}, stations: {stop_id: [{qid, distance}, ...]} }
 */
export function buildNormalizedSpotsOutput(spotsByStation) {
  const spots = {};
  const stations = {};

  for (const stopId of Object.keys(spotsByStation)) {
    stations[stopId] = [];
    for (const spot of spotsByStation[stopId]) {
      if (!spots[spot.id]) {
        spots[spot.id] = {
          name: spot.name,
          description: spot.description,
          image: spot.image,
          wikidata_url: spot.wikidata_url,
          wikipedia_url: spot.wikipedia_url,
          latitude: spot.latitude,
          longitude: spot.longitude,
          pageviews: spot.pageviews,
        };
      }
      stations[stopId].push({ qid: spot.id, distance: spot.distance });
    }
  }

  return { spots, stations };
}

/**
 * 駅周辺のスポットを検索（Wikidata SPARQL）
 */
async function searchSpotsAroundStation(stop, radiusKm, spotDetailsCache = {}) {
  const response = await fetchWikidataResponse(stop, radiusKm);
  if (!response.ok) {
    throw new Error(`Wikidata HTTP ${response.status}: ${response.body}`);
  }
  const data = JSON.parse(response.body);

    if (!data.results || !data.results.bindings) {
      return [];
    }

    // 結果をスポットオブジェクトに変換
    const spotsByQid = new Map();
    for (const binding of data.results.bindings) {
      const wikidataId = binding.item.value.split('/').pop();
      if (spotsByQid.has(wikidataId)) continue;
      const wikidataImage = binding.image?.value || null;
      const spot = {
        id: wikidataId,
        name: binding.itemLabel?.value || '（名称不明）',
        description: '',
        pageviews: null,
        image: wikidataImage && !isProblematicImage(wikidataImage) ? wikidataImage : null,
        wikidata_url: binding.item.value,
        // Wikidataのサイトリンクから直接取得（Wikipedia全文検索によるタイトル取り違えを防ぐ）
        wikipedia_url: binding.article?.value || null,
        latitude: null,
        longitude: null,
        distance: null,
      };

      if (spotDetailsCache[wikidataId]) {
        Object.assign(spot, spotDetailsCache[wikidataId]);
      }

      // 座標を解析
      if (binding.coordinate?.value) {
        const match = binding.coordinate.value.match(
          /Point\(([^ ]+) ([^ ]+)\)/
        );
        if (match) {
          spot.longitude = parseFloat(match[1]);
          spot.latitude = parseFloat(match[2]);
          spot.distance = calculateDistance(
            stop.stop_lat,
            stop.stop_lon,
            spot.latitude,
            spot.longitude
          );
        }
      }

      // Wikipedia から説明文・ページビューを取得
      if (!spotDetailsCache[wikidataId]) {
        try {
          await enrichSpotWithWikipedia(spot);
          spotDetailsCache[wikidataId] = {
            description: spot.description,
            image: spot.image,
            wikipedia_url: spot.wikipedia_url,
            pageviews: spot.pageviews,
          };
        } catch (error) {
          console.warn(`    ⚠️  Wikipedia 拡張失敗: ${spot.name} - ${error.message}`);
        }
      }

      spotsByQid.set(wikidataId, spot);
    }

  return Array.from(spotsByQid.values()).sort(
    (left, right) => left.distance - right.distance
  );
}

// 位置図（locator map）・汎用サムネイル失敗アイコンのファイル名パターン。
// 実際の景色写真ではないため、旅行アプリの体験を損なう画像として除外する。
const PROBLEMATIC_IMAGE_PATTERN = /map|locator|relief|g[ée]olocalisation|gthumb/i;

function isProblematicImage(imageUrl) {
  const filename = decodeURIComponent(imageUrl.split('/').pop().split('?')[0]);
  return PROBLEMATIC_IMAGE_PATTERN.test(filename);
}

/**
 * Wikipedia API でスポット情報を拡張（説明文・ページビュー）
 * 記事タイトルは Wikidata のサイトリンク（spot.wikipedia_url）から直接得る。
 * Wikipedia全文検索は使わない（検索結果が別記事に一致し、無関係な記事の
 * pageviews/説明文を取得してしまう取り違えを防ぐため）。
 */
export async function enrichSpotWithWikipedia(spot) {
  if (!spot.wikipedia_url) return;

  const pageTitle = decodeURIComponent(
    spot.wikipedia_url.split('/wiki/').pop()
  ).replace(/_/g, ' ');

  if (pageTitle.includes('曖昧さ回避')) {
    console.warn(`    ⚠️  曖昧さ回避ページの疑い（タイトル）: ${spot.name} → ${pageTitle}`);
  }

  try {
    // ページの詳細情報を取得
    const pageParams = new URLSearchParams({
      action: 'query',
      format: 'json',
      titles: pageTitle,
      prop: 'extracts|pageimages|pageprops',
      exintro: 1,
      explaintext: 1,
      pithumbsize: 300,
    });

    const pageResponse = await fetchWithTimeout(
      `${WIKIPEDIA_API}?${pageParams}`,
      {
        headers: { 'User-Agent': WIKIDATA_USER_AGENT },
      }
    );

    if (!pageResponse.ok) return;

    const pageData = await pageResponse.json();
    const pages = pageData.query?.pages;
    const page = Object.values(pages || {})[0];

    if (page?.pageprops && 'disambiguation' in page.pageprops) {
      console.warn(`    ⚠️  曖昧さ回避ページを検出、スキップ: ${spot.name} → ${pageTitle}`);
      spot.is_disambiguation = true;
      return;
    }

    if (page) {
      spot.description = page.extract || '';
      if (page.thumbnail?.source && !isProblematicImage(page.thumbnail.source)) {
        spot.image = page.thumbnail.source;
      }
    }

    // ページビュー数を取得
    try {
      const pageviewsUrl = [
        PAGEVIEWS_API,
        'all-access',
        'all-agents',
        encodeURIComponent(pageTitle),
        'monthly',
        PAGEVIEWS_DATE_RANGE.start,
        PAGEVIEWS_DATE_RANGE.end,
      ].join('/');

      const pageviewsResponse = await fetchWithTimeout(pageviewsUrl, {
        headers: { 'User-Agent': WIKIDATA_USER_AGENT },
      });

      if (pageviewsResponse.ok) {
        const pageviewsData = await pageviewsResponse.json();
        const items = pageviewsData.items || [];

        if (items.length > 0) {
          // 直近12ヶ月の平均を計算
          const total = items.reduce((sum, item) => sum + item.views, 0);
          spot.pageviews = Math.round(total / items.length);
        }
      }
    } catch (error) {
      console.warn(`    ⚠️  ページビュー取得失敗: ${pageTitle}`);
    }
  } catch (error) {
    console.warn(`    ⚠️  Wikipedia拡張エラー: ${error.message}`);
  }
}

/**
 * 2点間の距離を計算（Haversine公式）
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
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

/**
 * スリープ関数
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 実行
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  generateSpots().catch((error) => {
    console.error('❌ 致命的エラー:', error);
    process.exit(1);
  });
}
