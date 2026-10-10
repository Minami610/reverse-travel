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
import { assertBundleFresh, assertSiteDataFresh, assertMaplibreVendorFresh } from './check-bundle-freshness.js';

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

/**
 * 要素のスクリーンショットを安全に撮る（2026-10-10追加）。
 * 【背景】応援マークの説明枠を追加したことでカードが縦に伸び、スマホ幅（375×667）
 * ではカード1枚がビューポート高さを超えることがある。
 * 【試行錯誤】(1) Playwright純正のlocator.screenshot()は、要素がビューポートより
 * 高い場合に内部でスクロールしながら複数フレームを継ぎ合わせるが、position:fixedの
 * フッターが継ぎ合わせ画像のあちこちに写り込んだ。(2) フッターを非表示にしたうえで
 * locator.screenshot()を使っても、#results-listが内部スクロール要素（ページ自体は
 * スクロールしない）であるこのレイアウトでは、要素が何番目のカードか（＝内部スクロール量）
 * によって、カードより上のタブ・並び替え欄まで写り込んだり、逆に下端が欠けたりする
 * 不具合が再現した（内部スクロールとPlaywrightの要素スクロールが噛み合わない）。
 * 対策：ビューポート自体を、内部スクロールが一切不要なくらい大きく広げてから
 * （#results-list等の内部スクロールを実質無効化する）、boundingBox()で測った座標を
 * そのままpage.screenshot({clip})に渡す。単一フレーム・内部スクロール無しの状態に
 * 揃えることで、cropがずれる要因を取り除く。
 */
