/**
 * debug-log.js - 開発・検証用のログ
 *
 * 公開版のコンソールには件数のログを出さない。URLに ?debug=1 を付けたときだけ出す
 * （verify-render・verify-localは0件の見張りにこのログを読むため、?debug=1で開く）。
 * Nodeから読むとき（verify-regression）はwindow・locationが無いので出さない。
 */
const DEBUG_ENABLED =
  typeof window !== 'undefined' && new URLSearchParams(window.location?.search).get('debug') === '1';

export function debugLog(...args) {
  if (DEBUG_ENABLED) console.log(...args);
}
