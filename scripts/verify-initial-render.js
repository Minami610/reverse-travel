/**
 * verify-initial-render.js - 実際にレンダリングされ、操作できる状態かを検証する
 *
 * 構文チェック（node --check）や実fetch検証だけでは、
 * 「JSは正常に動作し例外も出ないが、CSSの都合で画面が真っ白/カードが
 * 潰れて見えない」種類の不具合を検出できなかった。そのため、jsdomで
 * dist/index.htmlを実際にロード・実行し、以下の2段階を確認する：
 *
 * 1. 初期表示（検索前）：#search-form とその祖先要素すべてが
 *    display:none になっていないか
 * 2. 検索後：実際に検索フォームを送信して #results-list に
 *    .spot-card が生成されるか、各カードが画像・タイトル・説明文・
 *    要約行・詳細ボタンを持つか、カードの computed style
 *    （display / min-height / overflow）が想定通りかを確認する
 *
 * 【制約】jsdomは実際のレイアウトエンジン（レンダリング）を持たないため、
 * 要素の実ピクセル高さ（offsetHeight等）は検証できない。ここで確認できるのは
 * 「CSSのcomputedStyleとして意図した値（display/min-height/flex-shrink等）が
 * 効いているか」「要素が実際にDOM上に存在するか」まで。実際に何px描画されるかは
 * 引き続きブラウザでの確認が必要。
 * 画面幅（PC/スマホ）はwindow.matchMediaをスタブして両パターンを検証する。
 *
 * 【2026-10-02】県ごとにデータを分割した段階1(c)により、本番ページは起動時・
 * 検索時にdocs/data/配下をfetchする（単一HTMLへの埋め込みをやめた）。jsdomは
 * windowにfetchを実装していないため、docs/配下のファイルをそのまま返す
 * 簡易fetchシム（stubFetch）を用意する。また、window.EMBEDDED_STATIONSが
 * 無くなったため、出発駅の選択はハードコードではなく実際のオートコンプリート
 * （入力→候補クリック）を操作して検証する（waitForSuggestion）。
 */

import fs from 'fs';
import path from 'path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'url';
import { assertBundleFresh, assertSiteDataFresh } from './check-bundle-freshness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const distIndexPath = path.join(__dirname, '../dist/index.html');
const docsDir = path.join(__dirname, '../docs');

/**
 * 公開する都道府県の一覧（config/published-prefectures.json）と、実際にdocs/data/に
 * 出力されている内容が一致するかを確認する。
 *
 * 【背景】026525fで、段階1(b)検証用に手元でビルドした富山・石川
 * （本番には採用しない方針だった）が、docs/data/pref/16・17としてそのまま
 * push・公開されてしまう事故があった。verify-renderが通っていても、この種の
 * 「意図しない公開」は#search-formの表示可否やカード生成とは無関係なため、
 * 既存のチェックでは検出できなかった。このチェックはjsdomを使わず、
 * docs/data/配下のファイルを直接読んで判定する（軽量・高速に失敗させるため）。
 */
function checkPublishedPrefecturesConsistency() {
  console.log('\n=== 公開都道府県の一覧チェック ===');
  const errors = [];

  const publishedConfigPath = path.join(rootDir, 'config/published-prefectures.json');
  const publishedConfig = JSON.parse(fs.readFileSync(publishedConfigPath, 'utf-8'));
  const published = new Set((publishedConfig.published || []).map((c) => String(c).padStart(2, '0')));
  if (published.size === 0) {
    errors.push('config/published-prefectures.json の published が空です');
  }

  // docs/data/pref/ に実在するディレクトリが、公開リストと完全一致するか
  const prefDir = path.join(docsDir, 'data/pref');
  const actualPrefDirs = fs.existsSync(prefDir)
    ? new Set(fs.readdirSync(prefDir).filter((f) => fs.statSync(path.join(prefDir, f)).isDirectory()))
    : new Set();
  const extraDirs = [...actualPrefDirs].filter((c) => !published.has(c));
  const missingDirs = [...published].filter((c) => !actualPrefDirs.has(c));
  if (extraDirs.length > 0) {
    errors.push(`docs/data/pref/ に公開リスト外の都道府県が存在します: ${extraDirs.join(', ')}`);
  }
  if (missingDirs.length > 0) {
    errors.push(`docs/data/pref/ に公開リストの都道府県が見つかりません: ${missingDirs.join(', ')}`);
  }

  // docs/data/national/published-prefectures.json 自体の内容
  const publishedListPath = path.join(docsDir, 'data/national/published-prefectures.json');
  if (!fs.existsSync(publishedListPath)) {
    errors.push('docs/data/national/published-prefectures.json が見つかりません');
  } else {
    const actualList = new Set(JSON.parse(fs.readFileSync(publishedListPath, 'utf-8')));
    const extra = [...actualList].filter((c) => !published.has(c));
    const missing = [...published].filter((c) => !actualList.has(c));
    if (extra.length > 0 || missing.length > 0) {
      errors.push(
        `docs/data/national/published-prefectures.json が公開リストと食い違います` +
        `（余分: ${extra.join(',') || 'なし'} / 不足: ${missing.join(',') || 'なし'}）`
      );
    }
  }

  // 駅一覧（出発駅の選択肢）に、公開リスト外の都道府県コードが混ざっていないか
  const stationIndexPath = path.join(docsDir, 'data/national/station-index.json');
  if (fs.existsSync(stationIndexPath)) {
    const stationIndex = JSON.parse(fs.readFileSync(stationIndexPath, 'utf-8'));
    const codesInStationIndex = new Set(stationIndex.map(([, prefCode]) => String(prefCode).padStart(2, '0')));
    const extraCodes = [...codesInStationIndex].filter((c) => !published.has(c));
    if (extraCodes.length > 0) {
      errors.push(`station-index.json に公開リスト外の都道府県コードが含まれます: ${extraCodes.join(', ')}`);
    }
  }

  // 出典マニフェストの対応地域件数が、公開県数と一致するか（県ごとに重複しない
  // prefecture名が1件ずつ入る設計のため、件数が一致しなければ混入を疑える）
  const dataSourcesPath = path.join(docsDir, 'data/national/data-sources.json');
  if (fs.existsSync(dataSourcesPath)) {
    const manifest = JSON.parse(fs.readFileSync(dataSourcesPath, 'utf-8'));
    const coveragePrefCount = manifest.coverage?.prefectures?.length ?? -1;
    if (coveragePrefCount !== published.size) {
      errors.push(
        `data-sources.json の coverage.prefectures 件数（${coveragePrefCount}）が公開県数（${published.size}）と一致しません` +
        `（実際: ${JSON.stringify(manifest.coverage?.prefectures)}）`
      );
    }
  }

  if (errors.length > 0) {
    console.log('❌ 公開都道府県の一覧に食い違いがあります:');
    errors.forEach((e) => console.log(`  - ${e}`));
    return false;
  }

  console.log(`✅ 公開都道府県の一覧は config/published-prefectures.json（${[...published].join(', ')}）と一致しています`);
  return true;
}

/**
 * window.fetch のシム。gtfs-loader.js・main.js は常に相対パス文字列
 * （例: "data/national/station-index.json"）でfetchを呼ぶため、
 * docsDir を基準にそのままファイルを読む。本番のGitHub Pagesでは
 * docs/ がサイトルートとして配信されるため、相対パスの解決は一致する。
 * ファイルが無い場合（未ビルドの隣接県など）はok:false/404を返し、
 * gtfs-loader.jsのグレースフルスキップ処理をそのまま検証できるようにする。
 */
/**
 * main.jsのpopulateDataSources()が#howto-coverageに描画するはずの文字列を、
 * 実際に生成済みのdocs/data/national/data-sources.jsonから組み立てる
 * （期待値をここにハードコードせず、ビルド成果物から導く）。
 * ファイルが無い場合はnullを返す。
 */
function buildExpectedCoverageText() {
  const dataSourcesPath = path.join(docsDir, 'data/national/data-sources.json');
  if (!fs.existsSync(dataSourcesPath)) return null;
  const manifest = JSON.parse(fs.readFileSync(dataSourcesPath, 'utf-8'));
  const prefectures = manifest.coverage?.prefectures;
  if (!Array.isArray(prefectures) || prefectures.length === 0) return null;
  return `現在は${prefectures.join('・')}に対応しています。対応している路線は「出典の詳細」で確認できます。`;
}

