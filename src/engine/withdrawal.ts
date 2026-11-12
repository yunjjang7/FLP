import type { PlanBase, YearEnd } from '../types';
import { debtPaymentAt, expenseRatioAt, incomeValue, nominalFactor, publicPensionAt, type Debt, type ExpenseStep, type IncomeStream } from './montecarlo';
import { normalGen, percentile } from './random';

export type StrategyKey = 'fixed' | 'percent' | 'bucket' | 'guardrail';

export const STRATEGIES: Record<StrategyKey, { label: string; desc: string }> = {
  fixed: { label: '정액 인출', desc: '부족한 생활비(생활비 − 연금)를 매년 같은 실질금액으로 인출합니다. 생활은 안정적이지만 하락장에서 고갈 위험이 커집니다.' },
  percent: { label: '정률 인출', desc: '매년 잔액의 일정 비율(예: 4%)만 인출합니다. 자산은 고갈되지 않지만 인출액이 시장에 따라 변합니다.' },
  bucket: { label: '3-버킷 전략', desc: '현금(2년치)·채권(5년치)·성장자산으로 나눠, 현금 바구니에서 인출하고 성장자산이 오른 해에만 채워 넣어 하락장 매도를 피합니다.' },
  guardrail: { label: '가드레일', desc: '매년 초 자산을 평균수익 계획의 기준선과 비교해, 하단선 아래면 인출을 줄이고 상단선 위면 되돌립니다. 하락장에서 조금 덜 써서 고갈을 늦춥니다. 자산이 끝까지 버티는 데 필요한 금액보다 충분히 많으면 기준선보다 낮아도 줄이지 않습니다.' },
};

export interface GuardrailOptions {
  band: number; // 기준선에서 벗어나는 폭(0.15 = ±15%)
  cut: number; // 하단선 아래일 때 줄이는 비율
  raise: number; // 상단선 위일 때 늘리는 비율
  floor: number; // 최저 배율(계획 대비)
  ceil: number; // 최고 배율(감액·증액 방식)
  cutOnly: boolean; // 감액만: 계획 인출액보다 늘리지 않음(줄였던 만큼만 되돌림)
}

export const DEFAULT_GUARDRAIL: GuardrailOptions = { band: 0.15, cut: 0.1, raise: 0.1, floor: 0.7, ceil: 1.3, cutOnly: true };

/**
 * 가드레일 배율 갱신: 연초 자산(bal)을 기준선(base)과 비교.
 * required(평균 수익으로 끝까지 버티는 데 필요한 자산)를 주면 감액 판정은 기준선과 필요 자산 중 낮은 쪽으로 함:
 * 매각대금처럼 큰 돈이 들어와 기준선이 필요 자산보다 훨씬 높은 계획에서, 자산이 충분한데도 기준선보다 낮다는 이유로 줄이지 않게.
 */
export function nextGuardrail(m: number, bal: number, base: number, g: GuardrailOptions, required?: number) {
  const line = required === undefined ? base : Math.min(base, Math.max(0, required));
  if (bal < line * (1 - g.band)) return Math.max(g.floor, m * (1 - g.cut));
  if (bal > base * (1 + g.band)) return Math.min(g.cutOnly ? Math.max(1, m) : g.ceil, m * (1 + g.raise));
  // 줄였던 인출은 필요 자산의 상단선만 넘어도 되돌림
  if (m < 1 && bal > line * (1 + g.band)) return Math.min(1, m * (1 + g.raise));
  return m;
}

