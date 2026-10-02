/**
 * municipality-polygon-lookup.js - 国土数値情報「行政区域データ」(N03)による
 * 市区町村ポリゴン判定（ビルド時専用。フロントエンドには一切含めない）。
 *
 * 【背景】parse-and-transform.jsの駅表示名の曖昧さ回避は、以前
 * municipality-locations.json（Wikidataの代表点）への最近傍探索で市区町村を
 * 判定していた。しかし代表点は市区町村の「どこか1点」でしかなく、富山市のように
 * 市域が広い自治体では代表点が市街地から離れた場所（南部の山間部）にあることがあり、
 * 富山市中心部の停留所が隣接する小さな自治体（舟橋村）に誤判定される実例が出た
 * （2026-10-02、富山・石川の再ビルドで発見）。さらにWikidataの代表点データには
 * 上市町・朝日町が欠落し、合併で消滅した旧大山町が残っているなど、母集団自体にも
 * 抜け漏れがあった。
 *
 * 「代表点に近いか」ではなく「市区町村の境界ポリゴンの中に実際に入っているか」で
 * 判定するよう、国土数値情報（国土交通省、出典表記必須のオープンデータ）の
 * 行政区域データ(N03)を使う。ODPTが連携を推奨する国土交通省データでもあり、
 * 応募の「使用したオープンデータ」にも記載できる。
 *
 * 出典：国土交通省 国土数値情報「行政区域データ」(N03)
 *   https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-v3_1.html
 * 利用規約：国土数値情報ダウンロードサイトコンテンツ利用規約（政府標準利用規約 第2.0版 準拠）
 *   https://nlftp.mlit.go.jp/ksj/other/agreement_01.html
 * 【2026-10-02訂正】当初「PDL1.0（政府標準利用規約1.0）」と記載していたが誤りだった。
 * N03データリストページの「このデータの使用許諾条件」リンク先（上記agreement_01.html）
 * を直接確認したところ、正式名称は「国土数値情報ダウンロードサイトコンテンツ利用規約」で、
 * 準拠するのは政府標準利用規約の**第2.0版**（制定：令和2年4月1日）であり、PDLという略称も
 * 1.0という版番号もこのページには登場しない。「PDL1.0」はダウンロードサイト側の
 * 「使用許諾条件」一覧表の要約表現（「適用する利用規約に基づく」）を、全く別の
 * （デジタル庁が定める）「公共データ利用規約（PDL）」と取り違えたことによる誤記だった。
 * index.htmlへの手書きをやめ、ここ（N03_DATA_SOURCE）を唯一の情報源として
 * generate-site-data.js経由でdata-sources.jsonマニフェストに反映する。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import AdmZip from 'adm-zip';
import * as shapefile from 'shapefile';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(__dirname, '../../data/raw-gis/n03');

// 令和5年（2023年1月1日時点）版。
const N03_VINTAGE = '20230101';

/**
 * data-sources.jsonマニフェスト（generate-site-data.jsのgenerateNationalDataSources()）
 * に載せる、N03の出典情報。GTFSフィードのfeed_info.txtに相当する機械可読な出典情報が
 * N03には無いため、ここに人間が確認した値を一元管理する（上記コメントの訂正履歴参照）。
 */
export const N03_DATA_SOURCE = {
  id: 'n03',
  category: 'build-time-tool',
  category_label: 'ビルド時にのみ使用（検索結果の表示には含まれません）',
  provider_name: '国土交通省',
  dataset_name: '国土数値情報「行政区域データ」(N03)',
  dataset_url: 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-v3_1.html',
  license_label: '国土数値情報ダウンロードサイトコンテンツ利用規約（政府標準利用規約第2.0版準拠）',
  license_url: 'https://nlftp.mlit.go.jp/ksj/other/agreement_01.html',
  usage_note: '同名の駅・停留所の表示名を区別するため、停留所の座標がどの市区町村の境界ポリゴンに含まれるかの判定にのみ使用しています。',
};

function zipUrl(prefCode) {
  const code = String(prefCode).padStart(2, '0');
  return `https://nlftp.mlit.go.jp/ksj/gml/data/N03/N03-2023/N03-${N03_VINTAGE}_${code}_GML.zip`;
}

async function downloadAndExtract(prefCode) {
  const code = String(prefCode).padStart(2, '0');
  const prefDir = path.join(cacheDir, code);
  fs.mkdirSync(prefDir, { recursive: true });
  const zipPath = path.join(prefDir, 'n03.zip');

  if (!fs.existsSync(zipPath)) {
    console.log(`   → 国土数値情報N03（都道府県コード${code}）をダウンロード中...`);
    const url = zipUrl(prefCode);
    const response = await fetch(url, { timeout: 60000 });
    if (!response.ok) {
      throw new Error(`N03ダウンロード失敗: HTTP ${response.status} (${url})`);
    }
    await pipeline(response.body, createWriteStream(zipPath));
  }

  const shpExists = fs.readdirSync(prefDir).some((f) => f.endsWith('.shp'));
  if (!shpExists) {
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(prefDir, true);
  }

  const files = fs.readdirSync(prefDir);
  const shpFile = files.find((f) => f.toLowerCase().endsWith('.shp'));
  const dbfFile = files.find((f) => f.toLowerCase().endsWith('.dbf'));
  if (!shpFile || !dbfFile) {
    throw new Error(`N03のshp/dbfファイルが見つかりません（都道府県コード${code}, dir=${prefDir}）`);
  }
  return { shpPath: path.join(prefDir, shpFile), dbfPath: path.join(prefDir, dbfFile) };
}

/**
 * 指定した都道府県コードのN03ポリゴンを読み込み、点がどの市区町村に属するかを
 * 判定する関数を返す。
 * @param {Array<number|string>} prefCodes - 対象の都道府県コード（複数可。県境付近の
 *   停留所が隣県のポリゴンに入ることがあるため、建築中の県＋隣接県を渡すことを想定）
 * @returns {Promise<(lon:number, lat:number)=>string|null>} 市区町村名（例：「富山市」）を返す関数。
 *   どのポリゴンにも入らなければnull
 */
export async function buildMunicipalityPolygonFinder(prefCodes) {
  const features = [];
  for (const prefCode of prefCodes) {
    const { shpPath, dbfPath } = await downloadAndExtract(prefCode);
    // N03のdbf属性ファイルはShift-JIS（CP932）でエンコードされている
    // （日本の行政データに多い）。utf-8指定だと文字化けする（実測で発見）。
    const source = await shapefile.open(shpPath, dbfPath, { encoding: 'shift-jis' });
    let result = await source.read();
    while (!result.done) {
      features.push(result.value);
      result = await source.read();
    }
  }
  console.log(`   → N03ポリゴン読み込み完了: ${features.length}件（${prefCodes.length}都道府県分）`);

  return function findMunicipality(lat, lon) {
    const point = { type: 'Point', coordinates: [lon, lat] };
    for (const feature of features) {
      if (!feature.geometry) continue;
      try {
        if (booleanPointInPolygon(point, feature)) {
          // N03_004が市区町村名。政令指定都市の区はN03_004が市名、N03_005が区名
          // （例：N03_004="新潟市"、N03_005="中央区"）。区がある場合は
          // 「市名区名」を連結した表示名にする（例：「新潟市中央区」）。
          const city = feature.properties.N03_004 || '';
          const ward = feature.properties.N03_005 || '';
          const name = `${city}${ward}`.trim();
          if (name) return name;
        }
      } catch {
        continue; // 不正なジオメトリはスキップ（判定失敗として扱う）
      }
    }
    return null;
  };
}
