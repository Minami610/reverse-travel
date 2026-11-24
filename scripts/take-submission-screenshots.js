/**
 * take-submission-screenshots.js - 応募（公共交通オープンデータチャレンジ2026）に出すスクリーンショットを撮る
 *
 * 【75本目、Minami指示】公開URLで、何度でも同じ手順で撮れるようにする。
 *   01 PC・富山駅前 ¥800 で検索した結果（2D、左の一覧パネルを開いた状態）
 *   02 01から＋を押して ¥1,000（オレンジの NEW ピンと「NEW +N」が見える）。＋は1回で¥100なので2回押す（指示は「1回」だったが、指示の金額¥1,000に合わせた）
 *   03 PCの3D（富山駅前 ¥800 で検索したあと、全体の見え方）
 *   04a〜04c PCの詳細（¥800の一覧から、写真があり紹介文が長い順に3つ）
 *   05 スマホ2画面を横に並べた1枚（左：結果〈上の1行カードと下の一覧（小）〉、右：ピンを押して出る場所のカード）
 * PCは1440×900・deviceScaleFactor 2、スマホは390×844・deviceScaleFactor 3。
 * 撮る前に、地図のタイル・地形・¥2000分の裏の取得・波やぽよん・初めて3Dにしたときの吹き出しが終わるのを待つ。
 * マウスは画面の外へ動かしてから撮る（ホバーの強調を写さない。ヘッドレスなのでカーソル・開発者ツールは写らない）。
 *
 * 使い方：node scripts/take-submission-screenshots.js [--url <URL>] [--only 01,02,...]
 * 保存先：data/screenshots/submission-75/（.gitignoreの対象）
 * 撮った画像ごとに、大きさ（ピクセル）・見出し・件数・一覧に写った場所の名前をログに出す（場所らしくないものが写っていないかを人が見る）。
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const outDir = path.join(rootDir, 'data/screenshots/submission-75');

const args = process.argv.slice(2);
const argValue = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const BASE_URL = argValue('--url') || 'https://minami610.github.io/reverse-travel/';
const ONLY = argValue('--only') ? argValue('--only').split(',') : null;
const want = (id) => !ONLY || ONLY.includes(id);

// verify-layout.jsと同じ（実際のGPUで描く）
const GPU_LAUNCH_ARGS = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const PC = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
const SP = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const STATION = '富山駅前';
const BUDGET = 800;

/** PNGの幅・高さ（IHDR）を読む */
function pngSize(file) {
  const b = fs.readFileSync(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

async function openPage(browser, opts) {
  const context = await browser.newContext(opts);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  const url = BASE_URL + (BASE_URL.includes('?') ? '&' : '?') + 'nocache=' + Date.now();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('departure-input')?.placeholder === '駅名を入力...', null, { timeout: 30000 });
  return { context, page, errors };
}

/** 出発駅を候補から選び、金額をスライダーで入れて「この条件で探す」を押す（verify-layout.jsのsearchAt()と同じ手順） */
async function search(page, station, budget) {
  const hidden = await page.evaluate(() => document.getElementById('search-form').offsetParent === null);
  if (hidden) { await page.click('#search-summary-toggle'); await page.waitForTimeout(200); }
  await page.fill('#departure-input', '');
  await page.fill('#departure-input', station);
  await page.waitForTimeout(500);
  await page.locator('.suggestion-item', { hasText: station }).first().click();
  await page.evaluate((v) => {
    const el = document.getElementById('budget-slider');
    el.value = v;
    el.dispatchEvent(new Event('input'));
  }, budget);
  const before = await page.evaluate(() => window.__maxBudgetPrefetchAppliedCount || 0);
  await page.click('#search-btn');
  await page.waitForSelector('.spot-card, .no-results', { timeout: 30000, state: 'attached' });
  // ¥2000分の裏の取得が地図・一覧に渡るまで待つ
  await page.waitForFunction((n) => (window.__maxBudgetPrefetchAppliedCount || 0) > n, before, { timeout: 60000 });
}

/** 2Dの地図が落ち着くまで：波・ぽよん・円の動き・地図合わせが終わり、ベクトル地図のタイルを読み終わる */
async function settle2d(page) {
  await page.waitForFunction(() => {
    const mv = window.__mapViewForDebug;
    if (!mv) return true;
    const hiddenPins = Array.from(mv.markersBySpotId.values()).filter((m) => m.getElement()?.classList.contains('pin-wave-hidden')).length;
    return hiddenPins === 0 && mv._budgetFitWait == null && mv._circleAnimFrame == null && !mv._circleWave && !mv._pinPop && !mv._circleFitAnim
      && document.querySelectorAll('.map-pin-drop').length === 0;
  }, null, { timeout: 30000, polling: 100 });
  await page.evaluate(() => new Promise((resolve) => {
    const gl = window.__mapViewForDebug?._vectorBaseLayer?.getMaplibreMap();
    if (!gl) { resolve(); return; }
    const t = setTimeout(resolve, 30000);
    const check = () => { if (gl.loaded() && gl.areTilesLoaded()) { clearTimeout(t); resolve(); } else setTimeout(check, 200); };
    setTimeout(check, 300);
  }));
  await page.waitForTimeout(800);
}

/** 3Dの地図が落ち着くまで：地形・タイル・カメラ・「いっぱい」の合わせ直し・波・ぽよん・吹き出し */
async function settle3d(page) {
  // 3Dの地図は初めて3Dにしたときに作られる
  await page.waitForFunction(() => window.__terrainViewForDebug && window.__terrainMapForDebug, null, { timeout: 60000 });
  await page.evaluate(() => window.__terrainViewForDebug.waitForTerrainLoaded(60000));
  await page.waitForFunction(() => {
    const tv = window.__terrainViewForDebug;
    const map = window.__terrainMapForDebug;
    const hint = document.getElementById('map-rotate-hint');
    return map.areTilesLoaded() && !map.isMoving() && !tv._fillRefinePending && tv._budgetFitWait == null
      && tv._circleAnimFrame == null && !tv._circleWave && !tv._pinPop
      && document.querySelectorAll('.map-pin-drop-3d').length === 0 && (!hint || hint.hidden);
  }, null, { timeout: 60000, polling: 100 });
  await page.waitForTimeout(1000);
  await page.waitForFunction(() => window.__terrainMapForDebug.areTilesLoaded() && !window.__terrainMapForDebug.isMoving(), null, { timeout: 30000 });
}

/** 押した部品にホバーの強調が残らないよう、マウスを画面の外へ出す */
async function mouseAway(page) {
  await page.mouse.move(-20, -20);
  await page.waitForTimeout(200);
}

/** 画像を読み終わるまで待つ（写真の枠が空のまま撮らない） */
async function waitImages(page, selector) {
  await page.waitForFunction((sel) => [...document.querySelectorAll(sel)].every((img) => img.complete), selector, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(300);
}

async function describe(page) {
  return page.evaluate(() => {
    const text = (id) => (document.getElementById(id)?.textContent || '').replace(/\s+/g, ' ').trim();
    const visible = (id) => { const el = document.getElementById(id); return !!el && !el.hidden && el.offsetParent !== null; };
    return {
      heading: text('results-band-heading'),
      mapCount: text('results-map-count'),
      newCount: visible('results-new-count') ? text('results-new-count') : (visible('map-new-count') ? text('map-new-count') : '（なし）'),
      cards: [...document.querySelectorAll('#results-list .spot-card h3')].map((h) => h.textContent.trim()),
    };
  });
}

const report = [];
async function shot(page, name, extra = {}) {
  const file = path.join(outDir, name);
  await page.screenshot({ path: file });
  const size = pngSize(file);
  const info = { file: name, size: `${size.width}×${size.height}`, ...extra };
  report.push(info);
  console.log(`📷 ${name}（${info.size}）`);
  for (const [k, v] of Object.entries(extra)) console.log(`   ${k}: ${Array.isArray(v) ? v.join('、') : v}`);
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: GPU_LAUNCH_ARGS });
  const allErrors = [];
  try {
    // --- 01・02：PCの2D ---
    if (want('01') || want('02')) {
      const { context, page, errors } = await openPage(browser, PC);
      await search(page, STATION, BUDGET);
      await settle2d(page);
      await mouseAway(page);
      const d1 = await describe(page);
      if (want('01')) await shot(page, `01_pc_2d_${STATION}_800.png`, { 見出し: d1.heading, 地図のか所: d1.mapCount, NEW: d1.newCount, 一覧: d1.cards });
      if (want('02')) {
        // ＋は1回で¥100上がる。¥800→¥1,000は2回（続けて押すと、すぐ新しい地図合わせへ移る）
        await page.click('#mobile-budget-increment');
        await page.waitForTimeout(150);
        await page.click('#mobile-budget-increment');
        await page.waitForTimeout(500);
        await settle2d(page);
        await mouseAway(page);
        const d2 = await describe(page);
        await shot(page, `02_pc_2d_${STATION}_1000_new.png`, { 見出し: d2.heading, 地図のか所: d2.mapCount, NEW: d2.newCount, 一覧: d2.cards });
      }
      allErrors.push(...errors);
      await context.close();
    }

    // --- 03：PCの3D（全体の見え方） ---
    if (want('03')) {
      const { context, page, errors } = await openPage(browser, PC);
      await search(page, STATION, BUDGET);
      await settle2d(page);
      await page.click('#map-dimension-toggle');
      await settle3d(page);
      await mouseAway(page);
      const d = await describe(page);
      await shot(page, `03_pc_3d_${STATION}_800.png`, { 見出し: d.heading, 地図のか所: d.mapCount, NEW: d.newCount });
      allErrors.push(...errors);
      await context.close();
    }

    // --- 04a〜04c：PCの詳細（写真があり、紹介文が長い順に3つ） ---
    if (want('04')) {
      const { context, page, errors } = await openPage(browser, PC);
      await search(page, STATION, BUDGET);
      await settle2d(page);
      const candidates = await page.evaluate(() => [...document.querySelectorAll('#results-list .spot-card')]
        .filter((c) => c.querySelector('img.spot-image'))
        .map((c) => ({ id: c.getAttribute('data-spot-id'), name: c.querySelector('h3').textContent.trim() })));
      // 紹介文の長さは、詳細を開いて紹介文（.detail-description）を読んで比べる
      const measured = [];
      for (const c of candidates) {
        await page.click(`#results-list .spot-card[data-spot-id="${c.id}"] .detail-btn`);
        await page.waitForFunction((name) => document.querySelector('.detail-title')?.textContent.includes(name), c.name, { timeout: 10000 }).catch(() => {});
        const len = await page.evaluate(() => (document.querySelector('.detail-description')?.textContent || '').trim().length);
        measured.push({ ...c, len });
        await page.locator('.breadcrumb-list-link:visible').first().click();
        await page.waitForSelector(`#results-list .spot-card[data-spot-id="${c.id}"]`, { state: 'visible', timeout: 10000 }).catch(() => {});
      }
      measured.sort((a, b) => b.len - a.len || a.id.localeCompare(b.id));
      console.log('詳細の候補（写真あり、紹介文の長い順）：' + measured.map((m) => `${m.name}(${m.len}字)`).join('、'));
      await context.close();
      allErrors.push(...errors);
      const picks = measured.slice(0, 3);
      for (const [i, p] of picks.entries()) {
        const s = await openPage(browser, PC);
        await search(s.page, STATION, BUDGET);
        await settle2d(s.page);
        await s.page.click(`#results-list .spot-card[data-spot-id="${p.id}"] .detail-btn`);
        await s.page.waitForSelector('.detail-description', { timeout: 10000 });
        await s.page.waitForTimeout(2000);
        await settle2d(s.page);
        await waitImages(s.page, '#detail-container img');
        await mouseAway(s.page);
        const meta = await s.page.evaluate(() => (document.querySelector('.detail-meta')?.textContent || '').replace(/\s+/g, ' ').trim());
        await shot(s.page, `04${'abc'[i]}_pc_detail_${p.name}.png`, { 場所: p.name, 紹介文: `${p.len}字`, 金額など: meta });
        allErrors.push(...s.errors);
        await s.context.close();
      }
    }

    // --- 05：スマホ2画面を横に並べる ---
    if (want('05')) {
      const { context, page, errors } = await openPage(browser, SP);
      await search(page, STATION, BUDGET);
      await settle2d(page);
      await waitImages(page, '#results-list img');
      await mouseAway(page);
      const d = await describe(page);
      const leftFile = path.join(outDir, '_05_left.png');
      await page.screenshot({ path: leftFile });
      // 右：ピンを押して場所のカードを出す。ほかの部品に隠れていない1つずつのピン（verify-layout.jsのuncoveredPin()と同じ探し方）を、
      // 地図の真ん中に近い順に押し、写真のあるカードが出たらそれを使う（無ければ最後に押したもの）。
      let picked = false;
      for (let attempt = 0; attempt < 12 && !picked; attempt++) {
        const found = await page.evaluate((skip) => {
          document.querySelectorAll('[data-shot-pick]').forEach((e) => e.removeAttribute('data-shot-pick'));
          const area = document.getElementById('spots-map').getBoundingClientRect();
          const cx = area.left + area.width / 2;
          const cy = area.top + area.height / 2;
          const pins = [...document.querySelectorAll('#spots-map .map-pin-spot')].map((el) => ({ el, b: el.getBoundingClientRect() }))
            .filter(({ el, b }) => {
              if (!(b.width > 0 && b.height > 0)) return false;
              const t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
              return t && el.contains(t);
            })
            .sort((p, q) => Math.hypot(p.b.left - cx, p.b.top - cy) - Math.hypot(q.b.left - cx, q.b.top - cy));
          const pin = pins[skip];
          if (!pin) return false;
          pin.el.setAttribute('data-shot-pick', '1');
          return true;
        }, attempt);
        if (!found) break;
        await page.locator('[data-shot-pick="1"]').first().click();
        await page.waitForSelector('#sheet-spot-card:not([hidden])', { timeout: 10000 });
        picked = (await page.locator('#sheet-spot-card img.sheet-spot-image').count()) > 0;
        if (!picked && attempt < 11) {
          await page.click('.sheet-spot-close');
          await page.waitForTimeout(800);
          await settle2d(page);
        }
      }
      if (!(await page.locator('#sheet-spot-card:not([hidden])').count())) throw new Error('押せるピンが見つからない（05の右）');
      await page.waitForTimeout(1500);
      await settle2d(page);
      await waitImages(page, '#sheet-spot-card img');
      await mouseAway(page);
      const cardName = await page.evaluate(() => document.querySelector('.sheet-spot-name')?.textContent.trim());
      const rightFile = path.join(outDir, '_05_right.png');
      await page.screenshot({ path: rightFile });
      allErrors.push(...errors);
      await context.close();

      // 2枚を並べる（背景は薄い灰色、間とまわりに余白）
      const L = pngSize(leftFile);
      const pad = 96;
      const W = L.width * 2 + pad * 3;
      const H = L.height + pad * 2;
      const composer = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
      const cp = await composer.newPage();
      const dataUrl = (f) => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
      await cp.setContent(`<!doctype html><html><body style="margin:0;background:#f2f3f5;width:${W}px;height:${H}px;display:flex;gap:${pad}px;padding:${pad}px;box-sizing:border-box">
        <img src="${dataUrl(leftFile)}" style="width:${L.width}px;height:${L.height}px;display:block;border-radius:24px;box-shadow:0 6px 24px rgba(0,0,0,0.12)">
        <img src="${dataUrl(rightFile)}" style="width:${L.width}px;height:${L.height}px;display:block;border-radius:24px;box-shadow:0 6px 24px rgba(0,0,0,0.12)">
      </body></html>`);
      await waitImages(cp, 'img');
      await shot(cp, `05_sp_${STATION}_800_result_and_card.png`, { 左: `${d.heading}（下の一覧〈小〉）`, 右の場所のカード: cardName, 一覧: d.cards });
      await composer.close();
      fs.unlinkSync(leftFile);
      fs.unlinkSync(rightFile);
    }
  } finally {
    await browser.close();
  }
  const red = allErrors.filter((e) => !/dem_png|404/.test(e));
  console.log(`\nコンソールの赤い表示：${allErrors.length}件（標高タイルの404などを除くと${red.length}件）`);
  red.forEach((e) => console.log('  ' + e));
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ url: BASE_URL, takenAt: new Date().toISOString(), shots: report, consoleErrors: allErrors }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