export interface WithdrawInput {
  startAge: number;
  endAge: number;
  startBalance: number; // 은퇴 시점 금융자산(실질)
  expenseAnnual: number; // 연 생활비(실질)
  pensions: IncomeStream[];
  meanReturn: number; // 명목 %
  volatility: number; // %
  inflation: number; // %
  percentRate: number; // 정률 인출 비율 %
  debts?: Debt[]; // 은퇴 후에도 남은 대출 상환
  extras?: { age: number; amount: number; flow?: boolean }[]; // 은퇴 후 목적자금·매년 반복 지출(flow: 해마다 나가는 지출 — 첫해는 남은 달만큼)
  guardrail?: GuardrailOptions;
  expenseGrowth?: number; // 생활비 명목 증가율 %(없으면 물가 연동)
  expenseSteps?: ExpenseStep[]; // 나이 구간별 생활비 배율
  fixedDraw?: number; // 자산 인출액 명목 고정(연, 인출 시작 시점 금액)
  inflows?: { name?: string; age: number; amount: number }[]; // 노란우산 등 묶인 자산 수령액(실질)
  /** 첫해(startAge)가 1년 중 차지하는 비율(없으면 1): 이미 인출 중일 때 올해 남은 달만큼만 생활비·소득·수익을 셈 */
  firstYearShare?: number;
}

/** share: 그 해가 차지하는 비율(첫해만 1보다 작을 수 있음, 없으면 1). 금액은 그 기간의 실제 금액 */
export interface ScheduleRow { age: number; pension: number; withdrawal: number; income: number; need: number; endBalance: number; inflow: number; share?: number }

export interface StrategyResult {
  key: StrategyKey;
  successRate: number; // 생활비 90% 이상을 매년 충족한 비율
  depletionRate: number; // 자산이 고갈된 비율
  medianDepletionAge: number | null; // 전체 시나리오 고갈 나이 중앙값(과반이 유지되면 null)
  depletedMedianAge: number | null; // 고갈된 시나리오만의 고갈 나이 중앙값
  baseline?: number[]; // 가드레일 기준선(평균수익 정액 인출 연초 잔액)
  ages: number[];
  p10: number[];
  p50: number[];
  medianIncome: number[];
  schedule: ScheduleRow[];
  adjustRate: number; // 가드레일: 한 번이라도 인출을 줄인 시나리오 비율
  minMultiplier: number; // 가드레일: 하위 10% 시나리오의 최저 배율
}

const pensionAt = (inp: WithdrawInput, age: number) => inp.pensions.reduce((a, p) => a + incomeValue(p, age, inp.inflation), 0);
const debtAt = (inp: WithdrawInput, age: number) => debtPaymentAt(inp, age);
/** 그 해 목적자금·반복 지출: 해마다 나가는 흐름(flow)은 share 만큼, 한 번 쓰는 지출은 그대로 */
const extraAt = (inp: WithdrawInput, age: number, share = 1) => (inp.extras ?? []).filter((e) => e.age === age).reduce((a, e) => a + e.amount * (e.flow ? share : 1), 0);
/** 그 나이 해가 차지하는 비율: 첫해만 firstYearShare */
export const shareAt = (inp: WithdrawInput, age: number) => (age === inp.startAge && inp.firstYearShare !== undefined ? Math.min(1, Math.max(0, inp.firstYearShare)) : 1);
export const inflowOf = (inp: WithdrawInput, age: number) => (inp.inflows ?? []).filter((e) => e.age === age).reduce((a, e) => a + e.amount, 0);
/** 해당 나이의 생활비(실질) */
const livingAt = (inp: WithdrawInput, age: number) =>
  inp.expenseAnnual * expenseRatioAt(inp.expenseSteps, age) * (inp.expenseGrowth === undefined ? 1 : nominalFactor(inp.expenseGrowth, inp.inflation, age - inp.startAge));
/** 인출액 고정일 때 그해 고정액(실질): 국민·개인연금 + 자산 인출로 채움 */
const drawAt = (inp: WithdrawInput, age: number) => (inp.fixedDraw ?? 0) * nominalFactor(0, inp.inflation, age - inp.startAge);
/** 해당 나이에 자산에서 꺼내야 할 금액(연). share 를 주면 그 기간만큼(생활비·소득·대출은 비례, 한 번 쓰는 지출은 그대로) */
export const needAt = (inp: WithdrawInput, age: number, share = 1) =>
  inp.fixedDraw !== undefined
    ? (Math.max(0, drawAt(inp, age) - publicPensionAt(inp, age)) + debtAt(inp, age)) * share + extraAt(inp, age, share)
    : Math.max(0, (livingAt(inp, age) + debtAt(inp, age) - pensionAt(inp, age)) * share + extraAt(inp, age, share));
