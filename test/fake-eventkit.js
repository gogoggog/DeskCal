#!/usr/bin/env node
// 시험용 가짜 맥 캘린더 도우미 (진짜는 build/mac/EventKitHelper.swift)
const readline = require('readline');
const cals = [
  { id: 'C1', name: '집', color: '#34c759', writable: true, source: 'iCloud', memo: false },
  { id: 'C2', name: '대한민국 공휴일', color: '#ff3b30', writable: false, source: '구독', memo: false },
];
const events = [];
let n = 0;
const key = (d) => d.slice(0, 10);
const reply = (id, ok, x) => process.stdout.write(JSON.stringify(ok ? { id, ok, result: x } : { id, ok, error: x }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const r = JSON.parse(line);
  try {
    switch (r.cmd) {
      case 'status': case 'request': return reply(r.id, true, { status: 'granted' });
      case 'calendars': return reply(r.id, true, cals);
      case 'events': return reply(r.id, true, events.filter((e) => r.calIds.includes(e.calId) && e.end >= r.from && e.start <= r.to));
      case 'create': {
        const ev = r.event;
        if (!String(ev.title || '').trim()) throw new Error('일정 제목을 입력해 주세요');
        const id = `E${++n}`;
        const start = ev.allDay ? `${ev.startDay}T00:00:00.000Z` : ev.start;
        const end = ev.allDay ? `${ev.endDay}T23:59:59.000Z` : ev.end;
        events.push({ id, uid: `U${n}`, title: ev.title, allDay: ev.allDay, calId: r.calId, start, end, startDay: key(start), endDay: key(end), writable: true, location: ev.location, notes: ev.notes });
        return reply(r.id, true, { id, uid: `U${n}` });
      }
      case 'delete': { const i = events.findIndex((e) => e.id === r.eventId); if (i < 0) throw new Error('일정을 찾지 못했습니다'); events.splice(i, 1); return reply(r.id, true, { ok: true }); }
      case 'memoGet': { const m = memos[r.month]; return reply(r.id, true, m ? { found: true, ...m } : { found: false }); }
      case 'memoSave': { if (String(r.text).trim()) memos[r.month] = { text: r.text, updatedAt: 1000 + ++n }; else delete memos[r.month]; return reply(r.id, true, {}); }
      default: throw new Error(`모르는 명령: ${r.cmd}`);
    }
  } catch (e) { reply(r.id, false, e.message); }
});
const memos = {};
