/**
 * generate-site-data.js - data/derived/pref/{code}/ の派生JSONを、配信用の
 * docs/data/pref/{code}/ に変換して出力する（段階1(c)の土台）。
 *
 * 【背景】現行のbundle-html.jsは全データを単一HTMLに埋め込む方式で、県が
 * 増えるほどページが肥大化する（香川だけで埋め込みデータが2.7MB＝バンドル全体の
 * 92%を占める）。県ごとに分割し、出発駅の県＋隣接県だけをfetchする構成に移行する。
 *
 * この変換で行うこと：
 * 1. route-details.jsonのroute_id文字列を、県内で使われるユニークな値だけの
 *    配列（routeIndex）に対する整数インデックスへ置き換える。route_id文字列は
 *    ユニーク数が少ない一方（実測: 富山で245件）、エントリ数に比例して繰り返し
 *    登場するため（同実測で全体の31%、1.9MB/6.1MB）、スポットのQIDインデックス化
 *    と同じ考え方で圧縮する。出力形式: { routeIndex: [...], data: {...} }
 *    （data部分の構造自体はdata/derived側と同じ、route_id文字列だけが整数に
 *    置き換わる）。フロントエンド（gtfs-loader.js）はロード時にrouteIndexで
 *    文字列へ復元し、以降のコード（fare-calculator.js・route-formatter.js等）は
 *    一切変更しない。
 * 2. その他のファイル（fare-lookup-tables/stops-metadata/stations/route-info/
 *    spots-by-station/data-sources）はそのままコピーする（JSON.parse→
 *    JSON.stringifyで整形を除去するのみ）。
 *
 * 【2026-10-03追記】docs/data（公開ページが実際に配信する場所）に書き込めるのは、
 * config/published-prefectures.json に載っている県だけに限定した。
 * 【背景】026525fで「段階1(b)：本番には採用しない」としていた富山・石川を、
 * 検証目的で `node generate-site-data.js 37,16,17` と手で実行してそのまま
 * docs/dataに出力・pushしてしまい、公開ページで富山・石川が出発駅として
 * 検索できる状態になる事故があった（県境の重複スポット統合・県境駅の連結
 * ・番号0判定など、段階1(c)で確認する予定だった点が未検証のまま公開されていた）。
 * 再発防止のため、docs/dataへ出力する唯一の経路を「引数なしで実行し、
 * config/published-prefectures.jsonを読む」ルートだけに絞った。手元で
 * 公開前の県を検証したい場合は `--local-verify <コード,...>` を使う
 * （docs/data/ではなくdata/site-preview/に出力する。公開されない）。
 *
 * 使い方:
 *   node scripts/build-pipeline/generate-site-data.js
 *     → 公開モード。config/published-prefectures.jsonの県をdocs/dataに出力
 *   node scripts/build-pipeline/generate-site-data.js --local-verify 37,16,17
 *     → ローカル検証モード。指定県をdata/site-preview/に出力（docs/は変更しない）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { N03_DATA_SOURCE } from './municipality-polygon-lookup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '../..');
const DOCS_DATA_ROOT = path.join(rootDir, 'docs/data');

const ODPT_OR_GTFS_DATA_JP = new Set(['odpt', 'gtfs-data-jp']);

function prefCodeStr(code) {
  return String(code).padStart(2, '0');
}

/**
 * route-details.jsonの中に登場するroute_id文字列をすべて集め、整数インデックス化する。
 * @param {object} routeDetails - {originId: {destId: {operatorId: RouteEntry}}}
 * @returns {{routeIndex: string[], data: object}}
 */
function indexRouteIds(routeDetails) {
  const routeIndex = [];
  const idToIndex = new Map();
  function indexOf(routeId) {
    if (!idToIndex.has(routeId)) {
      idToIndex.set(routeId, routeIndex.length);
      routeIndex.push(routeId);
    }
    return idToIndex.get(routeId);
  }

  const data = {};
  for (const [originId, destMap] of Object.entries(routeDetails)) {
    data[originId] = {};
    for (const [destId, byOperator] of Object.entries(destMap)) {
      data[originId][destId] = {};
      for (const [operatorId, entry] of Object.entries(byOperator)) {
        if (entry.length === 3) {
          data[originId][destId][operatorId] = [indexOf(entry[0]), entry[1], entry[2]];
        } else {
          data[originId][destId][operatorId] = [
            entry[0], indexOf(entry[1]), entry[2], entry[3], indexOf(entry[4]), entry[5], entry[6],
          ];
        }
      }
    }
  }
  return { routeIndex, data };
}

