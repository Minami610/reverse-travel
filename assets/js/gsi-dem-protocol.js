/**
 * gsi-dem-protocol.js - 国土地理院 標高タイル（dem_png）をMapLibre GL JSの
 * raster-dem（terrarium符号化）として読めるように変換するプロトコルハンドラ
 * （2026-10-10、4本目①「3D地図の土台」。feature/3d-mapブランチ）
 *
 * 【背景】地理院標高タイルの符号化式（https://maps.gsi.go.jp/development/demtile.html）は
 *   x = 2^16・R + 2^8・G + B
 *   x < 2^23  → h = x × u（u=標高分解能0.01m）
 *   x = 2^23  → データなし（R=128, G=0, B=0）
 *   x > 2^23  → h = (x − 2^24) × u
 * という区分式で、負の標高（海面下）を24bit符号付き整数のような折り返しで表現する。
 * MapLibreのraster-demソースが持つ`encoding:"custom"`は
 *   h = R×redFactor + G×greenFactor + B×blueFactor − baseShift
 * という単一の一次式しか表せず、上記の区分（データなしの特別値、2^23を境にした
 * 符号反転）を再現できない。一次式のまま無理に近似すると、データなし
 * （海など）のピクセルが標高830km級の異常値として解釈され、海上に巨大な柱が
 * 立つ不具合になる（調査段階で「redFactor:2.16」という式を使っていたが、これは
 * 地理院タイル一覧ページをWebFetchで要約した際に上付き文字（2^16等）が
 * 失われて「216」という桁の並びに化けたものを、確認せずにそのまま使って
 * しまった誤りだった。2^23/2^24の閾値も同様に223/224に化けており、
 * データなし判定・負標高の折り返しのどちらも欠落していた）。
 *
 * 【対策】maplibregl.addProtocol()でタイル取得を横取りし、取得したPNGを
 * canvasで1ピクセルずつ本来の区分式で標高(m)に復元したうえで、MapLibreが
 * ネイティブ対応する terrarium 符号化（h = R×256 + G + B/256 − 32768）に
 * 再エンコードして返す。データなし（海等）は0mとして扱う（Minami指示）。
 *
 * 【2026-10-10追記、4本目②】ピクセル変換（1タイル256×256=65536ピクセル）を
 * Web Worker（gsi-dem-worker.js）に逃がし、メインスレッドをブロックしない
 * ようにした。convertGsiDemTileToTerrarium自体はOffscreenCanvasが使えれば
 * それを使う（メインスレッド・ワーカーどちらでも動く共通コードにするため）、
 * 無ければdocument.createElementのcanvasにフォールバックする（メインスレッド
 * 専用の経路）。ワーカーが使えない・失敗した環境では、このメインスレッド版の
 * 変換に自動フォールバックする（registerGsiDemProtocol参照）。
 */

const GSI_NODATA_X = 2 ** 23; // 8388608
const GSI_WRAP_X = 2 ** 24; // 16777216
const GSI_RESOLUTION = 0.01; // u

/** 地理院標高タイルのRGB値から標高(m)を復元する。データなしは0m。 */
export function decodeGsiElevation(r, g, b) {
  const x = r * 65536 + g * 256 + b;
  if (x === GSI_NODATA_X) return 0;
  if (x < GSI_NODATA_X) return x * GSI_RESOLUTION;
  return (x - GSI_WRAP_X) * GSI_RESOLUTION;
}

/** 標高(m)をterrarium符号化のRGBに変換する（h = R*256 + G + B/256 - 32768の逆関数）。 */
export function encodeTerrariumElevation(heightMeters) {
  const shifted = heightMeters + 32768;
  const intPart = Math.floor(shifted);
  const frac = shifted - intPart;
  const r = Math.floor(intPart / 256) & 255;
  const g = intPart % 256 & 255;
  const b = Math.round(frac * 256) & 255;
  return [r, g, b];
}

/** OffscreenCanvasがあればそれを、無ければ（メインスレッドのみ）通常のcanvasを作る。 */
function createCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasToBlob(canvas) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlobに失敗しました'))), 'image/png');
  });
}

