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
 */

import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distIndexPath = path.join(__dirname, '../dist/index.html');

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

  window.addEventListener('error', (e) => {
    errors.push(e.error ? (e.error.stack || e.error.message) : e.message);
  });

  // main.js は DOMContentLoaded を待って起動する。jsdomは非同期でイベントを
  // 発火するため、発火後に少し待ってからDOMの状態を確認する。
  await new Promise((resolve) => {
    const done = () => setTimeout(resolve, 50);
    if (window.document.readyState === 'complete') {
      done();
    } else {
      window.addEventListener('load', done);
    }
  });

  const doc = window.document;
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

  const ok = searchFormDisplay !== 'none' && hiddenAncestors.length === 0;
  console.log(ok ? '✅ #search-form は表示状態です' : '❌ #search-form は非表示になっています');

  window.close();
  return ok;
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
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  stubMatchMedia(window, true);
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

  // 実際のユーザー操作を模して検索を実行する（出発駅・予算をセットしてフォーム送信）
  const departureInput = doc.getElementById('departure-input');
  departureInput.value = '高松築港';
  departureInput.dataset.stationName = '高松築港';
  doc.getElementById('budget-input').value = '1000';
  doc.getElementById('search-form').dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true })
  );

  const rendered = await waitFor(
    () => doc.getElementById('results-list').children.length > 0,
    8000
  );

  if (errors.length > 0) {
    console.log('⚠️  ページ実行中に発生したエラー:');
    errors.forEach((e) => console.log('  - ' + e));
  }

  if (!rendered) {
    console.log('❌ 検索後も #results-list に子要素が生成されませんでした（タイムアウト）');
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
    const structureOk = hasImage && hasTitle && hasDescription && hasSummary && hasButton;

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
      console.log(`  ❌ カード[${i}]: 構造=${structureOk ? 'OK' : 'NG'} (image=${hasImage},title=${hasTitle},description=${hasDescription},summary=${hasSummary},button=${hasButton}) / スタイル=${styleOk ? 'OK' : 'NG'} (display=${cardStyle.display}, min-height=${cardStyle.minHeight}, img.height=${imgStyle.height}, img.flex-shrink=${imgStyle.flexShrink})`);
    }
  }

  console.log(
    ok
      ? `✅ カード${sampleCount}件（先頭から）の構造・スタイルは想定通りです`
      : '❌ 構造またはスタイルが想定と異なるカードがあります'
  );

  window.close();
  return ok;
}

async function main() {
  if (!fs.existsSync(distIndexPath)) {
    console.error('dist/index.html が見つかりません。先に npm run bundle を実行してください');
    process.exit(1);
  }
  const html = fs.readFileSync(distIndexPath, 'utf-8');

  const desktopOk = await checkVisible(html, true, 'PC幅相当');
  const mobileOk = await checkVisible(html, false, 'スマホ幅相当');
  const cardsOk = await checkResultCards(html);

  if (desktopOk && mobileOk && cardsOk) {
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
