/**
 * catalog-snapshot.js - 都道府県ごとのGTFS取得元カタログを、取得日付きのスナップショットとして
 * data/derived/national/gtfs-catalog-snapshot.json に保存する。
 *
 * 【背景】gtfs-data.jpのカタログ（どのフィードがどの都道府県に属するか）は将来的に
 * 変化しうるため、ビルドのたびに毎回問い合わせるのではなく、取得日を記録した
 * スナップショットとして保存し、以降のビルドはそれを参照する（再現性のため）。
 * 香川県（ことでん・ことでんバス）はgtfs-data.jp外の事業者公式サイトからの
 * 直接取得のため、"source": "direct" として同じスナップショット形式に含め、
 * どのフィードがどこ由来かを出典表示（generate-data-sources-manifest.js）と
 * 突き合わせられるようにする。
 *
 * 【gtfs-data.jp API v2】段階1(b)で富山・石川向けに実装。実際に叩いて確認した構造：
 * - `GET /v2/organizations/{organization_id}/feeds/{feed_id}` がフィードのメタデータと
 *   リビジョン一覧（gtfs_files配列）を返す。各リビジョンはrid（current/数値のプレビュー等）を持ち、
 *   rid==="current"のものが現在公開中のデータ。
 * - 現在データのダウンロードURLは `gtfs_files[].gtfs_url`
 *   （`.../files/feed.zip?uid=<gtfs_file_uid>` の形。uidはリビジョンごとに変わる）。
 * - operator.idはorganization_idとfeed_idの組から作る（gtfs-id.jsのコメント参照：
 *   feed_idは全国一意ではない。例：野々市市と内灘町が共にfeed_id="communitybus"）。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const snapshotPath = path.join(__dirname, '../../data/derived/national/gtfs-catalog-snapshot.json');
const targetOperatorsPath = path.join(__dirname, '../../config/target-operators.json');

const GTFS_DATA_JP_API_BASE = 'https://api.gtfs-data.jp/v2';
const GTFS_DATA_JP_USER_AGENT = 'reverse-travel/0.1.0 (contact: reverse-travel-maintainer)';

// 都道府県コード → 直接取得(direct)の設定ファイルの対応。gtfs-data.jp由来の
// 都道府県が増えたら、ここに追加するのではなく別途APIフェッチャーを実装すること
// （直接取得はこの県固有の少数事業者にしか成立しない前提）。
const DIRECT_FETCH_PREFECTURES = {
  37: { name: '香川県', configPath: targetOperatorsPath, operatorsKey: 'phase1_operators' },
};

// 都道府県コード → gtfs-data.jpの{organization_id, feed_id}一覧。
// Cowork承認済みの構成（段階1(b)指示）をそのまま列挙する。
// 地鉄市内電車（chitetsu/chitetsushinaidensha）は富山の構成には含めない運用も
// できるが、「運賃は手書きしない」方針のため、ここでは敢えて含めて取得し、
// fare-feed-check.jsの実データ判定で運賃データなしとして自動除外させる
// （除外理由がログに残り、思い込みでの除外にならない）。
const GTFS_DATA_JP_PREFECTURES = {
  16: {
    name: '富山県',
    feeds: [
      { organization_id: 'chitetsu', feed_id: 'chitetsushinaidensha' }, // 地鉄市内電車（運賃データなしで自動除外される想定）
      { organization_id: 'chitetsu', feed_id: 'chitetsubus' }, // 地鉄バス
      { organization_id: 'manyosen', feed_id: 'manyosen' }, // 万葉線
      { organization_id: 'kaetsunou', feed_id: 'kaetsunouippan' }, // 加越能バス（一般路線）
      { organization_id: 'kaetsunou', feed_id: 'kaetsunousekaiisan' }, // 加越能バス（世界遺産バス）
      { organization_id: 'kaetsunou', feed_id: 'kaetsunouhimi' }, // 加越能バス（氷見市街地周遊バス）
      { organization_id: 'nantocity', feed_id: 'nanbus' }, // 南砺市営バス
      { organization_id: 'oyabecity', feed_id: 'oyabecitybus' }, // 小矢部市営バス
    ],
  },
  17: {
    name: '石川県',
    feeds: [
      { organization_id: 'hakusancity', feed_id: 'hakusan_bus_meguru' }, // 白山市コミュニティバス「めぐーる」
      { organization_id: 'komatsucity', feed_id: 'kibagatasen' }, // 小松市 木場潟線
      { organization_id: 'komatsucity', feed_id: 'blue' }, // 小松市 市内循環線北コース
      { organization_id: 'komatsucity', feed_id: 'orange' }, // 小松市 市内循環線南コース
      { organization_id: 'nonoichicity', feed_id: 'communitybus' }, // 野々市市コミュニティバス
      { organization_id: 'uchinadatown', feed_id: 'communitybus' }, // 内灘町コミュニティバス
    ],
  },
};

function loadSnapshotFile() {
  if (!fs.existsSync(snapshotPath)) return { prefectures: {} };
  return JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
}

function saveSnapshotFile(snapshot) {
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
}

function buildDirectFetchEntry(prefCode) {
  const def = DIRECT_FETCH_PREFECTURES[prefCode];
  const config = JSON.parse(fs.readFileSync(def.configPath, 'utf-8'));
  const operators = (config[def.operatorsKey] || []).map((op) => ({ ...op, source: 'direct' }));
  if (operators.length === 0) {
    throw new Error(`${def.configPath} に事業者が1件もありません（${def.operatorsKey}が空）`);
  }
  return {
    pref_code: String(prefCode),
    pref_name: def.name,
    snapshot_date: new Date().toISOString().slice(0, 10),
    operators,
  };
}

/** gtfs-data.jp APIから1フィード分のメタデータを取得し、operator形式に変換する */
async function fetchGtfsDataJpFeed(organizationId, feedId) {
  const url = `${GTFS_DATA_JP_API_BASE}/organizations/${organizationId}/feeds/${feedId}`;
  const res = await fetch(url, { headers: { 'User-Agent': GTFS_DATA_JP_USER_AGENT } });
  if (!res.ok) {
    throw new Error(`gtfs-data.jp API エラー: HTTP ${res.status}（${organizationId}/${feedId}, ${url}）`);
  }
  const json = await res.json();
  const body = json.body;
  if (!body) {
    throw new Error(`gtfs-data.jp API: 想定外のレスポンス形式（${organizationId}/${feedId}）`);
  }

  const currentFile = (body.gtfs_files || []).find((f) => f.rid === 'current');
  if (!currentFile) {
    throw new Error(`gtfs-data.jp: rid="current"のファイルが見つかりません（${organizationId}/${feedId}）。フィードが廃止済みの可能性があります`);
  }

  const operatorId = `${organizationId}.${feedId}`;
  return {
    id: operatorId,
    name: `${body.organization_name} ${body.feed_name}`,
    gtfs_url: currentFile.gtfs_url,
    source: 'gtfs-data.jp',
    source_category: 'gtfs-data-jp',
    source_category_label: 'GTFSデータリポジトリ（gtfs-data.jp）から取得',
    source_category_note: null,
    license_label: body.feed_license,
    license_url: body.feed_license_url,
    license_source_url: body.feed_page_url || null,
    license_source_note: 'gtfs-data.jp APIのfeed_license/feed_license_urlをそのまま採用',
    organization_id: organizationId,
    feed_id: feedId,
    rid: currentFile.rid,
    gtfs_file_uid: currentFile.gtfs_file_uid,
    gtfs_file_from_date: currentFile.from_date,
    gtfs_file_to_date: currentFile.to_date,
    gtfs_file_created_at: currentFile.created_at,
    gtfs_file_published_at: currentFile.published_at,
  };
}

