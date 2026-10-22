// 프로그램 본체: 바탕화면 위젯 창을 띄우고, 설정 저장과 일정 가져오기를 담당
const { app, BrowserWindow, ipcMain, Tray, Menu, shell, nativeImage, screen, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { downloadIcs, extractEvents, normalizeUrl } = require('./calendar');
const icloud = require('./icloud');
const google = require('./google');
const memo = require('./memo');
const os = require('os');

const IS_MAC = process.platform === 'darwin';

// 윈도우 11(22H2 이상)이면 뒤가 흐리게 비치는 효과(아크릴) 사용
let useAcrylic = false;
function acrylicSupported() {
  if (IS_MAC) return true; // 맥은 기본으로 흐림 효과(비브런시) 지원
  if (process.platform !== 'win32') return false;
  const build = Number(String(os.release()).split('.')[2] || 0);
  return build >= 22621;
}

const HOLIDAY_URL =
  'https://calendar.google.com/calendar/ical/ko.south_korea%23holiday%40group.v.calendar.google.com/public/basic.ics';

const DEFAULT_CONFIG = {
  calendars: [
    { id: 'kr-holiday', name: '대한민국 공휴일', url: HOLIDAY_URL, color: '#ff5a5f', holiday: true, enabled: true },
  ],
  alwaysOnTop: false,
  autoStart: false,
  opacity: 0.92,
  theme: 'auto',
  showTerms: true,
  showLunar: false,
  eventColors: {},
  uiVersion: 4,
  style: 'glass', // 'glass' = 물방울 유리(리퀴드 글래스), 'basic' = 기본
  weekStart: 0, // 0 = 일요일 시작, 1 = 월요일 시작
  bounds: null,
  // 아이클라우드 계정: { appleId, passwordEnc, calendars:[{url,name,color,enabled}], defaultCal }
  icloud: null,
  // 구글 계정: { email, tokenEnc, calendars:[{id,name,color,writable,primary,enabled}] }
  google: null,
  // 새 일정 기본 캘린더 (아이클라우드 주소 또는 'g:구글캘린더ID')
  defaultCal: '',
  // 달력 아래 메모칸
  showMemo: true,
  memoHeight: 40, // 메모칸 높이(px) — 기본은 한 줄
  memoSync: true, // 아이클라우드가 연결돼 있으면 메모도 아이클라우드에 저장
};

const dataDir = () => app.getPath('userData');
const configPath = () => path.join(dataDir(), 'config.json');
const cachePath = () => path.join(dataDir(), 'cache.json');
const memosPath = () => path.join(dataDir(), 'memos.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  } catch (e) {
    console.error('저장 실패', file, e);
  }
}

let config;
let cache; // { [url]: { text, fetchedAt } } — 인터넷이 끊겨도 마지막 일정을 보여 주기 위함
let win;
let tray;

function loadConfig() {
  const saved = readJson(configPath(), {});
  config = { ...DEFAULT_CONFIG, ...saved };
  // 새 화면(2판)으로 처음 바뀔 때는 유리 테마와 새 기본 크기로
  if ((saved.uiVersion || 1) < 3) {
    config.theme = 'auto';
    if ((saved.uiVersion || 1) < 2) config.bounds = null;
    config.opacity = 1;
    config.uiVersion = 3;
    writeJson(configPath(), config);
  }
  // 0.9: 물방울 유리 디자인을 켜고, 메모칸은 한 줄로
  if ((saved.uiVersion || 1) < 4) {
    config.style = 'glass';
    config.blur = true;
    config.memoHeight = 40;
    config.uiVersion = 4;
    writeJson(configPath(), config);
  }
  if (!Array.isArray(config.calendars)) config.calendars = DEFAULT_CONFIG.calendars;
  cache = readJson(cachePath(), {});
  memos = readJson(memosPath(), {});
  if (!memos || typeof memos !== 'object' || Array.isArray(memos)) memos = {};
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  config.bounds = win.getBounds();
  writeJson(configPath(), config);
}

