/**
 * generate-municipality-table.js - 市区町村→都道府県 対応表の生成
 *
 * 県判定（P131による所在地推定）で、停留所のP131が市区町村レベルまでしか
 * 返らないケース（実測: 富山県で調査対象1,379件中74.8%）を都道府県に変換するための
 * 静的参照テーブルを1回だけ生成する。日本の行政区分は地理的事実として
 * 変化が少ないため、都度クエリせずビルド成果物として持つ。
 *
 * 【重要な教訓（実装時に発見した罠）】
 * 県庁所在地クラスの市（例：富山市・金沢市）は「日本の市」（Q494721）を
 * 直接のP31に持たないことがある（実際は「中核市」「都道府県庁所在地」等の
 * より具体的なクラスのみを持つ）。最初の実装でQ494721だけを指定したところ
 * 富山市・金沢市が丸ごと欠落した。市区町村関連クラスを複数OR条件で
 * 網羅的に指定すること。このテーブルを再生成する際は同じ罠を踏まないよう、
 * 以下のクラスリストを起点に、生成後に必ず「47都道府県すべてに1件以上の
 * 市区町村があるか」のアサーションで検証すること。
 *
 * 使い方: node scripts/build-pipeline/generate-municipality-table.js
 * 出力:
 * - data/derived/national/municipality-to-pref.json
 *   { "富山市": "富山県", "高岡市": "富山県", ... }
 * - data/derived/national/municipality-locations.json
 *   [{ "name": "富山市", "pref": "富山県", "lat": ..., "lon": ... }, ...]
 *   駅の表示名の曖昧さ回避（例：「西町（小松市）」、parse-and-transform.jsの
 *   buildStationClusters()参照）用に、市区町村の代表座標から最近傍の市区町村名を
 *   引くためのテーブル。市区町村の境界ポリゴンは持たないため、これは
 *   「代表点への最近傍」による近似であり、境界付近では隣接市区町村と誤ることが
 *   ありうる（表示名の曖昧さ回避という用途上、実害は限定的と判断）。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '../../data/derived/national');
const outPath = path.join(outDir, 'municipality-to-pref.json');
const locationsOutPath = path.join(outDir, 'municipality-locations.json');

const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
const USER_AGENT = 'reverse-travel/0.1.0 (contact: reverse-travel-maintainer)';

const PREF_NAMES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

// 実データ検証で判明した「市」の具体的サブクラス（政令指定都市・中核市・
// 都道府県庁所在地は「日本の市」とは別に単独でP31に付与されうるため、
// これらもOR条件に含めないと県庁所在地クラスの市が丸ごと欠落する。
const MUNICIPALITY_CLASSES = [
  'Q494721', // 日本の市
  'Q1059478', // 日本の町
  'Q4174776', // 日本の村
  'Q116621544', // 特別区
  'Q515', // 都市（一般。P17=日本で絞るため過検出は限定的）
  'Q1137833', // 中核市
  'Q1749269', // 政令指定都市
  'Q65589340', // 都道府県庁所在地
  'Q18663566', // 日本の廃止市区町村（過去のGTFSデータに残る旧地名対策）
];

/**
 * JSON文字列リテラルの内側にだけ現れる生の制御文字（エスケープされていない
 * 改行・タブ等）を、対応するエスケープ列（\n, \r, \t）またはその他は除去に
 * 置き換える。文字列の外側（トークン区切りの空白）はJSON構造の解釈に
 * 影響するため一切変更しない（単純な正規表現での全置換だと、区切り空白まで
 * 壊してJSON構造そのものを破壊することがあった）。
 */
