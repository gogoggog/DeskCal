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
    if (!config.calendars.length && !config.icloud && !config.google) {
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
    if (config.icloud) for (const c of config.icloud.calendars || []) list.push({ key: c.url, name: c.name, color: c.color, source: '아이클라우드', writable: true });
    if (config.google) for (const c of config.google.calendars || []) list.push({ key: `g:${c.id}`, name: c.name, color: c.color, source: '구글', writable: !!c.writable });
    return list;
  }
  const writableCals = () => allCals().filter((c) => c.writable);
  const hasAccount = () => !!(config.icloud || config.google);
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
    $('popNote').textContent = ev.recurring ? '반복 일정은 아이폰에서 수정해 주세요' : '';
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
  async function load(force = false) {
    const days = gridDays();
    const token = ++loadToken;
    loading = true;
    renderStatus();
    try {
      const res = await api.getEvents(keyOf(days[0]), keyOf(days[days.length - 1]), force);
      if (token !== loadToken) return;
      events = res.events;
      lastErrors = res.errors;
      lastUpdated = res.updatedAt;
    } catch (e) {
      if (token !== loadToken) return;
      lastErrors = [{ name: '전체', message: errText(e) }];
    }
    loading = false;
    indexEvents();
    renderAll();
  }

  function goMonth(delta) {
    view = new Date(view.getFullYear(), view.getMonth() + delta, 1);
    renderAll();
    load();
  }
  function goToday() {
    view = new Date();
    view.setDate(1);
    selected = todayKey;
    renderAll();
    load();
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
    const showSource = !!(config.icloud && config.google);
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
      b.appendChild(document.createTextNode(showSource ? `${cal.name} (${cal.source === '구글' ? 'G' : 'iCloud'})` : cal.name));
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
    small.textContent = '연결됨';
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
      o.textContent = config.icloud && config.google ? `${cal.name} (${cal.source})` : cal.name;
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
    renderCalList();
    renderIcloud();
    renderGoogle();
    renderDefaultCal();
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
    !$('settings').classList.contains('hidden') || !$('composer').classList.contains('hidden') || !$('arrange').classList.contains('hidden');

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

  // ---------- 연결 ----------
  function wire() {
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

    document.addEventListener('mousedown', (e) => {
      if (!$('evPop').classList.contains('hidden') && !e.target.closest('#evPop') && !e.target.closest('.chip') && !e.target.closest('.more')) hidePopover();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && !$('arrange').classList.contains('hidden'))) {
        if (!$('arrange').classList.contains('hidden')) endArrange();
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
  }
  start();
})();
