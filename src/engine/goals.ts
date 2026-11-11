import type { Asset, Goal, Liability, Profile } from '../types';
import { contribSchedule, creditInflows, incomeTaxSchedule, npCostOutflows } from './incomeTax';
import { fvLump, monthlyRate, payoffMonths, pmtForTarget, realRate } from './finance';
import { debtAnnualAt, type Debt, type ExpenseStep, type IncomeStream, type PlanInput } from './montecarlo';
import { isFinancial, type Summary } from './portfolio';
import { hpStreams, rentStreams, saleInflows } from './realestate';

export interface GoalPlan {
  goal: Goal;
  years: number; // 지금부터 목표(반복 지출은 시작) 나이까지 햇수
  futureValue: number; // 목표 시점 명목 필요액(반복 지출은 시작 나이에 있어야 할 금액)
  allocated: number; // 현재 중기 자산 중 배정액
  monthlyNeeded: number; // 필요 월 적립액(명목)
  fundedRatio: number; // 배정액의 미래가치 / 필요액 %
  /** 매년 반복 지출: 지출 구간(지난 해는 빼고)과 첫해 지출액(명목) */
  recurring?: { fromAge: number; toAge: number; count: number; firstPayment: number };
}

/**
 * 재무목표 현가화: 현재가치 금액 × (1+상승률)^년수 = 미래 필요액.
 * 매년 반복 지출은 시작 나이(이미 시작했으면 지금)에 남은 해마다의 지출을 중기 자산 기대수익률로 할인해 한 번에 있어야 할 금액으로 봄.
 * 중기·목적자금 자산을 일시 목표에 시기가 빠른 순으로 먼저 배정하고, 남은 자산을 반복 지출에 배정한 뒤 부족분을 월 적립액(PMT)으로 산출.
 * 반복 지출은 끝 나이가 지나지 않았으면 행으로 넣음(일시 목표는 목표 나이가 지나면 뺌).
 */
export function planGoals(goals: Goal[], assets: Asset[], currentAge: number): GoalPlan[] {
  const mid = assets.filter((a) => isFinancial(a) && a.purpose === 'mid');
  const midTotal = mid.reduce((s, a) => s + a.amount, 0);
  const midReturn = midTotal > 0 ? mid.reduce((s, a) => s + (a.amount / midTotal) * a.expectedReturn, 0) : 3;
  const r = monthlyRate(midReturn);
  let pool = midTotal;
  const startAge = (g: Goal) => Math.max(g.targetAge, currentAge);
  const plan = (goal: Goal): GoalPlan => {
    const from = startAge(goal);
    const years = from - currentAge;
    let futureValue = fvLump(goal.amountPV, goal.growthRate / 100, years);
    let recurring: GoalPlan['recurring'];
    if (isRecurring(goal)) {
      // 해마다 그해 초에 내고, 남은 돈은 계속 중기 자산 수익률로 굴린다고 봄
      futureValue = 0;
      for (let age = from; age <= goal.endAge!; age++) futureValue += fvLump(goal.amountPV, goal.growthRate / 100, age - currentAge) / Math.pow(1 + midReturn / 100, age - from);
      recurring = { fromAge: from, toAge: goal.endAge!, count: goal.endAge! - from + 1, firstPayment: fvLump(goal.amountPV, goal.growthRate / 100, years) };
    }
    const n = years * 12;
    const needNow = futureValue / Math.pow(1 + r, n); // 지금 이만큼 있으면 충분
    const allocated = Math.min(pool, needNow);
    pool -= allocated;
    const monthlyNeeded = pmtForTarget(futureValue, allocated, r, n);
    const fundedRatio = futureValue > 0 ? (fvLump(allocated, r, n) / futureValue) * 100 : 100;
    return { goal, years, futureValue, allocated, monthlyNeeded, fundedRatio, ...(recurring ? { recurring } : {}) };
  };
  const byAge = (a: Goal, b: Goal) => startAge(a) - startAge(b);
  const usable = goals.filter((g) => g.category !== 'retirement');
  const once = usable.filter((g) => !isRecurring(g) && g.targetAge >= currentAge).sort(byAge).map(plan);
  const rec = usable.filter((g) => isRecurring(g) && g.endAge! >= currentAge).sort(byAge).map(plan);
  return [...once, ...rec].sort((a, b) => a.years - b.years);
}

