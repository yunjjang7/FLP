import type { Draw } from '../types';
import { pensionLimit, type TaxRow } from './tax';

/** 연금계좌 밖 자산(ISA·일반계좌 등)에서 꺼낸 돈을 적는 계좌 이름 */
export const OTHER_ACCOUNT = 'ISA·일반';

export const monthKey = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`;

/** ‘2026-11’, ‘2026/11’, ‘2026.11’, ‘2026-11-03’, ‘202611’ → ‘2026-11’. 알 수 없으면 null */
export function parseMonth(v: unknown): string | null {
  const m = String(v ?? '').trim().match(/^(\d{4})\s*[-./년]?\s*(\d{1,2})/);
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? monthKey(Number(m[1]), month) : null;
}

export interface DrawAccount {
  name: string;
  owner: 'self' | 'spouse' | null; // null: ISA·일반 또는 계획에 없는(이름이 바뀐) 계좌
  planned: boolean; // 지금 계획(연금 세금 계산)에 있는 계좌
  yearNo: number | null; // 연금수령연차(연금계좌만)
  planYear: number; // 그 해 계획 세전 인출액(명목)
  planMonth: number; // 월 정기지급 금액 = 그 해 계획 ÷ 계획 개월 수
  planToDate: number; // 지난 달(이번 달 포함)까지의 계획 누적
  actual: number; // 그 해 실제 인출 누적(세전)
  limit: number | null; // 연금수령한도(명목). null = 해당 없음, Infinity = 한도 없음(11년차~), 0 = 아직 연금수령 불가
  overLimit: number; // 누적 실제 인출이 연금수령한도를 넘은 금액
}

export interface DrawMonth {
  month: string; // YYYY-MM
  m: number; // 1~12
  inPlan: boolean; // 계획 기간에 드는 달(첫해는 계획 시작 달부터)
  past: boolean; // 이미 지났거나 이번 달
  cells: number[]; // 계좌별 실제 인출(accounts 순서)
  notes: string[]; // 그 달 메모
  actual: number; // 그 달 실제 합계
  plan: number; // 그 달 계획 합계
}

export interface DrawReview {
  year: number;
  months: number; // 그 해 계획 개월 수(첫해는 남은 달)
  firstMonth: number; // 계획이 시작되는 달
  elapsed: number; // 계획 기간 가운데 지난 달 수(이번 달 포함)
  accounts: DrawAccount[];
  rows: DrawMonth[];
  planYear: number; // 그 해 계획 합계(세전, 명목)
  planToDate: number;
  actual: number; // 그 해 실제 합계
  hasPlan: boolean;
}

/**
 * 엑셀 ‘월별인출표’: 그 해 계좌별 인출 계획(연금 세금 계산의 한 행)을 달로 나눠 실제 인출 기록과 비교.
 * 계획은 연 계획 ÷ 계획 개월 수(첫해는 firstMonth 부터 12월까지), 실제는 세전 금액.
 * 연 누적 실제 인출이 계좌별 연금수령한도(연초 평가액 ÷ (11 − 연차) × 120%)를 넘으면 overLimit 에 넘은 금액.
 * row 가 없으면(계획 시작 전의 해) 기록만 모아 보여 줌.
 */
export function reviewDraws(row: TaxRow | undefined, year: number, records: Draw[], at: { firstMonth?: number; nowYear: number; nowMonth: number }): DrawReview {
  const firstMonth = row ? Math.min(12, Math.max(1, Math.round(at.firstMonth ?? 1))) : 1;
  const months = 13 - firstMonth;
  const elapsed = !row || year > at.nowYear ? 0 : year < at.nowYear ? months : Math.min(months, Math.max(0, at.nowMonth - firstMonth + 1));
  const mine = records.filter((r) => r.month.startsWith(`${year}-`) && r.amount > 0);
  const base: Pick<DrawAccount, 'name' | 'owner' | 'planned' | 'yearNo' | 'planYear' | 'limit'>[] = row
    ? [
        ...row.accounts.map((a) => ({ name: a.name, owner: a.owner, planned: true, yearNo: a.yearNo, planYear: a.drawn, limit: pensionLimit(a.start, a.yearNo) as number | null })),
        { name: OTHER_ACCOUNT, owner: null, planned: true, yearNo: null, planYear: row.otherDrawn, limit: null },
      ]
    : [];
  // 계획에 없는 이름으로 적힌 기록(계좌 이름을 바꿨거나 계획 시작 전)은 뒤에 따로 보여 줌
  for (const r of mine) if (!base.some((a) => a.name === r.account)) base.push({ name: r.account, owner: null, planned: false, yearNo: null, planYear: 0, limit: null });
  const sumOf = (name: string) => mine.filter((r) => r.account === name).reduce((s, r) => s + r.amount, 0);
  const accounts: DrawAccount[] = base.map((a) => {
    const actual = sumOf(a.name);
    const planMonth = a.planYear / months;
    return { ...a, planMonth, planToDate: planMonth * elapsed, actual, overLimit: a.limit === null || a.limit === Infinity ? 0 : Math.max(0, actual - a.limit) };
  });
  const planMonthTotal = accounts.reduce((s, a) => s + a.planMonth, 0);
  const rows: DrawMonth[] = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    const month = monthKey(year, m);
    const here = mine.filter((r) => r.month === month);
    const cells = accounts.map((a) => here.filter((r) => r.account === a.name).reduce((s, r) => s + r.amount, 0));
    const inPlan = !!row && m >= firstMonth;
    return {
      month,
      m,
      inPlan,
      past: year < at.nowYear || (year === at.nowYear && m <= at.nowMonth),
      cells,
      notes: here.map((r) => r.note ?? '').filter(Boolean),
      actual: cells.reduce((s, v) => s + v, 0),
      plan: inPlan ? planMonthTotal : 0,
    };
  });
  return {
    year,
    months,
    firstMonth,
    elapsed,
    accounts,
    rows,
    planYear: accounts.reduce((s, a) => s + a.planYear, 0),
    planToDate: planMonthTotal * elapsed,
    actual: accounts.reduce((s, a) => s + a.actual, 0),
    hasPlan: !!row,
  };
}

/** 그 해 실제 인출 합계(세전): 연말결산 ‘그 해 실제 인출’에 넣을 값 */
export const drawTotal = (records: Draw[], year: number) => records.filter((r) => r.month.startsWith(`${year}-`) && r.amount > 0).reduce((s, r) => s + r.amount, 0);

/** 기록이 있는 연도(오름차순) */
export const drawYears = (records: Draw[]) => [...new Set(records.map((r) => Number(r.month.slice(0, 4))).filter((y) => Number.isFinite(y) && y > 0))].sort((a, b) => a - b);
