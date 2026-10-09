/**
 * jp-holidays.js - 日本の国民の祝日を計算する（2026-10-09、便数調査のため新規作成）
 *
 * 「運行期間内の祝日でない水曜日」を決定的に選ぶために必要（Minamiさんの指示）。
 * 外部API・外部データファイルには依存せず、祝日法の規定をコードで計算する
 * （ビルドのオフライン性・再現性を保つため。CLAUDE.mdの「決定的な選択規則を
 * 使うこと」の方針に合わせた）。
 *
 * 実装範囲：
 * - 固定日の祝日（元日・建国記念の日・天皇誕生日・昭和の日・憲法記念日・
 *   みどりの日・こどもの日・山の日・文化の日・勤労感謝の日）
 * - 「ハッピーマンデー」の祝日（成人の日・海の日・敬老の日・スポーツの日）
 * - 春分の日・秋分の日（国立天文台が例年2月に官報で確定するまでは正式な日付が
 *   存在しないため、1980〜2099年の範囲で有効とされる近似式で計算する。
 *   出典：海上保安庁 水路部の計算式として広く知られるもの）
 * - 振替休日（祝日が日曜のとき、次の祝日でない日を休日にする）
 * - 国民の休日（前後を祝日に挟まれた祝日でない平日を休日にする）
 *
 * 【検証方法】既知の実際のカレンダー（2026年・2027年）と突き合わせて
 * 主要な祝日の日付が合うことを確認済み（investigate-service-frequency.jsの
 * 冒頭で自己チェックとして出力する）。
 */

function vernalEquinoxDay(year) {
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

function autumnalEquinoxDay(year) {
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

/** その月のn番目の指定曜日（0=日,1=月,...）の日付を返す */
function nthWeekday(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const firstWeekday = first.getUTCDay();
  const offset = (weekday - firstWeekday + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}

function dateKey(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 指定した年の祝日一覧を { "YYYY-MM-DD": "祝日名" } の形で返す（振替休日・
 * 国民の休日を含む）。年単位でキャッシュする。
 */
const cache = new Map();
export function getHolidaysForYear(year) {
  if (cache.has(year)) return cache.get(year);

  const holidays = new Map();
  const add = (month, day, name) => holidays.set(dateKey(year, month, day), name);

  add(1, 1, '元日');
  add(1, nthWeekday(year, 1, 1, 2), '成人の日');
  add(2, 11, '建国記念の日');
  add(2, 23, '天皇誕生日');
  add(3, vernalEquinoxDay(year), '春分の日');
  add(4, 29, '昭和の日');
  add(5, 3, '憲法記念日');
  add(5, 4, 'みどりの日');
  add(5, 5, 'こどもの日');
  add(7, nthWeekday(year, 7, 1, 3), '海の日');
  add(8, 11, '山の日');
  add(9, nthWeekday(year, 9, 1, 3), '敬老の日');
  add(9, autumnalEquinoxDay(year), '秋分の日');
  add(10, nthWeekday(year, 10, 1, 2), 'スポーツの日');
  add(11, 3, '文化の日');
  add(11, 23, '勤労感謝の日');

  // 振替休日：祝日が日曜のとき、その直後の「祝日でない日」を休日にする
  const substituteAdds = [];
  for (const [key] of holidays) {
    const d = new Date(`${key}T00:00:00Z`);
    if (d.getUTCDay() === 0) {
      const next = new Date(d);
      do {
        next.setUTCDate(next.getUTCDate() + 1);
      } while (holidays.has(next.toISOString().slice(0, 10)));
      substituteAdds.push([next.toISOString().slice(0, 10), '振替休日']);
    }
  }
  for (const [key, name] of substituteAdds) holidays.set(key, name);

  // 国民の休日：前後を祝日に挟まれた、祝日でない平日
  const nationalAdds = [];
  for (const [key] of holidays) {
    const d = new Date(`${key}T00:00:00Z`);
    const next = new Date(d);
    next.setUTCDate(next.getUTCDate() + 2);
    const between = new Date(d);
    between.setUTCDate(between.getUTCDate() + 1);
    const betweenKey = between.toISOString().slice(0, 10);
    const nextKey = next.toISOString().slice(0, 10);
    if (!holidays.has(betweenKey) && holidays.has(nextKey) && between.getUTCDay() !== 0) {
      nationalAdds.push([betweenKey, '国民の休日']);
    }
  }
  for (const [key, name] of nationalAdds) holidays.set(key, name);

  cache.set(year, holidays);
  return holidays;
}

/** "YYYYMMDD"（GTFS形式）または"YYYY-MM-DD"の日付文字列が祝日かどうか */
export function isHoliday(dateStr) {
  const normalized = dateStr.includes('-')
    ? dateStr
    : `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
  const year = parseInt(normalized.slice(0, 4), 10);
  return getHolidaysForYear(year).has(normalized);
}

/**
 * 指定した日付（"YYYYMMDD"）以降で、最初の「祝日でない」指定曜日の日付を返す
 * （"YYYYMMDD"形式）。weekday: 0=日,1=月,...,6=土。
 */
export function findFirstNonHolidayWeekdayOnOrAfter(startDateStr, weekday) {
  let d = new Date(
    Date.UTC(
      parseInt(startDateStr.slice(0, 4), 10),
      parseInt(startDateStr.slice(4, 6), 10) - 1,
      parseInt(startDateStr.slice(6, 8), 10)
    )
  );
  for (let i = 0; i < 400; i++) {
    if (d.getUTCDay() === weekday) {
      const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
      if (!isHoliday(ymd)) return ymd;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  throw new Error(`400日以内に祝日でない曜日${weekday}が見つかりませんでした（起点: ${startDateStr}）`);
}
