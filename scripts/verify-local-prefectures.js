/**
 * verify-local-prefectures.js - 段階1(c)の本体：複数都道府県の同時ロードをローカルで確認する
 *
 * 【位置づけ】config/published-prefectures.jsonに載っていない（＝まだ公開しない）県も
 * 含めて、隣接県同時ロードの罠（CLAUDE.md「全国一括ビルドはやらない。まず少数県
 * （隣接ペアを必ず含む）で全経路を通してから展開する」）を手元で確認するための
 * 常設スクリプト。docs/dataやpublished-prefectures.jsonには一切触れない。
 *
 * 事前に以下を実行しておくこと（別コマンドなのは、verify-local自体は高速に
 * 繰り返し実行したい一方、generate-site-dataはGTFS由来の派生データを
 * 変換するだけの重い処理ではないため毎回自動実行してもよいが、確認したい
 * 県の組み合わせを呼び出し側が選べるようにするため）：
 *   node scripts/build-pipeline/generate-site-data.js --local-verify 37,16,17
 *
 * 実行内容：
 * 1. 県境の重複スポットQIDチェック：data/site-preview/pref/配下にある全県の
 *    組み合わせについて、spotsIndexが重複するQIDを機械的に抽出する。
 *    段階1の前提条件（CLAUDE.md）で富山・石川の重複として名前ベースで
 *    見込まれていた6件のうち、2026-10-02時点で実際に両県のビルド出力に
 *    残っているのは西茶屋資料館(Q11629456)・中村神社(Q11365871)の2件のみ
 *    （Wikidata側の編集で残り4件に相当する項目が見当たらなくなったため。
 *    詳細はこのファイル末尾のKNOWN_BORDER_QIDSコメント参照）。
 *    これをBORDER_QID_CHECKSとして固定し、回帰検出に使う
 *    （config/regression-baseline.jsonと同じ考え方）。
 * 2. 県境の駅の二重表示チェック：読み込んだ全県の組み合わせについて、
 *    停留所間の最短距離を総当たりで計算する。閾値（1000m、駅クラスタリングの
 *    閾値と同じ）を下回るペアがあれば、二重表示の疑いとして報告する
 *    （失敗にはしない。CLAUDE.mdの「県またぎ駅マージ」が未実装なのは既知のため）。
 * 3. 各県の「県内通し番号0」の駅からの検索：整数インデックス0が
 *    `=== undefined`ではなく`!value`で判定されているとどこかで「なし」に
 *    化けるというCLAUDE.mdの既知の罠を、実際の検索フローで横断的に検出する。
 * 4. 隣接県を同時ロードしたときの検索時間の目安（jsdomのファイル読み込みのみ。
 *    ネットワーク遅延は含まない。回線込みの見積もりはnpm run verify-renderの
 *    サイズ実測と別途計算する）。
 *
 * 使い方: npm run verify-local
 */

import fs from 'fs';
import path from 'path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const previewDir = path.join(rootDir, 'data/site-preview');
const distIndexPath = path.join(rootDir, 'dist/index.html');

