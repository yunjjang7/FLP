import type { Asset, Cashflow, Goal, Insurance, Liability, Profile, SavedPlan } from '../types';
import { buildPlanInput } from './goals';
import { withPensionTax } from './pensionTaxPlan';
import { deterministicPath, retirementNeed, simulate, withdrawStart, type PlanInput, type SimResult } from './montecarlo';
import { summarize, type Summary } from './portfolio';

/** 저장할 수 있는 계획 수 */
export const MAX_PLANS = 5;

/** 계획 하나를 이루는 데이터(지금 입력값 또는 저장한 계획) */
export interface PlanData {
  profile: Profile;
  assets: Asset[];
  liabilities: Liability[];
  cashflows: Cashflow[];
  goals: Goal[];
  insurance: Insurance[];
}

/** 비교 표에 쓰는 계획 지표 */
export interface PlanMetrics {
  age: number; // 현재 나이
  retireAge: number;
  living: number; // 은퇴 후 월 생활비(인출액 고정 방식이면 월 고정 인출액)
  drawMode: boolean; // 인출액 고정 방식인지
  financialAssets: number;
  netWorth: number;
  successRate: number; // %
  depletedAt: number | null; // 평균 수익일 때 자산이 바닥나는 나이
  lifeExpectancy: number;
  startAge: number; // 인출 시작 나이
  startRate: number; // 첫해 인출률(%)
  endP50: number; // 기대수명 때 잔액 중앙값(오늘 물가)
  readiness: number; // 은퇴 준비율(%)
}

const genId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 지금 데이터로 저장용 계획을 만듦. draft 가 있으면 저장되는 프로필에 덮어씀(What-if 조정안) */
export function makePlan(name: string, data: PlanData, today: string, draft?: Partial<Profile>): SavedPlan {
  // 안쪽 프로필에는 plans 를 빼서 계획 안에 계획이 겹겹이 쌓이지 않게 함
  const { plans: _omit, ...profile } = { ...data.profile, ...draft };
  return {
    id: genId(),
    name: name.trim() || `계획 ${today}`,
    savedAt: today,
    profile: structuredClone(profile) as Profile,
    assets: structuredClone(data.assets),
    liabilities: structuredClone(data.liabilities),
    cashflows: structuredClone(data.cashflows),
    goals: structuredClone(data.goals),
    insurance: structuredClone(data.insurance),
  };
}

/** 계획의 핵심 지표: 화면(FlpContext)과 같은 방식으로 계산해 같은 데이터면 같은 성공확률이 나옴 */
export function planMetrics(data: PlanData, month: number): PlanMetrics {
  const { profile, assets, liabilities, cashflows, goals, insurance } = data;
  const summary = summarize(profile, assets, liabilities, cashflows, undefined, insurance, month);
  const input = withPensionTax(profile, assets, buildPlanInput(profile, assets, liabilities, goals, summary), profile.birthYear + summary.age);
  return metricsFrom(profile, summary, input, simulate(input, 1000));
}

/** 이미 계산해 둔 요약·입력·시뮬레이션에서 지표만 뽑음(지금 계획은 화면에서 돌린 결과를 그대로 씀) */
export function metricsFrom(profile: Profile, summary: Summary, input: PlanInput, sim: SimResult): PlanMetrics {
  const start = withdrawStart(input);
  const need = retirementNeed(input);
  const drawMode = input.fixedDraw !== undefined;
  return {
    age: summary.age,
    retireAge: profile.retireAge,
    living: drawMode ? Math.round((input.fixedDraw ?? 0) / 12) : profile.retireMonthlyExpense,
    drawMode,
    financialAssets: summary.financialAssets,
    netWorth: summary.netWorth,
    successRate: sim.successRate,
    depletedAt: deterministicPath(input).depletedAt,
    lifeExpectancy: input.lifeExpectancy,
    startAge: start.age,
    startRate: start.rate,
    endP50: sim.p50[sim.p50.length - 1] ?? 0,
    readiness: need.ratio,
  };
}

/** 계획 추가(같은 id 면 바꿔 넣음). 최대 개수를 넘으면 그대로 둠 */
export function withPlan(plans: SavedPlan[] | undefined, plan: SavedPlan): SavedPlan[] {
  const list = plans ?? [];
  const i = list.findIndex((x) => x.id === plan.id);
  if (i >= 0) return list.map((x, j) => (j === i ? plan : x));
  if (list.length >= MAX_PLANS) return list;
  return [...list, plan];
}

/** 계획 삭제 */
export function withoutPlan(plans: SavedPlan[] | undefined, id: string): SavedPlan[] {
  return (plans ?? []).filter((x) => x.id !== id);
}
