import { describe, expect, it } from 'vitest';
import { sampleData } from '../db/sample';
import { fvAnnuity, fvLump, npsFactor, payoffMonths, pmtForTarget, pvAnnuity, realRate, scale } from './finance';
import { buildPlanInput, loanEndAge, lockedInflow, planGoals, retireIncomes } from './goals';
import { insuranceGap } from './insurance';
import { deterministicPath, expenseAt, incomeValue, publicPensionAt, retireOutflowAt, retirementNeed, simulate, solveFor, withdrawStart, type PlanInput } from './montecarlo';
import { contribSchedule, creditInflows, incomeTaxAmount, incomeTaxSchedule, pensionIncomeAmount } from './incomeTax';
import { pensionLimit, pensionTaxRate, pensionTaxSchedule, retireTaxRate, taxSetup } from './tax';
import { summarize } from './portfolio';
import { prescriptions } from './prescribe';
import { financialScore, riskChecks } from './risk';
import { baseBalanceAt, basePlanWithdrawal, compareStrategy, DEFAULT_GUARDRAIL, guardrailBaseline, needAt, nextGuardrail, reviewYearEnds, yearsToYearEnd } from './withdrawal';
import type { PlanBase } from '../types';

describe('재무함수', () => {
  it('엑셀 FV/PV 와 일치', () => {
    expect(fvLump(100, 0.1, 2)).toBeCloseTo(121, 6);
    expect(fvAnnuity(100, 0.1, 2)).toBeCloseTo(210, 6);
    expect(pvAnnuity(100, 0.1, 2)).toBeCloseTo(173.553719, 5);
    // 엑셀 FV(5%/12, 120, -10, 0) = 1552.82
    expect(fvAnnuity(10, 0.05 / 12, 120)).toBeCloseTo(1552.82, 1);
  });
  it('PMT 는 FV 의 역함수', () => {
    const p = pmtForTarget(10000, 1000, 0.004, 120);
    expect(fvLump(1000, 0.004, 120) + fvAnnuity(p, 0.004, 120)).toBeCloseTo(10000, 6);
    expect(pmtForTarget(100, 1000, 0.01, 12)).toBe(0);
  });
  it('실질수익률·scale', () => {
    expect(realRate(5, 2)).toBeCloseTo(1.05 / 1.02 - 1, 10);
    expect(scale(5, 0, 10)).toBe(0.5);
    expect(scale(80, 70, 40)).toBe(0);
    expect(scale(30, 70, 40)).toBe(1);
  });
});

const base: PlanInput = {
  currentAge: 40, retireAge: 60, lifeExpectancy: 100, startBalance: 10000, annualSavings: 1200,
  meanReturn: 5, volatility: 10, inflation: 2, retireExpenseAnnual: 3000,
  pensions: [{ startAge: 65, annual: 1200 }], goals: [],
};

describe('몬테카를로', () => {
  it('같은 시드 → 같은 결과', () => {
    const a = simulate(base, 300, 1);
    const b = simulate(base, 300, 1);
    expect(a.successRate).toBe(b.successRate);
    expect(a.p50).toEqual(b.p50);
    expect(a.ages[0]).toBe(40);
    expect(a.ages.at(-1)).toBe(100);
  });
  it('변동성 0 이면 결정론적 경로와 일치', () => {
    const r = simulate({ ...base, volatility: 0 }, 50);
    const d = deterministicPath(base).balances;
    r.p50.forEach((v, i) => expect(v).toBeCloseTo(d[i], 4));
  });
  it('저축이 늘면 성공확률이 줄지 않음', () => {
    expect(simulate({ ...base, annualSavings: 3000 }).successRate).toBeGreaterThanOrEqual(simulate(base).successRate);
  });
  it('solveFor 로 찾은 저축액은 목표 확률 달성', () => {
    const v = solveFor(base, (i, x) => ({ ...i, annualSavings: x }), 0, 20000, 85)!;
    expect(v).not.toBeNull();
    expect(simulate({ ...base, annualSavings: v }, 400, 7).successRate).toBeGreaterThanOrEqual(85);
  });
});