/** 일시 목표만(반복 지출 제외): 처방의 목적자금 적립 합계·목적자금 바구니에 씀 */
export const onceGoalPlans = (plans: GoalPlan[]) => plans.filter((g) => !g.recurring);

/**
 * 필요 적립액 계산(planGoals)에서 빠지는 목표와 이유: 목표 나이가 지났거나 0, 반복 기간이 끝남, ‘은퇴’ 분류
 */
export function goalPlanSkips(goals: Goal[], currentAge: number) {
  return goals.flatMap((g) => {
    const reason =
      g.category === 'retirement'
        ? '‘은퇴’ 분류 — 노후 진단에서 따로 계산'
        : isRecurring(g)
          ? g.endAge! < currentAge ? `반복 기간 ${g.targetAge}~${g.endAge}세가 지남` : null
          : g.targetAge < currentAge
            ? g.targetAge > 0 ? `목표 나이 ${g.targetAge}세가 지남` : '목표 나이가 비어 있음(0)'
            : null;
    return reason ? [{ goal: g, reason }] : [];
  });
}

/** 매년 반복되는 지출인지 */
export const isRecurring = (g: Goal) => (g.endAge ?? 0) > g.targetAge;

/** 노후 계산에 들어가는 목표 탭 항목(‘은퇴’ 분류 제외) 가운데 fromAge 이후에 한 번이라도 지출이 남은 것 — 연도별 행이 아니라 항목 수로 셈 */
export function goalItemsFrom(goals: Goal[], fromAge: number) {
  return goals.filter((g) => g.category !== 'retirement' && (isRecurring(g) ? g.endAge! : g.targetAge) >= fromAge);
}

/** 배우자 나이 → 본인 나이로 바꿀 때 더할 값(배우자가 어리면 +) */
export const spouseGap = (p: Profile) => (p.spouseBirthYear > 0 ? p.spouseBirthYear - p.birthYear : 0);
/** 배우자 나이를 본인 나이로 */
export const spouseToSelf = (p: Profile, spouseAge: number) => spouseAge + spouseGap(p);
/** 배우자 은퇴(근로소득이 끊기는) 본인 나이 */
export const spouseRetireSelfAge = (p: Profile) => spouseToSelf(p, p.spouseRetireAge ?? 0);

/** 국민연금 첫해 비율(생일 다음 달부터)과 연 인상률 */
export function npTerms(profile: Profile, month: number | undefined, currentAge: number): Pick<IncomeStream, 'firstShare' | 'growth' | 'baseAge'> {
  const m = Math.round(month ?? 0);
  return {
    ...(m >= 1 && m <= 12 ? { firstShare: (12 - m) / 12 } : {}),
    ...(profile.npGrowth !== undefined && profile.npGrowth !== null && Number.isFinite(profile.npGrowth) ? { growth: profile.npGrowth, baseAge: currentAge } : {}),
  };
}

