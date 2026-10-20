// 구글 캘린더 연결 (구글 로그인 + 일정 읽기·쓰기)
// 데스크톱 앱 표준 방식: 기본 브라우저에서 로그인 → 이 PC의 임시 주소(127.0.0.1)로 결과를 받음
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/calendar/v3';
const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

let client = null; // { client_id, client_secret }
function loadClient() {
  if (client) return client;
  const file = path.join(__dirname, 'google-client.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!j.client_id || !j.client_secret) throw new Error('이 버전에는 구글 연결 정보가 들어 있지 않습니다. 최신 설치 파일을 받아 주세요');
  client = { client_id: j.client_id, client_secret: j.client_secret };
  return client;
}
// 테스트용: 주소 바꾸기
let endpoints = { AUTH_URL, TOKEN_URL, REVOKE_URL, API };
function _setEndpoints(e) { endpoints = { ...endpoints, ...e }; }

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---------- 일정 색: DeskCal 8색 ↔ 구글 일정 색 번호 ----------
const TO_GOOGLE = {
  '#ff3b30': '11', '#ff9500': '6', '#ffcc00': '5', '#34c759': '2',
  '#0a84ff': '7', '#af52de': '3', '#ff2d55': '4', '#a2845e': '8',
};
const FROM_GOOGLE = {
  11: '#ff3b30', 6: '#ff9500', 5: '#ffcc00', 2: '#34c759', 7: '#0a84ff', 3: '#af52de', 4: '#ff2d55', 8: '#a2845e',
  1: '#7986cb', 9: '#3f51b5', 10: '#0b8043',
};

// ---------- 로그인 ----------
let pendingLogin = null;

function page(title, body) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:'Malgun Gothic',system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0;background:#f6f6f3;color:#1b1c1f">
<div style="text-align:center"><div style="font-size:42px">${title.startsWith('로그인 완료') ? '✅' : '⚠️'}</div>
<h2 style="margin:8px 0">${title}</h2><p style="color:#6c6e74">${body}</p></div></body>`;
}

// openBrowser(url): 기본 브라우저로 주소 열기 (main에서 shell.openExternal 전달)
function login(openBrowser, { timeoutMs = 5 * 60 * 1000 } = {}) {
  if (pendingLogin) pendingLogin.cancel('새 로그인을 시작했습니다');
  const { client_id, client_secret } = loadClient();
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  return new Promise((resolve, reject) => {
    let done = false;
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/') { res.writeHead(404); res.end(); return; }
      const err = u.searchParams.get('error');
      const code = u.searchParams.get('code');
      if (u.searchParams.get('state') !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('잘못된 요청', 'DeskCal에서 다시 로그인해 주세요.'));
        return;
      }
      if (err || !code) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('로그인이 취소되었습니다', 'DeskCal로 돌아가 다시 시도할 수 있습니다.'));
        finish(new Error(err === 'access_denied' ? '구글 로그인을 취소했습니다' : '구글 로그인에 실패했습니다'));
        return;
      }
      try {
        const redirect_uri = `http://127.0.0.1:${server.address().port}`;
        const tok = await postForm(endpoints.TOKEN_URL, {
          code, client_id, client_secret, redirect_uri, grant_type: 'authorization_code', code_verifier: verifier,
        });
        if (!tok.refresh_token) throw new Error('구글에서 로그인 유지 정보를 받지 못했습니다. 다시 시도해 주세요');
        const email = emailFromIdToken(tok.id_token);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('로그인 완료!', '이 창을 닫고 DeskCal로 돌아가세요.'));
        finish(null, { email, refreshToken: tok.refresh_token, accessToken: tok.access_token, expiresIn: tok.expires_in });
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('로그인에 실패했습니다', String(e.message || e)));
        finish(e);
      }
    });
    const timer = setTimeout(() => finish(new Error('로그인 시간이 지났습니다. 다시 시도해 주세요')), timeoutMs);
    function finish(e, v) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pendingLogin = null;
      setTimeout(() => server.close(), 500);
      if (e) reject(e);
      else resolve(v);
    }
    pendingLogin = { cancel: (msg) => finish(new Error(msg)) };
    server.listen(0, '127.0.0.1', () => {
      const redirect_uri = `http://127.0.0.1:${server.address().port}`;
      const q = new URLSearchParams({
        client_id, redirect_uri, response_type: 'code', scope: SCOPES.join(' '),
        code_challenge: challenge, code_challenge_method: 'S256', state,
        access_type: 'offline', prompt: 'consent',
      });
      openBrowser(`${endpoints.AUTH_URL}?${q}`);
    });
    server.on('error', (e) => finish(e));
  });
}

