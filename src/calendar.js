// 캘린더(.ics) 주소에서 일정을 가져와 화면에 쓰기 좋은 형태로 바꿔 주는 부분
const ical = require('node-ical');

const pad = (n) => String(n).padStart(2, '0');
// 날짜를 "2026-10-19" 같은 문자열로 (내 PC 시간대 기준)
function dayKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 종일 일정 날짜는 시간대와 무관하게 '그 날짜' 그대로 써야 해서 따로 처리
function allDayKey(d) {
  if (d && d.dateOnly) return dayKey(d);
  // 일부 캘린더는 종일 일정을 UTC 자정으로 줌
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) {
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  return dayKey(d);
}

function normalizeUrl(url) {
  return String(url || '').trim().replace(/^webcal:\/\//i, 'https://');
}

async function downloadIcs(url) {
  const res = await fetch(normalizeUrl(url), {
    headers: { 'User-Agent': 'DeskCal/1.0' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('캘린더(.ics) 주소가 아닌 것 같습니다');
  return text;
}

// ics 텍스트 → 기간 안의 일정 목록
function extractEvents(icsText, from, to) {
  const data = ical.sync.parseICS(icsText);
  const out = [];
  for (const item of Object.values(data)) {
    if (!item || item.type !== 'VEVENT' || !item.start) continue;
    if (item.status === 'CANCELLED') continue;
    let instances;
    try {
      instances = ical.expandRecurringEvent(item, { from, to, expandOngoing: true });
    } catch (e) {
      continue; // 형식이 깨진 일정 하나 때문에 전체가 멈추지 않도록
    }
    const valOf = (v) => (v == null ? '' : String(v.val ?? v));
    const extra = {
      uid: valOf(item.uid),
      location: valOf(item.location),
      notes: valOf(item.description),
      ownColor: (() => {
        const c = valOf(item['DESKCAL-COLOR'] || item['X-DESKCAL-COLOR'] || item['x-deskcal-color']).trim();
        return /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : '';
      })(),
      hasAlarm: Object.values(item).some((v) => v && typeof v === 'object' && v.type === 'VALARM') || !!item.alarms,
    };
    for (const inst of instances) {
      const title = String(
        (inst.summary && (inst.summary.val ?? inst.summary)) || '(제목 없음)'
      );
      if (inst.isFullDay) {
        const startKey = allDayKey(inst.start);
        // 종일 일정의 끝 날짜는 '다음 날'로 들어 있으므로 하루 빼기
        let endKey = startKey;
        if (inst.end) {
          const e = new Date(inst.end.getTime());
          const endExclusive = allDayKey(e);
          const [y, m, d] = endExclusive.split('-').map(Number);
          const last = new Date(y, m - 1, d - 1);
          endKey = dayKey(last) < startKey ? startKey : dayKey(last);
        }
        out.push({ ...extra, title, allDay: true, startDay: startKey, endDay: endKey, recurring: !!(inst.isRecurring || item.rrule) });
      } else {
        const s = new Date(inst.start.getTime());
        const e = inst.end ? new Date(inst.end.getTime()) : new Date(s.getTime());
        // 자정에 끝나는 일정은 전날까지로 표시
        const endForDay = new Date(Math.max(s.getTime(), e.getTime() - 1));
        out.push({
          ...extra,
          title,
          allDay: false,
          start: s.toISOString(),
          end: e.toISOString(),
          startDay: dayKey(s),
          endDay: dayKey(endForDay),
          recurring: !!(inst.isRecurring || item.rrule),
        });
      }
    }
  }
  return out;
}

module.exports = { downloadIcs, extractEvents, normalizeUrl, dayKey };