async function buildGtfsDataJpEntry(prefCode) {
  const def = GTFS_DATA_JP_PREFECTURES[prefCode];
  const operators = [];
  for (const { organization_id, feed_id } of def.feeds) {
    console.log(`   → gtfs-data.jp取得中: ${organization_id}/${feed_id}`);
    operators.push(await fetchGtfsDataJpFeed(organization_id, feed_id));
  }
  if (operators.length === 0) {
    throw new Error(`都道府県コード${prefCode}: gtfs-data.jpのフィード一覧が空です`);
  }
  return {
    pref_code: String(prefCode),
    pref_name: def.name,
    snapshot_date: new Date().toISOString().slice(0, 10),
    operators,
  };
}

/**
 * 都道府県コードのカタログスナップショットを読み込む（なければ生成して保存する）。
 * @param {number|string} prefCode
 * @param {{force?: boolean}} options - forceでスナップショットを取り直す
 */
export async function loadOrBuildCatalogSnapshot(prefCode, { force = false } = {}) {
  const key = String(prefCode);
  const snapshot = loadSnapshotFile();

  if (snapshot.prefectures[key] && !force) {
    console.log(`⏭️  カタログスナップショット: 都道府県コード${key}は既存（${snapshot.prefectures[key].snapshot_date}取得分）を再利用`);
    return snapshot.prefectures[key];
  }

  const numericCode = Number(prefCode);
  let entry;
  if (numericCode in DIRECT_FETCH_PREFECTURES) {
    entry = buildDirectFetchEntry(numericCode);
    console.log(
      `✅ カタログスナップショット: 都道府県コード${key}（${entry.pref_name}）を新規取得（事業者${entry.operators.length}件、取得元: direct）`
    );
  } else if (numericCode in GTFS_DATA_JP_PREFECTURES) {
    entry = await buildGtfsDataJpEntry(numericCode);
    console.log(
      `✅ カタログスナップショット: 都道府県コード${key}（${entry.pref_name}）を新規取得（フィード${entry.operators.length}件、取得元: gtfs-data.jp、rid=current）`
    );
  } else {
    const known = [...Object.keys(DIRECT_FETCH_PREFECTURES), ...Object.keys(GTFS_DATA_JP_PREFECTURES)];
    throw new Error(
      `都道府県コード${key}のカタログ取得方法が未実装です。現時点で対応している都道府県コードは${known.join(', ')}のみです。`
    );
  }

  snapshot.prefectures[key] = entry;
  saveSnapshotFile(snapshot);
  return entry;
}

