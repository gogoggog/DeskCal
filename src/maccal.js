// 맥 캘린더 연결 (맥 전용, 앱 전용 암호 없이)
// 같이 들어 있는 작은 도우미 프로그램(deskcal-eventkit)이 맥 기본 캘린더(EventKit)를 읽고 씁니다.
// 도우미 코드: build/mac/EventKitHelper.swift
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

let helperPathOverride = null;
function helperPath() {
  if (helperPathOverride) return helperPathOverride;
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'deskcal-eventkit'), // 설치된 앱
    path.join(__dirname, '..', 'build', 'mac', 'deskcal-eventkit'), // 개발 중
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || candidates[candidates.length - 1];
}

let child = null;
let rl = null;
let nextId = 1;
const pending = new Map(); // id → { resolve, reject, timer }

function available() {
  return (process.platform === 'darwin' || !!helperPathOverride) && fs.existsSync(helperPath());
}

function start() {
  if (child) return;
  child = spawn(helperPath(), [], { stdio: ['pipe', 'pipe', 'pipe'] });
  rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || '맥 캘린더 오류'));
  });
  child.stderr.on('data', () => {});
  const dead = (why) => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(why)); }
    pending.clear();
    child = null;
    rl = null;
  };
  child.on('exit', () => dead('맥 캘린더 도우미가 멈췄습니다. 다시 시도해 주세요'));
  child.on('error', () => dead('맥 캘린더 도우미를 실행하지 못했습니다'));
}

function call(cmd, args = {}, timeoutMs = 30000) {
  if (!available()) return Promise.reject(new Error('이 컴퓨터에서는 맥 캘린더를 쓸 수 없습니다'));
  start();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('맥 캘린더가 응답하지 않습니다'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      child.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e);
    }
  });
}

function stop() {
  if (child) { try { child.kill(); } catch {} }
  child = null;
}

const status = async () => (await call('status')).status;
// 허용 창은 사용자가 고를 때까지 기다림 (최대 10분)
const request = async () => (await call('request', {}, 10 * 60 * 1000)).status;
const calendars = () => call('calendars');

async function fetchEvents(calIds, from, to) {
  if (!calIds.length) return [];
  const list = await call('events', { calIds, from: from.toISOString(), to: to.toISOString() }, 60000);
  return list.map((e) => ({
    title: e.title || '(제목 없음)',
    allDay: !!e.allDay,
    location: e.location || '',
    notes: e.notes || '',
    uid: e.uid,
    recurring: !!e.recurring,
    hasAlarm: !!e.hasAlarm,
    objUrl: `ek:${e.id}`,
    etag: '',
    editable: !!e.writable,
    calKey: `ek:${e.calId}`,
    ...(e.allDay ? { startDay: e.startDay, endDay: e.endDay } : { start: e.start, end: e.end, startDay: e.startDay, endDay: e.endDay }),
  }));
}

function clean(ev) {
  const out = { title: ev.title, location: ev.location || '', notes: ev.notes || '', allDay: !!ev.allDay };
  if (ev.allDay) Object.assign(out, { startDay: ev.startDay, endDay: ev.endDay || ev.startDay });
  else Object.assign(out, { start: ev.start, end: ev.end });
  if (ev.alarmMinutes !== undefined) out.alarmMinutes = ev.alarmMinutes; // null = 알림 지우기
  return out;
}
const createEvent = (calId, ev) => call('create', { calId, event: clean(ev) });
const updateEvent = (eventId, ev) => call('update', { eventId, event: clean(ev) });
const deleteEvent = (eventId) => call('delete', { eventId });

// 월별 메모 → { text, updatedAt } 또는 null
async function fetchMemo(month) {
  const r = await call('memoGet', { month });
  return r && r.found ? { text: r.text || '', updatedAt: Number(r.updatedAt) || 0 } : null;
}
const saveMemo = (month, text) => call('memoSave', { month, text: String(text || '') });

module.exports = {
  available, status, request, calendars, fetchEvents, createEvent, updateEvent, deleteEvent, fetchMemo, saveMemo, stop,
  _setHelperPath: (p) => { stop(); helperPathOverride = p; },
};