function boundsAreVisible(b) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x + 40 < a.x + a.width && b.x + b.width - 40 > a.x && b.y >= a.y - 10 && b.y + 40 < a.y + a.height;
  });
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const dw = Math.min(760, area.width - 40);
  const dh = Math.min(620, area.height - 40);
  const defaults = { width: dw, height: dh, x: area.x + area.width - dw - 20, y: area.y + 20 };
  const b = config.bounds && boundsAreVisible(config.bounds) ? config.bounds : defaults;

  let look;
  if (useAcrylic && IS_MAC) look = { transparent: true, vibrancy: 'under-window', visualEffectState: 'active', backgroundColor: '#00000000', roundedCorners: true };
  else if (useAcrylic) look = { transparent: false, backgroundMaterial: 'acrylic', backgroundColor: '#00000000', roundedCorners: true };
  else look = { transparent: true, backgroundColor: '#00000000' };
  win = new BrowserWindow({
    ...b,
    minWidth: 480,
    minHeight: 380,
    frame: false,
    ...look,
    hasShadow: !IS_MAC || useAcrylic,
    resizable: false, // 평소에는 잠금 (위치·크기 조정 모드에서만 풀림)
    movable: true,
    skipTaskbar: true, // 작업표시줄에 안 보이게 (트레이 아이콘으로 관리)
    alwaysOnTop: !!config.alwaysOnTop,
    show: false,
    title: 'DeskCal',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setOpacity(Number(config.opacity) || 1);
  // 맥: 모든 데스크탑(스페이스)에 보이게
  if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());

  let t;
  const later = () => {
    clearTimeout(t);
    t = setTimeout(saveBounds, 500);
  };
  win.on('move', later);
  win.on('resize', later);

  // 링크는 위젯 안이 아니라 기본 브라우저로 열기
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function createTray() {
  let img;
  if (IS_MAC) {
    // 맥 메뉴 막대용 흑백 아이콘 (밝은·어두운 메뉴 막대에 맞춰 자동으로 색이 바뀜)
    img = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'trayTemplate.png'));
    if (img.isEmpty()) img = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png')).resize({ width: 16, height: 16 });
    else img.setTemplateImage(true);
  } else {
    img = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png')).resize({ width: 16, height: 16 });
  }
  tray = new Tray(img);
  tray.setToolTip('DeskCal 달력');
  const rebuild = () =>
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '달력 보이기', click: () => { win.show(); win.focus(); } },
        { label: '설정', click: () => { win.show(); win.webContents.send('open-settings'); } },
        { label: '새로고침', click: () => win.webContents.send('refresh') },
        { label: '일정 검색', click: () => { win.show(); win.focus(); win.webContents.send('open-search'); } },
        { label: '업데이트 확인', click: () => { win.show(); checkUpdate(true); } },
        { type: 'separator' },
        {
          label: '항상 위에 표시',
          type: 'checkbox',
          checked: !!config.alwaysOnTop,
          click: (item) => applySettings({ alwaysOnTop: item.checked }),
        },
        { label: '위치·크기 조정', click: () => { win.show(); win.focus(); win.webContents.send('start-arrange'); } },
        {
          label: '크기',
          submenu: [
            ['작게', 560, 460],
            ['보통', 760, 620],
            ['크게', 980, 780],
            ['아주 크게', 1200, 960],
          ].map(([label, w, h]) => ({ label, click: () => { const r = win.isResizable(); const b = win.getBounds(); win.setResizable(true); win.setBounds({ x: b.x, y: b.y, width: w, height: h }); win.setResizable(r); saveBounds(); } })),
        },
        { label: '위치 초기화', click: () => { config.bounds = null; const r = win.isResizable(); win.setResizable(true); win.setBounds({ width: 760, height: 620 }); win.center(); win.setResizable(r); saveBounds(); } },
        { type: 'separator' },
        { label: '종료', click: () => app.quit() },
      ])
    );
  rebuild();
  if (!IS_MAC) tray.on('click', () => { win.show(); win.focus(); }); // 맥은 누르면 메뉴가 열림
  return rebuild;
}

let rebuildTrayMenu = () => {};

function applySettings(patch) {
  config = { ...config, ...patch };
  if (win) {
    win.setAlwaysOnTop(!!config.alwaysOnTop);
    win.setOpacity(Math.min(1, Math.max(0.3, Number(config.opacity) || 1)));
  }
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: !!config.autoStart });
  }
  writeJson(configPath(), config);
  rebuildTrayMenu();
  if (win) win.webContents.send('config-changed', publicConfig());
  return publicConfig();
}

function publicConfig() {
  const { bounds, icloud: ic, google: g, eventColors, ...rest } = config;
  const icPublic = ic
    ? { appleId: ic.appleId, calendars: ic.calendars || [], defaultCal: ic.defaultCal || '' }
    : null;
  const gPublic = g ? { email: g.email, calendars: g.calendars || [] } : null;
  return { ...rest, platform: process.platform, icloud: icPublic, google: gPublic, defaultCal: currentDefaultCal(), isPackaged: app.isPackaged, blurPref: config.blur !== false, blurAvailable: acrylicSupported(), blurActive: useAcrylic };
}

