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
 * 【現時点のスコープ】gtfs-data.jp API v2からのカタログ取得は未実装（段階1(b)以降、
 * 富山・石川で実際にgtfs-data.jp由来のフィードを扱うときに実装する）。存在しない
 * 手順を「あるかのように」書かない（CLAUDE.md）ため、direct以外の取得方法が
 * 必要な都道府県コードを渡すと明示的にエラーで止まる。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const snapshotPath = path.join(__dirname, '../../data/derived/national/gtfs-catalog-snapshot.json');
const targetOperatorsPath = path.join(__dirname, '../../config/target-operators.json');

// 都道府県コード → 直接取得(direct)の設定ファイルの対応。gtfs-data.jp由来の
// 都道府県が増えたら、ここに追加するのではなく別途APIフェッチャーを実装すること
// （直接取得はこの県固有の少数事業者にしか成立しない前提）。
const DIRECT_FETCH_PREFECTURES = {
  37: { name: '香川県', configPath: targetOperatorsPath, operatorsKey: 'phase1_operators' },
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

/**
 * 都道府県コードのカタログスナップショットを読み込む（なければ生成して保存する）。
 * @param {number|string} prefCode
 * @param {{force?: boolean}} options - forceでスナップショットを取り直す
 */
export function loadOrBuildCatalogSnapshot(prefCode, { force = false } = {}) {
  const key = String(prefCode);
  const snapshot = loadSnapshotFile();

  if (snapshot.prefectures[key] && !force) {
    console.log(`⏭️  カタログスナップショット: 都道府県コード${key}は既存（${snapshot.prefectures[key].snapshot_date}取得分）を再利用`);
    return snapshot.prefectures[key];
  }

  if (!(prefCode in DIRECT_FETCH_PREFECTURES) && !(Number(prefCode) in DIRECT_FETCH_PREFECTURES)) {
    throw new Error(
      `都道府県コード${key}のカタログ取得方法が未実装です。` +
      `gtfs-data.jp API連携は段階1(b)以降（富山・石川）で実装予定のため、現時点ではdirect（事業者直接取得）` +
      `として登録済みの都道府県コード（${Object.keys(DIRECT_FETCH_PREFECTURES).join(', ')}）のみビルドできます。`
    );
  }

  const entry = buildDirectFetchEntry(Number(prefCode));
  snapshot.prefectures[key] = entry;
  saveSnapshotFile(snapshot);
  console.log(
    `✅ カタログスナップショット: 都道府県コード${key}（${entry.pref_name}）を新規取得（事業者${entry.operators.length}件、取得元: direct）`
  );
  return entry;
}
