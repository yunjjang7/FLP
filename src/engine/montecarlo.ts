import { realRate } from './finance';
import { normalGen, percentile } from './random';

/**
 * 은퇴 후 소득 흐름(연금·임대료 등). annual 은 실질 연액.
 * growth(1회 명목 인상률 %)가 있으면 baseAge 기준 금액이 step 년마다 growth% 인상되고, 물가만큼 실질 가치가 줄어듦.
 * endAge 는 마지막으로 받는 나이(포함).
 */
export interface IncomeStream {
  name?: string;
  startAge: number;
  annual: number;
  endAge?: number;
  growth?: number;
  step?: number;
  baseAge?: number;
  /** pension: 국민연금·개인연금(인출액 고정 방식에서 고정액 안에 포함) · 그 밖(임대료·근로소득 등)은 고정액과 별도로 모두 씀 */
  kind?: 'pension';
  /** 시작하는 해에 받는 비율(국민연금: 생일 다음 달부터 → (12 − 출생 월) / 12) */
  firstShare?: number;
}

/** 해당 나이의 소득 실질 연액 */
export function incomeValue(p: IncomeStream, age: number, inflation: number) {
  if (age < p.startAge || (p.endAge !== undefined && p.endAge > 0 && age > p.endAge)) return 0;
  const share = age === p.startAge && p.firstShare !== undefined ? p.firstShare : 1;
  if (p.growth === undefined) return p.annual * share;
  const t = Math.max(0, age - (p.baseAge ?? p.startAge));
  const step = Math.max(1, Math.round(p.step ?? 1));
  return (share * p.annual * Math.pow(1 + p.growth / 100, Math.floor(t / step))) / Math.pow(1 + inflation / 100, t);
}

/** 모든 금액은 현재가치(실질, 만원/년) 기준 */
export interface PlanInput {
  currentAge: number;
  retireAge: number;
  lifeExpectancy: number;
  startBalance: number;
  annualSavings: number; // 은퇴 전 연 저축액
  meanReturn: number; // 명목 기대수익률 %
  volatility: number; // %
  inflation: number; // %
  retireExpenseAnnual: number; // 은퇴 후 연 생활비
  pensions: IncomeStream[]; // 국민연금·개인연금·임대료 등 은퇴 후 소득
  /** 해당 나이에 지출되는 목적자금·반복 지출(실질). loan 이 있으면 만기일시 상환 대출의 원금 상환(그 대출 이름) */
  goals: { age: number; amount: number; loan?: string; premium?: string }[]; // loan: 만기일시 대출 원금, premium: 은퇴 후 보험료
  /** 은퇴 후 자산 운용(미지정 시 은퇴 전과 동일) */
  retireMeanReturn?: number;
  retireVolatility?: number;
  /** 대출 상환: endAge 나이부터 상환이 끝남. 은퇴 전엔 그만큼 저축이 늘고, 은퇴 후에도 남아 있으면 지출로 계산 */
  debts?: Debt[];
  /** 은퇴 전 저축 변화: fromAge 나이부터 연 저축에 annual 을 더함(음수면 감소, 예: 배우자 은퇴) */
  savingsChanges?: { fromAge: number; annual: number; name?: string }[];
  /** 은퇴 후 생활비 명목 증가율(%). 없으면 물가만큼 올라 실질 금액이 일정 */
  expenseGrowth?: number;
  /** 연금으로 쓰는 금액 명목 고정(연, 인출 시작 시점 금액): 이 금액을 국민·개인연금과 자산 인출로 채우고(연금이 늘면 인출이 줄어듦), 임대료 등 그 밖의 소득은 모두 생활비로 씀 */
  fixedDraw?: number;
  /** 수령 전 묶인 자산(노란우산 등)·부동산 매각(sale)·세액공제 환급(credit): 해당 나이에 세후 금액(실질)이 들어와 함께 운용됨 */
  inflows?: { name?: string; age: number; amount: number; kind?: 'credit' | 'sale' }[];
}

export interface SimResult {
  ages: number[];
  p10: number[];
  p50: number[];
  p90: number[];
  deterministic: number[];
  successRate: number; // %
  depletionAges: (number | null)[]; // 시나리오별 첫 고갈 나이
  depletionHistogram: { age: number; count: number }[];
  medianDepletionAge: number | null;
  balanceAtRetire: { p10: number; p50: number; p90: number };
}

export const pensionAt = (input: PlanInput, age: number) => input.pensions.reduce((a, p) => a + incomeValue(p, age, input.inflation), 0);
/** 국민·개인연금만(kind = pension) */
export const publicPensionAt = (input: { pensions: IncomeStream[]; inflation: number }, age: number) =>
  input.pensions.filter((p) => p.kind === 'pension').reduce((a, p) => a + incomeValue(p, age, input.inflation), 0);

