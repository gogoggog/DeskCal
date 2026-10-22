// 간단한 시험: node test/run.js
// 진짜 아이클라우드 대신 가짜 서버를 써서 메모 저장·불러오기를 확인합니다.
const assert = require('assert');
const path = require('path');

const memo = require('../src/memo');

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.stack || e}`);
    process.exitCode = 1;
  }
}

// ---------- 가짜 아이클라우드 (CalDAV) ----------
const HOME = 'https://p1-caldav.icloud.com/123/calendars/';
function fakeServer() {
  const cals = [
    { url: `${HOME}home/`, displayName: '집', calendarColor: '#34C759FF', components: ['VEVENT'] },
    { url: `${HOME}work/`, displayName: '직장', calendarColor: '#0A84FF', components: ['VEVENT'] },
  ];
  const objects = new Map(); // url → { data, etag }
  let n = 0;
  const etag = () => `"e${++n}"`;
  const ok = (status = 201, tag) => ({ ok: true, status, headers: new Headers(tag ? { etag: tag } : {}) });
  const client = {
    async fetchCalendars() { return cals.map((c) => ({ ...c })); },
    async makeCalendar({ url, props }) {
      if (cals.some((c) => c.url === url)) return [{ status: 405, ok: false }];
      cals.push({ url, displayName: props['d:displayname'], calendarColor: props['ca:calendar-color'], components: ['VEVENT'] });
      return [{ status: 201, ok: true }];
    },
    async fetchCalendarObjects({ calendar }) {
      return [...objects.entries()].filter(([u]) => u.startsWith(calendar.url)).map(([url, o]) => ({ url, data: o.data, etag: o.etag }));
    },
    async createCalendarObject({ calendar, filename, iCalString }) {
      const url = calendar.url + filename;
      if (objects.has(url)) return { ok: false, status: 412 };
      const t = etag();
      objects.set(url, { data: iCalString, etag: t });
      return ok(201, t);
    },
    async updateCalendarObject({ calendarObject: { url, data, etag: tag } }) {
      const cur = objects.get(url);
      if (!cur) return { ok: false, status: 404 };
      if (tag && cur.etag !== tag) return { ok: false, status: 412 };
      const t = etag();
      objects.set(url, { data, etag: t });
      return ok(204, t);
    },
    async deleteCalendarObject({ calendarObject: { url, etag: tag } }) {
      const cur = objects.get(url);
      if (!cur) return { ok: false, status: 404 };
      if (tag && cur.etag !== tag) return { ok: false, status: 412 };
      objects.delete(url);
      return ok(204);
    },
  };
  return { cals, objects, client };
}

// tsdav 대신 가짜 서버를 쓰도록 바꿔 끼우고 icloud.js를 새로 불러오기
function loadIcloudWith(server) {
  const tsdavPath = require.resolve('tsdav');
  require.cache[tsdavPath] = { id: tsdavPath, filename: tsdavPath, loaded: true, exports: { createDAVClient: async () => server.client } };
  const icPath = path.join(__dirname, '..', 'src', 'icloud.js');
  delete require.cache[icPath];
  return require(icPath);
}

(async () => {
  console.log('메모 형식');
  await check('메모 → 캘린더 파일 → 메모 (줄바꿈·쉼표·긴 글 그대로)', () => {
    const text = '첫 줄, 쉼표; 세미콜론 \\ 역슬래시\n둘째 줄 ' + '가나다'.repeat(40) + '\n\n🎉 끝';
    const ics = memo.buildMemoIcs('2026-10', text, 1761100000000);
    assert(ics.split('\r\n').every((l) => Buffer.byteLength(l, 'utf8') <= 75), '75바이트 넘는 줄이 있음');
    const p = memo.parseMemoIcs(ics);
    assert.strictEqual(p.month, '2026-10');
    assert.strictEqual(p.text, text);
    assert.strictEqual(p.updatedAt, 1761100000000);
  });
  await check('메모는 그달 1일 하루 종일 일정으로 보임 (아이폰 캘린더에서도 읽힘)', () => {
    const { extractEvents } = require('../src/calendar');
    const evs = extractEvents(memo.buildMemoIcs('2026-12', '연말 정산 서류'), new Date(2026, 10, 25), new Date(2027, 0, 5));
    assert.strictEqual(evs.length, 1);
    assert.strictEqual(evs[0].startDay, '2026-12-01');
    assert.strictEqual(evs[0].endDay, '2026-12-01');
    assert.strictEqual(evs[0].allDay, true);
    assert.strictEqual(evs[0].notes, '연말 정산 서류');
  });
  await check('잘못된 달은 거절', () => {
    assert(!memo.isMonthKey('2026-13'));
    assert(!memo.isMonthKey('2026-1'));
    assert(memo.isMonthKey('2026-01'));
    assert.strictEqual(memo.parseMemoIcs('BEGIN:VCALENDAR\r\nSUMMARY:보통 일정\r\nEND:VCALENDAR'), null);
  });

  console.log('아이클라우드 메모 저장 (가짜 서버)');
  const server = fakeServer();
  const icloud = loadIcloudWith(server);
  await check('연결하면 메모 캘린더는 일정 목록에서 빠짐', async () => {
    server.cals.push({ url: `${HOME}deskcal-memo/`, displayName: 'DeskCal 메모', components: ['VEVENT'] });
    const cals = await icloud.connect('me@icloud.com', 'abcd-efgh-ijkl-mnop');
    assert.deepStrictEqual(cals.map((c) => c.name), ['집', '직장']);
    server.cals.pop();
    icloud.disconnect();
  });
  await check('메모 캘린더가 없으면 처음 저장할 때 만듦', async () => {
    await icloud.connect('me@icloud.com', 'abcd-efgh-ijkl-mnop');
    assert.strictEqual(await icloud.fetchMemo('2026-10'), null);
    await icloud.saveMemo('2026-10', '10월: 부가세 신고', 1000);
    assert(server.cals.some((c) => c.url === `${HOME}deskcal-memo/`), '메모 캘린더가 안 만들어짐');
    const got = await icloud.fetchMemo('2026-10');
    assert.strictEqual(got.text, '10월: 부가세 신고');
  });
  await check('고쳐 쓰면 같은 일정을 고침 (새로 만들지 않음)', async () => {
    await icloud.saveMemo('2026-10', '10월: 부가세 신고\n아기 예방접종', 2000);
    await icloud.saveMemo('2026-10', '10월: 부가세 신고\n아기 예방접종 (25일)', 3000);
    const memoObjs = [...server.objects.keys()].filter((u) => u.includes('deskcal-memo'));
    assert.strictEqual(memoObjs.length, 1);
    assert.strictEqual((await icloud.fetchMemo('2026-10')).text, '10월: 부가세 신고\n아기 예방접종 (25일)');
  });
  await check('다른 기기(맥)에서 고친 걸 받아 옴', async () => {
    const url = [...server.objects.keys()].find((u) => u.includes('deskcal-memo-2026-10'));
    server.objects.set(url, { data: memo.buildMemoIcs('2026-10', '맥에서 고침', 5000), etag: '"mac1"' });
    const got = await icloud.fetchMemo('2026-10');
    assert.strictEqual(got.text, '맥에서 고침');
    assert.strictEqual(got.updatedAt, 5000);
  });
  await check('그사이 바뀌었어도(412) 지금 쓴 내용으로 저장', async () => {
    const url = [...server.objects.keys()].find((u) => u.includes('deskcal-memo-2026-10'));
    server.objects.set(url, { data: memo.buildMemoIcs('2026-10', '또 다른 기기', 6000), etag: '"other"' });
    await icloud.saveMemo('2026-10', '윈도우에서 마지막으로 씀', 7000);
    assert.strictEqual((await icloud.fetchMemo('2026-10')).text, '윈도우에서 마지막으로 씀');
  });
  await check('메모를 다 지우면 아이클라우드에서도 지움', async () => {
    await icloud.saveMemo('2026-10', '   ', 8000);
    assert.strictEqual(await icloud.fetchMemo('2026-10'), null);
    assert(![...server.objects.keys()].some((u) => u.includes('deskcal-memo-2026-10')));
  });
  await check('달마다 따로 저장', async () => {
    await icloud.saveMemo('2026-11', '11월', 9000);
    await icloud.saveMemo('2026-12', '12월', 9000);
    // 가짜 서버는 기간으로 거르지 않으므로 달 구분은 메모 안의 표시로 함
    assert.strictEqual((await icloud.fetchMemo('2026-11')).text, '11월');
    assert.strictEqual((await icloud.fetchMemo('2026-12')).text, '12월');
  });

  // ---------- 맥용 암호 보관 (열쇠 파일) ----------
  const localSecret = require('../src/localsecret');
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskcal-secret-'));
  await check('맥 암호: 저장한 암호를 그대로 다시 읽음', async () => {
    const enc = localSecret.encrypt(dir, 'abcd-efgh-ijkl-mnop');
    assert(localSecret.isLocal(enc));
    assert(!enc.includes('abcd'));
    assert.strictEqual(localSecret.decrypt(dir, enc), 'abcd-efgh-ijkl-mnop');
  });
  await check('맥 암호: 열쇠 파일은 내 계정만 읽기 가능', async () => {
    if (process.platform === 'win32') return;
    assert.strictEqual(fs.statSync(path.join(dir, 'secret.key')).mode & 0o777, 0o600);
  });
  await check('맥 암호: 같은 열쇠로 계속 읽힘(업데이트 후에도)', async () => {
    const enc = localSecret.encrypt(dir, '두번째');
    assert.strictEqual(localSecret.decrypt(dir, enc), '두번째');
    assert(!localSecret.isLocal('예전키체인방식base64'));
  });
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n${passed}개 통과${process.exitCode ? ' · 실패 있음' : ''}`);
})();
