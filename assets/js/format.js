/**
 * format.js - 画面に出す数の書き方をそろえる小さな関数
 *
 * 【2026-11-26、78本目、Minami決定】金額は「¥1,000」のように3桁ごとにカンマを入れる。
 * 以前はmain.jsだけにformatThousands()があり、一覧のカード・行き方・マイリスト・共有の文などは
 * 「¥2000」と出ていた（提出の画像に写るため直す）。main.js・route-formatter.js・favorites.jsから使う。
 * カンマを付けるのは表示のときだけ。マイリストの保存データ（roundTripFare）は数のまま保存・比較する。
 *
 * bundle-html.jsは全ファイルを1つのスクリプトにつなぐため、このファイルは使う側より先に並べる。
 */

/** 数字を3桁区切りにする（例: 1740 → "1,740"）。数でないもの（壊れた値）はそのまま文字にする */
export function formatThousands(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('ja-JP') : String(n);
}