/** 해당 나이의 생활비(대출·목적자금 제외). 인출액 고정이면 소득 + 고정 인출액 */
export const livingOf = (inp: WithdrawInput, age: number) =>
  inp.fixedDraw !== undefined ? pensionAt(inp, age) - publicPensionAt(inp, age) + Math.max(drawAt(inp, age), publicPensionAt(inp, age)) : livingAt(inp, age);
/** 해당 나이의 필요 지출: 생활비 + 남은 대출 상환 + 목적자금·반복 지출 */
export const spendAt = (inp: WithdrawInput, age: number, share = 1) => (livingOf(inp, age) + debtAt(inp, age)) * share + extraAt(inp, age, share);
/** 명목 수익률 → 실질(기간 share 년) */
const toReal = (nominal: number, inf: number, share = 1) => (1 + Math.max(-0.95, nominal)) / Math.pow(1 + inf / 100, share) - 1;

type Draw = () => number;

/**
 * 필요 자산: 평균 수익이 날 때 그 해 초(그 해 유입 전) 자산이 얼마면 끝까지 계획 인출을 댈 수 있는지(실질).
 * [i] = i번째 해 초, 마지막은 0. 뒤에 들어올 일시금·매각대금은 그 해부터의 필요액에서 빼되, 들어오기 전 해의 인출은 그대로 필요
 */
export function requiredBalances(inp: WithdrawInput) {
  const years = Math.max(0, inp.endAge - inp.startAge);
  const out = new Array<number>(years + 1).fill(0);
  for (let i = years - 1; i >= 0; i--) {
    const age = inp.startAge + i;
    const sh = shareAt(inp, age);
    const r = toReal((inp.meanReturn / 100) * sh, inp.inflation, sh);
    out[i] = Math.max(0, needAt(inp, age, sh) - inflowOf(inp, age) + out[i + 1] / (1 + r));
  }
  return out;
}

