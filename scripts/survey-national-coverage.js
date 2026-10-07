/**
 * survey-national-coverage.js - 全国47都道府県のgtfs-data.jpフィードを棚卸しする（調査専用）
 *
 * 【位置づけ】Coworkの指示による一回限りの調査スクリプト。本番ビルド
 * （build-prefecture.js等）からは呼ばれない。結果はdata/derived/national/
 * coverage-survey.jsonに保存するだけで、config/published-prefectures.json等の
 * 本番設定には一切触れない。
 *
 * 【段階A（必須・軽量）】`GET /v2/feeds?pref={都道府県コード}`だけで分かる範囲：
 * フィード数・ライセンス許可リストを満たすフィード数・廃止済みフィード数。
 * このエンドポイントは一覧の各要素に feed_license を直接含むため、
 * フィード詳細（organizations/{id}/feeds/{id}）への個別アクセスは不要。
 *
 * 【段階B（重い・選択的）】運賃データ（fare_rules/fare_attributes）の有無・
 * 鉄道（route_type 0/1/2）の有無は、GTFSの実ファイルを見ないと分からない。
 * 47都道府県×全フィードをダウンロードするのは重すぎるため、「段階Aで
 * ライセンス許可かつ廃止済みでない」フィードだけを対象にZIPをダウンロードし、
 * fare_rules.txt/fare_attributes.txt/routes.txtの有無・内容を確認する
 * （対象外のフィードは使えないため確認する意味がない）。
 * それでも重い場合に備え、--skip-downloadで段階Aのみ実行できるようにする。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import { parse } from 'csv-parse/sync';
import { checkLicenseAllowed } from './build-pipeline/license-check.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const outputPath = path.join(rootDir, 'data/derived/national/coverage-survey.json');
// プロセスIDを含めて一意にする（同時に2プロセス走らせたとき、片方の終了時の
// rmSyncがもう片方のダウンロード中ZIPを消してしまいENOENTになる事故が実際に
// あったため、2026-10-07修正）。
const tmpDownloadDir = path.join(rootDir, `data/derived/national/.coverage-survey-tmp-${process.pid}`);

const GTFS_DATA_JP_API_BASE = 'https://api.gtfs-data.jp/v2';
const USER_AGENT = 'reverse-travel/0.1.0 (contact: reverse-travel-maintainer; purpose: coverage survey)';
const LIST_REQUEST_INTERVAL_MS = 400; // gtfs-data.jpへの配慮（47回の軽量リクエストのみ）
const DOWNLOAD_REQUEST_INTERVAL_MS = 500;
const DOWNLOAD_TIMEOUT_MS = 30000;

const PREF_NAMES_BY_CODE = {
  1: '北海道', 2: '青森県', 3: '岩手県', 4: '宮城県', 5: '秋田県', 6: '山形県', 7: '福島県',
  8: '茨城県', 9: '栃木県', 10: '群馬県', 11: '埼玉県', 12: '千葉県', 13: '東京都', 14: '神奈川県',
  15: '新潟県', 16: '富山県', 17: '石川県', 18: '福井県', 19: '山梨県', 20: '長野県', 21: '岐阜県',
  22: '静岡県', 23: '愛知県', 24: '三重県', 25: '滋賀県', 26: '京都府', 27: '大阪府', 28: '兵庫県',
  29: '奈良県', 30: '和歌山県', 31: '鳥取県', 32: '島根県', 33: '岡山県', 34: '広島県', 35: '山口県',
  36: '徳島県', 37: '香川県', 38: '愛媛県', 39: '高知県', 40: '福岡県', 41: '佐賀県', 42: '長崎県',
  43: '熊本県', 44: '大分県', 45: '宮崎県', 46: '鹿児島県', 47: '沖縄県',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchFeedList(prefCode) {
  const url = `${GTFS_DATA_JP_API_BASE}/feeds?pref=${prefCode}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}（${url}）`);
  }
  const json = await res.json();
  if (!Array.isArray(json.body)) {
    throw new Error(`想定外のレスポンス形式（${url}）`);
  }
  return json.body;
}

async function fetchFeedDetail(organizationId, feedId) {
  const url = `${GTFS_DATA_JP_API_BASE}/organizations/${organizationId}/feeds/${feedId}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}（${url}）`);
  }
  const json = await res.json();
  return json.body;
}

async function downloadZip(url, destPath) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, timeout: DOWNLOAD_TIMEOUT_MS });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}（${url}）`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
  return buffer.length;
}

/**
 * ZIP内のGTFSファイルを調べ、運賃データ・鉄道系route_typeの有無を判定する。
 * ファイルが存在しない／空（ヘッダのみ）の場合はfalse扱いにする。
 */
function inspectGtfsZip(zipPath) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const findEntry = (name) => entries.find((e) => e.entryName.toLowerCase() === name || e.entryName.toLowerCase().endsWith('/' + name));

  function readCsv(name) {
    const entry = findEntry(name);
    if (!entry) return null;
    const text = entry.getData().toString('utf-8').replace(/^﻿/, '');
    if (!text.trim()) return [];
    try {
      return parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true });
    } catch {
      return null; // 壊れたCSVは「判定不能」扱い
    }
  }

  const fareRules = readCsv('fare_rules.txt');
  const fareAttributes = readCsv('fare_attributes.txt');
  const hasFareData = (Array.isArray(fareRules) && fareRules.length > 0) || (Array.isArray(fareAttributes) && fareAttributes.length > 0);

  const routes = readCsv('routes.txt');
  const hasRail = Array.isArray(routes) && routes.some((r) => ['0', '1', '2'].includes(String(r.route_type)));

  return { hasFareData, hasRail, fileCount: entries.length };
}