// ---------- 아이클라우드 ----------
// 암호는 윈도우 계정 잠금(DPAPI)으로 암호화해서 이 PC에만 저장
function encryptPw(pw) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('이 PC에서는 암호를 안전하게 저장할 수 없습니다');
  return safeStorage.encryptString(pw).toString('base64');
}
function decryptPw(enc) {
  return safeStorage.decryptString(Buffer.from(enc, 'base64'));
}

let icloudConnecting = null;
async function ensureIcloud() {
  if (icloud.isConnected()) return true;
  const ic = config.icloud;
  if (!ic || !ic.passwordEnc) return false;
  if (!icloudConnecting) {
    icloudConnecting = (async () => {
      const fresh = await icloud.connect(ic.appleId, decryptPw(ic.passwordEnc));
      // 아이폰에서 캘린더 이름·색을 바꿨을 수 있으니 반영 (표시 여부는 유지)
      const prev = new Map((ic.calendars || []).map((c) => [c.url, c]));
      ic.calendars = fresh.map((c) => ({ ...c, enabled: prev.has(c.url) ? prev.get(c.url).enabled !== false : true }));
      if (!ic.calendars.some((c) => c.url === ic.defaultCal)) ic.defaultCal = ic.calendars[0]?.url || '';
      writeJson(configPath(), config);
    })().finally(() => { icloudConnecting = null; });
  }
  await icloudConnecting;
  return true;
}

ipcMain.handle('icloud:connect', async (_e, { appleId, password }) => {
  appleId = String(appleId || '').trim();
  password = String(password || '').replace(/\s+/g, '');
  if (!appleId || !password) throw new Error('애플 ID와 앱 전용 암호를 모두 입력해 주세요');
  icloud.disconnect();
  const cals = await icloud.connect(appleId, password);
  config.icloud = {
    appleId,
    passwordEnc: encryptPw(password),
    calendars: cals.map((c) => ({ ...c, enabled: true })),
    defaultCal: cals[0].url,
  };
  // 예전에 '공개 링크'로 넣은 아이클라우드 캘린더는 중복되니 숨김
  config.calendars = config.calendars.map((c) => (/icloud\.com/i.test(c.url) ? { ...c, enabled: false } : c));
  icCache.clear();
  return applySettings({});
});

ipcMain.handle('icloud:disconnect', () => {
  icloud.disconnect();
  config.icloud = null;
  icCache.clear();
  dropSearch();
  return applySettings({});
});

ipcMain.handle('icloud:update', (_e, patch) => {
  const ic = config.icloud;
  if (!ic) return publicConfig();
  if (patch && typeof patch.defaultCal === 'string' && ic.calendars.some((c) => c.url === patch.defaultCal)) {
    ic.defaultCal = patch.defaultCal;
  }
  if (patch && patch.toggle && typeof patch.toggle.url === 'string') {
    ic.calendars = ic.calendars.map((c) => (c.url === patch.toggle.url ? { ...c, enabled: !!patch.toggle.enabled } : c));
  }
  return applySettings({});
});

