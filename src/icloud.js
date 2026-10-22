// 아이클라우드 캘린더 계정 연결 (읽기 + 일정 추가/삭제)
// 애플이 제공하는 표준 방식(CalDAV)으로 연결하며, 애플 계정의 '앱 전용 암호'를 사용합니다.
const crypto = require('crypto');
const { extractEvents } = require('./calendar');
const memo = require('./memo');

const ICLOUD_URL = 'https://caldav.icloud.com';

let tsdav; // 처음 쓸 때 불러옴
let client = null;
let calMap = new Map(); // 캘린더 주소 → 캘린더 정보
let connectedAs = null;
let memoCal = null; // 'DeskCal 메모' 캘린더 (일정 목록에는 넣지 않음)
let homeUrl = ''; // 캘린더들이 들어 있는 상위 주소
const rawMap = new Map(); // 일정 주소 → 원본 내용 (수정할 때 다른 정보를 보존하기 위함)

// 애플 서버끼리 연결을 넘길 때(리디렉트) 로그인 정보가 빠지지 않도록 직접 따라가는 함수
// 로그인 정보는 애플(icloud.com) 서버로만 전달
let trail = []; // 문제 생겼을 때 어디서 막혔는지 보여 주기 위한 기록
async function icloudFetch(input, init = {}) {
  const startUrl = new URL(typeof input === 'string' ? input : input.url);
  if (init.redirect === 'manual' || init.redirect === 'error') {
    const r = await fetch(input, init);
    note(r, startUrl);
    return r;
  }
  let url = startUrl;
  let opts = { ...init, redirect: 'manual' };
  for (let i = 0; i < 6; i++) {
    const res = await fetch(url.href, opts);
    note(res, url);
    const loc = res.headers.get('location');
    if (![301, 302, 303, 307, 308].includes(res.status) || !loc) return res;
    const next = new URL(loc, url);
    const sameHost = next.host === url.host;
    const apple = next.protocol === 'https:' && /(^|\.)icloud\.com$/i.test(next.hostname);
    if (!sameHost && !apple) return res; // 애플 밖으로는 로그인 정보를 보내지 않음
    if (res.status === 303) opts = { ...opts, method: 'GET', body: undefined };
    url = next;
  }
  throw new Error('too many redirects');
}
function note(res, url) {
  trail.push(`${res.status} ${url.hostname}`);
  if (trail.length > 8) trail.shift();
}

function loadLib() {
  if (!tsdav) tsdav = require('tsdav');
  return tsdav;
}

function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return String(v._text ?? v._cdata ?? v.value ?? '');
  return String(v);
}

