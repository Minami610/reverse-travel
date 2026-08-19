/**
 * refresh-and-normalize-spots.js
 *
 * generate-spots.json.js の Pageviews API / Wikipedia検索API 修正を既存キャッシュに反映する。
 * Wikidata近傍検索（駅893件分）はやり直さず、ユニークなスポット（QID）241件分だけ
 * Wikipedia検索・説明文・ページビューを再取得し、spots-by-station.json を
 * QID辞書＋駅ごとの参照配列に正規化して書き出す。
 *
 * 使い方: node scripts/build-pipeline/refresh-and-normalize-spots.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  enrichSpotWithWikipedia,
  buildNormalizedSpotsOutput,
  REQUEST_INTERVAL_MS,
} from './generate-spots.json.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const derivedDir = path.join(__dirname, '../../data/derived');
const stationCachePath = path.join(derivedDir, 'spots-by-station.cache.json');
const detailsCachePath = path.join(derivedDir, 'spot-details.cache.json');
const finalOutputPath = path.join(derivedDir, 'spots-by-station.json');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!fs.existsSync(stationCachePath)) {
    throw new Error(`${stationCachePath} が見つかりません`);
  }

  const stationCache = JSON.parse(fs.readFileSync(stationCachePath, 'utf-8'));
  const detailsCache = fs.existsSync(detailsCachePath)
    ? JSON.parse(fs.readFileSync(detailsCachePath, 'utf-8'))
    : {};

  // ユニークQIDを収集（駅をまたいで重複するスポットは1回だけ処理）
  const uniqueSpots = new Map();
  for (const stopId of Object.keys(stationCache)) {
    for (const spot of stationCache[stopId]) {
      if (!uniqueSpots.has(spot.id)) {
        uniqueSpots.set(spot.id, { name: spot.name });
      }
    }
  }

  const qids = Array.from(uniqueSpots.keys());
  console.log(`🔍 ユニークスポット数: ${qids.length}`);
  if (qids.length === 0) {
    throw new Error('ユニークスポットが0件です。spots-by-station.cache.json を確認してください。');
  }

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < qids.length; i += 1) {
    const qid = qids[i];
    const meta = uniqueSpots.get(qid);
    const progress = `[${i + 1}/${qids.length}]`;

    const spot = {
      name: meta.name,
      description: '',
      pageviews: null,
      image: null,
      wikipedia_url: null,
    };

    try {
      await enrichSpotWithWikipedia(spot);
      const found = Boolean(spot.wikipedia_url);
      detailsCache[qid] = {
        description: spot.description,
        image: spot.image,
        wikipedia_url: spot.wikipedia_url,
        pageviews: spot.pageviews,
      };
      if (found) {
        successCount += 1;
        console.log(
          `  ${progress} ${meta.name}: wikipedia=${spot.wikipedia_url} pageviews=${spot.pageviews ?? 'データなし'}`
        );
      } else {
        failCount += 1;
        console.warn(`  ${progress} ${meta.name}: Wikipedia記事が見つかりませんでした`);
      }
    } catch (error) {
      failCount += 1;
      console.error(`  ${progress} ${meta.name}: エラー - ${error.message}`);
    }

    fs.writeFileSync(detailsCachePath, JSON.stringify(detailsCache, null, 2));

    if (i < qids.length - 1) {
      await sleep(REQUEST_INTERVAL_MS);
    }
  }

  console.log(`\n📊 再取得結果: 成功 ${successCount} / 失敗 ${failCount} / 全 ${qids.length}`);
  if (successCount === 0) {
    throw new Error('全件失敗しました。API呼び出しを確認してください（0件成功でのエラー停止）。');
  }

  // 駅ごとの内部キャッシュ（denormalized）にも最新の詳細情報を反映
  for (const stopId of Object.keys(stationCache)) {
    stationCache[stopId] = stationCache[stopId].map((spot) => {
      const detail = detailsCache[spot.id];
      return detail ? { ...spot, ...detail } : spot;
    });
  }
  fs.writeFileSync(stationCachePath, JSON.stringify(stationCache, null, 2));

  // 正規化済み最終出力（QID辞書＋駅ごとの参照配列）を書き出し
  const normalizedOutput = buildNormalizedSpotsOutput(stationCache);
  fs.writeFileSync(finalOutputPath, JSON.stringify(normalizedOutput));

  const uniqueSpotCount = Object.keys(normalizedOutput.spots).length;
  const stationCount = Object.keys(normalizedOutput.stations).length;
  const refCount = Object.values(normalizedOutput.stations).reduce(
    (sum, arr) => sum + arr.length,
    0
  );
  const pageviewsPresent = Object.values(normalizedOutput.spots).filter(
    (s) => s.pageviews !== null && s.pageviews !== undefined
  ).length;
  const sizeBytes = fs.statSync(finalOutputPath).size;

  console.log(`\n✅ 正規化済み出力を書き込み: ${finalOutputPath}`);
  console.log(`   spots辞書: ${uniqueSpotCount}件`);
  console.log(`   駅数: ${stationCount}駅 / 駅→スポット参照: ${refCount}件`);
  console.log(`   pageviews取得済み: ${pageviewsPresent} / ${uniqueSpotCount}件`);
  console.log(`   ファイルサイズ: ${(sizeBytes / 1024 / 1024).toFixed(2)} MB`);
}

main().catch((error) => {
  console.error('❌ 致命的エラー:', error);
  process.exit(1);
});