/**
 * 2026-10-02時点で確認済みの、富山(16)・石川(17)の県境重複スポット。
 * 名前ベースで富山・石川データ初回ビルド前に見込んでいた6件
 * （西茶屋資料館、野間神社（金沢市玉鉾町）、神田神社（金沢市）、神田神社、
 * 木呂川、中村神社）のうち、ここに載るのは実際にQIDで両県から見つかった
 * ものだけ。残り4件は現在の富山・石川ビルド出力のどちらにも存在しない。
 *
 * 調査結果（Wikidata APIを直接確認、2026-10-02）：
 * - 野間神社（玉鉾町）・神田神社（金沢市）・神田神社（無印）に相当すると
 *   見られる現在のWikidata項目は、Q135194806/Q135194808/Q135194810/
 *   Q135194812（いずれもQIDが1億3500万台＝最近作成）で、"Kamutano/Nomano
 *   Shrine 分社1/分社2"という説明を持つ。P361(part of)がQ11399659
 *   「加賀国の式内社一覧」（神社リスト項目、座標なし、sitelinks=1）を指しており、
 *   神社一覧ページから個別の分社項目へ分割された形跡がある。分割後の個々の
 *   分社項目はsitelinks=0（言語版記事を持たない）で、本アプリの
 *   sitelinks>=10の足切り（config/spot-ranking-config.json）を満たさないため、
 *   除外機構のバグではなく、この閾値どおりの動作として検索結果から漏れている。
 * - 木呂川(Q11518238)は石川(17)側のみに存在し、富山(16)側のbboxには入って
 *   いない（17側の座標36.56076,136.616417は16のbboxの西端付近にあり、
 *   境界の扱い次第で片側にしか入らないことがある）。重複排除の対象には
 *   ならないが、富山・石川いずれから出発しても隣接県を同時ロードするため
 *   検索結果には変わらず現れる。
 * - ローカル確認でdata/derived/pref/16・17のspot-diff-report.jsonも確認したが、
 *   「直近1回のビルドとの比較」のみを保持する設計（履歴を積まない）のため、
 *   段階1(b)ビルド時点からの変化を遡って追うことはできなかった。
 */
const BORDER_QID_CHECKS = [
  { prefA: '16', prefB: '17', qid: 'Q11629456', expectedName: '西茶屋資料館' },
  { prefA: '16', prefB: '17', qid: 'Q11365871', expectedName: '中村神社' },
];

const BORDER_STATION_DISTANCE_WARN_METERS = 1000;

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function requirePreviewData() {
  const prefDir = path.join(previewDir, 'pref');
  if (!fs.existsSync(prefDir) || fs.readdirSync(prefDir).length === 0) {
    console.error(
      '❌ data/site-preview/ が見つかりません。先に以下を実行してください：\n' +
      '   node scripts/build-pipeline/generate-site-data.js --local-verify <都道府県コード,...>\n' +
      '   （例: node scripts/build-pipeline/generate-site-data.js --local-verify 37,16,17）'
    );
    process.exit(1);
  }
  if (!fs.existsSync(distIndexPath)) {
    console.error('❌ dist/index.html が見つかりません。先に npm run bundle を実行してください');
    process.exit(1);
  }
}

function listPrefCodes() {
  return fs.readdirSync(path.join(previewDir, 'pref')).sort();
}

function loadSpotsRegion(prefCode) {
  return JSON.parse(
    fs.readFileSync(path.join(previewDir, 'pref', prefCode, 'spots-by-station.json'), 'utf-8')
  );
}

function loadStations(prefCode) {
  return JSON.parse(
    fs.readFileSync(path.join(previewDir, 'pref', prefCode, 'stations.json'), 'utf-8')
  );
}

/** 1. 県境の重複スポットQIDチェック */
function checkBorderSpots(prefCodes) {
  console.log('\n=== 1. 県境の重複スポットQIDチェック ===');
  if (prefCodes.length < 2) {
    console.log('ℹ️  2県以上が無いためスキップします');
    return true;
  }

  let ok = true;
  for (let i = 0; i < prefCodes.length; i++) {
    for (let j = i + 1; j < prefCodes.length; j++) {
      const [a, b] = [prefCodes[i], prefCodes[j]];
      const regionA = loadSpotsRegion(a);
      const regionB = loadSpotsRegion(b);
      const mapA = new Map(regionA.spotsIndex.map((qid, idx) => [qid, regionA.spots[idx].name]));
      const mapB = new Map(regionB.spotsIndex.map((qid, idx) => [qid, regionB.spots[idx].name]));
      const overlap = [...mapA.keys()].filter((qid) => mapB.has(qid));

      console.log(`--- ${a} × ${b}：重複QID ${overlap.length}件 ---`);
      for (const qid of overlap) {
        const nameA = mapA.get(qid);
        const nameB = mapB.get(qid);
        const mismatch = nameA !== nameB ? ' ⚠️名前不一致' : '';
        console.log(`  ${qid}  ${a}側=${nameA} / ${b}側=${nameB}${mismatch}`);
        if (nameA !== nameB) ok = false;
      }

      for (const check of BORDER_QID_CHECKS) {
        const pairMatches =
          (check.prefA === a && check.prefB === b) || (check.prefA === b && check.prefB === a);
        if (!pairMatches) continue;
        if (overlap.includes(check.qid)) {
          console.log(`  ✅ 既知の県境重複QID ${check.qid}（${check.expectedName}）は今回も両県に存在し、重複排除の対象になっています`);
        } else {
          console.log(
            `  ℹ️  既知の県境重複QID ${check.qid}（${check.expectedName}）が今回は見つかりませんでした` +
            `（Wikidata側の変化の可能性。CLAUDE.mdの既知の現象。失敗扱いにはしません）`
          );
        }
      }
    }
  }
  return ok;
}