function cleanColor(c) {
  const s = textOf(c).trim();
  const m = s.match(/^#([0-9a-f]{6})/i);
  return m ? `#${m[1].toLowerCase()}` : '#4f8cff';
}

async function connect(appleId, password, serverUrl = ICLOUD_URL) {
  const { createDAVClient } = loadLib();
  let c;
  trail = [];
  try {
    c = await createDAVClient({
      serverUrl,
      credentials: { username: appleId, password },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
      fetch: icloudFetch,
    });
  } catch (e) {
    throw friendly(e);
  }
  let cals;
  try {
    cals = await c.fetchCalendars();
  } catch (e) {
    throw friendly(e);
  }
  cals = (cals || []).filter((cal) => !cal.components || cal.components.includes('VEVENT'));
  homeUrl = homeOf(cals);
  memoCal = cals.find(isMemoCal) || null;
  cals = cals.filter((cal) => !isMemoCal(cal));
  if (!cals.length) {
    throw new Error(`로그인하지 못했거나 캘린더가 없습니다. 애플 ID와 앱 전용 암호를 다시 확인해 주세요.${trail.length ? ` [진단: ${trail.join(' → ')}]` : ''}`);
  }
  client = c;
  connectedAs = appleId;
  calMap = new Map(cals.map((cal) => [cal.url, cal]));
  return cals.map((cal) => ({
    url: cal.url,
    name: textOf(cal.displayName) || '캘린더',
    color: cleanColor(cal.calendarColor),
  }));
}

// 메모 캘린더인지 (주소 끝이 deskcal-memo/ 이거나 이름이 'DeskCal 메모')
function isMemoCal(cal) {
  if (!cal) return false;
  const url = String(cal.url || '');
  return url.replace(/\/+$/, '').endsWith(`/${memo.MEMO_CAL_SLUG}`) || textOf(cal.displayName).trim() === memo.MEMO_CAL_NAME;
}
// https://pXX-caldav.icloud.com/1234/calendars/<캘린더>/ → https://pXX-caldav.icloud.com/1234/calendars/
function homeOf(cals) {
  for (const c of cals || []) {
    const m = String(c.url || '').match(/^(https:\/\/[^/]+\/.*?\/calendars\/)/);
    if (m) return m[1];
  }
  return '';
}

function friendly(e) {
  const msg = String((e && e.message) || e);
  const diag = trail.length ? ` [진단: ${trail.join(' → ')}]` : '';
  if (/401|unauthori/i.test(msg)) return new Error(`애플 ID 또는 앱 전용 암호가 맞지 않습니다.${diag}`);
  if (/fetch failed|ENOTFOUND|ECONN|timeout/i.test(msg)) return new Error(`인터넷 연결을 확인해 주세요.${diag}`);
  return new Error(`${msg}${diag}`);
}

function isConnected() {
  return !!client;
}

function disconnect() {
  client = null;
  connectedAs = null;
  calMap = new Map();
  memoCal = null;
  homeUrl = '';
  memoObjs.clear();
}

// 기간 안의 일정 가져오기
async function fetchEvents(calUrl, from, to) {
  const cal = calMap.get(calUrl);
  if (!client || !cal) throw new Error('아이클라우드에 연결되어 있지 않습니다');
  let objects;
  try {
    objects = await client.fetchCalendarObjects({
      calendar: cal,
      timeRange: { start: from.toISOString(), end: to.toISOString() },
    });
  } catch (e) {
    throw friendly(e);
  }
  const out = [];
  for (const obj of objects || []) {
    if (!obj || !obj.data) continue;
    rawMap.set(obj.url, { data: obj.data, etag: obj.etag || '' });
    for (const ev of extractEvents(obj.data, from, to)) {
      out.push({ ...ev, objUrl: obj.url, etag: obj.etag || '' });
    }
  }
  return out;
}

// ---------- 일정 추가 ----------
const pad = (n) => String(n).padStart(2, '0');
function icsEscape(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}
// 긴 줄은 75바이트마다 접기 (캘린더 표준 규칙)
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
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
const utcStamp = (d) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
const dateOnly = (key) => key.replace(/-/g, '');
function nextDayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  const n = new Date(y, m - 1, d + 1);
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
}

function buildIcs(ev, uid) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//DeskCal//KO',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${utcStamp(new Date())}`,
    `CREATED:${utcStamp(new Date())}`,
  ];
  if (ev.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${dateOnly(ev.startDay)}`);
    lines.push(`DTEND;VALUE=DATE:${dateOnly(nextDayKey(ev.endDay || ev.startDay))}`);
  } else {
    lines.push(`DTSTART:${utcStamp(new Date(ev.start))}`);
    lines.push(`DTEND:${utcStamp(new Date(ev.end))}`);
  }
  lines.push(`SUMMARY:${icsEscape(ev.title)}`);
  if (ev.location) lines.push(`LOCATION:${icsEscape(ev.location)}`);
  if (ev.notes) lines.push(`DESCRIPTION:${icsEscape(ev.notes)}`);
  lines.push(...colorLines(ev.color));
  if (ev.alarmMinutes != null && ev.alarmMinutes >= 0) {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(ev.title)}`, `TRIGGER:-PT${Math.round(ev.alarmMinutes)}M`, 'END:VALARM');
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// 일정 색 (애플 캘린더 앱은 '캘린더 색'만 쓰므로 아이폰에는 캘린더 색으로 보입니다)
const COLOR_NAMES = {
  '#ff3b30': 'tomato', '#ff9500': 'darkorange', '#ffcc00': 'gold', '#34c759': 'limegreen',
  '#0a84ff': 'dodgerblue', '#af52de': 'mediumorchid', '#ff2d55': 'deeppink', '#a2845e': 'peru',
};
function colorLines(color) {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return [];
  const c = color.toLowerCase();
  const out = [`X-DESKCAL-COLOR:${c}`];
  if (COLOR_NAMES[c]) out.push(`COLOR:${COLOR_NAMES[c]}`);
  return out;
}

