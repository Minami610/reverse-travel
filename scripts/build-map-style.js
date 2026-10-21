/**
 * build-map-style.js - 2D・3Dの下地の地図のスタイル（MapLibreのスタイルJSON）を作る
 *
 * 【2026-10-21、43本目D（44本目で差し替え）、Minami決定】下地の地図を「国土地理院のベクトル地図
 * （地図記号なし・アプリの色）」にそろえる。見本：Coworkの「地図の見た目_Bダッシュ.png」の2段目
 * 「B'：国土地理院ベクトル（地図記号なし・色をアプリに合わせた例）」。
 *
 * 入力：assets/vendor/gsi-vector/pale.json（国土地理院の公式スタイル「淡色」をそのまま保存したもの。
 *   取得元 https://gsi-cyberjapan.github.io/gsivectortile-mapbox-gl-js/pale.json 、タイルは
 *   https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/{z}/{x}/{y}.pbf （地理院地図Vector））
 * 出力：assets/vendor/gsi-vector/app-style.json（bundle-html.jsがdist/・docs/のvendor/gsi-vector/へコピー）
 *
 * やること：
 * 1. 地図記号・細かい記号のレイヤーを外す（source-layerがsymbol・contour・landforma・landforml・
 *    landformp・searoute・structurel・structurea・wstructurea・boundary。44本目の指示どおり）。
 *    標高点の数字（elevation）も地図記号のたぐいのため外す。
 * 2. 残した文字のレイヤー（label＝地名・施設名、transp＝駅名・道路番号）からアイコン（地図記号・
 *    道路番号の盾）を外し、文字だけにする（アイコンだけのレイヤーは外す）。アイコンの画像（sprite）
 *    は使わなくなるため、スタイルからも外す。
 * 3. 色をアプリに合わせる：地はうすいクリーム色、水面はうすい水色、道路は白に灰色のふち、
 *    高速道路・国道は少し濃い灰色、鉄道は灰色、建物はうすい灰色、文字は灰色。
 *    元の色の値ごとに置き換える（同じ元の色＝同じ役割のため、レイヤーを1つずつ手で直すより
 *    抜けが無い）。
 * 4. 一番下に地の色（background）のレイヤーを足す（元のスタイルには無い）。
 *
 * 使い方：node scripts/build-map-style.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const srcPath = path.join(rootDir, 'assets/vendor/gsi-vector/pale.json');
const outPath = path.join(rootDir, 'assets/vendor/gsi-vector/app-style.json');

const DROP_SOURCE_LAYERS = new Set([
  'symbol', 'contour', 'landforma', 'landforml', 'landformp', 'searoute',
  'structurel', 'structurea', 'wstructurea', 'boundary',
  'elevation',
]);

// アプリの色（見本B'に合わせた値）
const APP = {
  background: '#F4F2EC',
  water: '#CCE0F0',
  waterLine: '#A9C9E6',
  building: '#E6E3DC',
  buildingLine: '#DAD6CF',
  roadCasing: '#C9C4BA',
  road: '#FFFFFF',
  majorRoad: '#BDB8AE',
  railway: '#999999',
  railwayLight: '#B3B3B3',
  text: '#5F5F5F',
  textLight: '#8A8A8A',
  textHalo: '#FFFFFF',
};

/** 元の色（rgb/rgba表記）→ アプリの色。source-layerと塗る場所ごとに決める。 */
function recolor(sourceLayer, key, value) {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(String(value).replace(/\s+/g, ''));
  if (!m) return value;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const isWhite = r === 255 && g === 255 && b === 255;
  const isGray = r === g && g === b;
  if (key === 'text-halo-color') return APP.textHalo;
  if (key === 'text-color') {
    if (isWhite) return APP.textLight; // 道路番号（もとは盾のアイコンの上の白文字）
    return (r + g + b) / 3 < 100 ? APP.text : APP.textLight;
  }
  switch (sourceLayer) {
    case 'waterarea':
      return (r > 250 && g > 250) ? APP.water : APP.water;
    case 'river':
    case 'lake':
    case 'coastline':
      if (isWhite) return APP.water;
      return APP.waterLine;
    case 'building':
      return key === 'line-color' ? APP.buildingLine : APP.building;
    case 'road':
      if (isWhite) return APP.road;
      if (isGray) return APP.roadCasing; // 道路のふち（灰色）
      return APP.majorRoad; // 国道（黄）・高速道路（緑）など色付きの道路
    case 'railway':
      if (isWhite) return '#FFFFFF';
      if (isGray && r >= 190) return APP.railwayLight;
      return APP.railway;
    default:
      return value;
  }
}