function stubFetch(window, { delayMsForPrefData = 0 } = {}) {
  window.fetch = async (url) => {
    const relPath = String(url).replace(/^\//, '');
    // 県データ（data/pref/配下）の読み込み中表示を検証するため、意図的に
    // 遅延させられるようにする（delayMsForPrefData、checkLoadingStates参照）。
    // 駅一覧（national/配下）は遅延させない＝オートコンプリート自体の検証を妨げない。
    if (delayMsForPrefData > 0 && /^data\/pref\//.test(relPath)) {
      await new Promise((r) => setTimeout(r, delayMsForPrefData));
    }
    const filePath = path.join(docsDir, relPath);
    if (!fs.existsSync(filePath)) {
      return { ok: false, status: 404, json: async () => { throw new Error(`stubFetch: ${relPath} not found`); } };
    }
    const text = fs.readFileSync(filePath, 'utf-8');
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  };
}

/**
 * 出発駅のオートコンプリートを実際に操作し、候補アイテムを取得する。
 * loadStationIndex()（起動時の非同期fetch）が完了するまでは候補が
 * 出ないため、完了するまで入力イベントをポーリングで再送する。
 * @param {string} inputText - 入力欄に入れる文字列（候補を絞り込む）
 * @param {string} exactName - 候補の中からdata-station-nameで一致させる表示名
 */
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

// main.jsのBAND_WIDTH/MAX_BUDGETと同じ値を保つこと（2026-10-06、帯表示導入時に追加）
const BAND_WIDTH = 200;
const MAX_BUDGET_FOR_CHECK = 2000;
/** main.jsのformatBandLabel()と同じ規則（例: budget=1000 → "¥801〜¥1000"） */
function formatBandLabel(budget) {
  return `¥${budget - BAND_WIDTH + 1}〜¥${budget}`;
}

function stubMatchMedia(window, matches) {
  window.matchMedia = (query) => ({
    matches,
    media: query,
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

/** #search-form およびその祖先要素をルートまで辿り、display:noneのものを探す */
function findHiddenAncestors(window, el) {
  const issues = [];
  let node = el;
  while (node && node !== window.document.documentElement) {
    const style = window.getComputedStyle(node);
    if (style.display === 'none') {
      const idPart = node.id ? `#${node.id}` : '';
      const classPart = node.classList.length ? `.${[...node.classList].join('.')}` : '';
      issues.push(`<${node.tagName.toLowerCase()}${idPart}${classPart}> が display:none`);
    }
    node = node.parentElement;
  }
  return issues;
}

async function checkVisible(html, matches, label) {
  const errors = [];
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  stubMatchMedia(window, matches);
  stubFetch(window);

  window.addEventListener('error', (e) => {
    errors.push(e.error ? (e.error.stack || e.error.message) : e.message);
  });

  // main.js は DOMContentLoaded を待って起動する。jsdomは非同期でイベントを
  // 発火するため、発火後にDOMの状態を確認する。出典・使い方の表示内容は
  // fetch（stubFetch経由でdocs/を読む）で非同期に描画されるため、
  // 「読み込み中」のプレースホルダーが消えるまでポーリングで待つ
  // （埋め込みデータ時代の固定50ms待ちでは、fetchのPromise解決前に
  // チェックしてしまう可能性があるため）。
  await new Promise((resolve) => {
    const done = () => setTimeout(resolve, 50);
    if (window.document.readyState === 'complete') {
      done();
    } else {
      window.addEventListener('load', done);
    }
  });

  const doc = window.document;
  await waitFor(() => !/読み込み中/.test(doc.getElementById('app-footer')?.textContent || ''), 5000);

  const searchForm = doc.getElementById('search-form');

  console.log(`\n=== ${label}（matchMedia matches=${matches}） ===`);

  if (errors.length > 0) {
    console.log('⚠️  ページ実行中に発生したエラー:');
    errors.forEach((e) => console.log('  - ' + e));
  }

  if (!searchForm) {
    console.log('❌ #search-form がDOM上に見つかりません');
    window.close();
    return false;
  }

  const searchFormDisplay = window.getComputedStyle(searchForm).display;
  const hiddenAncestors = findHiddenAncestors(window, searchForm);

  console.log(`#search-form の computed display: ${searchFormDisplay}`);
  if (hiddenAncestors.length > 0) {
    console.log('❌ 非表示になっている祖先要素:');
    hiddenAncestors.forEach((i) => console.log('  - ' + i));
  }

  const formOk = searchFormDisplay !== 'none' && hiddenAncestors.length === 0;
  console.log(formOk ? '✅ #search-form は表示状態です' : '❌ #search-form は非表示になっています');

  // 応募条件で必須の表示3点（フッター）が、このレイアウト幅で実際に見える状態か。
  // 「構文が通っても画面は壊れる」ため、DOM存在だけでなく祖先のdisplay:noneも辿る。
  const footer = doc.getElementById('app-footer');
  let footerOk = false;
  if (!footer) {
    console.log('❌ #app-footer（必須表示3点）がDOM上に見つかりません');
  } else {
    const footerDisplay = window.getComputedStyle(footer).display;
    const footerHiddenAncestors = findHiddenAncestors(window, footer);
    const aboutBtn = doc.getElementById('about-data-btn');
    // データ出典部分（#footer-data-sources）はマニフェストからJSが描画するため、
    // 初期HTMLの「読み込み中…」プレースホルダーのまま残っていないかも確認する
    // （残っていれば描画が走らなかった、または失敗した証拠）。
    const footerSourcesRendered = !/読み込み中/.test(footer.textContent);
    footerOk =
      footerDisplay !== 'none' &&
      footerHiddenAncestors.length === 0 &&
      !!aboutBtn &&
      /出典/.test(footer.textContent) &&
      /保証されません/.test(footer.textContent) &&
      footerSourcesRendered;
    if (footerHiddenAncestors.length > 0) {
      console.log('❌ #app-footer の非表示の祖先要素:');
      footerHiddenAncestors.forEach((i) => console.log('  - ' + i));
    }
    console.log(
      footerOk
        ? `✅ #app-footer（出典・免責・問い合わせ導線）は表示状態です: 「${footer.textContent.replace(/\s+/g, ' ').trim()}」`
        : `❌ #app-footer が要件を満たしません（display=${footerDisplay}, about-btn=${!!aboutBtn}, 出典描画=${footerSourcesRendered}）`
    );
  }

  // モーダルは初期状態で非表示、ボタン押下で開くこと
  const modal = doc.getElementById('about-modal');
  let modalOk = false;
  if (!modal) {
    console.log('❌ #about-modal が見つかりません');
  } else {
    const initiallyHidden = window.getComputedStyle(modal).display === 'none';
    doc.getElementById('about-data-btn')?.dispatchEvent(
      new window.Event('click', { bubbles: true })
    );
    const opensOnClick = window.getComputedStyle(modal).display !== 'none';
    const hasContact = /お問い合わせ先/.test(modal.textContent) && /@/.test(modal.textContent);

    // 出典一覧はビルド時生成の data-sources.json から描画される（ハードコード禁止）。
    // 「読み込み中」「準備中」のプレースホルダーのまま残っていないか＝実際に
    // 描画が走ったかを確認する。
    const feedListItems = [...doc.querySelectorAll('#about-feed-list li')];
    const feedListText = doc.getElementById('about-feed-list')?.textContent || '';
    const feedListRendered =
      feedListItems.length > 0 && !/読み込み中|準備中/.test(feedListText);

    modalOk = initiallyHidden && opensOnClick && hasContact && feedListRendered;
    console.log(
      modalOk
        ? `✅ #about-modal は初期非表示→ボタンで開き、問い合わせ先とフィード出典一覧（${feedListItems.length}件）を含みます`
        : `❌ #about-modal 挙動NG（初期非表示=${initiallyHidden}, クリックで開く=${opensOnClick}, 問い合わせ先=${hasContact}, フィード一覧描画=${feedListRendered}）`
    );
  }

  // 「使い方」モーダル（アプリ内マニュアル）も同じ開閉の仕組みで実装している。
  // カバレッジ表記（#howto-coverage）はdata-sources.jsonのcoverageから描画される
  // ため、手書きのプレースホルダー（「読み込み中」）が残っていないかを確認する。
  const howtoModal = doc.getElementById('howto-modal');
  let howtoOk = false;
  if (!howtoModal) {
    console.log('❌ #howto-modal（使い方）が見つかりません');
  } else {
    const initiallyHidden = window.getComputedStyle(howtoModal).display === 'none';
    doc.getElementById('howto-btn')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    const opensOnClick = window.getComputedStyle(howtoModal).display !== 'none';
    const coverageText = doc.getElementById('howto-coverage')?.textContent || '';
    // 対応地域の文言は、docs/data/national/data-sources.jsonのcoverage.prefectures
    // （generate-site-data.jsがconfig/published-prefectures.jsonのarea_notesを
    // 織り込んで生成済み）から、main.jsのpopulateDataSources()と同じ組み立て規則で
    // 期待文字列を作り、ハードコードした文言でなく実データと一致するかを確認する。
    const expectedCoverageText = buildExpectedCoverageText();
    const coverageRendered = expectedCoverageText !== null && coverageText === expectedCoverageText;

    // 予算は往復基準（2026-09-12決定）。「帰りの交通費は含まれません」という
    // 片道基準時代の記述が戻っていないか、往復である旨の説明があるかを確認する。
    const modalText = howtoModal.textContent;
    const roundTripWordingOk = /往復/.test(modalText) && !/帰りの交通費は含まれません/.test(modalText);

    howtoOk = initiallyHidden && opensOnClick && coverageRendered && roundTripWordingOk;
    console.log(
      howtoOk
        ? `✅ #howto-modal は初期非表示→ボタンで開き、対応地域「${coverageText}」・往復基準の説明を含みます`
        : `❌ #howto-modal 挙動NG（初期非表示=${initiallyHidden}, クリックで開く=${opensOnClick}, ` +
          `対応地域=${coverageRendered}[実際:"${coverageText}" / 期待:"${expectedCoverageText}"], 往復表記=${roundTripWordingOk}）`
    );
  }

  window.close();
  return formOk && footerOk && modalOk && howtoOk;
}

/**
 * #results-list が「検索結果の最終状態」（スポットカード、または0件案内文）に
 * なっているかを判定する。
 * 【背景】performSearch()は県データのfetch待ちの間、結果欄に一時的な
 * 「データを読み込んでいます…」プレースホルダー（<p class="loading">）を
 * 挿入するようになった（2026-10-03）。「children.length > 0」や
 * 「innerHTMLが変化したか」だけを完了条件にすると、この一時プレースホルダーの
 * 挿入を検索完了と誤認し、実際の結果が描画される前に判定してしまう
 * （実際にこのチェック自体がこの誤検出を起こした）。
 */
function resultsSettled(doc) {
  const list = doc.getElementById('results-list');
  if (!list) return false;
  return !!(list.querySelector('.spot-card') || list.querySelector('.no-results'));
}

/** 条件が満たされるまでポーリングする（jsdomにはMutationObserverの完全な非同期解決保証がないため） */
async function waitFor(predicate, timeoutMs, intervalMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

/**
 * 実際に検索フォームを送信し、結果カードが生成されるか・
 * 想定した構造とCSSを持つかを確認する。
 */
async function checkResultCards(html) {
  const errors = [];
  // fare-calculator.js が console.log で出す「直接到達駅」「乗り継ぎ到達駅」
  // 「往復予算内」の件数を横取りする。テキスト出力をregexで拾うのではなく、
  // VirtualConsoleの'log'イベントで生の引数を受け取る（文字列化のブレに強い）。
  // 【背景】この3段階のどれかが0件でも、最終的なスポット件数がたまたま
  // 非0になることがあり（実際に段階Bの実装中、乗り継ぎ到達駅が0件のまま
  // 気づかず.spot-card検証だけは通っていた）、「件数0を成功扱いしない」
  // というCLAUDE.mdのルールをverify-render自身が破っていた反省による。
  const capturedLogs = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('log', (...args) => {
    capturedLogs.push(args.map((a) => String(a)).join(' '));
  });
  virtualConsole.forwardTo(console);

  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  stubMatchMedia(window, true);
  stubFetch(window);
  window.addEventListener('error', (e) => {
    errors.push(e.error ? (e.error.stack || e.error.message) : e.message);
  });

  await new Promise((resolve) => {
    const done = () => setTimeout(resolve, 50);
    if (window.document.readyState === 'complete') done();
    else window.addEventListener('load', done);
  });

  const doc = window.document;

  console.log('\n=== 検索実行後の結果カード検証 ===');

  // 実際のユーザー操作を模して検索を実行する（出発駅名を入力→オートコンプリート
  // の候補をクリック→予算を設定→フォーム送信）。段階1(c)でwindow.EMBEDDED_STATIONS
  // が無くなったため、駅IDを直接セットする手段がない。実際の操作フロー自体を
  // 検証できる利点もある（候補クリック時のdataset設定ロジックも通る）。
  const takamatsuItem = await waitForSuggestion(doc, window, '高松築港', '高松築港');
  if (!takamatsuItem) {
    console.log('❌ 検証用の出発駅「高松築港」の候補が見つかりません（駅一覧ロード失敗の可能性）');
    window.close();
    return false;
  }
  takamatsuItem.dispatchEvent(new window.Event('click', { bubbles: true }));
  doc.getElementById('budget-input').value = '1000';
  doc.getElementById('search-form').dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true })
  );

  const rendered = await waitFor(() => resultsSettled(doc), 8000);

  if (errors.length > 0) {
    console.log('⚠️  ページ実行中に発生したエラー:');
    errors.forEach((e) => console.log('  - ' + e));
  }

  if (!rendered) {
    console.log('❌ 検索後も #results-list に子要素が生成されませんでした（タイムアウト）');
    window.close();
    return false;
  }

  // 直接到達・乗り継ぎ到達・往復予算内のいずれかが0件なら失敗にする。
  // 完全一致まではscripts/verify-regression.jsの役割で、ここは「0件を
  // 静かに通さない」という最低限の安全網。
  const stageChecks = [
    { label: '直接到達駅', pattern: /直接到達駅:\s*(\d+)駅/ },
    { label: '乗り継ぎ到達駅', pattern: /乗り継ぎ到達駅:\s*(\d+)駅/ },
    { label: '往復予算内', pattern: /往復予算内.*?:\s*(\d+)駅/ },
  ];
  let stagesOk = true;
  for (const { label, pattern } of stageChecks) {
    const match = capturedLogs.map((l) => l.match(pattern)).find(Boolean);
    const count = match ? parseInt(match[1], 10) : null;
    if (count === null) {
      console.log(`❌ ログから「${label}」の件数を取得できませんでした`);
      stagesOk = false;
    } else if (count === 0) {
      console.log(`❌ 「${label}」が0件です（0件を成功扱いにしない）`);
      stagesOk = false;
    } else {
      console.log(`✅ ${label}: ${count}件`);
    }
  }
  if (!stagesOk) {
    window.close();
    return false;
  }

  const cards = [...doc.querySelectorAll('.spot-card')];
  console.log(`生成された .spot-card 数: ${cards.length}`);

  if (cards.length === 0) {
    console.log('❌ .spot-card が1件も生成されていません');
    window.close();
    return false;
  }

  let ok = true;
  const sampleCount = Math.min(cards.length, 5);
  for (let i = 0; i < sampleCount; i++) {
    const card = cards[i];
    const hasImage = !!card.querySelector('.spot-image');
    const hasTitle = !!card.querySelector('h3');
    const hasDescription = !!card.querySelector('.spot-description');
    const hasSummary = !!card.querySelector('.spot-summary');
    const hasButton = !!card.querySelector('.detail-btn');
    // 予算は往復基準（2026-09-12決定）。カード要約が往復額を表示しているか、
    // 「往復¥」表記の有無で確認する（片道額のまま出戻っていないかの検出）。
    const summaryText = card.querySelector('.spot-summary')?.textContent || '';
    const hasRoundTripLabel = /往復¥\d/.test(summaryText);
    const structureOk = hasImage && hasTitle && hasDescription && hasSummary && hasButton && hasRoundTripLabel;

    const cardStyle = window.getComputedStyle(card);
    const imgStyle = window.getComputedStyle(card.querySelector('.spot-image'));
    // jsdomは実レイアウトを持たないため実ピクセル高さは測れないが、
    // computedStyleとしてmin-height/flex-shrinkの指定自体は確認できる
    const styleOk =
      cardStyle.display !== 'none' &&
      cardStyle.minHeight === '280px' &&
      imgStyle.height === '180px' && // 2026-10-10、デザイン②「写真を大きく出す」で130px→180pxに変更
      imgStyle.flexShrink === '0';

    if (!structureOk || !styleOk) {
      ok = false;
      console.log(`  ❌ カード[${i}]: 構造=${structureOk ? 'OK' : 'NG'} (image=${hasImage},title=${hasTitle},description=${hasDescription},summary=${hasSummary},button=${hasButton},往復表記=${hasRoundTripLabel}) / スタイル=${styleOk ? 'OK' : 'NG'} (display=${cardStyle.display}, min-height=${cardStyle.minHeight}, img.height=${imgStyle.height}, img.flex-shrink=${imgStyle.flexShrink})`);
    }
  }

  console.log(
    ok
      ? `✅ カード${sampleCount}件（先頭から）の構造・スタイルは想定通りです`
      : '❌ 構造またはスタイルが想定と異なるカードがあります'
  );

  // 【2026-10-06 帯表示】結果の見出し（#results-band-heading）が
  // 「往復¥801〜¥1000で行ける場所」の形式で表示されているかを確認する。
  const searchedBudget = 1000; // この検索で使った予算（budget-input.valueと一致させること）
  const bandHeadingEl = doc.getElementById('results-band-heading');
  const bandHeadingText = bandHeadingEl?.textContent || '';
  const expectedBandHeading = `往復${formatBandLabel(searchedBudget)}で行ける場所`;
  const bandHeadingOk = !bandHeadingEl?.hidden && bandHeadingText === expectedBandHeading;
  console.log(
    bandHeadingOk
      ? `✅ 帯の見出しが表示されています: 「${bandHeadingText}」`
      : `❌ 帯の見出しが想定と異なります（実際: "${bandHeadingText}" hidden=${bandHeadingEl?.hidden} / 期待: "${expectedBandHeading}"）`
  );

  // 帯の外（予算−¥200以下、または予算超）の運賃のカードが混ざっていないかを
  // 全カードで確認する（カードの往復¥表記から運賃を読み取る）。
  const bandMin = searchedBudget - BAND_WIDTH;
  const outOfBandCards = cards
    .map((card) => {
      const summaryText = card.querySelector('.spot-summary')?.textContent || '';
      const fareMatch = summaryText.match(/往復¥(\d+)/);
      return fareMatch ? { name: card.querySelector('h3')?.textContent, fare: parseInt(fareMatch[1], 10) } : null;
    })
    .filter((c) => c && (c.fare <= bandMin || c.fare > searchedBudget));
  const bandRangeOk = outOfBandCards.length === 0;
  console.log(
    bandRangeOk
      ? `✅ 全${cards.length}件のカードが帯（${formatBandLabel(searchedBudget)}）の範囲内です`
      : `❌ 帯の範囲外のカードが混ざっています（${outOfBandCards.length}件）: ${JSON.stringify(outOfBandCards.slice(0, 5))}`
  );

  // 到達駅0件（=検索結果0件）のときの案内文を検証する。
  // 【背景】2026-10-01のことでんバス運賃改定で、ＪＲ栗林駅から往復¥400の検索が
  // 実際に0件になった（最低片道運賃が¥200→¥210になり往復¥400を超えたため）。
  // これは値上げの正しい結果で予算の上限・刻み幅は変えないが、「該当するスポットが
  // 見つかりません」とだけ出て終わる画面は不親切なため、「ここからは往復¥Xから
  // 行けます」という案内を出すようにした（main.jsのbuildNoResultsMessage()）。
  // この組み合わせで実際に案内文が出ることを常設検証する。
  const noResultsOk = await checkNoResultsMessage(doc, window);

  window.close();
  return ok && bandHeadingOk && bandRangeOk && noResultsOk;
}

/**
 * ＪＲ栗林駅×往復¥400（2026-10-01のことでんバス運賃改定後は、帯表示でも実際に
 * 帯0件になる組み合わせ）で検索し、以下を確認する（2026-10-06、帯表示への変更に
 * 伴い全面的に書き換え）：
 * 1. 帯の見出し・0件の案内文が、どちらも想定どおりの帯（¥201〜¥400）を表すこと
 * 2. 「往復¥Xで探す」ボタンが1件以上出ること
 * 3. そのボタンを実際にクリックして検索すると、スポットが1件以上出ること
 *    （findNearestBudgetsWithResults()が「言うだけ」の案内をしていないことの確認）
 * 対象駅が見つからない、または（データ側の変化で）たまたま0件でなくなっていた場合は
 * このチェック自体をスキップする（0件になる特定の組み合わせに依存しすぎないため）。
 */
async function checkNoResultsMessage(doc, window) {
  const kuribayashiItem = await waitForSuggestion(doc, window, 'ＪＲ栗林駅', 'ＪＲ栗林駅');
  if (!kuribayashiItem) {
    console.log('ℹ️  0件案内文チェック: 検証用の出発駅「ＪＲ栗林駅」が見つからないためスキップします');
    return true;
  }

  // 直前の検索（高松築港）の結果がすでに#results-listに残っているため、
  // 「内容が変化したか」だけでは「データを読み込んでいます…」の一時
  // プレースホルダーへの変化で早期にtrueになってしまう。「前回から内容が
  // 変化していて、かつ最終状態（スポットカードか0件案内文）になっている」の
  // 両方を新しい検索の完了条件にする（2026-10-03：読み込み中プレースホルダー
  // 導入に伴う修正。古いカードのままの誤判定・プレースホルダーでの早期判定の
  // 両方を防ぐ）。
  const beforeHtml = doc.getElementById('results-list').innerHTML;
  const noResultsBudget = 400;

  kuribayashiItem.dispatchEvent(new window.Event('click', { bubbles: true }));
  doc.getElementById('budget-input').value = String(noResultsBudget);
  doc.getElementById('search-form').dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true })
  );

  const rendered = await waitFor(
    () => doc.getElementById('results-list').innerHTML !== beforeHtml && resultsSettled(doc),
    8000
  );
  if (!rendered) {
    console.log('❌ 0件案内文チェック: 検索後も #results-list の内容が更新されませんでした（タイムアウト）');
    return false;
  }

  const resultsList = doc.getElementById('results-list');
  const hasCards = resultsList.querySelectorAll('.spot-card').length > 0;
  if (hasCards) {
    console.log('ℹ️  0件案内文チェック: ＪＲ栗林駅×往復¥400（帯）が0件でなくなっている（データの変化）ためスキップします');
    return true;
  }

  // 帯の見出しは0件でも表示されたままのはず
  const bandHeadingText = doc.getElementById('results-band-heading')?.textContent || '';
  const expectedBandHeading = `往復${formatBandLabel(noResultsBudget)}で行ける場所`;
  const bandHeadingOk = bandHeadingText === expectedBandHeading;

  const noResultsText = resultsList.querySelector('.no-results')?.textContent || '';
  const expectedMessage = `往復${formatBandLabel(noResultsBudget)}で行ける場所は見つかりませんでした。`;
  const messageOk = noResultsText === expectedMessage;

  console.log(
    bandHeadingOk && messageOk
      ? `✅ 0件案内文チェック: 見出し「${bandHeadingText}」・本文「${noResultsText}」とも想定どおりです`
      : `❌ 0件案内文チェック: 見出し=${bandHeadingOk}["${bandHeadingText}"／期待"${expectedBandHeading}"] 本文=${messageOk}["${noResultsText}"／期待"${expectedMessage}"]`
  );
  if (!bandHeadingOk || !messageOk) return false;

  // 上下いずれか近い「結果がある帯」のボタン（往復¥Xで探す）が出ているか
  const retryButtons = [...resultsList.querySelectorAll('.budget-retry-btn')];
  if (retryButtons.length === 0) {
    console.log('❌ 0件案内文チェック: 「往復¥Xで探す」ボタンが1つも出ていません');
    return false;
  }
  console.log(
    `✅ 0件案内文チェック: 「往復¥Xで探す」ボタンが${retryButtons.length}件出ています` +
    `（${retryButtons.map((b) => b.textContent).join('、')}）`
  );

  // ボタンが案内した予算が「言うだけ」になっていないか、実際にそのボタンを
  // クリックして検索し、スポットが1件以上出ることを確認する（最初のボタンを使う）。
  const retryBudget = retryButtons[0].getAttribute('data-budget');
  const beforeHtml2 = resultsList.innerHTML;
  retryButtons[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  const rendered2 = await waitFor(
    () => doc.getElementById('results-list').innerHTML !== beforeHtml2 && resultsSettled(doc),
    8000
  );
  if (!rendered2) {
    console.log('❌ 0件案内文チェック: ボタン押下後も #results-list の内容が更新されませんでした（タイムアウト）');
    return false;
  }
  const cardsAfterRetry = resultsList.querySelectorAll('.spot-card').length;
  if (cardsAfterRetry === 0) {
    console.log(`❌ 0件案内文チェック: ボタンが案内した往復¥${retryBudget}で実際に検索してもスポットが0件でした（案内が実態と合っていません）`);
    return false;
  }
  console.log(`✅ 0件案内文チェック: ボタンが案内した往復¥${retryBudget}で実際に検索すると${cardsAfterRetry}件のスポットが出ました`);
  return true;
}

