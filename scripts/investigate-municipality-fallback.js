/**
 * investigate-municipality-fallback.js - スポット市町村名タグ付けの「1km以内フォールバック」調査
 * （2026-10-10、調査専用。読み取り専用、docs/・data/derivedは変更しない）
 *
 * Minami指示：「ポリゴンの外（海・河口・橋など）のときは、最寄りのポリゴンが1km以内に
 * あればその市町村を使う。それもなければ付けない。富山での判定できない件数が、
 * どれだけ減るかを報告する。」
 *
 * municipality-polygon-lookup.js の buildMunicipalityPolygonFinder() は
 * 「点がポリゴンの中にあるか」しか判定せず、ポリゴン境界までの距離を返す機能が無い。
 * @turf/point-to-polygon-distance 等の追加パッケージは未インストールのため、
 * 新規依存を増やさずに、点ー線分の最短距離（局所的に平面近似、1km級の精度には十分）を
 * 自前で計算する。本番（municipality-polygon-lookup.js）には一切手を入れず、
 * ここでしか使わない独立実装。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as shapefile from 'shapefile';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const cacheDir = path.join(rootDir, 'data/raw-gis/n03');

function readPrefJson(codeStr, name) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, 'data/derived/pref', codeStr, name), 'utf-8'));
}

async function loadFeaturesForOnePref(prefCode) {
  const code = String(prefCode).padStart(2, '0');
  const prefDir = path.join(cacheDir, code);
  const files = fs.readdirSync(prefDir);
  const shpFile = files.find((f) => f.toLowerCase().endsWith('.shp'));
  const dbfFile = files.find((f) => f.toLowerCase().endsWith('.dbf'));
  const source = await shapefile.open(path.join(prefDir, shpFile), path.join(prefDir, dbfFile), { encoding: 'shift-jis' });
  const features = [];
  let result = await source.read();
  while (!result.done) {
    features.push(result.value);
    result = await source.read();
  }
  return features;
}

/** @param {Array<number|string>} prefCodes 出発地の県＋隣接県（駅名曖昧さ回避と同じ考え方） */
async function loadFeatures(prefCodes) {
  const all = [];
  for (const code of prefCodes) all.push(...(await loadFeaturesForOnePref(code)));
  return all;
}

function municipalityName(feature) {
  const city = feature.properties.N03_004 || '';
  const ward = feature.properties.N03_005 || '';
  return `${city}${ward}`.trim();
}

function findExact(lat, lon, features) {
  const point = { type: 'Point', coordinates: [lon, lat] };
  for (const feature of features) {
    if (!feature.geometry) continue;
    try {
      if (booleanPointInPolygon(point, feature)) {
        const name = municipalityName(feature);
        if (name) return name;
      }
    } catch { /* 不正なジオメトリはスキップ */ }
  }
  return null;
}

// --- 点ー線分の最短距離（局所平面近似、km単位） ---
function toLocalXY(lon, lat, refLat) {
  const kmPerDegLon = 111.32 * Math.cos((refLat * Math.PI) / 180);
  const kmPerDegLat = 111.32;
  return { x: lon * kmPerDegLon, y: lat * kmPerDegLat };
}

function pointToSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function getRings(geometry) {
  if (geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat();
  return [];
}

function featureBBox(feature) {
  if (feature._bbox) return feature._bbox;
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const ring of getRings(feature.geometry)) {
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  feature._bbox = [minLon, minLat, maxLon, maxLat];
  return feature._bbox;
}

/** 点から最も近いポリゴンまでの距離(km)と、その市町村名を返す（bboxで粗く絞ってから厳密計算） */
function findNearest(lat, lon, features, maxKm) {
  // 緯度1度=111.32km、経度1度=111.32*cos(lat)km。maxKmに安全マージンを掛けて度数へ変換
  const margin = 1.3;
  const degLat = (maxKm * margin) / 111.32;
  const degLon = (maxKm * margin) / (111.32 * Math.cos((lat * Math.PI) / 180));

  let best = null;
  let bestDist = Infinity;
  for (const feature of features) {
    if (!feature.geometry) continue;
    const [minLon, minLat, maxLon, maxLat] = featureBBox(feature);
    if (lon < minLon - degLon || lon > maxLon + degLon || lat < minLat - degLat || lat > maxLat + degLat) continue;

    const p = toLocalXY(lon, lat, lat);
    for (const ring of getRings(feature.geometry)) {
      for (let i = 0; i < ring.length - 1; i++) {
        const a = toLocalXY(ring[i][0], ring[i][1], lat);
        const b = toLocalXY(ring[i + 1][0], ring[i + 1][1], lat);
        const d = pointToSegmentDistance(p.x, p.y, a.x, a.y, b.x, b.y);
        if (d < bestDist) { bestDist = d; best = feature; }
      }
    }
  }
  if (best && bestDist <= maxKm) return { name: municipalityName(best), distanceKm: bestDist };
  return null;
}

// 自県のN03だけでは隣県にまたがるスポット（白川郷＝岐阜県等）が解決できないため、
// 駅名曖昧さ回避と同じ考え方で「出発地の県＋隣接の可能性がある県」も合わせて読む。
const NEIGHBOR_CODES = { 16: ['21', '17'], 17: ['16'], 37: [] };

async function main() {
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const codes = onlyArg ? onlyArg.split('=')[1].split(',') : ['16', '17', '37'];
  const MAX_KM = 1;

  for (const code of codes) {
    const spots = readPrefJson(code, 'spots-by-station.json').spots;
    const prefCodes = [code, ...(NEIGHBOR_CODES[code] || [])];
    const features = await loadFeatures(prefCodes);
    let total = 0, exactResolved = 0, fallbackResolved = 0, stillUnresolved = 0;
    const fallbackSamples = [];
    const unresolvedSamples = [];

    for (const spot of spots) {
      total += 1;
      const exact = findExact(spot.latitude, spot.longitude, features);
      if (exact) { exactResolved += 1; continue; }
      const nearest = findNearest(spot.latitude, spot.longitude, features, MAX_KM);
      if (nearest) {
        fallbackResolved += 1;
        if (fallbackSamples.length < 10) fallbackSamples.push(`${spot.name} → ${nearest.name}（${nearest.distanceKm.toFixed(3)}km）`);
      } else {
        stillUnresolved += 1;
        if (unresolvedSamples.length < 10) unresolvedSamples.push(spot.name);
      }
    }

    console.log(`\n=== 都道府県コード${code} ===`);
    console.log(`総数${total}: ポリゴン内${exactResolved} / 1km以内フォールバックで解決${fallbackResolved} / なお判定不可${stillUnresolved}`);
    console.log(`  判定不可率: ${((exactResolved / total) * 100).toFixed(1)}% → ${(((exactResolved + fallbackResolved) / total) * 100).toFixed(1)}%`);
    console.log('  フォールバックで解決した例:', fallbackSamples);
    console.log('  なお判定不可な例:', unresolvedSamples);
  }
}

main().catch((err) => {
  console.error('❌ エラー:', err);
  process.exit(1);
});
