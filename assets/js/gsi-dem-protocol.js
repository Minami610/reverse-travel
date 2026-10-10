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
 * 性能：ピクセル単位のJSループだが、1タイルは256×256=65536ピクセルで、
 * 3D表示で同時に読み込むタイル数は数十枚程度（県全体俯瞰のズーム9前後）。
 * 実測はこの回の報告に記載。
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

/**
 * 1タイル分のPNG（ArrayBuffer/Blob）を地理院符号化→terrarium符号化に変換する。
 * ブラウザのcanvas APIのみを使う（PNGデコード/エンコードライブラリを追加しない）。
 * @param {Blob} pngBlob
 * @returns {Promise<ArrayBuffer>} 変換後PNGのArrayBuffer
 */
export async function convertGsiDemTileToTerrarium(pngBlob) {
  const bitmap = await createImageBitmap(pngBlob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
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

  const outBlob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlobに失敗しました'))), 'image/png');
  });
  return outBlob.arrayBuffer();
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
    const data = await convertGsiDemTileToTerrarium(blob);
    return { data };
  });
}