async function main() {
  const skipDownload = process.argv.includes('--skip-download');
  const onlyCodes = (() => {
    const arg = process.argv.find((a) => a.startsWith('--only='));
    if (!arg) return null;
    return new Set(arg.replace('--only=', '').split(',').map((s) => s.trim()));
  })();

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (!skipDownload) fs.mkdirSync(tmpDownloadDir, { recursive: true });

  // --onlyで一部県だけ再調査するときは、既存のcoverage-survey.jsonを土台にして
  // 対象県だけ上書きする（他県の集計を消さないため）。
  let prefectures = {};
  let errors = [];
  if (onlyCodes && fs.existsSync(outputPath)) {
    const existing = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    prefectures = existing.prefectures || {};
    errors = (existing.errors || []).filter((e) => !onlyCodes.has(e.pref_code) && !onlyCodes.has(String(Number(e.pref_code))));
  }

  for (let code = 1; code <= 47; code++) {
    const codeStr = String(code).padStart(2, '0');
    if (onlyCodes && !onlyCodes.has(codeStr) && !onlyCodes.has(String(code))) continue;
    const prefName = PREF_NAMES_BY_CODE[code];
    process.stdout.write(`[${codeStr}] ${prefName} ... `);

    let feeds;
    try {
      feeds = await fetchFeedList(code);
    } catch (error) {
      console.log(`❌ 取得失敗: ${error.message}`);
      errors.push({ pref_code: codeStr, pref_name: prefName, error: error.message });
      await sleep(LIST_REQUEST_INTERVAL_MS);
      continue;
    }

    const discontinued = feeds.filter((f) => f.feed_is_discontinued);
    const active = feeds.filter((f) => !f.feed_is_discontinued);
    const licenseAllowed = active.filter((f) => checkLicenseAllowed({ license_label: f.feed_license }).allowed);

    const feedSummaries = feeds.map((f) => ({
      organization_id: f.organization_id,
      organization_name: f.organization_name,
      feed_id: f.feed_id,
      feed_name: f.feed_name,
      feed_license: f.feed_license,
      license_allowed: checkLicenseAllowed({ license_label: f.feed_license }).allowed,
      feed_is_discontinued: f.feed_is_discontinued,
      latest_feed_start_date: f.latest_feed_start_date,
      latest_feed_end_date: f.latest_feed_end_date,
      last_updated_at: f.last_updated_at,
      fare_data: 'unchecked',
      has_rail: 'unchecked',
    }));

    let fareDataCount = 'unchecked';
    let railFeedCount = 'unchecked';

    if (!skipDownload) {
      fareDataCount = 0;
      railFeedCount = 0;
      for (const summary of feedSummaries) {
        if (!summary.license_allowed || summary.feed_is_discontinued) continue;
        try {
          const detail = await fetchFeedDetail(summary.organization_id, summary.feed_id);
          const current = (detail.gtfs_files || []).find((f) => f.rid === 'current');
          if (!current || !current.gtfs_url) {
            summary.fare_data = '未確認（current版なし）';
            summary.has_rail = '未確認（current版なし）';
            await sleep(DOWNLOAD_REQUEST_INTERVAL_MS);
            continue;
          }
          const zipPath = path.join(tmpDownloadDir, `${summary.organization_id}_${summary.feed_id}.zip`);
          await downloadZip(current.gtfs_url, zipPath);
          const { hasFareData, hasRail } = inspectGtfsZip(zipPath);
          summary.fare_data = hasFareData;
          summary.has_rail = hasRail;
          if (hasFareData) fareDataCount++;
          if (hasRail) railFeedCount++;
          fs.unlinkSync(zipPath);
        } catch (error) {
          summary.fare_data = `未確認（${error.message}）`;
          summary.has_rail = `未確認（${error.message}）`;
          errors.push({ pref_code: codeStr, pref_name: prefName, feed: `${summary.organization_id}/${summary.feed_id}`, error: error.message });
        }
        await sleep(DOWNLOAD_REQUEST_INTERVAL_MS);
      }
    }

    prefectures[codeStr] = {
      pref_name: prefName,
      feed_count: feeds.length,
      active_feed_count: active.length,
      discontinued_feed_count: discontinued.length,
      license_allowed_feed_count: licenseAllowed.length,
      fare_data_feed_count: fareDataCount,
      rail_feed_count: railFeedCount,
      feeds: feedSummaries,
    };

    console.log(
      `フィード${feeds.length}件（うち廃止${discontinued.length}・ライセンス許可${licenseAllowed.length}）` +
      (skipDownload ? '' : `・運賃データあり${fareDataCount}・鉄道あり${railFeedCount}`)
    );

    await sleep(LIST_REQUEST_INTERVAL_MS);
  }

  if (!skipDownload && fs.existsSync(tmpDownloadDir)) {
    fs.rmSync(tmpDownloadDir, { recursive: true, force: true });
  }

  const output = {
    description: '全国47都道府県のgtfs-data.jpフィード棚卸し（調査専用。本番ビルドはこのファイルを参照しない）。survey-national-coverage.jsが生成。',
    surveyed_at: new Date().toISOString().slice(0, 10),
    skip_download: skipDownload,
    prefectures,
    errors,
  };
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n✅ 保存: ${path.relative(rootDir, outputPath)}`);
  if (errors.length > 0) {
    console.log(`⚠️  ${errors.length}件のエラーがありました（coverage-survey.jsonのerrorsを参照）`);
  }
}

main().catch((error) => {
  console.error('❌ 調査スクリプト実行エラー:', error);
  process.exit(1);
});
