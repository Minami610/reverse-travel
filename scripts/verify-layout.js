/**
 * verify-layout.js - Playwright（実ブラウザ）による見た目のレイアウト検証
 *
 * 【背景】jsdomには実レイアウトエンジンが無いため、verify-render（jsdom）では
 * 「要素が重なっている」「ボタンが文章の上に出て見切れている」「候補一覧が
 * 他の要素の裏に隠れる」といった見た目だけの不具合を検出できない。実際に
 * 2026-10-07、このレイアウト崩れが2回続けて見落とされた
 * （0件画面のボタン見切れ、出発駅候補一覧が検索ボタン・地図の裏に隠れる）。
 * このスクリプトはPlaywright（Chromium）でdist/index.htmlを実際にレンダリングし、
 * 主要な画面をPC幅（1920×1080）・スマホ幅（390×844）の両方でスクリーンショットに
 * 撮った上で、要素のbounding boxから「重なっていないか」「画面内に収まっているか」
 * を自動判定する。
 *
 * 実行順序：bundle → verify-render → verify-layout → verify-regression
 * （verify-renderが先：構文・データの正しさを先に確認してから、見た目を確認する）
 */

import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertBundleFresh, assertSiteDataFresh } from './check-bundle-freshness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const docsDir = path.join(rootDir, 'docs');
const distIndexPath = path.join(rootDir, 'dist/index.html');
const screenshotDir = path.join(rootDir, 'data/screenshots/verify-layout');

const VIEWPORTS = {
  pc: { width: 1920, height: 1080 },
  // 2026-10-08、1本目（お気に入り・マイリスト・共有）の指示でスマホ幅を
  // 375pxに指定されたため、375×667（iPhone SE/8相当）に変更した。
  sp: { width: 375, height: 667 },
};

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml',
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const filePath = urlPath === '/'
        ? distIndexPath
        : path.join(docsDir, urlPath);
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('not found: ' + filePath);
          return;
        }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function searchAt(page, stationText, budget) {
  await page.fill('#departure-input', '');
  await page.fill('#departure-input', stationText);
  await page.waitForTimeout(400);
  const item = page.locator('.suggestion-item', { hasText: stationText }).first();
  await item.click();
  for (let i = 0; i < 20; i++) {
    const value = parseInt(await page.inputValue('#budget-input'), 10);
    if (value === budget) break;
    if (value < budget) await page.click('#budget-increment');
    else await page.click('#budget-decrement');
  }
  await page.click('#search-btn');
  await page.waitForSelector('.spot-card, .no-results', { timeout: 15000 });
  await page.waitForTimeout(300);
}

/** 2つの矩形が重なっているか（null=非表示要素は重なり判定の対象外） */
function rectsOverlap(a, b) {
  if (!a || !b) return false;
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** 矩形が0サイズでなく、ビューポート内に収まっているか */
function isFullyVisible(rect, viewport) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  return rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width + 1 && rect.y + rect.height <= viewport.height + 1;
}

/** タップ領域が44px四方以上あるか（Minamiさんの指示：スマホで押しやすい大きさ） */
const TOUCH_TARGET_MIN_PX = 44;
function isTouchTargetLargeEnough(rect) {
  return !!rect && rect.width >= TOUCH_TARGET_MIN_PX - 1 && rect.height >= TOUCH_TARGET_MIN_PX - 1;
}

const results = [];
function record(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(ok ? `✅ ${label}` : `❌ ${label}${detail ? '（' + detail + '）' : ''}`);
}

/**
 * 画面全体に横スクロールが発生していないか（要素が画面幅をはみ出していないか）。
 * 本文がはみ出すと、スマホ幅でページ全体が横に伸びて崩れる。
 */
async function checkNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  record(`${label}: 横スクロールが発生していない`, overflow <= 1, `はみ出し ${overflow}px`);
}

/**
 * 【2026-10-07追加】出発駅の入力欄の下端と、予算の見出しの上端の間に、不自然な
 * 空白ができていないかを確認する（Minamiさんがスマホ実機・screenshotの両方で発見：
 * スマホ幅で両者の間に150px超の空白があった）。
 * 原因は、.form-rowがスマホ幅でflex-direction:columnになる際、.form-group-budgetには
 * 縦積み用の上書き（flex:0 0 auto; width:100%）があったのに.form-group-departureには
 * 無く、横積み用のflex-basis（1 1 220px）が縦積みでは「高さ220px」として効いて
 * しまっていたこと（position:fixed化とは無関係。CSS側の修正コメント参照）。
 * 重なり・見切れだけでなく「離れすぎ」も検出するため、重なり判定とは別に
 * しきい値（40px。通常のgap・marginの数倍）を設けて明示的に確認する。
 */
