/**
 * gtfs-diff-report.js - ビルドごとのGTFS構造差分レポート（駅・停留所・路線）
 *
 * 【背景】--forceで香川を再ビルドした際、駅362→364・停留所893→895・路線26→25と
 * 変化していた。原因はことでんバスのフィード更新（2026-10-01ダイヤ改正、
 * feed_versionが「ことでんバス_20260401-20260930」→「ことでんバス_20261001-
 * 20270331」に変化）で、スポットのWikidata側変化とは別の、GTFSデータそのものの
 * 更新だった。この種の変化は到達駅数（回帰チェックの基準値）に影響しうるため、
 * スポットの差分レポート（spot-diff-report.js）と同様、駅・停留所・路線の
 * 追加/削除を名前付きで機械的に検出する。ただしGTFSの正当な更新（ダイヤ改正等）
 * まで失敗にすると通常運用を妨げるため、こちらはゲート（ビルド失敗）にはせず
 * 報告のみとする。
 */

function diffByKey(oldItems, newItems, keyFn, labelFn) {
  const oldMap = new Map(oldItems.map((i) => [keyFn(i), i]));
  const newMap = new Map(newItems.map((i) => [keyFn(i), i]));
  const added = [...newMap.keys()].filter((k) => !oldMap.has(k)).map((k) => labelFn(newMap.get(k)));
  const removed = [...oldMap.keys()].filter((k) => !newMap.has(k)).map((k) => labelFn(oldMap.get(k)));
  return { added, removed, oldCount: oldItems.length, newCount: newItems.length };
}

/**
 * @param {{stations: object, stopsMetadata: Array, routeInfo: object}|null} previous - 前回出力（なければnull）
 * @param {{stations: object, stopsMetadata: Array, routeInfo: object}} current - 今回出力
 */
export function computeGtfsDiff(previous, current) {
  if (!previous) {
    return { hasPrevious: false };
  }

  const oldStations = Object.entries(previous.stations).map(([id, s]) => ({ id, name: s.display_name }));
  const newStations = Object.entries(current.stations).map(([id, s]) => ({ id, name: s.display_name }));
  const stations = diffByKey(oldStations, newStations, (s) => s.id, (s) => s.name);

  const stops = diffByKey(
    previous.stopsMetadata,
    current.stopsMetadata,
    (s) => s.stop_id,
    (s) => `${s.stop_name} (${s.stop_id})`
  );

  const oldRoutes = Object.entries(previous.routeInfo).map(([id, r]) => ({ id, name: r.route_long_name || r.route_short_name || id }));
  const newRoutes = Object.entries(current.routeInfo).map(([id, r]) => ({ id, name: r.route_long_name || r.route_short_name || id }));
  const routes = diffByKey(oldRoutes, newRoutes, (r) => r.id, (r) => r.name);

  return { hasPrevious: true, stations, stops, routes };
}

function logSection(label, section) {
  if (section.added.length === 0 && section.removed.length === 0) {
    console.log(`  ${label}: 変化なし（${section.oldCount}件）`);
    return;
  }
  console.log(`  ${label}: ${section.oldCount}件 → ${section.newCount}件`);
  for (const a of section.added) console.log(`    + ${a}`);
  for (const r of section.removed) console.log(`    - ${r}`);
}

export function logGtfsDiff(diff, label) {
  if (!diff.hasPrevious) {
    console.log(`\nℹ️  [${label}] 前回の出力がないため、GTFS差分チェックをスキップします（初回ビルド）`);
    return;
  }
  console.log(`\n📐 [${label}] 前回ビルドとのGTFS構造差分（駅・停留所・路線）`);
  logSection('駅', diff.stations);
  logSection('停留所', diff.stops);
  logSection('路線', diff.routes);
}
