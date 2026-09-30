/**
 * spot-diff-report.js - ビルドごとのスポット差分レポート
 *
 * 【背景】Wikidataは他者が継続的に編集しているため、config/spot-config.jsonも
 * 除外クエリのコードも一切変えなくても、Wikidata側の分類（P31/P279）が
 * 変わるだけで次のビルドの除外対象が静かに変わりうる（香川で実測：図書館の
 * P279編集により8件が新たに除外された。2026-09-30確認）。
 * 43都道府県分のビルドや、コンテスト審査前の再ビルドでも同じことが起こりうるため、
 * 「気をつける」ではなく前回出力との差分を機械的に検出する仕組みにする。
 */

/**
 * @param {{spotsIndex: string[], spots: Array}|null} previousOutput - 前回ビルドのspots-by-station.json（なければnull）
 * @param {{spotsIndex: string[], spots: Array}} newOutput - 今回ビルドの出力
 * @param {Array<{id: string, name: string, matchedExcludedQids: string[]}>} excludedItems - 今回ビルドで除外統計用に取得した除外項目一覧
 */
export function computeSpotDiff(previousOutput, newOutput, excludedItems) {
  const oldIndex = previousOutput?.spotsIndex || [];
  const newIndex = newOutput.spotsIndex;
  const oldSet = new Set(oldIndex);
  const newSet = new Set(newIndex);

  const excludedById = new Map((excludedItems || []).map((e) => [e.id, e]));

  const added = newIndex
    .filter((qid) => !oldSet.has(qid))
    .map((qid) => {
      const spot = newOutput.spots[newOutput.spotsIndex.indexOf(qid)];
      return { qid, name: spot?.name || '(不明)' };
    });

  const removed = oldIndex
    .filter((qid) => !newSet.has(qid))
    .map((qid) => {
      const idx = oldIndex.indexOf(qid);
      const spot = previousOutput.spots[idx];
      const excluded = excludedById.get(qid);
      return {
        qid,
        name: spot?.name || '(不明)',
        matchedExcludedQids: excluded?.matchedExcludedQids || null,
      };
    });

  const removalRatio = oldIndex.length > 0 ? removed.length / oldIndex.length : 0;

  return {
    hasPrevious: previousOutput !== null,
    previousCount: oldIndex.length,
    newCount: newIndex.length,
    added,
    removed,
    addedCount: added.length,
    removedCount: removed.length,
    removalRatio,
  };
}

/** コンソール表示用にレポートを出力する */
export function logSpotDiff(diff, label) {
  if (!diff.hasPrevious) {
    console.log(`\nℹ️  [${label}] 前回の出力がないため、スポット差分チェックをスキップします（初回ビルド）`);
    return;
  }

  console.log(`\n📐 [${label}] 前回ビルドとのスポット差分（前回${diff.previousCount}件 → 今回${diff.newCount}件）`);
  console.log(`  追加: ${diff.addedCount}件`);
  for (const a of diff.added) {
    console.log(`    + ${a.name} (${a.qid})`);
  }
  console.log(`  削除: ${diff.removedCount}件`);
  for (const r of diff.removed) {
    const reason = r.matchedExcludedQids ? r.matchedExcludedQids.join(', ') : '不明（bbox圏外・取得失敗等の可能性）';
    console.log(`    - ${r.name} (${r.qid}) 除外原因クラス: ${reason}`);
  }
  console.log(`  削除率: ${(diff.removalRatio * 100).toFixed(1)}%（前回${diff.previousCount}件中${diff.removedCount}件）`);
}