/** baseline: 가드레일 기준선(평균수익 정액 인출 경로의 연초 잔액), required: 필요 자산 */
function runOne(key: StrategyKey, inp: WithdrawInput, zEq: Draw, zBd: Draw, baseline?: number[], required?: number[]) {
  const years = Math.max(0, inp.endAge - inp.startAge);
  const rows: ScheduleRow[] = [];
  let ok = true;
  let depleted = false;
  let depletedAge: number | null = null;
  const mu = inp.meanReturn / 100;
  const sg = inp.volatility / 100;

  // 버킷 초기 배분
  const firstNeed = needAt(inp, inp.startAge);
  let b1 = Math.min(inp.startBalance, firstNeed * 2);
  let b2 = Math.min(inp.startBalance - b1, firstNeed * 5);
  let b3 = inp.startBalance - b1 - b2;
  let bal = inp.startBalance;
  const g = inp.guardrail ?? DEFAULT_GUARDRAIL;
  let m = 1;
  let minM = 1;
  // 성장 바구니 수익률·변동성: 시작 시점 전체 기대수익률이 포트폴리오와 같도록 역산
  const CASH_R = 0.025;
  const BOND_R = 0.04;
  const mu3 = b3 > 0 ? Math.min(0.12, Math.max(mu, (mu * inp.startBalance - CASH_R * b1 - BOND_R * b2) / b3)) : mu;
  const sg3 = b3 > 0 ? Math.min(0.3, Math.max(sg, sg * (inp.startBalance / b3))) : sg;

  for (let i = 0; i < years; i++) {
    const age = inp.startAge + i;
    // 첫해가 1년이 안 되면 생활비·소득·수익을 그 기간만큼만(변동성은 √기간)
    const sh = shareAt(inp, age);
    const rt = Math.sqrt(sh);
    const pension = pensionAt(inp, age) * sh;
    const need = needAt(inp, age, sh);
    const inflow = inflowOf(inp, age);
    let withdrawal = 0;
    if (key === 'guardrail') {
      if (i > 0 && baseline) m = nextGuardrail(m, bal, baseline[i] ?? 0, g, required?.[i]);
      bal += inflow;
      minM = Math.min(minM, m);
      withdrawal = Math.min(bal, need * m);
      bal -= withdrawal;
      bal *= 1 + toReal(mu * sh + sg * rt * zEq(), inp.inflation, sh);
    } else if (key === 'bucket') {
      // 수령한 일시금은 성장 바구니에 넣고, 현금 → 채권 → 성장 순서로 인출
      b3 += inflow;
      const buckets = [b1, b2, b3];
      let want = need;
      for (let k = 0; k < 3 && want > 0; k++) {
        const t = Math.min(buckets[k], want);
        buckets[k] -= t;
        want -= t;
        withdrawal += t;
      }
      [b1, b2, b3] = buckets;
      const rEq = toReal(mu3 * sh + sg3 * rt * zEq(), inp.inflation, sh);
      const rBd = toReal(BOND_R * sh + 0.05 * rt * zBd(), inp.inflation, sh);
      const rCash = toReal(CASH_R * sh, inp.inflation, sh);
      b1 *= 1 + rCash;
      b2 *= 1 + rBd;
      b3 *= 1 + rEq;
      const nextNeed = needAt(inp, age + 1);
      const fill = (target: number, cur: number, from: number) => Math.max(0, Math.min(target - cur, from));
      if (rEq > 0) {
        let t = fill(nextNeed * 2, b1, b3); b1 += t; b3 -= t;
        t = fill(nextNeed * 5, b2, b3); b2 += t; b3 -= t;
      } else {
        const t = fill(nextNeed * 2, b1, b2); b1 += t; b2 -= t;
      }
      bal = b1 + b2 + b3;
    } else {
      bal += inflow;
      withdrawal = key === 'fixed' ? Math.min(bal, need) : bal * (inp.percentRate / 100) * sh;
      bal -= withdrawal;
      bal *= 1 + toReal(mu * sh + sg * rt * zEq(), inp.inflation, sh);
    }
    if (bal <= 1e-6) {
      bal = 0;
      if (need > 0 && !depleted) { depleted = true; depletedAge = age + 1; }
    }
    if (withdrawal < need * 0.9 - 1e-6) ok = false;
    rows.push({ age, pension, withdrawal, income: pension + withdrawal, need: spendAt(inp, age, sh), endBalance: bal, inflow, ...(sh < 1 ? { share: sh } : {}) });
  }
  return { rows, ok, depleted, depletedAge, minM };
}

export function compareStrategy(key: StrategyKey, inp: WithdrawInput, runs = 1000, seed = 11): StrategyResult {
  const years = Math.max(0, inp.endAge - inp.startAge);
  const ages = Array.from({ length: years }, (_, i) => inp.startAge + i);
  const g1 = normalGen(seed);
  const g2 = normalGen(seed + 1000);
  const bals: number[][] = ages.map(() => []);
  const incs: number[][] = ages.map(() => []);
  let okCount = 0;
  let depCount = 0;
  let cutCount = 0;
  const mins: number[] = [];
  const depAges: number[] = [];
  // 기준선: 평균수익으로 정액 인출했을 때의 연초 잔액
  const baseline = key === 'guardrail' ? [inp.startBalance, ...runOne('fixed', inp, () => 0, () => 0).rows.map((r) => r.endBalance)] : undefined;
  const required = key === 'guardrail' ? requiredBalances(inp) : undefined;
  for (let r = 0; r < runs; r++) {
    const { rows, ok, depleted, depletedAge, minM } = runOne(key, inp, g1, g2, baseline, required);
    if (depletedAge !== null) depAges.push(depletedAge);
    rows.forEach((row, i) => { bals[i].push(row.endBalance); incs[i].push(row.income); });
    if (ok) okCount++;
    if (depleted) depCount++;
    if (minM < 1) cutCount++;
    mins.push(minM);
  }
  const pct = (cols: number[][], p: number) => cols.map((c) => percentile(c.sort((a, b) => a - b), p));
  const det = runOne(key, inp, () => 0, () => 0, baseline, required);
  return {
    key,
    successRate: runs ? (okCount / runs) * 100 : 0,
    depletionRate: runs ? (depCount / runs) * 100 : 0,
    medianDepletionAge: depAges.length > runs / 2 ? depAges.sort((a, b) => a - b)[Math.floor(runs / 2)] : null,
    depletedMedianAge: depAges.length ? Math.round(percentile(depAges.slice().sort((a, b) => a - b), 0.5)) : null,
    baseline,
    ages,
    p10: pct(bals, 0.1),
    p50: pct(bals, 0.5),
    medianIncome: pct(incs, 0.5),
    schedule: det.rows,
    adjustRate: runs ? (cutCount / runs) * 100 : 0,
    minMultiplier: mins.length ? percentile(mins.sort((a, b) => a - b), 0.1) : 1,
  };
}