describe('샘플 데이터 통합', () => {
  const d = sampleData(2026);
  const s = summarize(d.profile, d.assets, d.liabilities, d.cashflows, 2026);
  it('요약값', () => {
    expect(s.age).toBe(45);
    expect(s.totalDebt).toBe(30000);
    expect(s.netWorth).toBe(s.totalAssets - 30000);
    expect(s.savings).toBe(650 - (95 + 80) - 185 - 190);
    expect(s.byPurpose.reduce((a, b) => a + b.value, 0)).toBe(s.totalAssets);
  });
  it('목표·위험·보장·처방이 계산됨', () => {
    const gp = planGoals(d.goals, d.assets, s.age);
    expect(gp).toHaveLength(4);
    expect(gp[0].futureValue).toBeCloseTo(4000 * 1.04 ** 4, 4);
    const input = buildPlanInput(d.profile, d.assets, d.liabilities, d.goals, s);
    const sim = simulate(input);
    expect(sim.successRate).toBeGreaterThanOrEqual(0);
    expect(sim.successRate).toBeLessThanOrEqual(100);
    const ins = insuranceGap(d.profile, s, d.insurance, d.goals);
    expect(ins.lines).toHaveLength(3);
    const score = financialScore(d.profile, d.assets, s, sim.successRate, ins);
    expect(score.total).toBeGreaterThanOrEqual(0);
    expect(score.total).toBeLessThanOrEqual(100);
    expect(riskChecks(d.profile, d.assets, s).length).toBeGreaterThan(5);
    expect(prescriptions(d.profile, s, input, sim.successRate, gp, ins).length).toBeGreaterThan(0);
  });
});

describe('은퇴 후 운용·대출 상환', () => {
  it('원리금 균등 상환 개월 수', () => {
    expect(payoffMonths(1200, 0, 100)).toBe(12);
    // 엑셀 NPER(6%/12, -111.03, 10000) = 119.98 → 120개월
    expect(payoffMonths(10000, 6, 111.03)).toBe(120);
    expect(payoffMonths(10000, 6, 50)).toBeNull(); // 이자(50)만 겨우 냄
    expect(loanEndAge({ name: 'a', balance: 1200, rate: 0, monthlyPayment: 100 }, 45)).toEqual({ age: 46, auto: true });
    expect(loanEndAge({ name: 'a', balance: 1200, rate: 0, monthlyPayment: 100, endAge: 55 }, 45)).toEqual({ age: 55, auto: false });
  });
  it('은퇴 후 수익률을 낮추면 은퇴 전 경로는 같고 이후 잔액은 줄어듦', () => {
    const a = deterministicPath(base).balances;
    const b = deterministicPath({ ...base, retireMeanReturn: 3, retireVolatility: 5 }).balances;
    for (let i = 0; i <= 20; i++) expect(b[i]).toBeCloseTo(a[i], 6);
    expect(b[30]).toBeLessThan(a[30]);
  });
  it('은퇴 전 대출 상환이 끝나면 그 뒤로 저축이 늘어남', () => {
    const withDebt = { ...base, debts: [{ endAge: 50, annual: 600 }] };
    const a = deterministicPath(base).balances;
    const b = deterministicPath(withDebt).balances;
    expect(b[10]).toBeCloseTo(a[10], 6); // 50세 이전은 동일
    expect(b[11]).toBeCloseTo(a[11] + 600, 6); // 50세부터 +600
    expect(simulate(withDebt).successRate).toBeGreaterThanOrEqual(simulate(base).successRate);
  });
  it('은퇴 후에도 남은 대출은 지출로 계산', () => {
    const late = { ...base, debts: [{ endAge: 70, annual: 600 }] };
    const a = deterministicPath(base).balances;
    const b = deterministicPath(late).balances;
    expect(b[20]).toBeCloseTo(a[20], 6); // 은퇴 시점까지 동일(상환 중이라 저축 증가 없음)
    expect(b[21]).toBeCloseTo(a[21] - 600, 6);
    const w = { startAge: 60, endAge: 100, startBalance: 60000, expenseAnnual: 4000, pensions: [], meanReturn: 5, volatility: 10, inflation: 2, percentRate: 4 };
    const f = compareStrategy('fixed', { ...w, debts: [{ endAge: 65, annual: 600 }] }, 50);
    expect(f.schedule[0].withdrawal).toBeCloseTo(4600, 6);
    expect(f.schedule[5].withdrawal).toBeCloseTo(4000, 6);
  });
});

describe('인출 전략', () => {
  const inp = { startAge: 60, endAge: 100, startBalance: 60000, expenseAnnual: 4000, pensions: [{ startAge: 65, annual: 1500 }], meanReturn: 5, volatility: 10, inflation: 2, percentRate: 4 };
  it('정률 인출은 고갈되지 않음', () => {
    expect(compareStrategy('percent', inp, 200).depletionRate).toBe(0);
  });
  it('스케줄 길이와 버킷 결과', () => {
    const b = compareStrategy('bucket', inp, 200);
    expect(b.schedule).toHaveLength(40);
    expect(b.successRate).toBeGreaterThan(0);
    const f = compareStrategy('fixed', inp, 200);
    expect(f.schedule[0].withdrawal).toBeCloseTo(4000, 6);
    expect(f.schedule[5].withdrawal).toBeCloseTo(2500, 6);
  });
});