// 일정 색은 일정 안에도 저장하지만, 아이클라우드가 지울 경우를 대비해 이 PC에도 기억
function rememberColor(uid, color) {
  if (!uid) return;
  config.eventColors = config.eventColors || {};
  if (color && /^#[0-9a-f]{6}$/i.test(color)) config.eventColors[uid] = color.toLowerCase();
  else delete config.eventColors[uid];
  const keys = Object.keys(config.eventColors);
  if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete config.eventColors[k];
  writeJson(configPath(), config);
}

const isGoogle = (s) => typeof s === 'string' && s.startsWith('g:');

ipcMain.handle('event:create', async (_e, { calUrl, event }) => {
  const target = calUrl || currentDefaultCal();
  if (isGoogle(target)) {
    if (!ensureGoogle()) throw new Error('먼저 설정에서 구글 계정으로 로그인해 주세요');
    await google.createEvent(target.slice(2), event); // 구글은 일정 색을 구글 쪽에 저장
    gCache.clear();
    dropSearch();
    return true;
  }
  if (!(await ensureIcloud())) throw new Error('먼저 설정에서 캘린더 계정을 연결해 주세요');
  const { uid } = await icloud.createEvent(target || config.icloud.defaultCal, event);
  rememberColor(uid, event && event.color);
  icCache.clear();
  dropSearch();
  return true;
});

ipcMain.handle('event:update', async (_e, { objUrl, uid, event }) => {
  if (isGoogle(objUrl)) {
    if (!ensureGoogle()) throw new Error('구글에 로그인되어 있지 않습니다');
    await google.updateEvent(objUrl, event);
    gCache.clear();
    dropSearch();
    return true;
  }
  if (!(await ensureIcloud())) throw new Error('아이클라우드에 연결되어 있지 않습니다');
  await icloud.updateEvent(objUrl, event);
  rememberColor(uid, event && event.color);
  icCache.clear();
  dropSearch();
  return true;
});

ipcMain.handle('event:delete', async (_e, { objUrl, etag }) => {
  if (isGoogle(objUrl)) {
    if (!ensureGoogle()) throw new Error('구글에 로그인되어 있지 않습니다');
    await google.deleteEvent(objUrl);
    gCache.clear();
    dropSearch();
    return true;
  }
  if (!(await ensureIcloud())) throw new Error('아이클라우드에 연결되어 있지 않습니다');
  await icloud.deleteEvent(objUrl, etag);
  icCache.clear();
  dropSearch();
  return true;
});

// ---------- 구글 ----------
const gCache = new Map();
function ensureGoogle() {
  const g = config.google;
  if (!g || !g.tokenEnc) return false;
  if (!google.hasSession()) google.setSession(decryptPw(g.tokenEnc));
  return true;
}

// 새 일정의 기본 캘린더: 저장된 값이 아직 쓸 수 있는 캘린더인지 확인
function writableCals() {
  const list = [];
  if (config.icloud) for (const c of config.icloud.calendars || []) list.push(c.url);
  if (config.google) for (const c of config.google.calendars || []) if (c.writable) list.push(`g:${c.id}`);
  return list;
}
function currentDefaultCal() {
  const list = writableCals();
  if (config.defaultCal && list.includes(config.defaultCal)) return config.defaultCal;
  if (config.icloud && list.includes(config.icloud.defaultCal)) return config.icloud.defaultCal;
  const gp = config.google && (config.google.calendars || []).find((c) => c.primary && c.writable);
  if (gp) return `g:${gp.id}`;
  return list[0] || '';
}

let googleLoginBusy = false;
ipcMain.handle('google:login', async () => {
  if (googleLoginBusy) throw new Error('구글 로그인 창이 이미 열려 있습니다. 브라우저를 확인해 주세요');
  googleLoginBusy = true;
  try {
    const r = await google.login((url) => shell.openExternal(url));
    google.setSession(r.refreshToken, r.accessToken, r.expiresIn);
    const cals = await google.listCalendars();
    const prev = new Map(((config.google && config.google.calendars) || []).map((c) => [c.id, c]));
    config.google = {
      email: r.email,
      tokenEnc: encryptPw(r.refreshToken),
      // 구글의 '대한민국의 휴일' 캘린더는 기본 공휴일과 겹치니 처음엔 숨김
      calendars: cals.map((c) => ({ ...c, enabled: prev.has(c.id) ? prev.get(c.id).enabled !== false : !c.holiday })),
    };
    gCache.clear();
    if (win) { win.show(); win.focus(); }
    return applySettings({});
  } finally {
    googleLoginBusy = false;
  }
});

ipcMain.handle('google:disconnect', async () => {
  const g = config.google;
  if (g && g.tokenEnc) {
    try { await google.revoke(decryptPw(g.tokenEnc)); } catch {}
  }
  google.clearSession();
  config.google = null;
  gCache.clear();
  return applySettings({});
});

ipcMain.handle('google:update', (_e, patch) => {
  const g = config.google;
  if (!g) return publicConfig();
  if (patch && patch.toggle && typeof patch.toggle.id === 'string') {
    g.calendars = g.calendars.map((c) => (c.id === patch.toggle.id ? { ...c, enabled: !!patch.toggle.enabled } : c));
  }
  return applySettings({});
});

ipcMain.handle('cal:set-default', (_e, key) => {
  if (typeof key === 'string' && writableCals().includes(key)) config.defaultCal = key;
  return applySettings({});
});

const icCache = new Map(); // 같은 달을 자주 다시 불러오지 않도록 잠깐 보관

// ---------- 화면(렌더러)과 주고받는 기능들 ----------
ipcMain.handle('config:get', () => publicConfig());

ipcMain.handle('config:set', (_e, patch) => {
  const allowed = ['calendars', 'alwaysOnTop', 'autoStart', 'opacity', 'theme', 'weekStart', 'showTerms', 'showLunar', 'blur', 'showMemo', 'memoHeight', 'memoSync', 'style'];
  const clean = {};
  for (const k of allowed) if (k in (patch || {})) clean[k] = patch[k];
  if ('memoHeight' in clean) clean.memoHeight = Math.round(Math.min(600, Math.max(36, Number(clean.memoHeight) || 40)));
  for (const k of ['showMemo', 'memoSync']) if (k in clean) clean[k] = !!clean[k];
  if ('style' in clean) clean.style = clean.style === 'basic' ? 'basic' : 'glass';
  if (clean.calendars) {
    clean.calendars = clean.calendars
      .filter((c) => c && typeof c.url === 'string' && c.url.trim())
      .map((c, i) => ({
        id: String(c.id || `cal-${Date.now()}-${i}`),
        name: String(c.name || '캘린더').slice(0, 40),
        url: normalizeUrl(c.url),
        color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#4f8cff',
        holiday: !!c.holiday,
        enabled: c.enabled !== false,
      }));
  }
  return applySettings(clean);
});

// from/to: 'YYYY-MM-DD' 문자열, force: 캐시 무시하고 새로 받기
ipcMain.handle('events:get', async (_e, { from, to, force }) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('날짜가 올바르지 않습니다');
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return collectEvents(new Date(fy, fm - 1, fd, 0, 0, 0), new Date(ty, tm - 1, td, 23, 59, 59), from, to, force);
});

