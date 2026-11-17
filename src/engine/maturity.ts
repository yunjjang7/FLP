import type { Asset, AssetType, Purpose } from '../types';

/**
 * 예금·적금 만기 연월. 만기 전에 깨면 약정 이자 대신 중도해지 이율을 받으므로
 * 비상금으로 바로 쓸 수 있는지, 목적자금이 목표 시점 전에 돌아오는지를 점검함(노후 시뮬레이션에는 쓰지 않음).
 */
export const MATURITY_TYPES: AssetType[] = ['deposit', 'savings'];
export const canMaturity = (a: Pick<Asset, 'type'>) => MATURITY_TYPES.includes(a.type);
/** 만기 연도를 넣은 예금·적금 */
export const hasMaturity = (a: Pick<Asset, 'type' | 'maturityYear'>) => canMaturity(a) && (a.maturityYear ?? 0) > 0;

/** 만기 월(1~12)이 아니면 undefined */
const monthOf = (m?: number) => (m !== undefined && Number.isInteger(m) && m >= 1 && m <= 12 ? m : undefined);

/** "2027년 3월"(월이 없으면 "2027년") */
export const maturityLabel = (a: Pick<Asset, 'maturityYear' | 'maturityMonth'>) => {
  const m = monthOf(a.maturityMonth);
  return `${a.maturityYear}년${m ? ` ${m}월` : ''}`;
};

/** 비상금으로 바로 쓸 수 있다고 보는 남은 기간: 만기가 이 개월 수보다 더 남으면 ‘묶인 돈’ */
export const EMERGENCY_LOCK_MONTHS = 3;

/**
 * 이번 달부터 만기 달까지 개월 수(만기 월을 비우면 그 해 12월로 봄 — 늦게 잡아 보수적으로).
 * 0이면 이번 달 만기, 음수면 지남
 */
export function monthsToMaturity(a: Pick<Asset, 'maturityYear' | 'maturityMonth'>, nowYear: number, nowMonth = 1) {
  return ((a.maturityYear ?? 0) - nowYear) * 12 + ((monthOf(a.maturityMonth) ?? 12) - nowMonth);
}

export interface MaturityRow {
  name: string;
  type: AssetType;
  purpose: Purpose;
  amount: number;
  year: number;
  month?: number;
  monthsLeft: number; // 음수면 만기 지남
}

/** 만기 연도를 넣은 예금·적금(평가액 > 0), 만기가 빠른 순 */
export function maturities(assets: Asset[], nowYear: number, nowMonth = 1): MaturityRow[] {
  return assets
    .filter((a) => hasMaturity(a) && a.amount > 0)
    .map((a) => ({
      name: a.name || (a.type === 'savings' ? '적금' : '예금'),
      type: a.type,
      purpose: a.purpose,
      amount: a.amount,
      year: a.maturityYear!,
      ...(monthOf(a.maturityMonth) ? { month: monthOf(a.maturityMonth) } : {}),
      monthsLeft: monthsToMaturity(a, nowYear, nowMonth),
    }))
    .sort((x, y) => x.monthsLeft - y.monthsLeft);
}

/** 비상금(단기 용도) 가운데 만기가 3개월 넘게 남은 예금·적금 금액 */
export const emergencyLockedOf = (rows: MaturityRow[]) =>
  rows.filter((r) => r.purpose === 'short' && r.monthsLeft > EMERGENCY_LOCK_MONTHS).reduce((s, r) => s + r.amount, 0);

export interface GoalTimingGap {
  name: string; // 목표 이름
  goalYear: number;
  /** 이 목표에 배정한 목적자금 가운데 목표 해까지 만기가 오지 않는 돈으로만 채울 수 있는 금액 */
  short: number;
  /** 목표 해보다 늦게 만기가 오는 중기 예금·적금 */
  late: MaturityRow[];
}

/**
 * 목적자금 시점 맞추기: 목표를 시기 순으로 보며, 그 해까지 배정한 목적자금 누계가
 * ‘중기·목적자금 합계 − 그 해 뒤에 만기가 오는 중기 예금·적금’보다 크면 그만큼은 중도해지해야 함.
 * 만기 연도가 목표 해와 같으면 제때 돌아온다고 봄(목표 월은 모름).
 */
export function goalTimingGaps(
  plans: { goal: { name: string }; years: number; allocated: number }[],
  midTotal: number,
  rows: MaturityRow[],
  nowYear: number,
): GoalTimingGap[] {
  const mid = rows.filter((r) => r.purpose === 'mid' && r.monthsLeft > 0);
  if (!mid.length) return [];
  let cum = 0;
  const out: GoalTimingGap[] = [];
  for (const p of [...plans].sort((a, b) => a.years - b.years)) {
    if (!(p.allocated > 0)) continue;
    cum += p.allocated;
    const goalYear = nowYear + p.years;
    const late = mid.filter((r) => r.year > goalYear);
    const usable = midTotal - late.reduce((s, r) => s + r.amount, 0);
    const short = Math.min(p.allocated, cum - usable);
    if (short > 0.5) out.push({ name: p.goal.name || '목표', goalYear, short, late });
  }
  return out;
}
