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

// terrain-map-view.jsのSPOT_FOCUS_DURATION_MS（2600ms）のflyToが
// 確実に完了するのを待つ時間（2026-10-11、5本目）。
const SPOT_FOCUS_WAIT_MS = 3200;

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

/** 3D地図で、指定した名前のスポットのlatitude/longitudeと直近の出発駅を取る。
 * 【2026-10-15、11本目②】checkDescendTiltChoreography専用のローカル関数
 * だったものを、checkReturnToOverviewからも使うためモジュール直下へ移した。 */
async function findSpotAndStation(page, spotName) {
  return page.evaluate((name) => {
    const feats = window.__terrainMapForDebug.querySourceFeatures('spots');
    const f = feats.find((x) => x.properties.name === name);
    const spot = f ? { latitude: f.geometry.coordinates[1], longitude: f.geometry.coordinates[0] } : null;
    const station = window.__terrainViewForDebug._lastDepartureStation;
    return { spot, station };
  }, spotName);
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
  // 状態を崩したまま次に渡さない）。旧#back-btnは6本目Eで「見てきた場所」の
  // 足あと表示に置き換わった。カードから直接開いた詳細（この先への履歴なし）
  // なので「一覧」を押すのが旧back-btnと同じ結果になる。
  await page.click('.breadcrumb-list-link').catch(() => {});
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
  await page.click('.breadcrumb-list-link').catch(() => {});
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
  // 旧#back-btn×2（候補詳細→元の詳細→一覧）を、足あとの「1つ前」→「一覧」の
  // クリックに置き換える。この時点の足あとは「一覧 ＞ 元の場所 ＞ 候補」
  // （trail.length=2）のため、「1つ前」はdata-history-index="0"。
  await page.click('[data-history-index="0"]').catch(() => {});
  await page.click('.breadcrumb-list-link').catch(() => {});
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
    await page.click('.breadcrumb-list-link').catch(() => {});
    return null;
  }

  const onwardSection = page.locator('.onward-section');
  const screenshotPath = path.join(screenshotDir, `onward-badge-${viewportLabel}.png`);
  await screenshotElementSafely(page, onwardSection, screenshotPath, VIEWPORTS[viewportLabel]);

  await checkNoHorizontalOverflow(page, `[${viewportLabel}] この先へ（応援マーク付き）`);
  await page.click('.breadcrumb-list-link').catch(() => {});
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
    await page.click('.breadcrumb-list-link').catch(() => {});
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
  await page.click('.breadcrumb-list-link').catch(() => {});
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

      // 【2026-10-14、10本目②】円の半径が「今の予算以内で一番遠い場所までの
      // 直線距離」と一致することを検証する。haversine式はテスト側で独立に
      // 再実装し、view内部が今持っているデータ（_lastSpots/_departureStation）
      // から期待値を出す（裏取得の完了タイミングに左右されないよう、view自身の
      // 現在のデータを基準にする）。2D・3D両方を見る。
      await page.waitForTimeout(100); // requestAnimationFrame 1コマ分の塗り替えを待つ
      const circleCheck = await page.evaluate((budget) => {
        const toRad = (d) => (d * Math.PI) / 180;
        const haversine = (lat1, lon1, lat2, lon2) => {
          const R = 6371;
          const dPhi = toRad(lat2 - lat1);
          const dLambda = toRad(lon2 - lon1);
          const a = Math.sin(dPhi / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLambda / 2) ** 2;
          return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
        };
        const mv = window.__mapViewForDebug;
        const tv = window.__terrainViewForDebug;
        const compute = (spots, dep) => {
          if (!dep) return 0;
          return spots.reduce((max, s) => {
            if (typeof s.latitude !== 'number' || typeof s.longitude !== 'number') return max;
            if (s.source_round_trip_fare > budget) return max;
            return Math.max(max, haversine(dep.stop_lat, dep.stop_lon, s.latitude, s.longitude));
          }, 0);
        };
        const expected2d = mv ? compute(mv._lastSpots || [], mv._departureStation) : null;
        const expected3d = tv ? compute(tv._lastSpots || [], tv._lastDepartureStation) : null;
        return {
          expected2d, actual2d: mv ? mv._reachCircleRadiusKm : null,
          expected3d, actual3d: tv ? tv._reachCircleRadiusKm : null,
        };
      }, budget);
      record(
        `[${station} ¥${budget}] 2Dの円の半径が「予算以内で一番遠い場所までの距離」と一致する`,
        circleCheck.expected2d !== null && Math.abs(circleCheck.expected2d - circleCheck.actual2d) < 0.01,
        JSON.stringify(circleCheck)
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
    // 【不具合修正】¥2000全域の裏取得（scheduleMaxBudgetPrefetch）は波の演出を
    // 邪魔しないよう意図的に1200ms遅らせてある（main.jsのWAVE_REVEAL_SAFE_DELAY_MS
    // 参照）。これを待たずに「ドラッグ前」の円半径を読むと、まだ帯スポットだけの
    // 狭いデータセットを基準にしてしまい、¥2000へドラッグしても同じデータセットの
    // ままなので半径が変わらない（＝ドラッグの効果ではなく裏取得未完了が原因）という
    // 見かけ上の失敗になる。裏取得が確実に終わるまで待ってから基準値を読む。
    await page.waitForTimeout(1500);

    const cardsBefore = await page.locator('.spot-card h3').allTextContents();
    // 【2026-10-14、10本目①②、Minami決定：A】地図の点（2D）は変えず、円の半径だけ
    // 変わることを検証する。
    const markersBeforeDrag = await page.evaluate(() => {
      const mv = window.__mapViewForDebug;
      return {
        count: mv.markersBySpotId.size,
        visible: Array.from(mv.markersBySpotId.values()).filter((m) => m.getElement()?.style.display !== 'none').length,
        circleKm: mv._reachCircleRadiusKm,
      };
    });
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
    const markersDuringDrag = await page.evaluate(() => {
      const mv = window.__mapViewForDebug;
      return {
        count: mv.markersBySpotId.size,
        visible: Array.from(mv.markersBySpotId.values()).filter((m) => m.getElement()?.style.display !== 'none').length,
        circleKm: mv._reachCircleRadiusKm,
      };
    });
    record(
      'スライダーを動かしている間、地図の点（2D）の数・表示状態は変わらない',
      markersBeforeDrag.count === markersDuringDrag.count && markersBeforeDrag.visible === markersDuringDrag.visible,
      `変更前${JSON.stringify(markersBeforeDrag)} → ドラッグ中${JSON.stringify(markersDuringDrag)}`
    );
    record(
      'スライダーを動かしている間、円の半径は変わる（¥1000→¥2000）',
      markersDuringDrag.circleKm > markersBeforeDrag.circleKm,
      `変更前${markersBeforeDrag.circleKm}km → ドラッグ中${markersDuringDrag.circleKm}km`
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
      // 地形の読み込みを待ってから撮る（Minami指示4本目④）。
      // 【2026-10-14、10本目①②】検索を挟まずスライダーだけ動かしているため、
      // 地図の点は検索時（¥1000）のまま変わらず、到達範囲の円だけが
      // 400/1000/2000の順に変わる（Minami決定：A）。
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

/**
 * 【2026-10-14、10本目②③】検索後の波の演出（出発駅から近い順に点が出る）と、
 * 「検索前はスライダーが円だけを動かす」ことを合わせて検証する。
 * - 通常時：検索直後は一部の点がまだ隠れていて、1.5秒待つと全部出る（2D）。
 *   3Dは「filterに距離条件が一時的に入り、1.5秒後に外れる」ことで同じ現象を見る。
 * - prefers-reduced-motionのときは検索直後から隠れている点が無い（即座に全部出る）。
 * - スクリーンショット：富山駅前・2D/3D・PC/スマホで、¥600と¥1600（検索前、
 *   円だけ変わる）、検索を押した直後、1秒後。
 */
async function checkWaveRevealAndCircleScreenshots(browser, baseUrl, savedPaths) {
  console.log('\n=== 検索後の波の演出・到達円の検証（10本目②③） ===');

  // --- 1) 通常時：地図タブを見ながら検索すると、直後は一部が隠れていて、
  // 1.5秒待つと全部出る ---
  {
    const context = await browser.newContext({ viewport: VIEWPORTS.sp });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#departure-input');
    await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');
    await page.fill('#departure-input', '富山駅前');
    await page.waitForTimeout(400);
    await page.locator('.suggestion-item', { hasText: '富山駅前' }).first().click();
    for (let i = 0; i < 20; i++) {
      const value = parseInt(await page.inputValue('#budget-input'), 10);
      if (value === 1000) break;
      if (value < 1000) await page.click('#budget-increment'); else await page.click('#budget-decrement');
    }
    // 【不具合修正】地図タブが非表示（一覧タブ側）のままだと#spots-mapのコンテナが
    // 0×0のままで、Leafletがマーカーのアイコン要素をまだ作らない
    // （marker.getElement()がundefinedを返す。MapView.applyBudget()が同じ理由で
    // コンテナサイズ0の間は塗り替えを保留するのと同じ制約）。地図タブを検索前に
    // 開いておき、コンテナに実寸がある状態で検索する。
    await page.click('.tab-btn[data-tab="map"]');
    await page.waitForTimeout(200);
    await page.click('#search-btn');
    // 一覧タブが非表示のため.spot-cardは「存在するが不可視」になりうる。
    // 存在だけを待つ（visible待ちのwaitForSelectorは使わない）。
    await page.waitForFunction(
      () => document.querySelector('.spot-card, .no-results') !== null,
      { timeout: 15000 }
    );
    const countHidden = () => page.evaluate(() => {
      const mv = window.__mapViewForDebug;
      return Array.from(mv.markersBySpotId.values()).filter((m) => m.getElement()?.classList.contains('pin-wave-hidden')).length;
    });
    const hiddenSoonAfter = await countHidden();
    record('[波の演出/2D] 検索直後は一部の点がまだ隠れている', hiddenSoonAfter > 0, `直後に隠れている点=${hiddenSoonAfter}件`);
    await page.waitForTimeout(1500);
    const hiddenAfterWait = await countHidden();
    record('[波の演出/2D] 1.5秒待つと全部の点が出る', hiddenAfterWait === 0, `1.5秒後に隠れている点=${hiddenAfterWait}件`);
    await context.close();
  }

  // --- 1b) 【不具合修正の検証】一覧タブを見ながら検索した場合（地図コンテナが
  // 検索時点では0×0）でも、後で地図タブを開くと波の演出が改めて行われる ---
  {
    const context = await browser.newContext({ viewport: VIEWPORTS.sp });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#departure-input');
    await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');
    await page.fill('#departure-input', '富山駅前');
    await page.waitForTimeout(400);
    await page.locator('.suggestion-item', { hasText: '富山駅前' }).first().click();
    for (let i = 0; i < 20; i++) {
      const value = parseInt(await page.inputValue('#budget-input'), 10);
      if (value === 1000) break;
      if (value < 1000) await page.click('#budget-increment'); else await page.click('#budget-decrement');
    }
    // 一覧タブのまま（地図タブへは切り替えない）検索する。
    await page.click('#search-btn');
    await page.waitForSelector('.spot-card, .no-results', { timeout: 15000 });
    const pendingFlag = await page.evaluate(() => window.__mapViewForDebug._pendingWaveReveal);
    record('[波の演出/2D/一覧タブのまま検索] 波の演出が保留扱いになる（コンテナ未準備のため）', pendingFlag === true, `_pendingWaveReveal=${pendingFlag}`);
    // ここで初めて地図タブを開く＝invalidateMapSize()が波の演出をやり直すはず。
    // layout-controller.jsのinvalidateMapSize()はrequestAnimationFrame 1コマ分
    // 遅れて実行されるため、クリック直後ではなく、保留フラグが落ちる
    // （＝やり直しが実行された）のをポーリングで待つ。
    await page.click('.tab-btn[data-tab="map"]');
    await page.waitForFunction(
      () => window.__mapViewForDebug._pendingWaveReveal === false,
      { timeout: 2000 }
    ).catch(() => {});
    const hiddenRightAfterTabOpen = await page.evaluate(() => {
      const mv = window.__mapViewForDebug;
      return Array.from(mv.markersBySpotId.values()).filter((m) => m.getElement()?.classList.contains('pin-wave-hidden')).length;
    });
    record('[波の演出/2D/一覧タブのまま検索] 地図タブを開くと波の演出が改めて始まる', hiddenRightAfterTabOpen > 0, `隠れている点=${hiddenRightAfterTabOpen}件`);
    await context.close();
  }

  // --- 2) prefers-reduced-motion：検索直後から隠れている点が無い ---
  {
    const context = await browser.newContext({ viewport: VIEWPORTS.sp, reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#departure-input');
    await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');
    await searchAt(page, '富山駅前', 1000);
    const hiddenImmediately = await page.evaluate(() => {
      const mv = window.__mapViewForDebug;
      return Array.from(mv.markersBySpotId.values()).filter((m) => m.getElement()?.classList.contains('pin-wave-hidden')).length;
    });
    record(
      '[波の演出/reduced-motion] 検索直後から隠れている点が無い（即座に全部出る）',
      hiddenImmediately === 0,
      `隠れている点=${hiddenImmediately}件`
    );
    await context.close();
  }

  // --- 3) 3D：検索直後はfilterに距離条件が入っており、1.5秒待つと外れる ---
  {
    const context = await browser.newContext({ viewport: VIEWPORTS.pc });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#departure-input');
    await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');
    await searchAt(page, '富山駅前', 1000);
    await page.click('#map-dimension-toggle');
    const became3d = await page.waitForFunction(
      () => document.getElementById('map-area').classList.contains('mode-3d'),
      { timeout: 30000 }
    ).then(() => true).catch(() => false);
    if (became3d) {
      await page.evaluate(() => window.__terrainViewForDebug.waitForTerrainLoaded(30000));
      // 別の予算に変えてから検索し直し、波の演出を新たに発生させる。
      for (let i = 0; i < 20; i++) {
        const value = parseInt(await page.inputValue('#budget-input'), 10);
        if (value === 1600) break;
        if (value < 1600) await page.click('#budget-increment'); else await page.click('#budget-decrement');
      }
      await page.click('#search-btn');
      await page.waitForSelector('.spot-card, .no-results', { timeout: 15000 });
      // 【不具合修正、3回目】_waveFrameも、実はapplyBudget()自体が
      // requestAnimationFrame 1コマ分、実際の塗り替え（_paintBudget→
      // _startWaveReveal）を間引いている（スライダー連打対策、7本目からの
      // 既存の仕組み）ため、_startWaveReveal()が呼ばれるタイミング自体が
      // 1フレーム遅れうる。フルスイートの重いGPU負荷下ではこの1フレームの
      // 遅れが実測で無視できない長さになり、「検索直後」の時点ではまだ
      // _startWaveReveal()自体が呼ばれていないことがあった。render()の
      // 呼び出しスタック内でrAFを一切介さず同期的に設定される
      // _pendingPaintReveal（applyBudget()参照）を見れば、「検索によって
      // reveal:trueのrender()が実際に呼ばれたか」をレンダリングの遅延に
      // 影響されず確認できる。
      const pendingRevealRequested = await page.evaluate(() => window.__terrainViewForDebug._pendingPaintReveal);
      record(
        '[波の演出/3D] 検索によって波の演出（reveal）が要求されている',
        pendingRevealRequested === true,
        `_pendingPaintReveal=${pendingRevealRequested}`
      );
      await page.waitForTimeout(1500);
      const filterAfterWait = await page.evaluate(() => window.__terrainMapForDebug.getFilter('spots-circle'));
      record(
        '[波の演出/3D] 1.5秒待つと距離条件が外れる（予算の条件だけになる＝波が終わる）',
        Array.isArray(filterAfterWait) && filterAfterWait[0] === '<=',
        JSON.stringify(filterAfterWait)
      );
    } else {
      record('[波の演出/3D] 3D化（検証の前提）', false);
    }
    await context.close();
  }

  // --- 4) スクリーンショット：富山駅前・2D/3D・PC/スマホで、¥600・¥1600（検索前）、
  // 検索直後、1秒後 ---
  for (const dim of ['2d', '3d']) {
    for (const [label, viewport] of Object.entries(VIEWPORTS)) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForSelector('#departure-input');
      await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');
      await searchAt(page, '富山駅前', 1000);
      if (label === 'sp') await page.click('.tab-btn[data-tab="map"]').catch(() => {});
      if (dim === '3d') {
        await page.click('#map-dimension-toggle');
        const became3d = await page.waitForFunction(
          () => document.getElementById('map-area').classList.contains('mode-3d'),
          { timeout: 30000 }
        ).then(() => true).catch(() => false);
        record(`[円のスクリーンショット/${dim}/${label}] 3D化に成功`, became3d);
        if (!became3d) { await context.close(); continue; }
        await page.evaluate(() => window.__terrainViewForDebug.waitForTerrainLoaded(30000));
      }
      const mapAreaBox = () => page.locator('#map-area').boundingBox();

      for (const budget of [600, 1600]) {
        await page.evaluate((v) => {
          const el = document.getElementById('budget-slider');
          el.value = v;
          el.dispatchEvent(new Event('input'));
        }, budget);
        await page.waitForTimeout(250);
        const shotPath = path.join(screenshotDir, `budget-circle-${dim}-${budget}-presearch-${label}.png`);
        await page.screenshot({ path: shotPath, clip: await mapAreaBox() });
        savedPaths.push(shotPath);
        console.log(`  保存: budget-circle-${dim}-${budget}-presearch-${label}.png`);
      }

      await page.click('#search-btn');
      // 【不具合修正】spではこの時点で地図タブへ切り替え済み（一覧タブが
      // display:none）のため、waitForSelectorの既定（visible待ち）は
      // .spot-cardが「存在するが不可視」の状態で永遠にタイムアウトする。
      // 存在だけを待つwaitForFunctionに替える。
      await page.waitForFunction(
        () => document.querySelector('.spot-card, .no-results') !== null,
        { timeout: 15000 }
      );
      const immediatePath = path.join(screenshotDir, `budget-circle-${dim}-search-immediate-${label}.png`);
      await page.screenshot({ path: immediatePath, clip: await mapAreaBox() });
      savedPaths.push(immediatePath);
      console.log(`  保存: budget-circle-${dim}-search-immediate-${label}.png`);

      await page.waitForTimeout(1000);
      const plus1sPath = path.join(screenshotDir, `budget-circle-${dim}-search-plus1s-${label}.png`);
      await page.screenshot({ path: plus1sPath, clip: await mapAreaBox() });
      savedPaths.push(plus1sPath);
      console.log(`  保存: budget-circle-${dim}-search-plus1s-${label}.png`);

      await context.close();
    }
  }
}

async function checkTerrainMapToggle(browser, baseUrl, savedPaths) {
  console.log('\n=== 2D/3D切替（3D地図の土台）の検証 ===');

  for (const [label, viewport] of Object.entries(VIEWPORTS)) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    // 【2026-10-11追加】Worker URL解決ミスで「Workerが実は1度も起動していな
    // かった」のに、地形読み込みの検証（terrainLoaded）自体は素通りしていた
    // 反省から、gsi-dem-worker.jsへのリクエストが実際に200で返ること、変換が
    // メインスレッドにフォールバックしていないことを機械的に確認する。
    const workerResponses = [];
    page.on('response', (res) => {
      if (res.url().includes('gsi-dem-worker')) workerResponses.push(res.status());
    });
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#departure-input');
    await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');
    await searchAt(page, '富山駅前', 1600);
    if (label === 'sp') {
      await page.click('.tab-btn[data-tab="map"]');
      await page.waitForTimeout(200);
    }

    // 【2026-10-11追加】「地形読み込み完了」が「平らな地図」より速く終わる
    // （setTerrain()は平らな地図のload後にしか呼ばないため、原理的に起こり
    // 得ない）矛盾をMinamiが指摘。原因はwaitForTerrainLoaded()がMapLibreの
    // 複数バッチ読み込みの最初のバッチだけで完了と誤判定していたこと
    // （terrain-map-view.js参照、settleベースの待機に修正済み）。クリック直後、
    // flat map load（ensureMap()が解決する基準）とterrain load（修正後の
    // waitForTerrainLoaded()が解決する基準）の両方のタイムスタンプを記録し、
    // 「地形 >= 平らな地図」の順序が常に成り立つことを回帰チェックする。
    await page.click('#map-dimension-toggle');
    await page.waitForFunction(() => !!window.__terrainMapForDebug, { timeout: 10000 }).catch(() => {});
    await page.evaluate(() => {
      window.__perfTiming = {};
      if (!window.__terrainMapForDebug) return;
      window.__terrainMapForDebug.once('load', () => { window.__perfTiming.flatMapAt = Date.now(); });
      window.__terrainViewForDebug.waitForTerrainLoaded(60000).then((ok) => {
        window.__perfTiming.terrainAt = Date.now();
        window.__perfTiming.terrainOk = ok;
      });
    });

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

      // 地形 >= 平らな地図の順序が崩れていないか（2026-10-11追加の回帰チェック）。
      const timing = await page.evaluate(() => window.__perfTiming);
      record(
        `[${label}] 地形の読み込み完了が平らな地図より後（または同時）である`,
        typeof timing.flatMapAt === 'number' && typeof timing.terrainAt === 'number' && timing.terrainAt >= timing.flatMapAt,
        `flatMapAt=${timing.flatMapAt}, terrainAt=${timing.terrainAt}, 差=${timing.terrainAt - timing.flatMapAt}ms`
      );

      // Workerが実際に起動・使用されていることの確認（2026-10-11追加）。
      record(
        `[${label}] gsi-dem-worker.jsへのリクエストが200で返る`,
        workerResponses.length > 0 && workerResponses.every((s) => s === 200),
        `${workerResponses.length}件: ${JSON.stringify(workerResponses)}`
      );
      const conversionStats = await page.evaluate(() => window.__gsiDemConversionStats);
      record(
        `[${label}] DEMタイルの変換がWorker経由で行われている（メインスレッドに落ちていない）`,
        conversionStats && conversionStats.viaWorker > 0 && conversionStats.viaMainThread === 0,
        JSON.stringify(conversionStats)
      );
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

      // 立山連峰が見える向き（Minami指示：富山駅前から南東・pitch70前後・
      // ズーム10前後）。bearingはCoworkの指摘を受けて実機でbearing=0,45,...,315を
      // 振り、画面上部（遠方）の地点のqueryTerrainElevationが最も高くなる値を
      // 確認した結果、130（富山湾を背にして立山連峰側を向く）に修正した
      // （旧220は富山湾＝北側が奥に見えてしまっていた）。
      await page.evaluate(() => {
        window.__terrainMapForDebug.jumpTo({ center: [137.2133, 36.7004], pitch: 70, zoom: 10, bearing: 130 });
      });
      // 【2026-10-11修正】waitForTerrainLoaded()が複数バッチの最後まで正しく
      // 待つよう直った結果、立山方向（zoom10・pitch70、高標高域で要求タイルが
      // 多い）の地形読み込みは実測36秒程度かかることが分かった（旧20秒の
      // タイムアウトでは「未完了」に化けていた。実機トレースで
      // ok=true・所要36059msを確認済み、ハングしているわけではない）。
      const terrainLoaded2 = await page.evaluate(() => window.__terrainViewForDebug.waitForTerrainLoaded(60000));
      record(`[${label}] 立山方向への移動後も地形の読み込みが完了する`, terrainLoaded2);
      await page.waitForTimeout(300);

      // 画面上部（奥）に標高2000m以上の地点が入っていることを確認する
      // （Minami指示：数字で確認する）。PC（横長）とsp（縦長）でアスペクト比が
      // 大きく異なり、1点だけだと同じfrac指定でも実際に遠景が指す地点がずれる
      // （実機でpcだけ標高0mになる例を確認）ため、画面上部の複数の高さで
      // 調べて最大値を見る。
      const highPointElevation = await page.evaluate(() => {
        const map = window.__terrainMapForDebug;
        const canvas = map.getCanvas();
        const w = canvas.width / (window.devicePixelRatio || 1);
        const h = canvas.height / (window.devicePixelRatio || 1);
        let max = null;
        for (const frac of [0.02, 0.05, 0.08, 0.12, 0.16]) {
          const pt = map.unproject([w / 2, h * frac]);
          const elev = map.queryTerrainElevation([pt.lng, pt.lat]);
          if (elev !== null && (max === null || elev > max)) max = elev;
        }
        return max;
      });
      record(
        `[${label}] 立山方向の画面に標高2000m以上の地点が入っている`,
        highPointElevation !== null && highPointElevation >= 2000,
        `画面上部付近の最高標高: ${highPointElevation}m`
      );

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

/**
 * 【2026-10-11追加】高松築港で3D表示が毎回失敗する不具合があった
 * （原因：new Worker('gsi-dem-worker.js')がドキュメント基準でURL解決され
 * 404・全ワーカー起動失敗・応答待ちのpendingRequestsが永久に残る、の2点）。
 * 富山駅前（checkTerrainMapToggle）以外の基準駅でも3Dが開けることを確認する。
 * 公開中の各都道府県から少なくとも1駅（高松築港・琴電琴平＝香川、
 * 小松駅＝石川）を選び、海沿い・内陸どちらでも開けることを見る
 * （高松築港は海沿いでDEMタイル数が多く、今回の不具合が最も再現しやすかった）。
 */
async function checkTerrainMapOpensForBaselineStations(browser, baseUrl) {
  console.log('\n=== 各県の基準駅で3D表示が開けるかの検証 ===');
  const stations = ['高松築港', '琴電琴平', '小松駅'];

  for (const station of stations) {
    const context = await browser.newContext({ viewport: VIEWPORTS.pc });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#departure-input');
    await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');
    await searchAt(page, station, 1000);

    await page.click('#map-dimension-toggle');
    const became3d = await page.waitForFunction(
      () => document.getElementById('map-area').classList.contains('mode-3d'),
      { timeout: 30000 }
    ).then(() => true).catch(() => false);
    record(`[${station}] 切替ボタンで3Dになる`, became3d);

    if (became3d) {
      const terrainLoaded = await page.evaluate(() => window.__terrainViewForDebug.waitForTerrainLoaded(20000));
      record(`[${station}] 地形（標高タイル）の読み込みが完了する`, terrainLoaded);
      const circleCount = await page.evaluate(() => {
        const map = window.__terrainMapForDebug;
        return map ? map.querySourceFeatures('spots').length : -1;
      });
      record(`[${station}] 3D地図上にスポットの点が出る`, circleCount > 0, `${circleCount}件`);
    }

    if (pageErrors.length > 0) record(`[${station}] 3D化中にページエラーが発生していない`, false, pageErrors.join('; '));

    await context.close();
  }
}

/**
 * 【2026-10-11、5本目】3D地図の見せ方改善の検証：
 * 1. 視点を回せる（dragRotate・touchZoomRotate）・コンパスボタンがある
 * 2. 一覧のカードから開いた詳細で、その場所へ寄る（ズーム13以上）、
 *    スマホの詳細画面「地図で見る」でも同様に寄る、詳細は一番上から始まる
 * 3. 足あと（旧「← 一覧に戻る」）の「一覧」で引きすぎ対策の範囲（ズーム9.5以上）に戻る
 * 4. 予算¥2000（対象範囲が広がる）でも引きすぎない（ズーム9.5以上）
 * （いずれもMinami指示、3D限定。2Dの動きは変えていない＝map-view.js無変更。
 * 検証用スポット「城生城」は八尾駅から往復¥400のため、¥2000への変更は
 * 帯表示から消える前＝カードを探す前に行わないこと）
 */
async function checkTerrain3DCameraAndInteraction(browser, baseUrl, savedPaths) {
  console.log('\n=== 3D地図のカメラ（引き・寄り・回転）の検証 ===');

  for (const [label, viewport] of Object.entries(VIEWPORTS)) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#departure-input');
    // 【2026-10-11修正】城生城（八尾駅から往復¥400）は「予算の帯」表示
    // （¥(budget-199)〜¥budget）の外だと一覧に出ない。¥1000だと帯は
    // ¥801〜¥1000でカードが見つからず検証が失敗していた。¥400で検索し、
    // 帯¥201〜¥400に城生城を含める。
    await searchAt(page, '八尾駅', 400);
    if (label === 'sp') {
      await page.click('.tab-btn[data-tab="map"]');
      await page.waitForTimeout(200);
    }

    await page.click('#map-dimension-toggle');
    const became3d = await page.waitForFunction(
      () => document.getElementById('map-area').classList.contains('mode-3d'),
      { timeout: 30000 }
    ).then(() => true).catch(() => false);
    if (!became3d) {
      record(`[${label}] 3D化（カメラ検証の前提）`, false);
      await context.close();
      continue;
    }
    await page.evaluate(() => window.__terrainViewForDebug.waitForTerrainLoaded(60000));

    // 1. 回転・コンパス（budgetやカード選択と無関係なので最初に見る）。
    // 【2026-10-14、10本目①、Minami決定：B】PCの右ドラッグ回転は残すが、
    // スマホの2本指でひねる回転は止める（2本指ズーム・2本指上下の傾きは残す）。
    const rotateState = await page.evaluate(() => ({
      dragRotate: window.__terrainMapForDebug.dragRotate.isEnabled(),
      touchZoomRotateEnabled: window.__terrainMapForDebug.touchZoomRotate.isEnabled(),
      touchRotationDisabled: window.__terrainMapForDebug.touchZoomRotate._rotationDisabled === true,
      touchPitch: window.__terrainMapForDebug.touchPitch.isEnabled(),
    }));
    record(`[${label}] PCの右ドラッグ回転が有効（dragRotate）`, rotateState.dragRotate);
    record(`[${label}] スマホの2本指ズームは有効のまま（touchZoomRotate）`, rotateState.touchZoomRotateEnabled);
    record(`[${label}] スマホの2本指回転だけ無効化されている`, rotateState.touchRotationDisabled);
    record(`[${label}] スマホの2本指上下の傾きは有効のまま（touchPitch）`, rotateState.touchPitch);
    const hasCompass = await page.evaluate(() => !!document.querySelector('.maplibregl-ctrl-compass'));
    record(`[${label}] コンパス（方角ボタン）が表示されている`, hasCompass);

    // 2. 一覧のカードから詳細を開くと、その場所へ寄る（城生城＝八尾駅から
    // 往復¥400で行ける山あいのスポット、Minami指示の例）。
    // 【2026-10-11修正】予算¥2000に変える前（帯¥201〜¥400のうちに）カードを
    // 探す。帯は「budget-199〜budget」だけを表示するため、先に¥2000へ
    // 変えてしまうと城生城（¥400）が一覧から消えて見つからなくなる。
    await page.click('.tab-btn[data-tab="list"]').catch(() => {});
    await page.waitForTimeout(200);
    const card = page.locator('.spot-card', { hasText: '城生城' }).first();
    const cardExists = await card.count().then((n) => n > 0).catch(() => false);
    if (cardExists) {
      await card.click();
      await page.waitForTimeout(SPOT_FOCUS_WAIT_MS);
      if (label === 'sp') {
        // スマホは詳細画面に遷移するだけでは地図が見えないため、
        // 「地図で見る」ボタンでの遷移も合わせて検証する（Minami指示4番）。
        const mapBtn = page.locator('.detail-map-btn');
        const mapBtnVisible = await mapBtn.isVisible().catch(() => false);
        record(`[${label}] 詳細画面に「地図で見る」ボタンがある`, mapBtnVisible);
        if (mapBtnVisible) {
          // 【2026-10-11修正】通常のlocator.click()は、クリック自体のハンドラが
          // 同期的にdata-viewを変えてボタンの入っているコンテナを隠すため、
          // Playwrightのクリック後の可視性再確認がタイムアウトすることがあった。
          // ネイティブのclick()を直接呼び、Playwrightの actionability 再確認を
          // 経由しないようにする。
          await page.evaluate(() => document.querySelector('.detail-map-btn')?.click());
          await page.waitForTimeout(SPOT_FOCUS_WAIT_MS);
          const mapTabActive = await page.evaluate(
            () => document.querySelector('.tab-btn[data-tab="map"]')?.classList.contains('active')
          );
          record(`[${label}] 「地図で見る」で地図タブに切り替わる`, mapTabActive);
        }
      }
      const zoomAfterSelect = await page.evaluate(() => window.__terrainMapForDebug.getZoom());
      record(`[${label}] 場所を選ぶとズーム13以上に寄る`, zoomAfterSelect >= 13, `zoom=${zoomAfterSelect.toFixed(2)}`);

      // 【2026-10-11修正】locator.screenshot()は撮影前に要素の「安定」を
      // ポーリングで待つが、3D地図はWebGLキャンバスを常に再描画しており、
      // setBearing()の直後でも度々タイムアウトした（原因不明、他のmap-area
      // 撮影箇所との違いを調べたが特定できなかった）。このファイルの他の
      // 箇所（行130）と同じ、boundingBox()を取ってpage.screenshot({clip})で
      // 撮る方式に変え、要素の安定待ちそのものを回避する。
      // 【2026-10-14、10本目①】自動回転をまるごと廃止したため、ここで
      // 止めていた_stopAutoRotate()呼び出しは不要になった（削除）。
      const mapAreaBox = await page.locator('#map-area').boundingBox();
      const focusedPath = path.join(screenshotDir, `terrain-3d-spot-focus-${label}.png`);
      await page.screenshot({ path: focusedPath, clip: mapAreaBox });
      savedPaths.push(focusedPath);

      // 回転させたあと（Minami指示のスクリーンショット要件）
      await page.evaluate(() => {
        const map = window.__terrainMapForDebug;
        map.setBearing(map.getBearing() + 110);
      });
      await page.waitForTimeout(300);
      const rotatedPath = path.join(screenshotDir, `terrain-3d-rotated-${label}.png`);
      await page.screenshot({ path: rotatedPath, clip: mapAreaBox });
      savedPaths.push(rotatedPath);

      if (label === 'sp') {
        // 【2026-10-11追加】スマホは「地図で見る」でdata-view="results"（地図
        // タブ）に移っており、足あと（旧#back-btn）が見えない状態になっている
        // （足あとはdata-view="detail"のときだけ表示）。Minami指示
        // 「地図タブから詳細へ戻れること」の経路＝寄った先のピンをタップして
        // 【2026-10-15、11本目①修正】吹き出し（ポップアップ）は廃止され、
        // 地図の下の固定情報枠（#spot-info-panel）に統一された（Minami決定：A）。
        // ここも枠の「詳細を見る」から戻る経路に合わせて更新する。
        // 【試行錯誤】画面中央をタップする方法を試したが、3D地形では標高の
        // ある地点の円が地表の高さぶん持ち上がって描画されるため、
        // 平面投影上の中心（flyToの中心）とピンの実際の描画位置がずれて
        // タップが外れることがあった。ここではピンの正確な画面座標を
        // 得るためにMapLibreのproject()で位置を計算してからクリックする。
        const pinScreenPos = await page.evaluate(() => {
          const map = window.__terrainMapForDebug;
          const feats = map.querySourceFeatures('spots');
          const f = feats.find((x) => x.properties.name === '城生城');
          if (!f) return null;
          const p = map.project(f.geometry.coordinates);
          return { x: p.x, y: p.y };
        });
        let detailBtnVisible = false;
        if (pinScreenPos) {
          const box = await page.locator('#map-area').boundingBox();
          await page.mouse.click(box.x + pinScreenPos.x, box.y + pinScreenPos.y);
          detailBtnVisible = await page.locator('.spot-info-detail-btn').first().isVisible().catch(() => false);
        }
        record(`[${label}] 地図タブでピンをタップすると下の情報枠が出る`, detailBtnVisible);
        if (detailBtnVisible) {
          const btnBox = await page.locator('.spot-info-detail-btn').first().boundingBox();
          await page.mouse.click(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
          await page.waitForFunction(
            () => document.getElementById('app-layout')?.getAttribute('data-view') === 'detail',
            { timeout: 5000 }
          ).catch(() => {});
        }
        const dataViewAfterReturn = await page.evaluate(
          () => document.getElementById('app-layout')?.getAttribute('data-view')
        );
        record(`[${label}] 地図タブで情報枠の「詳細を見る」を実クリックすると詳細へ戻れる`, dataViewAfterReturn === 'detail', `data-view=${dataViewAfterReturn}`);
      }

      // 詳細画面に戻ってスクロール位置を確認（この先へ経由の確認は別関数、
      // ここでは「一覧から新規に開いた詳細が一番上にある」ことだけ見る）。
      const scrollTop = await page.evaluate(() => document.getElementById('detail-container')?.scrollTop ?? -1);
      record(`[${label}] 詳細画面が一番上から始まる`, scrollTop === 0, `scrollTop=${scrollTop}`);

      // 足あとの「一覧」（旧「← 一覧に戻る」）で引きすぎ対策の範囲に戻る
      await page.click('.breadcrumb-list-link');
      await page.waitForTimeout(1000);
      if (label === 'sp') await page.click('.tab-btn[data-tab="map"]').catch(() => {});
      const zoomAfterBack = await page.evaluate(() => window.__terrainMapForDebug.getZoom());
      record(
        `[${label}] 足あとの「一覧」で俯瞰（ズーム9.5以上）に戻る`,
        zoomAfterBack >= 9.5,
        `zoom=${zoomAfterBack.toFixed(2)}`
      );
    } else {
      record(`[${label}] 検証用スポット「城生城」が見つかる`, false);
    }

    // 3. 予算¥2000（対象範囲が広がる）でも引きすぎない（ズーム9.5以上）。
    // 【2026-10-11修正】固定1000ms待機だと、fitToBudget()のeaseTo（600ms）が
    // システム負荷（検証スイート全体を通しで流しているとき等）で遅れ、
    // まだ開始前の値を読んでしまうことがあった（実機確認：単体では正しく
    // 9.5になるのに、スイート内では9.00になるケースを再現）。固定時間でなく、
    // 実際にズームが変化し終わるまでポーリングして待つ。
    if (label === 'sp') await page.click('.tab-btn[data-tab="list"]').catch(() => {});
    const zoomBeforeWide = await page.evaluate(() => window.__terrainMapForDebug.getZoom());
    await page.evaluate(() => {
      const slider = document.getElementById('budget-slider');
      slider.value = '2000';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(
      (prevZoom) => window.__terrainMapForDebug.getZoom() !== prevZoom,
      zoomBeforeWide,
      { timeout: 5000 }
    ).catch(() => {});
    await page.waitForTimeout(800); // easeTo完了後の余韻
    const zoomOverview = await page.evaluate(() => window.__terrainMapForDebug.getZoom());
    record(`[${label}] 3Dで予算¥2000のときのズームが9.5以上`, zoomOverview >= 9.5, `zoom=${zoomOverview.toFixed(2)}`);

    if (label === 'sp') await page.click('.tab-btn[data-tab="map"]').catch(() => {});
    const overviewBox = await page.locator('#map-area').boundingBox();
    const overviewPath = path.join(screenshotDir, `terrain-3d-overview-2000-${label}.png`);
    await page.screenshot({ path: overviewPath, clip: overviewBox });
    savedPaths.push(overviewPath);

    if (pageErrors.length > 0) record(`[${label}] 3Dカメラ検証中にページエラーが発生していない`, false, pageErrors.join('; '));

    await context.close();
  }
}

/**
 * 【2026-10-12、7本目①③】3Dの既定の見た目が「D」（Minami決定：全体=淡色地図＋
 * 強め陰影、寄ったとき＝ズーム13以上＝航空写真＋弱い陰影）であること、
 * 自動回転が場所に寄ったあとに始まり、止めたら再始動しないこと
 * （6本目で残っていた競合の本番修正）を検証する。
 */
async function checkDefaultStyleD(browser, baseUrl, savedPaths) {
  console.log('\n=== 3Dの既定の見た目がD・自動回転の検証（7本目①③） ===');

  const context = await browser.newContext({ viewport: VIEWPORTS.pc });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForSelector('#departure-input');
  await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');
  await searchAt(page, '八尾駅', 400);
  await page.click('#map-dimension-toggle');
  const became3d = await page.waitForFunction(
    () => document.getElementById('map-area').classList.contains('mode-3d'),
    { timeout: 30000 }
  ).then(() => true).catch(() => false);
  record('[D既定] 3D化（検証の前提）', became3d);
  if (!became3d) {
    await context.close();
    return;
  }
  await page.evaluate(() => window.__terrainViewForDebug.waitForTerrainLoaded(60000));

  const layerInfo = await page.evaluate(() => {
    const map = window.__terrainMapForDebug;
    const layerIds = map.getStyle().layers.map((l) => l.id);
    return {
      layerIds,
      hasPale: layerIds.includes('gsi-bg-pale'),
      hasAerial: layerIds.includes('gsi-bg-aerial'),
      hasOldComparisonLayers: layerIds.some((id) => id === 'gsi-bg' || id === 'gsi-bg-overview' || id === 'gsi-bg-zoomed'),
      aerialOpacityExpr: map.getPaintProperty('gsi-bg-aerial', 'raster-opacity'),
    };
  });
  record(
    '[D既定] 背景レイヤーが淡色地図(gsi-bg-pale)＋航空写真(gsi-bg-aerial)の2枚',
    layerInfo.hasPale && layerInfo.hasAerial,
    JSON.stringify(layerInfo.layerIds)
  );
  record('[D既定] 6本目の比較用パターン（gsi-bg/gsi-bg-overview/gsi-bg-zoomed）が残っていない（使わないコードを削除済み）', !layerInfo.hasOldComparisonLayers);
  record(
    '[D既定] 航空写真のraster-opacityがズームで補間される式になっている（パッと切り替わらない）',
    Array.isArray(layerInfo.aerialOpacityExpr) && layerInfo.aerialOpacityExpr[0] === 'interpolate',
    JSON.stringify(layerInfo.aerialOpacityExpr)
  );

  const coords = await page.evaluate((name) => {
    const feats = window.__terrainMapForDebug.querySourceFeatures('spots');
    const f = feats.find((x) => x.properties.name === name);
    return f ? { latitude: f.geometry.coordinates[1], longitude: f.geometry.coordinates[0] } : null;
  }, '城生城');
  record('[D既定] 検証用スポット「城生城」が見つかる', !!coords);
  const station = await page.evaluate(() => window.__terrainViewForDebug._lastDepartureStation);

  if (coords) {
    // 【2026-10-14、10本目①】寄る前後でbearingが変わらないことを見るため、
    // flyToSpot()を呼ぶ直前のbearingを控えておく（Minami決定：B、回転を
    // まるごと廃止。以前は出発駅→スポットの方位角に合わせて回転していた）。
    const bearingBeforeFly = await page.evaluate(() => window.__terrainMapForDebug.getBearing());
    // 【2026-10-13、8本目③】flyToSpot()は「真上(pitch0)から降りる→読み込み
    // 落ち着いたら傾ける」の2段階になったため、onTiltCompleteで両方終わる
    // のを待ってから以降の確認に進む（旧：waitForSceneSettled()を外から
    // 1回呼ぶだけだった。今は内部で2回呼ばれるため、外から呼ぶ意味が無い）。
    await page.evaluate(({ spot, station }) => {
      return new Promise((resolve) => {
        window.__terrainViewForDebug.onTiltComplete = () => resolve();
        window.__terrainViewForDebug.flyToSpot(spot, station);
        setTimeout(resolve, 30000);
      });
    }, { spot: coords, station });
    const zoomAndOpacity = await page.evaluate(() => {
      const map = window.__terrainMapForDebug;
      const zoom = map.getZoom();
      // raster-opacityの式を現在のズームで手動評価する（MapLibreは式の実評価
      // 結果を取得する公開APIを持たないため、2点の線形補間として自前で計算）。
      const expr = map.getPaintProperty('gsi-bg-aerial', 'raster-opacity');
      const [, , , z0, v0, z1, v1] = expr;
      const t = Math.max(0, Math.min(1, (zoom - z0) / (z1 - z0)));
      return { zoom, evaluatedOpacity: v0 + (v1 - v0) * t };
    });
    record(
      '[D既定] 場所に寄る（ズーム13以上）と航空写真の不透明度がほぼ1になる',
      zoomAndOpacity.zoom >= 13 && zoomAndOpacity.evaluatedOpacity >= 0.99,
      JSON.stringify(zoomAndOpacity)
    );

    // 【2026-10-14、10本目①、Minami決定：B】回転をまるごと廃止した検証。
    // 1. 寄る前後でbearingが変わらないこと（以前は出発駅→スポットの方位角に
    //    合わせて回転していたが、「地図が勝手に回る・向きが大きく変わるのが
    //    無駄な動きに感じる」というMinami指摘で廃止した）。
    const bearingAfterFly = await page.evaluate(() => window.__terrainMapForDebug.getBearing());
    record(
      '[回転] 寄る前後でbearingが変わらない',
      Math.abs(bearingAfterFly - bearingBeforeFly) < 0.01,
      `寄る前=${bearingBeforeFly} / 寄った後=${bearingAfterFly}`
    );
    // 2. 何も操作しなくても、ゆっくり回る演出（自動回転）が起きないこと。
    //    10秒待ってもbearingが変わらないことで確認する。
    await page.waitForTimeout(10000);
    const bearingAfterWait = await page.evaluate(() => window.__terrainMapForDebug.getBearing());
    record(
      '[回転] 自動回転が廃止されている（10秒待ってもbearingが変わらない）',
      Math.abs(bearingAfterWait - bearingAfterFly) < 0.01,
      `寄った直後=${bearingAfterFly} / 10秒後=${bearingAfterWait}`
    );

    const mapAreaBox = await page.locator('#map-area').boundingBox();
    const shotPath = path.join(screenshotDir, 'default-style-d-zoomed-pc.png');
    await page.screenshot({ path: shotPath, clip: mapAreaBox });
    savedPaths.push(shotPath);
  }

  if (pageErrors.length > 0) record('[D既定] 検証中にページエラーが発生していない', false, pageErrors.join('; '));
  await context.close();
}

/**
 * 【2026-10-13、8本目③】場所に寄るとき、まず真上（pitch0）から降りて、
 * 画面中央付近の読み込みが落ち着いたら傾けて立体にする（pitch0→60）演出を
 * 検証する。あわせて、降りている途中でユーザーが操作すると演出が止まること、
 * prefers-reduced-motionのときは短く（一度に）なることを確認する。
 */
async function checkDescendTiltChoreography(browser, baseUrl, savedPaths) {
  console.log('\n=== 真上から降りて傾ける演出の検証（8本目③） ===');

  // --- 1. 降りるときpitch0、読み込み後にpitch50〜60になること ---
  {
    const context = await browser.newContext({ viewport: VIEWPORTS.pc });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#departure-input');
    await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');
    await searchAt(page, '八尾駅', 400);
    await page.click('#map-dimension-toggle');
    const became3d = await page.waitForFunction(
      () => document.getElementById('map-area').classList.contains('mode-3d'),
      { timeout: 30000 }
    ).then(() => true).catch(() => false);
    record('[降下→傾け] 3D化（検証の前提）', became3d);
    if (became3d) {
      await page.evaluate(() => window.__terrainViewForDebug.waitForTerrainLoaded(60000));
      const { spot, station } = await findSpotAndStation(page, '城生城');
      record('[降下→傾け] 検証用スポット「城生城」が見つかる', !!spot);
      if (spot) {
        await page.evaluate(() => {
          window.__events = [];
          window.__t0 = performance.now();
          window.__terrainViewForDebug.onOverheadSettled = () => window.__events.push({ t: performance.now() - window.__t0, type: 'overhead', pitch: window.__terrainMapForDebug.getPitch() });
          window.__terrainViewForDebug.onTiltComplete = () => window.__events.push({ t: performance.now() - window.__t0, type: 'tilt', pitch: window.__terrainMapForDebug.getPitch() });
        });
        await page.evaluate(({ spot, station }) => window.__terrainViewForDebug.flyToSpot(spot, station), { spot, station });

        // 【2026-10-13修正】flyTo中のpitch補間は一定速度ではなく（実測：
        // 2600ms中の1500ms時点でもまだ49.9°、ほぼ終盤まで大きく変わらない）、
        // 任意の中間時点で判定すると不安定になる。「真上から降りる」の確認は
        // 降下完了後・傾け始める前（onOverheadSettledの時点）のpitchを見る
        // 方が実装のイージング挙動に左右されず安定する。
        await page.waitForFunction(() => window.__events.some((e) => e.type === 'overhead'), { timeout: 30000 }).catch(() => {});
        const overheadEvent = await page.evaluate(() => window.__events.find((e) => e.type === 'overhead'));
        record(
          '[降下→傾け] 降り終えた時点（傾け始める前）はpitchが0に近い',
          !!overheadEvent && overheadEvent.pitch < 5,
          overheadEvent ? `pitch=${overheadEvent.pitch.toFixed(1)}` : 'overheadイベントが発生しなかった'
        );
        const popupBox1 = await page.locator('#map-area').boundingBox();
        const overheadShotPath = path.join(screenshotDir, 'descend-overhead-jonojo-pc.png');
        await page.screenshot({ path: overheadShotPath, clip: popupBox1 });
        savedPaths.push(overheadShotPath);

        await page.waitForFunction(() => window.__events.some((e) => e.type === 'tilt'), { timeout: 15000 }).catch(() => {});
        const events = await page.evaluate(() => window.__events);
        const tiltEvent = events.find((e) => e.type === 'tilt');
        record(
          '[降下→傾け] 読み込み後、pitchが50〜60になる',
          !!tiltEvent && tiltEvent.pitch >= 50 && tiltEvent.pitch <= 60.5,
          JSON.stringify(events)
        );
        await page.waitForTimeout(500);
        const tiltedShotPath = path.join(screenshotDir, 'descend-tilted-jonojo-pc.png');
        await page.screenshot({ path: tiltedShotPath, clip: popupBox1 });
        savedPaths.push(tiltedShotPath);
      }
    }
    await context.close();
  }

  // --- 1b. 同じ構図（八尾駅→城生城）のスマホ幅スクリーンショット ---
  {
    const context = await browser.newContext({ viewport: VIEWPORTS.sp });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#departure-input');
    await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');
    await searchAt(page, '八尾駅', 400);
    await page.click('.tab-btn[data-tab="map"]').catch(() => {});
    await page.click('#map-dimension-toggle');
    const became3dSp = await page.waitForFunction(
      () => document.getElementById('map-area').classList.contains('mode-3d'),
      { timeout: 30000 }
    ).then(() => true).catch(() => false);
    if (became3dSp) {
      await page.evaluate(() => window.__terrainViewForDebug.waitForTerrainLoaded(60000));
      const { spot, station } = await findSpotAndStation(page, '城生城');
      if (spot) {
        await page.evaluate(() => {
          window.__events = [];
          window.__t0 = performance.now();
          window.__terrainViewForDebug.onOverheadSettled = () => window.__events.push({ t: performance.now() - window.__t0, type: 'overhead' });
          window.__terrainViewForDebug.onTiltComplete = () => window.__events.push({ t: performance.now() - window.__t0, type: 'tilt' });
        });
        await page.evaluate(({ spot, station }) => window.__terrainViewForDebug.flyToSpot(spot, station), { spot, station });
        await page.waitForFunction(() => window.__events.some((e) => e.type === 'overhead'), { timeout: 30000 }).catch(() => {});
        const mapBox = await page.locator('#map-area').boundingBox();
        const overheadShotSp = path.join(screenshotDir, 'descend-overhead-jonojo-sp.png');
        await page.screenshot({ path: overheadShotSp, clip: mapBox });
        savedPaths.push(overheadShotSp);
        await page.waitForFunction(() => window.__events.some((e) => e.type === 'tilt'), { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(500);
        const tiltedShotSp = path.join(screenshotDir, 'descend-tilted-jonojo-sp.png');
        await page.screenshot({ path: tiltedShotSp, clip: mapBox });
        savedPaths.push(tiltedShotSp);
      }
    }
    await context.close();
  }

  // --- 2. 降りている途中でユーザーが操作すると演出が止まること ---
  {
    const context = await browser.newContext({ viewport: VIEWPORTS.pc });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#departure-input');
    await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');
    await searchAt(page, '八尾駅', 400);
    await page.click('#map-dimension-toggle');
    await page.waitForFunction(() => document.getElementById('map-area').classList.contains('mode-3d'), { timeout: 30000 }).catch(() => {});
    await page.evaluate(() => window.__terrainViewForDebug.waitForTerrainLoaded(60000));
    const { spot, station } = await findSpotAndStation(page, '城生城');
    if (spot) {
      await page.evaluate(() => {
        window.__events = [];
        window.__t0 = performance.now();
        window.__terrainViewForDebug.onTiltComplete = () => window.__events.push({ t: performance.now() - window.__t0, type: 'tilt' });
      });
      await page.evaluate(({ spot, station }) => window.__terrainViewForDebug.flyToSpot(spot, station), { spot, station });
      // 降りている途中（真上から降りる演出はSPOT_FOCUS_DURATION_MS=2600msかかる）に
      // 本物のホイール操作で割り込む（page.mouse.wheelは実際のDOMイベントを発生させる
      // ため、MapLibreのe.originalEventが付く＝プログラム操作と区別できる）。
      // 【不具合修正】固定座標(960,540)はビューポート中央だが、PCのこのレイアウトでは
      // #map-areaが画面幅いっぱいではなく左寄りの一部（実測x:376〜867程度）のため、
      // 中央座標だと一覧側のボタンにホイールイベントが当たってしまい、地図側の
      // wheelハンドラに届いていなかった（verify-layoutで「傾け演出が行われない」が
      // 失敗＝実際には傾け演出が止まらずに最後まで進んでいたことで発覚）。
      // #map-areaの実際の矩形の中心を使う。
      await page.waitForTimeout(800);
      const mapAreaBoxForWheel = await page.locator('#map-area').boundingBox();
      await page.mouse.move(
        mapAreaBoxForWheel.x + mapAreaBoxForWheel.width / 2,
        mapAreaBoxForWheel.y + mapAreaBoxForWheel.height / 2
      );
      await page.mouse.wheel(0, -100);
      await page.waitForTimeout(5000); // 本来傾け終わるはずの時間を過ぎても待つ
      const events = await page.evaluate(() => window.__events);
      record('[降下→傾け] 降りている途中で操作すると、傾け演出が行われない', events.length === 0, JSON.stringify(events));
    } else {
      record('[降下→傾け] 操作による中断の検証用スポットが見つかる', false);
    }
    await context.close();
  }

  // --- 3. prefers-reduced-motionのときは短く（一度に）なること ---
  {
    const context = await browser.newContext({ viewport: VIEWPORTS.pc, reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#departure-input');
    await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');
    await searchAt(page, '八尾駅', 400);
    await page.click('#map-dimension-toggle');
    await page.waitForFunction(() => document.getElementById('map-area').classList.contains('mode-3d'), { timeout: 30000 }).catch(() => {});
    await page.evaluate(() => window.__terrainViewForDebug.waitForTerrainLoaded(60000));
    const { spot, station } = await findSpotAndStation(page, '城生城');
    if (spot) {
      const reducedMotionDetected = await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      record('[降下→傾け] reduced-motionがブラウザ側で有効になっている（検証の前提）', reducedMotionDetected);

      const result = await page.evaluate(({ spot, station }) => {
        return new Promise((resolve) => {
          const t0 = performance.now();
          let overheadAt = null, tiltAt = null;
          window.__terrainViewForDebug.onOverheadSettled = () => { overheadAt = performance.now() - t0; };
          window.__terrainViewForDebug.onTiltComplete = () => { tiltAt = performance.now() - t0; resolve({ overheadAt, tiltAt }); };
          window.__terrainViewForDebug.flyToSpot(spot, station);
          setTimeout(() => resolve({ overheadAt, tiltAt, timedOut: true }), 5000);
        });
      }, { spot, station });
      record(
        '[降下→傾け] reduced-motionのときは短時間（1秒未満）で傾け終わる',
        !result.timedOut && result.tiltAt < 1000,
        JSON.stringify(result)
      );
      const finalPitch = await page.evaluate(() => window.__terrainMapForDebug.getPitch());
      record('[降下→傾け] reduced-motionでも最終的にpitchが50〜60になる', finalPitch >= 50 && finalPitch <= 60.5, `pitch=${finalPitch.toFixed(1)}`);
    } else {
      record('[降下→傾け] reduced-motion検証用スポットが見つかる', false);
    }
    await context.close();
  }

  // --- 4. スクリーンショット：富山駅前→立山方面、真上から見えた瞬間／立体になったあと（PC・スマホ） ---
  const TATEYAMA_SPOT = { name: '国立登山研修所', lat: 36.66346190359144, lon: 137.31365203857422 };
  for (const [label, viewport] of Object.entries(VIEWPORTS)) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#departure-input');
    await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');
    await searchAt(page, '富山駅前', 2000);
    if (label === 'sp') await page.click('.tab-btn[data-tab="map"]').catch(() => {});
    await page.click('#map-dimension-toggle');
    const became3d = await page.waitForFunction(
      () => document.getElementById('map-area').classList.contains('mode-3d'),
      { timeout: 30000 }
    ).then(() => true).catch(() => false);
    if (!became3d) { await context.close(); continue; }
    await page.evaluate(() => window.__terrainViewForDebug.waitForTerrainLoaded(60000));
    const station = await page.evaluate(() => window.__terrainViewForDebug._lastDepartureStation);

    await page.evaluate(() => {
      window.__events = [];
      window.__t0 = performance.now();
      window.__terrainViewForDebug.onOverheadSettled = () => window.__events.push({ t: performance.now() - window.__t0, type: 'overhead' });
      window.__terrainViewForDebug.onTiltComplete = () => window.__events.push({ t: performance.now() - window.__t0, type: 'tilt' });
    });
    await page.evaluate(({ spot, station }) => window.__terrainViewForDebug.flyToSpot(spot, station), {
      spot: { latitude: TATEYAMA_SPOT.lat, longitude: TATEYAMA_SPOT.lon },
      station,
    });
    await page.waitForFunction(() => window.__events.some((e) => e.type === 'overhead'), { timeout: 30000 }).catch(() => {});
    const mapBox = await page.locator('#map-area').boundingBox();
    const overheadShot = path.join(screenshotDir, `descend-overhead-tateyama-${label}.png`);
    await page.screenshot({ path: overheadShot, clip: mapBox });
    savedPaths.push(overheadShot);

    await page.waitForFunction(() => window.__events.some((e) => e.type === 'tilt'), { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
    const tiltedShot = path.join(screenshotDir, `descend-tilted-tateyama-${label}.png`);
    await page.screenshot({ path: tiltedShot, clip: mapBox });
    savedPaths.push(tiltedShot);

    await context.close();
  }
}

/**
 * 【2026-10-15、11本目①、Minami決定：A】地図の吹き出し（ポップアップ）を
 * 廃止し、地図の下の固定情報枠（#spot-info-panel）に統一したことの検証
 * （2D・3D、PC・スマホ375px）。
 * - ピンを押すと枠が出て、吹き出しは出ないこと
 * - 枠の「詳細を見る」を実際にクリックすると詳細が開くこと
 * - 選んだピンだけが強調されること（白縁＋光の輪）
 * - 枠が地図のボタン類（2D/3D切替・出典）と重ならないこと
 * - 応援マーク対象のスポットは名前の横にハートが付くこと
 * - 枠を閉じる（×）・検索し直す・予算を触るといずれも枠とピンの強調が消えること
 */
async function checkSpotInfoPanel(browser, baseUrl, savedPaths) {
  console.log('\n=== 地図の下の固定情報枠の検証（11本目①） ===');

  // --- 2D ---
  for (const [label, viewport] of Object.entries(VIEWPORTS)) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#departure-input');
    await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');
    await searchAt(page, '高松築港', 1000);
    if (label === 'sp') {
      await page.click('.tab-btn[data-tab="map"]');
      await page.waitForTimeout(200);
    }

    // 実際のピン（.map-pin-spot、L.divIcon）を本物のクリックで押す
    // （直接呼び出しは使わない）。.map-pin-spot:visibleで実際に見えている
    // ピンに絞り、boundingBox()を取ってmouse.click()で座標指定して押す
    // （locator.click()はピン密集時に別マーカーに「intercepts pointer
    // events」で奪われることがあったため）。
    const pinLocator = page.locator('.map-pin-spot:visible').first();
    const pinBox = await pinLocator.boundingBox();
    if (pinBox) await page.mouse.click(pinBox.x + pinBox.width / 2, pinBox.y + pinBox.height / 2);
    await page.waitForTimeout(150);

    const panelVisible = await page.locator('#spot-info-panel').isVisible().catch(() => false);
    record(`[2D/${label}] ピンをクリックすると下の情報枠が出る`, panelVisible);
    const popupCount = await page.locator('.leaflet-popup').count();
    record(`[2D/${label}] 吹き出し（ポップアップ）は出ない`, popupCount === 0, `.leaflet-popup数=${popupCount}`);
    const selectedPinCount = await page.locator('.map-pin-spot.map-pin-selected:visible').count();
    record(`[2D/${label}] 選んだピンだけが強調される`, selectedPinCount === 1, `強調中のピン数=${selectedPinCount}`);

    if (panelVisible) {
      const spotName = (await page.locator('#spot-info-content .spot-info-name').textContent()) || '';
      const panelBox = await page.locator('#spot-info-panel').boundingBox();
      const toggleBox = await page.locator('#map-dimension-toggle').boundingBox();
      const attribBox = await page.locator('#spots-map .leaflet-control-attribution').boundingBox().catch(() => null);
      record(
        `[2D/${label}] 情報枠が2D/3D切替ボタンと重ならない`,
        !rectsOverlap(panelBox, toggleBox),
        JSON.stringify({ panelBox, toggleBox })
      );
      if (attribBox) {
        record(
          `[2D/${label}] 情報枠が出典ボタンと重ならない`,
          !rectsOverlap(panelBox, attribBox),
          JSON.stringify({ panelBox, attribBox })
        );
      }

      const panelPath = path.join(screenshotDir, `spot-info-panel-2d-${label}.png`);
      const mapAreaBox = await page.locator('#map-area').boundingBox();
      await page.screenshot({ path: panelPath, clip: mapAreaBox });
      savedPaths.push(panelPath);

      const btnBox = await page.locator('.spot-info-detail-btn').boundingBox();
      if (btnBox) await page.mouse.click(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
      const openedDetail = await page.waitForFunction(
        () => document.getElementById('app-layout')?.getAttribute('data-view') === 'detail',
        { timeout: 5000 }
      ).then(() => true).catch(() => false);
      const heading = openedDetail ? await page.locator('#detail-content h2').textContent() : null;
      record(
        `[2D/${label}] 枠の「詳細を見る」を実クリックすると、該当スポットの詳細画面が開く`,
        openedDetail && !!heading && spotName.includes(heading),
        `panel="${spotName}" / heading="${heading}"`
      );
      if (openedDetail) await page.click('.breadcrumb-list-link').catch(() => {});
    }

    if (pageErrors.length > 0) record(`[2D/${label}] 情報枠検証中にページエラーが発生していない`, false, pageErrors.join('; '));
    await context.close();
  }

  // --- 3D ---
  for (const [label, viewport] of Object.entries(VIEWPORTS)) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#departure-input');
    await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');
    await searchAt(page, '高松築港', 1000);
    if (label === 'sp') {
      await page.click('.tab-btn[data-tab="map"]');
      await page.waitForTimeout(200);
    }
    await page.click('#map-dimension-toggle');
    const became3d = await page.waitForFunction(
      () => document.getElementById('map-area').classList.contains('mode-3d'),
      { timeout: 30000 }
    ).then(() => true).catch(() => false);
    if (!became3d) {
      record(`[3D/${label}] 3D化（情報枠検証の前提）`, false);
      await context.close();
      continue;
    }
    await page.evaluate(() => window.__terrainViewForDebug.waitForTerrainLoaded(60000));

    // 円（circle-layer）は実DOM要素を持たないため、project()で実際の画面座標を
    // 求めてからmouse.click()で押す（このファイルの他のピン検証箇所と同じ方式）。
    const pinScreenPos = await page.evaluate((budget) => {
      const map = window.__terrainMapForDebug;
      const feats = map.querySourceFeatures('spots').filter((f) => f.properties.fare <= budget);
      if (feats.length === 0) return null;
      const f = feats[0];
      const p = map.project(f.geometry.coordinates);
      return { x: p.x, y: p.y, name: f.properties.name };
    }, 1000);
    record(`[3D/${label}] 検証対象のピンが見つかる`, !!pinScreenPos);

    if (pinScreenPos) {
      const mapBox = await page.locator('#map-area').boundingBox();
      await page.mouse.click(mapBox.x + pinScreenPos.x, mapBox.y + pinScreenPos.y);
      // flyToSpot()の降りる演出が始まるため、情報枠はすぐ出るはず（Minami指示：
      // 寄る演出と情報枠の表示は独立。枠はクリック直後に出す設計）。
      await page.waitForTimeout(300);
      const panelVisible = await page.locator('#spot-info-panel').isVisible().catch(() => false);
      record(`[3D/${label}] ピンをクリックすると下の情報枠が出る`, panelVisible);
      const popupCount = await page.locator('.maplibregl-popup').count();
      record(`[3D/${label}] 吹き出し（ポップアップ）は出ない`, popupCount === 0, `.maplibregl-popup数=${popupCount}`);
      // 【不具合修正】querySourceFeatures()はタイル境界をまたぐ点を複数タイルから
      // 重複して返すことがあるMapLibreの既知の挙動で、実際に2件返ってきて
      // 誤検出した。ソース自体が今持っているGeoJSONデータ（_data、setData()で
      // 渡した値そのもの）を直接見れば、タイル分割の影響を受けず確実。
      const selectedCount = await page.evaluate(() => {
        const tv = window.__terrainViewForDebug;
        const source = window.__terrainMapForDebug.getSource('selected-spot');
        const featureCount = source?._data?.features?.length ?? -1;
        return { hasSelectedId: !!tv.selectedSpotId, featureCount };
      });
      record(
        `[3D/${label}] 選んだピンの強調（selected-spotソース）が1件だけ描かれる`,
        selectedCount.hasSelectedId && selectedCount.featureCount === 1,
        JSON.stringify(selectedCount)
      );

      if (panelVisible) {
        const spotName = (await page.locator('#spot-info-content .spot-info-name').textContent()) || '';
        const panelBox = await page.locator('#spot-info-panel').boundingBox();
        const toggleBox = await page.locator('#map-dimension-toggle').boundingBox();
        const compassBox = await page.locator('.maplibregl-ctrl-top-right').boundingBox().catch(() => null);
        record(
          `[3D/${label}] 情報枠が2D/3D切替ボタンと重ならない`,
          !rectsOverlap(panelBox, toggleBox),
          JSON.stringify({ panelBox, toggleBox })
        );
        if (compassBox) {
          record(
            `[3D/${label}] 情報枠が方角ボタンと重ならない`,
            !rectsOverlap(panelBox, compassBox),
            JSON.stringify({ panelBox, compassBox })
          );
        }

        const panelPath = path.join(screenshotDir, `spot-info-panel-3d-${label}.png`);
        await page.screenshot({ path: panelPath, clip: mapBox });
        savedPaths.push(panelPath);

        const btnBox = await page.locator('.spot-info-detail-btn').boundingBox();
        await page.mouse.click(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
        const openedDetail = await page.waitForFunction(
          () => document.getElementById('app-layout')?.getAttribute('data-view') === 'detail',
          { timeout: 5000 }
        ).then(() => true).catch(() => false);
        const heading = openedDetail ? await page.locator('#detail-content h2').textContent() : null;
        record(
          `[3D/${label}] 枠の「詳細を見る」を実クリックすると、該当スポットの詳細画面が開く`,
          openedDetail && !!heading && spotName.includes(heading),
          `panel="${spotName}" / heading="${heading}"`
        );
        if (openedDetail) await page.click('.breadcrumb-list-link').catch(() => {});
      }
    }

    if (pageErrors.length > 0) record(`[3D/${label}] 情報枠検証中にページエラーが発生していない`, false, pageErrors.join('; '));
    await context.close();
  }

  // --- 応援マーク対象のスポットは名前の横にハートが付く（2D） ---
  {
    const context = await browser.newContext({ viewport: VIEWPORTS.pc });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#departure-input');
    await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');
    // 富山駅前→伏木万葉大橋（往復¥1600）は応援マーク対象（実データ確認済み、
    // このファイルのcaptureSupportBadgeCardScreen()と同じ組み合わせ）。
    await searchAt(page, '富山駅前', 1600);
    const supportedSpotId = await page.locator('.spot-card.spot-card-supported').first().getAttribute('data-spot-id');
    if (supportedSpotId) {
      const pinScreenPos = await page.evaluate((spotId) => {
        const mv = window.__mapViewForDebug;
        const marker = mv.markersBySpotId.get(spotId);
        const el = marker?.getElement();
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }, supportedSpotId);
      if (pinScreenPos) await page.mouse.click(pinScreenPos.x, pinScreenPos.y);
      await page.waitForTimeout(150);
      const heartVisible = await page.locator('#spot-info-content .spot-info-heart').isVisible().catch(() => false);
      record('[2D] 応援マーク対象のスポットは情報枠の名前の横にハートが付く', heartVisible);
    } else {
      record('[2D] 応援マーク対象の検証用スポットが見つかる', false);
    }
    await context.close();
  }

  // --- 選択の排他性：別のピンを選ぶと前のピンの強調が外れる（2D） ---
  {
    const context = await browser.newContext({ viewport: VIEWPORTS.pc });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#departure-input');
    await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');
    await searchAt(page, '高松築港', 1000);
    const pins = page.locator('.map-pin-spot:visible');
    const first = await pins.nth(0).boundingBox();
    const second = await pins.nth(1).boundingBox();
    if (first && second) {
      await page.mouse.click(first.x + first.width / 2, first.y + first.height / 2);
      await page.waitForTimeout(100);
      await page.mouse.click(second.x + second.width / 2, second.y + second.height / 2);
      await page.waitForTimeout(100);
      const selectedCount = await page.locator('.map-pin-spot.map-pin-selected:visible').count();
      record('[2D] 別のピンを選ぶと前のピンの強調が外れる（強調は常に1件）', selectedCount === 1, `強調中のピン数=${selectedCount}`);
    } else {
      record('[2D] 選択の排他性検証用のピンが2件見つかる', false);
    }

    // --- 枠を閉じる（×）・検索し直す・予算を触るで枠とピンの強調が消える ---
    await page.click('#spot-info-close');
    const afterClose = {
      panelHidden: await page.locator('#spot-info-panel').isHidden(),
      selectedCount: await page.locator('.map-pin-spot.map-pin-selected:visible').count(),
    };
    record(
      '[2D] ×で枠を閉じると、枠が消えピンの強調も外れる',
      afterClose.panelHidden && afterClose.selectedCount === 0,
      JSON.stringify(afterClose)
    );

    const pinsAgain = page.locator('.map-pin-spot:visible');
    const again = await pinsAgain.nth(0).boundingBox();
    if (again) await page.mouse.click(again.x + again.width / 2, again.y + again.height / 2);
    await page.waitForTimeout(100);
    await page.click('#budget-increment');
    const afterBudget = {
      panelHidden: await page.locator('#spot-info-panel').isHidden(),
      selectedCount: await page.locator('.map-pin-spot.map-pin-selected:visible').count(),
    };
    record(
      '[2D] 予算（±）を触ると、枠が消えピンの強調も外れる',
      afterBudget.panelHidden && afterBudget.selectedCount === 0,
      JSON.stringify(afterBudget)
    );

    const pinsForSearch = page.locator('.map-pin-spot:visible');
    const forSearch = await pinsForSearch.nth(0).boundingBox();
    if (forSearch) await page.mouse.click(forSearch.x + forSearch.width / 2, forSearch.y + forSearch.height / 2);
    await page.waitForTimeout(100);
    await searchAt(page, '高松築港', 2000);
    const afterResearch = {
      panelHidden: await page.locator('#spot-info-panel').isHidden(),
      selectedCount: await page.locator('.map-pin-spot.map-pin-selected:visible').count(),
    };
    record(
      '[2D] 検索し直すと、枠が消えピンの強調も外れる',
      afterResearch.panelHidden && afterResearch.selectedCount === 0,
      JSON.stringify(afterResearch)
    );

    await context.close();
  }
}

/**
 * 【2026-10-15、11本目②、Minami決定：C】場所に寄っているときに予算を触ると
 * 全体の位置へなめらかに戻ること（1.5秒前後）、「全体を見る」ボタンで同じ位置に
 * 戻れること、向き（bearing）は変わらないことを検証する（3D中心、2Dも軽く見る）。
 */
async function checkReturnToOverview(browser, baseUrl, savedPaths) {
  console.log('\n=== 予算を触ったら全体に戻る・「全体を見る」ボタンの検証（11本目②） ===');

  // --- 3D：ピンを押して寄る→予算を触ると全体に戻る ---
  {
    const context = await browser.newContext({ viewport: VIEWPORTS.pc });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#departure-input');
    await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');
    await searchAt(page, '八尾駅', 400);
    await page.click('#map-dimension-toggle');
    const became3d = await page.waitForFunction(
      () => document.getElementById('map-area').classList.contains('mode-3d'),
      { timeout: 30000 }
    ).then(() => true).catch(() => false);
    record('[3D] 3D化（全体復帰検証の前提）', became3d);
    if (became3d) {
      await page.evaluate(() => window.__terrainViewForDebug.waitForTerrainLoaded(60000));
      // 【不具合修正】11本目②の途中までactivateTerrainMap()がここでfitToBudget()を
      // 呼んでいたため、3D化直後のgetZoom()がそのまま「全体」の基準値として
      // 使えていた。その呼び出しはDEMタイル取得の競合を招く不具合が見つかって
      // 削除し、今はreturnToOverview()が呼ばれるまでカメラを動かさない設計に
      // なった（Minami指示の範囲外の変更ではなく、この変更をした副作用で
      // テスト側の前提が崩れていただけ）。基準値は本番と同じfitToBudget()を
      // ここで一度呼んで実際に計算させる。
      // 【不具合修正、2回目】固定700ms待ちでは、フルスイート実行時のレンダリング
      // 負荷が高いと名目600msのeaseTo()が実時間でそれより大幅に長くかかることが
      // あり（このファイルの他のカメラ検証箇所と同じ既知の事情）、まだ動いている
      // 途中のズームを基準値にしてしまっていた。isMoving()がfalseになる
      // （＝カメラが静止した）のをポーリングで待つ方が、実行環境の負荷変動に強い。
      await page.evaluate(() => window.__terrainViewForDebug.fitToBudget(window.__terrainViewForDebug._lastBudget));
      await page.waitForTimeout(100); // easeTo()起動自体のラグを避ける（isMoving()が真になる前に見てしまうのを防ぐ）
      await page.waitForFunction(() => !window.__terrainMapForDebug.isMoving(), { timeout: 10000 }).catch(() => {});
      const overviewZoom = await page.evaluate(() => window.__terrainMapForDebug.getZoom());
      const bearingBeforeFocus = await page.evaluate(() => window.__terrainMapForDebug.getBearing());

      const { spot, station } = await findSpotAndStation(page, '城生城');
      if (spot) {
        await page.evaluate(({ spot, station }) => {
          return new Promise((resolve) => {
            window.__terrainViewForDebug.onTiltComplete = () => resolve();
            window.__terrainViewForDebug.flyToSpot(spot, station);
            setTimeout(resolve, 30000);
          });
        }, { spot, station });

        const viewAllVisibleWhenFocused = await page.locator('#view-all-btn').isVisible().catch(() => false);
        record('[3D] 寄っている間は「全体を見る」ボタンが出る', viewAllVisibleWhenFocused);

        // 予算（+）を触る＝ユーザー操作。全体へなめらかに戻るはず（1.5秒前後）。
        // 固定待ちではなくisMoving()の収束をポーリングで待つ（上のコメント参照）。
        await page.click('#budget-increment');
        await page.waitForTimeout(100); // easeTo()起動自体のラグを避ける（isMoving()が真になる前に見てしまうのを防ぐ）
      await page.waitForFunction(() => !window.__terrainMapForDebug.isMoving(), { timeout: 10000 }).catch(() => {});
        const zoomAfterBudgetTouch = await page.evaluate(() => window.__terrainMapForDebug.getZoom());
        const bearingAfterBudgetTouch = await page.evaluate(() => window.__terrainMapForDebug.getBearing());
        record(
          '[3D] 寄ったあと予算を触ると、ズームが全体の値に戻る',
          Math.abs(zoomAfterBudgetTouch - overviewZoom) < 1.0,
          `全体=${overviewZoom.toFixed(2)} / 予算操作後=${zoomAfterBudgetTouch.toFixed(2)}`
        );
        record(
          '[3D] 予算操作で全体に戻っても、向き（bearing）は変わらない',
          Math.abs(bearingAfterBudgetTouch - bearingBeforeFocus) < 0.01,
          `寄る前=${bearingBeforeFocus} / 戻った後=${bearingAfterBudgetTouch}`
        );
        const viewAllHiddenAfterReturn = await page.locator('#view-all-btn').isHidden().catch(() => false);
        record('[3D] 全体に戻ると「全体を見る」ボタンが消える', viewAllHiddenAfterReturn);

        const mapAreaBox = await page.locator('#map-area').boundingBox();
        const returnedPath = path.join(screenshotDir, 'return-to-overview-3d-pc.png');
        await page.screenshot({ path: returnedPath, clip: mapAreaBox });
        savedPaths.push(returnedPath);

        // もう一度寄ってから「全体を見る」ボタンで戻れることも確認する。
        await page.evaluate(({ spot, station }) => {
          return new Promise((resolve) => {
            window.__terrainViewForDebug.onTiltComplete = () => resolve();
            window.__terrainViewForDebug.flyToSpot(spot, station);
            setTimeout(resolve, 30000);
          });
        }, { spot, station });
        await page.click('#view-all-btn');
        await page.waitForTimeout(100); // easeTo()起動自体のラグを避ける（isMoving()が真になる前に見てしまうのを防ぐ）
      await page.waitForFunction(() => !window.__terrainMapForDebug.isMoving(), { timeout: 10000 }).catch(() => {});
        const zoomAfterViewAllBtn = await page.evaluate(() => window.__terrainMapForDebug.getZoom());
        record(
          '[3D] 「全体を見る」ボタンで同じ全体の位置に戻る',
          Math.abs(zoomAfterViewAllBtn - overviewZoom) < 1.0,
          `全体=${overviewZoom.toFixed(2)} / ボタン後=${zoomAfterViewAllBtn.toFixed(2)}`
        );
      } else {
        record('[3D] 全体復帰検証用スポットが見つかる', false);
      }
    }
    await context.close();
  }

  // --- 2D：手でズームしてから予算を触ると全体に戻る ---
  {
    const context = await browser.newContext({ viewport: VIEWPORTS.pc });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#departure-input');
    await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');
    await searchAt(page, '八尾駅', 400);
    const overviewZoom2d = await page.evaluate(() => window.__mapViewForDebug.map.getZoom());
    await page.evaluate(() => { window.__mapViewForDebug.map.setZoom(window.__mapViewForDebug.map.getZoom() + 3, { animate: false }); });
    await page.waitForTimeout(200);
    const viewAllVisible2d = await page.locator('#view-all-btn').isVisible().catch(() => false);
    record('[2D] 手でズームすると「全体を見る」ボタンが出る', viewAllVisible2d);

    await page.click('#budget-increment');
    await page.waitForTimeout(1900);
    const zoomAfter2d = await page.evaluate(() => window.__mapViewForDebug.map.getZoom());
    record(
      '[2D] 手でズームしたあと予算を触ると、ズームが全体の値に戻る',
      Math.abs(zoomAfter2d - overviewZoom2d) < 1.0,
      `全体=${overviewZoom2d.toFixed(2)} / 予算操作後=${zoomAfter2d.toFixed(2)}`
    );
    await context.close();
  }

  // --- prefers-reduced-motion：アニメーションせず一度に戻る ---
  {
    const context = await browser.newContext({ viewport: VIEWPORTS.pc, reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#departure-input');
    await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');
    await searchAt(page, '八尾駅', 400);
    const overviewZoomRM = await page.evaluate(() => window.__mapViewForDebug.map.getZoom());
    await page.evaluate(() => { window.__mapViewForDebug.map.setZoom(window.__mapViewForDebug.map.getZoom() + 3, { animate: false }); });
    await page.click('#budget-increment');
    await page.waitForTimeout(100); // アニメーションなしなら、わずかな待ちで既に戻っているはず
    const zoomAfterRM = await page.evaluate(() => window.__mapViewForDebug.map.getZoom());
    record(
      '[reduced-motion] 予算を触ると、アニメーションせず一度に全体へ戻る',
      Math.abs(zoomAfterRM - overviewZoomRM) < 1.0,
      `全体=${overviewZoomRM.toFixed(2)} / 100ms後=${zoomAfterRM.toFixed(2)}`
    );
    await context.close();
  }
}

/**
 * 【2026-10-11、6本目E】「見てきた場所」の足あと表示を検証する。
 * 高松築港・往復¥1000の1件目「多和神社」は、実データ確認済みで
 * 「この先へ」を2回たどれる（多和神社→志度寺→玉泉寺）ため、3か所たどる
 * 検証にこの組み合わせを使う。
 */
async function checkBreadcrumbTrail(browser, baseUrl, savedPaths) {
  console.log('\n=== 「見てきた場所」の足あとの検証（E） ===');

  const breadcrumbItemSelector = '#detail-breadcrumb [data-history-index], #detail-breadcrumb .breadcrumb-current';

  for (const [label, viewport] of Object.entries(VIEWPORTS)) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#departure-input');
    await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');
    await searchAt(page, '高松築港', 1000);
    if (label === 'sp') await page.click('.tab-btn[data-tab="list"]').catch(() => {});

    // 一覧から1件目を開く：「一覧 ＞ 今の場所」の2項目だけになる
    await page.locator('.spot-card').first().click();
    await page.waitForSelector('#detail-content h2', { timeout: 15000 });
    const names = [await page.locator('#detail-content h2').textContent()];

    let itemCount = await page.locator(breadcrumbItemSelector).count();
    record(`[${label}] 一覧から直接開いたときは「一覧 ＞ 今の場所」の2項目だけ`, itemCount === 2, `実際 ${itemCount}件`);

    // 「この先へ」を2回たどる（計3か所訪問）
    for (let step = 0; step < 2; step++) {
      const onwardCards = page.locator('.onward-card');
      const hasOnward = await onwardCards.count() > 0;
      if (!hasOnward) break;
      await onwardCards.first().click();
      await page.waitForTimeout(250);
      names.push(await page.locator('#detail-content h2').textContent());
    }
    record(`[${label}] 「この先へ」を2回たどり3か所を訪問できた`, names.length === 3, `${names.length}か所: ${names.join(' → ')}`);

    itemCount = await page.locator(breadcrumbItemSelector).count();
    record(`[${label}] 3か所たどると足あとが4つ並ぶ（一覧＋3）`, itemCount === 4, `実際 ${itemCount}件`);

    if (label === 'pc') {
      const bcBox = await page.locator('#detail-breadcrumb').boundingBox();
      if (bcBox) {
        const bcPath = path.join(screenshotDir, `breadcrumb-3places-${label}.png`);
        await page.screenshot({ path: bcPath, clip: bcBox });
        savedPaths.push(bcPath);
      }
    } else {
      // スマホ幅：中間（一覧の直後〜「1つ前」の手前）が「…」に省略される
      const middleHidden = await page.evaluate(() => {
        const collapsed = document.querySelector('.breadcrumb-middle-collapsed');
        const trail = document.querySelector('.breadcrumb-trail');
        if (!collapsed || !trail) return null;
        return getComputedStyle(collapsed).display !== 'none' && !trail.classList.contains('breadcrumb-expanded');
      });
      record(`[${label}] スマホ幅では途中の場所が「…」に省略される`, middleHidden === true, `middleHidden=${middleHidden}`);

      const bcBox = await page.locator('#detail-breadcrumb').boundingBox();
      if (bcBox) {
        const bcPath = path.join(screenshotDir, `breadcrumb-collapsed-${label}.png`);
        await page.screenshot({ path: bcPath, clip: bcBox });
        savedPaths.push(bcPath);
      }

      await page.click('.breadcrumb-ellipsis').catch(() => {});
      const expanded = await page.evaluate(() => document.querySelector('.breadcrumb-trail')?.classList.contains('breadcrumb-expanded'));
      record(`[${label}] 「…」を押すと途中の場所が展開される`, expanded === true);
    }

    // 2つ以上前（最初に訪問した場所、data-history-index="0"）に戻ると、
    // そこへ移動し、後ろの足あとが消える
    await page.click('[data-history-index="0"]');
    await page.waitForTimeout(300);
    const headingAfterJump = await page.locator('#detail-content h2').textContent();
    record(`[${label}] 2つ前に戻ると、その場所の詳細が表示される`, headingAfterJump === names[0], `期待="${names[0]}" 実際="${headingAfterJump}"`);

    itemCount = await page.locator(breadcrumbItemSelector).count();
    record(`[${label}] 2つ前に戻ると、後ろの足あとが消える（残り2つ：一覧＋今の場所）`, itemCount === 2, `実際 ${itemCount}件`);

    // 戻ったときは、その場所の「この先へ」の位置を見せている。
    // 【2026-10-11修正】PC（縦1080px）は詳細画面の内容が丸ごと収まることがあり、
    // scrollIntoView()がそもそも不要（＝見出しが上端に来ない）になる場合がある
    // ため、「見出しが上端付近にあるか」ではなく「この先へセクションがコンテナの
    // 表示範囲内に入っているか（スクロールせず見えているか）」を見る方が、
    // 見せ方の意図（さらにスクロールしなくても見える）に合う。
    const scrolledToOnward = await page.evaluate(() => {
      const container = document.getElementById('detail-container');
      const onward = document.querySelector('.onward-section');
      if (!container || !onward) return null;
      const containerRect = container.getBoundingClientRect();
      const onwardRect = onward.getBoundingClientRect();
      return onwardRect.top < containerRect.bottom && onwardRect.bottom > containerRect.top;
    });
    record(`[${label}] 戻ったとき「この先へ」の位置を見せている（スクロールせず見えている）`, scrolledToOnward === true, `scrolledToOnward=${scrolledToOnward}`);

    // 「一覧」を押すと一覧に戻る
    await page.click('.breadcrumb-list-link');
    await page.waitForTimeout(200);
    const dataView = await page.evaluate(() => document.getElementById('app-layout')?.getAttribute('data-view'));
    record(`[${label}] 足あとの「一覧」を押すと一覧に戻る`, dataView === 'results', `data-view=${dataView}`);

    await context.close();
  }

  // --- スマホ本体の戻る操作（popstate）でも、足あとのクリックと同じ動きになること ---
  {
    const context = await browser.newContext({ viewport: VIEWPORTS.sp });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('#departure-input');
    await page.waitForFunction(() => document.getElementById('departure-input').placeholder === '駅名を入力...');
    await searchAt(page, '高松築港', 1000);
    await page.click('.tab-btn[data-tab="list"]').catch(() => {});
    await page.locator('.spot-card').first().click();
    await page.waitForSelector('#detail-content h2', { timeout: 15000 });
    const originalHeading = await page.locator('#detail-content h2').textContent();

    const hasOnward = await page.locator('.onward-card').count() > 0;
    record('[sp] popstate検証用の「この先へ」候補が見つかる', hasOnward);
    if (hasOnward) {
      await page.locator('.onward-card').first().click();
      await page.waitForTimeout(250);
      const candidateHeading = await page.locator('#detail-content h2').textContent();

      await page.goBack(); // UIボタンではなく、スマホ本体の戻る操作を模す
      await page.waitForTimeout(250);
      const backHeading = await page.locator('#detail-content h2').textContent();
      record(
        '[sp] スマホ本体の戻る操作（popstate）でも足あとの「1つ前」に戻る',
        backHeading === originalHeading && backHeading !== candidateHeading,
        `候補="${candidateHeading}" → 戻った後="${backHeading}"（元="${originalHeading}"）`
      );
      const itemCount = await page.locator(breadcrumbItemSelector).count();
      record('[sp] popstateで戻った後の足あとは「一覧＋今の場所」の2項目', itemCount === 2, `実際 ${itemCount}件`);
    }
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
    await checkTerrainMapOpensForBaselineStations(browser, baseUrl);
    await checkTerrain3DCameraAndInteraction(browser, baseUrl, savedPaths);
    await checkDefaultStyleD(browser, baseUrl, savedPaths);
    await checkDescendTiltChoreography(browser, baseUrl, savedPaths);
    await checkSpotInfoPanel(browser, baseUrl, savedPaths);
    await checkReturnToOverview(browser, baseUrl, savedPaths);
    await checkBreadcrumbTrail(browser, baseUrl, savedPaths);
    await checkBudgetSlider(browser, baseUrl, savedPaths);
    await checkWaveRevealAndCircleScreenshots(browser, baseUrl, savedPaths);
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