/** 가드레일 기준선: 평균수익으로 정액 인출했을 때의 연초 잔액과 그 해 인출액 */
export function guardrailBaseline(inp: WithdrawInput) {
  const rows = runOne('fixed', inp, () => 0, () => 0).rows;
  return { balances: [inp.startBalance, ...rows.map((r) => r.endBalance)], withdrawals: rows.map((r) => r.withdrawal), required: requiredBalances(inp), ...(rows[0]?.share !== undefined ? { share: rows[0].share } : {}) };
}

/** 기준선 고정 시점부터 Y년 12월 말까지 흐른 햇수(고정한 달부터 셈) */
export const yearsToYearEnd = (base: Pick<PlanBase, 'year' | 'month'>, y: number) => y - base.year + (13 - base.month) / 12;

/**
 * 흐른 햇수 t → 기준선 배열 위치. 첫해를 남은 달만큼만 계산한 기준선(share)은 [1]이 고정한 해의 12월 말이라
 * 첫 구간이 share 년, 그 뒤는 1년 단위
 */
const baseIndex = (base: Pick<PlanBase, 'share'>, t: number) => {
  const sh = base.share !== undefined && base.share > 0 && base.share < 1 ? base.share : 1;
  return t <= sh ? Math.max(0, t) / sh : 1 + (t - sh);
};

/** 기준선 잔액(명목): t년 뒤, 연 단위 값 사이는 직선 보간 */
export function baseBalanceAt(base: PlanBase, t: number) {
  return seriesAt(base, base.balances, t);
}

/** 필요 자산(명목): t년 뒤. 예전에 고정해 값이 없는 기준선은 undefined */
export function baseRequiredAt(base: PlanBase, t: number) {
  return base.required?.length ? seriesAt(base, base.required, t) : undefined;
}

/** 감액 판정선(명목): 기준선과 필요 자산 중 낮은 쪽 */
export function baseFloorAt(base: PlanBase, t: number) {
  const bl = baseBalanceAt(base, t);
  const rq = baseRequiredAt(base, t);
  return rq === undefined ? bl : Math.min(bl, rq);
}

function seriesAt(base: PlanBase, b: number[], t: number) {
  if (t <= 0) return b[0] ?? 0;
  const x = baseIndex(base, t);
  const i = Math.min(b.length - 1, Math.floor(x));
  const j = Math.min(b.length - 1, i + 1);
  const real = b[i] + (b[j] - b[i]) * (x - i);
  return real * Math.pow(1 + base.inflation / 100, t);
}

/** 기준선 계획 인출액(명목): 기간 [t0, t1] 동안 */
export function basePlanWithdrawal(base: PlanBase, t0: number, t1: number) {
  let real = 0;
  const x0 = baseIndex(base, t0);
  const x1 = baseIndex(base, t1);
  base.withdrawals.forEach((w, i) => {
    const overlap = Math.max(0, Math.min(i + 1, x1) - Math.max(i, x0));
    real += w * overlap;
  });
  return real * Math.pow(1 + base.inflation / 100, (t0 + t1) / 2);
}

