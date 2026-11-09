import type { Asset, Goal, Liability, Profile } from '../types';
import { contribSchedule, creditInflows, incomeTaxSchedule, npCostOutflows } from './incomeTax';
import { fvLump, monthlyRate, payoffMonths, pmtForTarget, realRate } from './finance';
import type { IncomeStream, PlanInput } from './montecarlo';
import { isFinancial, type Summary } from './portfolio';

export interface GoalPlan {
  goal: Goal;
  years: number;
  futureValue: number; // 목표 시점 명목 필요액
  allocated: number; // 현재 중기 자산 중 배정액
  monthlyNeeded: number; // 필요 월 적립액(명목)
  fundedRatio: number; // 배정액의 미래가치 / 필요액 %
}

/**
 * 재무목표 현가화: 현재가치 금액 × (1+상승률)^년수 = 미래 필요액.
 * 중기·목적자금 자산을 목표 시기가 빠른 순으로 배정한 뒤, 부족분을 월 적립액(PMT)으로 산출.
 */
export function planGoals(goals: Goal[], assets: Asset[], currentAge: number): GoalPlan[] {
  const mid = assets.filter((a) => a.purpose === 'mid');
  const midTotal = mid.reduce((s, a) => s + a.amount, 0);
  const midReturn = midTotal > 0 ? mid.reduce((s, a) => s + (a.amount / midTotal) * a.expectedReturn, 0) : 3;
  const r = monthlyRate(midReturn);
  let pool = midTotal;
  return goals
    .filter((g) => g.category !== 'retirement' && !isRecurring(g) && g.targetAge >= currentAge)
    .slice()
    .sort((a, b) => a.targetAge - b.targetAge)
    .map((goal) => {
      const years = Math.max(0, goal.targetAge - currentAge);
      const futureValue = fvLump(goal.amountPV, goal.growthRate / 100, years);
      const n = years * 12;
      const needNow = futureValue / Math.pow(1 + r, n); // 지금 이만큼 있으면 충분
      const allocated = Math.min(pool, needNow);
      pool -= allocated;
      const monthlyNeeded = pmtForTarget(futureValue, allocated, r, n);
      const fundedRatio = futureValue > 0 ? (fvLump(allocated, r, n) / futureValue) * 100 : 100;
      return { goal, years, futureValue, allocated, monthlyNeeded, fundedRatio };
    });
}

/** 매년 반복되는 지출인지 */
export const isRecurring = (g: Goal) => (g.endAge ?? 0) > g.targetAge;

/** 배우자 나이 → 본인 나이로 바꿀 때 더할 값(배우자가 어리면 +) */
export const spouseGap = (p: Profile) => (p.spouseBirthYear > 0 ? p.spouseBirthYear - p.birthYear : 0);
/** 배우자 나이를 본인 나이로 */
export const spouseToSelf = (p: Profile, spouseAge: number) => spouseAge + spouseGap(p);
/** 배우자 은퇴(근로소득이 끊기는) 본인 나이 */
export const spouseRetireSelfAge = (p: Profile) => spouseToSelf(p, p.spouseRetireAge ?? 0);

/** 은퇴 후 소득 목록: 부부 국민연금·개인연금, 본인 은퇴 뒤 배우자 근로소득, 기타 소득(나이는 모두 본인 기준으로 변환) */
export function retireIncomes(profile: Profile, currentAge: number): IncomeStream[] {
  const toSelf = (age: number, owner?: string) => (owner === 'spouse' ? spouseToSelf(profile, age) : age);
  const spouseWorkEnd = spouseRetireSelfAge(profile) - 1;
  const list: IncomeStream[] = [
    { name: '국민연금', kind: 'pension', startAge: profile.nationalPensionAge, annual: profile.nationalPension * 12 },
    { name: '배우자 국민연금', kind: 'pension', startAge: spouseToSelf(profile, profile.spousePensionAge), annual: profile.spousePension * 12 },
    { name: '개인·퇴직연금', kind: 'pension', startAge: profile.privatePensionAge, annual: profile.privatePension * 12 },
    { name: '배우자 개인·퇴직연금', kind: 'pension', startAge: spouseToSelf(profile, profile.spousePrivatePensionAge ?? 0), annual: (profile.spousePrivatePension ?? 0) * 12 },
    // 본인이 먼저 은퇴하면 배우자가 은퇴할 때까지 배우자 소득이 생활비를 보탬
    ...((profile.spouseIncome ?? 0) > 0 && spouseWorkEnd >= profile.retireAge
      ? [{ name: '배우자 근로소득', startAge: profile.retireAge, endAge: spouseWorkEnd, annual: profile.spouseIncome * 12 }]
      : []),
    ...(profile.incomes ?? []).map((i) => ({
      name: i.name || '기타 소득',
      startAge: toSelf(i.startAge, i.owner),
      endAge: i.endAge > 0 ? toSelf(i.endAge, i.owner) : undefined,
      annual: i.monthly * 12,
      growth: i.growth,
      step: i.step,
      baseAge: currentAge,
    })),
  ];
  return list.filter((p) => p.annual > 0);
}

export interface PlanOverrides {
  monthlySavings?: number;
  meanReturn?: number;
  volatility?: number;
  retireAge?: number;
  retireMonthlyExpense?: number;
}

/**
 * 대출 상환 종료 나이. 직접 입력값이 있으면 그대로, 없으면 원리금 균등 상환으로 계산.
 * 월상환액이 이자보다 작아 끝나지 않으면 age = Infinity.
 */
