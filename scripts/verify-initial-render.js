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

// main.jsのBAND_WIDTHと同じ値を保つこと（2026-10-06、帯表示導入時に追加）
const BAND_WIDTH = 200;
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
      imgStyle.height === '130px' &&
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
 * 【2026-10-07追加】帯の判定を「駅単位」から「スポット単位」に直したことの検証
 * （Minamiさんが公開ページで発見：TOYAMAキラリ等が往復¥400の帯にも往復¥1000の
 * 帯にも別々の運賃で出ていた）。
 * 1. 往復¥1000の帯に出たスポットが、隣の帯（予算−¥200＝往復¥800の帯。¥900の帯
 *    ではない点に注意：帯の幅=¥200・予算刻み=¥100のため、1段階隣の¥900の帯とは
 *    ¥100分重なりがあり、そちらは重複して出てよい）には出ていないこと
 * 2. 往復¥1000の帯に出た各スポットの表示運賃が、docs/data/を直接読んで独立に
 *    計算した「そのスポットの真の最安往復運賃」と一致すること
 */
async function checkSpotLevelBanding(html) {
  console.log('\n=== 帯のスポット単位判定チェック ===');
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

  const item = await waitForSuggestion(doc, window, '高松築港', '高松築港');
  if (!item) {
    console.log('❌ 検証用の出発駅「高松築港」の候補が見つかりません');
    window.close();
    return false;
  }
  item.dispatchEvent(new window.Event('click', { bubbles: true }));

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

  const at1000 = await searchAt(1000);
  const at800 = await searchAt(800); // 予算−¥200＝隣の帯（¥601〜¥800、重なりなし）

  const overlap = [...at1000.keys()].filter((qid) => at800.has(qid));
  const noOverlap = overlap.length === 0;
  console.log(
    noOverlap
      ? `✅ 往復¥1000の帯のスポット（${at1000.size}件）は、隣の¥800の帯（${at800.size}件）と重複していません`
      : `❌ 隣の帯（¥800）と重複しているスポットがあります: ${overlap.join(', ')}`
  );

  const groundTruth = await computeGroundTruthFares('37', '高松築港', 2000);
  let fareMismatch = null;
  for (const [qid, displayedFare] of at1000) {
    const trueFare = groundTruth.get(qid);
    if (trueFare === undefined) continue; // 念のため（本来は必ず見つかるはず）
    if (trueFare !== displayedFare) {
      fareMismatch = { qid, displayedFare, trueFare };
      break;
    }
  }
  const fareOk = fareMismatch === null;
  console.log(
    fareOk
      ? `✅ 往復¥1000の帯の全${at1000.size}件で、表示運賃がそのスポットの真の最安往復運賃と一致しています`
      : `❌ 表示運賃が最安運賃と食い違うスポットがあります: ${JSON.stringify(fareMismatch)}`
  );

  if (errors.length > 0) {
    console.log('⚠️  ページ実行中に発生したエラー:');
    errors.forEach((e) => console.log('  - ' + e));
  }

  window.close();
  return noOverlap && fareOk && errors.length === 0;
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

  if (
    publishedOk && desktopOk && mobileOk && cardsOk && loadingStateOk && transferDisplayOk &&
    spotLevelBandingOk && departureMismatchOk
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