function sanitizeJsonControlChars(text) {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    if (!inString) {
      if (ch === '"') inString = true;
      result += ch;
      continue;
    }
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      result += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = false;
      result += ch;
      continue;
    }
    if (code <= 0x1f) {
      if (ch === '\n') result += '\\n';
      else if (ch === '\r') result += '\\r';
      else if (ch === '\t') result += '\\t';
      // それ以外の制御文字は表示に影響しないため単純に落とす
      continue;
    }
    result += ch;
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// WDQSは同一クエリでも応答時間が13秒〜51秒〜504タイムアウトまで振れることが
// 既知（CLAUDE.md参照）。本関数の実装中にも、このテーブル生成クエリが
// 3回中2回「JSON.parseに失敗（位置はそのたび異なる）」で落ち、3回目は成功した
// （クエリ・パース処理のどちらも変えていないのに結果だけ変わった）。これは
// WDQS側の応答が時々壊れる既知の不安定さの一種とみなし、他のWikidata呼び出し
// （generate-spots-by-region.js）と同じ考え方でリトライを入れる。
const SPARQL_MAX_RETRIES = 2;
const SPARQL_RETRY_BACKOFF_MS = [5000, 15000];

async function sparqlQuery(query, { post = false } = {}) {
  for (let attempt = 0; attempt <= SPARQL_MAX_RETRIES; attempt += 1) {
    try {
      const params = new URLSearchParams({ query, format: 'json' });
      const response = post
        ? await fetch(WIKIDATA_SPARQL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Accept: 'application/sparql-results+json',
              'User-Agent': USER_AGENT,
            },
            body: params,
            signal: AbortSignal.timeout(90000),
          })
        : await fetch(`${WIKIDATA_SPARQL}?${params}`, {
            headers: { Accept: 'application/sparql-results+json', 'User-Agent': USER_AGENT },
            signal: AbortSignal.timeout(90000),
          });
      if (!response.ok) {
        throw new Error(`SPARQL失敗: HTTP ${response.status} - ${(await response.text()).slice(0, 300)}`);
      }
      // WDQSの一部ラベル文字列に、JSON文字列リテラル内では不正な生の制御文字
      // （エスケープされていない改行・タブ等）が混入することがあり、
      // response.json()（内部でJSON.parseと同じ厳格パーサを使う）が例外を投げる。
      const rawText = await response.text();
      const sanitized = sanitizeJsonControlChars(rawText);
      const data = JSON.parse(sanitized);
      return data.results.bindings;
    } catch (error) {
      if (attempt === SPARQL_MAX_RETRIES) throw error;
      console.warn(
        `   ⚠️  SPARQLクエリ失敗（${error.message}）。${SPARQL_RETRY_BACKOFF_MS[attempt]}ms 待機後にリトライ ${attempt + 1}/${SPARQL_MAX_RETRIES}`
      );
      await sleep(SPARQL_RETRY_BACKOFF_MS[attempt]);
    }
  }
}

