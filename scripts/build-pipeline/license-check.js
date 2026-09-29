/**
 * license-check.js - フィードのライセンスが許可リストに含まれるかを判定する
 *
 * config/license-allowlist.json に列挙された文字列のいずれかを
 * operator.license_label が部分一致で含んでいれば許可する。
 * license_label が未設定（「要確認」等）のフィードは、許可リストの
 * どの文字列とも一致しないため自動的に除外される（安全側に倒す）。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const allowlistPath = path.join(__dirname, '../../config/license-allowlist.json');

let cachedAllowlist = null;
function loadAllowlist() {
  if (!cachedAllowlist) {
    if (!fs.existsSync(allowlistPath)) {
      throw new Error(`ライセンス許可リストが見つかりません: ${allowlistPath}`);
    }
    cachedAllowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf-8')).allowed_license_substrings;
  }
  return cachedAllowlist;
}

/**
 * @param {{license_label?: string}} operator
 * @returns {{ allowed: boolean, matchedSubstring: string|null }}
 */
export function checkLicenseAllowed(operator) {
  const label = operator.license_label || '';
  const allowlist = loadAllowlist();
  const matched = allowlist.find((substring) => label.includes(substring));
  return { allowed: Boolean(matched), matchedSubstring: matched || null };
}
