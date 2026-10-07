/**
 * favorites.js - お気に入り（マイリスト）の保存・共有URLの組み立て/解析
 *
 * localStorageはこのアプリで初めて使う（2026-10-08時点で他に使用箇所なし）。
 * 利用不可能な環境（プライベートブラウジング・ストレージ無効化等）でも画面が
 * 壊れないよう、読み書きはすべてtry/catchで囲み、失敗時は「保存されていない」
 * 状態として振る舞う（例外を外に投げない）。
 *
 * 保存項目は { qid, name, prefCode, departureStationId, departureName,
 * roundTripFare, durationMin, savedAt } の7項目に固定する（Minamiさんの判断。
 * data-sources.jsonのgenerated_atを「データの版」として保存する案は、保存のたびに
 * 余分なfetchが要ることを理由に見送った。運賃の変化は保存時の値と読み込み時の
 * 再計算値を単純比較するだけで検出する）。
 */

const STORAGE_KEY = 'ikeru.favorites.v1';
const MAX_LIST_SHARE_ITEMS = 20;

function isValidFavoriteEntry(entry) {
  return (
    entry &&
    typeof entry === 'object' &&
    typeof entry.qid === 'string' &&
    entry.qid.length > 0 &&
    typeof entry.name === 'string' &&
    typeof entry.prefCode === 'string' &&
    typeof entry.departureStationId === 'string' &&
    typeof entry.departureName === 'string' &&
    typeof entry.roundTripFare === 'number' &&
    (entry.durationMin === null || typeof entry.durationMin === 'number') &&
    typeof entry.savedAt === 'string'
  );
}

/**
 * 保存済みのお気に入り一覧を読む。localStorageが使えない・壊れている・
 * 形式が違う場合は空配列を返す（画面を落とさない）。配列中、個々の要素が
 * 壊れている場合はその要素だけ読み飛ばす（1件の破損で全体を失わないため）。
 */
export function loadFavorites() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidFavoriteEntry);
  } catch {
    return [];
  }
}

/** @returns {boolean} 保存に成功したか（失敗してもエラーは投げない） */
export function saveFavorites(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function isFavorite(qid) {
  return loadFavorites().some((f) => f.qid === qid);
}

/**
 * お気に入りの保存/解除を切り替える。同じQIDが既にあれば解除、無ければ追加する
 * （1スポットにつき1件。別の出発駅から同じスポットを再度保存すると、
 * 直近の出発駅の内容で上書きされる）。
 * @returns {boolean} 切り替えた後の状態（true=保存された、false=解除された）
 */
export function toggleFavorite(entry) {
  const list = loadFavorites();
  const idx = list.findIndex((f) => f.qid === entry.qid);
  if (idx >= 0) {
    list.splice(idx, 1);
    saveFavorites(list);
    return false;
  }
  list.push(entry);
  saveFavorites(list);
  return true;
}

export function removeFavorite(qid) {
  saveFavorites(loadFavorites().filter((f) => f.qid !== qid));
}

/** 既にあれば内容を置き換え、無ければ追加する（共有されたリストの一括追加用）。 */
export function upsertFavorite(entry) {
  const list = loadFavorites();
  const idx = list.findIndex((f) => f.qid === entry.qid);
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  saveFavorites(list);
}

/**
 * 景勝地1件の共有URL（出発駅はstation_id・表示名の両方を入れる。
 * どちらかだけでは再現できない場合があるため：station_idは再ビルドで駅が
 * 1件も増減しなければ安定だが保証はなく、表示名だけだと同名駅が複数県にある
 * 場合に曖昧になる。開く側は「sidが実在しdepと一致→採用、ダメならdepの
 * 完全一致が1件だけのとき採用」の順で解決する）。
 */
export function buildSpotShareUrl(baseHref, { qid, prefCode, stationId, departureName }) {
  const url = new URL(baseHref);
  url.search = '';
  url.hash = '';
  url.searchParams.set('spot', qid);
  url.searchParams.set('pref', String(prefCode));
  url.searchParams.set('sid', stationId);
  url.searchParams.set('dep', departureName);
  return url.toString();
}

export function parseSpotShareParams(searchParams) {
  const qid = searchParams.get('spot');
  const prefCode = searchParams.get('pref');
  const stationId = searchParams.get('sid');
  const departureName = searchParams.get('dep');
  if (!qid || !prefCode || !departureName) return null;
  return { qid, prefCode, stationId, departureName };
}

/**
 * リストの各項目を1フィールドずつencodeURIComponentしてから`:`で連結し、
 * 項目同士は`,`で連結する。`:`/`,`はencodeURIComponentが必ずエスケープする
 * 文字のため、station_idが日本語やコロンを含んでいても区切り文字と衝突しない
 * （実データで確認済み：香川の一部station_idは`kotoden:瓦町_出入口1`のように
 * 既にコロンを含む）。件数は先頭20件に切り詰める。
 */
export function buildListShareUrl(baseHref, items) {
  const url = new URL(baseHref);
  url.search = '';
  url.hash = '';
  const encoded = items
    .slice(0, MAX_LIST_SHARE_ITEMS)
    .map((it) => [it.qid, it.prefCode, it.stationId].map((v) => encodeURIComponent(String(v))).join(':'))
    .join(',');
  url.searchParams.set('list', encoded);
  return url.toString();
}

/**
 * ?list=の値を{qid, prefCode, stationId}の配列に戻す。壊れた項目
 * （区切りの数が合わない・空文字列等）は読み飛ばす。
 */
export function parseListParam(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((chunk) => {
      const parts = chunk.split(':');
      if (parts.length !== 3) return null;
      try {
        const [qid, prefCode, stationId] = parts.map((p) => decodeURIComponent(p));
        if (!qid || !prefCode || !stationId) return null;
        return { qid, prefCode, stationId };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .slice(0, MAX_LIST_SHARE_ITEMS);
}

/**
 * 共有テキストを組み立てる（2026-10-08時点の1本目では便数・市町村名は含めない。
 * Minamiさんの判断：2本目でデータを作る段階からまとめて追加する）。
 */
export function buildSpotShareText(spotName, departureName, roundTripFare, durationMin, url) {
  const durationPart = typeof durationMin === 'number' ? `、約${durationMin}分` : '';
  return `${spotName}／${departureName}からバスで往復¥${roundTripFare}${durationPart}。／${url}`;
}

/**
 * navigator.shareが使えればそれを使い、無ければクリップボードにコピーする。
 * @returns {Promise<'shared'|'copied'|'failed'>}
 */
export async function shareOrCopy(text, url) {
  if (navigator.share) {
    try {
      await navigator.share({ text, url });
      return 'shared';
    } catch (error) {
      // ユーザーがシートを閉じた場合（AbortError）は失敗として扱わない
      if (error?.name === 'AbortError') return 'shared';
      // navigator.shareが失敗した場合はクリップボードにフォールバックする
    }
  }
  try {
    await navigator.clipboard.writeText(`${text}`);
    return 'copied';
  } catch {
    return 'failed';
  }
}