/** 2. 県境の駅の二重表示チェック（近接停留所の距離チェック） */
function checkBorderStationDuplicates(prefCodes) {
  console.log('\n=== 2. 県境の駅の二重表示チェック ===');
  if (prefCodes.length < 2) {
    console.log('ℹ️  2県以上が無いためスキップします');
    return true;
  }

  let ok = true;
  for (let i = 0; i < prefCodes.length; i++) {
    for (let j = i + 1; j < prefCodes.length; j++) {
      const [a, b] = [prefCodes[i], prefCodes[j]];
      const stationsA = Object.values(loadStations(a));
      const stationsB = Object.values(loadStations(b));

      let minDist = Infinity;
      let minPair = null;
      const candidates = [];
      for (const sa of stationsA) {
        for (const sb of stationsB) {
          const d = haversineMeters(sa.stop_lat, sa.stop_lon, sb.stop_lat, sb.stop_lon);
          if (d < minDist) {
            minDist = d;
            minPair = [sa.display_name, sb.display_name];
          }
          if (d < BORDER_STATION_DISTANCE_WARN_METERS) {
            candidates.push({ a: sa.display_name, b: sb.display_name, distM: Math.round(d) });
          }
        }
      }

      console.log(`--- ${a} × ${b}：最短距離 ${Math.round(minDist)}m（${minPair?.join(' - ')}） ---`);
      if (candidates.length > 0) {
        console.log(
          `  ⚠️  ${BORDER_STATION_DISTANCE_WARN_METERS}m未満の候補ペアが${candidates.length}件あります` +
          `（同じ場所が別駅として二重に出る可能性。県またぎ駅マージは未実装、CLAUDE.md参照）：`
        );
        candidates.slice(0, 10).forEach((c) => console.log(`    ${c.a} - ${c.b}（${c.distM}m）`));
      } else {
        console.log(`  ✅ ${BORDER_STATION_DISTANCE_WARN_METERS}m未満の候補ペアはありません（現時点では二重表示の実害なし）`);
      }
    }
  }
  return ok;
}