function deepMapColors(sourceLayer, key, v) {
  if (typeof v === 'string') return recolor(sourceLayer, key, v);
  if (Array.isArray(v)) return v.map((x) => deepMapColors(sourceLayer, key, x));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = deepMapColors(sourceLayer, key, x);
    return out;
  }
  return v;
}

const ICON_LAYOUT_KEYS = Object.freeze([
  'icon-image', 'icon-size', 'icon-allow-overlap', 'icon-ignore-placement', 'icon-optional',
  'icon-pitch-alignment', 'icon-rotation-alignment', 'icon-anchor', 'icon-offset', 'icon-rotate',
  'icon-padding', 'icon-keep-upright', 'icon-text-fit', 'icon-text-fit-padding',
]);

function main() {
  const src = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
  const sourceId = Object.keys(src.sources)[0];
  let droppedBySourceLayer = 0;
  let droppedIconOnly = 0;
  const layers = [];
  for (const layer of src.layers) {
    const sl = layer['source-layer'];
    if (DROP_SOURCE_LAYERS.has(sl)) { droppedBySourceLayer++; continue; }
    const l = JSON.parse(JSON.stringify(layer));
    if (l.type === 'symbol') {
      if (!l.layout || !l.layout['text-field']) { droppedIconOnly++; continue; }
      for (const k of ICON_LAYOUT_KEYS) delete l.layout[k];
      for (const k of Object.keys(l.paint || {})) if (k.startsWith('icon-')) delete l.paint[k];
    }
    if (l.paint) {
      for (const [k, v] of Object.entries(l.paint)) {
        if (/color/.test(k)) l.paint[k] = deepMapColors(sl, k, v);
      }
    }
    layers.push(l);
  }
  if (layers.length === 0) throw new Error('残ったレイヤーが0件です（入力のスタイルを確認してください）');
  const out = {
    version: 8,
    name: 'reverse-travel GSI vector (no map symbols, app colors)',
    // 文字の形（字形）は国土地理院が配信しているもの（元のスタイルと同じ）。
    glyphs: src.glyphs,
    // 【45本目】出典は、国土地理院が提供実験の説明（GitHubのgsimaps-vector-experiment）で求めている
    // 「国土地理院ベクトルタイル提供実験」とし、その説明へリンクする（43本目は「国土地理院」だけだった）。
    // 以前の説明：地図の上の出典は短く「国土地理院」（地理院地図Vectorのページへのリンク）にする。元のスタイルの
    // 「地理院地図Vector（仮称）」のままだと、PCの地図の下の情報枠（2D/3D切替ボタンと出典ボタンの間に
    // 収める作り、main.jsのupdateSpotInfoPanelMaxWidth()）が狭まり、場所の名前が押しつぶされて
    // 見えなくなった（実機相当の確認で発覚）。詳しい名前は出典画面（index.html）に書いている。
    sources: { [sourceId]: { ...src.sources[sourceId], attribution: '<a href="https://github.com/gsi-cyberjapan/gsimaps-vector-experiment" target="_blank" rel="noopener">国土地理院ベクトルタイル提供実験</a>' } },
    layers: [
      { id: 'app-background', type: 'background', paint: { 'background-color': APP.background } },
      ...layers,
    ],
  };
  fs.writeFileSync(outPath, JSON.stringify(out));
  const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log(`✅ ${path.relative(rootDir, outPath)}（${out.layers.length}レイヤー、${kb}KB）`);
  console.log(`   外したレイヤー：地図記号など${droppedBySourceLayer}件、アイコンだけの文字レイヤー${droppedIconOnly}件`);
}

main();
