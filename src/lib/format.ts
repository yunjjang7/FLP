/** 만원 단위 숫자를 읽기 쉬운 문자열로: 12500 → "1.25억", 3500 → "3,500만" */
export function won(v: number, withUnit = true) {
  if (!Number.isFinite(v)) return '-';
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  let s: string;
  if (a >= 10000) {
    const eok = a / 10000;
    s = `${eok >= 100 ? Math.round(eok).toLocaleString('ko-KR') : eok.toFixed(eok >= 10 ? 1 : 2).replace(/\.?0+$/, '')}억`;
  } else {
    s = `${Math.round(a).toLocaleString('ko-KR')}만`;
  }
  return sign + s + (withUnit ? '원' : '');
}

export const pct = (v: number, digits = 0) => (Number.isFinite(v) ? `${v.toFixed(digits)}%` : '-');

export const num = (v: number) => Math.round(v).toLocaleString('ko-KR');

/** [2027, 2028, 2031, 2032] → "2027~2028, 2031~2032년" (세 구간부터는 ‘외’) */
export function yearRanges(years: number[]) {
  if (years.length === 0) return '';
  const parts: string[] = [];
  let a = years[0];
  let b = years[0];
  for (const y of [...years.slice(1), NaN]) {
    if (y === b + 1) { b = y; continue; }
    parts.push(a === b ? `${a}` : `${a}~${b}`);
    a = b = y;
  }
  return `${parts.slice(0, 2).join(', ')}년${parts.length > 2 ? ' 외' : ''}`;
}