function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64').toString('utf8'));
    return payload.email || '';
  } catch {
    return '';
  }
}

async function postForm(url, data) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(data).toString(),
    signal: AbortSignal.timeout(20000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(j.error === 'invalid_grant' ? '구글 연결이 끊어졌습니다. 설정에서 다시 로그인해 주세요' : `구글 오류 (${j.error || res.status})`);
    e.code = j.error;
    throw e;
  }
  return j;
}

// ---------- 접속 정보 관리 ----------
// session: { refreshToken, accessToken, expiresAt }
let session = null;
function setSession(refreshToken, accessToken, expiresIn) {
  session = { refreshToken, accessToken: accessToken || null, expiresAt: accessToken ? Date.now() + (expiresIn - 60) * 1000 : 0 };
}
function clearSession() { session = null; }
function hasSession() { return !!(session && session.refreshToken); }

async function accessToken() {
  if (!hasSession()) throw new Error('구글에 로그인되어 있지 않습니다');
  if (session.accessToken && Date.now() < session.expiresAt) return session.accessToken;
  const { client_id, client_secret } = loadClient();
  const tok = await postForm(endpoints.TOKEN_URL, {
    client_id, client_secret, refresh_token: session.refreshToken, grant_type: 'refresh_token',
  });
  session.accessToken = tok.access_token;
  session.expiresAt = Date.now() + ((tok.expires_in || 3600) - 60) * 1000;
  return session.accessToken;
}

async function api(method, pathAndQuery, body) {
  const doCall = async () => {
    const t = await accessToken();
    return fetch(`${endpoints.API}${pathAndQuery}`, {
      method,
      headers: { Authorization: `Bearer ${t}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  };
  let res;
  try {
    res = await doCall();
    if (res.status === 401 && session) {
      session.accessToken = null; // 만료됐으면 한 번 새로 받아서 재시도
      res = await doCall();
    }
  } catch (e) {
    if (e && e.code) throw e;
    throw new Error('인터넷 연결을 확인해 주세요');
  }
  if (res.status === 204) return null;
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 412) throw new Error('그사이 다른 곳에서 이 일정이 바뀌었습니다. 새로고침 후 다시 시도해 주세요');
    if (res.status === 403) throw new Error('이 캘린더에 쓸 권한이 없습니다');
    if (res.status === 404 || res.status === 410) {
      const e = new Error('일정을 찾을 수 없습니다 (이미 지워졌을 수 있어요)');
      e.status = res.status;
      throw e;
    }
    throw new Error(`구글 캘린더 오류 (${(j.error && j.error.message) || res.status})`);
  }
  return j;
}

// ---------- 캘린더 목록 ----------
async function listCalendars() {
  const out = [];
  let pageToken = '';
  do {
    const j = await api('GET', `/users/me/calendarList?maxResults=250${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
    for (const c of j.items || []) {
      if (c.deleted) continue;
      out.push({
        id: c.id,
        name: c.summaryOverride || c.summary || '캘린더',
        color: /^#[0-9a-f]{6}$/i.test(c.backgroundColor) ? c.backgroundColor.toLowerCase() : '#4285f4',
        writable: c.accessRole === 'owner' || c.accessRole === 'writer',
        primary: !!c.primary,
        holiday: /#holiday@group\.v\.calendar\.google\.com$/.test(c.id),
      });
    }
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  out.sort((a, b) => (b.primary - a.primary) || (b.writable - a.writable) || a.name.localeCompare(b.name, 'ko'));
  return out;
}

// ---------- 일정 읽기 ----------
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function prevDayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d - 1));
}
function nextDayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + 1));
}

