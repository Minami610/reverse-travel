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
 * - `GET /v2/feeds?pref={都道府県コード}` が、その都道府県に属する全フィードの一覧
 *   （organization_id/feed_id・ライセンス・廃止フラグ等）を返す。
 * - `GET /v2/organizations/{organization_id}/feeds/{feed_id}` がフィード1件分のメタデータと
 *   リビジョン一覧（gtfs_files配列）を返す。各リビジョンはrid（current/数値のプレビュー等）を持ち、
 *   rid==="current"のものが現在公開中のデータ。
 * - 現在データのダウンロードURLは `gtfs_files[].gtfs_url`
 *   （`.../files/feed.zip?uid=<gtfs_file_uid>` の形。uidはリビジョンごとに変わる）。
 * - operator.idはorganization_idとfeed_idの組から作る（gtfs-id.jsのコメント参照：
 *   feed_idは全国一意ではない。例：野々市市と内灘町が共にfeed_id="communitybus"）。
 *
 * 【2026-10-03修正】段階1(b)では`/v2/feeds?pref=`の存在に気づかず、富山・石川向けに
 * Cowork承認済みの{organization_id, feed_id}一覧（富山8件・石川6件）を手書きしていた。
 * 実際に`/v2/feeds?pref=16`を叩くと31件のフィードが存在し（富山市のコミュニティバス9件、
 * 高岡市公営バス、射水市のきときとバス、立山町営バス、上市町営バス、魚津・黒部・滑川・
 * 入善・朝日町・砺波市のバス、西日本JRバス名金線等）、23件が手書きの一覧から漏れていた。
 * 石川（6件）はたまたま手書きの一覧と一致していたが、再発防止のため両県とも
 * このAPIを一覧の唯一の情報源にする。手書きで県の一覧から外すのではなく、
 * 取得した全件をいったん候補にしたうえで、廃止フィード（feed_is_discontinued）は
 * 理由付きでexcluded_operatorsに回す（ライセンス・運賃データの判定は引き続き
 * build-prefecture.js側で機械的に行う）。
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

// 都道府県コード(01〜47) → 都道府県名。gtfs-data.jpの/v2/feeds APIは都道府県名を
// 返さないため、カタログスナップショットのpref_nameに使う静的な対応表（地理的事実）。
const PREF_NAMES_BY_CODE = {
  1: '北海道', 2: '青森県', 3: '岩手県', 4: '宮城県', 5: '秋田県', 6: '山形県', 7: '福島県',
  8: '茨城県', 9: '栃木県', 10: '群馬県', 11: '埼玉県', 12: '千葉県', 13: '東京都', 14: '神奈川県',
  15: '新潟県', 16: '富山県', 17: '石川県', 18: '福井県', 19: '山梨県', 20: '長野県', 21: '岐阜県',
  22: '静岡県', 23: '愛知県', 24: '三重県', 25: '滋賀県', 26: '京都府', 27: '大阪府', 28: '兵庫県',
  29: '奈良県', 30: '和歌山県', 31: '鳥取県', 32: '島根県', 33: '岡山県', 34: '広島県', 35: '山口県',
  36: '徳島県', 37: '香川県', 38: '愛媛県', 39: '高知県', 40: '福岡県', 41: '佐賀県', 42: '長崎県',
  43: '熊本県', 44: '大分県', 45: '宮崎県', 46: '鹿児島県', 47: '沖縄県',
};

/** gtfs-data.jp APIから、指定した都道府県コードに属する全フィードの一覧を取得する */
async function fetchFeedListFromApi(prefCode) {
  const url = `${GTFS_DATA_JP_API_BASE}/feeds?pref=${prefCode}`;
  const res = await fetch(url, { headers: { 'User-Agent': GTFS_DATA_JP_USER_AGENT } });
  if (!res.ok) {
    throw new Error(`gtfs-data.jp API エラー: HTTP ${res.status}（/v2/feeds?pref=${prefCode}）`);
  }
  const json = await res.json();
  if (!Array.isArray(json.body)) {
    throw new Error(`gtfs-data.jp API: 想定外のレスポンス形式（/v2/feeds?pref=${prefCode}）`);
  }
  return json.body;
}

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

/**
 * 指定した都道府県コードについて、/v2/feeds?pref= で見つかった全フィードを
 * 候補にする。廃止フィード（feed_is_discontinued）はダウンロードを試みず、
 * 理由付きでexcluded_operatorsに回す。残りは1件ずつ詳細取得（rid=current）を
 * 試み、失敗したものも理由付きで除外に回す（1件の失敗で都道府県全体の
 * ビルドを止めない）。
 */
async function buildGtfsDataJpEntry(prefCode) {
  const feedList = await fetchFeedListFromApi(prefCode);
  if (feedList.length === 0) {
    throw new Error(`都道府県コード${prefCode}: gtfs-data.jpのフィード一覧が空です（/v2/feeds?pref=${prefCode}）`);
  }
  const prefName = PREF_NAMES_BY_CODE[Number(prefCode)];
  if (!prefName) {
    throw new Error(`都道府県コード${prefCode}の名称が不明です（PREF_NAMES_BY_CODEに未登録）`);
  }

  const operators = [];
  const excludedOperators = [];

  for (const feed of feedList) {
    const operatorId = `${feed.organization_id}.${feed.feed_id}`;
    if (feed.feed_is_discontinued) {
      excludedOperators.push({
        operator: operatorId,
        operator_name: `${feed.organization_name} ${feed.feed_name}`,
        reason: `gtfs-data.jp上で廃止済み（feed_is_discontinued=true${feed.feed_discontinued_date ? `、廃止日 ${feed.feed_discontinued_date}` : ''}）`,
      });
      continue;
    }
    console.log(`   → gtfs-data.jp取得中: ${operatorId}`);
    try {
      operators.push(await fetchGtfsDataJpFeed(feed.organization_id, feed.feed_id));
    } catch (error) {
      console.warn(`   ⚠️  ${operatorId}: 詳細取得に失敗したため除外します（${error.message}）`);
      excludedOperators.push({
        operator: operatorId,
        operator_name: `${feed.organization_name} ${feed.feed_name}`,
        reason: `gtfs-data.jpからの詳細取得に失敗（${error.message}）`,
      });
    }
  }

  if (operators.length === 0) {
    throw new Error(`都道府県コード${prefCode}: 取得できたフィードが1件もありません（${excludedOperators.length}件すべて除外）`);
  }

  return {
    pref_code: String(prefCode),
    pref_name: prefName,
    snapshot_date: new Date().toISOString().slice(0, 10),
    operators,
    excluded_operators: excludedOperators,
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
  } else {
    // direct以外は常にgtfs-data.jpの/v2/feeds?pref=から動的に取得する（手書きの
    // 一覧は持たない。2026-10-03修正：以前は都道府県コードごとの手書き一覧しか
    // 受け付けず、富山で31件中23件が一覧から漏れる事故があった）。
    entry = await buildGtfsDataJpEntry(numericCode);
    console.log(
      `✅ カタログスナップショット: 都道府県コード${key}（${entry.pref_name}）を新規取得` +
      `（フィード${entry.operators.length}件、除外${entry.excluded_operators.length}件、取得元: gtfs-data.jp、rid=current）`
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