async function collectEvents(fromDate, toDate, from, to, force) {
  const results = [];
  const errors = [];
  const FRESH_MS = 5 * 60 * 1000;

  await Promise.all(
    config.calendars
      .filter((c) => c.enabled !== false)
      .map(async (cal) => {
        let entry = cache[cal.url];
        const stale = !entry || Date.now() - entry.fetchedAt > FRESH_MS;
        if (force || stale) {
          try {
            const text = await downloadIcs(cal.url);
            entry = { text, fetchedAt: Date.now() };
            cache[cal.url] = entry;
          } catch (err) {
            errors.push({ name: cal.name, message: String(err.message || err) });
          }
        }
        if (!entry) return;
        try {
          for (const ev of extractEvents(entry.text, fromDate, toDate)) {
            results.push({ ...ev, calId: cal.id, color: cal.color, holiday: !!cal.holiday });
          }
        } catch (err) {
          errors.push({ name: cal.name, message: '일정을 읽지 못했습니다' });
        }
      })
  );

  // 아이클라우드 계정으로 연결된 캘린더
  if (config.icloud) {
    try {
      if (await ensureIcloud()) {
        const IC_FRESH_MS = 60 * 1000;
        await Promise.all(
          config.icloud.calendars
            .filter((c) => c.enabled !== false)
            .map(async (cal) => {
              const key = `${cal.url}|${from}|${to}`;
              let hit = icCache.get(key);
              if (force || !hit || Date.now() - hit.at > IC_FRESH_MS) {
                try {
                  hit = { at: Date.now(), events: await icloud.fetchEvents(cal.url, fromDate, toDate) };
                  icCache.set(key, hit);
                } catch (err) {
                  errors.push({ name: cal.name, message: String(err.message || err) });
                }
              }
              if (!hit) return;
              for (const ev of hit.events) {
                const own = ev.ownColor || (config.eventColors || {})[ev.uid] || '';
                results.push({ ...ev, calId: `icloud:${cal.url}`, calUrl: cal.url, calColor: cal.color, color: own || cal.color, ownColor: own, holiday: false, editable: true });
              }
            })
        );
      }
    } catch (err) {
      errors.push({ name: '아이클라우드', message: String(err.message || err) });
    }
  }

  // 구글 계정으로 연결된 캘린더
  if (config.google) {
    try {
      if (ensureGoogle()) {
        const G_FRESH_MS = 60 * 1000;
        await Promise.all(
          config.google.calendars
            .filter((c) => c.enabled !== false)
            .map(async (cal) => {
              const key = `${cal.id}|${from}|${to}`;
              let hit = gCache.get(key);
              if (force || !hit || Date.now() - hit.at > G_FRESH_MS) {
                try {
                  hit = { at: Date.now(), events: await google.fetchEvents(cal.id, fromDate, toDate, cal.writable) };
                  gCache.set(key, hit);
                } catch (err) {
                  errors.push({ name: `구글 · ${cal.name}`, message: String(err.message || err) });
                }
              }
              if (!hit) return;
              for (const ev of hit.events) {
                results.push({
                  ...ev, calId: `g:${cal.id}`, calUrl: `g:${cal.id}`, calColor: cal.color,
                  color: ev.ownColor || cal.color, holiday: false,
                });
              }
            })
        );
      }
    } catch (err) {
      errors.push({ name: '구글', message: String(err.message || err) });
    }
  }

  // 지금 설정에 없는 캘린더의 캐시는 정리
  const urls = new Set(config.calendars.map((c) => c.url));
  for (const k of Object.keys(cache)) if (!urls.has(k)) delete cache[k];
  writeJson(cachePath(), cache);

  return { events: results, errors, updatedAt: Date.now() };
}

