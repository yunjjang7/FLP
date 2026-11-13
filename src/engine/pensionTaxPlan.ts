import type { Asset, Profile } from '../types';
import { withdrawStart, type PathTax, type PlanInput } from './montecarlo';
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
 * 기대수명·물가는 계획(inp) 값을 씀(장수·고물가 스트레스처럼 계획만 바꾼 경우도 그에 맞춰 세금을 다시 계산).
 * 프로필 ‘노후 진단에 연금 인출 세금 반영’이 아니오(planPensionTax === false)면 세금 지출을 빼고 돌려줌.
 */
export function withPensionTax(profile: Profile, assets: Asset[], inp: PlanInput, nowYear: number): PlanInput {
  const plan = taxPlan(profile, assets, inp, nowYear);
  if (!plan.setup) return plan.base;
  const taxes = toGoals(pensionTaxSchedule(plan.schedule, plan.setup).rows);
  return taxes.length ? { ...plan.base, goals: plan.base.goals.concat(taxes) } : plan.base;
}

/** 세금 지출을 뺀 계획과, 세금 계산에 쓰는 인출 스케줄(가드레일 · 평균 수익)·계좌 설정 */
function taxPlan(profile: Profile, assets: Asset[], inp: PlanInput, nowYear: number) {
  const base = { ...inp, goals: inp.goals.filter((g) => !g.pensionTax) };
  if (profile.planPensionTax === false) return { base, setup: null, schedule: [] };
  const start = withdrawStart(base);
  const wi = withdrawInputOf(base, start, { endAge: inp.lifeExpectancy, inflation: inp.inflation, startBalance: start.balance });
  const setup = taxSetup({ ...profile, inflation: inp.inflation }, assets, nowYear, wi.startBalance, wi.meanReturn, profile.birthYear + start.age, inp.firstYearShare ?? 1);
  if (setup && inp.death) setup.death = { owner: inp.death.who, year: profile.birthYear + inp.death.age };
  return { base, setup, schedule: setup ? compareStrategy(PENSION_TAX_STRATEGY, wi, 0).schedule : [] };
}

const toGoals = (rows: { age: number; tax: number }[]) => rows.filter((r) => r.tax > 0.005).map((r) => ({ age: r.age, amount: r.tax, pensionTax: true as const }));

/**
 * 몬테카를로 경로별 연금 인출 세금(simulate 의 pathTax). 인출액은 평균 경로와 같게 두고, 계좌가 불어나는 정도만
 * 그 경로의 수익률로 바꿔 세금을 다시 구함: 수익이 나쁘면 운용수익(과세재원)이 적어 과세제외 재원 비중이 커지고 세금이 줄어듦.
 * 1,000개 경로에 약 0.2초가 더 걸려 노후 진단 기본 계산(성공확률)에만 씀. 세금을 반영하지 않으면(설정 아니오·연금계좌 없음) undefined
 */
export function makePathTax(profile: Profile, assets: Asset[], inp: PlanInput, nowYear: number): PathTax | undefined {
  const { setup, schedule } = taxPlan(profile, assets, inp, nowYear);
  if (!setup || !inp.goals.some((g) => g.pensionTax)) return undefined;
  return (growthAt) => toGoals(pensionTaxSchedule(schedule.map((r) => ({ ...r, growth: growthAt(r.age) })), setup).rows);
}

/** 계획을 바꿔 다시 계산하는 표(민감도·스트레스 테스트·생활비 가정 비교 등)에서 쓰는, 바뀐 계획에 맞춰 연금 인출 세금을 다시 넣는 함수 */
export type Retax = (inp: PlanInput) => PlanInput;
export const makeRetax = (profile: Profile, assets: Asset[], nowYear: number): Retax => (inp) => withPensionTax(profile, assets, inp, nowYear);

/** 계획에 들어 있는 연금 인출 세금 합계(실질)와 나이 범위 */
export function pensionTaxTotal(inp: PlanInput) {
  const t = inp.goals.filter((g) => g.pensionTax);
  return { total: t.reduce((a, g) => a + g.amount, 0), from: t.length ? Math.min(...t.map((g) => g.age)) : null, to: t.length ? Math.max(...t.map((g) => g.age)) : null };
}