async function checkDepartureBudgetGap(page, viewportLabel) {
  const GAP_THRESHOLD_PX = 40;
  const inputBox = await page.locator('#departure-input').boundingBox();
  const budgetLabelBox = await page.locator('label[for="budget-input"]').boundingBox();
  if (!inputBox || !budgetLabelBox) {
    record(`[${viewportLabel}] 出発駅欄と予算見出しの間隔: 要素が見つかる`, false);
    return;
  }
  const gap = budgetLabelBox.y - (inputBox.y + inputBox.height);
  record(
    `[${viewportLabel}] 出発駅欄の下端と予算見出しの上端の間に不自然な空白がない`,
    gap <= GAP_THRESHOLD_PX,
    `間隔 ${gap.toFixed(1)}px（しきい値 ${GAP_THRESHOLD_PX}px）`
  );
  // 「出発駅の入力欄が横幅いっぱいに広がっていない」もあわせて確認する
  // （同じ修正で解消するため、ここでまとめて見る）。PCは出発駅・予算が横並びで
  // 入力欄が行幅いっぱいにならないのが正しい設計のため、スマホ幅のみ見る。
  const formRowBox = viewportLabel === 'sp' ? await page.locator('.form-row').boundingBox() : null;
  if (formRowBox) {
    const widthDiff = formRowBox.width - inputBox.width;
    record(
      `[${viewportLabel}] 出発駅の入力欄が行の横幅いっぱいに広がっている`,
      widthDiff <= 2,
      `行の幅 ${formRowBox.width.toFixed(1)}px / 入力欄の幅 ${inputBox.width.toFixed(1)}px`
    );
  }
}

async function captureNoResultsScreen(page, viewportLabel) {
  await searchAt(page, 'ＪＲ栗林駅', 300);
  const screenshotPath = path.join(screenshotDir, `no-results-${viewportLabel}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const noResultsBox = await page.locator('.no-results').boundingBox();
  const buttonBoxes = await page.locator('.budget-retry-btn').all();
  const viewport = VIEWPORTS[viewportLabel];

  if (!noResultsBox) {
    record(`[${viewportLabel}] 0件画面: .no-results が見つかる`, false);
    return screenshotPath;
  }
  record(`[${viewportLabel}] 0件画面: 文章が画面内に収まっている`, isFullyVisible(noResultsBox, viewport));

  if (buttonBoxes.length === 0) {
    record(`[${viewportLabel}] 0件画面: 「往復¥Xで探す」ボタンが見つかる`, false);
  } else {
    for (let i = 0; i < buttonBoxes.length; i++) {
      const box = await buttonBoxes[i].boundingBox();
      record(`[${viewportLabel}] 0件画面: ボタン[${i}]が画面内に収まっている（見切れていない）`, isFullyVisible(box, viewport));
      record(
        `[${viewportLabel}] 0件画面: ボタン[${i}]が文章の下にあり重ならない`,
        !!box && !rectsOverlap(noResultsBox, box) && box.y >= noResultsBox.y + noResultsBox.height - 1
      );
    }
  }
  await checkNoHorizontalOverflow(page, `[${viewportLabel}] 0件画面`);
  return screenshotPath;
}

async function captureSuggestionsScreen(page, viewportLabel) {
  await page.fill('#departure-input', '');
  await page.fill('#departure-input', '魚');
  await page.waitForTimeout(400);
  const screenshotPath = path.join(screenshotDir, `suggestions-${viewportLabel}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });

  const viewport = VIEWPORTS[viewportLabel];
  const items = await page.locator('.suggestion-item').all();
  let visibleCount = 0;
  const otherBoxes = {
    searchBtn: await page.locator('#search-btn').boundingBox(),
    map: await page.locator('#map-slot-desktop, #map-slot-mobile').first().boundingBox().catch(() => null),
  };

  for (const item of items) {
    const box = await item.boundingBox();
    if (box && isFullyVisible(box, viewport) && box.width > 0 && box.height > 0) {
      visibleCount++;
    }
  }
  record(`[${viewportLabel}] 候補一覧: 8件以上の候補が画面内に見えている`, visibleCount >= 8, `実際 ${visibleCount}件`);

  // 検索ボタン・地図の「裏に隠れていない」こと＝候補アイテムの矩形と重なっていても、
  // 候補一覧自体がそれらより手前（z-index）にあるため実際には隠れていないはず。
  // ここでは「候補一覧の方が検索ボタン・地図より下（後）のDOM順で、かつ重なる位置に
  // 描画されている＝裏に回っていたら見えない」を可視判定（上のisFullyVisible）で代替し、
  // 重なり自体は許容する（手前に重ねて表示する設計のため）。
  await checkNoHorizontalOverflow(page, `[${viewportLabel}] 候補一覧`);
  return screenshotPath;
}

