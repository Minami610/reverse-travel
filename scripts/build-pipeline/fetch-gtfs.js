/**
 * fetch-gtfs.js - GTFSデータ自動ダウンロード
 * config/target-operators.json から対象事業者を読み込み、
 * 各社の GTFS を data/raw-gtfs/ にダウンロード
 */

import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import AdmZip from 'adm-zip';
import { fileURLToPath } from 'url';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// パス定義
const configPath = path.join(__dirname, '../../config/target-operators.json');
const dataDir = path.join(__dirname, '../../data/raw-gtfs');
// 停留所・経路・運行情報はどんな交通フィードにも必須（欠けていればダウンロード・
// 解凍そのものが失敗している証拠）。fare_rules.txt/fare_attributes.txtは必須に
// 含めない：運賃データを持たないフィードが実在する（例：富山地方鉄道市内電車。
// 2026-10-01、段階1(b)で実際に検証して判明）。これらはparse-and-transform.jsが
// 欠如を許容して警告のみで続行し、fare-feed-check.jsが「運賃データなし」として
// 後段で理由付きで除外する設計のため、ここで止める必要がない（むしろ1事業者の
// 運賃データ欠如で県全体のダウンロードが失敗するのは過剰）。
const requiredGtfsFiles = ['stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt'];
const fareGtfsFiles = ['fare_rules.txt', 'fare_attributes.txt'];

function validateExtractedFiles(operatorDir, operatorName) {
  const missingFiles = requiredGtfsFiles.filter(
    (filename) => !fs.existsSync(path.join(operatorDir, filename))
  );

  if (missingFiles.length > 0) {
    throw new Error(
      `${operatorName}: GTFS必須ファイルがありません: ${missingFiles.join(', ')}`
    );
  }

  const missingFareFiles = fareGtfsFiles.filter(
    (filename) => !fs.existsSync(path.join(operatorDir, filename))
  );
  if (missingFareFiles.length > 0) {
    console.warn(
      `   ⚠️  ${operatorName}: 運賃関連ファイルがありません（${missingFareFiles.join(', ')}）。` +
      `運賃データなしのフィードとして後段（fare-feed-check.js）で除外判定されます`
    );
  }
}

/**
 * GTFS仕様はファイル拡張子を.txtと定めているが、一部のフィードは.csvで配布している
 * （実例：南砺市営バスのcalendar/calendar_dates/shapes/stop_times、2026-10-01、
 * 段階1(b)で発見）。以降のパース処理（parse-and-transform.js等）は.txtを前提にしか
 * 読んでいないため、.txtが存在せず.csvだけが存在するファイルをコピーして.txt版を
 * 作る。特定の事業者・ファイル名をハードコードせず、解凍後のディレクトリを
 * 汎用的に走査することで、同じ癖を持つ他のフィードにも自動対応する。
 */
function normalizeCsvToTxt(operatorDir, operatorName) {
  const files = fs.readdirSync(operatorDir);
  for (const file of files) {
    if (!file.endsWith('.csv')) continue;
    const base = file.slice(0, -4);
    const txtPath = path.join(operatorDir, `${base}.txt`);
    if (fs.existsSync(txtPath)) continue;
    fs.copyFileSync(path.join(operatorDir, file), txtPath);
    console.log(`   → ${operatorName}: ${file} に.txt版がないため ${base}.txt としてコピー（GTFS仕様外の.csv配布に対応）`);
  }
}

function extractAndValidateZip(zipPath, operatorDir, operatorName) {
  console.log(`   → ZIPを解凍中: ${zipPath}`);
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(operatorDir, true);
  normalizeCsvToTxt(operatorDir, operatorName);
  validateExtractedFiles(operatorDir, operatorName);
  console.log(`   → GTFS必須ファイルを検証完了 (${requiredGtfsFiles.length} ファイル)`);
}

/**
 * GTFSデータをダウンロード
 * @param {{operators?: Array, dataDir?: string, force?: boolean}} options
 *   operators省略時はconfig/target-operators.jsonのphase1_operatorsを使う（従来どおりの挙動）。
 *   forceはZIPが既に存在しても再ダウンロードする（段階1の「強制再取得オプション」用）。
 */
export async function fetchGTFS(options = {}) {
  console.log('📥 GTFS ダウンロード開始...');

  const operators = options.operators
    || JSON.parse(fs.readFileSync(configPath, 'utf-8')).phase1_operators;
  const targetDir = options.dataDir || dataDir;
  const force = options.force || false;

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  for (const operator of operators) {
    const operatorDir = path.join(targetDir, operator.id);
    const zipPath = path.join(operatorDir, 'data.zip');

    try {
      // ディレクトリ作成
      fs.mkdirSync(operatorDir, { recursive: true });

      if (force && fs.existsSync(zipPath)) {
        fs.rmSync(zipPath);
      }

      if (!fs.existsSync(zipPath)) {
        console.log(`⏳ ${operator.name} をダウンロード中...`);
        const response = await fetch(operator.gtfs_url, {
          timeout: 30000,
        });

        if (!response.ok) {
          throw new Error(
            `HTTP ${response.status}: ${operator.gtfs_url}`
          );
        }

        await pipeline(response.body, createWriteStream(zipPath));
        console.log(`✅ ${operator.name} をダウンロード完了`);
      } else {
        console.log(`⏭️  ${operator.name} - ZIPは既に存在。再利用`);
      }

      const hasAllFiles = requiredGtfsFiles.every(
        (filename) => fs.existsSync(path.join(operatorDir, filename))
      );
      if (!hasAllFiles || force) {
        extractAndValidateZip(zipPath, operatorDir, operator.name);
      } else {
        console.log(`   → ${operator.name}: GTFSファイルは展開済み`);
      }

    } catch (error) {
      console.error(`❌ ${operator.name} ダウンロード失敗:`, error.message);
      throw error;
    }
  }

  console.log('✅ GTFS ダウンロード完了\n');
}

// 実行
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fetchGTFS().catch((error) => {
    console.error('❌ 致命的エラー:', error);
    process.exit(1);
  });
}
