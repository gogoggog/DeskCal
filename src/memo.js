// 달력 아래 '월별 메모'
// - 늘 이 PC(memos.json)에 먼저 저장해서, 인터넷이 끊겨도 메모가 사라지지 않게 합니다.
// - 아이클라우드가 연결돼 있으면 'DeskCal 메모' 캘린더에 그달 1일의 종일 일정 하나로 올려서
//   윈도우·맥(그리고 나중에 만들 아이폰 앱)이 같은 메모를 봅니다.
//   형식은 docs/data-format.md 에 정리해 두었습니다.

const MEMO_CAL_NAME = 'DeskCal 메모';
const MEMO_CAL_SLUG = 'deskcal-memo';

const pad = (n) => String(n).padStart(2, '0');
const isMonthKey = (k) => typeof k === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(k);

function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return `${y}년 ${m}월`;
}
function memoUid(month) {
  return `deskcal-memo-${month}`;
}
function memoFileName(month) {
  return `${memoUid(month)}.ics`;
}

const utcStamp = (d) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

function icsEscape(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}
function icsUnescape(s) {
  return String(s || '').replace(/\\(n|N|\\|,|;)/g, (_m, c) => (c === 'n' || c === 'N' ? '\n' : c));
}
function fold(line) {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const parts = [];
  let cur = '';
  let curLen = 0;
  for (const ch of line) {
    const len = Buffer.byteLength(ch, 'utf8');
    if (curLen + len > (parts.length ? 74 : 75)) {
      parts.push(cur);
      cur = '';
      curLen = 0;
    }
    cur += ch;
    curLen += len;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

// 메모 한 달치 → 캘린더 파일 내용
function buildMemoIcs(month, text, updatedAt = Date.now()) {
  const [y, m] = month.split('-').map(Number);
  const next = new Date(y, m - 1, 2);
  const now = utcStamp(new Date(updatedAt));
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//DeskCal//Memo//KO',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${memoUid(month)}`,
    `DTSTAMP:${now}`,
    `LAST-MODIFIED:${now}`,
    `DTSTART;VALUE=DATE:${y}${pad(m)}01`,
    `DTEND;VALUE=DATE:${next.getFullYear()}${pad(next.getMonth() + 1)}${pad(next.getDate())}`,
    `SUMMARY:${icsEscape(`📝 ${m}월 메모`)}`,
    `DESCRIPTION:${icsEscape(text)}`,
    'TRANSP:TRANSPARENT',
    `X-DESKCAL-MEMO:${month}`,
    `X-DESKCAL-UPDATED:${Math.round(updatedAt)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

// 캘린더 파일 내용 → { month, text, updatedAt }  (메모가 아니면 null)
function parseMemoIcs(data) {
  const lines = String(data || '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  let month = '';
  let text = '';
  let updated = 0;
  let lastMod = 0;
  let summary = '';
  let dtstart = '';
  for (const l of lines) {
    const i = l.indexOf(':');
    if (i < 0) continue;
    const key = l.slice(0, i).split(';')[0].toUpperCase();
    const val = l.slice(i + 1);
    if (key === 'X-DESKCAL-MEMO') month = val.trim();
    else if (key === 'DESCRIPTION') text = icsUnescape(val);
    else if (key === 'X-DESKCAL-UPDATED') updated = Number(val) || 0;
    else if (key === 'SUMMARY') summary = icsUnescape(val).trim();
    else if (key === 'DTSTART') dtstart = val.trim();
    else if (key === 'LAST-MODIFIED') {
      const m = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
      if (m) lastMod = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    }
    else if (key === 'UID' && !month) {
      const m = val.match(/^deskcal-memo-(\d{4}-\d{2})$/);
      if (m) month = m[1];
    }
  }
  // 맥 캘린더(DeskCal 맥)에서 만든 메모: 표시 대신 '📝 N월 메모' 제목 + 그달 1일
  if (!isMonthKey(month)) {
    const t = summary.match(/^📝\s*(\d{1,2})월 메모$/);
    const d = dtstart.match(/^(\d{4})(\d{2})01/);
    if (t && d && Number(t[1]) === Number(d[2])) month = `${d[1]}-${d[2]}`;
  }
  if (!isMonthKey(month)) return null;
  // 다른 기기에서 고치면 LAST-MODIFIED만 바뀔 수 있으니 더 늦은 쪽
  return { month, text, updatedAt: Math.max(updated, lastMod) };
}

module.exports = { MEMO_CAL_NAME, MEMO_CAL_SLUG, isMonthKey, monthLabel, memoUid, memoFileName, buildMemoIcs, parseMemoIcs };