/** 실질 배율: 명목으로 해마다 growth% 오를 때 t년 뒤 금액의 현재가치 배율 */
export const nominalFactor = (growth: number, inflation: number, t: number) => Math.pow((1 + growth / 100) / (1 + inflation / 100), Math.max(0, t));

/** 생활비 변화가 시작되는 나이(은퇴 또는 지금 중 늦은 쪽). 그 전까지는 물가만큼 오름 */
const expenseBaseAge = (input: PlanInput) => Math.max(input.currentAge, input.retireAge);

/** 해당 나이의 은퇴 후 생활비(실질) */
export const expenseAt = (input: PlanInput, age: number) =>
  input.expenseGrowth === undefined ? input.retireExpenseAnnual : input.retireExpenseAnnual * nominalFactor(input.expenseGrowth, input.inflation, age - expenseBaseAge(input));

/** 해당 나이에 들어오는 묶인 자산 수령액(실질) */
export const inflowAt = (input: PlanInput, age: number) => (input.inflows ?? []).filter((x) => x.age === age).reduce((a, x) => a + x.amount, 0);

/**
 * 대출 상환 흐름. annual 은 지금 연 상환액, bullet 은 만기일시 상환(annual 은 이자).
 * decline: 원금균등 상환에서 잔액이 줄어 연 상환액이 해마다 줄어드는 폭(fromAge 부터)
 */
export interface Debt {
  name?: string;
  endAge: number;
  annual: number;
  bullet?: boolean;
  decline?: number;
  fromAge?: number;
}

/** 해당 나이의 대출 상환액(연): 원금균등이면 해마다 줄고, 상환 종료 나이부터 0 */
export const debtAnnualAt = (d: Debt, age: number) =>
  age >= d.endAge ? 0 : Math.max(0, d.annual - (d.decline ?? 0) * Math.max(0, age - (d.fromAge ?? age)));

/** 해당 나이에 아직 남아 있는 대출 상환액(연) */
export const debtPaymentAt = (input: { debts?: Debt[] }, age: number) => (input.debts ?? []).reduce((a, d) => a + debtAnnualAt(d, age), 0);

/** 은퇴 전 연 저축액: 기본 저축 + 지금보다 줄어든 대출 상환액(상환 종료·원금균등 감소분) */
export const savingsAt = (input: PlanInput, age: number) =>
  input.annualSavings +
  (input.debts ?? []).reduce((a, d) => a + d.annual - debtAnnualAt(d, age), 0) +
  (input.savingsChanges ?? []).filter((c) => age >= c.fromAge).reduce((a, c) => a + c.annual, 0);

/** 은퇴 후 자산에서 꺼내야 할 금액(생활비 − 연금 + 남은 대출 상환). 인출액 고정이면 고정액(명목) − 국민·개인연금 + 대출 상환 */
export const retireOutflowAt = (input: PlanInput, age: number) =>
  input.fixedDraw !== undefined
    ? Math.max(0, input.fixedDraw * nominalFactor(0, input.inflation, age - expenseBaseAge(input)) - publicPensionAt(input, age)) + debtPaymentAt(input, age)
    : expenseAt(input, age) - pensionAt(input, age) + debtPaymentAt(input, age);

/** 해당 나이의 기대수익률·변동성(%) */
export function returnAt(input: PlanInput, age: number) {
  if (age >= input.retireAge && input.retireMeanReturn !== undefined) {
    return { mean: input.retireMeanReturn, vol: input.retireVolatility ?? input.volatility };
  }
  return { mean: input.meanReturn, vol: input.volatility };
}

export function outflowAt(input: PlanInput, age: number) {
  let out = 0;
  for (const g of input.goals) if (g.age === age) out += g.amount;
  if (age >= input.retireAge) out += retireOutflowAt(input, age);
  return out - inflowAt(input, age);
}

/** 한 경로 계산. z: 표준정규 난수 공급 함수(결정론적 경로는 항상 0) */
export function runPath(input: PlanInput, z: () => number) {
  const years = Math.max(0, input.lifeExpectancy - input.currentAge);
  const balances = new Array<number>(years + 1);
  let bal = input.startBalance;
  balances[0] = bal;
  let depletedAt: number | null = null;
  for (let i = 0; i < years; i++) {
    const age = input.currentAge + i;
    const { mean, vol } = returnAt(input, age);
    const nominal = Math.max(-0.95, mean / 100 + (vol / 100) * z());
    const real = (1 + nominal) / (1 + input.inflation / 100) - 1;
    bal = bal * (1 + real);
    if (age < input.retireAge) bal += savingsAt(input, age);
    bal -= outflowAt(input, age);
    if (bal < 0) {
      if (depletedAt === null) depletedAt = age + 1;
      bal = 0;
    }
    balances[i + 1] = bal;
  }
  return { balances, depletedAt };
}