describe('엑셀 반영: 인출 중 은퇴자·소득·가드레일·반복 지출', () => {
  it('이미 은퇴했으면 현재 나이·현재 자산에서 인출 시작', () => {
    const retired = { ...base, currentAge: 66, retireAge: 60, startBalance: 50000 };
    const st = withdrawStart(retired);
    expect(st.retired).toBe(true);
    expect(st.age).toBe(66);
    expect(st.balance).toBe(50000);
    expect(st.outflow).toBeCloseTo(3000 - 1200, 6);
    expect(withdrawStart({ ...retired, goals: [{ age: 66, amount: 500 }] }).outflow).toBeCloseTo(2300, 6); // 그해 지출 포함
    expect(st.rate).toBeCloseTo(1800 / 50000 * 100, 6);
    const need = retirementNeed(retired);
    expect(need.startAge).toBe(66);
    expect(need.projected).toBe(50000);
    // 은퇴 전 사용자는 은퇴 나이부터
    expect(withdrawStart(base).age).toBe(60);
  });
  it('소득 흐름: 시작·종료 나이와 인상 주기', () => {
    const rent = { startAge: 60, endAge: 70, annual: 1200, growth: 5, step: 2, baseAge: 58 };
    expect(incomeValue(rent, 59, 0)).toBe(0);
    expect(incomeValue(rent, 60, 0)).toBeCloseTo(1200 * 1.05, 6); // 58세부터 2년 → 1회 인상(1회 5%)
    expect(incomeValue(rent, 61, 0)).toBeCloseTo(1200 * 1.05, 6);
    expect(incomeValue(rent, 70, 0)).toBeCloseTo(1200 * 1.05 ** 6, 6);
    expect(incomeValue(rent, 71, 0)).toBe(0);
    // 물가만큼 오르면 실질 가치 유지(매년 인상)
    expect(incomeValue({ startAge: 60, annual: 1000, growth: 2, step: 1, baseAge: 50 }, 80, 2)).toBeCloseTo(1000, 6);
    // 인상률 없음 = 실질 일정(국민연금)
    expect(incomeValue({ startAge: 65, annual: 1500 }, 90, 3)).toBe(1500);
  });
  it('배우자 국민연금은 배우자 나이를 본인 나이로 환산', () => {
    const { profile } = sampleData(2026); // 본인 45세, 배우자 43세, 배우자 65세 개시
    const list = retireIncomes(profile, 45);
    expect(list.find((x) => x.name === '배우자 국민연금')?.startAge).toBe(67);
    expect(list.find((x) => x.name === '오피스텔 월세')?.endAge).toBe(80);
  });
  it('임대료 소득이 있으면 성공확률이 줄지 않음', () => {
    const withRent = { ...base, pensions: [...base.pensions, { startAge: 60, annual: 600 }] };
    expect(simulate(withRent).successRate).toBeGreaterThanOrEqual(simulate(base).successRate);
  });
  it('반복 지출은 시작~종료 나이 매년 계산되고 목적자금 적립에서는 빠짐', () => {
    const d = sampleData(2026);
    const s = summarize(d.profile, d.assets, d.liabilities, d.cashflows, 2026);
    const inp = buildPlanInput(d.profile, d.assets, d.liabilities, d.goals, s);
    const travel = inp.goals.filter((g) => g.age >= 61 && g.age <= 75 && Math.abs(g.amount - 500) < 1e-6);
    expect(travel).toHaveLength(15);
    expect(planGoals(d.goals, d.assets, 45).some((g) => g.goal.name === '은퇴 후 여행')).toBe(false);
  });
  it('가드레일 배율: 하단선 아래 감액, 상단선 위 되돌림(감액만)', () => {
    const g = DEFAULT_GUARDRAIL;
    expect(nextGuardrail(1, 80, 100, g)).toBeCloseTo(0.9, 6); // -20% → 10% 감액
    expect(nextGuardrail(0.9, 90, 100, g)).toBeCloseTo(0.9, 6); // 기준선 안 → 유지
    expect(nextGuardrail(0.9, 120, 100, g)).toBeCloseTo(0.99, 6); // 상단선 위 → 되돌림
    expect(nextGuardrail(1, 120, 100, g)).toBe(1); // 감액만: 계획보다 늘리지 않음
    expect(nextGuardrail(1, 120, 100, { ...g, cutOnly: false })).toBeCloseTo(1.1, 6);
    expect(nextGuardrail(0.72, 10, 100, g)).toBe(0.7); // 최저 배율
    expect(nextGuardrail(1.25, 200, 100, { ...g, cutOnly: false })).toBe(1.3); // 최고 배율
  });
  it('가드레일 인출은 정액보다 고갈 확률이 낮고, 평균수익 경로에서는 정액과 같음', () => {
    const inp = { startAge: 60, endAge: 100, startBalance: 60000, expenseAnnual: 4000, pensions: [{ startAge: 65, annual: 1500 }], meanReturn: 5, volatility: 12, inflation: 2, percentRate: 4 };
    const f = compareStrategy('fixed', inp, 500);
    const gr = compareStrategy('guardrail', inp, 500);
    expect(gr.depletionRate).toBeLessThanOrEqual(f.depletionRate);
    expect(gr.adjustRate).toBeGreaterThan(0);
    expect(gr.minMultiplier).toBeGreaterThanOrEqual(0.7);
    gr.schedule.forEach((r, i) => expect(r.withdrawal).toBeCloseTo(f.schedule[i].withdrawal, 6));
  });
  it('인출 화면 추가 지출(extras)은 해당 연도 인출액에 더해짐', () => {
    const inp = { startAge: 60, endAge: 70, startBalance: 60000, expenseAnnual: 4000, pensions: [], meanReturn: 5, volatility: 10, inflation: 2, percentRate: 4, extras: [{ age: 62, amount: 800 }] };
    const f = compareStrategy('fixed', inp, 20);
    expect(f.schedule[2].withdrawal).toBeCloseTo(4800, 6);
    expect(f.schedule[3].withdrawal).toBeCloseTo(4000, 6);
  });
  it('국민연금 조기·연기 수령 배율', () => {
    expect(npsFactor(65, 65)).toBe(1);
    expect(npsFactor(62, 65)).toBeCloseTo(0.82, 6);
    expect(npsFactor(70, 65)).toBeCloseTo(1.36, 6);
    expect(npsFactor(58, 65)).toBeCloseTo(0.7, 6); // 최대 5년
  });
  it('위험 점검에 인출률 항목', () => {
    const d = sampleData(2026);
    const s = summarize(d.profile, d.assets, d.liabilities, d.cashflows, 2026);
    const c = riskChecks(d.profile, d.assets, s, { rate: 7, age: 60, retired: false }).find((x) => x.key === 'withdraw');
    expect(c?.level).toBe('danger');
  });
});