/**
 * 1タイル分のPNG（Blob）を地理院符号化→terrarium符号化に変換する。
 * メインスレッド・Web Workerのどちらからも呼べる共通実装（PNGデコード/
 * エンコードライブラリを追加せず、ブラウザのcanvas APIのみを使う）。
 * @param {Blob} pngBlob
 * @returns {Promise<ArrayBuffer>} 変換後PNGのArrayBuffer
 */
export async function convertGsiDemTileToTerrarium(pngBlob) {
  const bitmap = await createImageBitmap(pngBlob);
  const canvas = createCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  for (let i = 0; i < pixels.length; i += 4) {
    const h = decodeGsiElevation(pixels[i], pixels[i + 1], pixels[i + 2]);
    const [r, g, b] = encodeTerrariumElevation(h);
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);

  const outBlob = await canvasToBlob(canvas);
  return outBlob.arrayBuffer();
}

const WORKER_URL = 'gsi-dem-worker.js'; // 同じvendor/maplibre/フォルダに同梱（相対import解決のため）
const WORKER_COUNT = Math.min(4, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2);

let workerPool = null; // null=未初期化 or 無効化（フォールバック確定）
let nextWorkerIndex = 0;
let nextRequestId = 1;
const pendingRequests = new Map();

function initWorkerPool() {
  if (workerPool !== null) return workerPool;
  if (typeof Worker === 'undefined') {
    workerPool = false;
    return workerPool;
  }
  try {
    const pool = [];
    for (let i = 0; i < WORKER_COUNT; i++) {
      const worker = new Worker(WORKER_URL, { type: 'module' });
      worker.onmessage = (e) => {
        const { id, buffer, error } = e.data;
        const entry = pendingRequests.get(id);
        if (!entry) return;
        pendingRequests.delete(id);
        if (error) entry.reject(new Error(error));
        else entry.resolve(buffer);
      };
      worker.onerror = () => {
        // このプール全体を無効化し、以降はメインスレッド変換にフォールバックする
        // （個別タイル単位のエラーはworker.onmessage側のerrorフィールドで扱う。
        // onerrorはworker自体が壊れた場合＝モジュール読み込み失敗等を想定）
        workerPool = false;
      };
      pool.push(worker);
    }
    workerPool = pool;
  } catch {
    workerPool = false;
  }
  return workerPool;
}

function convertViaWorker(blob) {
  const pool = initWorkerPool();
  if (!pool) return null; // フォールバックを使う合図
  const worker = pool[nextWorkerIndex];
  nextWorkerIndex = (nextWorkerIndex + 1) % pool.length;
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    worker.postMessage({ id, blob });
  });
}

/**
 * Workerプールが使えればそちらで変換し、無ければ・失敗すればメインスレッドで
 * 変換する（呼び出し元はどちらの経路かを意識しなくてよい）。
 */
async function convertGsiDemTileAuto(blob) {
  const viaWorker = convertViaWorker(blob);
  if (viaWorker) {
    try {
      return await viaWorker;
    } catch {
      // ワーカー経由の変換に失敗した場合はメインスレッドへフォールバックする
    }
  }
  return convertGsiDemTileToTerrarium(blob);
}

/**
 * MapLibreにカスタムプロトコルを登録する。タイルURLは
 * `${protocolName}://<実際のdem_png URL>` の形で指定する
 * （例: "gsidem://https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png"）。
 * @param {object} maplibregl
 * @param {string} protocolName
 */
export function registerGsiDemProtocol(maplibregl, protocolName = 'gsidem') {
  maplibregl.addProtocol(protocolName, async (params, abortController) => {
    const realUrl = params.url.slice(protocolName.length + 3); // "gsidem://" の9文字分を除く
    const response = await fetch(realUrl, { signal: abortController.signal });
    if (!response.ok) {
      throw new Error(`地理院標高タイルの取得に失敗しました（HTTP ${response.status}）: ${realUrl}`);
    }
    const blob = await response.blob();
    const data = await convertGsiDemTileAuto(blob);
    return { data };
  });
}
