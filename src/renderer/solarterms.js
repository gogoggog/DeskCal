// 24절기 계산 (태양의 위치로 계산, 한국 시간 기준)
(function (root) {
  const NAMES = {
    0: '춘분', 15: '청명', 30: '곡우', 45: '입하', 60: '소만', 75: '망종',
    90: '하지', 105: '소서', 120: '대서', 135: '입추', 150: '처서', 165: '백로',
    180: '추분', 195: '한로', 210: '상강', 225: '입동', 240: '소설', 255: '대설',
    270: '동지', 285: '소한', 300: '대한', 315: '입춘', 330: '우수', 345: '경칩',
  };
  const rad = Math.PI / 180;
  const norm = (x) => ((x % 360) + 360) % 360;

  // 태양의 겉보기 황경 (도)
  function sunLongitude(ms) {
    const jd = ms / 86400000 + 2440587.5;
    const T = (jd - 2451545.0) / 36525;
    const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
    const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * rad;
    const C =
      (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M) +
      (0.019993 - 0.000101 * T) * Math.sin(2 * M) +
      0.000289 * Math.sin(3 * M);
    const omega = (125.04 - 1934.136 * T) * rad;
    return norm(L0 + C - 0.00569 - 0.00478 * Math.sin(omega));
  }

  // 한국 시간으로 그 날(00:00~24:00) 사이에 절기가 들면 이름을 돌려줌
  function solarTermOn(y, m, d) {
    const start = Date.UTC(y, m - 1, d) - 9 * 3600000;
    const end = start + 86400000;
    const a = sunLongitude(start);
    let b = sunLongitude(end);
    if (b < a) b += 360;
    const k = Math.ceil(a / 15) * 15;
    if (k <= b && k > a - 1e-9) return NAMES[norm(k)] || null;
    return null;
  }

  root.solarTermOn = solarTermOn;
  if (typeof module !== 'undefined') module.exports = { solarTermOn };
})(typeof window !== 'undefined' ? window : globalThis);