/** 都道府県コード1件分を {outRoot}/pref/{code}/ へ変換出力する */
export function generateSiteDataForPrefecture(prefCode, outRoot = DOCS_DATA_ROOT) {
  const codeStr = prefCodeStr(prefCode);
  const srcDir = path.join(rootDir, 'data/derived/pref', codeStr);
  const destDir = path.join(outRoot, 'pref', codeStr);
  fs.mkdirSync(destDir, { recursive: true });

  const plainCopyFiles = [
    'fare-lookup-tables.json',
    'stops-metadata.json',
    'stations.json',
    'route-info.json',
    'spots-by-station.json',
    'data-sources.json',
  ];
  for (const file of plainCopyFiles) {
    const srcPath = path.join(srcDir, file);
    if (!fs.existsSync(srcPath)) {
      throw new Error(`${srcPath} が見つかりません。先に npm run build-prefecture ${prefCode} を実行してください`);
    }
    const parsed = JSON.parse(fs.readFileSync(srcPath, 'utf-8'));
    fs.writeFileSync(path.join(destDir, file), JSON.stringify(parsed));
  }

  const routeDetailsPath = path.join(srcDir, 'route-details.json');
  const routeDetails = JSON.parse(fs.readFileSync(routeDetailsPath, 'utf-8'));
  const indexed = indexRouteIds(routeDetails);
  fs.writeFileSync(path.join(destDir, 'route-details.json'), JSON.stringify(indexed));

  const beforeSize = fs.statSync(routeDetailsPath).size;
  const afterSize = fs.statSync(path.join(destDir, 'route-details.json')).size;
  console.log(
    `✅ ${path.relative(rootDir, destDir)}/ を生成（route-details.json: ${(beforeSize / 1024).toFixed(1)}KB → ` +
    `${(afterSize / 1024).toFixed(1)}KB、routeIndex ${indexed.routeIndex.length}件）`
  );

  return { codeStr, routeIdCount: indexed.routeIndex.length };
}

/**
 * 都道府県コード→隣接都道府県コードの静的表。日本の地理的事実のため、一度
 * 作れば更新不要。陸続きの隣接に加え、公共交通で直接行き来できる橋・トンネル
 * 経由の隣接も含める（例：香川⇔岡山、瀬戸大橋線で鉄道が直通する）。
 * 【注記】全47都道府県分を網羅しているが、今回実地検証したのは香川・富山・
 * 石川の3県のみ。他県分は一般的な地理知識に基づく下書きであり、全国展開前に
 * 要レビュー。
 */
export const PREFECTURE_ADJACENCY = {
  '01': [], // 北海道（本州と地続きではない。青函トンネルは新幹線のみで本アプリ未対応路線）
  '02': ['03', '05', '06'], // 青森
  '03': ['02', '04', '05', '06'], // 岩手
  '04': ['03', '05', '07'], // 宮城
  '05': ['02', '03', '06'], // 秋田
  '06': ['02', '03', '04', '05', '07'], // 山形
  '07': ['04', '06', '09', '10', '15'], // 福島
  '08': ['09', '10', '11', '12', '14'], // 茨城
  '09': ['07', '08', '10', '15'], // 栃木
  '10': ['07', '08', '09', '11', '15', '20'], // 群馬
  '11': ['08', '10', '12', '13', '14', '19', '20'], // 埼玉
  '12': ['08', '11', '13', '14'], // 千葉
  '13': ['11', '12', '14', '19'], // 東京
  '14': ['08', '11', '12', '13', '19', '22'], // 神奈川
  '15': ['07', '09', '10', '20', '21', '16'], // 新潟
  '16': ['15', '17', '20', '21'], // 富山
  '17': ['16', '18', '21'], // 石川
  '18': ['17', '20', '21', '25', '26', '27'], // 福井
  '19': ['11', '13', '14', '20', '22'], // 山梨
  '20': ['10', '11', '15', '16', '18', '19', '21', '23'], // 長野
  '21': ['15', '16', '17', '18', '20', '23', '24', '25'], // 岐阜
  '22': ['14', '19', '23'], // 静岡
  '23': ['20', '21', '22', '24', '25'], // 愛知
  '24': ['21', '23', '25', '26'], // 三重
  '25': ['18', '21', '24', '26', '27', '28', '29'], // 滋賀
  '26': ['18', '21', '24', '25', '27', '28', '29', '30'], // 京都
  '27': ['18', '25', '26', '28'], // 大阪
  '28': ['25', '26', '27', '29', '31', '32', '33'], // 兵庫
  '29': ['25', '26', '28', '30'], // 奈良
  '30': ['26', '29', '28', '36'], // 和歌山
  '31': ['28', '32', '33'], // 鳥取
  '32': ['31', '33', '34'], // 島根
  '33': ['28', '31', '32', '34', '36', '37'], // 岡山（瀬戸大橋線で香川と直通）
  '34': ['32', '33', '35', '38', '39'], // 広島（瀬戸内海航路で愛媛・今治と繋がるが未確認のため陸続きのみ記載）
  '35': ['34', '31'], // 山口
  '36': ['30', '37', '38'], // 徳島
  '37': ['36', '38', '33'], // 香川（陸続きは徳島・愛媛、瀬戸大橋線で岡山と直通）
  '38': ['36', '37', '39'], // 愛媛
  '39': ['36', '38'], // 高知
  '40': ['41', '42', '43', '44'], // 福岡
  '41': ['40', '42'], // 佐賀
  '42': ['41'], // 長崎
  '43': ['40', '44', '45', '46'], // 熊本
  '44': ['40', '43', '45'], // 大分
  '45': ['43', '44', '46'], // 宮崎
  '46': ['43', '45'], // 鹿児島
  '47': [], // 沖縄（地続きの都道府県なし）
};