/** 은퇴 후 소득 목록: 부부 국민연금·개인연금, 본인 은퇴 뒤 배우자 근로소득, 기타 소득(나이는 모두 본인 기준으로 변환) */
export function retireIncomes(profile: Profile, currentAge: number): IncomeStream[] {
  const toSelf = (age: number, owner?: string) => (owner === 'spouse' ? spouseToSelf(profile, age) : age);
  const spouseWorkEnd = spouseRetireSelfAge(profile) - 1;
  const list: IncomeStream[] = [
    { name: '국민연금', kind: 'pension', startAge: profile.nationalPensionAge, annual: profile.nationalPension * 12, ...npTerms(profile, profile.birthMonth, currentAge) },
    { name: '배우자 국민연금', kind: 'pension', startAge: spouseToSelf(profile, profile.spousePensionAge), annual: profile.spousePension * 12, ...npTerms(profile, profile.spouseBirthMonth, currentAge) },
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
  // 만기일시 상환은 원금이 줄지 않아 끝나는 나이를 계산할 수 없음 → 만기 나이를 직접 넣어야 함
  if (l.repay === 'bullet') return { age: Infinity, auto: true };
  if (l.repay === 'equal') {
    // 원금균등: 월 원금 = 월 상환액 − 이번 달 이자, 잔액 ÷ 월 원금 개월이면 끝남
    const pr = equalPrincipal(l, currentAge);
    return { age: pr > 0 ? currentAge + Math.ceil(l.balance / pr / 12) : Infinity, auto: true };
  }
  const m = payoffMonths(l.balance, l.rate, l.monthlyPayment);
  return { age: m === null ? Infinity : currentAge + Math.ceil(m / 12), auto: true };
}

/** 원금균등 상환의 월 원금: 상환 종료 나이가 있으면 잔액 ÷ 남은 개월, 없으면 월 상환액 − 이번 달 이자 */
export function equalPrincipal(l: Liability, currentAge: number) {
  if (l.endAge && l.endAge > currentAge) return l.balance / ((l.endAge - currentAge) * 12);
  return l.monthlyPayment - (l.balance * l.rate) / 1200;
}

/** 원금균등 상환에서 월 상환액이 1년마다 줄어드는 폭(월 원금 × 12개월 × 월 금리) */
export function equalMonthlyDecline(l: Liability, currentAge: number) {
  const pr = equalPrincipal(l, currentAge);
  return pr > 0 ? pr * 12 * (l.rate / 1200) : 0;
}

/** years 년 뒤 대출 잔액(명목): 원리금균등·원금균등 상환(만기일시 상환은 원금 그대로), 상환 종료 나이가 되면 0 */
export function loanBalanceAt(l: Liability, currentAge: number, years: number) {
  if (years <= 0) return l.balance;
  if (currentAge + years >= loanEndAge(l, currentAge).age) return 0;
  if (l.repay === 'bullet') return l.balance;
  if (l.repay === 'equal') return Math.max(0, l.balance - equalPrincipal(l, currentAge) * years * 12);
  const i = l.rate / 1200;
  const m = years * 12;
  if (i === 0) return Math.max(0, l.balance - l.monthlyPayment * m);
  const g = Math.pow(1 + i, m);
  return Math.max(0, l.balance * g - (l.monthlyPayment * (g - 1)) / i);
}


/** 만기일시 상환인데 상환 종료 나이(만기)가 비었거나 지난 대출: 원금 상환이 계산에 빠짐 */
export const bulletNoMaturity = (l: Liability, currentAge: number) => l.repay === 'bullet' && l.balance > 0 && !((l.endAge ?? 0) > currentAge);

/**
 * 만기일시 상환 대출의 원금 일시 상환: 만기 나이에 남은 원금을 자산에서 한 번에 뺌.
 * 원금은 명목 금액 그대로라 실질 금액 = 원금 ÷ (1 + 물가)^(만기까지 햇수). 만기 나이가 없거나 지났으면 없음.
 */
export function bulletRepayments(liabilities: Liability[], currentAge: number, inflation: number) {
  return liabilities
    .filter((l) => l.repay === 'bullet' && l.balance > 0 && (l.endAge ?? 0) > currentAge)
    .map((l) => ({ name: l.name, age: l.endAge!, nominal: l.balance, amount: l.balance / Math.pow(1 + inflation / 100, l.endAge! - currentAge) }));
}
/** 대출 → 시뮬레이션 상환 흐름(지금 월 상환액 기준, 원금균등은 해마다 줄어듦) */
export function loanDebt(l: Liability, currentAge: number): Debt {
  return {
    name: l.name,
    endAge: loanEndAge(l, currentAge).age,
    annual: l.monthlyPayment * 12,
    ...(l.repay === 'bullet' ? { bullet: true } : {}),
    // 원금균등은 잔액이 줄어 상환액이 해마다 줄고, 줄어든 만큼 저축이 늘어남
    ...(l.repay === 'equal' ? { decline: equalMonthlyDecline(l, currentAge) * 12, fromAge: currentAge } : {}),
  };
}

export interface LoanYear {
  age: number;
  payment: number; // 그 해 상환액(원금 + 이자, 만기일시는 이자)
  principal: number; // 만기일시: 그 해 한 번에 갚는 원금
  balance: number; // 연말 잔액
}

/**
 * 대출 연도별 상환표(지금 금액 기준 추정): 지금 나이 ~ lastAge.
 * 상환액은 시뮬레이션과 같은 흐름(원금균등은 해마다 줄어듦), 잔액은 loanBalanceAt, 만기일시는 만기 나이에 원금.
 */
export function loanSchedule(l: Liability, currentAge: number, lastAge: number): LoanYear[] {
  const d = loanDebt(l, currentAge);
  const out: LoanYear[] = [];
  for (let age = currentAge; age <= lastAge; age++) {
    const principal = l.repay === 'bullet' && age === d.endAge ? l.balance : 0;
    // 마지막 해는 남은 잔액 + 이자까지만 냄(만기일시는 이자만 내므로 그대로)
    const start = loanBalanceAt(l, currentAge, age - currentAge);
    const due = debtAnnualAt(d, age);
    const payment = l.repay === 'bullet' || !Number.isFinite(d.endAge) || age < d.endAge - 1 ? due : Math.min(due, start * (1 + l.rate / 100));
    out.push({ age, payment, principal, balance: loanBalanceAt(l, currentAge, age - currentAge + 1) });
  }
  return out;
}

/**
 * 은퇴 후에도 내는 보험료: 납입 종료 나이가 은퇴 나이보다 늦으면 은퇴(이미 은퇴했으면 지금)부터 종료 전 해까지 매년 자산에서 뺌.
 * 납입 종료 나이가 없는(0) 보험은 기대수명까지 계속 냄(lifeExpectancy 를 넘긴 경우).
 * 보험료는 명목 고정이라 실질 금액 = 연 보험료 ÷ (1 + 물가)^(햇수). 보험 탭 보험료를 지출에 자동으로 더한 경우만.
 */
export function retirePremiums(s: Summary, retireAge: number, inflation: number, lifeExpectancy?: number) {
  const out: { age: number; amount: number; premium: string }[] = [];
  if (!(s.insurance > 0)) return out;
  const push = (name: string, monthly: number, endExclusive: number) => {
    for (let age = Math.max(retireAge, s.age); age < endExclusive; age++) out.push({ age, amount: (monthly * 12) / Math.pow(1 + inflation / 100, age - s.age), premium: name });
  };
  for (const x of s.insuranceEnds.filter((e) => e.age > retireAge)) push(x.name, x.monthly, x.age);
  if (lifeExpectancy !== undefined) for (const x of s.insuranceOngoing ?? []) push(x.name, x.monthly, lifeExpectancy + 1);
  return out;
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
/** 프로필의 나이 구간별 생활비 → 기본 생활비 대비 배율(나이순). 인출액 고정 방식이거나 기본 생활비가 0이면 없음 */
export function expenseSteps(profile: Profile): ExpenseStep[] | undefined {
  const base = profile.retireMonthlyExpense;
  const list = (profile.expenseSteps ?? []).filter((x) => x.fromAge > 0 && x.monthly >= 0);
  if (profile.expenseMode === 'draw' || !(base > 0) || !list.length) return undefined;
  return [...list].sort((a, b) => a.fromAge - b.fromAge).map((x) => ({ fromAge: x.fromAge, ratio: x.monthly / base }));
}

export function expenseRule(profile: Profile): Pick<PlanInput, 'expenseGrowth' | 'fixedDraw'> {
  if (profile.expenseMode === 'growth') return { expenseGrowth: profile.expenseGrowth ?? 0 };
  if (profile.expenseMode === 'draw') return { fixedDraw: (profile.fixedDraw ?? 0) * 12 };
  return {};
}

/**
 * 은퇴 전 저축 변화
 * - 배우자가 본인보다 먼저 은퇴하면 그때부터 가구 저축이 배우자 소득만큼 줄어듦
 * - 보험 납입이 끝나면 그 나이부터 월 보험료만큼 저축이 늘어남(보험 탭 보험료를 지출에 자동으로 더한 경우만)
 */
export function savingsChanges(profile: Profile, s: Summary, retireAge: number): PlanInput['savingsChanges'] {
  const out: { fromAge: number; annual: number; name?: string }[] = [];
  if ((profile.spouseIncome ?? 0) > 0 && spouseRetireSelfAge(profile) < retireAge) out.push({ fromAge: spouseRetireSelfAge(profile), annual: -profile.spouseIncome * 12, name: '배우자 은퇴' });
  if (s.insurance > 0) for (const x of s.insuranceEnds.filter((e) => e.age < retireAge)) out.push({ fromAge: x.age, annual: x.monthly * 12, name: `${x.name} 납입 완료` });
  return out.length ? out : undefined;
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
  const taxRows = profile.incomeTax?.on || profile.contrib ? incomeTaxSchedule(profile, nowYear, undefined, assets, liabilities) : [];
  const credits = creditInflows(profile, nowYear, contribSchedule(profile, taxRows));
  const npCost = profile.incomeTax?.on && profile.incomeTax.addToDraw ? npCostOutflows(taxRows) : [];
  // 매각 예정 부동산은 매각 연도에 순매각대금(비용·보증금·새 집 구입액 차감)이 금융자산으로 들어옴
  const inflows = [...locked.map((a) => lockedInflow(a, profile, nowYear)).map(({ name, age, amount }) => ({ name, age, amount })), ...saleInflows(assets, profile, nowYear), ...credits];
  return {
    ...expenseRule(profile),
    inflows: inflows.length ? inflows : undefined,
    retireMeanReturn: profile.retireSeparate ? profile.retireReturn : undefined,
    retireVolatility: profile.retireSeparate ? profile.retireVolatility : undefined,
    // 월상환액은 현재 금액 그대로(실질 일정) 가정
    debts: liabilities
      .filter((l) => l.monthlyPayment > 0 || l.repay === 'bullet') // 만기일시는 이자가 0이어도 만기 점검용으로 남김
      .map((l) => loanDebt(l, s.age)),
    savingsChanges: savingsChanges(profile, s, o.retireAge ?? profile.retireAge),
    currentAge: s.age,
    retireAge: o.retireAge ?? profile.retireAge,
    lifeExpectancy: profile.lifeExpectancy,
    startBalance,
    // 지출이 소득보다 많으면(저축 여력 마이너스) 그 부족분은 은퇴 전에도 금융자산에서 꺼내 쓴다고 봄
    annualSavings: (o.monthlySavings ?? s.savings) * 12,
    meanReturn: o.meanReturn ?? liqReturn,
    volatility: o.volatility ?? liqVol,
    inflation,
    retireExpenseAnnual: (o.retireMonthlyExpense ?? profile.retireMonthlyExpense) * 12,
    // 나이 구간별 생활비는 기본 생활비 대비 배율로 넣어 기본 생활비를 바꿔 보는 시나리오에도 같은 비율로 따라감
    expenseSteps: expenseSteps(profile),
    // 임대용 부동산 월세(공실·관리 경비 차감, 매각 전 해까지)도 은퇴 후 소득
    pensions: [...retireIncomes(profile, s.age), ...rentStreams(assets, profile, s.age).map(({ spouseShare: _, ...x }) => x), ...hpStreams(assets, profile, s.age)],
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
      // 만기일시 상환 대출은 만기 나이에 원금을 한 번에 갚음
      .concat(bulletRepayments(liabilities, s.age, inflation).map(({ name, age, amount }) => ({ age, amount, loan: name })))
      // 은퇴 뒤까지 내는 보험료는 그 해 자산에서 뺌
      .concat(retirePremiums(s, o.retireAge ?? profile.retireAge, inflation, profile.lifeExpectancy))
      .concat(npCost),
  };
}
