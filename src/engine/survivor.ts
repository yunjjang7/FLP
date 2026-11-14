import { expenseRatioAt, pensionAt, type ExpenseStep, type IncomeStream, type PlanInput } from './montecarlo';
import type { StressCase } from './stress';

/**
 * 배우자 사별 분석: 부부 중 한 사람이 먼저 세상을 떠났을 때 남은 사람의 노후 자금.
 * 바뀌는 것: 생활비(1인 가구 비율), 국민연금(떠난 사람 몫은 끊기고 유족연금), 떠난 사람의 개인연금·근로소득, 사망보험금, 계획 기간(남은 사람 기대수명).
 */
export type Who = 'self' | 'spouse';

/** 유족연금 지급률(%): 떠난 사람의 국민연금 가입기간 10년 미만 40 · 10~20년 50 · 20년 이상 60 */
export const SURVIVOR_RATES = [40, 50, 60];
/** 본인 노령연금과 유족연금이 겹칠 때: 본인 노령연금 + 유족연금의 30%, 또는 유족연금만 가운데 큰 쪽 */
export const SURVIVOR_OVERLAP = 0.3;
/** 1인 가구 생활비 기본 비율(%) */
export const SURVIVOR_LIVING = 70;
/** 분석할 사별 시점(본인 나이) */
export const SURVIVOR_AGES = [65, 75, 85];

export interface SurvivorOptions {
  dies: Who; // 먼저 떠나는 사람
  age: number; // 그때 본인 나이(그 해부터 혼자)
  livingRatio: number; // 혼자일 때 생활비 비율(%)
  rate: number; // 유족연금 지급률(%)
  spouseGap: number; // 배우자 출생연도 − 본인 출생연도(배우자가 어리면 +)
  deathBenefit?: number; // 사망보험금(계약 금액 그대로, 만원)
}

const NP = { self: '국민연금', spouse: '배우자 국민연금' } as const;
const PRIVATE = { self: '개인·퇴직연금', spouse: '배우자 개인·퇴직연금' } as const;
const SPOUSE_WORK = '배우자 근로소득';

/** 그 나이 전 해까지만 받게 자름(이미 그 전에 끝나면 그대로, 시작 전이면 없앰) */
function cut(p: IncomeStream, age: number): IncomeStream | null {
  if (p.startAge >= age) return null;
  return { ...p, endAge: p.endAge !== undefined && p.endAge > 0 ? Math.min(p.endAge, age - 1) : age - 1 };
}

/** 사별 뒤 소득 목록 */
export function survivorIncomes(pensions: IncomeStream[], o: SurvivorOptions): IncomeStream[] {
  const left: Who = o.dies === 'self' ? 'spouse' : 'self';
  const gone = pensions.find((p) => p.name === NP[o.dies]);
  const mine = pensions.find((p) => p.name === NP[left]);
  const out: IncomeStream[] = [];
  for (const p of pensions) {
    if (p === mine) continue; // 아래에서 유족연금과 함께 정함
    const stops = p.name === NP[o.dies] || p.name === PRIVATE[o.dies] || (o.dies === 'spouse' && p.name === SPOUSE_WORK);
    const x = stops ? cut(p, o.age) : p;
    if (x) out.push(x);
  }
  // 유족연금: 떠난 사람 연금액 × 지급률(받기 전에 떠나도 예상 연금액 기준), 인상 조건은 같게
  const base = gone ? (gone.annual * Math.min(100, Math.max(0, o.rate))) / 100 : 0;
  const widow = (startAge: number, annual: number, endAge?: number): IncomeStream => ({
    name: '유족연금', kind: 'pension', startAge, annual, ...(endAge !== undefined ? { endAge } : {}),
    ...(gone?.growth !== undefined ? { growth: gone.growth, step: gone.step, baseAge: gone.baseAge } : {}),
  });
  if (!mine) {
    if (base > 0) out.push(widow(o.age, base));
    return out;
  }
  // 남은 사람의 노령연금이 시작되기 전에는 유족연금만
  const from = Math.max(o.age, mine.startAge);
  if (base > 0 && o.age < mine.startAge) out.push(widow(o.age, base, mine.startAge - 1));
  if (mine.annual + base * SURVIVOR_OVERLAP >= base) {
    out.push(mine);
    if (base > 0) out.push(widow(from, base * SURVIVOR_OVERLAP));
  } else {
    const kept = cut(mine, from);
    if (kept) out.push(kept);
    out.push(widow(from, base));
  }
  return out;
}