/**
 * 既にdocs/data/pref/配下に生成済みの都道府県から、全国の軽量駅一覧
 * （docs/data/national/station-index.json）を生成する。
 * エントリは[表示名, 都道府県コード(数値), 県内通し番号]の配列形式
 * （駅IDや座標は含めない。選択後にloadPrefectures()でその県の
 * stations.jsonを取得してから、県内通し番号で実際のstation_idを復元する）。
 * 県内通し番号は、その県のstations.jsonのキー（station_id）を昇順ソートした
 * ときのインデックスで決める（生成側・参照側で同じソート規則を使えば一致する）。
 */
export function generateStationIndex(prefCodes, outRoot = DOCS_DATA_ROOT) {
  const entries = [];
  for (const prefCode of prefCodes) {
    const codeStr = prefCodeStr(prefCode);
    const stationsPath = path.join(outRoot, 'pref', codeStr, 'stations.json');
    if (!fs.existsSync(stationsPath)) {
      throw new Error(`${stationsPath} が見つかりません。先にgenerateSiteDataForPrefecture(${prefCode})を実行してください`);
    }
    const stations = JSON.parse(fs.readFileSync(stationsPath, 'utf-8'));
    const sortedIds = Object.keys(stations).sort();
    sortedIds.forEach((stationId, localIndex) => {
      entries.push([stations[stationId].display_name, Number(codeStr), localIndex]);
    });
  }

  const outDir = path.join(outRoot, 'national');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'station-index.json');
  fs.writeFileSync(outPath, JSON.stringify(entries));
  console.log(`✅ ${path.relative(rootDir, outPath)} を生成（${entries.length}駅、${prefCodes.length}都道府県分）`);

  const adjacencyPath = path.join(outDir, 'prefecture-adjacency.json');
  fs.writeFileSync(adjacencyPath, JSON.stringify(PREFECTURE_ADJACENCY));
  console.log(`✅ ${path.relative(rootDir, adjacencyPath)} を生成`);

  return { stationCount: entries.length };
}

/**
 * config/spot-ranking-config.json を docs/data/national/ にコピーする。
 *
 * 【背景】以前はbundle-html.jsが単一HTMLに埋め込んでいたが、県分割後は
 * フロントエンド（gtfs-loader.jsのloadStationIndex()）が起動時に一度だけ
 * fetchする構成に変える。この設定は都道府県に依存しないため、
 * docs/data/pref/配下ではなくnational配下に置く。
 */
export function copySpotRankingConfig(outRoot = DOCS_DATA_ROOT) {
  const srcPath = path.join(rootDir, 'config/spot-ranking-config.json');
  const outDir = path.join(outRoot, 'national');
  fs.mkdirSync(outDir, { recursive: true });
  const parsed = JSON.parse(fs.readFileSync(srcPath, 'utf-8'));
  const outPath = path.join(outDir, 'spot-ranking-config.json');
  fs.writeFileSync(outPath, JSON.stringify(parsed));
  console.log(`✅ ${path.relative(rootDir, outPath)} を生成`);
}

