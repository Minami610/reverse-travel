import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchWikidataResponse } from './build-pipeline/generate-spots.json.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const stopsPath = path.join(__dirname, '../data/derived/stops-metadata.json');
const stops = JSON.parse(fs.readFileSync(stopsPath, 'utf-8'));
const requestedNames = process.argv.slice(2);
const stationNames = requestedNames.length > 0
  ? requestedNames
  : ['高松築港', '琴電琴平', '長尾'];

function findStop(name) {
  const stop = stops.find((candidate) => candidate.stop_name === name);
  if (!stop) {
    throw new Error(`GTFS stops-metadata.json に${name}が見つかりません`);
  }
  return stop;
}

for (const stationName of stationNames) {
  const stop = findStop(stationName);
  console.log(`\n=== ${stop.stop_name} (${stop.stop_lat}, ${stop.stop_lon}) ===`);
  const response = await fetchWikidataResponse(stop, 3, 30000);

  if (!response.ok) {
    throw new Error(`${stationName}: Wikidata HTTP ${response.status}: ${response.body}`);
  }

  const data = JSON.parse(response.body);
  const distances = new Map(
    (response.nearbyItems || []).map((item) => [
      item.value.split('/').pop(),
      Number(item.distance),
    ])
  );
  const candidatesByQid = new Map();
  for (const binding of data.results?.bindings || []) {
    const qid = binding.item.value.split('/').pop();
    candidatesByQid.set(qid, {
      name: binding.itemLabel?.value || '(名称不明)',
      distanceKm: distances.get(qid),
      qid,
    });
  }
  const candidates = Array.from(candidatesByQid.values()).sort(
    (left, right) => left.distanceKm - right.distanceKm
  );

  console.log(`取得件数: ${candidates.length}`);
  console.table(candidates);
}
