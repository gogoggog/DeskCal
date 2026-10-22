// 달력 화면을 그리는 부분
(() => {
  const api = window.deskcal;
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, '0');
  const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return keyOf(d); };
  const dayDiff = (a, b) => Math.round((parseKey(b) - parseKey(a)) / 86400000);
  const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

  // 애플 기본 색
  const COLORS = [
    ['#ff3b30', '빨강'], ['#ff9500', '주황'], ['#ffcc00', '노랑'], ['#34c759', '초록'],
    ['#0a84ff', '파랑'], ['#af52de', '보라'], ['#ff2d55', '분홍'], ['#a2845e', '갈색'],
  ];

  let config = null;
  let view = new Date();
  view.setDate(1);
  let selected = keyOf(new Date());
  let todayKey = keyOf(new Date());
  let events = [];
  let byDay = new Map();
  let lastErrors = [];
  let lastUpdated = 0;
  let loadToken = 0;
  let loading = false;

  function errText(e) {
    return String((e && e.message) || e).replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '');
  }

  // ---------- 테마 ----------
  const darkMQ = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const t = config.theme || 'auto';
    document.body.dataset.theme = t === 'auto' ? (darkMQ.matches ? 'dark' : 'light') : t;
    document.body.classList.toggle('blur', !!config.blurActive);
    document.body.classList.toggle('glass', config.style !== 'basic');
  }
  darkMQ.addEventListener('change', () => config && applyTheme());

  // ---------- 음력 ----------
  let lunarFmt = null;
  try { lunarFmt = new Intl.DateTimeFormat('ko-KR-u-ca-dangi', { month: 'numeric', day: 'numeric' }); } catch {}
  if (!lunarFmt) try { lunarFmt = new Intl.DateTimeFormat('ko-KR-u-ca-chinese', { month: 'numeric', day: 'numeric' }); } catch {}
  function lunarOf(d) {
    if (!lunarFmt) return '';
    try {
      const p = lunarFmt.formatToParts(d);
      const m = (p.find((x) => x.type === 'month') || {}).value;
      const dd = (p.find((x) => x.type === 'day') || {}).value;
      if (!m || !dd) return '';
      return dd === '1' || d.getDate() === 1 ? `음 ${m}.${dd}` : `${m}.${dd}`;
    } catch { return ''; }
  }

  // ---------- 날짜 계산 ----------
  function gridDays() {
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    const offset = (first.getDay() - Number(config.weekStart || 0) + 7) % 7;
    const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    const rows = Math.ceil((offset + daysInMonth) / 7);
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
    const days = [];
    for (let i = 0; i < rows * 7; i++) days.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
    return days;
  }

  function indexEvents() {
    byDay = new Map();
    for (const ev of events) {
      let k = ev.startDay;
      let guard = 0;
      while (k <= ev.endDay && guard++ < 400) {
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k).push(ev);
        k = addDays(k, 1);
      }
    }
    for (const list of byDay.values()) {
      list.sort((a, b) => {
        if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
        if (a.allDay) return a.startDay.localeCompare(b.startDay) || a.title.localeCompare(b.title, 'ko');
        return a.start.localeCompare(b.start);
      });
    }
  }

  const fmtTime = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const fmtTimeKo = (iso) => {
    const d = new Date(iso);
    const h = d.getHours();
    return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${pad(d.getMinutes())}`;
  };
  const dayLabel = (k) => { const d = parseKey(k); return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK[d.getDay()]})`; };

  // ---------- 그리기 ----------
  function renderHeader() {
    const t = new Date();
    $('tMonth').textContent = `${view.getMonth() + 1}월`;
    $('tYear').textContent = view.getFullYear();
    const same = view.getFullYear() === t.getFullYear() && view.getMonth() === t.getMonth();
    $('todaySub').textContent = same ? `오늘 ${t.getMonth() + 1}월 ${t.getDate()}일 ${WEEK[t.getDay()]}요일` : '';
    const ws = Number(config.weekStart || 0);
    const wd = $('weekdays');
    wd.innerHTML = '';
    for (let i = 0; i < 7; i++) {
      const dow = (i + ws) % 7;
      const el = document.createElement('div');
      el.textContent = WEEK[dow];
      if (dow === 0) el.className = 'sun';
      wd.appendChild(el);
    }
  }

  function renderGrid() {
    const grid = $('grid');
    grid.innerHTML = '';
    const days = gridDays();
    grid.style.gridTemplateRows = `repeat(${days.length / 7}, minmax(0, 1fr))`;
    const month = view.getMonth();
    for (const d of days) {
      const k = keyOf(d);
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.key = k;
      cell.setAttribute('role', 'gridcell');
      if (d.getMonth() !== month) cell.classList.add('other');
      if (d.getDay() === 0) cell.classList.add('sun');
      if (d.getDay() === 0 || d.getDay() === 6) cell.classList.add('weekend');
      if (k === todayKey) cell.classList.add('today');
      if (k === selected) cell.classList.add('selected');

      const list = byDay.get(k) || [];
      const holidays = list.filter((e) => e.holiday);
      if (holidays.length) cell.classList.add('holiday');

      const head = document.createElement('div');
      head.className = 'head-line';
      const lbls = document.createElement('span');
      lbls.className = 'lbls';
      for (const h of holidays) {
        const s = document.createElement('span');
        s.className = 'lbl-holiday';
        s.textContent = h.title;
        lbls.appendChild(s);
      }
      const term = config.showTerms !== false && window.solarTermOn ? window.solarTermOn(d.getFullYear(), d.getMonth() + 1, d.getDate()) : null;
      if (term) {
        const s = document.createElement('span');
        s.className = 'lbl-term';
        s.textContent = term;
        lbls.appendChild(s);
      }
      if (config.showLunar && !holidays.length) {
        const lu = lunarOf(d);
        if (lu) {
          const s = document.createElement('span');
          s.className = 'lbl-lunar';
          s.textContent = lu;
          lbls.appendChild(s);
        }
      }
      const num = document.createElement('span');
      num.className = 'num';
      if (d.getDate() === 1) {
        const m = document.createElement('span');
        m.className = 'm';
        m.textContent = `${d.getMonth() + 1}월`;
        num.append(m, document.createTextNode(`${d.getDate()}일`));
      } else {
        num.textContent = d.getDate();
      }
      head.append(lbls, num);
      cell.appendChild(head);
      cell.title = [...holidays.map((h) => h.title), term].filter(Boolean).join(' · ');
      grid.appendChild(cell);
    }
    fillChips();
  }

  const canEdit = (ev) => !!(ev.editable && ev.objUrl && !ev.recurring);

  function makeChip(ev, dayKey, col) {
    const chip = document.createElement('div');
    chip.className = 'chip' + (ev.allDay ? ' allday' : '');
    if (ev.allDay && ev.startDay < dayKey) chip.classList.add('cont');
    if (ev.allDay && ev.startDay < dayKey && col === 0) chip.classList.add('week-start');
    if (ev.allDay && ev.endDay > dayKey && col !== 6) chip.classList.add('contr');
    chip.style.setProperty('--c', ev.color);
    if (ev.allDay) {
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = ev.title;
      chip.appendChild(n);
    } else {
      const dot = document.createElement('span');
      dot.className = 'dot';
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = ev.title;
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = ev.startDay === dayKey ? fmtTime(ev.start) : '';
      chip.append(dot, n, t);
    }
    chip.title = ev.title;
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      showPopover(ev, chip);
    });
    chip.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (canEdit(ev)) openComposer({ edit: ev });
    });
    if (canEdit(ev)) {
      chip.draggable = true;
      chip.addEventListener('dragstart', (e) => {
        hidePopover();
        dragInfo = { ev, fromKey: dayKey };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', ev.title);
        setTimeout(() => chip.classList.add('dragging'), 0);
      });
      chip.addEventListener('dragend', () => {
        chip.classList.remove('dragging');
        document.querySelectorAll('.cell.drop').forEach((c) => c.classList.remove('drop'));
      });
    }
    return chip;
  }

  // 칸 크기에 맞춰 들어가는 만큼만 일정 표시
  function fillChips() {
    const cells = [...$('grid').children];
    if (!cells.length) return;
    const cap = Math.max(0, Math.floor((cells[0].clientHeight - 30) / 20));
    cells.forEach((cell, idx) => {
      const col = idx % 7;
      cell.querySelectorAll('.chip, .more').forEach((n) => n.remove());
      const k = cell.dataset.key;
      const list = (byDay.get(k) || []).filter((e) => !e.holiday);
      if (!list.length) return;
      const showN = list.length > cap ? Math.max(0, cap - 1) : list.length;
      list.slice(0, showN).forEach((ev) => cell.appendChild(makeChip(ev, k, col)));
      if (list.length > showN) {
        const more = document.createElement('div');
        more.className = 'more';
        more.textContent = `${list.length - showN}개 더 보기`;
        more.addEventListener('click', (e) => {
          e.stopPropagation();
          showDayList(k, more);
        });
        cell.appendChild(more);
      }
    });
  }

  function renderStatus() {
    const s = $('status');
    const btn = $('syncBtn');
    btn.classList.toggle('busy', loading);
    btn.classList.toggle('err', !loading && lastErrors.length > 0);
    if (!config.calendars.length && !hasAccount()) {
      s.textContent = '⚙ 설정에서 캘린더를 연결하세요';
      s.className = 'status';
    } else if (lastErrors.length) {
      s.textContent = `연결 실패: ${lastErrors.map((e) => e.name).join(', ')} — 마우스를 올리면 이유가 보입니다`;
      s.title = lastErrors.map((e) => `${e.name}: ${e.message}`).join('\n');
      s.className = 'status err';
    } else {
      s.textContent = '';
      s.title = '';
      s.className = 'status';
    }
    if (lastUpdated) {
      const d = new Date(lastUpdated);
      btn.title = `새로고침 (마지막 ${pad(d.getHours())}:${pad(d.getMinutes())})`;
    }
  }

  function renderAll() {
    hidePopover();
    renderHeader();
    renderGrid();
    renderStatus();
  }

  // ---------- 팝업 ----------
  let popEvent = null;
  function placePopover(anchor) {
    const pop = $('evPop');
    pop.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    let left = r.right + 8;
    if (left + pw > window.innerWidth - 8) left = r.left - pw - 8;
    if (left < 8) left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.left));
    let top = r.top - 6;
    if (top + ph > window.innerHeight - 8) top = window.innerHeight - ph - 8;
    pop.style.left = `${Math.max(8, left)}px`;
    pop.style.top = `${Math.max(8, top)}px`;
  }

  function describeWhen(ev) {
    if (ev.allDay) return ev.startDay === ev.endDay ? `${dayLabel(ev.startDay)}\n하루 종일` : `${dayLabel(ev.startDay)} ~ ${dayLabel(ev.endDay)}\n하루 종일`;
    if (ev.startDay === ev.endDay) return `${dayLabel(ev.startDay)}\n${fmtTimeKo(ev.start)} ~ ${fmtTimeKo(ev.end)}`;
    return `${dayLabel(ev.startDay)} ${fmtTimeKo(ev.start)} ~\n${dayLabel(ev.endDay)} ${fmtTimeKo(ev.end)}`;
  }

  // 일정을 넣을 수 있는 캘린더 전체 (아이클라우드 + 구글)
  function allCals() {
    const list = [];
    if (config.mac) for (const c of config.mac.calendars || []) list.push({ key: `ek:${c.id}`, name: c.name, color: c.color, source: c.source ? `맥 · ${c.source}` : '맥 캘린더', writable: !!c.writable });
    if (config.icloud && !config.icloudPaused) for (const c of config.icloud.calendars || []) list.push({ key: c.url, name: c.name, color: c.color, source: '아이클라우드', writable: true });
    if (config.google) for (const c of config.google.calendars || []) list.push({ key: `g:${c.id}`, name: c.name, color: c.color, source: '구글', writable: !!c.writable });
    return list;
  }
  const writableCals = () => allCals().filter((c) => c.writable);
  const macGranted = () => !!(config.mac && config.mac.status === 'granted' && config.mac.enabled);
  const hasAccount = () => !!(config.icloud || config.google || macGranted());
  function calOf(ev) {
    if (!ev || !ev.calUrl) return null;
    return allCals().find((x) => x.key === ev.calUrl) || null;
  }
  function calNameOf(ev) {
    const ic = calOf(ev);
    if (ic) return `${ic.name} · ${ic.source}`;
    const c = config.calendars.find((x) => x.id === ev.calId);
    return c ? `${c.name} · 보기 전용` : '';
  }

  function showPopover(ev, anchor) {
    document.querySelectorAll('.chip.active').forEach((c) => c.classList.remove('active'));
    if (anchor.classList.contains('chip')) anchor.classList.add('active');
    popEvent = ev;
    const pop = $('evPop');
    pop.querySelector('.pop-list')?.remove();
    pop.style.setProperty('--c', ev.color);
    $('popDot').classList.remove('hidden');
    $('popTitle').textContent = ev.title;
    $('popWhen').textContent = describeWhen(ev);
    $('popWhere').textContent = ev.location ? `📍 ${ev.location}` : '';
    $('popNotes').textContent = ev.notes || '';
    $('popCal').textContent = calNameOf(ev);
    const editable = canEdit(ev);
    $('popEdit').classList.toggle('hidden', !editable);
    $('popDel').classList.toggle('hidden', !editable);
    $('popFoot').classList.toggle('hidden', !editable && !ev.recurring);
    $('popNote').textContent = ev.recurring ? '반복 일정은 아이폰이나 캘린더 앱에서 수정해 주세요' : '';
    placePopover(anchor);
  }

  function showDayList(key, anchor) {
    hidePopover();
    const list = (byDay.get(key) || []).filter((e) => !e.holiday);
    const pop = $('evPop');
    pop.style.setProperty('--c', 'var(--blue)');
    $('popDot').classList.add('hidden');
    $('popTitle').textContent = dayLabel(key);
    $('popWhen').textContent = '';
    $('popWhere').textContent = '';
    $('popNotes').textContent = '';
    $('popCal').textContent = '';
    $('popFoot').classList.add('hidden');
    const ul = document.createElement('ul');
    ul.className = 'pop-list';
    for (const ev of list) {
      const li = document.createElement('li');
      li.style.setProperty('--c', ev.color);
      li.innerHTML = '<span class="dot"></span><span class="t"></span><span class="n"></span>';
      li.querySelector('.t').textContent = ev.allDay ? '종일' : fmtTime(ev.start);
      li.querySelector('.n').textContent = ev.title;
      li.addEventListener('click', (e) => { e.stopPropagation(); showPopover(ev, anchor); });
      li.addEventListener('dblclick', (e) => { e.stopPropagation(); if (canEdit(ev)) openComposer({ edit: ev }); });
      ul.appendChild(li);
    }
    pop.insertBefore(ul, $('popFoot'));
    placePopover(anchor);
  }

  function hidePopover() {
    $('evPop').classList.add('hidden');
    $('evPop').querySelector('.pop-list')?.remove();
    document.querySelectorAll('.chip.active').forEach((c) => c.classList.remove('active'));
    popEvent = null;
  }

  // ---------- 불러오기 ----------
  // 달마다 받아 온 일정을 기억해 두었다가, 다시 볼 때 바로 보여 주기
  const monthCache = new Map(); // '시작일|끝일' → { events, errors, updatedAt }
  function rangeOf(v) {
    const saved = view;
    view = v;
    const days = gridDays();
    view = saved;
    return [keyOf(days[0]), keyOf(days[days.length - 1])];
  }
  const sameEvents = (a, b) => a.length === b.length && JSON.stringify(a) === JSON.stringify(b);

  function show(res) {
    events = res.events;
    lastErrors = res.errors;
    lastUpdated = res.updatedAt;
    indexEvents();
  }

  async function load(force = false) {
    const [from, to] = rangeOf(view);
    const key = `${from}|${to}`;
    const token = ++loadToken;
    if (force) monthCache.clear();

    // 1) 기억해 둔 게 있으면 먼저 바로 보여 주기
    const cached = monthCache.get(key);
    if (cached && !force) {
      show(cached);
      renderAll();
    }

    // 2) 최신 내용을 받아서, 바뀐 게 있을 때만 다시 그리기
    loading = true;
    renderStatus();
    let res;
    try {
      res = await api.getEvents(from, to, force);
    } catch (e) {
      res = { events: cached ? cached.events : [], errors: [{ name: '전체', message: errText(e) }], updatedAt: lastUpdated };
    }
    if (token !== loadToken) return;
    loading = false;
    if (!res.errors.length) monthCache.set(key, res);
    const changed = !cached || force || !sameEvents(cached.events, res.events);
    show(res);
    if (changed) renderAll();
    else renderStatus();
    prefetchAround();
  }

  // 앞뒤 달을 미리 받아 두기 (조용히)
  let prefetchTimer = null;
  function prefetchAround() {
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(async () => {
      for (const delta of [1, -1]) {
        const v = new Date(view.getFullYear(), view.getMonth() + delta, 1);
        const [from, to] = rangeOf(v);
        const key = `${from}|${to}`;
        if (monthCache.has(key)) continue;
        try {
          const res = await api.getEvents(from, to, false);
          if (!res.errors.length) monthCache.set(key, res);
        } catch {}
      }
      // 너무 많이 쌓이지 않게 최근 12개월만 기억
      while (monthCache.size > 12) monthCache.delete(monthCache.keys().next().value);
    }, 400);
  }

  function goMonth(delta) {
    view = new Date(view.getFullYear(), view.getMonth() + delta, 1);
    const [from, to] = rangeOf(view);
    const cached = monthCache.get(`${from}|${to}`);
    if (cached) show(cached);
    else { events = []; indexEvents(); }
    renderAll();
    load();
    loadMemo();
  }
  function goToday() {
    const same = view.getFullYear() === new Date().getFullYear() && view.getMonth() === new Date().getMonth();
    view = new Date();
    view.setDate(1);
    selected = todayKey;
    renderAll();
    load();
    if (!same) loadMemo();
  }

  // ---------- 날짜 옮기기 (끌어 놓기) ----------
  let dragInfo = null;
  function eventPayload(ev, overrides = {}) {
    const base = {
      title: ev.title,
      location: ev.location || '',
      notes: ev.notes || '',
      color: ev.ownColor || '',
      allDay: ev.allDay,
    };
    if (ev.allDay) Object.assign(base, { startDay: ev.startDay, endDay: ev.endDay });
    else Object.assign(base, { start: ev.start, end: ev.end });
    return { ...base, ...overrides };
  }

  async function moveEvent(ev, deltaDays) {
    if (!deltaDays) return;
    let patch;
    if (ev.allDay) patch = { startDay: addDays(ev.startDay, deltaDays), endDay: addDays(ev.endDay, deltaDays) };
    else {
      const shift = (iso) => { const d = new Date(iso); d.setDate(d.getDate() + deltaDays); return d.toISOString(); };
      patch = { start: shift(ev.start), end: shift(ev.end) };
    }
    const payload = eventPayload(ev, patch);
    // 화면에 먼저 반영하고 저장
    Object.assign(ev, patch, ev.allDay ? {} : { startDay: addDays(ev.startDay, deltaDays), endDay: addDays(ev.endDay, deltaDays) });
    indexEvents();
    renderGrid();
    try {
      await api.updateEvent(ev.objUrl, ev.uid, payload);
    } catch (e) {
      alert(errText(e));
    }
    load(true);
  }

  function wireDrop() {
    const grid = $('grid');
    grid.addEventListener('dragover', (e) => {
      if (!dragInfo) return;
      const cell = e.target.closest('.cell');
      if (!cell) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.cell.drop').forEach((c) => c !== cell && c.classList.remove('drop'));
      cell.classList.add('drop');
    });
    grid.addEventListener('dragleave', (e) => {
      const cell = e.target.closest('.cell');
      if (cell && !cell.contains(e.relatedTarget)) cell.classList.remove('drop');
    });
    grid.addEventListener('drop', (e) => {
      if (!dragInfo) return;
      e.preventDefault();
      const cell = e.target.closest('.cell');
      const info = dragInfo;
      dragInfo = null;
      document.querySelectorAll('.cell.drop').forEach((c) => c.classList.remove('drop'));
      if (!cell) return;
      moveEvent(info.ev, dayDiff(info.fromKey, cell.dataset.key));
    });
    document.addEventListener('dragend', () => { dragInfo = null; });
  }

  // ---------- 일정 추가·편집 창 ----------
  const comp = { mode: 'new', ev: null, cal: '', color: '', saving: false };
  const addMinutes = (hhmm, mins) => {
    const [h, m] = hhmm.split(':').map(Number);
    const t = Math.min(23 * 60 + 55, h * 60 + m + mins);
    return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
  };

  function setAllDay(on) {
    $('compAllDay').checked = on;
    $('compStartTime').classList.toggle('hidden', on);
    $('compEndTime').classList.toggle('hidden', on);
    $('quickDur').classList.toggle('hidden', on);
  }

  function renderCalPick() {
    const wrap = $('compCals');
    wrap.innerHTML = '';
    const cals = writableCals();
    const showSource = new Set(cals.map((c) => c.source)).size > 1;
    if (comp.mode === 'edit') {
      const c = calOf(comp.ev);
      const s = document.createElement('span');
      s.className = 'fixed';
      s.style.setProperty('--c', c ? c.color : comp.ev.color);
      s.innerHTML = '<span class="dot"></span>';
      s.appendChild(document.createTextNode(c ? c.name : ''));
      wrap.appendChild(s);
      return;
    }
    for (const cal of cals) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cal.key === comp.cal ? 'on' : '';
      b.style.setProperty('--c', cal.color);
      b.title = `${cal.name} · ${cal.source}`;
      b.innerHTML = '<span class="dot"></span>';
      const short = cal.source === '구글' ? 'G' : cal.source === '아이클라우드' ? 'iCloud' : (cal.source.replace(/^맥 · /, '') || '맥');
      b.appendChild(document.createTextNode(showSource ? `${cal.name} (${short})` : cal.name));
      b.onclick = () => { comp.cal = cal.key; renderCalPick(); renderSwatches(); };
      wrap.appendChild(b);
    }
  }

  function currentCalColor() {
    if (comp.mode === 'edit') { const c = calOf(comp.ev); return c ? c.color : comp.ev.calColor || comp.ev.color; }
    const c = allCals().find((x) => x.key === comp.cal);
    return c ? c.color : '#0a84ff';
  }

  function renderSwatches() {
    const wrap = $('compColors');
    wrap.innerHTML = '';
    const auto = document.createElement('button');
    auto.type = 'button';
    auto.className = 'sw auto' + (comp.color ? '' : ' on');
    auto.style.setProperty('--c', currentCalColor());
    auto.title = '캘린더 색 그대로';
    auto.onclick = () => { comp.color = ''; renderSwatches(); };
    wrap.appendChild(auto);
    for (const [hex, name] of COLORS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sw' + (comp.color === hex ? ' on' : '');
      b.style.setProperty('--c', hex);
      b.title = name;
      b.onclick = () => { comp.color = hex; renderSwatches(); };
      wrap.appendChild(b);
    }
  }

  function openComposer({ day, edit } = {}) {
    hidePopover();
    if (!hasAccount() || !writableCals().length) {
      if (confirm('일정을 추가하려면 먼저 아이클라우드나 구글 계정을 연결해야 합니다.\n설정을 열까요?')) openSettings(true);
      return;
    }
    comp.mode = edit ? 'edit' : 'new';
    comp.ev = edit || null;
    comp.saving = false;
    $('compErr').textContent = '';
    $('compSave').disabled = false;
    $('compHeading').textContent = edit ? '이벤트 편집' : '새로운 이벤트';
    $('compSave').textContent = edit ? '완료' : '추가';
    $('compDelGroup').classList.toggle('hidden', !edit);
    $('compAlarm').querySelector('option[value="keep"]').hidden = !edit;

    if (edit) {
      $('compTitle').value = edit.title;
      $('compLocation').value = edit.location || '';
      $('compNotes').value = edit.notes || '';
      comp.color = edit.ownColor || '';
      $('compAlarm').value = 'keep';
      setAllDay(edit.allDay);
      if (edit.allDay) {
        $('compStartDate').value = edit.startDay;
        $('compEndDate').value = edit.endDay;
        $('compStartTime').value = '09:00';
        $('compEndTime').value = '10:00';
      } else {
        const s = new Date(edit.start);
        const e = new Date(edit.end);
        $('compStartDate').value = keyOf(s);
        $('compStartTime').value = `${pad(s.getHours())}:${pad(s.getMinutes())}`;
        $('compEndDate').value = keyOf(e);
        $('compEndTime').value = `${pad(e.getHours())}:${pad(e.getMinutes())}`;
      }
    } else {
      const key = day || selected;
      const wc = writableCals();
      comp.cal = wc.some((c) => c.key === config.defaultCal) ? config.defaultCal : (wc[0] && wc[0].key) || '';
      comp.color = '';
      let start = '09:00';
      if (key === todayKey) {
        const h = new Date().getHours() + 1;
        start = h <= 23 ? `${pad(h)}:00` : '23:00';
      }
      $('compTitle').value = '';
      $('compLocation').value = '';
      $('compNotes').value = '';
      $('compAlarm').value = '';
      setAllDay(false);
      $('compStartDate').value = key;
      $('compEndDate').value = key;
      $('compStartTime').value = start;
      $('compEndTime').value = addMinutes(start, 60);
    }
    renderCalPick();
    renderSwatches();
    $('composer').classList.remove('hidden');
    setTimeout(() => $('compTitle').focus(), 30);
  }

  function closeComposer() {
    $('composer').classList.add('hidden');
  }

  function readComposer() {
    const title = $('compTitle').value.trim();
    if (!title) throw new Error('제목을 입력해 주세요');
    const ev = {
      title,
      location: $('compLocation').value.trim(),
      notes: $('compNotes').value.trim(),
      color: comp.color,
    };
    const alarm = $('compAlarm').value;
    if (alarm === '' && comp.mode === 'edit') ev.alarmMinutes = null; // 편집에서 '없음' = 알림 지우기
    else if (alarm !== '' && alarm !== 'keep') ev.alarmMinutes = Number(alarm);
    const sd = $('compStartDate').value;
    const ed = $('compEndDate').value || sd;
    if (!sd) throw new Error('날짜를 확인해 주세요');
    if ($('compAllDay').checked) {
      if (ed < sd) throw new Error('종료일이 시작일보다 빠릅니다');
      Object.assign(ev, { allDay: true, startDay: sd, endDay: ed });
    } else {
      const st = $('compStartTime').value;
      const en = $('compEndTime').value;
      if (!st || !en) throw new Error('시간을 확인해 주세요');
      const s = new Date(`${sd}T${st}:00`);
      let e = new Date(`${ed}T${en}:00`);
      if (e <= s && sd === ed) e = new Date(e.getTime() + 86400000); // 끝이 더 이르면 다음 날로
      if (e <= s) throw new Error('종료 시간이 시작 시간보다 빠릅니다');
      Object.assign(ev, { allDay: false, start: s.toISOString(), end: e.toISOString() });
    }
    return ev;
  }

  async function saveComposer(e) {
    if (e) e.preventDefault();
    if (comp.saving) return;
    let ev;
    try {
      ev = readComposer();
    } catch (err) {
      $('compErr').textContent = errText(err);
      return;
    }
    comp.saving = true;
    $('compSave').disabled = true;
    $('compErr').textContent = '';
    try {
      if (comp.mode === 'edit') await api.updateEvent(comp.ev.objUrl, comp.ev.uid, ev);
      else await api.createEvent(comp.cal, ev);
      closeComposer();
      const showKey = ev.allDay ? ev.startDay : keyOf(new Date(ev.start));
      selected = showKey;
      const d = parseKey(showKey);
      view = new Date(d.getFullYear(), d.getMonth(), 1);
      await load(true);
    } catch (err) {
      $('compErr').textContent = errText(err);
    } finally {
      comp.saving = false;
      $('compSave').disabled = false;
    }
  }

  async function deleteEv(ev) {
    if (!confirm(`'${ev.title}' 이벤트를 삭제할까요?\n아이폰에서도 함께 지워집니다.`)) return false;
    try {
      await api.deleteEvent(ev.objUrl, ev.etag);
      await load(true);
      return true;
    } catch (err) {
      alert(errText(err));
      return false;
    }
  }

  function wireComposer() {
    $('composerForm').addEventListener('submit', saveComposer);
    $('compClose').onclick = closeComposer;
    $('composer').addEventListener('mousedown', (e) => { if (e.target.id === 'composer') closeComposer(); });
    $('compAllDay').onchange = (e) => setAllDay(e.target.checked);
    $('compDelete').onclick = async () => { if (comp.ev && (await deleteEv(comp.ev))) closeComposer(); };
    document.querySelectorAll('#quickDur button').forEach((b) => {
      b.onclick = () => {
        $('compEndDate').value = $('compStartDate').value;
        $('compEndTime').value = addMinutes($('compStartTime').value || '09:00', Number(b.dataset.min));
      };
    });
    // 시작을 바꾸면 종료도 같은 길이만큼 따라가기
    let prev = null;
    const snap = () => (prev = { d: $('compStartDate').value, t: $('compStartTime').value });
    $('compStartTime').addEventListener('focus', snap);
    $('compStartDate').addEventListener('focus', snap);
    const follow = () => {
      if (!prev) return snap();
      const before = new Date(`${prev.d}T${prev.t || '00:00'}:00`);
      const after = new Date(`${$('compStartDate').value}T${$('compStartTime').value || '00:00'}:00`);
      if (isNaN(before) || isNaN(after)) return snap();
      if ($('compAllDay').checked) {
        const span = dayDiff(prev.d, $('compEndDate').value || prev.d);
        $('compEndDate').value = addDays($('compStartDate').value, Math.max(0, span));
      } else {
        const end = new Date(`${$('compEndDate').value}T${$('compEndTime').value}:00`);
        if (!isNaN(end)) {
          const n = new Date(end.getTime() + (after - before));
          $('compEndDate').value = keyOf(n);
          $('compEndTime').value = `${pad(n.getHours())}:${pad(n.getMinutes())}`;
        }
      }
      snap();
    };
    $('compStartTime').addEventListener('change', follow);
    $('compStartDate').addEventListener('change', follow);
    // 메모 칸에서 Enter는 줄바꿈, Ctrl+Enter는 저장
    $('compNotes').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) saveComposer(e);
    });
  }

  // ---------- 아이클라우드 설정 ----------
  function renderIcloud() {
    const box = $('icloudBox');
    box.innerHTML = '';
    const ic = config.icloud;
    const macUsing = macGranted();
    $('icloudHead').textContent = macUsing ? '아이클라우드 직접 연결 (지금은 필요 없음)' : '아이클라우드';
    if (macUsing && !ic) {
      box.innerHTML = '<div class="group"><div class="row sub small" style="line-height:1.6;padding:10px 14px">맥 캘린더로 아이클라우드 일정과 메모를 이미 쓰고 있어서 앱 암호를 넣을 필요가 없어요.</div></div>';
      return;
    }
    if (!ic) {
      box.innerHTML = `
        <div class="group">
          <div class="row" style="display:block;padding:12px 14px">
            <div style="font-weight:600;margin-bottom:4px">아이클라우드 캘린더 연결</div>
            <div class="sub small" style="line-height:1.7">
              1. <button class="link-btn" id="icOpenApple" style="font-size:11px;padding:0">account.apple.com</button> 에 로그인<br>
              2. 로그인 및 보안 → <b>앱 암호</b> → ＋ (이름: DeskCal)<br>
              3. 나온 xxxx-xxxx-xxxx-xxxx 암호를 아래에 붙여 넣기
            </div>
          </div>
          <input class="field" id="icId" placeholder="애플 ID (이메일)" />
          <input class="field" id="icPw" type="password" placeholder="앱 전용 암호" />
          <button class="row action" id="icConnect" style="color:var(--blue);justify-content:center;font-weight:600">연결</button>
        </div>
        <p class="comp-err" id="icErr" style="margin:-6px 14px 10px"></p>`;
      $('icOpenApple').onclick = () => api.openExternal('https://account.apple.com/account/manage');
      const go = async () => {
        const btn = $('icConnect');
        btn.disabled = true;
        btn.textContent = '연결 중…';
        $('icErr').textContent = '';
        try {
          config = await api.icloudConnect($('icId').value, $('icPw').value);
          applyConfig();
          await load(true);
        } catch (e) {
          $('icErr').textContent = errText(e);
          btn.disabled = false;
          btn.textContent = '연결';
        }
      };
      $('icConnect').onclick = go;
      $('icPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      return;
    }
    const g = document.createElement('div');
    g.className = 'group';
    const who = document.createElement('div');
    who.className = 'row';
    const name = document.createElement('span');
    const idText = document.createElement('span');
    idText.style.fontWeight = '600';
    idText.textContent = ic.appleId;
    const small = document.createElement('small');
    small.textContent = macUsing ? '쉬는 중 · 맥 캘린더를 쓰는 동안은 쓰지 않아요' : '연결됨';
    name.append(idText, small);
    const out = document.createElement('button');
    out.className = 'link-btn';
    out.style.fontSize = '12px';
    out.textContent = '연결 해제';
    out.onclick = async () => {
      if (!confirm('아이클라우드 연결을 해제할까요? (아이폰 일정은 지워지지 않습니다)')) return;
      config = await api.icloudDisconnect();
      applyConfig();
      load(true);
    };
    who.append(name, out);
    g.appendChild(who);
    for (const cal of ic.calendars) {
      const row = document.createElement('label');
      row.className = 'row';
      row.style.setProperty('--c', cal.color);
      const left = document.createElement('span');
      left.style.cssText = 'flex-direction:row;align-items:center;gap:10px';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'check-dot';
      cb.checked = cal.enabled !== false;
      cb.onchange = async () => {
        config = await api.icloudUpdate({ toggle: { url: cal.url, enabled: cb.checked } });
        applyConfig();
        load();
      };
      left.append(cb, document.createTextNode(cal.name));
      row.appendChild(left);
      if (cal.url === config.defaultCal) {
        const def = document.createElement('small');
        def.className = 'sub';
        def.textContent = '기본';
        row.appendChild(def);
      }
      g.appendChild(row);
    }
    box.appendChild(g);
  }

  // ---------- 맥 캘린더 설정 (맥 전용) ----------
  function renderMac() {
    const box = $('macBox');
    const head = $('macHead');
    box.innerHTML = '';
    const m = config.mac;
    const show = !!(m && m.available);
    box.classList.toggle('hidden', !show);
    head.classList.toggle('hidden', !show);
    if (!show) return;
    const g = document.createElement('div');
    g.className = 'group';
    const top = document.createElement('label');
    top.className = 'row';
    top.innerHTML = '<span>맥 캘린더 사용<small>앱 암호 없이, 맥에 로그인된 계정의 캘린더를 씁니다</small></span>';
    const sw = document.createElement('input');
    sw.type = 'checkbox';
    sw.className = 'switch';
    sw.checked = !!m.enabled;
    sw.onchange = async () => { config = await api.macUpdate({ enabled: sw.checked }); applyConfig(); load(true); loadMemo(); };
    top.appendChild(sw);
    g.appendChild(top);
    if (m.enabled && m.status !== 'granted') {
      const row = document.createElement('div');
      row.className = 'row';
      row.style.cssText = 'display:block;padding:12px 14px';
      const denied = ['denied', 'restricted', 'writeOnly'].includes(m.status);
      row.innerHTML = denied
        ? '<div style="font-weight:600;margin-bottom:4px">캘린더 접근이 꺼져 있어요</div><div class="sub small" style="line-height:1.7">아래 버튼을 누르면 맥 설정이 열립니다.<br><b>DeskCal</b>을 켜고(전체 접근) DeskCal을 다시 열어 주세요.</div>'
        : '<div style="font-weight:600;margin-bottom:4px">캘린더 접근을 허용해 주세요</div><div class="sub small" style="line-height:1.7">아래 버튼을 누르고 뜨는 창에서 <b>허용</b>을 누르면 끝이에요.</div>';
      g.appendChild(row);
      const btn = document.createElement('button');
      btn.className = 'row action';
      btn.style.cssText = 'color:var(--blue);justify-content:center;font-weight:600';
      btn.textContent = denied ? '맥 설정 열기' : '캘린더 접근 허용';
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = '기다리는 중…';
        config = await api.macRequest();
        applyConfig();
        load(true);
        loadMemo();
      };
      g.appendChild(btn);
    }
    if (m.enabled && m.status === 'granted') {
      const bySource = new Map();
      for (const cal of m.calendars || []) {
        const k = cal.source || '기타';
        if (!bySource.has(k)) bySource.set(k, []);
        bySource.get(k).push(cal);
      }
      for (const [src, cals] of bySource) {
        const t = document.createElement('div');
        t.className = 'row sub small';
        t.style.minHeight = '28px';
        t.textContent = src;
        g.appendChild(t);
        for (const cal of cals) {
          const row = document.createElement('label');
          row.className = 'row';
          row.style.setProperty('--c', cal.color);
          const left = document.createElement('span');
          left.style.cssText = 'flex-direction:row;align-items:center;gap:10px';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.className = 'check-dot';
          cb.checked = cal.enabled !== false;
          cb.onchange = async () => { config = await api.macUpdate({ toggle: { id: cal.id, enabled: cb.checked } }); applyConfig(); load(); };
          left.append(cb, document.createTextNode(cal.name));
          row.appendChild(left);
          const tag = document.createElement('small');
          tag.className = 'sub';
          tag.textContent = `ek:${cal.id}` === config.defaultCal ? '기본' : cal.writable ? '' : '보기 전용';
          row.appendChild(tag);
          g.appendChild(row);
        }
      }
      const re = document.createElement('button');
      re.className = 'row action';
      re.style.color = 'var(--blue)';
      re.textContent = '캘린더 목록 새로고침';
      re.onclick = async () => { config = await api.macUpdate({ refresh: true }); applyConfig(); load(true); };
      g.appendChild(re);
    }
    box.appendChild(g);
  }

  // ---------- 구글 설정 ----------
  function renderGoogle() {
    const box = $('googleBox');
    box.innerHTML = '';
    const gg = config.google;
    const g = document.createElement('div');
    g.className = 'group';
    if (!gg) {
      g.innerHTML = `
        <div class="row" style="display:block;padding:12px 14px">
          <div style="font-weight:600;margin-bottom:4px">구글 캘린더 연결</div>
          <div class="sub small" style="line-height:1.7">버튼을 누르면 브라우저에서 구글 로그인 창이 열립니다. 로그인하고 <b>허용</b>을 누르면 연결됩니다.<br>
          처음에 '확인되지 않은 앱' 화면이 나오면 <b>고급 → DeskCal(으)로 이동</b>을 눌러 주세요.</div>
        </div>
        <button class="row action g-login" id="gLogin"><span class="g-logo" aria-hidden="true">G</span>구글 계정으로 로그인</button>`;
      box.appendChild(g);
      const err = document.createElement('p');
      err.className = 'comp-err';
      err.id = 'gErr';
      err.style.margin = '-6px 14px 10px';
      box.appendChild(err);
      $('gLogin').onclick = async () => {
        const btn = $('gLogin');
        btn.disabled = true;
        btn.lastChild.textContent = '브라우저에서 로그인해 주세요…';
        $('gErr').textContent = '';
        try {
          config = await api.googleLogin();
          applyConfig();
          await load(true);
        } catch (e) {
          if ($('gErr')) $('gErr').textContent = errText(e);
          btn.disabled = false;
          btn.lastChild.textContent = '구글 계정으로 로그인';
        }
      };
      return;
    }
    const who = document.createElement('div');
    who.className = 'row';
    const name = document.createElement('span');
    const idText = document.createElement('span');
    idText.style.fontWeight = '600';
    idText.textContent = gg.email || '구글 계정';
    const small = document.createElement('small');
    small.textContent = '연결됨';
    name.append(idText, small);
    const out = document.createElement('button');
    out.className = 'link-btn';
    out.style.fontSize = '12px';
    out.textContent = '연결 해제';
    out.onclick = async () => {
      if (!confirm('구글 연결을 해제할까요? (구글 캘린더의 일정은 지워지지 않습니다)')) return;
      config = await api.googleDisconnect();
      applyConfig();
      load(true);
    };
    who.append(name, out);
    g.appendChild(who);
    for (const cal of gg.calendars) {
      const row = document.createElement('label');
      row.className = 'row';
      row.style.setProperty('--c', cal.color);
      const left = document.createElement('span');
      left.style.cssText = 'flex-direction:row;align-items:center;gap:10px;min-width:0';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'check-dot';
      cb.checked = cal.enabled !== false;
      cb.onchange = async () => {
        config = await api.googleUpdate({ toggle: { id: cal.id, enabled: cb.checked } });
        applyConfig();
        load();
      };
      const nm = document.createElement('span');
      nm.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      nm.textContent = cal.name;
      left.append(cb, nm);
      row.appendChild(left);
      const tag = document.createElement('small');
      tag.className = 'sub';
      tag.textContent = `g:${cal.id}` === config.defaultCal ? '기본' : cal.writable ? '' : '보기 전용';
      row.appendChild(tag);
      g.appendChild(row);
    }
    box.appendChild(g);
  }

  // 새 이벤트 기본 캘린더 (계정 상관없이 한곳에서)
  function renderDefaultCal() {
    const box = $('defaultCalBox');
    box.innerHTML = '';
    const cals = writableCals();
    if (cals.length < 2) return;
    const g = document.createElement('div');
    g.className = 'group';
    const sel = document.createElement('div');
    sel.className = 'row';
    sel.innerHTML = '<span>새 이벤트 기본 캘린더</span>';
    const s = document.createElement('select');
    for (const cal of cals) {
      const o = document.createElement('option');
      o.value = cal.key;
      o.textContent = new Set(cals.map((c) => c.source)).size > 1 ? `${cal.name} (${cal.source})` : cal.name;
      s.appendChild(o);
    }
    s.value = config.defaultCal;
    s.onchange = async () => { config = await api.setDefaultCal(s.value); applyConfig(); };
    sel.appendChild(s);
    g.appendChild(sel);
    box.appendChild(g);
  }

  function renderCalList() {
    const ul = $('calList');
    ul.innerHTML = '';
    config.calendars.forEach((cal, i) => {
      const li = document.createElement('li');
      li.style.setProperty('--c', cal.color);
      const on = document.createElement('input');
      on.type = 'checkbox';
      on.className = 'check-dot';
      on.checked = cal.enabled !== false;
      on.onchange = () => updateCal(i, { enabled: on.checked });
      const name = document.createElement('span');
      name.className = 'cal-name';
      name.textContent = cal.name;
      name.title = cal.url;
      const color = document.createElement('input');
      color.type = 'color';
      color.value = cal.color;
      color.onchange = () => updateCal(i, { color: color.value });
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '삭제';
      del.onclick = () => {
        if (confirm(`'${cal.name}' 캘린더를 목록에서 뺄까요?`)) {
          saveConfig({ calendars: config.calendars.filter((_, j) => j !== i) }).then(() => load(true));
        }
      };
      li.append(on, name, color, del);
      ul.appendChild(li);
    });
  }
  function updateCal(i, patch) {
    saveConfig({ calendars: config.calendars.map((c, j) => (j === i ? { ...c, ...patch } : c)) }).then(() => load());
  }

  async function saveConfig(patch) {
    config = await api.setConfig(patch);
    applyConfig();
    return config;
  }

  function setSeg(id, value) {
    document.querySelectorAll(`#${id} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === String(value)));
  }

  function applyConfig() {
    applyTheme();
    setSeg('themeSeg', config.theme || 'auto');
    setSeg('weekSeg', config.weekStart || 0);
    setSeg('styleSeg', config.style === 'basic' ? 'basic' : 'glass');
    $('showTerms').checked = config.showTerms !== false;
    $('showLunar').checked = !!config.showLunar;
    $('opacity').value = config.opacity;
    $('alwaysOnTop').checked = !!config.alwaysOnTop;
    $('autoStart').checked = !!config.autoStart;
    $('autoStart').disabled = !config.isPackaged;
    $('autoStartHint').textContent = config.isPackaged ? '' : '설치된 프로그램에서만 가능';
    $('blur').checked = !!config.blurPref;
    $('blur').disabled = !config.blurAvailable;
    $('blurHint').textContent = config.blurAvailable ? '바꾸면 프로그램이 다시 시작됩니다' : '윈도우 11에서만 지원';
    $('showMemo').checked = config.showMemo !== false;
    const cloudOk = !!config.icloud || macGranted();
    $('memoSync').checked = config.memoSync !== false && cloudOk;
    $('memoSync').disabled = !cloudOk;
    $('memoSyncHint').textContent = cloudOk ? '윈도우·맥에서 같은 메모를 봅니다' : '아이클라우드를 연결하면 켤 수 있어요';
    applyMemoLayout();
    applyPlatform();
    const cloudNow = !!((config.icloud || macGranted()) && config.memoSync !== false);
    if (memoCloudSeen !== null && memoCloudSeen !== cloudNow) loadMemo();
    memoCloudSeen = cloudNow;
    renderCalList();
    renderMac();
    renderIcloud();
    renderGoogle();
    renderDefaultCal();
  }

  // 맥이면 단축키 표시·문구를 맥에 맞게
  function applyPlatform() {
    const mac = config.platform === 'darwin';
    document.body.classList.toggle('mac', mac);
    document.querySelectorAll('.mod-key').forEach((k) => (k.textContent = mac ? '⌘' : 'Ctrl'));
    $('searchBtn').title = `일정 검색 (${mac ? '⌘F' : 'Ctrl+F'})`;
    if (mac) {
      $('autoStartLabel').firstChild.textContent = '맥에 로그인하면 자동 실행';
      $('hideHint').textContent = '메뉴 막대 아이콘으로 다시 열기';
      if (config.blurAvailable) $('blurHint').textContent = '바꾸면 프로그램이 다시 시작됩니다';
    }
  }

  function openSettings(focusIcloud) {
    hidePopover();
    applyConfig();
    $('settings').classList.remove('hidden');
    if (focusIcloud === true) {
      const h = $('icloudHead');
      h.scrollIntoView({ block: 'start' });
      h.classList.add('flash');
      setTimeout(() => h.classList.remove('flash'), 1200);
    }
  }
  const closeSettings = () => $('settings').classList.add('hidden');
  const anyOverlayOpen = () =>
    !$('settings').classList.contains('hidden') || !$('composer').classList.contains('hidden') || !$('arrange').classList.contains('hidden') || searchOpen();

  // ---------- 위치·크기 조정 (평소에는 잠금) ----------
  function startArrange() {
    hidePopover();
    closeSettings();
    closeComposer();
    $('arrange').classList.remove('hidden');
    api.arrange(true);
  }
  function endArrange() {
    if ($('arrange').classList.contains('hidden')) return;
    $('arrange').classList.add('hidden');
    api.arrange(false);
  }

  // ---------- 업데이트 ----------
  let upd = { status: 'idle' };
  let updDismissed = '';
  function renderUpdate() {
    const bar = $('updateBar');
    const ver = upd.version ? ` ${upd.version}` : '';
    let text = '';
    let btn = '';
    if (upd.status === 'ready') { text = `새 버전${ver} 준비 완료 · 다시 시작하면 적용돼요`; btn = '지금 다시 시작'; }
    else if (upd.status === 'available') { text = `새 버전${ver}이 나왔어요`; btn = '받으러 가기'; }
    else if (upd.status === 'downloading' && upd.manual) { text = `새 버전${ver}을 받는 중이에요… ${upd.percent || 0}%`; }
    const show = !!text && updDismissed !== `${upd.status}:${upd.version}`;
    bar.classList.toggle('hidden', !show);
    $('updateText').textContent = text;
    $('updateBtn').textContent = btn;
    $('updateBtn').classList.toggle('hidden', !btn);
    // 설정 화면
    $('verText').textContent = upd.current || '';
    const hint = {
      checking: '확인 중…',
      latest: '최신 버전이에요',
      downloading: `새 버전${ver} 받는 중 ${upd.percent || 0}%`,
      ready: `새 버전${ver} 준비됨 · 다시 시작하면 적용`,
      available: `새 버전${ver}이 있어요`,
      error: upd.message || '확인하지 못했어요',
    }[upd.status] || (upd.mode === 'auto' ? '자동 업데이트 켜짐' : '');
    $('updHint').textContent = hint;
    $('checkUpd').textContent = upd.status === 'ready' ? '지금 다시 시작' : upd.status === 'available' ? '받으러 가기' : '업데이트 확인';
    $('checkUpd').disabled = upd.status === 'checking' || upd.status === 'downloading';
  }
  async function wireUpdate() {
    try { upd = await api.updateGet(); } catch {}
    renderUpdate();
    api.on('update-state', (st) => { upd = st; renderUpdate(); });
    $('updateBtn').onclick = () => api.updateInstall();
    $('updateClose').onclick = () => { updDismissed = `${upd.status}:${upd.version}`; renderUpdate(); };
    $('checkUpd').onclick = async () => {
      if (upd.status === 'ready' || upd.status === 'available') return api.updateInstall();
      upd = await api.updateCheck();
      renderUpdate();
    };
  }

  // ---------- 월별 메모 ----------
  // 지금 보고 있는 달의 메모를 달력 아래에 보여 주고, 쓰는 대로 저장
  const monthKeyOf = (v) => `${v.getFullYear()}-${pad(v.getMonth() + 1)}`;
  let memoMonth = '';
  let memoTimer = null;
  let memoSaving = false;
  let memoCloudSeen = null;

  function setMemoState(st) {
    const el = $('memoState');
    el.classList.remove('err', 'ok');
    el.title = '';
    if (!st) { el.textContent = ''; return; }
    if (st.pending) { el.textContent = '저장 중…'; return; }
    if (!st.cloud) {
      el.textContent = hasAccount() ? '이 컴퓨터에만 저장' : '이 컴퓨터에만 저장 · 아이클라우드를 연결하면 다른 기기와 함께 봐요';
      return;
    }
    if (st.error) {
      el.textContent = '아이클라우드 저장 실패 · 이 PC에는 저장됨';
      el.title = st.error;
      el.classList.add('err');
      return;
    }
    if (st.synced) { el.textContent = '아이클라우드에 저장됨'; el.classList.add('ok'); return; }
    el.textContent = '아이클라우드에 올리는 중…';
  }

  function applyMemoLayout() {
    const on = config.showMemo !== false;
    $('memoBox').classList.toggle('hidden', !on);
    const h = Number(config.memoHeight) || 40;
    document.querySelector('.frame').style.setProperty('--memo-h', `${on ? h : 0}px`);
    // 낮으면 한 줄 모양 (제목 · 메모 · 저장 상태가 한 줄에)
    $('memoBox').classList.toggle('compact', h < 70);
  }

  async function flushMemo() {
    if (!memoTimer && !memoSaving) return;
    clearTimeout(memoTimer);
    memoTimer = null;
    const month = memoMonth;
    const text = $('memoText').value;
    memoSaving = true;
    let res;
    try {
      res = await api.memoSet(month, text);
    } catch (e) {
      res = { cloud: true, synced: false, error: errText(e) };
    }
    memoSaving = false;
    if (month === memoMonth && !memoTimer) setMemoState(res);
  }

  async function loadMemo() {
    const month = monthKeyOf(view);
    if (memoTimer) await flushMemo(); // 앞 달에 쓰던 메모 먼저 저장
    const changedMonth = month !== memoMonth;
    memoMonth = month;
    $('memoTitle').textContent = `${view.getMonth() + 1}월 메모`;
    const ta = $('memoText');
    let local;
    try { local = await api.memoGet(month); } catch { return; }
    if (memoMonth !== month) return;
    if (changedMonth || (!memoTimer && document.activeElement !== ta)) ta.value = local.text;
    setMemoState(local);
    if (local.cloud) syncMemo(month, local.text);
  }

  // 다른 기기에서 고친 메모 받아 오기 (지금 쓰는 중이면 건드리지 않음)
  async function syncMemo(month = memoMonth, shown = $('memoText').value) {
    let res;
    try { res = await api.memoSync(month); } catch { return; }
    const ta = $('memoText');
    if (memoMonth !== month || memoTimer || memoSaving) return;
    if (ta.value === shown && ta.value !== res.text) {
      const focused = document.activeElement === ta;
      const pos = ta.selectionStart;
      ta.value = res.text;
      if (focused) ta.setSelectionRange(Math.min(pos, ta.value.length), Math.min(pos, ta.value.length));
    }
    setMemoState(res);
  }

  function wireMemo() {
    const ta = $('memoText');
    ta.addEventListener('input', () => {
      clearTimeout(memoTimer);
      memoTimer = setTimeout(flushMemo, 700);
      setMemoState({ pending: true });
    });
    ta.addEventListener('blur', () => { if (memoTimer) flushMemo(); });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); ta.blur(); }
      // 한 줄 모양일 때 Enter는 줄바꿈 대신 저장하고 마치기 (Shift+Enter는 줄바꿈)
      else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && $('memoBox').classList.contains('compact')) { e.preventDefault(); ta.blur(); }
    });
    window.addEventListener('beforeunload', () => { if (memoTimer) flushMemo(); });

    // 메모칸 높이 조절 (경계선을 위아래로 끌기)
    const split = $('memoSplit');
    let drag = null;
    split.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      split.setPointerCapture(e.pointerId);
      drag = { y: e.clientY, h: Number(config.memoHeight) || 40 };
      split.classList.add('on');
    });
    split.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const max = Math.max(80, document.querySelector('.frame').clientHeight - 230);
      const h = Math.round(Math.min(max, Math.max(36, drag.h - (e.clientY - drag.y))));
      config.memoHeight = h;
      applyMemoLayout();
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      split.classList.remove('on');
      saveConfig({ memoHeight: config.memoHeight });
    };
    split.addEventListener('pointerup', end);
    split.addEventListener('pointercancel', end);
    // 두 번 누르면 한 줄 ↔ 넓게
    split.addEventListener('dblclick', () => { const h = (Number(config.memoHeight) || 40) < 70 ? 130 : 40; config.memoHeight = h; applyMemoLayout(); saveConfig({ memoHeight: h }); });

    // 2분마다, 그리고 창으로 돌아왔을 때 다른 기기 메모 받아 오기
    setInterval(() => { if (document.activeElement !== ta) syncMemo(); }, 2 * 60 * 1000);
    window.addEventListener('focus', () => { if (document.activeElement !== ta && memoMonth) syncMemo(); });
  }

  // ---------- 일정 검색 ----------
  let searchToken = 0;
  let searchTimer = null;
  let searchActive = -1;
  let searchItems = [];
  const searchOpen = () => !$('search').classList.contains('hidden');

  function openSearch() {
    hidePopover();
    closeSettings();
    $('search').classList.remove('hidden');
    const input = $('searchInput');
    input.focus();
    input.select();
    api.searchWarm();
    if (input.value.trim() && !searchItems.length) runSearch();
  }
  function closeSearch() {
    $('search').classList.add('hidden');
    searchToken++;
  }

  // 찾은 글자 굵게 표시
  function highlight(el, text, words) {
    el.textContent = '';
    const low = text.toLowerCase();
    const marks = [];
    for (const w of words) {
      let i = low.indexOf(w);
      while (w && i >= 0) { marks.push([i, i + w.length]); i = low.indexOf(w, i + w.length); }
    }
    marks.sort((a, b) => a[0] - b[0]);
    let pos = 0;
    for (const [a, b] of marks) {
      if (a < pos) continue;
      if (a > pos) el.appendChild(document.createTextNode(text.slice(pos, a)));
      const m = document.createElement('mark');
      m.textContent = text.slice(a, b);
      el.appendChild(m);
      pos = b;
    }
    if (pos < text.length) el.appendChild(document.createTextNode(text.slice(pos)));
  }

  function setSearchActive(i) {
    const lis = [...$('searchList').querySelectorAll('li.hit')];
    if (!lis.length) { searchActive = -1; return; }
    searchActive = Math.max(0, Math.min(lis.length - 1, i));
    lis.forEach((li, n) => li.classList.toggle('active', n === searchActive));
    lis[searchActive].scrollIntoView({ block: 'nearest' });
  }

  function renderSearch(res, words) {
    const list = $('searchList');
    list.innerHTML = '';
    searchItems = res.results || [];
    searchActive = -1;
    const info = [];
    if (!searchItems.length) info.push('찾는 일정이 없어요');
    else info.push(`${res.total}개 찾음${res.total > searchItems.length ? ` · 최근 ${searchItems.length}개만 보여 줘요` : ''}`);
    if (res.range) info.push(`${res.range[0]}년 전 ~ ${res.range[1]}년 뒤 일정에서 찾았어요`);
    $('searchInfo').textContent = info.join(' · ');
    if (res.errors && res.errors.length) {
      const s = document.createElement('span');
      s.className = 'err';
      s.textContent = ` · 일부 캘린더를 못 읽었어요 (${res.errors.map((e) => e.name).join(', ')})`;
      $('searchInfo').appendChild(s);
    }
    let lastMonth = '';
    const todayK = keyOf(new Date());
    let todayLine = false;
    searchItems.forEach((ev, idx) => {
      const ym = ev.startDay.slice(0, 7);
      if (!todayLine && ev.startDay < todayK && idx > 0 && searchItems[idx - 1].startDay >= todayK) {
        const li = document.createElement('li');
        li.className = 'now-line';
        li.textContent = '오늘';
        list.appendChild(li);
        todayLine = true;
      }
      if (ym !== lastMonth) {
        lastMonth = ym;
        const h = document.createElement('li');
        h.className = 'month';
        const [y, m] = ym.split('-').map(Number);
        h.textContent = `${y}년 ${m}월`;
        list.appendChild(h);
      }
      const li = document.createElement('li');
      li.className = 'hit' + (ev.startDay < todayK ? ' past' : '');
      li.style.setProperty('--c', ev.color);
      const d = parseKey(ev.startDay);
      li.innerHTML = '<span class="when"><b></b><small></small></span><span class="dot"></span><span class="what"><span class="n"></span><span class="w"></span></span>';
      li.querySelector('.when b').textContent = `${d.getDate()}일`;
      li.querySelector('.when small').textContent = `${WEEK[d.getDay()]} ${ev.allDay ? '종일' : fmtTime(ev.start)}`;
      highlight(li.querySelector('.n'), ev.title, words);
      const where = [ev.location, ev.notes && words.some((w) => !ev.title.toLowerCase().includes(w) && !(ev.location || '').toLowerCase().includes(w)) ? ev.notes.replace(/\s+/g, ' ').slice(0, 80) : ''].filter(Boolean).join(' · ');
      highlight(li.querySelector('.w'), where, words);
      li.title = `${dayLabel(ev.startDay)} ${ev.title}`;
      li.addEventListener('click', () => jumpToEvent(ev));
      list.appendChild(li);
    });
  }

  async function runSearch(force = false) {
    const q = $('searchInput').value.trim();
    const token = ++searchToken;
    if (!q) {
      $('searchList').innerHTML = '';
      $('searchInfo').textContent = '제목, 장소, 메모에 들어 있는 낱말로 찾아요. 띄어 쓰면 모두 들어간 일정만 찾아요.';
      searchItems = [];
      return;
    }
    $('searchInfo').textContent = '찾는 중… (처음 한 번은 일정을 모으느라 몇 초 걸려요)';
    let res;
    try {
      res = await api.search(q, force);
    } catch (e) {
      res = { results: [], total: 0, errors: [{ name: '검색', message: errText(e) }] };
    }
    if (token !== searchToken) return;
    renderSearch(res, q.toLowerCase().split(/\s+/).filter(Boolean));
  }

  // 검색 결과를 누르면 그 날짜로 가서 일정 보여 주기
  async function jumpToEvent(ev) {
    closeSearch();
    const d = parseKey(ev.startDay);
    view = new Date(d.getFullYear(), d.getMonth(), 1);
    selected = ev.startDay;
    const [from, to] = rangeOf(view);
    const cached = monthCache.get(`${from}|${to}`);
    if (cached) show(cached);
    else { events = []; indexEvents(); }
    renderAll();
    loadMemo();
    await load();
    const cell = document.querySelector(`.cell[data-key="${ev.startDay}"]`);
    if (!cell) return;
    cell.classList.add('flash');
    setTimeout(() => cell.classList.remove('flash'), 1600);
    const same = events.find((x) => x.uid === ev.uid && x.startDay === ev.startDay && (x.start || '') === (ev.start || '')) || ev;
    const chip = [...cell.querySelectorAll('.chip')].find((c) => c.title === same.title);
    showPopover(same, chip || cell);
  }

  function wireSearch() {
    $('searchBtn').onclick = () => (searchOpen() ? closeSearch() : openSearch());
    $('searchClose').onclick = closeSearch;
    const input = $('searchInput');
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(), 250);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSearchActive(searchActive + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSearchActive(searchActive - 1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const lis = [...$('searchList').querySelectorAll('li.hit')];
        if (searchActive >= 0 && lis[searchActive]) lis[searchActive].click();
        else if (lis.length) lis[0].click();
        else runSearch(true);
      } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSearch(); }
    });
    api.on('open-search', openSearch);
    runSearch();
  }

  // ---------- 연결 ----------
  function wire() {
    wireUpdate();
    $('prevBtn').onclick = () => goMonth(-1);
    $('nextBtn').onclick = () => goMonth(1);
    $('todayBtn').onclick = goToday;
    $('titleBtn').onclick = goToday;
    $('syncBtn').onclick = () => load(true);
    $('addBtn').onclick = () => openComposer({ day: selected });
    $('menuBtn').onclick = () => openSettings();
    $('closeSettings').onclick = closeSettings;
    $('settings').addEventListener('mousedown', (e) => { if (e.target.id === 'settings') closeSettings(); });
    $('hideBtn').onclick = () => { closeSettings(); api.hide(); };
    $('arrangeBtn').onclick = startArrange;
    $('arrangeDone').onclick = endArrange;
    api.on('start-arrange', startArrange);
    $('quitBtn').onclick = () => api.quit();

    $('popEdit').onclick = () => { const ev = popEvent; if (ev) openComposer({ edit: ev }); };
    $('popDel').onclick = async () => { const ev = popEvent; if (ev) { hidePopover(); await deleteEv(ev); } };

    $('grid').addEventListener('click', (e) => {
      hidePopover();
      if (searchOpen()) closeSearch();
      const cell = e.target.closest('.cell');
      if (!cell) return;
      selected = cell.dataset.key;
      document.querySelectorAll('.cell.selected').forEach((c) => c.classList.remove('selected'));
      cell.classList.add('selected');
    });
    $('grid').addEventListener('dblclick', (e) => {
      const cell = e.target.closest('.cell');
      if (cell) openComposer({ day: cell.dataset.key });
    });
    wireComposer();
    wireDrop();
    wireMemo();
    wireSearch();

    document.addEventListener('mousedown', (e) => {
      if (!$('evPop').classList.contains('hidden') && !e.target.closest('#evPop') && !e.target.closest('.chip') && !e.target.closest('.more')) hidePopover();
    });
    document.addEventListener('keydown', (e) => {
      // Ctrl+F (맥은 ⌘F): 일정 검색
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'f' || e.key === 'F' || e.key === 'ㄹ')) {
        e.preventDefault();
        if ($('composer').classList.contains('hidden') && $('arrange').classList.contains('hidden')) openSearch();
        return;
      }
      if (e.key === 'Escape' || (e.key === 'Enter' && !$('arrange').classList.contains('hidden'))) {
        if (!$('arrange').classList.contains('hidden')) endArrange();
        else if (e.key === 'Escape' && searchOpen()) closeSearch();
        else if (e.key !== 'Escape') return;
        else if (!$('composer').classList.contains('hidden')) closeComposer();
        else if (!$('settings').classList.contains('hidden')) closeSettings();
        else hidePopover();
        return;
      }
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
      if (typing || anyOverlayOpen() || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === 'ArrowLeft') goMonth(-1);
      else if (e.key === 'ArrowRight') goMonth(1);
      else if (e.key === 't' || e.key === 'T' || e.key === 'ㅅ') goToday();
      else if (e.key === 'n' || e.key === 'N' || e.key === 'ㅜ') { e.preventDefault(); openComposer({ day: selected }); }
    });

    let wheelLock = 0;
    $('grid').addEventListener('wheel', (e) => {
      const now = Date.now();
      if (now - wheelLock < 350 || Math.abs(e.deltaY) < 20) return;
      wheelLock = now;
      goMonth(e.deltaY > 0 ? 1 : -1);
    }, { passive: true });

    document.querySelectorAll('#themeSeg button').forEach((b) => (b.onclick = () => saveConfig({ theme: b.dataset.v })));
    document.querySelectorAll('#weekSeg button').forEach((b) => (b.onclick = () => saveConfig({ weekStart: Number(b.dataset.v) }).then(() => { renderAll(); load(); })));
    $('showTerms').onchange = (e) => saveConfig({ showTerms: e.target.checked }).then(renderAll);
    $('showLunar').onchange = (e) => saveConfig({ showLunar: e.target.checked }).then(renderAll);
    $('showMemo').onchange = (e) => saveConfig({ showMemo: e.target.checked });
    document.querySelectorAll('#styleSeg button').forEach((b) => (b.onclick = async () => {
      const glass = b.dataset.v === 'glass';
      const needBlur = glass && config.blurAvailable && !config.blurActive;
      await saveConfig({ style: b.dataset.v, ...(needBlur ? { blur: true } : {}) });
      if (needBlur) api.relaunch(); // 바탕이 비치는 효과는 다시 켜야 적용됨
    }));
    $('memoSync').onchange = (e) => saveConfig({ memoSync: e.target.checked });
    $('opacity').oninput = (e) => saveConfig({ opacity: Number(e.target.value) });
    $('alwaysOnTop').onchange = (e) => saveConfig({ alwaysOnTop: e.target.checked });
    $('autoStart').onchange = (e) => saveConfig({ autoStart: e.target.checked });
    $('blur').onchange = async (e) => { await saveConfig({ blur: e.target.checked }); api.relaunch(); };
    document.querySelectorAll('[data-size]').forEach((b) => {
      b.onclick = () => { const [w, h] = b.dataset.size.split(',').map(Number); api.resizeTo(w, h); };
    });

    $('addCal').onclick = async () => {
      const name = $('newName').value.trim() || '내 캘린더';
      const url = $('newUrl').value.trim();
      if (!/^(https|webcal):\/\//i.test(url)) { alert('주소는 https:// 또는 webcal:// 로 시작해야 합니다.'); return; }
      await saveConfig({ calendars: [...config.calendars, { id: `cal-${Date.now()}`, name, url, color: $('newColor').value, enabled: true }] });
      $('newName').value = '';
      $('newUrl').value = '';
      $('addBox').open = false;
      await load(true);
    };

    // 크기 조절 손잡이 (흐림 효과일 때는 창 가장자리로 조절)
    const grip = $('grip');
    let drag = null;
    grip.addEventListener('pointerdown', async (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const [w, h] = await api.getSize();
      drag = { x: e.screenX, y: e.screenY, w, h, pending: false };
    });
    grip.addEventListener('pointermove', (e) => {
      if (!drag || drag.pending) return;
      drag.pending = true;
      const { x, y, w, h } = drag;
      const sx = e.screenX, sy = e.screenY;
      requestAnimationFrame(() => { if (!drag) return; api.resizeTo(w + (sx - x), h + (sy - y)); drag.pending = false; });
    });
    const endDrag = () => { drag = null; };
    grip.addEventListener('pointerup', endDrag);
    grip.addEventListener('pointercancel', endDrag);

    api.on('open-settings', () => openSettings());
    api.on('refresh', () => load(true));
    api.on('config-changed', (c) => { config = c; applyConfig(); });

    new ResizeObserver(() => { hidePopover(); fillChips(); }).observe($('grid'));

    setInterval(() => {
      const k = keyOf(new Date());
      if (k !== todayKey) {
        if (selected === todayKey) selected = k;
        todayKey = k;
        renderAll();
      }
    }, 60 * 1000);
    // 2분마다 새로 가져오기 (아이클라우드·구글은 매번, 링크 캘린더는 5분 이상 지났을 때만)
    setInterval(() => load(), 2 * 60 * 1000);
    window.addEventListener('focus', () => { if (Date.now() - lastUpdated > 60 * 1000) load(); });
  }

  async function start() {
    config = await api.getConfig();
    applyConfig();
    wire();
    renderAll();
    load();
    loadMemo();
  }
  start();
})();