// ---------- 일정 수정 ----------
// 원본을 줄 단위로 고쳐서, 알림·참석자 등 이 프로그램이 모르는 정보는 그대로 둡니다
function unfoldLines(text) {
  return text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter((l) => l.length);
}
const keyOfLine = (l) => l.split(/[;:]/)[0].toUpperCase();

function patchIcs(original, ev) {
  const lines = unfoldLines(original);
  const begin = lines.findIndex((l) => l.toUpperCase() === 'BEGIN:VEVENT');
  if (begin < 0) throw new Error('일정 내용을 읽지 못했습니다');
  let end = begin + 1;
  let depth = 0;
  for (; end < lines.length; end++) {
    const u = lines[end].toUpperCase();
    if (u.startsWith('BEGIN:')) depth++;
    else if (u.startsWith('END:')) { if (depth === 0) break; depth--; }
  }
  const body = lines.slice(begin + 1, end);
  const REPLACE = new Set(['DTSTART', 'DTEND', 'DURATION', 'SUMMARY', 'LOCATION', 'DESCRIPTION', 'X-DESKCAL-COLOR', 'COLOR', 'DTSTAMP', 'LAST-MODIFIED', 'SEQUENCE']);
  const kept = [];
  let seq = 0;
  let inAlarm = false;
  for (const l of body) {
    const u = l.toUpperCase();
    if (u === 'BEGIN:VALARM') inAlarm = true;
    if (inAlarm) {
      if (ev.alarmMinutes === undefined) kept.push(l); // 알림은 바꾸지 않으면 그대로
      if (u === 'END:VALARM') inAlarm = false;
      continue;
    }
    const k = keyOfLine(l);
    if (k === 'SEQUENCE') seq = Number(l.split(':')[1]) || 0;
    if (!REPLACE.has(k)) kept.push(l);
  }
  const now = utcStamp(new Date());
  const add = [`DTSTAMP:${now}`, `LAST-MODIFIED:${now}`, `SEQUENCE:${seq + 1}`];
  if (ev.allDay) {
    add.push(`DTSTART;VALUE=DATE:${dateOnly(ev.startDay)}`, `DTEND;VALUE=DATE:${dateOnly(nextDayKey(ev.endDay || ev.startDay))}`);
  } else {
    add.push(`DTSTART:${utcStamp(new Date(ev.start))}`, `DTEND:${utcStamp(new Date(ev.end))}`);
  }
  add.push(`SUMMARY:${icsEscape(ev.title)}`);
  if (ev.location) add.push(`LOCATION:${icsEscape(ev.location)}`);
  if (ev.notes) add.push(`DESCRIPTION:${icsEscape(ev.notes)}`);
  add.push(...colorLines(ev.color));
  if (ev.alarmMinutes != null && ev.alarmMinutes >= 0) {
    add.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(ev.title)}`, `TRIGGER:-PT${Math.round(ev.alarmMinutes)}M`, 'END:VALARM');
  }
  const out = [...lines.slice(0, begin + 1), ...kept, ...add, ...lines.slice(end)];
  return out.map(fold).join('\r\n') + '\r\n';
}

async function updateEvent(objUrl, ev) {
  if (!client) throw new Error('아이클라우드에 연결되어 있지 않습니다');
  validate(ev);
  const raw = rawMap.get(objUrl);
  if (!raw) throw new Error('일정 정보를 다시 불러온 뒤 시도해 주세요');
  const data = patchIcs(raw.data, { ...ev, title: String(ev.title).trim() });
  const res = await client.updateCalendarObject({ calendarObject: { url: objUrl, data, etag: raw.etag } });
  if (res && res.status === 412) throw new Error('그사이 아이폰에서 이 일정이 바뀌었습니다. 새로고침 후 다시 시도해 주세요');
  if (res && res.ok === false) throw new Error(`수정하지 못했습니다 (${res.status})`);
  rawMap.delete(objUrl);
}

function validate(ev) {
  if (!ev || !String(ev.title || '').trim()) throw new Error('일정 제목을 입력해 주세요');
  const keyRe = /^\d{4}-\d{2}-\d{2}$/;
  if (ev.allDay) {
    if (!keyRe.test(ev.startDay)) throw new Error('날짜가 올바르지 않습니다');
    if (ev.endDay && (!keyRe.test(ev.endDay) || ev.endDay < ev.startDay)) throw new Error('끝 날짜가 시작 날짜보다 빠릅니다');
  } else {
    const s = new Date(ev.start);
    const e = new Date(ev.end);
    if (isNaN(s) || isNaN(e)) throw new Error('시간이 올바르지 않습니다');
    if (e <= s) throw new Error('끝 시간이 시작 시간보다 빠릅니다');
  }
}

async function createEvent(calUrl, ev) {
  const cal = calMap.get(calUrl);
  if (!client || !cal) throw new Error('아이클라우드에 연결되어 있지 않습니다');
  validate(ev);
  const uid = `${crypto.randomUUID().toUpperCase()}`;
  const res = await client.createCalendarObject({
    calendar: cal,
    filename: `${uid}.ics`,
    iCalString: buildIcs({ ...ev, title: String(ev.title).trim() }, uid),
  });
  if (res && res.ok === false) throw new Error(`저장하지 못했습니다 (${res.status})`);
  return { uid };
}

async function deleteEvent(objUrl, etag) {
  if (!client) throw new Error('아이클라우드에 연결되어 있지 않습니다');
  const res = await client.deleteCalendarObject({ calendarObject: { url: objUrl, etag } });
  if (res && res.status === 412) throw new Error('그사이 아이폰에서 이 일정이 바뀌었습니다. 새로고침 후 다시 시도해 주세요');
  if (res && res.ok === false && res.status !== 404) throw new Error(`삭제하지 못했습니다 (${res.status})`);
}

// ---------- 월별 메모 ----------
const memoObjs = new Map(); // '2026-10' → { url, etag }

// 메모 캘린더가 없으면 하나 만들기 (처음 메모를 저장할 때 한 번)
async function ensureMemoCal() {
  if (!client) throw new Error('아이클라우드에 연결되어 있지 않습니다');
  if (memoCal) return memoCal;
  if (!homeUrl) throw new Error('메모 캘린더를 만들 위치를 찾지 못했습니다');
  const url = `${homeUrl}${memo.MEMO_CAL_SLUG}/`;
  let res;
  try {
    res = await client.makeCalendar({
      url,
      props: {
        'd:displayname': memo.MEMO_CAL_NAME,
        'ca:calendar-color': '#8e8e93',
        'c:supported-calendar-component-set': { 'c:comp': { _attributes: { name: 'VEVENT' } } },
      },
    });
  } catch (e) {
    throw friendly(e);
  }
  const r = Array.isArray(res) ? res[0] : res;
  const status = r && (r.status || (r.raw && r.raw.status));
  // 405 = 이미 있음 (다른 PC에서 먼저 만든 경우)
  if (status && status >= 400 && status !== 405) throw new Error(`메모 캘린더를 만들지 못했습니다 (${status})`);
  const all = await client.fetchCalendars();
  memoCal = (all || []).find(isMemoCal) || null;
  if (!memoCal) throw new Error('메모 캘린더를 만들지 못했습니다');
  return memoCal;
}

function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1) - 36 * 3600e3), end: new Date(Date.UTC(y, m - 1, 2) + 36 * 3600e3) };
}

// 그달 메모 가져오기 → { text, updatedAt } 또는 null (아직 없음)
async function fetchMemo(month) {
  if (!client) throw new Error('아이클라우드에 연결되어 있지 않습니다');
  if (!memo.isMonthKey(month)) throw new Error('달이 올바르지 않습니다');
  if (!memoCal) return null; // 메모 캘린더가 아직 없으면 메모도 없음
  const { start, end } = monthRange(month);
  let objects;
  try {
    objects = await client.fetchCalendarObjects({ calendar: memoCal, timeRange: { start: start.toISOString(), end: end.toISOString() } });
  } catch (e) {
    throw friendly(e);
  }
  let found = null;
  for (const obj of objects || []) {
    const p = obj && obj.data ? memo.parseMemoIcs(obj.data) : null;
    if (!p || p.month !== month) continue;
    if (!found || p.updatedAt > found.updatedAt) found = { ...p, url: obj.url, etag: obj.etag || '' };
  }
  if (found) memoObjs.set(month, { url: found.url, etag: found.etag });
  else memoObjs.delete(month);
  return found ? { text: found.text, updatedAt: found.updatedAt } : null;
}

// 그달 메모 저장 (빈 메모면 지움)
async function saveMemo(month, text, updatedAt) {
  if (!memo.isMonthKey(month)) throw new Error('달이 올바르지 않습니다');
  const empty = !String(text || '').trim();
  if (empty && !memoCal) return;
  const cal = await ensureMemoCal();
  if (!memoObjs.has(month)) await fetchMemo(month);
  const attempt = async () => {
    const known = memoObjs.get(month);
    if (empty) {
      if (!known) return { ok: true };
      const res = await client.deleteCalendarObject({ calendarObject: { url: known.url, etag: known.etag } });
      if (res && res.ok === false && res.status !== 404) return res;
      memoObjs.delete(month);
      return { ok: true };
    }
    const data = memo.buildMemoIcs(month, text, updatedAt);
    if (known) return client.updateCalendarObject({ calendarObject: { url: known.url, data, etag: known.etag } });
    return client.createCalendarObject({ calendar: cal, filename: memo.memoFileName(month), iCalString: data });
  };
  let res = await attempt();
  if (res && res.status === 412) {
    // 그사이 다른 기기에서 바뀌었으면 최신 정보를 받아서 한 번 더 (지금 쓰는 내용이 이김)
    await fetchMemo(month);
    res = await attempt();
  }
  if (res && res.ok === false) throw new Error(`메모를 아이클라우드에 저장하지 못했습니다 (${res.status})`);
  if (!empty) {
    const etag = (res && res.headers && typeof res.headers.get === 'function' && res.headers.get('etag')) || '';
    const prev = memoObjs.get(month);
    const url = prev ? prev.url : `${cal.url}${memo.memoFileName(month)}`;
    memoObjs.set(month, { url, etag });
    if (!etag) memoObjs.delete(month); // etag를 모르면 다음 저장 전에 새로 확인
  }
}

module.exports = {
  fetchMemo,
  saveMemo, _icloudFetch: icloudFetch, patchIcs, updateEvent, connect, disconnect, isConnected, fetchEvents, createEvent, deleteEvent, buildIcs, connectedAs: () => connectedAs };