/**
 * 既にdocs/data/pref/配下に生成済みの都道府県のdata-sources.jsonを統合し、
 * docs/data/national/data-sources.jsonを生成する。
 *
 * 【背景】出典画面（About/使い方モーダル）は、検索前（＝どの都道府県の
 * データもまだロードしていない状態）でも表示できる必要がある。以前は
 * 単一HTMLに埋め込んだ香川県分だけのdata-sources.jsonを常に表示していたが、
 * 県分割後は「今ロード済みの県」という状態がページ起動直後には存在しない。
 * 全県のマニフェストを機械的に統合（事業者IDで重複排除）した全国版を
 * 常に表示する方式にする（ハードコードした文言を増やさない）。
 * feeds/excluded_feedsはoperator_idで重複排除（最初に見つかった県の記述を採用）、
 * coverage.prefecturesは全県分の和集合（登場順）。
 *
 * 【2026-10-03追記】GTFSフィード以外に「ビルド時にのみ使用したデータ」
 * （国土数値情報N03、同名駅の市区町村判定に使用。フロントエンドには一切含まれない）も
 * build_time_data_sourcesとして載せる。以前はindex.htmlに出典を手書きしていたが、
 * このアプリの方針（出典はハードコードせずマニフェートから出す）に反するため、
 * ここで機械的に組み立てる。値そのもの（提供元・ライセンス名・URL）は
 * municipality-polygon-lookup.jsのN03_DATA_SOURCEを単一の情報源とする
 * （GTFSフィードのfeed_info.txtに相当する機械可読な出典情報がN03には無いため、
 * 人間が公式ページを確認して書いた値をコード側で一元管理する）。
 *
 * 【2026-10-06追記】県名の直後に「（補足）」を付けられるようにした
 * （config/published-prefectures.jsonのarea_notes、都道府県コード→補足文字列）。
 * 石川県のように、対応エリアが県内の一部市町のコミュニティバスに限られ県全域を
 * カバーしていない場合に、使い方画面の対応地域表示でその旨を正直に示すため。
 */
export function generateNationalDataSources(prefCodes, outRoot = DOCS_DATA_ROOT) {
  const feedsById = new Map();
  const excludedById = new Map();
  const prefectures = [];

  const publishedConfigPath = path.join(rootDir, 'config/published-prefectures.json');
  const areaNotes = fs.existsSync(publishedConfigPath)
    ? JSON.parse(fs.readFileSync(publishedConfigPath, 'utf-8')).area_notes || {}
    : {};

  for (const prefCode of prefCodes) {
    const codeStr = prefCodeStr(prefCode);
    const srcPath = path.join(outRoot, 'pref', codeStr, 'data-sources.json');
    if (!fs.existsSync(srcPath)) {
      throw new Error(`${srcPath} が見つかりません。先にgenerateSiteDataForPrefecture(${prefCode})を実行してください`);
    }
    const manifest = JSON.parse(fs.readFileSync(srcPath, 'utf-8'));

    for (const feed of manifest.feeds || []) {
      if (!feedsById.has(feed.operator_id)) feedsById.set(feed.operator_id, feed);
    }
    for (const excluded of manifest.excluded_feeds || []) {
      if (!excludedById.has(excluded.operator_id)) excludedById.set(excluded.operator_id, excluded);
    }
    for (const pref of manifest.coverage?.prefectures || []) {
      const note = areaNotes[codeStr];
      const label = note ? `${pref}（${note}）` : pref;
      if (!prefectures.includes(label)) prefectures.push(label);
    }
  }

  const feeds = [...feedsById.values()];
  const excludedFeeds = [...excludedById.values()];
  const byCategory = feeds.reduce((acc, feed) => {
    acc[feed.source_category] = (acc[feed.source_category] || 0) + 1;
    return acc;
  }, {});
  const odptOrGtfsDataJpCount = feeds.filter((f) => ODPT_OR_GTFS_DATA_JP.has(f.source_category)).length;

  const manifest = {
    generated_at: new Date().toISOString(),
    feeds,
    excluded_feeds: excludedFeeds,
    build_time_data_sources: [N03_DATA_SOURCE],
    summary: {
      total: feeds.length,
      by_category: byCategory,
      odpt_or_gtfs_data_jp_count: odptOrGtfsDataJpCount,
      excluded_total: excludedFeeds.length,
    },
    coverage: {
      prefectures,
      note: `都道府県コード${prefCodes.map(prefCodeStr).join('・')}の統合（generate-site-data.js）`,
    },
  };

  const outDir = path.join(outRoot, 'national');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'data-sources.json');
  fs.writeFileSync(outPath, JSON.stringify(manifest));
  console.log(
    `✅ ${path.relative(rootDir, outPath)} を生成（フィード${feeds.length}件、対象外${excludedFeeds.length}件、対応${prefectures.length}都道府県）`
  );
}