function stubFetch(window) {
  window.fetch = async (url) => {
    const relPath = String(url).replace(/^\//, '').replace(/^data\//, '');
    const filePath = path.join(previewDir, relPath);
    if (!fs.existsSync(filePath)) {
      return { ok: false, status: 404, json: async () => { throw new Error(`stubFetch: ${relPath} not found`); } };
    }
    const text = fs.readFileSync(filePath, 'utf-8');
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  };
}

function stubMatchMedia(window) {
  window.matchMedia = () => ({
    matches: true,
    media: '',
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  });
}

async function waitFor(predicate, timeoutMs, intervalMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

async function waitForSuggestion(doc, window, inputText, exactName, timeoutMs = 8000) {
  const departureInput = doc.getElementById('departure-input');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    departureInput.value = inputText;
    departureInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    const item = [...doc.querySelectorAll('.suggestion-item')].find(
      (el) => el.getAttribute('data-station-name') === exactName
    );
    if (item) return item;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/**
 * 3・4. 指定県の「県内通し番号0」の駅から実際に検索し、クラッシュしないか・
 * 到達駅が出るか・所要時間の目安を測る。
 */
async function searchFromFirstStation(prefCode) {
  const stations = loadStations(prefCode);
  const sortedIds = Object.keys(stations).sort();
  const firstStationName = stations[sortedIds[0]].display_name;

  const html = fs.readFileSync(distIndexPath, 'utf-8');
  const capturedLogs = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('log', (...args) => capturedLogs.push(args.map((a) => String(a)).join(' ')));

  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  stubMatchMedia(window);
  stubFetch(window);
  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.error ? (e.error.stack || e.error.message) : e.message));

  await new Promise((resolve) => {
    const done = () => setTimeout(resolve, 50);
    if (window.document.readyState === 'complete') done();
    else window.addEventListener('load', done);
  });
  const doc = window.document;

  const t0 = Date.now();
  const item = await waitForSuggestion(doc, window, firstStationName, firstStationName);
  if (!item) {
    console.log(`❌ ${prefCode}（${firstStationName}、県内通し番号0）: 出発駅の候補が見つかりません`);
    if (errors.length > 0) console.log('   エラー:', errors);
    window.close();
    return { ok: false };
  }
  item.dispatchEvent(new window.Event('click', { bubbles: true }));
  doc.getElementById('budget-input').value = '1000';
  doc.getElementById('search-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  // 【2026-10-03追記】performSearch()が県データのfetch待ちの間に一時的な
  // 「データを読み込んでいます…」プレースホルダーを結果欄へ挿入するようになったため
  // （main.js参照）、「children.length > 0」だけでは検索完了前のプレースホルダー
  // 挿入を検索完了と誤認する。スポットカードか0件案内文のどちらかが実際に
  // 描画された状態を完了条件にする。
  const rendered = await waitFor(
    () => !!(doc.getElementById('results-list').querySelector('.spot-card') ||
      doc.getElementById('results-list').querySelector('.no-results')),
    15000
  );
  const elapsedMs = Date.now() - t0;

  if (errors.length > 0) {
    console.log(`❌ ${prefCode}（${firstStationName}）: 実行中にエラーが発生しました`);
    errors.forEach((e) => console.log('   ' + e));
    window.close();
    return { ok: false };
  }
  if (!rendered) {
    console.log(`❌ ${prefCode}（${firstStationName}）: 検索がタイムアウトしました`);
    window.close();
    return { ok: false };
  }

  const cards = doc.querySelectorAll('.spot-card').length;
  const loadedLine = capturedLogs.find((l) => /都道府県分のデータをロード/.test(l)) || '';
  console.log(`✅ ${prefCode}（${firstStationName}、県内通し番号0、往復¥1000）: ${elapsedMs}ms、カード${cards}件 ${loadedLine}`);
  window.close();
  return { ok: true, elapsedMs, cards };
}

async function main() {
  requirePreviewData();
  const prefCodes = listPrefCodes();
  console.log(`対象都道府県: ${prefCodes.join(', ')}（data/site-preview/pref/配下）`);

  const spotsOk = checkBorderSpots(prefCodes);
  checkBorderStationDuplicates(prefCodes); // 情報提供のみ、失敗にはしない

  console.log('\n=== 3・4. 県内通し番号0の駅からの検索＋所要時間 ===');
  let searchesOk = true;
  for (const prefCode of prefCodes) {
    const result = await searchFromFirstStation(prefCode);
    if (!result.ok) searchesOk = false;
  }

  if (spotsOk && searchesOk) {
    console.log('\n✅ ローカル複数県検証: 成功');
  } else {
    console.error('\n❌ ローカル複数県検証: 問題が見つかりました（上記参照）');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('❌ 検証スクリプト実行エラー:', error);
  process.exit(1);
});