export function loanEndAge(l: Liability, currentAge: number): { age: number; auto: boolean } {
  if (l.endAge && l.endAge > 0) return { age: l.endAge, auto: false };
  const m = payoffMonths(l.balance, l.rate, l.monthlyPayment);
  return { age: m === null ? Infinity : currentAge + Math.ceil(m / 12), auto: true };
}

/** 아직 수령 전인 묶인 자산(노란우산 등) */
export const isLocked = (a: Asset, nowYear: number) => isFinancial(a) && (a.lockYear ?? 0) > nowYear;

/** 묶인 자산의 수령액: 기대수익률로 수령 연도까지 불어난 뒤 세금을 뗀 일시금(명목·실질, 본인 나이) */
export function lockedInflow(a: Asset, profile: Profile, nowYear: number) {
  const n = Math.max(0, (a.lockYear ?? nowYear) - nowYear);
  const nominal = a.amount * Math.pow(1 + a.expectedReturn / 100, n) * (1 - (a.lockTax ?? 0) / 100);
  return { name: a.name, year: a.lockYear ?? nowYear, age: (a.lockYear ?? nowYear) - profile.birthYear, nominal, amount: nominal / Math.pow(1 + profile.inflation / 100, n) };
}

/** 은퇴 후 생활비 방식 → 시뮬레이션 입력 */
export function expenseRule(profile: Profile): Pick<PlanInput, 'expenseGrowth' | 'fixedDraw'> {
  if (profile.expenseMode === 'growth') return { expenseGrowth: profile.expenseGrowth ?? 0 };
  if (profile.expenseMode === 'draw') return { fixedDraw: (profile.fixedDraw ?? 0) * 12 };
  return {};
}

/** 프로필·자산 데이터를 시뮬레이션 입력(실질 기준)으로 변환 */
export function buildPlanInput(profile: Profile, assets: Asset[], liabilities: Liability[], goals: Goal[], s: Summary, o: PlanOverrides = {}): PlanInput {
  const nowYear = profile.birthYear + s.age;
  // 수령 전 묶인 자산은 시작 자산에서 빼고, 수령 연도에 세후 일시금으로 더함
  const locked = assets.filter((a) => isLocked(a, nowYear));
  const liquid = assets.filter((a) => isFinancial(a) && !isLocked(a, nowYear));
  const startBalance = liquid.reduce((a, x) => a + x.amount, 0);
  const inflation = profile.inflation;
  // 묶인 자산이 있으면 은퇴 전 수익률·변동성도 꺼내 쓸 수 있는 자산만으로 계산
  const liqTotal = startBalance;
  const liqReturn = locked.length && liqTotal > 0 ? liquid.reduce((a, x) => a + (x.amount / liqTotal) * x.expectedReturn, 0) : s.portfolioReturn;
  const liqVol = locked.length && liqTotal > 0 ? liquid.reduce((a, x) => a + (x.amount / liqTotal) * x.volatility, 0) : s.portfolioVol;
  // 종합소득세·건보료 추정과 추가 납입 세액공제: 환급은 다음 해 들어오고, 국민연금 몫 세금은 원하면 지출에 더함
  const taxRows = profile.incomeTax?.on || profile.contrib ? incomeTaxSchedule(profile, nowYear) : [];
  const credits = creditInflows(profile, nowYear, contribSchedule(profile, taxRows));
  const npCost = profile.incomeTax?.on && profile.incomeTax.addToDraw ? npCostOutflows(taxRows) : [];
  const inflows = [...locked.map((a) => lockedInflow(a, profile, nowYear)).map(({ name, age, amount }) => ({ name, age, amount })), ...credits];
  return {
    ...expenseRule(profile),
    inflows: inflows.length ? inflows : undefined,
    retireMeanReturn: profile.retireSeparate ? profile.retireReturn : undefined,
    retireVolatility: profile.retireSeparate ? profile.retireVolatility : undefined,
    // 월상환액은 현재 금액 그대로(실질 일정) 가정
    debts: liabilities
      .filter((l) => l.monthlyPayment > 0)
      .map((l) => ({ name: l.name, endAge: loanEndAge(l, s.age).age, annual: l.monthlyPayment * 12 })),
    // 배우자가 본인보다 먼저 은퇴하면 그때부터 가구 저축이 배우자 소득만큼 줄어듦
    savingsChanges:
      (profile.spouseIncome ?? 0) > 0 && spouseRetireSelfAge(profile) < (o.retireAge ?? profile.retireAge)
        ? [{ fromAge: spouseRetireSelfAge(profile), annual: -profile.spouseIncome * 12 }]
        : undefined,
    currentAge: s.age,
    retireAge: o.retireAge ?? profile.retireAge,
    lifeExpectancy: profile.lifeExpectancy,
    startBalance,
    annualSavings: Math.max(0, o.monthlySavings ?? s.savings) * 12,
    meanReturn: o.meanReturn ?? liqReturn,
    volatility: o.volatility ?? liqVol,
    inflation,
    retireExpenseAnnual: (o.retireMonthlyExpense ?? profile.retireMonthlyExpense) * 12,
    pensions: retireIncomes(profile, s.age),
    goals: goals
      .filter((g) => g.category !== 'retirement')
      .flatMap((g) => {
        // 비용 상승률 중 물가 초과분만 실질 증가로 반영. 반복 지출은 시작~종료 나이까지 매년
        const extra = realRate(g.growthRate, inflation);
        const last = isRecurring(g) ? g.endAge! : g.targetAge;
        const out: { age: number; amount: number }[] = [];
        for (let age = Math.max(g.targetAge, s.age); age <= last; age++) out.push({ age, amount: g.amountPV * Math.pow(1 + extra, age - s.age) });
        return out;
      })
      .concat(npCost),
  };
}
