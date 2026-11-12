import { deterministicPath, simulate, type PlanInput, type SimResult } from './montecarlo';

/**
 * 스트레스 테스트: 계획에 나쁜 일 하나를 더했을 때 성공확률이 얼마나 떨어지는지.
 * 기본 계산과 같은 시드·횟수로 돌려 같은 시장 경로를 지나므로 차이는 그 사건의 영향만 남음
 */
export interface StressCase {
  key: string;
  label: string;
  desc: string;
  input: PlanInput;
}

export interface StressResult {
  key: string;
  label: string;
  desc: string;
  successRate: number;
  /** 과반이 고갈될 때만 값이 있음 */
  medianDepletionAge: number | null;
  /** 평균 수익 가정에서 자산이 바닥나는 나이(없으면 끝까지 유지) */
  depletedAt: number | null;
  /** 마지막 해 잔액 중앙값(오늘 물가) */
  endP50: number;
  lifeExpectancy: number;
}

export const STRESS_CRASH = -30; // 은퇴 첫해 수익률(%)
export const STRESS_FLAT_YEARS = 10; // 수익이 물가만큼만 나는 햇수
export const STRESS_INFLATION = 2; // 물가 추가(%p)
export const STRESS_LONG = 5; // 기대수명 추가(년)
export const STRESS_NP_CUT = 20; // 국민연금 삭감(%)

/** 인출 시작 나이(은퇴 나이, 이미 은퇴했으면 지금) */
const startAge = (input: PlanInput) => Math.max(input.retireAge, input.currentAge);

export function stressCases(input: PlanInput): StressCase[] {
  const s = startAge(input);
  const retired = input.currentAge >= input.retireAge;
  const when = retired ? '올해' : `은퇴 첫해(${s}세)`;
  const crash = [{ age: s, ret: STRESS_CRASH }];
  const flat = Array.from({ length: STRESS_FLAT_YEARS }, (_, i) => ({ age: s + i, ret: input.inflation }));
  const out: StressCase[] = [
    { key: 'crash', label: '은퇴 직후 폭락', desc: `${when} 수익률 −${-STRESS_CRASH}%, 그 뒤는 평소대로`, input: { ...input, shocks: crash } },
    { key: 'flat', label: `수익 없는 ${STRESS_FLAT_YEARS}년`, desc: `${s}~${s + STRESS_FLAT_YEARS - 1}세 수익률이 물가(${input.inflation}%)만큼만`, input: { ...input, shocks: flat } },
    { key: 'inflation', label: '고물가', desc: `물가상승률 ${input.inflation}% → ${input.inflation + STRESS_INFLATION}% (수익률은 그대로)`, input: { ...input, inflation: input.inflation + STRESS_INFLATION } },
    { key: 'long', label: '장수', desc: `${input.lifeExpectancy}세 → ${input.lifeExpectancy + STRESS_LONG}세까지`, input: { ...input, lifeExpectancy: input.lifeExpectancy + STRESS_LONG } },
  ];
  const np = input.pensions.some((p) => (p.name ?? '').includes('국민연금') && p.annual > 0);
  if (np) {
    out.push({
      key: 'npCut',
      label: '국민연금 삭감',
      desc: `부부 국민연금 ${STRESS_NP_CUT}% 감액`,
      input: { ...input, pensions: input.pensions.map((p) => ((p.name ?? '').includes('국민연금') ? { ...p, annual: p.annual * (1 - STRESS_NP_CUT / 100) } : p)) },
    });
  }
  if (!retired && input.annualSavings > 0) {
    out.push({ key: 'noSave', label: '저축 중단', desc: '지금부터 은퇴까지 새로 저축하지 않음(대출·보험이 끝나 늘어나는 저축도 없음)', input: { ...input, annualSavings: 0, ...noExtraSavings(input) } });
  }
  out.push({ key: 'combo', label: '폭락 + 고물가', desc: `${when} −${-STRESS_CRASH}% 폭락과 물가 +${STRESS_INFLATION}%p가 함께`, input: { ...input, shocks: crash, inflation: input.inflation + STRESS_INFLATION } });
  return out;
}

/**
 * 저축 중단: 은퇴 전 대출 상환이 끝나며 저축으로 돌아가는 금액도 없앰.
 * (엔진은 줄어든 상환액을 저축에 더하므로, 그만큼을 savingsChanges 로 다시 빼 줌)
 */
function noExtraSavings(input: PlanInput): Pick<PlanInput, 'savingsChanges'> {
  const changes: { fromAge: number; annual: number }[] = [];
  for (const d of input.debts ?? []) {
    if (d.decline) continue; // 원금균등의 해마다 줄어드는 폭은 작아 그대로 둠
    if (Number.isFinite(d.endAge) && d.endAge < input.retireAge && d.endAge > input.currentAge) changes.push({ fromAge: d.endAge, annual: -d.annual });
  }
  return { savingsChanges: changes };
}

export function summarizeStress(c: Pick<StressCase, 'key' | 'label' | 'desc' | 'input'>, sim: SimResult): StressResult {
  return {
    key: c.key,
    label: c.label,
    desc: c.desc,
    successRate: sim.successRate,
    medianDepletionAge: sim.medianDepletionAge,
    depletedAt: deterministicPath(c.input).depletedAt,
    endP50: sim.p50[sim.p50.length - 1] ?? 0,
    lifeExpectancy: c.input.lifeExpectancy,
  };
}

export function runStress(c: StressCase, runs = 1000): StressResult {
  return summarizeStress(c, simulate(c.input, runs));
}