export type YearEndPosition = 'below' | 'inside' | 'above';

export interface YearEndRow {
  record: YearEnd;
  t: number;
  baseline: number;
  lower: number;
  upper: number;
  position: YearEndPosition;
  multiplier: number; // 이 결산으로 정한 다음 해 인출 배율
  planWithdrawal: number; // 그 해 계획 인출액(명목)
  nextPlan: number; // 다음 해 계획 인출액(명목, 연)
  nextRecommended: number; // 배율을 적용한 다음 해 권장 인출액(명목, 연)
  /** 실제 수익률(추정, 소수) = 연말 자산 ÷ (연초 자산 − 그 해 인출) − 1. 연초 자산은 직전 해 결산(없으면 첫해의 기준선 시작 자산), 알 수 없으면 null */
  actualReturn: number | null;
  months: number; // 그 해 계획 기간(개월): 기준선을 고정한 첫해만 12보다 짧음
}

/** 기준선을 바꾸면 연말결산이 어떻게 달라지는지: 최근 판정·다음 해 권장 인출(전/후)과 판정에서 빠지는 결산 연도 */
export function rebaseDiff(from: PlanBase | undefined, to: PlanBase, records: YearEnd[], g: GuardrailOptions) {
  const before = from ? reviewYearEnds(from, records, g) : [];
  const after = reviewYearEnds(to, records, g);
  const kept = new Set(after.map((r) => r.record.year));
  return {
    before: before[before.length - 1] ?? null,
    after: after[after.length - 1] ?? null,
    dropped: before.map((r) => r.record.year).filter((y) => !kept.has(y)),
  };
}

type BaseHolder = { planBase?: PlanBase; planBasePrev?: PlanBase };

/** 기준선 다시 고정: 새 기준선으로 바꾸고 지금 기준선은 한 단계 보관 */
export function refixBase<T extends BaseHolder>(p: T, next: PlanBase): T {
  return { ...p, planBase: next, ...(p.planBase ? { planBasePrev: p.planBase } : {}) };
}

/** 이전 기준선으로 되돌리기: 보관한 기준선을 다시 쓰고 보관 칸은 비움(한 단계만) */
export function restoreBase<T extends BaseHolder>(p: T): T {
  if (!p.planBasePrev) return p;
  const { planBasePrev, ...rest } = p;
  return { ...rest, planBase: planBasePrev } as T;
}

/** 연말결산 기록을 기준선과 비교해 해마다 가드레일 판정(1년에 한 번, 직전 배율에서 이어서) */
export function reviewYearEnds(base: PlanBase, records: YearEnd[], g: GuardrailOptions): YearEndRow[] {
  let m = 1;
  const list = records.filter((r) => r.year >= base.year).slice().sort((a, b) => a.year - b.year);
  return list
    .map((record, i) => {
      const t = yearsToYearEnd(base, record.year);
      const baseline = baseBalanceAt(base, t);
      const required = baseRequiredAt(base, t);
      const lower = baseFloorAt(base, t) * (1 - g.band);
      const upper = baseline * (1 + g.band);
      const position: YearEndPosition = record.balance < lower ? 'below' : record.balance > upper ? 'above' : 'inside';
      m = nextGuardrail(m, record.balance, baseline, g, required);
      const nextPlan = basePlanWithdrawal(base, t, t + 1);
      // 연초 자산: 직전 해 결산 잔액, 첫해(기준선을 고정한 해)는 고정 시점 자산
      const prev = list[i - 1]?.year === record.year - 1 ? list[i - 1].balance : record.year === base.year ? base.balances[0] ?? 0 : 0;
      const invested = prev - record.withdrawn;
      const actualReturn = prev > 0 && invested > 0 ? record.balance / invested - 1 : null;
      const months = record.year === base.year ? 13 - base.month : 12;
      return { actualReturn, months, record, t, baseline, lower, upper, position, multiplier: m, planWithdrawal: basePlanWithdrawal(base, Math.max(0, t - 1), t), nextPlan, nextRecommended: nextPlan * m };
    });
}
