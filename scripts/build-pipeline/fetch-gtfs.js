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
const requiredGtfsFiles = [
  'stops.txt',
  'routes.txt',
  'trips.txt',
  'stop_times.txt',
  'fare_rules.txt',
  'fare_attributes.txt',
];

function validateExtractedFiles(operatorDir, operatorName) {
  const missingFiles = requiredGtfsFiles.filter(
    (filename) => !fs.existsSync(path.join(operatorDir, filename))
  );

  if (missingFiles.length > 0) {
    throw new Error(
      `${operatorName}: GTFS必須ファイルがありません: ${missingFiles.join(', ')}`
    );
  }
}

function extractAndValidateZip(zipPath, operatorDir, operatorName) {
  console.log(`   → ZIPを解凍中: ${zipPath}`);
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(operatorDir, true);
  validateExtractedFiles(operatorDir, operatorName);
  console.log(`   → GTFS必須ファイルを検証完了 (${requiredGtfsFiles.length} ファイル)`);
}

/**
 * GTFSデータをダウンロード
 */
export async function fetchGTFS() {
  console.log('📥 GTFS ダウンロード開始...');

  // config を読み込む
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  // data/raw-gtfs ディレクトリを作成
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  for (const operator of config.phase1_operators) {
    const operatorDir = path.join(dataDir, operator.id);
    const zipPath = path.join(operatorDir, 'data.zip');

    try {
      // ディレクトリ作成
      fs.mkdirSync(operatorDir, { recursive: true });

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
      if (!hasAllFiles) {
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
