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
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const spotConfigPath = path.join(__dirname, '../../config/spot-config.json');
const spotConfig = JSON.parse(fs.readFileSync(spotConfigPath, 'utf-8'));
const individualExclusionReasonByQid = new Map(
  (spotConfig.individual_exclusions?.qids || []).map((entry) => [entry.qid, entry.reason])
);

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
      const individualReason = individualExclusionReasonByQid.get(qid);
      return {
        qid,
        name: spot?.name || '(不明)',
        matchedExcludedQids: excluded?.matchedExcludedQids || null,
        individualExclusionReason: individualReason || null,
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
    let reason;
    if (r.individualExclusionReason) {
      reason = `個別除外リスト（理由：${r.individualExclusionReason}）`;
    } else if (r.matchedExcludedQids) {
      reason = `除外原因クラス: ${r.matchedExcludedQids.join(', ')}`;
    } else {
      reason = '原因不明（bbox圏外・取得失敗等の可能性。個別除外リストにも該当なし）';
    }
    console.log(`    - ${r.name} (${r.qid}) ${reason}`);
  }
  console.log(`  削除率: ${(diff.removalRatio * 100).toFixed(1)}%（前回${diff.previousCount}件中${diff.removedCount}件）`);
}

/**
 * P31（instance of）を1つも持たないスポットの一覧（【72】、2026-11-21）。
 *
 * 【背景】除外の仕組みはP31/P279*を起点にしているため、P31が無い項目は
 * どのクラス除外にも当たらず必ず残る。公開中の高松で「八重垣新地」（性風俗街、P31なし）が
 * この経路ですり抜けて検索結果に出ていた。P31が無いだけで除外すると、残すべき史跡・湧き水
 * （高原製粉精米水車場・瓜裂の清水など）まで消えるため、ビルドは止めずに毎回一覧を出し、
 * 人が見て個別除外（individual_exclusions）にするかを決める。
 *
 * @param {Array<{id: string, instanceOfQids: string[]}>} regionItems - generateSpotsForRegion()が返す地域全体の項目
 * @param {{spotsIndex: string[], spots: Array<{name: string, description?: string}>}} normalizedOutput - 停留所に紐づいたスポット
 * @returns {Array<{qid: string, name: string, firstSentence: string}>} QID順
 */
export function listSpotsWithoutInstanceOf(regionItems, normalizedOutput) {
  const noInstanceOf = new Set(
    (regionItems || []).filter((item) => (item.instanceOfQids || []).length === 0).map((item) => item.id)
  );
  return normalizedOutput.spotsIndex
    .map((qid, i) => ({ qid, spot: normalizedOutput.spots[i] }))
    .filter(({ qid }) => noInstanceOf.has(qid))
    .map(({ qid, spot }) => ({ qid, name: spot?.name || '(不明)', firstSentence: firstSentenceOf(spot?.description) }))
    .sort((a, b) => a.qid.localeCompare(b.qid, 'en', { numeric: true }));
}

function firstSentenceOf(text) {
  if (!text) return '';
  const end = text.indexOf('。');
  const sentence = end >= 0 ? text.slice(0, end + 1) : text;
  return sentence.length > 120 ? `${sentence.slice(0, 120)}…` : sentence;
}

/** コンソール表示用。ビルドは止めない（件数と一覧を出すだけ） */
export function logSpotsWithoutInstanceOf(list, label) {
  console.log(`\n👀 [${label}] P31（分類）が1つも無いスポット: ${list.length}件（クラスの除外が効かないため、場所らしくないものが無いか目で確かめる）`);
  for (const s of list) {
    console.log(`    ・${s.name} (${s.qid}) ${s.firstSentence || '（紹介文なし）'}`);
  }
}
