/**
 * compare-prefecture-build.js - build-prefecture.jsが生成したdata/derived/pref/{code}/を
 * config/regression-baseline.json（現行データから採取した基準値）と比較する。
 *
 * 【目的】段階1(a)：香川を新しい経路（build-prefecture.js）で作り直し、現行データと
 * 一致するかを確認する。verify-regression.jsと同じ組み合わせ（基準駅×帯ごとの予算。
 * 2026-10-06の帯表示導入前は6駅×往復¥400/¥1000の12通りだった）の到達駅数・
 * スポット件数に加えて、高松築港の乗換到達駅数（基準11）も見る。
 *
 * ずれた場合の切り分け方針：
 * - 到達駅数・乗換到達駅数がずれた → GTFS側のパース・運賃計算ロジックの違い
 *   （Wikidataとは無関係。処理側の問題）
 * - スポット件数だけがずれ、到達駅数は一致 → Wikidata側のデータ変化
 *   （bboxクエリはビルドのたびに最新のWikidataを問い合わせるため、記事の増減・
 *   sitelinks変動等で採用件数が変わりうる。処理のバグとは限らない）
 * 両方ずれた場合は、まず到達駅数のずれの原因を先に切り分けること
 *  （スポット側の差はそちらに引きずられて起きている可能性があるため）。
 *
 * 使い方: node scripts/compare-prefecture-build.js 37
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const baselinePath = path.join(rootDir, 'config/regression-baseline.json');

function toUrl(relativePath) {
  return pathToFileURL(path.join(rootDir, relativePath)).href;
}

function readJson(dir, name) {
  const filePath = path.join(dir, name);
  if (!fs.existsSync(filePath)) {
    throw new Error(`${filePath} が見つかりません。先に node scripts/build-prefecture.js <コード> を実行してください`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

async function main() {
  const codeArg = process.argv[2];
  if (!codeArg) {
    throw new Error('都道府県コードを指定してください（例: node scripts/compare-prefecture-build.js 37）');
  }
  const codeStr = String(codeArg).padStart(2, '0');
  const prefDir = path.join(rootDir, 'data/derived/pref', codeStr);

  console.log(`🔁 都道府県コード${codeStr}の新パイプライン出力を現行基準値と比較\n`);

  if (!fs.existsSync(baselinePath)) {
    throw new Error(`基準値ファイルが見つかりません: ${baselinePath}`);
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));

  global.window = {
    EMBEDDED_SPOT_RANKING_CONFIG: JSON.parse(
      fs.readFileSync(path.join(rootDir, 'config/spot-ranking-config.json'), 'utf-8')
    ),
  };

  const { FareCalculator } = await import(toUrl('assets/js/fare-calculator.js'));
  const { SpotFinder } = await import(toUrl('assets/js/spot-finder.js'));
  const { mergeIndexedSpotRegions } = await import(toUrl('assets/js/gtfs-loader.js'));

  const data = {
    fareData: readJson(prefDir, 'fare-lookup-tables.json'),
    stopsMetadata: readJson(prefDir, 'stops-metadata.json'),
    routeInfo: readJson(prefDir, 'route-info.json'),
    routeDetails: readJson(prefDir, 'route-details.json'),
    stations: readJson(prefDir, 'stations.json'),
  };
  const merged = mergeIndexedSpotRegions([readJson(prefDir, 'spots-by-station.json')]);
  data.spots = merged.spots;
  data.spotsByStation = merged.spotsByStation;

  const fareCalc = new FareCalculator(data);
  const spotFinder = new SpotFinder(data);

  function findStationId(displayName) {
    const entry = Object.entries(data.stations).find(([, s]) => s.display_name === displayName);
    if (!entry) throw new Error(`基準値の駅が新パイプライン出力のstations.jsonに見つかりません: ${displayName}`);
    return entry[0];
  }

  let mismatchReachable = 0;
  let mismatchSpotsOnly = 0;
  const details = [];

  for (const departure of baseline.departures) {
    const stationId = findStationId(departure.display_name);
    for (const [budgetStr, expected] of Object.entries(departure.budgets)) {
      const budget = parseInt(budgetStr, 10);
      const reachable = await fareCalc.calculateReachable(stationId, budget);
      const spots = await spotFinder.findSpots(reachable);
      const transfer = reachable.filter((r) => r.reachBy === 'transfer').length;
      const actual = { reachable: reachable.length, spots: spots.length, transfer };

      const reachableOk = actual.reachable === expected.reachable;
      const transferOk = expected.transfer === undefined || actual.transfer === expected.transfer;
      const spotsOk = actual.spots === expected.spots;
      const ok = reachableOk && transferOk && spotsOk;

      const line =
        `${ok ? '✅' : '❌'} ${departure.display_name} 往復¥${budget}: ` +
        `到達駅数=${actual.reachable}（基準${expected.reachable}）` +
        (expected.transfer !== undefined ? ` 乗換到達駅数=${actual.transfer}（基準${expected.transfer}）` : '') +
        ` スポット件数=${actual.spots}（基準${expected.spots}）`;
      console.log(line);

      if (!ok) {
        details.push({ departure: departure.display_name, budget, actual, expected });
        if (!reachableOk || !transferOk) mismatchReachable += 1;
        else if (!spotsOk) mismatchSpotsOnly += 1;
      }
    }
  }

  console.log('');
  if (details.length === 0) {
    console.log('✅ 12通りすべて基準値と一致しました（乗換到達駅数の基準がある項目も一致）');
    return;
  }

  console.error(`❌ ${details.length}件で基準値とずれました`);
  if (mismatchReachable > 0) {
    console.error(
      `  ⚠️  到達駅数または乗換到達駅数がずれた項目が${mismatchReachable}件あります。` +
      `Wikidata側の変化ではなく、GTFSパース・運賃計算側の処理の違いを疑ってください。`
    );
  }
  if (mismatchSpotsOnly > 0) {
    console.error(
      `  ℹ️  到達駅数は一致するがスポット件数だけずれた項目が${mismatchSpotsOnly}件あります。` +
      `Wikidata側のデータ変化（記事の増減・sitelinks変動等）の可能性があります。`
    );
  }
  process.exit(1);
}

main().catch((error) => {
  console.error('❌ 比較スクリプト実行エラー:', error);
  process.exit(1);
});