export function deterministicPath(input: PlanInput) {
  return runPath(input, () => 0);
}

export function simulate(input: PlanInput, runs = 1000, seed = 42): SimResult {
  const years = Math.max(0, input.lifeExpectancy - input.currentAge);
  const ages = Array.from({ length: years + 1 }, (_, i) => input.currentAge + i);
  const gen = normalGen(seed);
  const columns: number[][] = ages.map(() => new Array<number>(runs));
  const depletionAges: (number | null)[] = [];
  for (let r = 0; r < runs; r++) {
    const { balances, depletedAt } = runPath(input, gen);
    for (let i = 0; i <= years; i++) columns[i][r] = balances[i];
    depletionAges.push(depletedAt);
  }
  const p10: number[] = [];
  const p50: number[] = [];
  const p90: number[] = [];
  for (const col of columns) {
    col.sort((a, b) => a - b);
    p10.push(percentile(col, 0.1));
    p50.push(percentile(col, 0.5));
    p90.push(percentile(col, 0.9));
  }
  const failed = depletionAges.filter((a): a is number => a !== null).sort((a, b) => a - b);
  const hist = new Map<number, number>();
  for (const a of failed) {
    const bucket = Math.floor(a / 5) * 5;
    hist.set(bucket, (hist.get(bucket) ?? 0) + 1);
  }
  const ri = Math.min(years, Math.max(0, input.retireAge - input.currentAge));
  return {
    ages,
    p10,
    p50,
    p90,
    deterministic: deterministicPath(input).balances,
    successRate: runs > 0 ? ((runs - failed.length) / runs) * 100 : 0,
    depletionAges,
    depletionHistogram: [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([age, count]) => ({ age, count })),
    // 미고갈 시나리오를 무한대로 보고 전체 중앙값을 취함 → 과반이 고갈될 때만 값이 있음
    medianDepletionAge: failed.length > runs / 2 ? failed[Math.floor(runs / 2)] : null,
    balanceAtRetire: { p10: p10[ri] ?? 0, p50: p50[ri] ?? 0, p90: p90[ri] ?? 0 },
  };
}

/** 성공확률이 target(%) 이 되는 변수값을 이분 탐색 (공통 난수 사용으로 단조성 확보) */
export function solveFor(
  input: PlanInput,
  apply: (input: PlanInput, v: number) => PlanInput,
  lo: number,
  hi: number,
  target: number,
  increasing = true,
  runs = 400,
): number | null {
  const rate = (v: number) => simulate(apply(input, v), runs, 7).successRate;
  const ok = (v: number) => rate(v) >= target;
  if (increasing ? !ok(hi) : !ok(lo)) return null;
  if (increasing ? ok(lo) : ok(hi)) return increasing ? lo : hi;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid) === increasing) hi = mid;
    else lo = mid;
  }
  return increasing ? hi : lo;
}

/**
 * 인출 시작 시점: 은퇴 나이와 현재 나이 중 늦은 쪽.
 * balance 는 평균수익 가정의 그 시점 금융자산, rate 는 첫해 인출률(그해 자산에서 꺼낼 금액 / 금융자산, %).
 * 꺼낼 금액 = 생활비 − 연금·소득 + 남은 대출 상환 + 그해 목적자금·반복 지출
 */
export function withdrawStart(input: PlanInput) {
  const age = Math.max(input.retireAge, input.currentAge);
  const det = deterministicPath({ ...input, lifeExpectancy: age });
  const balance = det.balances[det.balances.length - 1] ?? input.startBalance;
  const goals = input.goals.filter((g) => g.age === age).reduce((a, g) => a + g.amount, 0);
  const outflow = Math.max(0, retireOutflowAt(input, age) + goals);
  return { age, retired: input.currentAge >= input.retireAge, balance, outflow, rate: balance > 0 ? (outflow / balance) * 100 : outflow > 0 ? Infinity : 0 };
}

/** 은퇴 필요자금·준비율 (결정론적). 이미 은퇴했으면 현재 나이부터 계산 */
export function retirementNeed(input: PlanInput) {
  const st = withdrawStart(input);
  const r = realRate(returnAt(input, st.age).mean, input.inflation);
  const n = Math.max(0, input.lifeExpectancy - st.age);
  let need = 0;
  for (let i = 0; i < n; i++) {
    const age = st.age + i;
    const goals = input.goals.filter((g) => g.age === age).reduce((a, g) => a + g.amount, 0);
    need += (Math.max(0, retireOutflowAt(input, age) + goals) - inflowAt(input, age)) / Math.pow(1 + r, i);
  }
  return { need, projected: st.balance, ratio: need > 0 ? (st.balance / need) * 100 : 100, startAge: st.age };
}