function toEvent(it, calId, writable) {
  const allDay = !!(it.start && it.start.date);
  const base = {
    title: it.summary || '(제목 없음)',
    allDay,
    location: it.location || '',
    notes: it.description || '',
    uid: it.id,
    ownColor: FROM_GOOGLE[it.colorId] || '',
    recurring: !!(it.recurringEventId || it.recurrence),
    objUrl: `g:${calId}|${it.id}`,
    etag: it.etag || '',
    editable: writable,
    hasAlarm: !!(it.reminders && (it.reminders.useDefault || (it.reminders.overrides || []).length)),
  };
  if (allDay) {
    const s = it.start.date;
    let e = it.end && it.end.date ? prevDayKey(it.end.date) : s;
    if (e < s) e = s;
    return { ...base, startDay: s, endDay: e };
  }
  const s = new Date(it.start.dateTime);
  const e = it.end && it.end.dateTime ? new Date(it.end.dateTime) : new Date(s.getTime());
  const endForDay = new Date(Math.max(s.getTime(), e.getTime() - 1));
  return { ...base, start: s.toISOString(), end: e.toISOString(), startDay: dayKey(s), endDay: dayKey(endForDay) };
}

async function fetchEvents(calId, from, to, writable) {
  const out = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({
      timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true',
      orderBy: 'startTime', maxResults: '2500',
    });
    if (pageToken) q.set('pageToken', pageToken);
    const j = await api('GET', `/calendars/${encodeURIComponent(calId)}/events?${q}`);
    for (const it of j.items || []) {
      if (it.status === 'cancelled' || !it.start) continue;
      out.push(toEvent(it, calId, writable));
    }
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return out;
}

// ---------- 일정 쓰기 ----------
function toGoogleBody(ev, { isNew }) {
  const body = {
    summary: String(ev.title || '').trim(),
    location: ev.location || '',
    description: ev.notes || '',
  };
  if (ev.allDay) {
    body.start = { date: ev.startDay };
    body.end = { date: nextDayKey(ev.endDay || ev.startDay) };
  } else {
    body.start = { dateTime: new Date(ev.start).toISOString() };
    body.end = { dateTime: new Date(ev.end).toISOString() };
  }
  // 색: 비워 두면 캘린더 색 (수정할 때 지우려면 빈 값으로)
  if (ev.color && TO_GOOGLE[ev.color]) body.colorId = TO_GOOGLE[ev.color];
  else if (!isNew) body.colorId = null;
  // 알림: 생략=그대로(새 일정은 구글 기본값), null=없음, 숫자=그 시간 전
  if (ev.alarmMinutes === null) body.reminders = { useDefault: false, overrides: [] };
  else if (typeof ev.alarmMinutes === 'number' && ev.alarmMinutes >= 0) {
    body.reminders = { useDefault: false, overrides: [{ method: 'popup', minutes: Math.round(ev.alarmMinutes) }] };
  }
  return body;
}

function validate(ev) {
  if (!ev || !String(ev.title || '').trim()) throw new Error('일정 제목을 입력해 주세요');
  if (ev.allDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.startDay)) throw new Error('날짜가 올바르지 않습니다');
    if (ev.endDay && ev.endDay < ev.startDay) throw new Error('끝 날짜가 시작 날짜보다 빠릅니다');
  } else if (!(new Date(ev.end) > new Date(ev.start))) {
    throw new Error('끝 시간이 시작 시간보다 빠릅니다');
  }
}

function splitObj(objUrl) {
  const s = String(objUrl).replace(/^g:/, '');
  const i = s.lastIndexOf('|');
  return { calId: s.slice(0, i), eventId: s.slice(i + 1) };
}

async function createEvent(calId, ev) {
  validate(ev);
  const j = await api('POST', `/calendars/${encodeURIComponent(calId)}/events`, toGoogleBody(ev, { isNew: true }));
  return { uid: j.id };
}

async function updateEvent(objUrl, ev) {
  validate(ev);
  const { calId, eventId } = splitObj(objUrl);
  await api('PATCH', `/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`, toGoogleBody(ev, { isNew: false }));
}

async function deleteEvent(objUrl) {
  const { calId, eventId } = splitObj(objUrl);
  try {
    await api('DELETE', `/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`);
  } catch (e) {
    if (e.status === 404 || e.status === 410) return; // 이미 지워짐
    throw e;
  }
}

async function revoke(refreshToken) {
  try {
    await fetch(`${endpoints.REVOKE_URL}?token=${encodeURIComponent(refreshToken)}`, {
      method: 'POST', signal: AbortSignal.timeout(10000),
    });
  } catch {
    // 인터넷이 안 되어도 이 PC에서는 지움
  }
}

module.exports = {
  login, setSession, clearSession, hasSession, listCalendars, fetchEvents,
  createEvent, updateEvent, deleteEvent, revoke, TO_GOOGLE, FROM_GOOGLE, _setEndpoints, _toGoogleBody: toGoogleBody, _toEvent: toEvent,
};