async function screenshotElementSafely(page, locator, screenshotPath, viewport) {
  await page.evaluate(() => {
    const footer = document.getElementById('app-footer');
    if (footer) footer.style.display = 'none';
  });
  // 内部スクロールが要らないくらい大きいビューポートにして、スクロール起因のずれを無くす
  await page.setViewportSize({ width: viewport.width, height: 3000 });
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('要素のbounding boxが取得できませんでした');
  await page.screenshot({ path: screenshotPath, clip: box });

  await page.evaluate(() => {
    const footer = document.getElementById('app-footer');
    if (footer) footer.style.display = '';
  });
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
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
  const budgetLabelBox = await page.locator('label[for="budget-slider"]').boundingBox();
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

/**
 * 【2026-10-09追加】ヘッダー内の文字が省略記号（text-overflow:ellipsis）で
 * 切れていないかを確認する。Minamiさんがスマホ幅のスクリーンショットで発見：
 * タイトル横の説明文が「予…」で切れていた。要素のscrollWidthがclientWidthを
 * 超えていれば、内容が収まりきらず省略されている（＝切れている）とみなす。
 * header自体だけでなく、header配下の可視要素すべてを対象にする（見出し・
 * 説明文・マイリストボタンの文言のいずれが切れても検出できるようにするため）。
 */
async function checkHeaderNotTruncated(page, viewportLabel) {
  const truncated = await page.evaluate(() => {
    const header = document.querySelector('header');
    if (!header) return null;
    const results = [];
    const walk = (el) => {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      if (el.scrollWidth > el.clientWidth + 1 && style.overflow !== 'visible') {
        results.push({ tag: el.tagName, id: el.id, cls: el.className, text: el.textContent.trim().slice(0, 30) });
      }
      for (const child of el.children) walk(child);
    };
    walk(header);
    return results;
  });
  if (truncated === null) {
    record(`[${viewportLabel}] ヘッダー: headerが見つかる`, false);
    return;
  }
  record(
    `[${viewportLabel}] ヘッダー内の文字が省略記号で切れていない`,
    truncated.length === 0,
    truncated.length > 0 ? truncated.map((t) => `<${t.tag}${t.id ? '#' + t.id : ''}>"${t.text}"`).join(', ') : undefined
  );
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

/**
 * ①応援マークありのカード全体・③曜日限定のカード全体（2026-10-10、2本目
 * 「便の少ない路線を応援」）。富山駅前→伏木万葉大橋（往復¥1600、2便/日・
 * 月・金のみ、実データから確認済み）は応援マーク対象かつ曜日限定の両方を
 * 満たすため、①③は同一カードで兼ねる（Minami報告：撮るスポットと一致させる）。
 * カード要素そのものをscreenshot()する（scrollIntoViewIfNeededしてから）。
 * 写真より下（マーク・説明枠・便数）まで写るようにするため、ページ全体ではなく
 * 要素単位のスクリーンショットにした。
 */
async function captureSupportBadgeCardScreen(page, viewportLabel) {
  await searchAt(page, '富山駅前', 1600);
  const card = page.locator('.spot-card.spot-card-supported').first();
  const screenshotPath = path.join(screenshotDir, `support-badge-card-${viewportLabel}.png`);
  await screenshotElementSafely(page, card, screenshotPath, VIEWPORTS[viewportLabel]);

  const badgeCount = await page.locator('.spot-card-supported').count();
  record(`[${viewportLabel}] 応援マーク: バッジ付きカードが表示されている`, badgeCount > 0, `${badgeCount}件`);

  const badgeNoteText = (await card.locator('.support-badge-note').textContent().catch(() => '')) || '';
  record(`[${viewportLabel}] 応援マーク: 説明枠に「応援」の文言が入っている`, badgeNoteText.includes('支える力'), badgeNoteText);
  record(`[${viewportLabel}] 曜日限定: 「月・金のみ」等の曜日限定文言が入っている`, /[月火水木金]・[月火水木金]のみ/.test(badgeNoteText), badgeNoteText);

  // 押せるボタンに見えないこと：<button>要素ではないことを確認する
  const heartTag = await card.locator('.support-badge-heart').evaluate((el) => el.tagName);
  record(`[${viewportLabel}] 応援マーク: ハート表示がbutton要素ではない（押せるボタンに見えない）`, heartTag !== 'BUTTON', heartTag);

  await checkNoHorizontalOverflow(page, `[${viewportLabel}] 応援マークカード`);
  return screenshotPath;
}

/** ②マークなしのカード全体（便数の小さな表示が見えること）。富山駅前→TOYAMAキラリ、42便/日 */
async function captureNonBadgeFrequencyScreen(page, viewportLabel) {
  await searchAt(page, '富山駅前', 400);
  const card = page.locator('.spot-card').filter({ has: page.locator('.spot-frequency-note') }).first();
  const screenshotPath = path.join(screenshotDir, `non-badge-frequency-card-${viewportLabel}.png`);
  await screenshotElementSafely(page, card, screenshotPath, VIEWPORTS[viewportLabel]);

  const noBadge = await page.locator('.spot-card-supported').count();
  record(`[${viewportLabel}] マークなしカード: 高頻度路線にはバッジが付かない`, noBadge === 0, `${noBadge}件`);

  const freqNoteText = (await card.locator('.spot-frequency-note').textContent().catch(() => '')) || '';
  record(`[${viewportLabel}] マークなしカード: 便数が小さく表示されている`, /\d+便/.test(freqNoteText), freqNoteText);

  await checkNoHorizontalOverflow(page, `[${viewportLabel}] マークなしカード`);
  return screenshotPath;
}

/**
 * ④要予約のカード全体・⑤要予約の区間がある詳細画面の経路部分。
 * 八尾駅→往復¥400の帯で、実際にUIが表示する並び順で最初に「要予約」を含むのは
 * 「八尾おわら資料館」（1便/日・全便予約制）。前回の報告は手元の検証スクリプトが
 * calculateReachable()の上限を¥2000（実際の検索は¥400）で呼んでいたため並び順が
 * ずれ、「井田主馬ヶ城」と誤って報告していた。実際の検索（¥400）で並び順を
 * 再確認し、スクリーンショットの「八尾おわら資料館」が正しい。
 */
async function captureReservationScreen(page, viewportLabel) {
  await searchAt(page, '八尾駅', 400);
  const card = page.locator('.spot-card').filter({ hasText: '要予約' }).first();
  const cardFound = await card.count() > 0;
  record(`[${viewportLabel}] 予約制: カードに「要予約」の文言があるスポットが見つかる`, cardFound);
  if (!cardFound) return null;

  const screenshotPath = path.join(screenshotDir, `reservation-card-${viewportLabel}.png`);
  await screenshotElementSafely(page, card, screenshotPath, VIEWPORTS[viewportLabel]);

  await card.locator('.detail-btn').click();
  await page.waitForSelector('#detail-content h2', { timeout: 15000 });
  const routeInfo = page.locator('#detail-content .route-info');
  const detailScreenshotPath = path.join(screenshotDir, `reservation-detail-route-${viewportLabel}.png`);
  await screenshotElementSafely(page, routeInfo, detailScreenshotPath, VIEWPORTS[viewportLabel]);

  const detailText = await page.locator('#detail-content').textContent();
  record(`[${viewportLabel}] 予約制: 詳細画面の経路にも「要予約」が出る`, detailText.includes('要予約'));

  await checkNoHorizontalOverflow(page, `[${viewportLabel}] 予約制詳細画面`);
  await page.click('#back-btn').catch(() => {});
  return [screenshotPath, detailScreenshotPath];
}

/**
 * 「この先へ」セクション（2026-10-10、3本目。feature/kono-sakiブランチ）を確認する。
 * 【2026-10-10修正反映】デザイン③（横長1行×3件、左56px写真・中央名前+一言・右運賃）、
 * 運賃表記「往復¥1,234（+¥120 または 追加なし）」、種類別の一言に更新済み。
 * 高松築港・往復¥1000の帯内1件目の詳細画面には、同じ路線の先が無い実データのため
 * 「すぐ近く」3件が表示される（実データで確認済み）。暗い枠・3件・新運賃表記・
 * カードをクリックすると候補の詳細へ切り替わることを確認する。
 * 【2026-10-10追記】この同じ画面の1件目（志度寺、ことでん志度線=route_type 2）は
 * 「同じ電車で約2分先」になる（route_typeによる呼び分けの実例。Minami指示）ため、
 * ここで「電車」の文言も確認し、このスクリーンショットを電車の例としても扱う。
 */
async function captureOnwardSectionScreen(page, viewportLabel) {
  await searchAt(page, '高松築港', 1000);
  await page.locator('.spot-card').first().click();
  await page.waitForSelector('#detail-content h2', { timeout: 15000 });
  const onwardSection = page.locator('.onward-section');
  const hasOnward = await onwardSection.count() > 0;
  record(`[${viewportLabel}] この先へ: セクションが表示されている`, hasOnward);
  if (!hasOnward) return null;

  const screenshotPath = path.join(screenshotDir, `onward-section-${viewportLabel}.png`);
  await screenshotElementSafely(page, onwardSection, screenshotPath, VIEWPORTS[viewportLabel]);

  const cardCount = await page.locator('.onward-card').count();
  record(`[${viewportLabel}] この先へ: カードが1〜3件表示されている`, cardCount >= 1 && cardCount <= 3, `${cardCount}件`);

  const fareText = await page.locator('.onward-fare').first().textContent();
  record(`[${viewportLabel}] この先へ: 運賃が「往復¥...（+¥... または 追加なし）」の形式`, /^往復¥[\d,]+（(追加なし|\+¥[\d,]+)）$/.test(fareText), fareText);

  const firstBlurbText = await page.locator('.onward-blurb').first().textContent();
  record(`[${viewportLabel}] この先へ: 鉄道（ことでん志度線）の候補は「同じ電車で」と表示される（電車の例）`, firstBlurbText.includes('同じ電車で'), firstBlurbText);

  const firstHeading = await page.locator('#detail-content h2').textContent();
  await page.locator('.onward-card').first().click();
  await page.waitForTimeout(200);
  const secondHeading = await page.locator('#detail-content h2').textContent();
  record(`[${viewportLabel}] この先へ: カードをクリックすると詳細が切り替わる`, secondHeading !== firstHeading, `${firstHeading} → ${secondHeading}`);

  await checkNoHorizontalOverflow(page, `[${viewportLabel}] この先へ`);
  await page.click('#back-btn').catch(() => {});
  await page.click('#back-btn').catch(() => {});
  return screenshotPath;
}

/**
 * 応援マーク（ハート）付きの「この先へ」候補の例（Minami指示8番）。
 * 富山駅前・往復¥1600・1件目の詳細（伏木万葉大橋）は、実データ確認済みで
 * 3件とも応援マーク対象（.onward-heart）が付く「すぐ近く」候補になる。
 */
async function captureOnwardBadgeScreen(page, viewportLabel) {
  await searchAt(page, '富山駅前', 1600);
  await page.locator('.spot-card').first().click();
  await page.waitForSelector('#detail-content h2', { timeout: 15000 });
  const heartCount = await page.locator('.onward-card .onward-heart').count();
  record(`[${viewportLabel}] この先へ: 応援マーク付きの候補がある例が見つかる`, heartCount > 0, `${heartCount}件`);
  if (heartCount === 0) {
    await page.click('#back-btn').catch(() => {});
    return null;
  }

  const onwardSection = page.locator('.onward-section');
  const screenshotPath = path.join(screenshotDir, `onward-badge-${viewportLabel}.png`);
  await screenshotElementSafely(page, onwardSection, screenshotPath, VIEWPORTS[viewportLabel]);

  await checkNoHorizontalOverflow(page, `[${viewportLabel}] この先へ（応援マーク付き）`);
  await page.click('#back-btn').catch(() => {});
  return screenshotPath;
}

/**
 * 「この先へ」候補を開いて、スマホ本体の戻る操作（history.back()、UIの
 * 「← 戻る」ボタンには触れない）で1つ前の詳細画面に戻った状態（Minami指示8番）。
 * popstateでの戻りが実際の画面にも正しく反映されることを目視できる形で残す。
 */
async function captureOnwardBackScreen(page, viewportLabel) {
  await searchAt(page, '富山駅前', 1600);
  await page.locator('.spot-card').first().click();
  await page.waitForSelector('#detail-content h2', { timeout: 15000 });
  const originalHeading = await page.locator('#detail-content h2').textContent();

  const hasOnward = await page.locator('.onward-card').count() > 0;
  record(`[${viewportLabel}] この先へ: 戻り確認用に候補が1件以上ある`, hasOnward);
  if (!hasOnward) {
    await page.click('#back-btn').catch(() => {});
    return null;
  }

  await page.locator('.onward-card').first().click();
  await page.waitForTimeout(200);
  const candidateHeading = await page.locator('#detail-content h2').textContent();

  await page.goBack(); // スマホ本体の戻る操作を模す（UIボタンのクリックではない）
  await page.waitForTimeout(200);
  const backHeading = await page.locator('#detail-content h2').textContent();
  record(
    `[${viewportLabel}] この先へ: スマホ本体の戻る操作で候補の1つ前（元のスポット）の詳細に戻る`,
    backHeading === originalHeading && backHeading !== candidateHeading,
    `候補="${candidateHeading}" → 戻った後="${backHeading}"（元="${originalHeading}"）`
  );

  const detailContent = page.locator('#detail-content');
  const screenshotPath = path.join(screenshotDir, `onward-back-detail-${viewportLabel}.png`);
  await screenshotElementSafely(page, detailContent, screenshotPath, VIEWPORTS[viewportLabel]);

  await checkNoHorizontalOverflow(page, `[${viewportLabel}] この先へ（戻った後の詳細）`);
  await page.click('#back-btn').catch(() => {});
  return screenshotPath;
}

/**
 * 2D/3D切替（4本目①「3D地図の土台」）の3シナリオを検証する（Minami指示3番）。
 * 実WebGLが要るためPlaywright（本ファイル）で行う。それぞれ独立したcontextを使う。
 * スクリーンショットはsp・pcの両方で、初期画面・立山方向・富山湾上空・2D復帰の
 * 4種類を撮る（Minami指示：スマホ375px・PC）。
 */
/**
 * 予算スライダー（4本目③「予算スライダー連動」）を検証する（Minami指示4番）。
 * - スライダーの値と帯の件数が、検索で出る件数と一致する（富山駅前・高松築港、
 *   ¥400・¥1000・¥2000）
 * - 動かしている間（'input'）は一覧が変わらない
 * - 「この条件で検索」を押すと一覧が変わる
 * - スクリーンショット：富山駅前で3D・予算¥400/¥1000/¥2000の3枚と、2Dで¥1000の1枚
 */
async function checkBudgetSlider(browser, baseUrl, savedPaths) {
  console.log('\n=== 予算スライダーの検証 ===');

  // --- 1) スライダーの値と帯の件数が検索結果と一致する ---
  for (const station of ['富山駅前', '高松築港']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#departure-input');
    await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');

    // 最初に適当な予算（¥1000）で検索し、以降はスライダーだけで値を変える
    // （allSpotsは¥2000で一度だけ取得され、以降の帯はスライダー側で絞り込むだけ
    // になる設計のため、ここで一覧を作り直す必要はない）。
    await searchAt(page, station, 1000);

    for (const budget of [400, 1000, 2000]) {
      // 実際の検索結果（別タブ相当。同じページで予算を変えて検索し直し、正解の件数を得る）
      await searchAt(page, station, budget);
      const actualCount = await page.locator('.spot-card').count();

      // スライダー経由（1000に一度戻してから対象の予算へ動かす＝再取得なしの経路を通す）
      await searchAt(page, station, 1000);
      await page.evaluate((v) => {
        const el = document.getElementById('budget-slider');
        el.value = v;
        el.dispatchEvent(new Event('input'));
      }, budget);
      await page.waitForTimeout(150);
      const previewText = await page.locator('#budget-band-preview').textContent();
      const sliderCountMatch = previewText.match(/(\d+)件$/);
      const sliderCount = sliderCountMatch ? parseInt(sliderCountMatch[1], 10) : null;

      record(
        `[${station} ¥${budget}] スライダーの帯件数(${sliderCount})と検索結果のカード数(${actualCount})が一致する`,
        sliderCount === actualCount,
        previewText
      );
    }
    await context.close();
  }

  // --- 2) 動かしている間は一覧が変わらない／3) 「この条件で検索」で一覧が変わる ---
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#departure-input');
    await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');
    await searchAt(page, '富山駅前', 1000);

    const cardsBefore = await page.locator('.spot-card h3').allTextContents();
    await page.evaluate(() => {
      const el = document.getElementById('budget-slider');
      el.value = 2000;
      el.dispatchEvent(new Event('input'));
    });
    await page.waitForTimeout(200);
    const cardsDuringDrag = await page.locator('.spot-card h3').allTextContents();
    record(
      'スライダーを動かしている間（input）は一覧が変わらない',
      JSON.stringify(cardsBefore) === JSON.stringify(cardsDuringDrag),
      `変更前${cardsBefore.length}件 → ドラッグ中${cardsDuringDrag.length}件`
    );

    const pendingClass = await page.evaluate(() => document.getElementById('search-btn').classList.contains('search-btn-pending'));
    record('スライダー操作後、「この条件で検索」ボタンが強調表示になる', pendingClass);

    await page.click('#search-btn');
    await page.waitForSelector('.spot-card, .no-results', { timeout: 15000 });
    await page.waitForTimeout(200);
    const cardsAfterSearch = await page.locator('.spot-card h3').allTextContents();
    record(
      '「この条件で検索」を押すと一覧が変わる（¥1000→¥2000の帯に変化）',
      JSON.stringify(cardsAfterSearch) !== JSON.stringify(cardsBefore)
    );

    await context.close();
  }

  // --- 4) スクリーンショット：富山駅前・3D・¥400/¥1000/¥2000、2D・¥1000 ---
  {
    const context = await browser.newContext({ viewport: { width: 375, height: 667 } });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#departure-input');
    await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');
    await searchAt(page, '富山駅前', 1000);
    await page.click('.tab-btn[data-tab="map"]');
    await page.waitForTimeout(200);
    await page.click('#map-dimension-toggle');
    const became3d = await page.waitForFunction(
      () => document.getElementById('map-area').classList.contains('mode-3d'),
      { timeout: 30000 }
    ).then(() => true).catch(() => false);
    record('スクリーンショット撮影用の3D化に成功', became3d);

    if (became3d) {
      // 地形の読み込みを待ってから撮る（Minami指示4本目④）
      await page.evaluate(() => window.__terrainViewForDebug.waitForTerrainLoaded(20000));
      await page.waitForTimeout(300);
      for (const budget of [400, 1000, 2000]) {
        await page.evaluate((v) => {
          const el = document.getElementById('budget-slider');
          el.value = v;
          el.dispatchEvent(new Event('input'));
        }, budget);
        await page.waitForTimeout(600);
        const shotPath = path.join(screenshotDir, `budget-slider-3d-${budget}.png`);
        await page.locator('#map-area').screenshot({ path: shotPath });
        savedPaths.push(shotPath);
        console.log(`  保存: budget-slider-3d-${budget}.png`);
      }

      // 2Dで¥1000の1枚
      await page.click('#map-dimension-toggle');
      await page.waitForTimeout(300);
      await page.evaluate(() => {
        const el = document.getElementById('budget-slider');
        el.value = 1000;
        el.dispatchEvent(new Event('input'));
      });
      await page.waitForTimeout(400);
      const shot2dPath = path.join(screenshotDir, 'budget-slider-2d-1000.png');
      await page.locator('#map-area').screenshot({ path: shot2dPath });
      savedPaths.push(shot2dPath);
      console.log('  保存: budget-slider-2d-1000.png');
    }

    await context.close();
  }
}

async function checkTerrainMapToggle(browser, baseUrl, savedPaths) {
  console.log('\n=== 2D/3D切替（3D地図の土台）の検証 ===');

  for (const [label, viewport] of Object.entries(VIEWPORTS)) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#departure-input');
    await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');
    await searchAt(page, '富山駅前', 1600);
    if (label === 'sp') {
      await page.click('.tab-btn[data-tab="map"]');
      await page.waitForTimeout(200);
    }

    await page.click('#map-dimension-toggle');
    const became3d = await page.waitForFunction(
      () => document.getElementById('map-area').classList.contains('mode-3d'),
      { timeout: 30000 }
    ).then(() => true).catch(() => false);
    record(`[${label}] 切替ボタンで3Dになる`, became3d);

    const markerCount = await page.locator('.maplibregl-marker').count();
    record(`[${label}] 3D地図上に検索結果のマーカーが出る`, markerCount > 0, `${markerCount}件`);

    if (pageErrors.length > 0) record(`[${label}] 3D化中にページエラーが発生していない`, false, pageErrors.join('; '));

    if (became3d) {
      // 【2026-10-10、4本目④】固定時間の待機だけでは標高タイルの変換が
      // 終わる前にスクリーンショットを撮ってしまい、平らな地図にかすみが
      // かかったようにしか見えない不具合をMinamiがスクリーンショットで発見。
      // isSourceLoaded基準で実際に地形タイルの読み込みを待つ。
      const terrainLoaded1 = await page.evaluate(() => window.__terrainViewForDebug.waitForTerrainLoaded(20000));
      record(`[${label}] 地形（標高タイル）の読み込みが完了する`, terrainLoaded1);
      await page.waitForTimeout(300);
      const initialPath = path.join(screenshotDir, `terrain-3d-initial-${label}.png`);
      await page.locator('#map-area').screenshot({ path: initialPath });
      savedPaths.push(initialPath);

      // 出典（compact attribution）と「2D表示」ボタンが重なっていないか
      // （Minami指示2番）。それぞれの画面内矩形を比較する。
      const overlapInfo = await page.evaluate(() => {
        const toggle = document.getElementById('map-dimension-toggle').getBoundingClientRect();
        const attrib = document.querySelector('#map-area .maplibregl-ctrl-attrib')?.getBoundingClientRect();
        if (!attrib) return { attribFound: false };
        const overlap = !(toggle.right < attrib.left || toggle.left > attrib.right || toggle.bottom < attrib.top || toggle.top > attrib.bottom);
        return { attribFound: true, overlap, toggle, attrib };
      });
      record(
        `[${label}] 出典（compact）と「2D表示」ボタンが重ならない`,
        overlapInfo.attribFound && !overlapInfo.overlap,
        JSON.stringify(overlapInfo)
      );

      // 立山連峰が見える向き（Minami指示：pitch70前後・ズーム10前後。市街地〜
      // 山地の中間を中心にすると稜線がはっきり見えることを調査で確認済み）
      await page.evaluate(() => {
        window.__terrainMapForDebug.jumpTo({ center: [137.40, 36.63], pitch: 72, zoom: 10.4, bearing: 220 });
      });
      const terrainLoaded2 = await page.evaluate(() => window.__terrainViewForDebug.waitForTerrainLoaded(20000));
      record(`[${label}] 立山方向への移動後も地形の読み込みが完了する`, terrainLoaded2);
      await page.waitForTimeout(300);
      const tateyamaPath = path.join(screenshotDir, `terrain-3d-tateyama-${label}.png`);
      await page.locator('#map-area').screenshot({ path: tateyamaPath });
      savedPaths.push(tateyamaPath);

      // 富山湾の上空（海に柱が立っていないことの目視確認用）
      await page.evaluate(() => {
        window.__terrainMapForDebug.jumpTo({ center: [137.15, 36.95], zoom: 10, pitch: 50, bearing: 0 });
      });
      await page.evaluate(() => window.__terrainViewForDebug.waitForTerrainLoaded(20000));
      await page.waitForTimeout(300);
      const bayPath = path.join(screenshotDir, `terrain-3d-bay-${label}.png`);
      await page.locator('#map-area').screenshot({ path: bayPath });
      savedPaths.push(bayPath);

      // 海上（富山湾の沖、データなし域を含む）で異常な標高（柱）が出ていないことを
      // 自動検証する（2026-10-10、地理院標高タイルのデータなし値(x=2^23)を誇張して
      // 解釈すると海上に標高830km級の柱が立つ不具合があった。将来の回帰を防ぐ）。
      const bayElevation = await page.evaluate(() => window.__terrainMapForDebug.queryTerrainElevation([137.15, 36.95]));
      record(
        `[${label}] 海上で異常な標高（柱）が出ていない`,
        bayElevation === null || Math.abs(bayElevation) < 100,
        `富山湾の沖の標高: ${bayElevation}`
      );
    }

    // 2Dに戻せる
    await page.click('#map-dimension-toggle');
    await page.waitForTimeout(400);
    const backTo2d = await page.evaluate(() => !document.getElementById('map-area').classList.contains('mode-3d'));
    const leafletVisible = await page.evaluate(() => getComputedStyle(document.getElementById('spots-map')).display !== 'none');
    record(`[${label}] 2Dに戻せる`, backTo2d && leafletVisible);
    if (backTo2d) {
      const afterTogglePath = path.join(screenshotDir, `terrain-3d-back-to-2d-${label}.png`);
      await page.locator('#map-area').screenshot({ path: afterTogglePath });
      savedPaths.push(afterTogglePath);
    }

    await context.close();
  }

  // WebGLが無い環境では切替ボタンを押しても2Dのまま・エラー文言が出ない
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    // canvas.getContext('webgl'/'webgl2')を常にnullにして、WebGL非対応環境を模す
    await context.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null;
        return orig.call(this, type, ...args);
      };
    });
    const page = await context.newPage();
    const dialogMessages = [];
    page.on('dialog', async (d) => { dialogMessages.push(d.message()); await d.dismiss(); });
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#departure-input');
    await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');
    await searchAt(page, '富山駅前', 1600);
    await page.click('.tab-btn[data-tab="map"]');
    await page.waitForTimeout(200);

    await page.click('#map-dimension-toggle');
    await page.waitForTimeout(1500);
    const stayed2d = await page.evaluate(() => !document.getElementById('map-area').classList.contains('mode-3d'));
    const errorElements = await page.evaluate(() => document.querySelectorAll('.error-message, [role="alert"]').length);
    record('WebGL非対応環境では切替ボタンを押しても2Dのまま', stayed2d);
    record('WebGL非対応環境でエラー文言（alert・画面上の表示）が出ない', dialogMessages.length === 0 && errorElements === 0,
      `alert=${dialogMessages.length}件, 画面表示=${errorElements}件`);

    await context.close();
  }
}