// ---------- 일정 검색 ----------
// 3년 전부터 1년 뒤까지의 일정을 받아 두고(5분간 기억), 제목·장소·메모에서 찾기
let searchPool = null; // { at, events, errors }
let searchLoading = null;
const SEARCH_BACK_YEARS = 3;
const SEARCH_AHEAD_YEARS = 1;
function searchRangeChunks() {
  const now = new Date();
  const chunks = [];
  for (let y = now.getFullYear() - SEARCH_BACK_YEARS; y <= now.getFullYear() + SEARCH_AHEAD_YEARS; y++) {
    for (const [m1, m2] of [[0, 5], [6, 11]]) {
      chunks.push([new Date(y, m1, 1, 0, 0, 0), new Date(y, m2 + 1, 0, 23, 59, 59)]);
    }
  }
  return chunks;
}
const keyOfDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
async function loadSearchPool(force) {
  if (!force && searchPool && Date.now() - searchPool.at < 5 * 60 * 1000) return searchPool;
  if (searchLoading) return searchLoading;
  searchLoading = (async () => {
    const seen = new Set();
    const events = [];
    const errors = [];
    // 반년씩 나눠서 받기 (한 번에 너무 많이 요청하지 않도록)
    for (const [a, b] of searchRangeChunks()) {
      const res = await collectEvents(a, b, `s:${keyOfDate(a)}`, keyOfDate(b), false);
      for (const ev of res.events) {
        if (ev.holiday) continue;
        const id = `${ev.calId}|${ev.uid}|${ev.startDay}|${ev.start || ''}`;
        if (seen.has(id)) continue; // 반년 경계에 걸친 일정 중복 제거
        seen.add(id);
        events.push(ev);
      }
      for (const er of res.errors) if (!errors.some((x) => x.name === er.name)) errors.push(er);
    }
    searchPool = { at: Date.now(), events, errors };
    return searchPool;
  })().finally(() => { searchLoading = null; });
  return searchLoading;
}
const norm = (s) => String(s || '').toLowerCase().normalize('NFC').replace(/\s+/g, ' ');
ipcMain.handle('events:search', async (_e, { query, force }) => {
  const q = norm(query).trim();
  if (!q) return { results: [], errors: [], total: 0 };
  const words = q.split(' ').filter(Boolean);
  const pool = await loadSearchPool(!!force);
  const hits = pool.events.filter((ev) => {
    const hay = norm(`${ev.title} ${ev.location || ''} ${ev.notes || ''}`);
    return words.every((w) => hay.includes(w));
  });
  // 날짜순 (최근 것이 위)
  hits.sort((a, b) => (b.start || b.startDay).localeCompare(a.start || a.startDay));
  return { results: hits.slice(0, 300), total: hits.length, errors: pool.errors, range: [SEARCH_BACK_YEARS, SEARCH_AHEAD_YEARS] };
});
// 검색창을 열 때 미리 받아 두기
ipcMain.handle('events:search-warm', async () => { try { await loadSearchPool(false); } catch {} return true; });
// 일정이 바뀌면 검색용 기억도 지우기
const dropSearch = () => { searchPool = null; };

// ---------- 월별 메모 ----------
// 늘 이 PC에 먼저 저장 → 아이클라우드가 연결돼 있으면 아이클라우드에도 저장
let memos = {}; // '2026-10' → { text, updatedAt, dirty }
function saveMemos() { writeJson(memosPath(), memos); }
const memoCloudOn = () => !!(config.icloud && config.memoSync !== false);
const memoOut = (month, extra) => {
  const m = memos[month] || { text: '', updatedAt: 0 };
  return { text: m.text || '', updatedAt: m.updatedAt || 0, cloud: memoCloudOn(), synced: !m.dirty, ...extra };
};

ipcMain.handle('memo:get', (_e, month) => {
  if (!memo.isMonthKey(month)) throw new Error('달이 올바르지 않습니다');
  return memoOut(month);
});

async function pushMemo(month) {
  const m = memos[month];
  if (!m || !m.dirty || !memoCloudOn()) return;
  if (!(await ensureIcloud())) return;
  const sentAt = m.updatedAt;
  await icloud.saveMemo(month, m.text, m.updatedAt);
  // 보내는 사이에 또 고쳤으면 아직 '보낼 것'으로 남겨 둠
  if (memos[month] && memos[month].updatedAt === sentAt) {
    memos[month].dirty = false;
    saveMemos();
  }
}

