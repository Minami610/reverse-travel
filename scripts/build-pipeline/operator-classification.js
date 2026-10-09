/**
 * operator-classification.js - 「コミュニティバス」の語を使ってよい事業者かどうかの判定
 * （2026-10-10、2本目「便の少ない路線を応援」マーク機能。Minami指示：
 * 「コミュニティバス」の語は、事業者が市町村などのコミュニティバスの場合だけ使う。
 * それ以外は「バス」「路線」とする）。
 *
 * 個別の事業者名をハードコードで列挙せず、feed_info.txtのfeed_publisher_nameの
 * 構造的な特徴（会社の法人格を示す語で終わるか）から機械的に判定する。
 * 実データでの確認（富山・石川・香川、2026-10-10時点）：
 *   「株式会社」で終わる: 富山地方鉄道・加越能バス・万葉線・ことでん・ことでんバス
 *     → いずれも私企業（コミュニティバスではない）
 *   市区町村名・町村の委員会名等で終わる: 上市町・黒部市・滑川市・南砺市・入善町・
 *     小矢部市・高岡市・立山町（表記は「富山県立山町」）・砺波市・朝日町・富山市・
 *     婦中コミュニティバス運営委員会・魚津市・白山市・小松市・野々市市・内灘町
 *     → いずれも市町村運営のコミュニティバス
 * （小松市kibagatasenのfeed_publisher_nameが法人番号の数字列になっている実データ上の
 *  不備があるが、法人格を示す語を含まないため正しく「コミュニティバス」側に分類される）
 *
 * 【2026-10-10修正】endsWith（名前の最後が法人格か）では「株式会社○○バス」のように
 * 法人格が先頭に来る表記を取りこぼしていた（実データに該当は無かったが、一般的な
 * 命名パターンとして起こりうる）。法人格を示す語を名前のどこかに含むか（includes）で
 * 判定するよう修正した。
 */
const COMPANY_MARKERS = ['株式会社', '有限会社', '合同会社', '合資会社', '（株）', '(株)'];

/**
 * @param {string|null|undefined} feedPublisherName - feed_info.txtのfeed_publisher_name
 * @returns {boolean} true=「コミュニティバス」の語を使ってよい（市町村等が運営）
 */
export function isCommunityBusOperator(feedPublisherName) {
  if (!feedPublisherName) return false; // 不明な場合は安全側（私企業扱い）に倒す
  return !COMPANY_MARKERS.some((marker) => feedPublisherName.includes(marker));
}
