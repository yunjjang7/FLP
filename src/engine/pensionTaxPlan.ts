import type { Asset, Profile } from '../types';
import { withdrawStart, type PlanInput } from './montecarlo';
import { pensionTaxSchedule, taxSetup } from './tax';
import { compareStrategy, DEFAULT_GUARDRAIL, type StrategyKey, type WithdrawInput } from './withdrawal';

/**
 * 노후 진단 계획(PlanInput)에서 인출 계획 입력을 만듦(인출 계획 화면 기본값과 같음).
 * 연금 인출 세금(pensionTax)은 인출 계획이 직접 계산하므로 지출에서 뺌.
 */
export function withdrawInputOf(
  inp: PlanInput,
  start: { age: number; retired: boolean },
  o: { endAge: number; inflation: number; startBalance: number; percentRate?: number; guardrail?: WithdrawInput['guardrail'] },
): WithdrawInput {
  const startAge = start.age;
  return {
    startAge,
    endAge: o.endAge,
    startBalance: o.startBalance,
    expenseAnnual: inp.retireExpenseAnnual,
    expenseGrowth: inp.expenseGrowth,
    expenseSteps: inp.expenseSteps,
    fixedDraw: inp.fixedDraw,
    inflows: inp.inflows?.filter((x) => x.age >= startAge),
    // 이미 인출 중이면 올해는 남은 달만큼만(은퇴 전이면 인출 첫해는 1년 전체)
    firstYearShare: start.retired ? inp.firstYearShare : undefined,
    pensions: inp.pensions,
    meanReturn: inp.retireMeanReturn ?? inp.meanReturn,
    volatility: inp.retireVolatility ?? inp.volatility,
    inflation: o.inflation,
    percentRate: o.percentRate ?? 4,
    debts: (inp.debts ?? []).filter((x) => x.endAge > startAge),
    extras: inp.goals.filter((g) => g.age >= startAge && !g.pensionTax),
    guardrail: o.guardrail ?? DEFAULT_GUARDRAIL,
  };
}

/** 노후 진단에 더하는 연금 인출 세금을 계산할 때 쓰는 인출 방식(인출 계획 화면 기본값) */
export const PENSION_TAX_STRATEGY: StrategyKey = 'guardrail';

/**
 * 연금 인출 세금(연금소득세 5.5/4.4/3.3%, 1,500만 초과 16.5%, 퇴직소득세)을 노후 진단 지출에 더함.
 * 인출 계획 화면과 같은 계산(가드레일 · 평균 수익 경로)으로 나이별 세금(실질)을 구해 그 해 지출(goals, pensionTax)로 넣음.
 * 몬테카를로 각 경로에서도 나이별 세금은 같은 금액으로 봄. 연금계좌가 없거나 세금이 없으면 그대로 돌려줌.
 */
export function withPensionTax(profile: Profile, assets: Asset[], inp: PlanInput, nowYear: number): PlanInput {
  const base = { ...inp, goals: inp.goals.filter((g) => !g.pensionTax) };
  const start = withdrawStart(base);
  const wi = withdrawInputOf(base, start, { endAge: profile.lifeExpectancy, inflation: profile.inflation, startBalance: start.balance });
  const setup = taxSetup(profile, assets, nowYear, wi.startBalance, wi.meanReturn, profile.birthYear + start.age);
  if (!setup) return base;
  const { rows } = pensionTaxSchedule(compareStrategy(PENSION_TAX_STRATEGY, wi, 0).schedule, setup);
  const taxes = rows.filter((r) => r.tax > 0.005).map((r) => ({ age: r.age, amount: r.tax, pensionTax: true as const }));
  return taxes.length ? { ...base, goals: base.goals.concat(taxes) } : base;
}