/**
 * 県データ（data/pref/配下）の読み込みをわざと遅延させ、検索ボタンを押した
 * 直後（読み込み完了前）に以下を確認する：
 * 1. 「データの読み込みに失敗しました」の警告（alert）が出ないこと
 *    （以前は!this.loader.stationIndexを「失敗」と誤判定していた不具合の再発防止）
 * 2. 結果欄に「データを読み込んでいます…」が表示されること
 * 遅延が解けたあとは、もう一度ボタンを押さなくても検索結果が出ることも確認する。
 */
async function checkLoadingState(html) {
  console.log('\n=== 読み込み中の表示チェック（県データのfetchを意図的に遅延） ===');
  const errors = [];
  const alerts = [];
  const DELAY_MS = 1500;

  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  stubMatchMedia(window, true);
  stubFetch(window, { delayMsForPrefData: DELAY_MS });
  window.alert = (msg) => alerts.push(msg);
  window.addEventListener('error', (e) => errors.push(e.error ? (e.error.stack || e.error.message) : e.message));

  await new Promise((resolve) => {
    const done = () => setTimeout(resolve, 50);
    if (window.document.readyState === 'complete') done();
    else window.addEventListener('load', done);
  });
  const doc = window.document;

  const item = await waitForSuggestion(doc, window, '高松築港', '高松築港');
  if (!item) {
    console.log('❌ 検証用の出発駅「高松築港」の候補が見つかりません');
    window.close();
    return false;
  }
  item.dispatchEvent(new window.Event('click', { bubbles: true }));
  doc.getElementById('budget-input').value = '1000';
  doc.getElementById('search-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  // 遅延中（県データのfetchがまだ解決していない状態）を狙って確認する
  await new Promise((r) => setTimeout(r, 200));
  const duringLoadText = doc.getElementById('results-list').textContent;
  const showsLoadingMessage = /データを読み込んでいます/.test(duringLoadText);
  const noFailureAlertYet = alerts.length === 0;

  console.log(
    showsLoadingMessage
      ? '✅ 読み込み中、結果欄に「データを読み込んでいます…」が表示されています'
      : `❌ 読み込み中の結果欄の表示が想定と異なります（実際: "${duringLoadText.trim()}"）`
  );
  console.log(
    noFailureAlertYet
      ? '✅ 読み込み中に「読み込みに失敗しました」の警告は出ていません'
      : `❌ 読み込み中にもかかわらず警告が出ました: ${JSON.stringify(alerts)}`
  );

  // 遅延が解けるのを待ち、ボタンを再度押さなくても結果が表示されることを確認する
  const rendered = await waitFor(
    () => doc.getElementById('results-list').querySelectorAll('.spot-card').length > 0,
    DELAY_MS + 8000
  );
  console.log(
    rendered
      ? '✅ 読み込み完了後、再度ボタンを押さなくても検索結果が表示されました'
      : '❌ 読み込み完了後も検索結果が表示されませんでした（タイムアウト）'
  );

  if (errors.length > 0) {
    console.log('⚠️  ページ実行中に発生したエラー:');
    errors.forEach((e) => console.log('  - ' + e));
  }

  window.close();
  return showsLoadingMessage && noFailureAlertYet && rendered && errors.length === 0;
}

/**
 * 乗換の表示が事実に合っているかを確認する（2026-10-05追加）：
 * 1. 乗換の注記が「※乗り換えの待ち時間は、運行本数から見積もった目安です」に
 *    なっていること（以前の「※乗換の待ち時間は考慮していません」は、選定ロジック
 *    自体は運行本数から見積もった待ち時間を考慮しているため実態と違っていた）
 * 2. 1本目の降り場と2本目の乗り場が100m以上離れている例があれば、
 *    「乗り場まで約○○m」の表示が出ること。香川に該当例が無い場合は、
 *    そのことを報告する（無いことを失敗にはしない）。
 * ＪＲ栗林駅（往復¥1000）は乗換到達駅89駅・乗換専属の新規スポット29件を持つ
 * ことを別の調査で確認済みのため、検証対象に使う。
 */
async function checkTransferDisplay(html) {
  console.log('\n=== 乗換表示の事実確認 ===');
  const errors = [];
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  stubMatchMedia(window, true);
  stubFetch(window);
  window.addEventListener('error', (e) => errors.push(e.error ? (e.error.stack || e.error.message) : e.message));

  await new Promise((resolve) => {
    const done = () => setTimeout(resolve, 50);
    if (window.document.readyState === 'complete') done();
    else window.addEventListener('load', done);
  });
  const doc = window.document;

  const item = await waitForSuggestion(doc, window, 'ＪＲ栗林駅', 'ＪＲ栗林駅');
  if (!item) {
    console.log('❌ 検証用の出発駅「ＪＲ栗林駅」の候補が見つかりません');
    window.close();
    return false;
  }
  item.dispatchEvent(new window.Event('click', { bubbles: true }));
  doc.getElementById('budget-input').value = '1000';
  doc.getElementById('search-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  const rendered = await waitFor(() => resultsSettled(doc), 8000);
  if (!rendered) {
    console.log('❌ 検索結果が表示されませんでした（タイムアウト）');
    window.close();
    return false;
  }

  const cards = [...doc.querySelectorAll('.spot-card')];
  let disclaimerFound = false;
  let distanceExampleFound = false;
  let distanceExampleText = null;

  for (const card of cards) {
    card.dispatchEvent(new window.Event('click', { bubbles: true }));
    const detailHtml = doc.getElementById('detail-content').innerHTML;
    if (/乗り換えの待ち時間は、運行本数から見積もった目安です/.test(detailHtml)) {
      disclaimerFound = true;
    }
    const match = detailHtml.match(/乗り換え（乗り場まで約(\d+)m）/);
    if (match && !distanceExampleFound) {
      distanceExampleFound = true;
      distanceExampleText = match[0];
    }
  }

  console.log(
    disclaimerFound
      ? '✅ 新しい注記「※乗り換えの待ち時間は、運行本数から見積もった目安です」が表示されています'
      : '❌ 新しい注記が見つかりませんでした（乗換を含む詳細画面が描画されなかった可能性）'
  );
  console.log(
    distanceExampleFound
      ? `✅ 乗り場の距離表示の例が見つかりました: ${distanceExampleText}`
      : 'ℹ️  香川（ＪＲ栗林駅、往復¥1000）には乗り場の距離表示（100m以上）に該当する例がありませんでした'
  );

  if (errors.length > 0) {
    console.log('⚠️  ページ実行中に発生したエラー:');
    errors.forEach((e) => console.log('  - ' + e));
  }

  window.close();
  return disclaimerFound && errors.length === 0;
}

function toEngineModuleUrl(relativePath) {
  return pathToFileURL(path.join(rootDir, relativePath)).href;
}

let engineModulesCache = null;
async function loadEngineModules() {
  if (engineModulesCache) return engineModulesCache;
  global.window = global.window || {};
  window.EMBEDDED_SPOT_RANKING_CONFIG = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'config/spot-ranking-config.json'), 'utf-8')
  );
  engineModulesCache = {
    FareCalculator: (await import(toEngineModuleUrl('assets/js/fare-calculator.js'))).FareCalculator,
    SpotFinder: (await import(toEngineModuleUrl('assets/js/spot-finder.js'))).SpotFinder,
    mergeIndexedSpotRegions: (await import(toEngineModuleUrl('assets/js/gtfs-loader.js'))).mergeIndexedSpotRegions,
  };
  return engineModulesCache;
}