/**
 * GTFS取得後、実際にダウンロードしたフィードのバージョン情報
 * （feed_info.txtのfeed_version/feed_start_date/feed_end_date）をカタログ
 * スナップショットに記録する。
 *
 * 【背景】カタログスナップショット自体は「どのURLから取得するか」の取得日
 * しか記録しておらず、フィードの中身がいつのダイヤ改正のものかは分からない。
 * 実際に、ことでんバスが2026-10-01のダイヤ改正でfeed_versionを
 * 「ことでんバス_20260401-20260930」→「ことでんバス_20261001-20270331」に
 * 更新していたことが、この記録がないと追えなかった（駅362→364等の変化の
 * 原因調査に手間がかかった）。再現性のため、取得のたびに記録を更新する。
 *
 * @param {number|string} prefCode
 * @param {Array<{operatorId: string, feedVersion: string|null, feedStartDate: string|null, feedEndDate: string|null}>} feedInfos
 */
export function recordFetchedFeedVersions(prefCode, feedInfos) {
  const key = String(prefCode);
  const snapshot = loadSnapshotFile();
  const entry = snapshot.prefectures[key];
  if (!entry) {
    console.warn(`⚠️  カタログスナップショットに都道府県コード${key}のエントリがないため、フィード版の記録をスキップします`);
    return;
  }

  const fetchedAt = new Date().toISOString();
  const byOperatorId = new Map(feedInfos.map((f) => [f.operatorId, f]));
  for (const operator of entry.operators) {
    const info = byOperatorId.get(operator.id);
    if (!info) continue;
    operator.feed_version = info.feedVersion;
    operator.feed_start_date = info.feedStartDate;
    operator.feed_end_date = info.feedEndDate;
    operator.last_fetched_at = fetchedAt;
  }
  saveSnapshotFile(snapshot);
  console.log(`✅ カタログスナップショット: 都道府県コード${key}のフィード版情報を記録（${feedInfos.length}件）`);
}
