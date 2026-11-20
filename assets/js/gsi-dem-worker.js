/**
 * gsi-dem-worker.js - 地理院標高タイルのピクセル変換をメインスレッドの外で行う
 * Web Worker（2026-10-10、4本目②「3Dの初回表示を速く感じさせる」）。
 *
 * 1タイル256×256=65536ピクセルの変換（地理院符号化の復号→terrarium再符号化）を
 * メインスレッドで行うと、CPUが遅い端末やスロットリング下でフレームが落ち、
 * 「3D地図を準備しています」の表示自体やページの他の操作が固まって見える。
 * この処理はDOM操作を伴わない純粋な計算（OffscreenCanvas + ピクセル配列の
 * 読み書き）のため、そのままWorkerに移せる。
 *
 * gsi-dem-protocol.js（同じvendor/maplibre/フォルダに同梱）のWorkerプールが
 * 生成・利用する。Worker自体が使えない・読み込みに失敗した環境では、
 * gsi-dem-protocol.js側がメインスレッドでの変換に自動フォールバックする。
 */
import { convertGsiDemTileToTerrarium } from './gsi-dem-protocol.js';

self.onmessage = async (e) => {
  const { id, blob } = e.data;
  try {
    const buffer = await convertGsiDemTileToTerrarium(blob);
    self.postMessage({ id, buffer }, [buffer]);
  } catch (err) {
    self.postMessage({ id, error: err && err.message ? err.message : String(err) });
  }
};