async function captureResultsListScreen(page, viewportLabel) {
  await searchAt(page, '高松築港', 1000);
  const screenshotPath = path.join(screenshotDir, `results-list-${viewportLabel}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const cards = await page.locator('.spot-card').all();
  record(`[${viewportLabel}] 結果一覧: カードが1件以上表示されている`, cards.length > 0, `${cards.length}件`);

  const viewport = VIEWPORTS[viewportLabel];
  const sample = cards.slice(0, Math.min(cards.length, 5));
  const boxes = [];
  for (const card of sample) {
    boxes.push(await card.boundingBox());
  }
  const allWithinWidth = boxes.every((b) => !b || (b.x >= -1 && b.x + b.width <= viewport.width + 1));
  record(`[${viewportLabel}] 結果一覧: カードが画面幅に収まっている（横はみ出しなし）`, allWithinWidth);

  let anyOverlap = false;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (rectsOverlap(boxes[i], boxes[j])) anyOverlap = true;
    }
  }
  record(`[${viewportLabel}] 結果一覧: カード同士が重なっていない`, !anyOverlap);

  await checkNoHorizontalOverflow(page, `[${viewportLabel}] 結果一覧`);
  return screenshotPath;
}

async function captureHowToScreen(page, viewportLabel) {
  await page.click('#howto-btn');
  await page.waitForTimeout(200);
  const screenshotPath = path.join(screenshotDir, `howto-${viewportLabel}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const modalVisible = await page.locator('#howto-modal').isVisible();
  record(`[${viewportLabel}] 使い方画面: モーダルが表示されている`, modalVisible);

  const viewport = VIEWPORTS[viewportLabel];
  const modalBox = await page.locator('#howto-modal').boundingBox();
  record(`[${viewportLabel}] 使い方画面: モーダルが画面幅に収まっている`, !!modalBox && modalBox.x >= -1 && modalBox.x + modalBox.width <= viewport.width + 1);

  await page.click('#howto-modal-close').catch(() => {});
  await checkNoHorizontalOverflow(page, `[${viewportLabel}] 使い方画面`);
  return screenshotPath;
}

async function captureSearchButtonPendingScreen(page, viewportLabel) {
  await searchAt(page, '高松築港', 1000);
  await page.click('#budget-increment');
  await page.waitForTimeout(100);
  const screenshotPath = path.join(screenshotDir, `search-btn-pending-${viewportLabel}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });

  const btnText = await page.locator('#search-btn').textContent();
  const hasPendingClass = await page.locator('#search-btn.search-btn-pending').count();
  record(`[${viewportLabel}] 検索ボタン状態変化: 文言が「この条件で検索」になっている`, btnText.trim() === 'この条件で検索', `実際: "${btnText.trim()}"`);
  record(`[${viewportLabel}] 検索ボタン状態変化: 強調クラスが付いている`, hasPendingClass === 1);

  const viewport = VIEWPORTS[viewportLabel];
  const btnBox = await page.locator('#search-btn').boundingBox();
  record(`[${viewportLabel}] 検索ボタン状態変化: ボタンが画面内に収まっている`, isFullyVisible(btnBox, viewport));
  return screenshotPath;
}

/**
 * カードの☆（マイリスト保存）・共有ボタンを確認する（2026-10-08追加）。
 * 重なり・はみ出しに加え、タップ領域が44px四方以上あることを見る。
 */
async function captureCardFavoriteShareScreen(page, viewportLabel) {
  await searchAt(page, '高松築港', 1000);
  const screenshotPath = path.join(screenshotDir, `card-favorite-share-${viewportLabel}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });

  const viewport = VIEWPORTS[viewportLabel];
  const firstCard = page.locator('.spot-card').first();
  const favBtn = firstCard.locator('.favorite-btn');
  const shareBtn = firstCard.locator('.share-btn');
  const favBox = await favBtn.boundingBox();
  const shareBox = await shareBtn.boundingBox();

  record(`[${viewportLabel}] カード: ☆ボタンが画面内に収まっている`, isFullyVisible(favBox, viewport));
  record(`[${viewportLabel}] カード: 共有ボタンが画面内に収まっている`, isFullyVisible(shareBox, viewport));
  record(`[${viewportLabel}] カード: ☆ボタンのタップ領域が44px四方以上`, isTouchTargetLargeEnough(favBox), favBox ? `${favBox.width.toFixed(0)}×${favBox.height.toFixed(0)}` : 'なし');
  record(`[${viewportLabel}] カード: 共有ボタンのタップ領域が44px四方以上`, isTouchTargetLargeEnough(shareBox), shareBox ? `${shareBox.width.toFixed(0)}×${shareBox.height.toFixed(0)}` : 'なし');
  record(`[${viewportLabel}] カード: ☆・共有ボタンが重なっていない`, !rectsOverlap(favBox, shareBox));

  // ☆を押して、カード本体の詳細遷移に巻き込まれていないこと（押しても詳細画面に
  // ならない＝クリックがカードに伝播していないこと）を確認する
  await favBtn.click();
  await page.waitForTimeout(150);
  const stillOnResultsList = await page.locator('#app-layout').getAttribute('data-view');
  record(`[${viewportLabel}] カード: ☆を押しても詳細画面に遷移しない（クリックの巻き込み防止）`, stillOnResultsList === 'results');

  await checkNoHorizontalOverflow(page, `[${viewportLabel}] カードの☆・共有`);
  return screenshotPath;
}

