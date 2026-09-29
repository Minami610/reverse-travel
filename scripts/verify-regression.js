/**
 * verify-regression.js - 香川県の回帰チェック（npm run verify-regression）
 *
 * 【背景】B（駅ID化・route_type判定・運賃と経路の事業者統一）の過程で、
 * 実装ミスにより「乗り継ぎ到達駅: 0駅」「往復予算内: 190駅」（本来199駅）に
 * なっていたことがあったが、npm run verify-render は✅で通っていた。
 * 気づけたのは一時スクリプトで手動確認したからで、そのスクリプトは
 * 確認後に削除していた。「件数0を成功扱いしない」というCLAUDE.mdのルールを、
 * テスト自体が破っていたことになる。同じ事故を繰り返さないよう、この
 * チェックを常設のnpmスクリプトにする。
 *
 * 確認内容：
 * 1. 香川6駅×往復¥400/¥1000の12通りについて、到達駅数・スポット件数が
 *    config/regression-baseline.json の基準値と完全一致すること
 * 2. 運賃を決めた事業者と表示経路の事業者が食い違う件数が0件であること
 *    （香川の直接到達すべてが対象）
 * 1つでもずれれば exit 1 で失敗する。
 *
 * 基準値を意図的に更新する場合は、このスクリプトで新しい値を確認したうえで
 * config/regression-baseline.json を書き換え、コミットメッセージに
 * 「なぜ変わったか」を書くこと（データ更新／仕様変更等）。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const derivedDir = path.join(rootDir, 'data/derived');
const baselinePath = path.join(rootDir, 'config/regression-baseline.json');

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(derivedDir, name), 'utf-8'));
}

function toUrl(relativePath) {
  return pathToFileURL(path.join(rootDir, relativePath)).href;
}

async function main() {
  console.log('🔁 回帰チェック開始（香川6駅×往復¥400/¥1000）\n');

  if (!fs.existsSync(baselinePath)) {
    throw new Error(`基準値ファイルが見つかりません: ${baselinePath}`);
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));

  // spot-finder.jsがwindow.EMBEDDED_SPOT_RANKING_CONFIGを同期的に参照するため用意する
  global.window = {
    EMBEDDED_SPOT_RANKING_CONFIG: JSON.parse(
      fs.readFileSync(path.join(rootDir, 'config/spot-ranking-config.json'), 'utf-8')
    ),
  };

  const { FareCalculator } = await import(toUrl('assets/js/fare-calculator.js'));
  const { SpotFinder } = await import(toUrl('assets/js/spot-finder.js'));
  const { RouteFormatter } = await import(toUrl('assets/js/route-formatter.js'));
  const { mergeIndexedSpotRegions } = await import(toUrl('assets/js/gtfs-loader.js'));
  const { parseRouteEntry, lookupRouteEntry } = await import(toUrl('assets/js/route-duration.js'));

  const data = {
    fareData: readJson('fare-lookup-tables.json'),
    stopsMetadata: readJson('stops-metadata.json'),
    routeInfo: readJson('route-info.json'),
    routeDetails: readJson('route-details.json'),
    stations: readJson('stations.json'),
  };
  const merged = mergeIndexedSpotRegions([readJson('spots-by-station.json')]);
  data.spots = merged.spots;
  data.spotsByStation = merged.spotsByStation;

  const fareCalc = new FareCalculator(data);
  const spotFinder = new SpotFinder(data);
  const routeFormatter = new RouteFormatter(data.routeInfo, data.routeDetails, data.stations);

  function findStationId(displayName) {
    const entry = Object.entries(data.stations).find(([, s]) => s.display_name === displayName);
    if (!entry) throw new Error(`基準値の駅がstations.jsonに見つかりません: ${displayName}`);
    return entry[0];
  }

  let failures = 0;

  // 1. 12通りの到達駅数・スポット件数
  for (const departure of baseline.departures) {
    const stationId = findStationId(departure.display_name);
    for (const [budgetStr, expected] of Object.entries(departure.budgets)) {
      const budget = parseInt(budgetStr, 10);
      const reachable = await fareCalc.calculateReachable(stationId, budget);
      const spots = await spotFinder.findSpots(reachable);
      const actual = { reachable: reachable.length, spots: spots.length };

      const ok = actual.reachable === expected.reachable && actual.spots === expected.spots;
      console.log(
        `${ok ? '✅' : '❌'} ${departure.display_name} 往復¥${budget}: ` +
        `到達駅数=${actual.reachable}（基準${expected.reachable}） スポット件数=${actual.spots}（基準${expected.spots}）`
      );
      if (!ok) failures += 1;

      // 0件はそもそも基準値も0でない限り失敗（CLAUDE.mdの「0件を成功扱いしない」を
      // このチェック自身が破らないようにする）
      if (actual.reachable === 0 && expected.reachable !== 0) {
        console.log(`   ⚠️  到達駅数が0件です（基準値は${expected.reachable}）`);
      }
    }
  }

  // 2. 運賃事業者と表示経路事業者の食い違い件数（香川全6駅、往復¥1000で確認）
  console.log('\n🔍 運賃事業者と表示経路事業者の食い違いチェック');
  let totalDirect = 0;
  let totalMismatch = 0;
  for (const departure of baseline.departures) {
    const stationId = findStationId(departure.display_name);
    const reachable = await fareCalc.calculateReachable(stationId, 1000);
    for (const station of reachable) {
      if (station.reachBy !== 'direct') continue;
      totalDirect += 1;
      const entry = lookupRouteEntry(data.routeDetails, stationId, station.station_id, station.viaOperator);
      const parsed = parseRouteEntry(entry);
      if (!parsed) continue; // 経路未確定は別問題（このチェックの対象外）
      const displayedRouteId = parsed.type === 'direct' ? parsed.route_id : parsed.legs[0].route_id;
      const displayedOperator = data.routeInfo[displayedRouteId]?.operator_id;
      if (displayedOperator !== station.viaOperator) {
        totalMismatch += 1;
        console.log(
          `   ❌ ${departure.display_name}→${station.display_name}：運賃事業者=${station.viaOperator}, ` +
          `表示経路事業者=${displayedOperator}, ¥${station.fare}`
        );
      }
    }
  }
  console.log(`直接到達${totalDirect}件中、食い違い${totalMismatch}件`);
  if (totalMismatch > 0) failures += 1;

  console.log('');
  if (failures > 0) {
    console.error(`❌ 回帰チェック失敗（${failures}件の不一致）`);
    process.exit(1);
  }
  console.log('✅ 回帰チェック成功: 香川12通り・運賃事業者一致ともに基準どおりです');
}

main().catch((error) => {
  console.error('❌ 回帰チェック実行エラー:', error);
  process.exit(1);
});