/** 혼자가 되는 나이부터 생활비 배율에 ratio 를 곱한 구간표 */
export function survivorSteps(steps: ExpenseStep[] | undefined, age: number, ratio: number): ExpenseStep[] {
  const ages = [...new Set([...(steps ?? []).map((s) => s.fromAge), age])].sort((a, b) => a - b);
  return ages.map((a) => ({ fromAge: a, ratio: expenseRatioAt(steps, a) * (a >= age ? ratio : 1) }));
}

/** 사별을 반영한 계획 입력 */
export function survivorInput(input: PlanInput, o: SurvivorOptions): PlanInput {
  // 본인이 먼저 떠나면 계획은 배우자 기대수명까지(배우자가 어리면 그만큼 길어짐)
  const life = o.dies === 'self' ? Math.max(o.age + 1, input.lifeExpectancy + o.spouseGap) : input.lifeExpectancy;
  const benefit = (o.deathBenefit ?? 0) / Math.pow(1 + input.inflation / 100, Math.max(0, o.age - input.currentAge));
  return {
    ...input,
    lifeExpectancy: life,
    death: { who: o.dies, age: o.age },
    pensions: survivorIncomes(input.pensions, o),
    // 인출액 고정 방식은 나이 구간별 생활비를 쓰지 않아 생활비 비율을 반영하지 못함
    ...(input.fixedDraw === undefined ? { expenseSteps: survivorSteps(input.expenseSteps, o.age, o.livingRatio / 100) } : {}),
    ...(benefit > 0.5 ? { inflows: [...(input.inflows ?? []), { name: '사망보험금', age: o.age, amount: benefit }] } : {}),
  };
}

export interface SurvivorCase extends StressCase {
  dies: Who;
  age: number;
  incomeBefore: number; // 사별 다음 해 부부 연금·소득(연, 오늘 물가) — 사별이 없을 때
  incomeAfter: number; // 사별 다음 해 혼자의 연금·소득
  /** 보험 탭에서 떠난 사람의 사망보장 합계(계약 금액, 만원) */
  benefit: number;
  /** 사망보장이 있을 때만: 사망보험금 없이 같은 사별을 돌린 계획(보험이 성공확률에 얼마나 기여하는지 비교용) */
  noBenefit?: PlanInput;
}

/** 본인·배우자가 각각 65·75·85세(본인 나이)에 먼저 떠나는 경우들 */
export function survivorCases(input: PlanInput, base: Omit<SurvivorOptions, 'dies' | 'age' | 'deathBenefit'>, benefits: Record<Who, number>, ages = SURVIVOR_AGES): SurvivorCase[] {
  const out: SurvivorCase[] = [];
  for (const dies of ['self', 'spouse'] as const) {
    for (const age of ages) {
      if (age <= input.currentAge || age >= input.lifeExpectancy) continue;
      const o: SurvivorOptions = { ...base, dies, age, deathBenefit: benefits[dies] };
      const next = survivorInput(input, o);
      const spouseAge = age - base.spouseGap;
      out.push({
        key: `${dies}-${age}`,
        label: dies === 'self' ? `본인이 ${age}세에 먼저` : `배우자가 ${spouseAge}세에 먼저`,
        desc: dies === 'self' ? `배우자 ${spouseAge}세부터 혼자 · ${next.lifeExpectancy}세(본인 나이 기준)까지` : `본인 ${age}세부터 혼자`,
        input: next,
        dies,
        age,
        incomeBefore: pensionAt(input, age + 1),
        incomeAfter: pensionAt(next, age + 1),
        benefit: Math.max(0, benefits[dies] ?? 0),
        ...(next.inflows?.some((f) => f.name === '사망보험금') ? { noBenefit: survivorInput(input, { ...o, deathBenefit: 0 }) } : {}),
      });
    }
  }
  return out;
}