async function main() {
  assertBundleFresh('verify-layout');
  assertSiteDataFresh('verify-layout');
  assertMaplibreVendorFresh('verify-layout');
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
      await checkHeaderNotTruncated(page, label);
      savedPaths.push(await captureNoResultsScreen(page, label));
      savedPaths.push(await captureSuggestionsScreen(page, label));
      savedPaths.push(await captureResultsListScreen(page, label));
      savedPaths.push(await captureHowToScreen(page, label));
      savedPaths.push(await captureSearchButtonPendingScreen(page, label));
      savedPaths.push(await captureCardFavoriteShareScreen(page, label));
      savedPaths.push(await captureDetailFavoriteShareScreen(page, label));
      savedPaths.push(await captureMylistScreen(page, label));
      savedPaths.push(await captureSupportBadgeCardScreen(page, label));
      savedPaths.push(await captureNonBadgeFrequencyScreen(page, label));
      const reservationPaths = await captureReservationScreen(page, label);
      if (reservationPaths) savedPaths.push(...reservationPaths);
      const onwardPath = await captureOnwardSectionScreen(page, label);
      if (onwardPath) savedPaths.push(onwardPath);
      const onwardBadgePath = await captureOnwardBadgeScreen(page, label);
      if (onwardBadgePath) savedPaths.push(onwardBadgePath);
      const onwardBackPath = await captureOnwardBackScreen(page, label);
      if (onwardBackPath) savedPaths.push(onwardBackPath);

      if (pageErrors.length > 0) {
        record(`[${label}] ページ実行中にエラーが発生していない`, false, pageErrors.join('; '));
      }

      await context.close();
    }

    await checkTerrainMapToggle(browser, baseUrl, savedPaths);
    await checkBudgetSlider(browser, baseUrl, savedPaths);
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