/** 詳細画面の☆・共有ボタンを確認する（2026-10-08追加） */
async function captureDetailFavoriteShareScreen(page, viewportLabel) {
  await searchAt(page, '高松築港', 1000);
  await page.locator('.spot-card').first().click();
  await page.waitForSelector('#detail-content h2', { timeout: 15000 });
  const screenshotPath = path.join(screenshotDir, `detail-favorite-share-${viewportLabel}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const viewport = VIEWPORTS[viewportLabel];
  const favBox = await page.locator('.detail-favorite-btn').boundingBox();
  const shareBox = await page.locator('.detail-share-btn').boundingBox();
  record(`[${viewportLabel}] 詳細画面: ☆ボタンが画面内に収まっている`, isFullyVisible(favBox, viewport));
  record(`[${viewportLabel}] 詳細画面: 共有ボタンが画面内に収まっている`, isFullyVisible(shareBox, viewport));
  record(`[${viewportLabel}] 詳細画面: ☆ボタンのタップ領域が44px四方以上`, isTouchTargetLargeEnough(favBox), favBox ? `${favBox.width.toFixed(0)}×${favBox.height.toFixed(0)}` : 'なし');
  record(`[${viewportLabel}] 詳細画面: 共有ボタンのタップ領域が44px四方以上`, isTouchTargetLargeEnough(shareBox), shareBox ? `${shareBox.width.toFixed(0)}×${shareBox.height.toFixed(0)}` : 'なし');
  record(`[${viewportLabel}] 詳細画面: ☆・共有ボタンが重なっていない`, !rectsOverlap(favBox, shareBox));

  await checkNoHorizontalOverflow(page, `[${viewportLabel}] 詳細画面の☆・共有`);
  // 一覧に戻しておく（他のキャプチャ関数が毎回searchAtし直すので必須ではないが、
  // 状態を崩したまま次に渡さない）
  await page.click('#back-btn').catch(() => {});
  return screenshotPath;
}

/**
 * マイリスト画面を確認する（2026-10-08追加）。まずカードから1件保存した上で
 * ヘッダーの「★ マイリスト」ボタンから開き、行の表示・閉じるボタン・
 * 削除/共有ボタンのタップ領域を見る。
 */
async function captureMylistScreen(page, viewportLabel) {
  await searchAt(page, '高松築港', 1000);
  // 直前のcaptureCardFavoriteShareScreen()が同じカードの☆を既に押している
  // 場合があるため（同じページ・同じlocalStorageを使い回すため状態が残る）、
  // 既に保存済みなら押し直さない（押すとトグルで解除されてしまう）。
  const favBtn = page.locator('.spot-card').first().locator('.favorite-btn');
  const alreadyActive = await favBtn.evaluate((el) => el.classList.contains('favorite-btn-active'));
  if (!alreadyActive) {
    await favBtn.click();
    await page.waitForTimeout(100);
  }

  await page.click('#mylist-btn');
  await page.waitForSelector('#mylist-body .mylist-row', { timeout: 15000 });
  const screenshotPath = path.join(screenshotDir, `mylist-${viewportLabel}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const viewport = VIEWPORTS[viewportLabel];
  const modalBox = await page.locator('#mylist-modal .modal-panel').boundingBox();
  record(`[${viewportLabel}] マイリスト画面: モーダルが画面幅に収まっている`, !!modalBox && modalBox.x >= -1 && modalBox.x + modalBox.width <= viewport.width + 1);

  const closeBox = await page.locator('#mylist-modal-close').boundingBox();
  record(`[${viewportLabel}] マイリスト画面: 閉じるボタンのタップ領域が44px四方以上`, isTouchTargetLargeEnough(closeBox), closeBox ? `${closeBox.width.toFixed(0)}×${closeBox.height.toFixed(0)}` : 'なし');

  const removeBox = await page.locator('.mylist-remove-btn').first().boundingBox();
  const shareBox = await page.locator('.mylist-share-btn').first().boundingBox();
  record(`[${viewportLabel}] マイリスト画面: 削除ボタンのタップ領域が44px四方以上`, isTouchTargetLargeEnough(removeBox), removeBox ? `${removeBox.width.toFixed(0)}×${removeBox.height.toFixed(0)}` : 'なし');
  record(`[${viewportLabel}] マイリスト画面: 共有ボタンのタップ領域が44px四方以上`, isTouchTargetLargeEnough(shareBox), shareBox ? `${shareBox.width.toFixed(0)}×${shareBox.height.toFixed(0)}` : 'なし');
  record(`[${viewportLabel}] マイリスト画面: 削除・共有ボタンが重なっていない`, !rectsOverlap(removeBox, shareBox));

  await checkNoHorizontalOverflow(page, `[${viewportLabel}] マイリスト画面`);
  await page.click('#mylist-modal-close');
  return screenshotPath;
}

async function main() {
  assertBundleFresh('verify-layout');
  assertSiteDataFresh('verify-layout');
  fs.mkdirSync(screenshotDir, { recursive: true });

  const server = await startServer();
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/`;
  console.log(`ローカルサーバー起動: ${baseUrl}（dist/index.html + docs/data/）`);

  const browser = await chromium.launch();
  const savedPaths = [];

  try {
    for (const [label, viewport] of Object.entries(VIEWPORTS)) {
      console.log(`\n=== ${label}（${viewport.width}×${viewport.height}） ===`);
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await page.goto(baseUrl, { waitUntil: 'networkidle' });
      await page.waitForSelector('#departure-input', { timeout: 15000 });
      // 駅一覧（オートコンプリート用）のロード完了を待つ
      await page.waitForFunction(() => {
        const input = document.getElementById('departure-input');
        return input && input.placeholder === '駅名を入力...';
      }, { timeout: 15000 });

      await checkDepartureBudgetGap(page, label);
      savedPaths.push(await captureNoResultsScreen(page, label));
      savedPaths.push(await captureSuggestionsScreen(page, label));
      savedPaths.push(await captureResultsListScreen(page, label));
      savedPaths.push(await captureHowToScreen(page, label));
      savedPaths.push(await captureSearchButtonPendingScreen(page, label));
      savedPaths.push(await captureCardFavoriteShareScreen(page, label));
      savedPaths.push(await captureDetailFavoriteShareScreen(page, label));
      savedPaths.push(await captureMylistScreen(page, label));

      if (pageErrors.length > 0) {
        record(`[${label}] ページ実行中にエラーが発生していない`, false, pageErrors.join('; '));
      }

      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n=== スクリーンショット保存先 ===');
  savedPaths.forEach((p) => console.log(`  - ${path.relative(rootDir, p)}`));

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n❌ 検証失敗: ${failed.length}件のレイアウト問題が見つかりました`);
    process.exit(1);
  }
  console.log('\n✅ 検証成功: レイアウトの重なり・見切れ・横スクロールは見つかりませんでした');
}

main().catch((error) => {
  console.error('❌ 検証スクリプト実行エラー:', error);
  process.exit(1);
});