describe('부부 소득·연금, 가드레일 비교, 연말결산', () => {
  const base = () => {
    const d = sampleData(2026);
    d.profile = { ...d.profile, birthYear: 1968, spouseBirthYear: 1973, retireAge: 58, spousePension: 100, spousePensionAge: 65 };
    return d;
  };
  it('배우자 나이 기준 소득·연금은 본인 나이로 바뀜', () => {
    const d = base();
    d.profile.spousePrivatePension = 50;
    d.profile.spousePrivatePensionAge = 55;
    d.profile.incomes = [{ name: '아내 임대료', monthly: 100, startAge: 53, endAge: 95, growth: 0, step: 1, owner: 'spouse' }];
    const list = retireIncomes(d.profile, 58);
    expect(list.find((x) => x.name === '배우자 국민연금')?.startAge).toBe(70);
    expect(list.find((x) => x.name === '배우자 개인·퇴직연금')?.startAge).toBe(60);
    const rent = list.find((x) => x.name === '아내 임대료')!;
    expect(rent.startAge).toBe(58);
    expect(rent.endAge).toBe(100);
  });
  it('본인이 먼저 은퇴하면 배우자 은퇴 전까지 배우자 소득이 은퇴 후 소득으로 들어감', () => {
    const d = sampleData(2026); // 본인 45세, 배우자 43세
    d.profile = { ...d.profile, spouseIncome: 200, spouseRetireAge: 62 }; // 배우자 62세 = 본인 64세
    const inc = retireIncomes(d.profile, 45).find((x) => x.name === '배우자 근로소득')!;
    expect(inc.startAge).toBe(60);
    expect(inc.endAge).toBe(63);
  });
  it('배우자가 먼저 은퇴하면 그때부터 은퇴 전 저축이 줄어듦', () => {
    const d = sampleData(2026);
    d.profile = { ...d.profile, spouseIncome: 150, spouseRetireAge: 50 }; // 본인 52세에 배우자 은퇴
    const s = summarize(d.profile, d.assets, d.liabilities, d.cashflows, 2026);
    const inp = buildPlanInput(d.profile, d.assets, d.liabilities, d.goals, s);
    expect(inp.savingsChanges).toEqual([{ fromAge: 52, annual: -1800 }]);
    const without = buildPlanInput({ ...d.profile, spouseIncome: 0 }, d.assets, d.liabilities, d.goals, s);
    expect(deterministicPath(inp).balances[15]).toBeLessThan(deterministicPath(without).balances[15]);
  });
  it('전략 결과에 고갈 나이 중앙값이 들어 있고, 가드레일은 고갈 경로를 늦춤', () => {
    const inp = { startAge: 60, endAge: 100, startBalance: 50000, expenseAnnual: 4000, pensions: [{ startAge: 65, annual: 1000 }], meanReturn: 5, volatility: 12, inflation: 2, percentRate: 4 };
    const f = compareStrategy('fixed', inp, 500);
    const gr = compareStrategy('guardrail', inp, 500);
    expect(f.depletedMedianAge).not.toBeNull();
    if (gr.depletedMedianAge !== null) expect(gr.depletedMedianAge).toBeGreaterThanOrEqual(f.depletedMedianAge!);
    if (f.depletionRate <= 50) expect(f.medianDepletionAge).toBeNull();
  });
  it('연말결산: 기준선 보간·명목 환산과 해마다 이어지는 가드레일 판정', () => {
    const pb: PlanBase = { savedAt: '2026-11-09', year: 2026, month: 11, inflation: 0, balances: [10000, 9000, 8000, 7000], withdrawals: [1200, 1200, 1200] };
    expect(yearsToYearEnd(pb, 2026)).toBeCloseTo(2 / 12, 6);
    expect(baseBalanceAt(pb, 1.5)).toBeCloseTo(8500, 6);
    expect(basePlanWithdrawal(pb, 0, 2 / 12)).toBeCloseTo(200, 6); // 11·12월 두 달
    const rows = reviewYearEnds(pb, [{ year: 2027, balance: 7000, withdrawn: 1200 }, { year: 2026, balance: 9900, withdrawn: 200 }], DEFAULT_GUARDRAIL);
    expect(rows.map((r) => r.position)).toEqual(['inside', 'below']); // 2027 말 기준선 ≈ 8833, 하단선 ≈ 7508
    expect(rows[1].multiplier).toBeCloseTo(0.9, 6);
    expect(rows[1].nextRecommended).toBeCloseTo(rows[1].nextPlan * 0.9, 6);
    expect(baseBalanceAt({ ...pb, inflation: 2 }, 1)).toBeCloseTo(9000 * 1.02, 6);
  });
  it('기준선은 평균수익 정액 인출 경로', () => {
    const inp = { startAge: 60, endAge: 63, startBalance: 10000, expenseAnnual: 1000, pensions: [], meanReturn: 2, volatility: 10, inflation: 2, percentRate: 4 };
    const b = guardrailBaseline(inp);
    expect(b.balances[0]).toBe(10000);
    expect(b.balances[1]).toBeCloseTo(9000, 6); // 실질수익 0%
    expect(b.withdrawals).toEqual([1000, 1000, 1000]);
  });
  it('은퇴자는 저축률 대신 인출률로 점검·점수', () => {
    const d = sampleData(2026);
    const s = summarize(d.profile, d.assets, d.liabilities, d.cashflows, 2026);
    const c = riskChecks(d.profile, d.assets, s, { rate: 3, age: 60, retired: true });
    expect(c.some((x) => x.key === 'savings')).toBe(false);
    const ins = insuranceGap(d.profile, s, d.insurance, d.goals);
    expect(financialScore(d.profile, d.assets, s, 80, ins, { rate: 3, retired: true }).items[0].label).toBe('인출률');
  });
});

