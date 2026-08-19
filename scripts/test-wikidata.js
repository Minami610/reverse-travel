import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchWikidataResponse } from './build-pipeline/generate-spots.json.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const stopsPath = path.join(__dirname, '../data/derived/stops-metadata.json');
const stops = JSON.parse(fs.readFileSync(stopsPath, 'utf-8'));
const testStop = stops.find((stop) => stop.stop_name === '高松築港');

if (!testStop) {
  throw new Error('GTFS stops-metadata.json に高松築港が見つかりません');
}

console.log(
  `Test station: ${testStop.stop_name} (${testStop.stop_lat}, ${testStop.stop_lon})`
);

try {
  const response = await fetchWikidataResponse(testStop, 3, 30000);
  console.log(`HTTP status: ${response.status}`);
  console.log(`Request URL: ${response.url}`);
  console.log('Response body:');
  console.log(response.body);

  const hasTamamoPark = response.body.includes('Q140315706');
  if (!response.ok || !hasTamamoPark) {
    console.error(
      'Validation failed: 玉藻公園 (Q140315706, 高松城跡) was not found in the response.'
    );
    process.exitCode = 1;
  } else {
    console.log('Validation passed: 玉藻公園 (Q140315706) is included.');
  }
} catch (error) {
  console.error('Request failed:', error);
  process.exitCode = 1;
}