export async function generateMunicipalityTable() {
  console.log('🏛️  都道府県自身のQIDを取得中...');
  const prefBindings = await sparqlQuery(`
    PREFIX wdt: <http://www.wikidata.org/prop/direct/>
    PREFIX wd: <http://www.wikidata.org/entity/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?item ?itemLabel WHERE {
      ?item wdt:P31 wd:Q50337.
      ?item rdfs:label ?itemLabel. FILTER(LANG(?itemLabel) = "ja")
    }
  `);
  const table = {};
  for (const b of prefBindings) {
    table[b.itemLabel.value] = b.itemLabel.value;
  }
  console.log(`   ${prefBindings.length}件`);

  console.log('🏘️  市区町村とその所属都道府県・代表座標を取得中...（P131*で祖先を遡るため数十秒かかる場合あり）');
  const classValues = MUNICIPALITY_CLASSES.map((q) => `wd:${q}`).join(' ');
  // P625（代表座標）はOPTIONAL：一部の廃止市区町村等は座標を持たない場合がある。
  // 複数座標を持つ項目があるとCartesian積で行数が水増しされるため
  // （CLAUDE.mdの「GROUP BY/DISTINCTを書かないと水増しされる」の罠）、
  // GROUP BYせず全行取得したうえで、JS側で決定的な選択規則（緯度→経度昇順）で
  // 1件に絞る（SPARQLの行順に依存する「最初の1行」は使わない）。
  const muniBindings = await sparqlQuery(
    `
    PREFIX wdt: <http://www.wikidata.org/prop/direct/>
    PREFIX wd: <http://www.wikidata.org/entity/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?itemLabel ?prefLabel ?coord ?dissolved WHERE {
      VALUES ?class { ${classValues} }
      ?item wdt:P31 ?class.
      ?item wdt:P17 wd:Q17.
      ?item rdfs:label ?itemLabel. FILTER(LANG(?itemLabel) = "ja")
      ?item wdt:P131* ?pref.
      ?pref wdt:P31 wd:Q50337.
      ?pref rdfs:label ?prefLabel. FILTER(LANG(?prefLabel) = "ja")
      OPTIONAL { ?item wdt:P625 ?coord. }
      OPTIONAL { ?item wdt:P576 ?dissolved. }
    }
  `,
    { post: true }
  );
  let resolved = 0;
  // name -> [{lat, lon, dissolved}, ...]（同名で複数座標があれば後で決定的に1件選ぶ）
  const coordCandidatesByName = new Map();
  for (const b of muniBindings) {
    const name = b.itemLabel.value;
    if (table[name] === undefined) resolved += 1;
    table[name] = b.prefLabel.value;

    if (b.coord?.value) {
      const match = b.coord.value.match(/Point\(([^ ]+) ([^ ]+)\)/);
      if (match) {
        const lon = parseFloat(match[1]);
        const lat = parseFloat(match[2]);
        if (!coordCandidatesByName.has(name)) coordCandidatesByName.set(name, []);
        coordCandidatesByName.get(name).push({ lat, lon, dissolved: Boolean(b.dissolved?.value) });
      }
    }
  }
  console.log(`   ${resolved}件（都道府県への変換が確定したもの）`);

  // municipality-locations.json（駅表示名の曖昧さ回避専用）は、廃止日(P576)を
  // 持つ市区町村を候補から除く。municipality-to-pref.json（県判定用）は
  // 「日本の廃止市区町村(Q18663566)」をそのまま含める（過去のGTFSデータに
  // 残る旧地名からの県判定に必要）が、表示名としてユーザーに見せる場合は
  // 「東岩瀬町」のような1940年合併済みの地名は伝わらない（2026-10-01、
  // 富山県のビルドで実際に発生して判明）。
  // 同名で複数候補がある場合、まず現存（非廃止）のものだけに絞り、
  // それでも複数あれば緯度→経度昇順で決定的に1件選ぶ。
  const locations = [];
  let dissolvedExcluded = 0;
  for (const [name, candidates] of coordCandidatesByName.entries()) {
    const active = candidates.filter((c) => !c.dissolved);
    dissolvedExcluded += candidates.length - active.length;
    if (active.length === 0) continue; // 現存する候補がなければ曖昧さ回避には使わない
    active.sort((a, b) => a.lat - b.lat || a.lon - b.lon);
    const { lat, lon } = active[0];
    locations.push({ name, pref: table[name], lat, lon });
  }
  console.log(
    `   ${locations.length}件の市区町村に代表座標あり（駅表示名の曖昧さ回避用。廃止市区町村${dissolvedExcluded}件を除外）`
  );

  // アサーション: 47都道府県すべてに1件以上の市区町村が存在するか検証する。
  // 「日本の市」だけを指定した最初の実装では富山市・金沢市が丸ごと欠落し、
  // このアサーションがあれば即座に気づけたはずだった不具合。
  const countByPref = {};
  for (const pref of Object.values(table)) countByPref[pref] = (countByPref[pref] || 0) + 1;
  const missing = PREF_NAMES.filter((pref) => !countByPref[pref] || countByPref[pref] <= 1);
  if (missing.length > 0) {
    throw new Error(
      `【生成失敗】以下の都道府県に市区町村が1件も見つかりませんでした（都道府県自身のエントリしかない）: ${missing.join(', ')}\n` +
        `MUNICIPALITY_CLASSESに欠けているクラスがある可能性があります。`
    );
  }
  console.log('✅ 47都道府県すべてに1件以上の市区町村を確認');

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(table));
  console.log(`✅ 保存: ${outPath}（${Object.keys(table).length}エントリ）`);

  fs.writeFileSync(locationsOutPath, JSON.stringify(locations));
  console.log(`✅ 保存: ${locationsOutPath}（${locations.length}エントリ）`);

  return table;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  generateMunicipalityTable().catch((error) => {
    console.error('❌ 致命的エラー:', error.message);
    process.exit(1);
  });
}