describe('생활비 명목 고정, 노란우산 수령, 연금 세금', () => {
  const retiree = () => {
    const d = sampleData(2026);
    d.profile = { ...d.profile, birthYear: 1968, retireAge: 58, inflation: 2.5, retireMonthlyExpense: 500 };
    d.liabilities = [];
    return d;
  };
  const plan = (d: ReturnType<typeof sampleData>) => buildPlanInput(d.profile, d.assets, d.liabilities, d.goals, summarize(d.profile, d.assets, d.liabilities, d.cashflows, 2026));

  it('생활비 명목 고정은 실질 생활비가 물가만큼 줄고, 연금 생활비 고정은 국민·개인연금만큼만 인출이 줄어듦', () => {
    const d = retiree();
    const real = plan(d);
    const flat = plan({ ...d, profile: { ...d.profile, expenseMode: 'growth', expenseGrowth: 0 } });
    expect(expenseAt(real, 78)).toBeCloseTo(6000, 6);
    expect(expenseAt(flat, 78)).toBeCloseTo(6000 / Math.pow(1.025, 20), 4);
    const draw = plan({ ...d, profile: { ...d.profile, expenseMode: 'draw', fixedDraw: 300 } });
    expect(draw.fixedDraw).toBe(3600);
    // 명목 3,600(실질은 물가만큼 감소)을 국민연금과 자산 인출로 채움: 국민연금이 나오면 그만큼 인출 감소
    const nps = publicPensionAt(draw, 68); // 국민연금 + 개인연금
    expect(retireOutflowAt(draw, 58)).toBeCloseTo(3600, 6);
    expect(retireOutflowAt(draw, 68)).toBeCloseTo(Math.max(0, 3600 / Math.pow(1.025, 10) - nps), 4);
    expect(deterministicPath(draw).balances.at(-1)!).toBeGreaterThanOrEqual(deterministicPath(real).balances.at(-1)!);
    // 인출 엔진도 같은 규칙
    const w = { startAge: 58, endAge: 100, startBalance: 50000, expenseAnnual: 6000, pensions: [{ startAge: 64, annual: 1200, kind: 'pension' as const }, { startAge: 58, annual: 4800 }], meanReturn: 5, volatility: 8, inflation: 2.5, percentRate: 4, fixedDraw: 3600 };
    expect(needAt(w, 58)).toBeCloseTo(3600, 6); // 임대료 4,800은 인출을 줄이지 않음
    expect(needAt(w, 64)).toBeCloseTo(3600 / Math.pow(1.025, 6) - 1200, 4);
  });

  it('수령 전 노란우산은 시작 자산에서 빠지고 수령 연도에 세후 일시금으로 들어옴', () => {
    const d = retiree();
    d.assets = [
      { name: '연금저축', type: 'pension', amount: 50000, expectedReturn: 5, volatility: 8, purpose: 'long', nature: 'invest' },
      { name: '노란우산', type: 'other', amount: 4350, expectedReturn: 3.3, volatility: 0, purpose: 'long', nature: 'safe', lockYear: 2029, lockTax: 4 },
    ];
    const inp = plan(d);
    expect(inp.startBalance).toBe(50000);
    expect(inp.inflows).toHaveLength(1);
    expect(inp.inflows![0].age).toBe(61);
    const nominal = 4350 * Math.pow(1.033, 3) * 0.96;
    expect(lockedInflow(d.assets[1], d.profile, 2026).nominal).toBeCloseTo(nominal, 4);
    expect(inp.inflows![0].amount).toBeCloseTo(nominal / Math.pow(1.025, 3), 4);
    // 은퇴 전 수익률도 꺼낼 수 있는 자산 기준
    expect(inp.meanReturn).toBe(5);
    // 수령 연도가 지나면 일반 자산
    d.assets[1].lockYear = 2025;
    expect(plan(d).startBalance).toBe(54350);
  });

  it('연금소득세율과 1,500만 한도 초과 경고', () => {
    expect(pensionTaxRate(69)).toBe(5.5);
    expect(pensionTaxRate(70)).toBe(4.4);
    expect(pensionTaxRate(80)).toBe(3.3);
    expect(retireTaxRate(10, 2034, 2025)).toBeCloseTo(7, 6);
    expect(retireTaxRate(10, 2035, 2025)).toBeCloseTo(6, 6);
    const d = retiree();
    d.profile = { ...d.profile, spouseBirthYear: 0, inflation: 0, retireTaxRate: 10, retireTaxYear1: 2025 };
    d.assets = [{ name: 'IRP', type: 'pension', amount: 10000, expectedReturn: 0, volatility: 0, purpose: 'long', nature: 'safe', taxFree: 1000, retirePart: 3000, pensionYear1: 2010 }];
    const setup = taxSetup(d.profile, d.assets, 2026, 10000, 0)!;
    expect(setup.accounts[0]).toMatchObject({ free: 1000, retire: 3000, taxed: 6000 });
    const row = (age: number, withdrawal: number) => ({ age, pension: 0, withdrawal, income: withdrawal, need: withdrawal, endBalance: 0, inflow: 0 });
    // 1년차: 과세제외 1,000 → 과세재원 1,500(5.5%) → 퇴직금 재원(7%)
    const r = pensionTaxSchedule([row(58, 3000)], setup).rows[0];
    expect(r.slot.self).toBeCloseTo(1500, 6);
    expect(r.tax).toBeCloseTo(1500 * 0.055 + ((3000 - 1000 - 1500 * 0.945) / 0.93) * 0.07, 6);
    expect(r.gross - r.tax).toBeCloseTo(3000, 6);
    // 퇴직금 재원·과세제외를 다 쓰면 한도를 넘어 16.5%
    const res = pensionTaxSchedule([row(58, 3000), row(59, 3000), row(60, 3000)], setup);
    expect(res.overYears.length).toBeGreaterThan(0);
    expect(res.rows.some((x) => x.over.self > 0)).toBe(true);
  });

  it('계좌별 연금수령한도: 평가액 ÷ (11 − 연차) × 120%, 넘는 금액은 연금외수령으로 경고', () => {
    expect(pensionLimit(10000, 0)).toBe(0);
    expect(pensionLimit(10000, 1)).toBeCloseTo(1200, 6);
    expect(pensionLimit(10000, 10)).toBeCloseTo(12000, 6);
    expect(pensionLimit(10000, 11)).toBe(Infinity);
    const d = retiree();
    d.profile = { ...d.profile, spouseBirthYear: 0, inflation: 0, retireTaxRate: 10, retireTaxYear1: 2025 };
    const acct = (year1: number) => [{ name: 'IRP', type: 'pension' as const, amount: 10000, expectedReturn: 0, volatility: 0, purpose: 'long' as const, nature: 'safe' as const, pensionYear1: year1 }];
    const row = (withdrawal: number) => ({ age: 58, pension: 0, withdrawal, income: withdrawal, need: withdrawal, endBalance: 0, inflow: 0 });
    const run = (year1: number, w: number) => pensionTaxSchedule([row(w)], taxSetup(d.profile, (d.assets = acct(year1)), 2026, 10000, 0)!);
    // 1년차(2026) 한도 1,200: 1,000 인출은 한도 안
    const ok = run(2026, 1000);
    expect(ok.limitWarnings).toHaveLength(0);
    expect(ok.rows[0].accounts[0]).toMatchObject({ yearNo: 1 });
    expect(ok.rows[0].accounts[0].limit).toBeCloseTo(1200, 6);
    // 2,000 인출: 1,200은 연금소득세 5.5%, 나머지는 한도 초과 16.5%
    const bad = run(2026, 2000);
    const over = (2000 - 1200 * 0.945) / 0.835;
    expect(bad.rows[0].accounts[0].over).toBeCloseTo(over, 6);
    expect(bad.rows[0].tax).toBeCloseTo(1200 * 0.055 + over * 0.165, 6);
    expect(bad.limitWarnings[0]).toMatchObject({ name: 'IRP', years: [2026] });
    // 11년차부터는 한도 없음
    expect(run(2016, 2000).limitWarnings).toHaveLength(0);
    // 1년차 전에는 꺼낼 수 없음
    expect(run(2027, 1000).rows[0].short).toBeCloseTo(1000, 6);
  });
  it('종합소득세·건보료: 엑셀 종합소득·건보료 시트 값과 같음', () => {
    // 엑셀 2034년: 남편 국민연금 세전 2,811.98만 → 연금소득금액 1,534.63만 → 종소세 91.39만, 아내 임대 사업소득 2,917.22만 → 317.99만
    expect(pensionIncomeAmount(2811.9825144 * 0.8)).toBeCloseTo(1534.6274, 3);
    expect(incomeTaxAmount(1534.6274104 - 150)).toBeCloseTo(91.3854, 3);
    expect(incomeTaxAmount(2917.215 - 150)).toBeCloseTo(317.990475, 4);
    expect(pensionIncomeAmount(300)).toBe(0);
    // 2026년(국민연금 전): 임대 월 400 · 아내 몫 100% · 필요경비 50% → 종소세 232.65만, 월 건보료는 고지서 72.482만 그대로
    const d = retiree();
    d.profile = {
      ...d.profile, spouseBirthYear: 1973, inflation: 0, nationalPension: 200, nationalPensionAge: 64, spousePension: 0,
      incomes: [{ name: '임대료', monthly: 400, startAge: 58, endAge: 0, growth: 0, step: 1, rent: true }],
      incomeTax: { on: true, rentSpouseShare: 100, rentExpense: 50, npTaxable: 80, npNet: 100, dedSelf: 150, dedSpouse: 150, hiNow: 72.482, hiRate: 7.19, hiLtc: 13.14, hiPublic: 50, hiPropGrowth: 0, hiPrivate: false, addToDraw: true },
    };
    const rows = incomeTaxSchedule(d.profile, 2026);
    expect(rows[0].taxSpouse).toBeCloseTo(232.65, 6);
    expect(rows[0].hiMonth).toBeCloseTo(72.482, 6);
    expect(rows[0].npPart).toBe(0);
    // 64세(2032)부터 국민연금: 종소세가 생기고, 건보료는 다음 해부터 국민연금 50% 반영
    const y32 = rows.find((r) => r.year === 2032)!;
    const y33 = rows.find((r) => r.year === 2033)!;
    expect(y32.taxSelf).toBeCloseTo(incomeTaxAmount(pensionIncomeAmount(2400 * 0.8) - 150), 6);
    expect(y33.hiMonth - y32.hiMonth).toBeCloseTo(((2400 * 0.5) / 12) * 0.0719 * 1.1314, 6);
    expect(y33.npPart).toBeCloseTo(y33.taxSelf + 2400 * 0.5 * 0.0719 * 1.1314, 6);
    // 인출에 더하기를 켜면 국민연금 몫이 지출로 들어감
    const at65 = (x: typeof d) => plan(x).goals.filter((g) => g.age === 65).reduce((a, g) => a + g.amount, 0);
    const off = { ...d, profile: { ...d.profile, incomeTax: { ...d.profile.incomeTax!, addToDraw: false } } };
    expect(at65(d) - at65(off)).toBeCloseTo(y33.npPart, 6);
  });

  it('추가 납입 세액공제: 900만 한도·공제율·종소세 한도, 환급은 다음 해 유입', () => {
    const d = retiree();
    d.profile = {
      ...d.profile, spouseBirthYear: 1973, inflation: 0, nationalPension: 0, spousePension: 0,
      incomes: [{ name: '임대료', monthly: 400, startAge: 58, endAge: 0, growth: 0, step: 1, rent: true }],
      incomeTax: { on: true, rentSpouseShare: 100, rentExpense: 50, npTaxable: 80, npNet: 100, dedSelf: 150, dedSpouse: 150, hiNow: 0, hiRate: 7.19, hiLtc: 13.14, hiPublic: 50, hiPropGrowth: 0, hiPrivate: false, addToDraw: false },
      contrib: { self: 600, spouse: 1200, from: 2027, to: 2028, selfRate: 0, spouseRate: 13.2 },
    };
    const rows = incomeTaxSchedule(d.profile, 2026);
    const c = contribSchedule(d.profile, rows);
    expect(c.map((x) => x.year)).toEqual([2027, 2028]);
    // 아내: 900만 × 13.2% = 118.8만(종소세 232.65만 안), 남편: 종합소득 없음 → 공제 0, 전액 과세제외
    expect(c[0].creditSpouse).toBeCloseTo(118.8, 6);
    expect(c[0].taxedSpouse).toBeCloseTo(900, 6);
    expect(c[0].rateSelf).toBe(16.5);
    expect(c[0].creditSelf).toBe(0);
    expect(c[0].taxedSelf).toBe(0);
    const inflow = creditInflows(d.profile, 2026, c);
    expect(inflow[0]).toMatchObject({ age: 2028 - 1968 });
    expect(inflow[0].amount).toBeCloseTo(118.8, 6);
    expect(plan(d).inflows!.some((x) => x.name === '세액공제 환급')).toBe(true);
  });

  it('계좌별 인출 시작 연도·순서, 1,500만 한도 채우기, 추가 납입', () => {
    const d = retiree();
    const base = { type: 'pension' as const, expectedReturn: 0, volatility: 0, purpose: 'long' as const, nature: 'safe' as const, pensionYear1: 2010 };
    d.profile = { ...d.profile, spouseBirthYear: 1968, inflation: 0, retireTaxRate: 10, retireTaxYear1: 2025 };
    d.assets = [
      { ...base, name: '키움', amount: 2000, drawStartYear: 2032 },
      { ...base, name: 'IRP', amount: 3000, drawOrder: 2 },
      { ...base, name: '교보', amount: 3000, drawOrder: 1 },
      { ...base, name: '아내 IRP', amount: 1000, owner: 'spouse' },
      { name: 'ISA', type: 'etf', amount: 1000, expectedReturn: 0, volatility: 0, purpose: 'long', nature: 'invest' },
    ];
    const row = (withdrawal: number) => ({ age: 58, pension: 0, withdrawal, income: withdrawal, need: withdrawal, endBalance: 0, inflow: 0 });
    const setup = taxSetup(d.profile, d.assets, 2026, 10000, 0)!;
    expect(setup.accounts.map((a) => a.name)).toEqual(['교보', 'IRP', '키움', '아내 IRP']);
    // 945 세후 = 교보 1,000(5.5%)만 사용, 키움은 2032년 전이라 그대로
    const r1 = pensionTaxSchedule([row(945)], setup).rows[0];
    expect(r1.accounts.find((a) => a.name === '교보')!.drawn).toBeCloseTo(1000, 6);
    expect(r1.accounts.find((a) => a.name === 'IRP')!.drawn).toBe(0);
    expect(r1.accounts.find((a) => a.name === '키움')!.drawn).toBe(0);
    // 한도 꽉 채우기: 본인·배우자 각 1,500만까지 더 꺼내 세후로 ISA에 재투자
    d.profile.slotFill = true;
    const r2 = pensionTaxSchedule([row(945)], taxSetup(d.profile, d.assets, 2026, 10000, 0)!).rows[0];
    expect(r2.slot.self).toBeCloseTo(1500, 6);
    expect(r2.slot.spouse).toBeCloseTo(1000, 6);
    expect(r2.reinvest).toBeCloseTo((500 + 1000) * 0.945, 6);
    expect(r2.isa).toBeCloseTo(1000 + 1500 * 0.945, 6);
    // 추가 납입: 본인 600은 인출 시작 전 계좌(키움)로, ISA에서 냄
    d.profile.slotFill = false;
    d.profile.contrib = { self: 600, spouse: 0, from: 2026, to: 2026, selfRate: 16.5, spouseRate: 0 };
    const r3 = pensionTaxSchedule([row(0)], taxSetup(d.profile, d.assets, 2026, 10000, 0)!).rows[0];
    expect(r3.contrib).toBeCloseTo(600, 6);
    expect(r3.isa).toBeCloseTo(400, 6);
    expect(r3.gross).toBe(0);
  });
});