// 아이클라우드와 맞추기: 더 최근에 고친 쪽이 이김
ipcMain.handle('memo:sync', async (_e, month) => {
  if (!memo.isMonthKey(month)) throw new Error('달이 올바르지 않습니다');
  if (!memoCloudOn()) return memoOut(month, { synced: false });
  try {
    if (!(await ensureIcloud())) return memoOut(month, { synced: false, error: '아이클라우드에 연결되어 있지 않습니다' });
    const local = memos[month];
    const remote = await icloud.fetchMemo(month);
    if (local && local.dirty && (!remote || local.updatedAt >= remote.updatedAt)) {
      await pushMemo(month);
    } else if (remote) {
      if (!local || !local.dirty || remote.updatedAt > (local.updatedAt || 0)) {
        if (!local || local.text !== remote.text || local.dirty) {
          memos[month] = { text: remote.text, updatedAt: remote.updatedAt, dirty: false };
          saveMemos();
        }
      }
    } else if (local && !local.dirty && local.text) {
      // 다른 기기에서 지운 메모
      delete memos[month];
      saveMemos();
    }
    return memoOut(month);
  } catch (err) {
    return memoOut(month, { synced: false, error: String((err && err.message) || err) });
  }
});

ipcMain.handle('memo:set', async (_e, { month, text }) => {
  if (!memo.isMonthKey(month)) throw new Error('달이 올바르지 않습니다');
  text = String(text || '').slice(0, 20000);
  memos[month] = { text, updatedAt: Date.now(), dirty: true };
  if (!memoCloudOn()) {
    memos[month].dirty = false;
    if (!text) delete memos[month];
  }
  saveMemos();
  if (!memoCloudOn()) return memoOut(month, { synced: false });
  try {
    await pushMemo(month);
    return memoOut(month);
  } catch (err) {
    return memoOut(month, { synced: false, error: String((err && err.message) || err) });
  }
});

// 아직 못 보낸 메모 보내기 (인터넷이 다시 연결됐을 때 등)
async function flushMemos() {
  if (!memoCloudOn()) return;
  for (const month of Object.keys(memos)) {
    if (memos[month] && memos[month].dirty) {
      try { await pushMemo(month); } catch {}
    }
  }
}

ipcMain.handle('app:open-external', (_e, url) => {
  if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
});
// 크기 조절: 투명 창은 윈도우에서 가장자리 끌기가 잘 안 돼서, 화면의 손잡이로 직접 조절
ipcMain.handle('win:get-size', () => (win ? win.getSize() : [360, 520]));
// 위치·크기 잠금: 풀려 있을 때만 창 가장자리로 크기 조절 가능
let arranging = false;
ipcMain.handle('win:arrange', (_e, on) => {
  arranging = !!on;
  if (win) {
    win.setResizable(arranging);
    if (!arranging) saveBounds();
  }
  return arranging;
});
ipcMain.on('win:resize', (_e, size) => {
  if (!win || !size) return;
  const wasResizable = win.isResizable();
  const w = Math.round(Math.min(1400, Math.max(480, Number(size.width) || 760)));
  const h = Math.round(Math.min(1400, Math.max(380, Number(size.height) || 620)));
  const b = win.getBounds();
  if (!wasResizable) win.setResizable(true); // 잠금 상태에서도 메뉴로 크기 바꾸기는 되도록
  win.setBounds({ x: b.x, y: b.y, width: w, height: h });
  if (!wasResizable) win.setResizable(false);
});
ipcMain.handle('app:relaunch', () => { app.relaunch(); app.exit(0); });
ipcMain.handle('app:hide', () => win && win.hide());
ipcMain.handle('app:quit', () => app.quit());

// 처음 실행할 때 바탕화면·시작 메뉴에 바로가기 만들기 (압축만 풀어 쓰는 경우를 위해)
function makeShortcutsOnce() {
  if (!app.isPackaged || process.platform !== 'win32' || config.shortcutsMade) return;
  try {
    const opts = { target: process.execPath, cwd: path.dirname(process.execPath), description: 'DeskCal 달력' };
    shell.writeShortcutLink(path.join(app.getPath('desktop'), 'DeskCal.lnk'), 'replace', opts);
    const startMenu = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    if (fs.existsSync(startMenu)) shell.writeShortcutLink(path.join(startMenu, 'DeskCal.lnk'), 'replace', opts);
  } catch (e) {
    console.error('바로가기 만들기 실패', e);
  }
  config.shortcutsMade = true;
  writeJson(configPath(), config);
}

// ---------- 자동 업데이트 ----------
// 설치 파일로 설치한 경우: 새 버전을 알아서 받아 두고, 끌 때(또는 '지금 다시 시작'을 누르면) 적용
// 압축 파일로 쓰는 경우: 새 버전이 나왔다고 알려 주기만 함
const HOMEPAGE = 'https://gogoggog.github.io/DeskCal/';
const LATEST_API = 'https://api.github.com/repos/gogoggog/deskcal/releases/latest';
let updateState = { status: 'idle', version: '', mode: 'notify', percent: 0, message: '' };
let autoUpdater = null;