/**
 * 【2026-10-08追加】favorites.js単体のテスト（jsdomを使わず、1つのJSDOMウィンドウの
 * localStorageをglobalThis.localStorageに割り当てて直接importする）。
 * 保存・解除・再読み込み後も残ること、localStorageが例外を出しても
 * 落ちないことを確認する。
 */
async function checkFavoritesStorage() {
  console.log('\n=== お気に入り（favorites.js）の保存・例外耐性チェック ===');
  const dom = new JSDOM('', { url: 'http://localhost/' });
  globalThis.localStorage = dom.window.localStorage;

  const favoritesModule = await import(toEngineModuleUrl('assets/js/favorites.js') + `?t=${Date.now()}`);
  const { loadFavorites, saveFavorites, toggleFavorite, removeFavorite, upsertFavorite, isFavorite } = favoritesModule;

  let ok = true;

  // 1. 保存→解除→再読み込み後も残ること（「再読み込み」はこのテストでは
  //    同じlocalStorageに対してloadFavorites()をもう一度呼ぶことで模す。
  //    実際のページ再読み込みに相当する検証は、検索結果のお気に入りボタンが
  //    クリックのたびにlocalStorageの現在値を見て押下状態を決め直す
  //    checkFavoriteCardToggle()側で行う）。
  const entry = {
    qid: 'Q_TEST_1', name: 'テストスポット', prefCode: '37',
    departureStationId: 'kotoden-bus:019501', departureName: '高松築港',
    roundTripFare: 500, durationMin: 20, savedAt: new Date().toISOString(),
  };
  const savedAfterToggle = toggleFavorite(entry);
  const persistedOnce = loadFavorites().some((f) => f.qid === 'Q_TEST_1');
  ok = ok && savedAfterToggle === true && persistedOnce;
  console.log(
    savedAfterToggle === true && persistedOnce
      ? '✅ 保存→loadFavorites()で読み直しても残っている'
      : `❌ 保存直後の読み直しに失敗（toggle結果=${savedAfterToggle}, 永続化=${persistedOnce}）`
  );

  const removedAfterToggle = toggleFavorite(entry);
  const goneAfterToggle = !loadFavorites().some((f) => f.qid === 'Q_TEST_1');
  ok = ok && removedAfterToggle === false && goneAfterToggle;
  console.log(
    removedAfterToggle === false && goneAfterToggle
      ? '✅ 同じQIDを再度toggleFavorite()すると解除され、読み直しても消えている'
      : '❌ 解除が正しく反映されていない'
  );

  // 2. removeFavorite / upsertFavorite
  toggleFavorite(entry);
  removeFavorite('Q_TEST_1');
  const removedDirect = !loadFavorites().some((f) => f.qid === 'Q_TEST_1');
  upsertFavorite({ ...entry, roundTripFare: 999 });
  upsertFavorite({ ...entry, roundTripFare: 999 }); // 2回呼んでも1件のまま（上書き）
  const afterUpsert = loadFavorites().filter((f) => f.qid === 'Q_TEST_1');
  const upsertOk = afterUpsert.length === 1 && afterUpsert[0].roundTripFare === 999;
  ok = ok && removedDirect && upsertOk;
  console.log(
    removedDirect && upsertOk
      ? '✅ removeFavorite()で削除でき、upsertFavorite()は重複させず内容を更新する'
      : `❌ removeFavorite/upsertFavoriteの挙動が想定と異なる（removeDirect=${removedDirect}, upsert件数=${afterUpsert.length}）`
  );
  removeFavorite('Q_TEST_1');

  // 3. 壊れたJSON・配列でない値・個々の要素が不正な場合に、画面を落とさず空扱いにする
  dom.window.localStorage.setItem('ikeru.favorites.v1', '{this is not json');
  const brokenJsonResult = loadFavorites();
  ok = ok && Array.isArray(brokenJsonResult) && brokenJsonResult.length === 0;
  console.log(
    Array.isArray(brokenJsonResult) && brokenJsonResult.length === 0
      ? '✅ 壊れたJSON（構文エラー）は例外を投げず空配列を返す'
      : '❌ 壊れたJSONの処理に失敗'
  );

  dom.window.localStorage.setItem('ikeru.favorites.v1', '{"not":"an array"}');
  const nonArrayResult = loadFavorites();
  ok = ok && Array.isArray(nonArrayResult) && nonArrayResult.length === 0;
  console.log(
    Array.isArray(nonArrayResult) && nonArrayResult.length === 0
      ? '✅ 配列でない値が保存されていても空配列を返す'
      : '❌ 配列でない値の処理に失敗'
  );

  dom.window.localStorage.setItem(
    'ikeru.favorites.v1',
    JSON.stringify([entry, { qid: 'Q_BROKEN' /* 他の必須項目が欠落 */ }, { ...entry, qid: 'Q_TEST_2' }])
  );
  const partiallyBroken = loadFavorites();
  const skipsInvalidOnly = partiallyBroken.length === 2 && partiallyBroken.every((f) => f.qid !== 'Q_BROKEN');
  ok = ok && skipsInvalidOnly;
  console.log(
    skipsInvalidOnly
      ? '✅ 配列中の壊れた1件だけを読み飛ばし、他の正常な要素は残す'
      : `❌ 壊れた要素の読み飛ばしに失敗（件数=${partiallyBroken.length}）`
  );
  dom.window.localStorage.clear();

  // 4. localStorage自体が例外を投げる環境（プライベートブラウジング等）でも落ちない。
  // 【注意】jsdomのStorage実装は、インスタンスに直接`ls.getItem = fn`で代入しても
  // 実際の呼び出しには反映されない（Storageの仕様上の特殊な内部動作のため、
  // 実測で確認済み）。globalThis.localStorage自体を、例外を投げる素朴な
  // オブジェクトに一時的に差し替えることで確実にシミュレートする。
  const realLocalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem() { throw new Error('storage disabled'); },
    setItem() { throw new Error('storage disabled'); },
    removeItem() { throw new Error('storage disabled'); },
  };

  let threwOnLoad = false;
  let threwOnSave = false;
  try {
    const result = loadFavorites();
    threwOnLoad = !Array.isArray(result);
  } catch {
    threwOnLoad = true;
  }
  try {
    const saveResult = saveFavorites([entry]);
    threwOnSave = saveResult !== false;
  } catch {
    threwOnSave = true;
  }
  ok = ok && !threwOnLoad && !threwOnSave;
  console.log(
    !threwOnLoad && !threwOnSave
      ? '✅ localStorage.getItem/setItemが例外を投げても、loadFavorites/saveFavoritesは例外を外に投げず安全な値を返す'
      : `❌ localStorageの例外がそのまま外に漏れている（load=${threwOnLoad}, save=${threwOnSave}）`
  );
  globalThis.localStorage = realLocalStorage;
  dom.window.localStorage.clear();
  delete globalThis.localStorage;
  dom.window.close();

  return ok;
}

/**
 * jsdomを介さず、docs/data/pref/配下の公開データを直接読んでfare-calculator.js/
 * spot-finder.jsを呼び出す（jsdom側のstubFetchが読むのと同じ実体）。
 * 2026-10-07に追加した帯のスポット単位化の検証用
 * （checkSpotLevelBanding・checkDepartureMismatchGuard参照）。
 */
async function loadEngineForPrefecture(prefCode) {
  const { FareCalculator, SpotFinder, mergeIndexedSpotRegions } = await loadEngineModules();
  function readPrefJson(name) {
    return JSON.parse(fs.readFileSync(path.join(docsDir, 'data/pref', prefCode, name), 'utf-8'));
  }
  const data = {
    fareData: readPrefJson('fare-lookup-tables.json'),
    stopsMetadata: readPrefJson('stops-metadata.json'),
    routeInfo: readPrefJson('route-info.json'),
    routeDetails: readPrefJson('route-details.json'),
    stations: readPrefJson('stations.json'),
  };
  const merged = mergeIndexedSpotRegions([readPrefJson('spots-by-station.json')]);
  data.spots = merged.spots;
  data.spotsByStation = merged.spotsByStation;
  return { fareCalc: new FareCalculator(data), spotFinder: new SpotFinder(data), stations: data.stations };
}

/**
 * 指定駅・指定予算の「真の最安往復運賃」をQIDごとに求める。budgetには検証したい
 * 帯より広い予算（¥2000等）を渡し、「その予算以下で本当に最も安く行ける運賃」を
 * 独立に計算する（jsdomが表示した値と別経路で検証するため）。
 */
async function computeGroundTruthFares(prefCode, stationDisplayName, budget) {
  const { fareCalc, spotFinder, stations } = await loadEngineForPrefecture(prefCode);
  const entry = Object.entries(stations).find(([, s]) => s.display_name === stationDisplayName);
  if (!entry) throw new Error(`computeGroundTruthFares: ${stationDisplayName} が見つかりません`);
  const reachable = await fareCalc.calculateReachable(entry[0], budget);
  const spots = await spotFinder.findSpots(reachable);
  return new Map(spots.map((s) => [s.id, s.source_round_trip_fare]));
}

/** 指定駅・指定予算の帯（予算−¥200より高く、予算以下）のスポットQID集合を独立に求める。 */
async function computeGroundTruthBandQids(prefCode, stationDisplayName, budget) {
  const fares = await computeGroundTruthFares(prefCode, stationDisplayName, budget);
  const bandQids = new Set();
  for (const [qid, fare] of fares) {
    if (fare > budget - 200) bandQids.add(qid);
  }
  return bandQids;
}

/**
 * regression-baseline.jsonから「県コード＋表示名」の基準駅一覧を平らにして取り出す。
 */
function loadBaselineStations() {
  const baseline = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'config/regression-baseline.json'), 'utf-8')
  );
  const stations = [];
  for (const [prefCode, pref] of Object.entries(baseline.prefectures)) {
    for (const dep of pref.departures) {
      stations.push({ prefCode, displayName: dep.display_name });
    }
  }
  return stations;
}

/**
 * 【2026-10-07追加】帯の判定を「駅単位」から「スポット単位」に直したことの検証
 * （Minamiさんが公開ページで発見：TOYAMAキラリ等が往復¥400の帯にも往復¥1000の
 * 帯にも別々の運賃で出ていた）。
 *
 * 【2026-10-07拡張】前回は高松築港・¥1000のみの検証だったが、「富山から出発すると
 * 隣の石川も読み込むため、処理の流れが違う可能性がある」というCoworkの指摘を受け、
 * 回帰テストの基準駅すべて（香川・富山・石川の12駅）×すべての予算（¥200〜¥2000、
 * 19通り）で検証するようにした。
 *
 * 各駅について、computeGroundTruthFares()で「その駅から予算¥2000以下で行ける
 * 全スポットの真の最安往復運賃」を1回だけ計算し、そこから各予算の帯
 * （予算−¥200より高く、予算以下）に属すべきQID集合を機械的に切り出す。
 * この切り出しは定義上、隣の帯と重複しようがない（1つのQIDは必ずちょうど1つの
 * 帯にしか属さない）ため、実際のUI検索結果がこの切り出しと完全一致することを
 * 確認すれば、「隣の帯と重複していない」「表示運賃が最安と一致」の両方を
 * 一度に検証できる。
 */
