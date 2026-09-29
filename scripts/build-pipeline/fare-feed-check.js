/**
 * fare-feed-check.js - フィードが使える運賃データを持つかを判定する
 *
 * 【背景】このアプリは予算（交通費）で到達可能駅を絞り込むため、運賃データの
 * ないフィード（例：富山地方鉄道の地鉄市内電車のように、fare_rules.txtが
 * 存在しない／存在しても1件も解決できない）は経路探索には使えても運賃計算に
 * 一切寄与しない。含めても実害はないが、「なぜ運賃が出ないのか」を毎回
 * 調査し直すよりは、ビルド時に機械的に検出して理由付きで除外した方が
 * データの意味が明確になる（CLAUDE.mdの段階1の指示に基づく）。
 */
import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';

/**
 * @param {string} operatorDir - data/raw-gtfs/{operator.id}
 * @returns {{ hasFareData: boolean, reason: string|null }}
 */
export function checkFeedHasFareData(operatorDir) {
  const fareRulesPath = path.join(operatorDir, 'fare_rules.txt');
  const fareAttributesPath = path.join(operatorDir, 'fare_attributes.txt');

  if (!fs.existsSync(fareRulesPath) || !fs.existsSync(fareAttributesPath)) {
    return { hasFareData: false, reason: 'fare_rules.txt または fare_attributes.txt が存在しない' };
  }

  const fareRules = parse(fs.readFileSync(fareRulesPath, 'utf-8'), { bom: true, columns: true });
  const fareAttrs = parse(fs.readFileSync(fareAttributesPath, 'utf-8'), { bom: true, columns: true });

  if (fareRules.length === 0 || fareAttrs.length === 0) {
    return { hasFareData: false, reason: 'fare_rules.txt/fare_attributes.txt の行数が0件' };
  }

  const fareIdSet = new Set(fareAttrs.map((a) => a.fare_id));
  const usableRuleCount = fareRules.filter((rule) => {
    if (!fareIdSet.has(rule.fare_id)) return false;
    const isOd = Boolean(rule.origin_id && rule.destination_id);
    const isUniform = Boolean(rule.route_id && !rule.origin_id && !rule.destination_id);
    return isOd || isUniform;
  }).length;

  if (usableRuleCount === 0) {
    return {
      hasFareData: false,
      reason: 'fare_rules.txtに解決可能な運賃ルール（OD型・均一型のいずれか）が1件もない',
    };
  }

  return { hasFareData: true, reason: null };
}