function installedByInstaller() {
  try {
    return fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall DeskCal.exe'));
  } catch {
    return false;
  }
}
function sendUpdate(patch) {
  updateState = { ...updateState, ...patch };
  if (win && !win.isDestroyed()) win.webContents.send('update-state', { ...updateState, current: app.getVersion() });
}
function isNewer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

function setupUpdater() {
  if (!app.isPackaged) return;
  if (installedByInstaller()) {
    try {
      ({ autoUpdater } = require('electron-updater'));
    } catch (e) {
      autoUpdater = null;
    }
  }
  if (autoUpdater) {
    updateState.mode = 'auto';
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (i) => sendUpdate({ status: 'downloading', version: i.version, percent: 0 }));
    autoUpdater.on('update-not-available', () => sendUpdate({ status: 'latest' }));
    autoUpdater.on('download-progress', (p) => sendUpdate({ status: 'downloading', percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (i) => sendUpdate({ status: 'ready', version: i.version }));
    autoUpdater.on('error', (e) => sendUpdate({ status: 'error', message: String((e && e.message) || e) }));
  }
  setTimeout(() => checkUpdate(false), 15 * 1000); // 켜고 15초 뒤
  setInterval(() => checkUpdate(false), 6 * 60 * 60 * 1000); // 이후 6시간마다
}

async function checkUpdate(manual) {
  if (!app.isPackaged) {
    sendUpdate({ status: 'latest' });
    return updateState;
  }
  if (updateState.status === 'ready' || updateState.status === 'downloading') return updateState;
  sendUpdate({ status: 'checking', manual: !!manual });
  if (autoUpdater) {
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      sendUpdate({ status: 'error', message: '업데이트를 확인하지 못했습니다' });
    }
    return updateState;
  }
  try {
    const res = await fetch(LATEST_API, { headers: { 'User-Agent': 'DeskCal' }, signal: AbortSignal.timeout(15000) });
    const j = await res.json();
    const latest = String(j.tag_name || '').replace(/^v/, '');
    if (latest && isNewer(latest, app.getVersion())) sendUpdate({ status: 'available', version: latest });
    else sendUpdate({ status: 'latest' });
  } catch {
    sendUpdate({ status: 'error', message: '업데이트를 확인하지 못했습니다' });
  }
  return updateState;
}

ipcMain.handle('update:get', () => ({ ...updateState, current: app.getVersion() }));
ipcMain.handle('update:check', async () => ({ ...(await checkUpdate(true)), current: app.getVersion() }));
ipcMain.handle('update:install', () => {
  if (autoUpdater && updateState.status === 'ready') {
    saveBounds();
    setImmediate(() => autoUpdater.quitAndInstall(true, true)); // 조용히 설치하고 다시 켜기
    return true;
  }
  shell.openExternal(HOMEPAGE);
  return false;
});

// 맥: 메뉴 막대는 안 보이지만 ⌘C·⌘V·⌘A 같은 단축키가 되도록 메뉴를 정해 둠
// (⌘W는 창을 닫는 대신 숨김 → 메뉴 막대 아이콘으로 다시 열기)
function setMacMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'DeskCal',
      submenu: [
        { label: 'DeskCal 숨기기', accelerator: 'Command+W', click: () => win && win.hide() },
        { label: '설정…', accelerator: 'Command+,', click: () => { if (win) { win.show(); win.webContents.send('open-settings'); } } },
        { type: 'separator' },
        { label: 'DeskCal 종료', accelerator: 'Command+Q', click: () => app.quit() },
      ],
    },
    { role: 'editMenu', label: '편집' },
  ]));
}

// ---------- 시작 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });
  app.whenReady().then(() => {
    app.setAppUserModelId('com.deskcal.app');
    // 맥: 독(Dock)에는 안 보이고 메뉴 막대 아이콘으로만 관리 (위젯처럼)
    if (IS_MAC && app.dock) app.dock.hide();
    loadConfig();
    if (IS_MAC) setMacMenu();
    makeShortcutsOnce();
    useAcrylic = acrylicSupported() && config.blur !== false;
    createWindow();
    rebuildTrayMenu = createTray();
    setupUpdater();
    setInterval(flushMemos, 3 * 60 * 1000); // 못 보낸 메모가 있으면 3분마다 다시 시도
    setTimeout(flushMemos, 20 * 1000);
    screen.on('display-removed', () => {
      if (win && !boundsAreVisible(win.getBounds())) win.center();
    });
  });
  // 창을 닫아도 트레이에 남아 있도록 (종료는 트레이 메뉴에서)
  app.on('window-all-closed', () => {});
}