async function checkSpotLevelBanding(html) {
  console.log('\n=== 帯のスポット単位判定チェック（基準駅12駅 × 予算¥200〜¥2000） ===');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  stubMatchMedia(window, true);
  stubFetch(window);
  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.error ? (e.error.stack || e.error.message) : e.message));

  await new Promise((resolve) => {
    const done = () => setTimeout(resolve, 50);
    if (window.document.readyState === 'complete') done();
    else window.addEventListener('load', done);
  });
  const doc = window.document;

  async function searchAt(budget) {
    const before = doc.getElementById('results-list').innerHTML;
    doc.getElementById('budget-input').value = String(budget);
    doc.getElementById('search-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => doc.getElementById('results-list').innerHTML !== before && resultsSettled(doc), 8000);
    const cards = [...doc.querySelectorAll('.spot-card')];
    const byQid = new Map();
    for (const card of cards) {
      const qid = card.getAttribute('data-spot-id');
      const summaryText = card.querySelector('.spot-summary')?.textContent || '';
      const fareMatch = summaryText.match(/往復¥(\d+)/);
      if (fareMatch) byQid.set(qid, parseInt(fareMatch[1], 10));
    }
    return byQid;
  }

  const stations = loadBaselineStations();
  let overallOk = true;

  for (const { prefCode, displayName } of stations) {
    const item = await waitForSuggestion(doc, window, displayName, displayName);
    if (!item) {
      console.log(`❌ 検証用の出発駅「${displayName}」の候補が見つかりません`);
      overallOk = false;
      continue;
    }
    item.dispatchEvent(new window.Event('click', { bubbles: true }));

    const groundTruth = await computeGroundTruthFares(prefCode, displayName, MAX_BUDGET_FOR_CHECK);
    const issues = [];

    for (let budget = 200; budget <= MAX_BUDGET_FOR_CHECK; budget += 100) {
      const expected = new Map(
        [...groundTruth].filter(([, fare]) => fare > budget - BAND_WIDTH && fare <= budget)
      );
      const actual = await searchAt(budget);

      const missing = [...expected.keys()].filter((qid) => !actual.has(qid));
      const extra = [...actual.keys()].filter((qid) => !expected.has(qid));
      const fareMismatches = [...actual.entries()]
        .filter(([qid, fare]) => expected.has(qid) && expected.get(qid) !== fare)
        .map(([qid, fare]) => ({ qid, displayedFare: fare, trueFare: expected.get(qid) }));

      if (missing.length > 0 || extra.length > 0 || fareMismatches.length > 0) {
        issues.push({ budget, missing, extra, fareMismatches, expectedSize: expected.size, actualSize: actual.size });
      }
    }

    if (issues.length === 0) {
      console.log(`✅ ${displayName}（${prefCode}）: 全19予算（¥200〜¥2000）で帯の範囲・表示運賃とも真の最安運賃と一致しています`);
    } else {
      overallOk = false;
      console.log(`❌ ${displayName}（${prefCode}）: ${issues.length}件の予算で食い違いがあります`);
      for (const issue of issues) {
        console.log(
          `  - ¥${issue.budget}: 期待${issue.expectedSize}件/実際${issue.actualSize}件` +
          (issue.missing.length ? ` / 欠落:${issue.missing.join(',')}` : '') +
          (issue.extra.length ? ` / 余分（隣の帯との重複の疑い）:${issue.extra.join(',')}` : '') +
          (issue.fareMismatches.length ? ` / 運賃不一致:${JSON.stringify(issue.fareMismatches)}` : '')
        );
      }
    }
  }

  if (errors.length > 0) {
    console.log('⚠️  ページ実行中に発生したエラー:');
    errors.forEach((e) => console.log('  - ' + e));
  }

  window.close();
  return overallOk && errors.length === 0;
}

/**
 * 【2026-10-07追加】出発駅の取り違えバグの検証（Minamiさんが公開ページで発見：
 * 「ＪＲ栗林駅」と打ち、候補を選ばずに検索すると、前に選んだ富山駅前のまま
 * 検索されていた＝入力欄の文字を変えても選択済みの駅がdatasetに残っていた）。
 * 1. 候補をクリックして「高松築港」を選び検索する（「前に選んでいた駅」を作る）
 * 2. 候補をクリックせず、入力欄を別の駅名（候補一覧でただ1つに完全一致する
 *    文字列）に書き換えて検索する→取り違えられず、その新しい駅（栗林駅）で
 *    正しく検索されること（card集合が、栗林駅を独立に計算した帯の正解集合と
 *    一致することで確認する。高松築港のまま＝取り違えなら一致しない）
 * 3. 入力欄をどの駅にも完全一致しない文字列に書き換えて検索する→検索されず、
 *    「候補から出発駅を選んでください」の案内が出て、前回の結果が据え置かれること
 */