/**
 * 公開中の都道府県コード一覧をdocs/data/national/published-prefectures.jsonに
 * 書き出す。フロントエンド（gtfs-loader.js）が、隣接県表（全47都道府県分の
 * 地理的事実）と突き合わせて「公開していない県へは404を出しに行かない」
 * フィルタに使う。
 */
export function writePublishedPrefecturesList(prefCodes, outRoot = DOCS_DATA_ROOT) {
  const outDir = path.join(outRoot, 'national');
  fs.mkdirSync(outDir, { recursive: true });
  const codes = prefCodes.map(prefCodeStr);
  const outPath = path.join(outDir, 'published-prefectures.json');
  fs.writeFileSync(outPath, JSON.stringify(codes));
  console.log(`✅ ${path.relative(rootDir, outPath)} を生成（${codes.join(', ')}）`);
}

/**
 * {outRoot}/pref/ 配下から、prefCodesに含まれない都道府県のディレクトリを削除する。
 * 【背景】026525fの事故は、docs/data/pref/16・17が「生成はしたが消さなかった」
 * ために公開され続けた。公開対象から外した県が docs/data/ に残り続けないよう、
 * 毎回の生成で公開リストと実際のディレクトリを一致させる。
 */
export function prunePrefDirs(prefCodes, outRoot = DOCS_DATA_ROOT) {
  const keep = new Set(prefCodes.map(prefCodeStr));
  const prefRoot = path.join(outRoot, 'pref');
  if (!fs.existsSync(prefRoot)) return;
  for (const entry of fs.readdirSync(prefRoot)) {
    if (keep.has(entry)) continue;
    const target = path.join(prefRoot, entry);
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`🗑️  ${path.relative(rootDir, target)}/ を削除（公開対象外）`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let prefCodes;
  let outRoot;

  if (args[0] === '--local-verify') {
    prefCodes = (args[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (prefCodes.length === 0) {
      console.error('ローカル検証モード: 都道府県コードを指定してください（例: --local-verify 37,16,17）');
      process.exit(1);
    }
    outRoot = path.join(rootDir, 'data/site-preview');
    console.log(`ℹ️  ローカル検証モード: ${path.relative(rootDir, outRoot)}/ に出力します（docs/は変更しません。公開されません）\n`);
  } else if (args.length > 0) {
    // docs/dataへ出力する経路は「引数なし＝公開リストを読む」だけに絞っている
    // （経緯は冒頭のコメント、2026-10-03追記を参照）。誤って任意の県をdocs/data
    // へ出力できてしまうと、同じ事故が再発する。
    console.error(
      '引数なしで実行してください（config/published-prefectures.jsonを読み、docs/dataに出力します）。\n' +
      '公開前の県を手元で検証する場合は --local-verify 37,16,17 の形式を使ってください（docs/には出力されません）。'
    );
    process.exit(1);
  } else {
    const publishedPath = path.join(rootDir, 'config/published-prefectures.json');
    const published = JSON.parse(fs.readFileSync(publishedPath, 'utf-8'));
    prefCodes = published.published;
    if (!Array.isArray(prefCodes) || prefCodes.length === 0) {
      console.error(`${publishedPath} の published が空です`);
      process.exit(1);
    }
    outRoot = DOCS_DATA_ROOT;
    console.log(`📢 公開モード: config/published-prefectures.json の${prefCodes.length}県をdocs/dataに出力します（${prefCodes.join(', ')}）\n`);
  }

  prunePrefDirs(prefCodes, outRoot);
  for (const code of prefCodes) {
    generateSiteDataForPrefecture(code, outRoot);
  }
  generateStationIndex(prefCodes, outRoot);
  copySpotRankingConfig(outRoot);
  generateNationalDataSources(prefCodes, outRoot);
  writePublishedPrefecturesList(prefCodes, outRoot);
}