async function checkDepartureMismatchGuard(html) {
  console.log('\n=== 出発駅の取り違えチェック ===');
  const errors = [];
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  stubMatchMedia(window, true);
  stubFetch(window);
  window.addEventListener('error', (e) => errors.push(e.error ? (e.error.stack || e.error.message) : e.message));

  await new Promise((resolve) => {
    const done = () => setTimeout(resolve, 50);
    if (window.document.readyState === 'complete') done();
    else window.addEventListener('load', done);
  });
  const doc = window.document;
  const departureInput = doc.getElementById('departure-input');

  const first = await waitForSuggestion(doc, window, '高松築港', '高松築港');
  if (!first) {
    console.log('❌ 検証用の出発駅「高松築港」の候補が見つかりません');
    window.close();
    return false;
  }
  first.dispatchEvent(new window.Event('click', { bubbles: true }));
  doc.getElementById('budget-input').value = '1000';
  doc.getElementById('search-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => resultsSettled(doc), 8000);

  // 2. 候補をクリックせず、「ＪＲ栗林駅」（候補一覧で唯一完全一致する文字列）に
  //    書き換えて検索する。inputイベントを発火させて実際のタイピングを模す。
  const beforeSwitchHtml = doc.getElementById('results-list').innerHTML;
  departureInput.value = 'ＪＲ栗林駅';
  departureInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.getElementById('search-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const switched = await waitFor(
    () => doc.getElementById('results-list').innerHTML !== beforeSwitchHtml && resultsSettled(doc),
    8000
  );

  const cardsAfterSwitch = new Set(
    [...doc.querySelectorAll('.spot-card')].map((c) => c.getAttribute('data-spot-id'))
  );
  const expectedKuribayashiQids = await computeGroundTruthBandQids('37', 'ＪＲ栗林駅', 1000);
  const setsEqual =
    cardsAfterSwitch.size === expectedKuribayashiQids.size &&
    [...cardsAfterSwitch].every((qid) => expectedKuribayashiQids.has(qid));
  const exactMatchOk = switched && setsEqual;
  console.log(
    exactMatchOk
      ? `✅ 候補をクリックせず「ＪＲ栗林駅」に書き換えて検索すると、取り違えられずその駅（独立に計算した帯のスポット${expectedKuribayashiQids.size}件と一致）で検索されました`
      : `❌ 出発駅が取り違えられている可能性があります（表示${cardsAfterSwitch.size}件 / 栗林駅の正解${expectedKuribayashiQids.size}件、内容変化=${switched}）`
  );

  // 3. どの駅にも完全一致しない文字列（「ＪＲ」は複数駅に部分一致するが完全一致は
  //    0件）に書き換えて検索する→検索されず案内が出て、直前の結果が据え置かれること
  const beforeMismatchHtml = doc.getElementById('results-list').innerHTML;
  departureInput.value = 'ＪＲ';
  departureInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.getElementById('search-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  const guidanceEl = doc.getElementById('departure-guidance');
  const guidanceShown = guidanceEl && !guidanceEl.hidden && guidanceEl.textContent === '候補から出発駅を選んでください';
  const resultsUnchanged = doc.getElementById('results-list').innerHTML === beforeMismatchHtml;
  const mismatchOk = guidanceShown && resultsUnchanged;
  console.log(
    mismatchOk
      ? '✅ どの駅にも完全一致しない文字列で検索すると、検索されず案内「候補から出発駅を選んでください」が表示され、前回の結果が据え置かれました'
      : `❌ 不一致ケースの挙動が想定と異なります（案内表示=${guidanceShown}, 結果据え置き=${resultsUnchanged}）`
  );

  if (errors.length > 0) {
    console.log('⚠️  ページ実行中に発生したエラー:');
    errors.forEach((e) => console.log('  - ' + e));
  }

  window.close();
  return exactMatchOk && mismatchOk && errors.length === 0;
}

/**
 * 【2026-10-07追加】帯が0件のときの案内文の出し分けを検証する
 * （Minamiさんが公開ページで発見：予算以下に行ける場所はあるのに、この帯だけ
 * 0件のときも「見つかりませんでした」と出ると「どこにも行けない」と誤読される）。
 * 魚津駅前は、行ける範囲の運賃がすべて¥800以下に収まる既知の基準駅
 * （config/regression-baseline.json参照）のため、往復¥1000で検索すると
 * 「この駅からは、往復¥800以下で行ける場所しかありません。」が出るはず。
 */
/**
 * 【2026-10-07拡張】Cowork（Minamiさん）が公開ページで確認した事例は「電鉄魚津駅前」
 * だったが、既存のチェックは回帰基準駅の「魚津駅前」（魚津市民バスの停留所、別の
 * 物理駅）しか見ていなかった。同じ県に似た名前の別駅が複数あるため、報告された
 * 駅名そのものでも検証できるよう駅名を引数化し、両方を呼ぶ。
 */
async function checkPartialBandMessage(html, stationName = '魚津駅前') {
  console.log(`\n=== 帯が0件（予算以下には行ける場所がある場合）の案内文チェック（${stationName}） ===`);
  const errors = [];
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  stubMatchMedia(window, true);
  stubFetch(window);
  window.addEventListener('error', (e) => errors.push(e.error ? (e.error.stack || e.error.message) : e.message));

  await new Promise((resolve) => {
    const done = () => setTimeout(resolve, 50);
    if (window.document.readyState === 'complete') done();
    else window.addEventListener('load', done);
  });
  const doc = window.document;

  const item = await waitForSuggestion(doc, window, stationName, stationName);
  if (!item) {
    console.log(`ℹ️  検証用の出発駅「${stationName}」が見つからないためスキップします`);
    window.close();
    return true;
  }
  item.dispatchEvent(new window.Event('click', { bubbles: true }));
  doc.getElementById('budget-input').value = '1000';
  doc.getElementById('search-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  const rendered = await waitFor(() => resultsSettled(doc), 8000);
  if (!rendered) {
    console.log('❌ 検索結果が表示されませんでした（タイムアウト）');
    window.close();
    return false;
  }

  const resultsList = doc.getElementById('results-list');
  const hasCards = resultsList.querySelectorAll('.spot-card').length > 0;
  if (hasCards) {
    console.log(`ℹ️  ${stationName}×往復¥1000の帯が0件でなくなっている（データの変化）ためスキップします`);
    window.close();
    return true;
  }

  const noResultsText = resultsList.querySelector('.no-results')?.textContent || '';
  const expectedText = 'この駅からは、往復¥800以下で行ける場所しかありません。';
  const ok = noResultsText === expectedText;
  console.log(
    ok
      ? `✅ ${stationName}×往復¥1000で想定どおりの案内文が表示されました: 「${noResultsText}」`
      : `❌ 案内文が想定と異なります（実際: "${noResultsText}" / 期待: "${expectedText}"）`
  );

  if (errors.length > 0) {
    console.log('⚠️  ページ実行中に発生したエラー:');
    errors.forEach((e) => console.log('  - ' + e));
  }

  window.close();
  return ok && errors.length === 0;
}

/**
 * 【2026-10-07追加】検索ボタンの状態変化チェック（Minamiさんが公開ページで発見：
 * 予算を変えても検索ボタンを押すまで前の結果・見出しが残り、予算欄¥800なのに
 * 結果は¥400のまま、という画面になって誤解された）。
 * main.jsのupdateSearchButtonState()が、次の3点を満たすかを確認する：
 * 1. 予算を変える（検索はしない）→ ボタンの文言が「この条件で検索」になり、
 *    強調クラス（search-btn-pending）が付く
 * 2. その状態で検索する → ボタンが既定の文言「検索」・既定の見た目に戻る
 * 3. 検索後、予算を最後に検索した値と同じ値に戻す → ボタンは既定のまま
 *    （一度「この条件で検索」になってから戻しても、強調が残り続けないこと）
 */
async function checkSearchButtonState(html) {
  console.log('\n=== 検索ボタンの状態変化チェック（予算・出発駅が直近の検索条件と違うとき） ===');
  const errors = [];
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  stubMatchMedia(window, true);
  stubFetch(window);
  window.addEventListener('error', (e) => errors.push(e.error ? (e.error.stack || e.error.message) : e.message));

  await new Promise((resolve) => {
    const done = () => setTimeout(resolve, 50);
    if (window.document.readyState === 'complete') done();
    else window.addEventListener('load', done);
  });
  const doc = window.document;
  const searchBtn = doc.getElementById('search-btn');
  const isPending = () => searchBtn.classList.contains('search-btn-pending') && searchBtn.textContent === 'この条件で検索';
  const isDefault = () => !searchBtn.classList.contains('search-btn-pending') && searchBtn.textContent === '検索';

  const item = await waitForSuggestion(doc, window, '高松築港', '高松築港');
  if (!item) {
    console.log('❌ 検証用の出発駅「高松築港」の候補が見つかりません');
    window.close();
    return false;
  }
  item.dispatchEvent(new window.Event('click', { bubbles: true }));
  doc.getElementById('budget-input').value = '1000';
  doc.getElementById('search-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => resultsSettled(doc), 8000);

  const initialOk = isDefault();
  console.log(
    initialOk
      ? '✅ 検索直後はボタンが既定の見た目（「検索」）です'
      : `❌ 検索直後のボタンの見た目が想定と異なります（文言="${searchBtn.textContent}", pending=${searchBtn.classList.contains('search-btn-pending')}）`
  );

  // 1. 予算を変える（検索はしない）→ 強調表示になること
  doc.getElementById('budget-increment').dispatchEvent(new window.Event('click', { bubbles: true }));
  const pendingAfterBudgetChange = isPending();
  console.log(
    pendingAfterBudgetChange
      ? '✅ 予算を変えて検索せずにいると、ボタンが「この条件で検索」（強調表示）になりました'
      : `❌ 予算を変えてもボタンが強調表示になりません（文言="${searchBtn.textContent}", pending=${searchBtn.classList.contains('search-btn-pending')}）`
  );

  // 2. その状態で検索する → 既定の見た目に戻ること
  doc.getElementById('search-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => resultsSettled(doc), 8000);
  const revertedAfterSearch = isDefault();
  console.log(
    revertedAfterSearch
      ? '✅ 検索すると、ボタンが既定の見た目（「検索」）に戻りました'
      : `❌ 検索してもボタンが既定の見た目に戻りません（文言="${searchBtn.textContent}", pending=${searchBtn.classList.contains('search-btn-pending')}）`
  );

  // 3. 予算を変えてから、最後に検索した値（¥1000）に戻す → 既定のままであること
  doc.getElementById('budget-increment').dispatchEvent(new window.Event('click', { bubbles: true }));
  doc.getElementById('budget-decrement').dispatchEvent(new window.Event('click', { bubbles: true }));
  const revertedAfterUndo = isDefault();
  console.log(
    revertedAfterUndo
      ? '✅ 予算を変えても、最後に検索した値に戻すとボタンは既定のままです'
      : `❌ 最後に検索した値に戻してもボタンが強調表示のままです（文言="${searchBtn.textContent}", pending=${searchBtn.classList.contains('search-btn-pending')}）`
  );

  if (errors.length > 0) {
    console.log('⚠️  ページ実行中に発生したエラー:');
    errors.forEach((e) => console.log('  - ' + e));
  }

  window.close();
  return initialOk && pendingAfterBudgetChange && revertedAfterSearch && revertedAfterUndo && errors.length === 0;
}

/**
 * 【2026-10-08追加】カードの☆（マイリスト保存）ボタンの保存・解除と、
 * ヘッダーの件数バッジ・詳細画面側の☆ボタンへの反映を確認する。
 */
async function checkFavoriteCardToggle(html) {
  console.log('\n=== カードの☆（マイリスト保存）トグルチェック ===');
  const errors = [];
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  stubMatchMedia(window, true);
  stubFetch(window);
  window.addEventListener('error', (e) => errors.push(e.error ? (e.error.stack || e.error.message) : e.message));

  await new Promise((resolve) => {
    const done = () => setTimeout(resolve, 50);
    if (window.document.readyState === 'complete') done();
    else window.addEventListener('load', done);
  });
  const doc = window.document;

  const item = await waitForSuggestion(doc, window, '高松築港', '高松築港');
  if (!item) {
    console.log('❌ 検証用の出発駅「高松築港」の候補が見つかりません');
    window.close();
    return false;
  }
  item.dispatchEvent(new window.Event('click', { bubbles: true }));
  doc.getElementById('budget-input').value = '1000';
  doc.getElementById('search-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => resultsSettled(doc), 8000);

  const firstCard = doc.querySelector('.spot-card');
  if (!firstCard) {
    console.log('❌ カードが1件も生成されていません');
    window.close();
    return false;
  }
  const favBtn = firstCard.querySelector('.favorite-btn');
  const spotId = firstCard.getAttribute('data-spot-id');

  favBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  const activeAfterFirstClick = favBtn.classList.contains('favorite-btn-active');
  const countAfterFirstClick = doc.getElementById('mylist-count')?.textContent;
  console.log(
    activeAfterFirstClick && countAfterFirstClick === '1'
      ? '✅ ☆を押すとカードが押下状態になり、ヘッダーの件数が1になりました'
      : `❌ ☆を押しても反映されません（active=${activeAfterFirstClick}, count=${countAfterFirstClick}）`
  );

  // 詳細画面を開き、同じスポットの☆が保存済み状態で表示されるか
  // 【2026-10-09修正】Minamiさんの指示で文言・aria-labelを変更：「削除」という語は
  // マイリスト画面の×ボタンだけに使うため、詳細画面は「保存済み」「マイリストに保存」
  // （aria-labelは「マイリストから外す」）を使う。
  firstCard.dispatchEvent(new window.Event('click', { bubbles: true }));
  const detailFavBtn = doc.querySelector('.detail-favorite-btn');
  const detailShowsActive = !!detailFavBtn?.classList.contains('favorite-btn-active') &&
    detailFavBtn?.textContent.trim() === '保存済み' &&
    detailFavBtn?.getAttribute('aria-label') === 'マイリストから外す';
  console.log(
    detailShowsActive
      ? '✅ 詳細画面でも同じスポットが「保存済み」として表示されます（aria-labelは「マイリストから外す」）'
      : `❌ 詳細画面の☆ボタンに保存状態が反映されていません（文言="${detailFavBtn?.textContent.trim()}", aria-label="${detailFavBtn?.getAttribute('aria-label')}"）`
  );

  // 詳細画面の☆を押して解除
  detailFavBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  const countAfterRemove = doc.getElementById('mylist-count')?.textContent;
  const detailShowsInactive = detailFavBtn.textContent.trim() === 'マイリストに保存' &&
    detailFavBtn.getAttribute('aria-label') === 'マイリストに保存';
  console.log(
    countAfterRemove === '0' && detailShowsInactive
      ? '✅ 詳細画面から解除すると、件数が0に戻り文言も「マイリストに保存」に戻ります'
      : `❌ 詳細画面からの解除が反映されません（count=${countAfterRemove}, 文言="${detailFavBtn.textContent.trim()}"）`
  );

  const allOk = activeAfterFirstClick && countAfterFirstClick === '1' && detailShowsActive &&
    countAfterRemove === '0' && detailShowsInactive;

  if (errors.length > 0) {
    console.log('⚠️  ページ実行中に発生したエラー:');
    errors.forEach((e) => console.log('  - ' + e));
  }

  window.close();
  return allOk && errors.length === 0;
}

/**
 * 【2026-10-08追加】共有リンク（?spot=...）で、現在の予算の帯の外にある
 * スポットを開けることを確認する（Minamiさんの判断：共有リンクは帯で絞らず、
 * 出発駅から上限¥2000で届くスポットの中からQIDで探す）。
 * 高松築港×ドングリランド（Q11323429、往復¥1740）を使う。初期予算（¥500）の
 * 帯には入らないが、開けること・予算欄が¥1800（¥100刻みの帯の上端）に
 * 揃うこと・一覧にもこのスポットが含まれることを確認する。
 */
async function checkSharedSpotBandBypass(html) {
  console.log('\n=== 共有リンク：帯の外のスポットを開けるかのチェック ===');
  const errors = [];
  const qid = 'Q11323429';
  const sid = 'kotoden-bus:019501';
  const url = `http://localhost/?spot=${qid}&pref=37&sid=${encodeURIComponent(sid)}&dep=${encodeURIComponent('高松築港')}`;
  const dom = new JSDOM(html, { url, runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  stubMatchMedia(window, true);
  stubFetch(window);
  window.addEventListener('error', (e) => errors.push(e.error ? (e.error.stack || e.error.message) : e.message));

  await new Promise((resolve) => {
    const done = () => setTimeout(resolve, 50);
    if (window.document.readyState === 'complete') done();
    else window.addEventListener('load', done);
  });
  const doc = window.document;

  const opened = await waitFor(
    () => doc.getElementById('app-layout')?.getAttribute('data-view') === 'detail',
    10000
  );
  if (!opened) {
    console.log('❌ 共有リンクを開いても詳細画面になりませんでした（タイムアウト）');
    window.close();
    return false;
  }

  const detailHeading = doc.querySelector('#detail-content h2')?.textContent;
  const budgetValue = doc.getElementById('budget-input')?.value;
  const showsCorrectSpot = detailHeading === 'ドングリランド';
  const budgetAligned = budgetValue === '1800'; // ceil(1740/100)*100
  console.log(
    showsCorrectSpot
      ? '✅ 初期予算（¥500）の帯の外にあるスポットでも、共有リンクから直接詳細が開きました'
      : `❌ 想定したスポットの詳細が開いていません（実際の見出し="${detailHeading}"）`
  );
  console.log(
    budgetAligned
      ? `✅ 予算欄がそのスポットの帯の上端（¥${budgetValue}）に揃いました`
      : `❌ 予算欄が想定と異なります（実際: ¥${budgetValue} / 期待: ¥1800）`
  );

  // 「← 一覧に戻る」で、このスポットを含む一覧に戻れること
  doc.getElementById('back-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  const backToList = doc.getElementById('app-layout')?.getAttribute('data-view') === 'results';
  const cardIncluded = !!doc.querySelector(`.spot-card[data-spot-id="${qid}"]`);
  console.log(
    backToList && cardIncluded
      ? '✅ 「← 一覧に戻る」で、このスポットを含む一覧に戻れました'
      : `❌ 一覧に戻ってもこのスポットが含まれていません（戻った=${backToList}, 含まれる=${cardIncluded}）`
  );

  if (errors.length > 0) {
    console.log('⚠️  ページ実行中に発生したエラー:');
    errors.forEach((e) => console.log('  - ' + e));
  }

  window.close();
  return showsCorrectSpot && budgetAligned && backToList && cardIncluded && errors.length === 0;
}

/**
 * 【2026-10-08追加】共有リンクのsid（station_id）が実際と食い違っていても、
 * depの駅名が県内で一意に一致すれば解決できることを確認する
 * （駅の再ビルドでstation_idが変わりうる場合のフォールバック経路）。
 */
async function checkSharedSpotSidMismatch(html) {
  console.log('\n=== 共有リンク：sidが食い違っていても駅名で解決できるかのチェック ===');
  const errors = [];
  const qid = 'Q11323429';
  const wrongSid = 'kotoden-bus:999999'; // 実在しないstation_id
  const url = `http://localhost/?spot=${qid}&pref=37&sid=${encodeURIComponent(wrongSid)}&dep=${encodeURIComponent('高松築港')}`;
  const dom = new JSDOM(html, { url, runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  stubMatchMedia(window, true);
  stubFetch(window);
  window.addEventListener('error', (e) => errors.push(e.error ? (e.error.stack || e.error.message) : e.message));

  await new Promise((resolve) => {
    const done = () => setTimeout(resolve, 50);
    if (window.document.readyState === 'complete') done();
    else window.addEventListener('load', done);
  });
  const doc = window.document;

  const opened = await waitFor(
    () => doc.getElementById('app-layout')?.getAttribute('data-view') === 'detail',
    10000
  );
  const detailHeading = doc.querySelector('#detail-content h2')?.textContent;
  const ok = opened && detailHeading === 'ドングリランド';
  console.log(
    ok
      ? '✅ sidが実在しなくても、駅名（高松築港）の完全一致で解決して詳細が開きました'
      : `❌ sid不一致時のフォールバックに失敗しました（開いた=${opened}, 見出し="${detailHeading}"）`
  );

  if (errors.length > 0) {
    console.log('⚠️  ページ実行中に発生したエラー:');
    errors.forEach((e) => console.log('  - ' + e));
  }

  window.close();
  return ok && errors.length === 0;
}

/**
 * 【2026-10-08追加】共有リンクの駅名が県内で複数の駅に一致する（曖昧な）場合、
 * エラー文言を出さず通常のトップ画面のままになることを確認する。
 * 公開中3県には実際に同名駅の重複が無いため（本文中で件数を報告済み）、
 * station-index.jsonのfetch結果に合成の重複エントリを注入して再現する。
 */
async function checkSharedSpotAmbiguousName(html) {
  console.log('\n=== 共有リンク：同じ名前の駅が複数あるときトップ画面になるかのチェック ===');
  const errors = [];
  const DUPLICATE_NAME = 'テスト重複駅';
  const url = `http://localhost/?spot=Q11323429&pref=37&dep=${encodeURIComponent(DUPLICATE_NAME)}`;
  const dom = new JSDOM(html, { url, runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  stubMatchMedia(window, true);
  // 通常のstubFetchに加えて、station-index.jsonだけ合成の重複エントリを2件追加する
  window.fetch = async (reqUrl) => {
    const relPath = String(reqUrl).replace(/^\//, '');
    if (relPath === 'data/national/station-index.json') {
      const original = JSON.parse(fs.readFileSync(path.join(docsDir, relPath), 'utf-8'));
      const withDuplicates = [...original, [DUPLICATE_NAME, 37, 0], [DUPLICATE_NAME, 37, 1]];
      return { ok: true, status: 200, json: async () => withDuplicates };
    }
    const filePath = path.join(docsDir, relPath);
    if (!fs.existsSync(filePath)) {
      return { ok: false, status: 404, json: async () => { throw new Error(`not found: ${relPath}`); } };
    }
    return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(filePath, 'utf-8')) };
  };
  window.addEventListener('error', (e) => errors.push(e.error ? (e.error.stack || e.error.message) : e.message));

  await new Promise((resolve) => {
    const done = () => setTimeout(resolve, 50);
    if (window.document.readyState === 'complete') done();
    else window.addEventListener('load', done);
  });
  const doc = window.document;

  // 「詳細画面にならず、通常のトップ画面のまま」であることの確認。
  // エラー文言（alert等）を出さないことも確認したいが、jsdomのwindow.alertは
  // 既定で例外を投げるため、呼ばれていたらここで検出できる。
  let alertCalled = false;
  window.alert = () => { alertCalled = true; };
  await new Promise((r) => setTimeout(r, 500)); // handleInitialUrl()の完了を待つ

  const view = doc.getElementById('app-layout')?.getAttribute('data-view');
  const hasResultsClass = doc.getElementById('app-layout')?.classList.contains('has-results');
  const isTopScreen = view !== 'detail' && !hasResultsClass;
  console.log(
    isTopScreen && !alertCalled
      ? '✅ 同名駅が複数あるときは詳細画面を開かず、エラー文言も出さず通常のトップ画面のままです'
      : `❌ 想定と異なります（data-view=${view}, has-results=${hasResultsClass}, alert呼び出し=${alertCalled}）`
  );

  if (errors.length > 0) {
    console.log('⚠️  ページ実行中に発生したエラー:');
    errors.forEach((e) => console.log('  - ' + e));
  }

  window.close();
  return isTopScreen && !alertCalled && errors.length === 0;
}

/**
 * 【2026-10-08追加】出発地の異なる項目が混ざった共有リスト（?list=...）を
 * 開けることを確認する（高松築港発のドングリランド＋富山駅前発のTOYAMAキラリ）。
 */
async function checkSharedListMixedDeparture(html) {
  console.log('\n=== 共有リスト：出発地の違う項目が混ざっていても開けるかのチェック ===');
  const errors = [];
  const items = [
    { qid: 'Q11323429', prefCode: '37', stationId: 'kotoden-bus:019501' },
    { qid: 'Q21060996', prefCode: '16', stationId: 'chitetsu.chitetsubus:101_01' },
  ];
  // 実際のbuildListShareUrl()と同じ関数を使ってURLを組み立てる（手で組み立てると、
  // URLSearchParams.set()が行う二重エンコードを再現できず、station_idに含まれる
  // コロンが区切り文字と区別できなくなる食い違いが実際に起きた）。
  const { buildListShareUrl } = await import(toEngineModuleUrl('assets/js/favorites.js'));
  const url = buildListShareUrl('http://localhost/', items);
  const dom = new JSDOM(html, { url, runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  stubMatchMedia(window, true);
  stubFetch(window);
  window.addEventListener('error', (e) => errors.push(e.error ? (e.error.stack || e.error.message) : e.message));

  await new Promise((resolve) => {
    const done = () => setTimeout(resolve, 50);
    if (window.document.readyState === 'complete') done();
    else window.addEventListener('load', done);
  });
  const doc = window.document;

  const modalOpened = await waitFor(() => doc.getElementById('shared-list-modal')?.hidden === false, 10000);
  if (!modalOpened) {
    console.log('❌ 共有されたリストのモーダルが開きませんでした');
    window.close();
    return false;
  }
  const rendered = await waitFor(() => (doc.getElementById('shared-list-body')?.textContent || '').includes('ドングリランド'), 10000);
  const bodyText = doc.getElementById('shared-list-body')?.textContent || '';
  const bothShown = bodyText.includes('ドングリランド') && bodyText.includes('TOYAMAキラリ');
  console.log(
    rendered && bothShown
      ? '✅ 出発地の異なる2件（高松築港発・富山駅前発）とも、共有されたリストに表示されました'
      : `❌ 混在リストの表示に失敗しました（本文: "${bodyText.replace(/\s+/g, ' ').trim().slice(0, 200)}"）`
  );

  if (errors.length > 0) {
    console.log('⚠️  ページ実行中に発生したエラー:');
    errors.forEach((e) => console.log('  - ' + e));
  }

  window.close();
  return bothShown && errors.length === 0;
}

/**
 * compute-service-frequency.js の便数計算ロジックを、合成GTFSデータ（一時ディレクトリに
 * calendar.txt等を実際に書き出す）で検証する（2026-10-10、2本目「便の少ない路線を
 * 応援」マーク機能。Minami指示：「合成データで、区間をまたぐ便の数え方、行きと
 * 帰りの少ない方、calendar_datesの運休日・臨時便の反映を確かめる」）。
 *
 * 代表日（祝日でない水曜日）はjp-holidays.jsの実関数で算出し、テスト側でハード
 * コードしない（本番ロジックと食い違う日付を使って見かけ上だけ通るのを防ぐため）。
 */
async function checkServiceFrequencyComputation() {
  console.log('\n=== 便数計算（compute-service-frequency.js）の合成データ検証 ===');
  const os = await import('os');
  const { findFirstNonHolidayWeekdayOnOrAfter } = await import(toEngineModuleUrl('scripts/build-pipeline/jp-holidays.js'));
  const { augmentRouteDetailsWithFrequency } = await import(toEngineModuleUrl('scripts/build-pipeline/compute-service-frequency.js'));

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freq-test-'));
  const operatorId = 'testop';
  const opDir = path.join(tmpRoot, operatorId);
  fs.mkdirSync(opDir, { recursive: true });

  const feedStartDate = '20260302'; // 月曜（2026年3月は大型連休が無く、祝日探索の検証に適する）
  const repWed = findFirstNonHolidayWeekdayOnOrAfter(feedStartDate, 3);

  fs.writeFileSync(path.join(opDir, 'feed_info.txt'),
    'feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date\n' +
    `テスト事業者,http://example.com,ja,${feedStartDate},20261231\n`);

  fs.writeFileSync(path.join(opDir, 'stops.txt'),
    'stop_id,stop_name,stop_lat,stop_lon\n' +
    ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].map((id, i) => `${id},stop${id},34.${String(i).padStart(3, '0')},134.${String(i).padStart(3, '0')}\n`).join(''));

  fs.writeFileSync(path.join(opDir, 'routes.txt'),
    'route_id,route_short_name,route_long_name,route_type\n' +
    'X,,RouteX,3\nY,,RouteY,3\nW,,RouteW,3\nV,,RouteV,3\nG,,RouteG,3\nH,,RouteH,3\n');

  fs.writeFileSync(path.join(opDir, 'trips.txt'),
    'route_id,trip_id,service_id\n' +
    'X,tripX1,MF\n' +
    'Y,tripY1,MF\n' +
    'W,tripW1,TueFri\n' +
    'V,tripV_out1,MF\nV,tripV_out2,MF\n' +
    'V,tripV_in1,MF\n' +
    'G,tripG1,MF_G\n' +
    'H,tripH1,ADHOC_H\n');

  fs.writeFileSync(path.join(opDir, 'stop_times.txt'),
    'trip_id,stop_id,stop_sequence,arrival_time,departure_time,pickup_type\n' +
    'tripX1,A,1,08:00:00,08:00:00,0\ntripX1,B,2,08:10:00,08:10:00,0\n' +
    'tripY1,A,1,09:00:00,09:00:00,0\ntripY1,B,2,09:10:00,09:10:00,0\n' +
    'tripW1,C,1,08:00:00,08:00:00,0\ntripW1,D,2,08:10:00,08:10:00,0\n' +
    'tripV_out1,E,1,08:00:00,08:00:00,0\ntripV_out1,F,2,08:10:00,08:10:00,0\n' +
    'tripV_out2,E,1,10:00:00,10:00:00,0\ntripV_out2,F,2,10:10:00,10:10:00,0\n' +
    'tripV_in1,F,1,09:00:00,09:00:00,0\ntripV_in1,E,2,09:10:00,09:10:00,0\n' +
    'tripG1,G,1,08:00:00,08:00:00,0\ntripG1,H,2,08:10:00,08:10:00,0\n' +
    // H線はI→J（G線のG→Hとは別区間にする：運休日と臨時便を同じ区間で重ねると
    // 「運休で0便になったG線」を「同じ日に走った臨時便」が穴埋めしてしまい、
    // 2つの検証が互いを打ち消し合うため、独立した区間に分ける）
    'tripH1,I,1,08:00:00,08:00:00,0\ntripH1,J,2,08:10:00,08:10:00,0\n');

  fs.writeFileSync(path.join(opDir, 'calendar.txt'),
    'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n' +
    `MF,1,1,1,1,1,0,0,${feedStartDate},20261231\n` +
    `TueFri,0,1,0,0,1,0,0,${feedStartDate},20261231\n` +
    `MF_G,1,1,1,1,1,0,0,${feedStartDate},20261231\n`
    // ADHOC_Hはcalendar.txtに行を持たない（calendar_dates.txtのADDのみで運行＝臨時便の典型パターン）
  );

  fs.writeFileSync(path.join(opDir, 'calendar_dates.txt'),
    'service_id,date,exception_type\n' +
    `MF_G,${repWed},2\n` + // 運休日：代表水曜だけG線（G→H）を運休にする
    `ADHOC_H,${repWed},1\n` // 臨時便：H線（I→J）は代表水曜だけ特別運行
  );

  const stopIdToStationId = new Map(
    ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].map((id) => [`${operatorId}:${id}`, `${operatorId}:${id}`])
  );

  // routeDetails: X/Yが同じ区間(A→B)を別route_idで担う（route_idをまたぐ合算の検証）、
  // Wは火・金のみ、VはE→Fの行き(2便)とF→Eの帰り(1便)で非対称、
  // G→Hは運休日（代表水曜だけ運休）、I→Jは臨時便（代表水曜だけ特別運行）の検証用
  const routeDetails = {
    [`${operatorId}:A`]: { [`${operatorId}:B`]: { [operatorId]: [`${operatorId}:X`, 10] } },
    [`${operatorId}:C`]: { [`${operatorId}:D`]: { [operatorId]: [`${operatorId}:W`, 10] } },
    [`${operatorId}:E`]: {
      [`${operatorId}:F`]: { [operatorId]: [`${operatorId}:V`, 10] },
    },
    [`${operatorId}:F`]: {
      [`${operatorId}:E`]: { [operatorId]: [`${operatorId}:V`, 10] },
    },
    [`${operatorId}:G`]: { [`${operatorId}:H`]: { [operatorId]: [`${operatorId}:G`, 10] } },
    [`${operatorId}:I`]: { [`${operatorId}:J`]: { [operatorId]: [`${operatorId}:H`, 10] } },
  };

  const result = augmentRouteDetailsWithFrequency(routeDetails, tmpRoot, stopIdToStationId);
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  let ok = true;

  // 1. 区間をまたぐ便の数え方：A→Bはroute_id X・Yどちらも同じ日に通るため合計2便
  //    （fareデータ上は「X線の経路」として解決されるが、便数は同一事業者内でroute_idを
  //    またいで合算する設計のため、X単体の1便ではなく2便になるはず）
  const abEntry = result.routeDetails[`${operatorId}:A`][`${operatorId}:B`][operatorId];
  const abTripCount = abEntry[abEntry.length - 3];
  const abOk = abTripCount === 2;
  ok = ok && abOk;
  console.log(abOk ? '✅ route_idをまたぐ合算：A→Bが2便（X線1便+Y線1便）' : `❌ route_idをまたぐ合算に失敗（期待2便、実際${abTripCount}便）`);

  // 2. 曜日ビットフラグ：C→D（W線）は火・金のみ運行 → dayCode=0b10010=18（bit1=火, bit4=金）
  const cdEntry = result.routeDetails[`${operatorId}:C`][`${operatorId}:D`][operatorId];
  const cdDayCode = cdEntry[cdEntry.length - 2];
  const cdOk = cdDayCode === 0b10010;
  ok = ok && cdOk;
  console.log(cdOk ? '✅ 曜日ビットフラグ：火・金のみ運行がdayCode=18として正しく出る' : `❌ 曜日ビットフラグが想定外（期待18、実際${cdDayCode}）`);

  // 3. 行き・帰りの少ない方：E→F（2便）・F→E（1便）→ どちらのエントリも1便が採用される
  const efEntry = result.routeDetails[`${operatorId}:E`][`${operatorId}:F`][operatorId];
  const feEntry = result.routeDetails[`${operatorId}:F`][`${operatorId}:E`][operatorId];
  const efTripCount = efEntry[efEntry.length - 3];
  const feTripCount = feEntry[feEntry.length - 3];
  const minOk = efTripCount === 1 && feTripCount === 1;
  ok = ok && minOk;
  console.log(minOk ? '✅ 行き・帰りの少ない方：E⇔Fとも帰り(1便)が採用される' : `❌ 行き帰りの最小値採用に失敗（E→F=${efTripCount}, F→E=${feTripCount}、期待は両方1）`);

  // 4. calendar_datesの運休日：G→H（G線、代表水曜だけ運休）→ 水曜のbitは立たず、他の平日で解決される
  const ghEntry = result.routeDetails[`${operatorId}:G`][`${operatorId}:H`][operatorId];
  const ghDayCode = ghEntry[ghEntry.length - 2];
  const wedBitOff = (ghDayCode & (1 << 2)) === 0; // bit2=水
  const stillWeekday = ghDayCode >= 0 && ghDayCode <= 31;
  const cancelOk = wedBitOff && stillWeekday;
  ok = ok && cancelOk;
  console.log(cancelOk
    ? '✅ calendar_datesの運休日：代表水曜の運休が反映され、水曜のビットが立たない'
    : `❌ 運休日の反映に失敗（dayCode=${ghDayCode}）`);

  // 5. calendar_datesの臨時便：I→J（H線、calendar.txtに行を持たずADD例外のみで
  //    代表水曜だけ運行）→ 水曜のbitだけが立ち、便数1で解決される
  const ijEntry = result.routeDetails[`${operatorId}:I`][`${operatorId}:J`][operatorId];
  const ijTripCount = ijEntry[ijEntry.length - 3];
  const ijDayCode = ijEntry[ijEntry.length - 2];
  const adhocOk = ijTripCount === 1 && ijDayCode === 0b00100; // bit2=水のみ
  ok = ok && adhocOk;
  console.log(adhocOk
    ? '✅ calendar_datesの臨時便：calendar.txtに行が無くADD例外のみの便が、その日だけ正しく解決される'
    : `❌ 臨時便の反映に失敗（tripCount=${ijTripCount}, dayCode=${ijDayCode}）`);

  console.log(ok ? '（この合成データ検証は本番のdata/derived/docsには一切影響しません）' : '');
  return ok;
}

/**
 * 便数まわりの表示用ロジック（route-duration.jsのformatDayLabel/operatorLabelWord/
 * estimateTripFrequency）を合成データで検証する。応援マークの線（3便）ちょうど・
 * その上下、曜日が限られる区間の文言、土休日のみの文言、コミュニティバス/バス/路線の
 * 呼び分けを確認する（2026-10-10、Minami指示）。
 */
async function checkFrequencyDisplayLogic() {
  console.log('\n=== 便数の表示ロジック（route-duration.js）の合成データ検証 ===');
  const { estimateTripFrequency, formatDayLabel, operatorLabelWord } = await import(toEngineModuleUrl('assets/js/route-duration.js'));

  let ok = true;

  // 1. 曜日の文言
  const labelChecks = [
    [31, '平日'],
    [32, '土休日'],
    [0b10010, '火・金のみ'], // bit1=火, bit4=金
    [0b00001, '月のみ'],
  ];
  for (const [code, expected] of labelChecks) {
    const actual = formatDayLabel(code);
    const pass = actual === expected;
    ok = ok && pass;
    console.log(pass ? `✅ formatDayLabel(${code}) === "${expected}"` : `❌ formatDayLabel(${code})が「${expected}」ではなく「${actual}」`);
  }

  // 2. 応援マークの線（3便）ちょうど・その上下 → main.jsのbuildFrequencyDisplay()と
  //    同じ比較式（tripCount <= maxTrips）で境界を確認する
  const maxTrips = 3;
  const boundaryChecks = [[2, true], [3, true], [4, false]];
  for (const [tripCount, expectedEligible] of boundaryChecks) {
    const actualEligible = tripCount <= maxTrips;
    const pass = actualEligible === expectedEligible;
    ok = ok && pass;
    console.log(pass
      ? `✅ ${tripCount}便/線${maxTrips}便 → バッジ対象=${expectedEligible}`
      : `❌ ${tripCount}便/線${maxTrips}便の判定が想定と異なる`);
  }

  // 3. コミュニティバス／バス／路線の呼び分け
  const routeInfo = {
    communityBusRoute: { route_type: '3', is_community_operator: true },
    privateBusRoute: { route_type: '3', is_community_operator: false },
    railRoute: { route_type: '1', is_community_operator: false },
  };
  const wordChecks = [
    ['communityBusRoute', 'コミュニティバス'],
    ['privateBusRoute', 'バス'],
    ['railRoute', '路線'],
  ];
  for (const [routeId, expected] of wordChecks) {
    const actual = operatorLabelWord(routeInfo, routeId);
    const pass = actual === expected;
    ok = ok && pass;
    console.log(pass ? `✅ operatorLabelWord(${routeId}) === "${expected}"` : `❌ operatorLabelWord(${routeId})が「${expected}」ではなく「${actual}」`);
  }

  // 4. estimateTripFrequency：直行・事業者をまたぐ乗換（行き・帰りの少ない方は
  //    compute-service-frequency.js側で確定済みの値をそのまま引くだけだが、
  //    reachBy='transfer'のとき2エントリのうち小さい方を選ぶ分岐はフロント側の責務）
  const routeDetails = {
    dep: { mid: { op1: ['routeA', 10, 5, 31, 0] }, dest: { op1: ['routeB', 10, 2, 31, 1] } },
    mid: { dest: { op2: ['routeC', 10, 8, 31, 0] } },
  };
  const directStation = { reachBy: 'direct', station_id: 'dest', viaOperator: 'op1' };
  const directFreq = estimateTripFrequency(routeDetails, 'dep', directStation);
  const directOk = directFreq?.tripCount === 2 && directFreq?.demandCount === 1;
  ok = ok && directOk;
  console.log(directOk ? '✅ estimateTripFrequency：直行区間の便数・予約制数を正しく引ける' : `❌ 直行区間の便数解決に失敗（${JSON.stringify(directFreq)}）`);

  const transferStation = { reachBy: 'transfer', transferAt: 'mid', station_id: 'dest', legOperators: ['op1', 'op2'] };
  const transferFreq = estimateTripFrequency(routeDetails, 'dep', transferStation);
  // dep→mid(op1)=5便、mid→dest(op2)=8便 → 少ない方の5便が採用される
  const transferOk = transferFreq?.tripCount === 5;
  ok = ok && transferOk;
  console.log(transferOk ? '✅ estimateTripFrequency：事業者をまたぐ乗換で少ない方の便数が採用される' : `❌ 乗換便数の最小値採用に失敗（${JSON.stringify(transferFreq)}）`);

  return ok;
}

/**
 * 共有文（favorites.jsのbuildSpotShareText）が、市町村名の有無・便数情報の有無で
 * 正しく文面を組み立てる／省略することを確認する（2026-10-10、Minami指示：
 * 「市町村が無いときは括弧ごと省く」）。
 */
async function checkShareTextMunicipalityAndFrequency() {
  console.log('\n=== 共有文の市町村名・便数の有無による組み立てチェック ===');
  const { buildSpotShareText } = await import(toEngineModuleUrl('assets/js/favorites.js'));

  let ok = true;

  const withBoth = buildSpotShareText('テスト地', '出発駅', 500, 20, 'http://example.com/x', '○○市', '平日1日3便の路線です。');
  const withBothOk = withBoth === 'テスト地（○○市）／出発駅からバスで往復¥500、約20分。／平日1日3便の路線です。／http://example.com/x';
  ok = ok && withBothOk;
  console.log(withBothOk ? '✅ 市町村・便数ともありのときの文面' : `❌ 市町村・便数ともありの文面が想定と異なる: "${withBoth}"`);

  const withoutMunicipality = buildSpotShareText('テスト地', '出発駅', 500, 20, 'http://example.com/x', null, '平日1日3便の路線です。');
  const withoutMunicipalityOk = withoutMunicipality.startsWith('テスト地／') && !withoutMunicipality.includes('（');
  ok = ok && withoutMunicipalityOk;
  console.log(withoutMunicipalityOk ? '✅ 市町村が無いとき、括弧ごと省かれる' : `❌ 市町村なし時の省略に失敗: "${withoutMunicipality}"`);

  const withoutFrequency = buildSpotShareText('テスト地', '出発駅', 500, 20, 'http://example.com/x', '○○市', null);
  const withoutFrequencyOk = withoutFrequency === 'テスト地（○○市）／出発駅からバスで往復¥500、約20分。／http://example.com/x';
  ok = ok && withoutFrequencyOk;
  console.log(withoutFrequencyOk ? '✅ 便数情報が無いとき、その行ごと省かれる（1本目までと同じ文面に戻る）' : `❌ 便数なし時の省略に失敗: "${withoutFrequency}"`);

  return ok;
}

/**
 * operator-classification.js（コミュニティバス判定）を検証する（2026-10-10、
 * endsWith→includesへの修正に伴うテスト）。
 * 1. 「株式会社○○バス」のように法人格が先頭に来る表記でも私企業と判定されること
 *    （修正前のendsWithでは見落としていたケース）。
 * 2. 公開中3県の全事業者で、修正前後の判定結果が変わらないこと
 *    （data/derived/pref/配下のdata-sources.jsonから実際のfeed_publisher_nameを読む）。
 */
async function checkOperatorClassification() {
  console.log('\n=== コミュニティバス判定（operator-classification.js）の検証 ===');
  const { isCommunityBusOperator } = await import(toEngineModuleUrl('scripts/build-pipeline/operator-classification.js'));

  let ok = true;

  // 1. 法人格が先頭に来るケース（endsWithでは取りこぼしていた）
  const prefixCases = [
    ['株式会社〇〇バス', false],
    ['有限会社△△交通', false],
    ['（株）□□観光バス', false],
    ['(株)××タクシー', false],
    ['〇〇市', true],
    ['△△町営バス運営委員会', true],
  ];
  for (const [name, expected] of prefixCases) {
    const actual = isCommunityBusOperator(name);
    const pass = actual === expected;
    ok = ok && pass;
    console.log(pass
      ? `✅ isCommunityBusOperator("${name}") === ${expected}`
      : `❌ isCommunityBusOperator("${name}")が${expected}ではなく${actual}`);
  }

  // 2. 公開中3県の全事業者で判定結果が変わらないこと
  const publishedConfigPath = path.join(rootDir, 'config/published-prefectures.json');
  const published = JSON.parse(fs.readFileSync(publishedConfigPath, 'utf-8')).published || [];
  let totalOperators = 0;
  for (const code of published) {
    const codeStr = String(code).padStart(2, '0');
    const dataSourcesPath = path.join(rootDir, 'data/derived/pref', codeStr, 'data-sources.json');
    if (!fs.existsSync(dataSourcesPath)) {
      console.log(`  ⚠️  都道府県コード${codeStr}: data-sources.jsonが見つからないためスキップ`);
      continue;
    }
    const routeInfoPath = path.join(rootDir, 'data/derived/pref', codeStr, 'route-info.json');
    const manifest = JSON.parse(fs.readFileSync(dataSourcesPath, 'utf-8'));
    const routeInfo = JSON.parse(fs.readFileSync(routeInfoPath, 'utf-8'));
    for (const feed of manifest.feeds || []) {
      totalOperators += 1;
      const expected = isCommunityBusOperator(feed.feed_publisher_name);
      // route-info.json側に実際に書き込まれた値（ビルド時にbuild-prefecture.jsが
      // 同じ関数で計算した値）と一致するかを確認する＝「今と変わらない」の直接比較
      const actualRoute = Object.values(routeInfo).find((r) => r.operator_id === feed.operator_id);
      if (!actualRoute) continue;
      const pass = actualRoute.is_community_operator === expected;
      ok = ok && pass;
      if (!pass) {
        console.log(`❌ ${feed.operator_id}（${feed.feed_publisher_name}）: route-info.json=${actualRoute.is_community_operator} / 現在の関数=${expected}`);
      }
    }
  }
  console.log(ok ? `✅ 公開中${published.length}都道府県・${totalOperators}事業者で判定結果が変化していません` : '❌ 判定結果が変化した事業者があります（上記参照）');

  return ok;
}

async function main() {
  if (!fs.existsSync(distIndexPath)) {
    console.error('dist/index.html が見つかりません。先に npm run bundle を実行してください');
    process.exit(1);
  }
  assertBundleFresh('verify-render');
  assertSiteDataFresh('verify-render');
  const publishedOk = checkPublishedPrefecturesConsistency();
  const html = fs.readFileSync(distIndexPath, 'utf-8');

  const desktopOk = await checkVisible(html, true, 'PC幅相当');
  const mobileOk = await checkVisible(html, false, 'スマホ幅相当');
  const cardsOk = await checkResultCards(html);
  const loadingStateOk = await checkLoadingState(html);
  const transferDisplayOk = await checkTransferDisplay(html);
  const spotLevelBandingOk = await checkSpotLevelBanding(html);
  const departureMismatchOk = await checkDepartureMismatchGuard(html);
  const partialBandMessageOk = await checkPartialBandMessage(html, '魚津駅前');
  const partialBandMessageUozuEkiOk = await checkPartialBandMessage(html, '電鉄魚津駅前');
  const searchButtonStateOk = await checkSearchButtonState(html);
  const favoritesStorageOk = await checkFavoritesStorage();
  const favoriteCardToggleOk = await checkFavoriteCardToggle(html);
  const sharedSpotBandBypassOk = await checkSharedSpotBandBypass(html);
  const sharedSpotSidMismatchOk = await checkSharedSpotSidMismatch(html);
  const sharedSpotAmbiguousNameOk = await checkSharedSpotAmbiguousName(html);
  const sharedListMixedDepartureOk = await checkSharedListMixedDeparture(html);
  const serviceFrequencyComputationOk = await checkServiceFrequencyComputation();
  const frequencyDisplayLogicOk = await checkFrequencyDisplayLogic();
  const shareTextMunicipalityOk = await checkShareTextMunicipalityAndFrequency();
  const operatorClassificationOk = await checkOperatorClassification();

  if (
    publishedOk && desktopOk && mobileOk && cardsOk && loadingStateOk && transferDisplayOk &&
    spotLevelBandingOk && departureMismatchOk && partialBandMessageOk && partialBandMessageUozuEkiOk &&
    searchButtonStateOk && favoritesStorageOk && favoriteCardToggleOk && sharedSpotBandBypassOk &&
    sharedSpotSidMismatchOk && sharedSpotAmbiguousNameOk && sharedListMixedDepartureOk &&
    serviceFrequencyComputationOk && frequencyDisplayLogicOk && shareTextMunicipalityOk &&
    operatorClassificationOk
  ) {
    console.log('\n✅ 検証成功: 初期表示・検索結果カードともに想定通りです');
  } else {
    console.error('\n❌ 検証失敗: 上記のいずれかで問題が見つかりました');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('❌ 検証スクリプト実行エラー:', error);
  process.exit(1);
});
