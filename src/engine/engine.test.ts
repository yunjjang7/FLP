import { describe, expect, it } from 'vitest';
import { won } from '../lib/format';
import { sampleData } from '../db/sample';
import { fvAnnuity, fvLump, npsFactor, payoffMonths, pmtForTarget, pvAnnuity, realRate, scale } from './finance';
import { buildPlanInput, expenseSteps, goalItemsFrom, goalPlanSkips, loanEndAge, onceGoalPlans, lockedInflow, planGoals, retireIncomes } from './goals';
import { CRITICAL_BASE, insuranceGap } from './insurance';
import { deterministicPath, expenseAt, expenseRatioAt, goalBreakdownAt, goalKind, GUARD_CUTS, GUARD_DROPS, guardrailSim, incomeValue, weakestGuardrail, outflowAt, publicPensionAt, retireOutflowAt, retirementNeed, savingsAt, simulate, solveFor, withdrawStart, yearShareAt, type PlanInput } from './montecarlo';
import { contribSchedule, creditInflows, hiDependent, hiPropMonthly, hiPropShare, incomeKindOf, incomeTaxAmount, incomeTaxSchedule, pensionIncomeAmount, personIncomeTax, wageIncomeAmount, wageTaxCredit, wageWithholding } from './incomeTax';
import { CHECK_AGE, checkAge, checkAt, hasCompareOrder, orderCombos, runCombo, summarizeTax, type ComboResult } from './orderCompare';
import { rentDuplicates, rentStreams } from './realestate';
import { pensionLimit, pensionTaxRate, pensionTaxSchedule, retireRateAt, retireTaxRate, taxSetup, type TaxResult } from './tax';
import { accountBuckets, isRiskCapped, marketRule, marketState } from './buckets';
import { milestones, monthsUntil, untilLabel, yearTodos } from './milestones';
import { isPaying, payEndSelfAge, pensionOverlap, summarize, volCheck, volMid, volRange } from './portfolio';
import { bucketMap, emergencyPrescription, goalPrescription, guardrailPrescription, prescriptions, recurringGoalPrescription, retiredGoalPrescription, savingsPrescription } from './prescribe';
import { emergencyCap, emergencyDetail, emergencyRunway, emergencyScore, financialScore, retiredBasis, riskChecks } from './risk';
import { baseBalanceAt, basePlanWithdrawal, compareStrategy, DEFAULT_GUARDRAIL, guardrailBaseline, needAt, nextGuardrail, rebaseDiff, refixBase, restoreBase, reviewYearEnds, shareAt, yearsToYearEnd } from './withdrawal';
import type { Draw, Goal, PlanBase } from '../types';
import { carryBefore, carryOverPlan, carryPatch, undoCarryPlan, undoPatch, drawTotal, drawYears, monthKey, OTHER_ACCOUNT, parseMonth, reviewDraws, yearEndAccounts } from './drawLog';
import { balanceAt, checkAges, lumpGrid, lumpTotal, returnScenarios, runScenario, scaleLiving, scaleLumps } from './scenarios';
import { sensitivityExpenses } from '../components/Sensitivity';
import { runStress, stressCases, STRESS_CRASH, STRESS_LONG } from './stress';

const DEFAULT_TAX_ON = { on: true, rentSpouseShare: 0, rentExpense: 0, npTaxable: 100, npNet: 100, dedSelf: 150, dedSpouse: 150, hiNow: 50, hiRate: 7.19, hiLtc: 13.14, hiPublic: 50, hiPropGrowth: 0, hiPrivate: false, addToDraw: false };

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
  it('은퇴 후에는 그 해 쓸 돈을 연초에 먼저 꺼내고 남은 돈만 굴림(노후 인출의 정액 인출과 같은 경로)', () => {
    const d = deterministicPath(base).balances;
    const i = base.retireAge - base.currentAge;
    const real = 1.05 / 1.02;
    expect(d[i + 1]).toBeCloseTo((d[i] - 3000) * real, 6);
    // 은퇴 전에는 한 해 굴린 뒤 연말에 저축을 더함
    expect(d[1]).toBeCloseTo(base.startBalance * real + base.annualSavings, 6);
    const w = { startAge: 60, endAge: 100, startBalance: d[i], expenseAnnual: 3000, pensions: base.pensions, meanReturn: 5, volatility: 10, inflation: 2, percentRate: 4 };
    const f = compareStrategy('fixed', w, 10);
    f.schedule.forEach((row, k) => expect(row.endBalance).toBeCloseTo(d[i + 1 + k], 4));
  });
  it('이미 은퇴했으면 비상금·DSR 기준은 지출 탭·세후 월소득 대신 은퇴 후 소득·지출', () => {
    const sm = { income: 400, expense: 800, emergencyFund: 9000, debtPayment: 100 } as unknown as Parameters<typeof retiredBasis>[0];
    const inp: PlanInput = { ...base, currentAge: 62, retireAge: 60, retireExpenseAnnual: 6000, pensions: [{ startAge: 60, annual: 2400 }], debts: [{ endAge: 70, annual: 1200 }], goals: [{ age: 62, amount: 360, premium: '종신', flow: true }, { age: 62, amount: 500 }] };
    const b = retiredBasis(sm, inp);
    expect(b.income).toBeCloseTo(200, 6); // 연금·월세 등 지금 소득
    expect(b.expense).toBeCloseTo((6000 + 1200 + 360) / 12, 6); // 생활비 + 대출 + 보험료(목표 탭 지출은 빼고)
    // 은퇴 전이면 그대로
    expect(retiredBasis(sm, { ...inp, currentAge: 50 })).toBe(sm);
  });
  it('저축이 늘면 성공확률이 줄지 않음', () => {
    expect(simulate({ ...base, annualSavings: 3000 }).successRate).toBeGreaterThanOrEqual(simulate(base).successRate);
  });
  it('solveFor 로 찾은 저축액은 목표 확률 달성', () => {
    const v = solveFor(base, (i, x) => ({ ...i, annualSavings: x }), 0, 20000, 85)!;
    expect(v).not.toBeNull();
    expect(simulate({ ...base, annualSavings: v }, 400, 7).successRate).toBeGreaterThanOrEqual(85);
  });
  it('스트레스 테스트: 나쁜 사건을 더하면 성공확률이 오르지 않고, 폭락은 그 해 수익률만 바꿈', () => {
    const sb: PlanInput = { ...base, pensions: [{ name: '국민연금', startAge: 65, annual: 1200 }] };
    const sim0 = simulate(sb, 400);
    const cases = stressCases(sb);
    expect(cases.map((c) => c.key)).toEqual(['crash', 'flat', 'inflation', 'long', 'npCut', 'noSave', 'combo']);
    const res = Object.fromEntries(cases.map((c) => [c.key, runStress(c, 400)]));
    for (const c of cases) expect(res[c.key].successRate).toBeLessThanOrEqual(sim0.successRate);
    expect(res.combo.successRate).toBeLessThanOrEqual(res.crash.successRate);
    expect(res.long.lifeExpectancy).toBe(base.lifeExpectancy + STRESS_LONG);
    // 폭락: 은퇴 첫해 연초 잔액까지는 기본 경로와 같고, 그 해 말 잔액만 (연초에 그 해 쓸 돈을 꺼낸 뒤 남은 돈의) 수익률 차이만큼 낮음
    const crash = cases[0].input;
    const d0 = deterministicPath(base).balances;
    const d1 = deterministicPath(crash).balances;
    const i = base.retireAge - base.currentAge;
    expect(d1.slice(0, i + 1)).toEqual(d0.slice(0, i + 1));
    expect(d1[i + 1]).toBeLessThan(d0[i + 1]);
    const real = (r: number) => (1 + r / 100) / (1 + base.inflation / 100);
    expect(d0[i + 1] - d1[i + 1]).toBeCloseTo((d0[i] - outflowAt(sb, sb.retireAge)) * (real(base.retireMeanReturn ?? base.meanReturn) - real(STRESS_CRASH)), 4);
    // 이미 은퇴했으면 저축 중단은 없고, 국민연금이 없으면 삭감도 없음
    const keys = stressCases({ ...base, currentAge: base.retireAge, pensions: [] }).map((c) => c.key);
    expect(keys).toEqual(['crash', 'flat', 'inflation', 'long', 'combo']);
  });
  it('하락장 가드레일: 생활비를 줄이면 성공확률이 줄지 않고, 감축 0이면 그대로', () => {
    const now = simulate(base, 500);
    const g = simulate({ ...base, guardrail: { drop: 20, cut: 10 } }, 500);
    expect(g.successRate).toBeGreaterThanOrEqual(now.successRate);
    expect(g.cutYearsAvg).toBeGreaterThan(0);
    expect(now.cutYearsAvg).toBe(0);
    const off = simulate({ ...base, guardrail: { drop: 20, cut: 0 } }, 500);
    expect(off.successRate).toBe(now.successRate);
    expect(off.p50).toEqual(now.p50);
    // 변동성 0이면 하락장이 없어 결과가 같음
    expect(simulate({ ...base, volatility: 0, guardrail: { drop: 20, cut: 10 } }, 20).p50).toEqual(simulate({ ...base, volatility: 0 }, 20).p50);
  });
  it('가드레일 결과 재사용: 같은 입력·설정이면 같은 객체, 지금 방식과 같은 시장 경로', () => {
    const a = guardrailSim(base, { drop: 20, cut: 10 });
    expect(guardrailSim(base, { drop: 20, cut: 10 })).toBe(a);
    expect(guardrailSim(base, { drop: 15, cut: 10 })).not.toBe(a);
    expect(a.successRate).toBe(simulate({ ...base, guardrail: { drop: 20, cut: 10 } }, 1000).successRate);
    // 감축이 클수록 성공확률이 줄지 않음
    expect(guardrailSim(base, { drop: 20, cut: 20 }).successRate).toBeGreaterThanOrEqual(guardrailSim(base, { drop: 20, cut: 5 }).successRate);
  });
  it('감축 해 나이 구간 분포: 은퇴 나이부터 5세 단위, 합계는 평균 감축 연수', () => {
    const g = guardrailSim(base, { drop: 15, cut: 10 });
    const start = Math.max(base.currentAge, base.retireAge);
    expect(g.cutHistogram[0].age).toBe(start);
    g.cutHistogram.forEach((x, i) => expect(x.age).toBe(start + i * 5));
    expect(g.cutHistogram.reduce((a, x) => a + x.years, 0)).toBeCloseTo(g.cutYearsAvg, 6);
    expect(simulate(base, 100).cutHistogram).toEqual([]);
  });
  it('가드레일 처방: 목표를 넘는 조합 가운데 감축 부담이 가장 작은 설정', () => {
    const now = simulate(base).successRate;
    const target = Math.min(99, now + 3);
    const { pick, best } = weakestGuardrail(base, target);
    const rx = guardrailPrescription(base, now, target, base.retireAge, base.lifeExpectancy);
    if (pick) {
      expect(pick.sim.successRate).toBeGreaterThanOrEqual(target);
      for (const d of GUARD_DROPS) for (const c of GUARD_CUTS) {
        const s = guardrailSim(base, { drop: d, cut: c });
        if (s.successRate >= target) expect(s.cutYearsAvg * c).toBeGreaterThanOrEqual(pick.sim.cutYearsAvg * pick.cut - 1e-9);
      }
      expect(rx?.title).toContain(`−${pick.drop}%`);
    } else {
      expect(best.sim.successRate).toBeLessThan(target);
    }
    // 이미 아주 높은 목표면 가장 강한 설정으로도 못 넘어 미달 안내
    const hard = guardrailPrescription(base, now, 100.1, base.retireAge, base.lifeExpectancy);
    if (hard) expect(hard.title).toContain('미달');
  });
  it('가드레일 감축은 생활비(고정액)에만 적용, 대출 상환은 그대로', () => {
    const debts = [{ name: '대출', endAge: 90, annual: 500 }];
    const inp = { ...base, debts, currentAge: 70, retireAge: 65 };
    expect(retireOutflowAt(inp, 70, 0.1)).toBeCloseTo(expenseAt(inp, 70) * 0.9 - publicPensionAt(inp, 70) * 0 - inp.pensions.reduce((a, p) => a + incomeValue(p, 70, inp.inflation), 0) + 500, 6);
    const fixed = { ...inp, fixedDraw: 4000 };
    expect(retireOutflowAt(fixed, 70, 0.1) - retireOutflowAt(fixed, 70)).toBeCloseTo(Math.min(0, Math.max(0, 3600 - publicPensionAt(fixed, 70)) - Math.max(0, 4000 - publicPensionAt(fixed, 70))), 6);
  });
});

describe('샘플 데이터 통합', () => {
  const d = sampleData(2026);
  const s = summarize(d.profile, d.assets, d.liabilities, d.cashflows, 2026, d.insurance);
  it('요약값', () => {
    expect(s.age).toBe(45);
    expect(s.totalDebt).toBe(30000);
    expect(s.netWorth).toBe(s.totalAssets - 30000);
    expect(s.savings).toBe(650 - (95 + 80) - 185 - 190);
    expect(s.byPurpose.reduce((a, b) => a + b.value, 0)).toBe(s.financialAssets);
  });
  it('보험 납입 종료 나이: 지난 보험은 지출에서 빼고, 은퇴 전에 끝나는 보험은 그 나이부터 저축 증가', () => {
    const [a, b, ...rest] = d.insurance;
    const ins = [{ ...a, payEndAge: 40 }, { ...b, payEndAge: 50 }, ...rest]; // 지금 45세: a는 납입 완료, b는 50세에 끝남
    const s2 = summarize(d.profile, d.assets, d.liabilities, d.cashflows, 2026, ins);
    expect(s2.insurance).toBe(45 - a.monthlyPremium);
    expect(s2.insuranceCount).toBe(d.insurance.length - 1);
    expect(s2.insuranceEnds).toEqual([{ name: b.name, age: 50, monthly: b.monthlyPremium }]);
    expect(s2.savings).toBe(s.savings + a.monthlyPremium);
    const inp = buildPlanInput(d.profile, d.assets, d.liabilities, d.goals, s2);
    expect(inp.savingsChanges).toEqual([{ fromAge: 50, annual: b.monthlyPremium * 12, name: `${b.name} 납입 완료` }]);
    const noChange = { ...inp, savingsChanges: undefined };
    expect(savingsAt(inp, 49)).toBe(savingsAt(noChange, 49));
    expect(savingsAt(inp, 50)).toBe(savingsAt(noChange, 50) + b.monthlyPremium * 12);
    // 지출에 보험료 항목이 따로 있으면(보험 탭 금액을 더하지 않았으면) 저축 변화도 넣지 않음
    const dup = summarize(d.profile, d.assets, d.liabilities, [...d.cashflows, { name: '보험료', kind: 'fixed' as const, category: '보험', monthly: 45 }], 2026, ins);
    expect(buildPlanInput(d.profile, d.assets, d.liabilities, d.goals, dup).savingsChanges).toBeUndefined();
  });
  it('저축 여력이 마이너스면 은퇴 전에도 그 부족분을 금융자산에서 꺼냄(0으로 자르지 않음)', () => {
    const short = { ...s, savings: -476 };
    const inp = buildPlanInput(d.profile, d.assets, d.liabilities, d.goals, short);
    expect(inp.annualSavings).toBe(-476 * 12);
    const ok = buildPlanInput(d.profile, d.assets, d.liabilities, d.goals, s);
    const det = (i: PlanInput) => deterministicPath(i).balances;
    // 1년 뒤 자산 차이 = 저축 차이(부족분 + 원래 저축)
    expect(det(ok)[1] - det(inp)[1]).toBeCloseTo((s.savings + 476) * 12, 6);
    expect(simulate(inp, 300, 7).successRate).toBeLessThan(simulate(ok, 300, 7).successRate);
  });
  it('처방: 저축 여력이 마이너스면 ‘부족분 → 필요액’으로 보여 주고 필요액도 마이너스까지 찾음', () => {
    const a = savingsPrescription({ income: 500, savings: -476 }, 120, 80);
    expect(a.title).toBe('월 476만원 부족 → 월 120만원 저축으로 전환 필요');
    expect(a.detail).toContain('−476만원 → 120만원으로 월 596만원 개선');
    expect(a.detail).toContain('목표 저축률은 24%');
    expect(savingsPrescription({ income: 500, savings: -476 }, 700, 80).detail).not.toContain('저축률'); // 100% 넘으면 생략
    expect(a.level).toBe('danger');
    const b = savingsPrescription({ income: 500, savings: -476 }, -200, 80);
    expect(b.title).toBe('월 부족분 476만원 → 200만원 이하로 줄여야 함');
    expect(b.detail).toContain('−476만원 → −200만원');
    // 소득이 0이어도 처방이 나옴(저축률 문구만 빠짐)
    expect(savingsPrescription({ income: 0, savings: -300 }, 50, 80).detail).not.toContain('저축률');
    expect(savingsPrescription({ income: 500, savings: 100 }, 200, 80).title).toBe('저축률 20% → 40%로 상향 필요');
    // 통합: 부족분이 있는 계획에서도 저축 처방이 나오고, 지금보다 나은 값을 요구
    const short = { ...s, savings: -476 };
    const inp = buildPlanInput(d.profile, d.assets, d.liabilities, d.goals, short);
    const rate = simulate(inp, 1000, 7).successRate;
    expect(rate).toBeLessThan(d.profile.criteria.successTarget);
    const rx = prescriptions(d.profile, short, inp, rate, planGoals(d.goals, d.assets, s.age), insuranceGap(d.profile, short, d.insurance, d.goals));
    const sv = rx.find((x) => x.area === '저축' && x.detail.includes('꺼내 쓰는'));
    expect(sv?.title).toMatch(/부족/);
    // 은퇴 나이 처방이 나오면 ‘적립 기간이 늘어난다’ 대신 부족분부터 줄이라고 안내
    for (const x of rx.filter((r) => r.title.startsWith('은퇴 시점'))) expect(x.detail).toContain('지출을 줄이는 것이 먼저');
  });
  it('비상금: 저축 여력이 마이너스면 부족분으로 몇 개월 뒤 바닥나는지 보여 주고 점수를 낮춤', () => {
    const fund = 3300;
    const base = { ...s, emergencyFund: fund, expense: 300 }; // 월 지출 11개월분
    const short = { ...base, savings: -476 };
    expect(emergencyRunway(short)).toBeCloseTo(fund / 476, 6);
    expect(emergencyRunway(base.savings < 0 ? { ...base, savings: 10 } : base)).toBe(Infinity);
    expect(emergencyCap(short, 6)).toBe(0.6); // 6.9개월 > 목표 6개월 → 주의
    expect(emergencyCap({ ...short, savings: -1000 }, 6)).toBe(0.4); // 3.3개월 → 위험
    const target = d.profile.criteria.emergencyMonths;
    const chk = (x: typeof s) => riskChecks(d.profile, d.assets, x).find((r) => r.key === 'emergency')!;
    expect(chk({ ...base, savings: 10 }).level).toBe('good');
    expect(chk(short).level).not.toBe('good');
    expect(chk(short).detail).toContain(`약 ${(fund / 476).toFixed(1)}개월 뒤 바닥`);
    // 처방: 월 지출 기준으로 충분해도 부족분으로 줄고 있으면 알림
    const rx = emergencyPrescription(short, target)!;
    expect(rx.title).toBe(`비상금 11.0개월분 — 매달 부족분으로 ${(fund / 476).toFixed(1)}개월 뒤 소진`);
    expect(emergencyPrescription({ ...base, savings: 10 }, target)).toBeNull();
    // 월 지출 기준으로도 부족하면 제목에 소진 기간을 덧붙이고, 목표보다 빨리 바닥나면 위험
    const low = emergencyPrescription({ ...short, emergencyFund: 900 }, target)!;
    expect(low.title).toMatch(/개월분\(.+원\) 부족 · 부족분으로 1\.9개월 뒤 소진/);
    expect(low.level).toBe('danger');
  });
  it('목적자금 처방·바구니: 저축 여력이 마이너스면 부족분까지 합친 개선액을 보여 줌', () => {
    const g = goalPrescription(-476, 120);
    expect(g.level).toBe('danger');
    expect(g.title).toBe('목적자금 월 적립 120만원 필요 — 지금은 매달 476만원 부족');
    expect(g.detail).toContain('월 596만원(부족분 476만원 + 적립 120만원)');
    expect(goalPrescription(100, 120).detail).toContain('월 20만원 많습니다');
    expect(goalPrescription(200, 120).level).toBe('good');
    // 바구니 권장 배치는 잔액 기준이라 부족분과 무관하게 마이너스가 나오지 않음
    const short = { ...s, savings: -476 };
    const b = bucketMap(d.profile, short, planGoals(d.goals, d.assets, s.age));
    expect(b.every((x) => x.target >= 0)).toBe(true);
    expect(b.map((x) => x.target)).toEqual(bucketMap(d.profile, s, planGoals(d.goals, d.assets, s.age)).map((x) => x.target));
  });
  it('민감도 표 생활비 행: 300만원 근처부터 지금 +100까지 50만원 간격', () => {
    expect(sensitivityExpenses(750)).toEqual([300, 350, 400, 450, 500, 550, 600, 650, 700, 750, 800, 850]);
    expect(sensitivityExpenses(350)).toEqual([250, 300, 350, 400, 450]); // 지금이 낮으면 −100까지
    expect(sensitivityExpenses(725)[0]).toBe(325);
    expect(sensitivityExpenses(60)).toEqual([10, 60, 110, 160]); // 0 이하(−40) 제외
  });
  it('피보험자별 납입 종료 나이: 배우자·자녀 나이를 본인 나이로 바꿔 계산', () => {
    const [a, b, c] = d.insurance;
    const p = { ...d.profile, spouseBirthYear: d.profile.birthYear + 2 }; // 배우자가 2살 어림
    const spouse = { ...a, insured: 'spouse' as const, payEndAge: 50 }; // 배우자 50세 = 본인 52세
    const child = { ...b, insured: 'child' as const, insuredBirthYear: d.profile.birthYear + 30, payEndAge: 20 }; // 자녀 20세 = 본인 50세
    const noYear = { ...c, insured: 'child' as const, payEndAge: 48 }; // 자녀 출생연도가 없으면 본인 나이
    expect(payEndSelfAge(spouse, p)).toBe(52);
    expect(payEndSelfAge(child, p)).toBe(50);
    expect(payEndSelfAge(noYear, p)).toBe(48);
    expect(payEndSelfAge({ ...a, insured: 'spouse', payEndAge: 50 }, { ...p, spouseBirthYear: 0 })).toBe(50);
    expect(payEndSelfAge({ ...a, payEndAge: 0, insured: 'child', insuredBirthYear: 2015 }, p)).toBe(0);
    expect(isPaying(spouse, 51, p)).toBe(true);
    expect(isPaying(spouse, 52, p)).toBe(false);
    const s2 = summarize(p, d.assets, d.liabilities, d.cashflows, 2026, [spouse, child, noYear]);
    expect(s2.insuranceEnds.map((e) => e.age)).toEqual([52, 50, 48]);
  });
  it('보험 탭 보험료를 지출에 더하고, 지출에 보험료 항목이 있으면 더하지 않음', () => {
    expect(s.insurance).toBe(45);
    expect(s.insuranceDup).toEqual([]);
    const withItem = [...d.cashflows, { name: '자동차', kind: 'fixed' as const, category: '보험료', monthly: 45 }];
    const dup = summarize(d.profile, d.assets, d.liabilities, withItem, 2026, d.insurance);
    expect(dup.insuranceDup).toEqual(['자동차']);
    expect(dup.insurance).toBe(0);
    expect(dup.expense).toBe(s.expense); // 두 번 빠지지 않음
    expect(summarize(d.profile, d.assets, d.liabilities, d.cashflows, 2026).expense).toBe(s.expense - 45);
  });
  it('목표·위험·보장·처방이 계산됨', () => {
    const gp = planGoals(d.goals, d.assets, s.age);
    expect(gp).toHaveLength(5); // 일시 목표 4건 + 반복 지출(은퇴 후 여행) 1건
    expect(gp[0].futureValue).toBeCloseTo(4000 * 1.04 ** 4, 4);
    const input = buildPlanInput(d.profile, d.assets, d.liabilities, d.goals, s);
    const sim = simulate(input);
    expect(sim.successRate).toBeGreaterThanOrEqual(0);
    expect(sim.successRate).toBeLessThanOrEqual(100);
    const ins = insuranceGap(d.profile, s, d.insurance, d.goals);
    expect(ins.people[0].lines).toHaveLength(3); // 본인은 사망·진단비·간병 세 줄
    expect(ins.people.map((g) => g.person)).toEqual(['본인', '배우자']);
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
    expect(b[21]).toBeCloseTo(a[21] - 600 * (1.05 / 1.02), 6); // 은퇴 후에는 연초에 꺼내므로 그 돈의 한 해 수익만큼 더 줄어듦
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
    // 그해 지출을 종류별로 나눔: 합계는 인출액에 더해진 금액과 같음
    const mixed = { ...retired, goals: [{ age: 66, amount: 100 }, { age: 66, amount: 228, premium: '종신보험' }, { age: 66, amount: 3000, loan: '전세대출' }, { age: 66, amount: 50, npTax: true }, { age: 67, amount: 999 }] };
    const by = goalBreakdownAt(mixed, 66);
    expect(by).toEqual({ goal: 100, premium: 228, loan: 3000, npTax: 50 });
    expect(withdrawStart(mixed).outflow).toBeCloseTo(1800 + 100 + 228 + 3000 + 50, 6);
    expect(mixed.goals.map(goalKind)).toEqual(['goal', 'premium', 'loan', 'npTax', 'goal']);
    expect(st.rate).toBeCloseTo(1800 / 50000 * 100, 6);
    const need = retirementNeed(retired);
    expect(need.startAge).toBe(66);
    expect(need.projected).toBe(50000);
    // 은퇴 전 사용자는 은퇴 나이부터
    expect(withdrawStart(base).age).toBe(60);
  });

  it('목표 탭 건수는 연도별 행이 아니라 항목 수로 셈', () => {
    const g = (name: string, targetAge: number, endAge?: number, category = 'other') => ({ name, category, targetAge, amountPV: 100, growthRate: 0, endAge }) as Goal;
    const goals = [g('등록금', 59, 60), g('보유세', 58, 100), g('여행', 55), g('차량', 70), g('은퇴', 58, undefined, 'retirement')];
    expect(goalItemsFrom(goals, 58).map((x) => x.name)).toEqual(['등록금', '보유세', '차량']); // 지난 일회성·은퇴 분류 제외
    expect(goalItemsFrom(goals, 61).map((x) => x.name)).toEqual(['보유세', '차량']);
    const d = sampleData();
    const s = summarize(d.profile, d.assets, d.liabilities, d.cashflows, 2026, d.insurance);
    const rows = buildPlanInput(d.profile, d.assets, d.liabilities, goals, s).goals.filter((x) => goalKind(x) === 'goal');
    expect(rows.length).toBeGreaterThan(goalItemsFrom(goals, s.age).length); // 반복 지출은 해마다 행이 생김
  });
  it('필요 적립액 표에서 빠지는 목표와 이유: 끝난 반복 지출·지난 목표·나이 0·은퇴 분류', () => {
    const g = (name: string, targetAge: number, endAge?: number, category = 'other') => ({ name, category, targetAge, amountPV: 100, growthRate: 0, endAge }) as Goal;
    const goals = [g('등록금', 59, 60), g('옛 학원비', 40, 50), g('여행', 55), g('대출상환', 0), g('차량', 70), g('은퇴', 58, undefined, 'retirement')];
    const sk = goalPlanSkips(goals, 58);
    expect(sk.map((x) => x.goal.name)).toEqual(['옛 학원비', '여행', '대출상환', '은퇴']);
    expect(sk[0].reason).toContain('반복 기간');
    expect(sk[1].reason).toContain('지남');
    expect(sk[2].reason).toContain('비어 있음');
    // 빠지지 않은 것만 필요 적립액 표에 나옴(반복 지출도 행으로)
    expect(planGoals(goals, [], 58).map((x) => x.goal.name)).toEqual(['등록금', '차량']);
  });
  it('반복 지출 행: 시작 나이에 있어야 할 금액과 월 적립액', () => {
    const g = (name: string, targetAge: number, endAge: number | undefined, amountPV: number) => ({ name, category: 'other', targetAge, amountPV, growthRate: 0, endAge }) as Goal;
    // 중기 자산이 없으면 기대수익률 3%: 59세에 100 + 60세 몫 100/1.03
    const [tuition] = planGoals([g('등록금', 59, 60, 100)], [], 58);
    expect(tuition.recurring).toMatchObject({ fromAge: 59, toAge: 60, count: 2, firstPayment: 100 });
    expect(tuition.years).toBe(1);
    expect(tuition.futureValue).toBeCloseTo(100 + 100 / 1.03, 6);
    expect(tuition.monthlyNeeded).toBeCloseTo(pmtForTarget(tuition.futureValue, 0, Math.pow(1.03, 1 / 12) - 1, 12), 6);
    // 연도별: 59세 초 100 지출 → 남은 100/1.03 을 1년 굴리면 100, 60세 초 100 지출 → 0
    expect(tuition.recurring!.schedule.map((y) => y.age)).toEqual([59, 60]);
    expect(tuition.recurring!.schedule[0].payment).toBe(100);
    expect(tuition.recurring!.schedule[0].balance).toBeCloseTo(100, 6);
    expect(tuition.recurring!.schedule[1].balance).toBeCloseTo(0, 6);
    // 이미 시작한 반복 지출은 지금부터 남은 해만
    const [tax] = planGoals([g('보유세', 55, 100, 10)], [], 58);
    expect(tax.recurring).toMatchObject({ fromAge: 58, count: 43 });
    expect(tax.years).toBe(0);
    expect(tax.recurring!.schedule).toHaveLength(43);
    expect(tax.recurring!.schedule.at(-1)!.balance).toBeCloseTo(0, 4);
    // 중기 자산은 일시 목표에 먼저 배정(반복 지출이 더 빨라도)
    const d = sampleData();
    const mid = [{ ...d.assets.find((x) => x.type !== 'realestate')!, purpose: 'mid' as const, amount: 1000, expectedReturn: 0, lockYear: undefined }];
    const plans = planGoals([g('등록금', 59, 60, 100), g('차량', 70, undefined, 1000)], mid, 58);
    expect(plans.map((x) => [x.goal.name, x.allocated])).toEqual([['등록금', 0], ['차량', 1000]]);
    // 처방의 목적자금 적립 합계·바구니에는 반복 지출을 넣지 않음
    const s = summarize(d.profile, d.assets, d.liabilities, d.cashflows, 2026, d.insurance);
    expect(bucketMap(d.profile, s, plans)).toEqual(bucketMap(d.profile, s, plans.filter((x) => !x.recurring)));
    // 처방: 반복 지출은 ‘참고’ 항목으로 따로, 목적자금 적립 합계에는 넣지 않음
    const rec = recurringGoalPrescription(plans)!;
    expect(rec.badge).toBe('참고');
    expect(rec.title).toContain(`월 ${won(plans[0].monthlyNeeded, false)}원`);
    expect(rec.detail).toContain('이중으로 세지 않음');
    expect(recurringGoalPrescription(plans.filter((x) => !x.recurring))).toBeNull();
    const rx = prescriptions(d.profile, s, buildPlanInput(d.profile, d.assets, d.liabilities, d.goals, s), 90, plans, insuranceGap(d.profile, s, d.insurance, d.goals));
    expect(rx.filter((r) => r.badge === '참고')).toHaveLength(1);
    expect(rx.some((r) => r.title.startsWith('목적자금 월 적립'))).toBe(false); // 일시 목표(차량)는 다 준비됐고 반복 지출은 합계에 안 넣음
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
    const s = summarize(d.profile, d.assets, d.liabilities, d.cashflows, 2026, d.insurance);
    const inp = buildPlanInput(d.profile, d.assets, d.liabilities, d.goals, s);
    const travel = inp.goals.filter((g) => g.age >= 61 && g.age <= 75 && Math.abs(g.amount - 500) < 1e-6);
    expect(travel).toHaveLength(15);
    const trip = planGoals(d.goals, d.assets, 45).find((g) => g.goal.name === '은퇴 후 여행');
    expect(trip?.recurring).toMatchObject({ fromAge: 61, toAge: 75, count: 15 }); // 표에는 반복 지출 행으로 나옴
    expect(onceGoalPlans(planGoals(d.goals, d.assets, 45)).some((g) => g.goal.name === '은퇴 후 여행')).toBe(false);
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
    const s = summarize(d.profile, d.assets, d.liabilities, d.cashflows, 2026, d.insurance);
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
    const s = summarize(d.profile, d.assets, d.liabilities, d.cashflows, 2026, d.insurance);
    const inp = buildPlanInput(d.profile, d.assets, d.liabilities, d.goals, s);
    expect(inp.savingsChanges).toEqual([{ fromAge: 52, annual: -1800, name: '배우자 은퇴' }]);
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
    // 실제 수익률(추정) = 연말 ÷ (연초 − 인출) − 1: 첫해 연초는 기준선 시작 자산, 다음 해는 직전 결산
    expect(rows[0].actualReturn).toBeCloseTo(9900 / (10000 - 200) - 1, 6);
    expect(rows[0].months).toBe(2);
    expect(rows[1].actualReturn).toBeCloseTo(7000 / (9900 - 1200) - 1, 6);
    expect(rows[1].months).toBe(12);
    // 직전 해 결산이 없으면 계산하지 않음
    expect(reviewYearEnds(pb, [{ year: 2028, balance: 7000, withdrawn: 1200 }], DEFAULT_GUARDRAIL)[0].actualReturn).toBeNull();
  });
  it('기준선 다시 고정: 바뀌는 판정·권장 인출·빠지는 결산 미리보기와 한 단계 되돌리기', () => {
    const old: PlanBase = { savedAt: '2026-11-09', year: 2026, month: 11, inflation: 0, balances: [10000, 9000, 8000, 7000], withdrawals: [1200, 1200, 1200] };
    const next: PlanBase = { savedAt: '2027-12-20', year: 2027, month: 1, inflation: 0, balances: [7000, 6000, 5000], withdrawals: [1000, 1000] };
    const recs = [{ year: 2026, balance: 9900, withdrawn: 200 }, { year: 2027, balance: 7000, withdrawn: 1200 }];
    const d = rebaseDiff(old, next, recs, DEFAULT_GUARDRAIL);
    // 이전 기준선: 2027 말 하단선 아래(배율 0.9) → 새 기준선: 2027 말 기준선 6000의 +16.7% → 상단선 위, 감액만이라 배율 1
    expect(d.before!.position).toBe('below');
    expect(d.before!.multiplier).toBeCloseTo(0.9, 6);
    expect(d.after!.position).toBe('above');
    expect(d.after!.multiplier).toBe(1);
    expect(d.after!.nextRecommended).toBeCloseTo(1000, 6);
    expect(d.dropped).toEqual([2026]); // 새 기준선 시작(2027)보다 앞선 결산은 판정에서 빠짐
    // 기준선이 없던 상태에서 처음 고정하면 비교할 이전 판정이 없음
    expect(rebaseDiff(undefined, old, recs, DEFAULT_GUARDRAIL)).toMatchObject({ before: null, dropped: [] });

    // 다시 고정하면 직전 기준선을 한 단계 보관, 되돌리면 보관 칸을 비움
    const p0: { name: string; planBase?: PlanBase; planBasePrev?: PlanBase } = { name: 'x', planBase: old };
    const p1 = refixBase(p0, next);
    expect(p1.planBase).toBe(next);
    expect(p1.planBasePrev).toBe(old);
    expect(p1.name).toBe('x');
    const p2 = restoreBase(p1);
    expect(p2.planBase).toBe(old);
    expect('planBasePrev' in p2).toBe(false);
    expect(restoreBase(p2)).toBe(p2); // 보관한 게 없으면 그대로
    // 처음 고정할 때는 보관할 기준선이 없음
    expect('planBasePrev' in refixBase({ name: 'y' } as { name: string; planBase?: PlanBase; planBasePrev?: PlanBase }, old)).toBe(false);
  });
  it('첫해를 남은 달만큼만 계산한 기준선: [1]이 고정한 해 12월 말', () => {
    // 11월에 고정(2개월 남음): balances[1] = 2026년 말, [2] = 2027년 말
    const pb: PlanBase = { savedAt: '2026-11-09', year: 2026, month: 11, inflation: 0, balances: [10000, 9800, 8600, 7400], withdrawals: [200, 1200, 1200], share: 2 / 12 };
    expect(baseBalanceAt(pb, yearsToYearEnd(pb, 2026))).toBeCloseTo(9800, 6);
    expect(baseBalanceAt(pb, yearsToYearEnd(pb, 2027))).toBeCloseTo(8600, 6);
    expect(baseBalanceAt(pb, 1 / 12)).toBeCloseTo(9900, 6); // 첫 구간 안에서는 직선 보간
    expect(basePlanWithdrawal(pb, 0, 2 / 12)).toBeCloseTo(200, 6);
    expect(basePlanWithdrawal(pb, 2 / 12, 14 / 12)).toBeCloseTo(1200, 6);
    const rows = reviewYearEnds(pb, [{ year: 2026, balance: 9800, withdrawn: 200 }], DEFAULT_GUARDRAIL);
    expect(rows[0].planWithdrawal).toBeCloseTo(200, 6);
    expect(rows[0].nextPlan).toBeCloseTo(1200, 6);
    expect(rows[0].position).toBe('inside');
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
    const s = summarize(d.profile, d.assets, d.liabilities, d.cashflows, 2026, d.insurance);
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
  const plan = (d: ReturnType<typeof sampleData>) => buildPlanInput(d.profile, d.assets, d.liabilities, d.goals, summarize(d.profile, d.assets, d.liabilities, d.cashflows, 2026, d.insurance));

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
    // 한 계좌 안에서는 법정 순서: 과세제외 1,000 → 퇴직금 재원(7%) → (퇴직금을 다 쓴 뒤) 과세재원
    const r = pensionTaxSchedule([row(58, 3000)], setup).rows[0];
    expect(r.slot.self).toBe(0);
    expect(r.tax).toBeCloseTo((2000 / 0.93) * 0.07, 6);
    expect(r.gross - r.tax).toBeCloseTo(3000, 6);
    expect(r.accounts[0].tax).toBeCloseTo(r.tax, 6);
    expect(r.accounts[0].freeLeft).toBeCloseTo(0, 6);
    expect(r.accounts[0].retireLeft).toBeCloseTo(3000 - 2000 / 0.93, 6);
    // 2년차에 퇴직금 재원을 다 쓰면 그 해부터 과세재원 1,500만(5.5%), 넘는 금액은 16.5%
    const res = pensionTaxSchedule([row(58, 3000), row(59, 3000), row(60, 3000)], setup);
    expect(res.rows[1].slot.self).toBeCloseTo(1500, 6);
    expect(res.overYears).toEqual([2027, 2028]);
    expect(res.rows.some((x) => x.over.self > 0)).toBe(true);
  });

  it('운용수익은 과세재원으로 쌓이고 과세제외·퇴직금 재원은 명목 금액 그대로', () => {
    const d = retiree();
    d.profile = { ...d.profile, spouseBirthYear: 0, inflation: 2, retireTaxRate: 10, retireTaxYear1: 2026 };
    d.assets = [{ name: 'IRP', type: 'pension', amount: 10000, expectedReturn: 5, volatility: 0, purpose: 'long', nature: 'safe', taxFree: 1000, retirePart: 3000, pensionYear1: 2010 }];
    const row = (age: number) => ({ age, pension: 0, withdrawal: 0, income: 0, need: 0, endBalance: 0, inflow: 0 });
    const res = pensionTaxSchedule([row(58), row(59), row(60)], taxSetup(d.profile, d.assets, 2026, 10000, 5)!);
    // 꺼내지 않으면 2년 뒤(2028)에도 과세제외 1,000 · 퇴직금 3,000(명목) 그대로, 불어난 돈은 과세재원
    expect(res.rows[2].accounts[0].freeLeft).toBeCloseTo(1000, 6);
    expect(res.rows[2].accounts[0].retireLeft).toBeCloseTo(3000, 6);
    expect(res.rows[2].accounts[0].start).toBeCloseTo(10000 * 1.05 ** 2, 4);
    // 인출 시작이 나중이면(10년 뒤) 그때까지 명목 그대로라 실질로는 물가만큼 줄어 있음
    const later = taxSetup(d.profile, d.assets, 2026, 15000, 5, 2036)!;
    expect(later.accounts[0].free).toBeCloseTo(1000 / 1.02 ** 10, 6);
    expect(later.accounts[0].retire).toBeCloseTo(3000 / 1.02 ** 10, 6);
    expect(later.accounts[0].taxed).toBeCloseTo(15000 - 4000 / 1.02 ** 10, 6);
  });

  it('퇴직금 재원 한도초과(감면 없음)가 과세재원 16.5%보다 싸면 먼저 꺼냄', () => {
    const d = retiree();
    d.profile = { ...d.profile, spouseBirthYear: 0, inflation: 0, retireTaxRate: 10, retireTaxYear1: 2026 };
    const base = { type: 'pension' as const, expectedReturn: 0, volatility: 0, purpose: 'long' as const, nature: 'safe' as const };
    d.assets = [
      { ...base, name: '연금저축', amount: 5000, pensionYear1: 2010 },
      { ...base, name: '퇴직 IRP', amount: 10000, retirePart: 10000, pensionYear1: 2026 }, // 1년차 한도 1,200
    ];
    const row = (withdrawal: number) => ({ age: 58, pension: 0, withdrawal, income: withdrawal, need: withdrawal, endBalance: 0, inflow: 0 });
    const r = pensionTaxSchedule([row(4000)], taxSetup(d.profile, d.assets, 2026, 15000, 0)!);
    // 연금저축 1,500(5.5%) → 퇴직 IRP 한도 안 1,200(7%) → 한도초과분은 퇴직소득세 10% 전액(16.5%보다 쌈)
    const rest = (4000 - 1500 * 0.945 - 1200 * 0.93) / 0.9;
    expect(r.rows[0].slot.self).toBeCloseTo(1500, 6);
    expect(r.rows[0].over.self).toBe(0);
    expect(r.rows[0].accounts[1].over).toBeCloseTo(rest, 6);
    expect(r.rows[0].tax).toBeCloseTo(1500 * 0.055 + 1200 * 0.07 + rest * 0.1, 6);
    // 퇴직소득세율이 16.5%보다 높으면 과세재원 16.5%가 먼저
    const hi = pensionTaxSchedule([row(4000)], taxSetup({ ...d.profile, retireTaxRate: 20 }, d.assets, 2026, 15000, 0)!);
    expect(hi.rows[0].over.self).toBeGreaterThan(0);
    expect(hi.rows[0].accounts[1].over).toBe(0);
  });

  it('퇴직금 실수령연차는 실제로 꺼낸 해만 세고, 매년 최소 인출을 넣으면 끊기지 않음', () => {
    expect(retireRateAt(10, 10)).toBeCloseTo(7, 6);
    expect(retireRateAt(10, 11)).toBeCloseTo(6, 6);
    const d = retiree();
    d.profile = { ...d.profile, spouseBirthYear: 0, inflation: 0, retireTaxRate: 10, retireTaxYear1: 2024 };
    const base = { type: 'pension' as const, expectedReturn: 0, volatility: 0, purpose: 'long' as const, nature: 'safe' as const, pensionYear1: 2010 };
    d.assets = [{ ...base, name: '퇴직 IRP', amount: 10000, retirePart: 10000 }, { name: '예금', type: 'deposit', amount: 5000, expectedReturn: 0, volatility: 0, purpose: 'long', nature: 'safe' }];
    const row = (age: number, withdrawal: number) => ({ age, pension: 0, withdrawal, income: withdrawal, need: withdrawal, endBalance: 0, inflow: 0 });
    const sched = [row(58, 0), row(59, 0), row(60, 930)];
    // 2024·2025년에 받았으니 2026년은 3년차. 안 꺼낸 해는 연차가 늘지 않음
    const off = pensionTaxSchedule(sched, taxSetup(d.profile, d.assets, 2026, 15000, 0)!);
    expect(off.rows.map((x) => x.retireNo)).toEqual([3, 3, 3]);
    expect(off.rows[0].gross).toBe(0);
    // 매년 최소 12만: 쓸 일이 없어도 꺼내 연차를 이어가고, 세후 금액은 ISA·일반계좌로 옮김
    const on = pensionTaxSchedule(sched, taxSetup({ ...d.profile, retireMinDraw: 12 }, d.assets, 2026, 15000, 0)!);
    expect(on.rows.map((x) => x.retireNo)).toEqual([3, 4, 5]);
    expect(on.rows[0].accounts[0].drawn).toBeCloseTo(12, 6);
    expect(on.rows[0].reinvest).toBeCloseTo(12 * 0.93, 6);
    expect(on.rows[0].isa).toBeCloseTo(5000 + 12 * 0.93, 6);
    // 필요해서 꺼낸 해는 그 금액이 최소 인출을 넘으므로 더 꺼내지 않음
    expect(on.rows[2].accounts[0].drawn).toBeCloseTo(1000, 6);
    expect(on.rows[2].reinvest).toBe(0);
  });

  it('인출 시작 전 계좌에 과세재원이 묶여 못 쓴 1,500만 한도', () => {
    const d = retiree();
    d.profile = { ...d.profile, spouseBirthYear: 0, inflation: 0 };
    const base = { type: 'pension' as const, expectedReturn: 0, volatility: 0, purpose: 'long' as const, nature: 'safe' as const, pensionYear1: 2010 };
    d.assets = [{ ...base, name: '교보', amount: 1000 }, { ...base, name: '키움', amount: 3000, drawStartYear: 2030 }];
    const row = (withdrawal: number) => ({ age: 58, pension: 0, withdrawal, income: withdrawal, need: withdrawal, endBalance: 0, inflow: 0 });
    const r = pensionTaxSchedule([row(945)], taxSetup(d.profile, d.assets, 2026, 4000, 0)!).rows[0];
    expect(r.slot.self).toBeCloseTo(1000, 6);
    expect(r.idle.self).toBeCloseTo(500, 6); // 남은 한도 500 < 키움 과세재원 3,000
    expect(r.idle.spouse).toBe(0);
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
    // 국민연금 몫 지출은 npTax 로 표시되어 목표 탭 지출과 따로 나뉨
    const by = goalBreakdownAt(plan(d), 65);
    expect(by.npTax).toBeCloseTo(y33.npPart, 6);
    expect(goalBreakdownAt(plan(off), 65).npTax).toBe(0);
    expect(by.goal).toBeCloseTo(goalBreakdownAt(plan(off), 65).goal, 6);
  });

  it('그 밖의 은퇴 후 소득: 종류별로 종소세·건보료 반영', () => {
    // 근로소득공제: 총급여 3,000만 → 공제 975만 → 근로소득금액 2,025만, 공제 한도 2,000만
    expect(wageIncomeAmount(3000)).toBeCloseTo(2025, 6);
    expect(wageIncomeAmount(400)).toBeCloseTo(120, 6);
    expect(wageIncomeAmount(50000)).toBeCloseTo(48000, 6);
    // 예전 데이터: kind 없으면 rent 체크로 판단
    expect(incomeKindOf({ name: '', monthly: 0, startAge: 0, endAge: 0, growth: 0, step: 1, rent: true })).toBe('rent');
    expect(incomeKindOf({ name: '', monthly: 0, startAge: 0, endAge: 0, growth: 0, step: 1 })).toBe('other');
    const d = retiree();
    const base = { ...DEFAULT_TAX_ON };
    const at = (incomes: typeof d.profile.incomes, extra = {}) =>
      incomeTaxSchedule({ ...d.profile, spouseBirthYear: 1973, inflation: 0, nationalPension: 0, spousePension: 0, incomes, incomeTax: { ...base, ...extra } }, 2026);
    const one = (kind: 'wage' | 'business' | 'publicPension' | 'privatePension' | 'other', owner: 'self' | 'spouse' = 'self', expense?: number) =>
      [{ name: 'x', monthly: 250, startAge: 50, endAge: 0, growth: 0, step: 1, owner, kind, expense }];
    // 근로 3,000만(본인)만: 근로소득세액공제·표준세액공제 뒤 75.075만을 연말정산으로 냈으니 5월 추가납부 0
    const w = at(one('wage'));
    expect(w[0].other).toBeCloseTo(3000, 6);
    expect(w[0].taxSelf).toBeCloseTo(75.075, 6);
    expect(w[0].wageWithheld).toBeCloseTo(75.075, 6);
    expect(w[0].due).toBeCloseTo(0, 6);
    expect(w[0].taxSpouse).toBe(0);
    expect(w[1].hiMonth - w[0].hiMonth).toBeCloseTo(0, 6); // 첫해 고지서 역산, 둘째 해부터 같은 소득이면 그대로
    // 배우자 사업소득: 필요경비 40% 뺀 1,800만이 배우자 종합소득, 건보료 100%
    const b = at(one('business', 'spouse', 40));
    expect(b[0].taxSpouse).toBeCloseTo(incomeTaxAmount(1800 - 150), 6);
    expect(b[0].taxSelf).toBe(0);
    // 공적연금 3,000만: 연금소득공제 뒤 과세
    expect(at(one('publicPension'))[0].taxSelf).toBeCloseTo(incomeTaxAmount(pensionIncomeAmount(3000) - 150), 6);
    // 사적연금·그 밖: 종소세 없음, 사적연금은 hiPrivate 켜면 다음 해 건보료에 50% 반영
    expect(at(one('privatePension'))[0].taxSelf).toBe(0);
    expect(at(one('other'))[0].other).toBe(0);
    const priv = at(one('privatePension'), { hiNow: 0, hiPrivate: true });
    expect(priv[1].hiMonth).toBeCloseTo(((3000 * 0.5) / 12) * 0.0719 * 1.1314, 6);
    expect(at(one('privatePension'), { hiNow: 0 })[1].hiMonth).toBe(0);
    // 근로소득 건보료(고지서 0에서 시작): 다음 해 총급여 × 50%
    expect(at(one('wage'), { hiNow: 0 })[1].hiMonth).toBeCloseTo(((3000 * 0.5) / 12) * 0.0719 * 1.1314, 6);
  });

  it('근로소득세액공제·표준세액공제·원천징수(기납부)', () => {
    // 세액공제: 산출세액 130만 이하 55%, 넘는 부분 30%
    expect(wageTaxCredit(100, 3000)).toBeCloseTo(55, 6);
    expect(wageTaxCredit(155.25, 3000)).toBeCloseTo(74, 6); // 79.075 → 한도 74(총급여 3,300만 이하)
    expect(wageTaxCredit(1000, 5000)).toBeCloseTo(66, 6); // 74 − 1,700 × 0.8% = 60.4 → 최소 66
    expect(wageTaxCredit(1000, 4000)).toBeCloseTo(74 - 700 * 0.008, 6);
    expect(wageTaxCredit(1000, 8000)).toBeCloseTo(50, 6);
    expect(wageTaxCredit(1000, 14000)).toBeCloseTo(20, 6);
    expect(wageTaxCredit(0, 3000)).toBe(0);
    // 근로소득만 3,000만: 과표 1,875 → 산출 155.25 − 공제 74 − 표준 13 = 68.25 × 1.1
    expect(wageWithholding(3000, 150)).toBeCloseTo(75.075, 6);
    expect(wageWithholding(0, 150)).toBe(0);
    // 근로소득이 없으면 예전 계산과 같음, 세액공제는 세금보다 크지 않음
    expect(personIncomeTax(2000, 150)).toBeCloseTo(incomeTaxAmount(1850), 6);
    expect(wageWithholding(600, 150)).toBe(0);
    // 근로 3,000만 + 사업 1,800만(본인): 산출 425.25, 근로소득분 비율 2,025/3,825로 공제 한도 74 → 결정 372.075, 5월에는 297만(= 사업소득 1,800 × 15% × 1.1)
    const d = retiree();
    const rows = incomeTaxSchedule({
      ...d.profile, spouseBirthYear: 1973, inflation: 0, nationalPension: 0, spousePension: 0,
      incomes: [
        { name: '근로', monthly: 250, startAge: 50, endAge: 0, growth: 0, step: 1, kind: 'wage' },
        { name: '사업', monthly: 150, startAge: 50, endAge: 0, growth: 0, step: 1, kind: 'business' },
      ],
      incomeTax: { ...DEFAULT_TAX_ON },
    }, 2026);
    expect(rows[0].taxSelf).toBeCloseTo(372.075, 6);
    expect(rows[0].withheld).toBeCloseTo(75.075, 6);
    expect(rows[0].due).toBeCloseTo(297, 6);
    expect(rows[0].npPart).toBe(0);
    // 배우자 근로소득이면 배우자 공제·원천징수로 계산
    const sp = incomeTaxSchedule({
      ...d.profile, spouseBirthYear: 1973, inflation: 0, nationalPension: 0, spousePension: 0,
      incomes: [{ name: '근로', monthly: 250, startAge: 50, endAge: 0, growth: 0, step: 1, owner: 'spouse', kind: 'wage' }],
      incomeTax: { ...DEFAULT_TAX_ON, dedSpouse: 300 },
    }, 2026);
    expect(sp[0].taxSpouse).toBeCloseTo(wageWithholding(3000, 300), 6);
    expect(sp[0].due).toBeCloseTo(0, 6);
  });

  it('임대용 부동산 월세: 은퇴 전에도 종소세에 한 번만, 근로소득 세액공제·기납부와 겹치지 않음', () => {
    // 1968년생 · 62세 은퇴 · 은퇴 후 재취업 근로 월 250(연 3,000만) · 자산 탭 상가 월세 200(경비 10%, 인상 0)
    const d = retiree();
    const shop = (owner: 'self' | 'spouse') => ({
      name: '상가', type: 'realestate' as const, amount: 50000, expectedReturn: 3, volatility: 8, purpose: 'long' as const, nature: 'invest' as const,
      reUse: 'rental' as const, rent: 200, deposit: 0, renewCycle: 2, renewRate: 0, rentCost: 10, owner,
    });
    const profile = {
      ...d.profile, retireAge: 62, spouseBirthYear: 1973, inflation: 0, nationalPension: 0, spousePension: 0,
      incomes: [{ name: '재취업', monthly: 250, startAge: 62, endAge: 0, growth: 0, step: 1, kind: 'wage' as const }],
      incomeTax: { ...DEFAULT_TAX_ON },
    };
    const rows = incomeTaxSchedule(profile, 2026, undefined, [shop('self')]);
    const y = (n: number) => rows.find((r) => r.year === n)!;
    // 은퇴 전(2026, 58세): 세금은 경비 차감 전 월세 2,400만으로 지금부터 계산, 근로소득은 아직 없어 세액공제·기납부 0
    expect(y(2026).rent).toBeCloseTo(2400, 6);
    expect(y(2026).other).toBe(0);
    expect(y(2026).wageWithheld).toBe(0);
    expect(y(2026).taxSelf).toBeCloseTo(incomeTaxAmount(2400 - 150), 6); // 232.65
    expect(y(2026).due).toBeCloseTo(y(2026).taxSelf, 6);
    // 현금흐름(노후 소득)에는 은퇴한 해부터만 들어감 → 은퇴 전 월세는 세후 월소득 몫이라 두 번 세지 않음
    const [cash] = rentStreams([shop('self')], profile, 58);
    const [gross] = rentStreams([shop('self')], profile, 58, true);
    expect(cash.startAge).toBe(62);
    expect(cash.annual).toBeCloseTo(2160, 6); // 경비 10% 뺀 순수입
    expect(gross.startAge).toBe(58);
    // 은퇴 후(2030, 62세): 근로 3,000 + 월세 2,400. 근로소득세액공제는 근로소득분 비율만큼(한도 74)만, 원천징수는 근로만 본 75.075
    // → 결정 471.075 − 기납부 75.075 = 396 = 월세 2,400 × 15% × 1.1 (월세 세금이 빠지거나 공제로 깎이지 않음)
    expect(y(2030).rent).toBeCloseTo(2400, 6);
    expect(y(2030).taxSelf).toBeCloseTo(personIncomeTax(wageIncomeAmount(3000) + 2400, 150, 3000), 6);
    expect(y(2030).taxSelf).toBeCloseTo(471.075, 6);
    expect(y(2030).wageWithheld).toBeCloseTo(wageWithholding(3000, 150), 6);
    expect(y(2030).due).toBeCloseTo(396, 6);
    // 배우자 명의 상가: 월세는 배우자 종소세, 본인 근로 세금은 연말정산으로 끝(5월 추가 0) → 사람 간에도 섞이지 않음
    const sp = incomeTaxSchedule(profile, 2026, undefined, [shop('spouse')]);
    const s30 = sp.find((r) => r.year === 2030)!;
    expect(s30.taxSelf).toBeCloseTo(wageWithholding(3000, 150), 6);
    expect(s30.taxSpouse).toBeCloseTo(incomeTaxAmount(2400 - 150), 6);
    expect(s30.due).toBeCloseTo(s30.taxSpouse, 6);
  });

  it('은퇴 전 세전 총급여: 은퇴 전 해까지 월세와 합쳐 세율 구간·근로소득세액공제·기납부 반영, 건보료 제외', () => {
    // 본인 58세 · 62세 은퇴 · 은퇴 전 총급여 3,000만 · 상가 월세 200 · 배우자(53세) 56세 은퇴 · 총급여 3,000만
    const d = retiree();
    const shop = { name: '상가', type: 'realestate' as const, amount: 50000, expectedReturn: 3, volatility: 8, purpose: 'long' as const, nature: 'invest' as const, reUse: 'rental' as const, rent: 200, deposit: 0, renewCycle: 2, renewRate: 0, rentCost: 0 };
    const base = { ...d.profile, retireAge: 62, spouseBirthYear: 1973, spouseRetireAge: 56, inflation: 0, nationalPension: 0, spousePension: 0, incomes: [], incomeTax: { ...DEFAULT_TAX_ON } };
    const rows = incomeTaxSchedule({ ...base, wageGross: 3000, spouseWageGross: 3000 }, 2026, undefined, [shop]);
    const none = incomeTaxSchedule(base, 2026, undefined, [shop]);
    const y = (r: typeof rows, n: number) => r.find((x) => x.year === n)!;
    // 2026: 급여 3,000 + 월세 2,400 → 결정 471.075, 연말정산 75.075 → 5월 396(월세 몫 15%). 급여를 안 넣으면 월세만 6% 구간 232.65
    expect(y(rows, 2026).salary).toBeCloseTo(6000, 6);
    expect(y(rows, 2026).taxSelf).toBeCloseTo(471.075, 6);
    expect(y(rows, 2026).wageWithheld).toBeCloseTo(2 * wageWithholding(3000, 150), 6);
    expect(y(rows, 2026).due).toBeCloseTo(396, 6);
    expect(y(none, 2026).due).toBeCloseTo(232.65, 6);
    // 배우자는 급여만이라 연말정산으로 끝(5월 추가 0)
    expect(y(rows, 2026).taxSpouse).toBeCloseTo(wageWithholding(3000, 150), 6);
    // 급여가 있는 해는 직장가입자: 재산분 없이 급여 외 소득(월세 2,400만) 중 2,000만 초과분에만 소득월액 보험료
    const extra = (400 / 12) * 0.0719 * 1.1314;
    expect(rows.filter((r) => r.year <= 2029).map((r) => r.hiMode)).toEqual(['work', 'work', 'work', 'workDep']); // 2029: 배우자 은퇴 → 소득·사업 없어 피부양자
    for (const n of [2026, 2028, 2029]) {
      expect(y(rows, n).hiMonth).toBeCloseTo(extra, 6);
      expect(y(rows, n).hiWork).toBeCloseTo(extra, 6);
      expect(y(rows, n).hiProp).toBe(0);
      expect(y(rows, n).hiMonth).toBeLessThan(y(none, n).hiMonth);
    }
    // 둘 다 은퇴한 해부터는 급여를 안 넣었을 때와 같은 지역 건보료
    expect(rows.filter((r) => r.year >= 2030).map((r) => [r.hiMode, r.hiMonth])).toEqual(none.filter((r) => r.year >= 2030).map((r) => ['region', r.hiMonth]));
    // 배우자 56세(2029)부터, 본인 62세(2030)부터 급여 0 → 은퇴 후엔 급여 없을 때와 같은 세금
    expect(y(rows, 2028).salary).toBeCloseTo(6000, 6);
    expect(y(rows, 2029).salary).toBeCloseTo(3000, 6);
    expect(y(rows, 2030).salary).toBe(0);
    expect(y(rows, 2030).due).toBeCloseTo(y(none, 2030).due, 6);
    // 물가만큼 명목 증가
    const inf = incomeTaxSchedule({ ...base, inflation: 2.5, wageGross: 3000 }, 2026, undefined, [shop]);
    expect(y(inf, 2028).salary).toBeCloseTo(3000 * 1.025 ** 2, 6);
  });

  it('부부 중 한 명만 일할 때: 다른 한 명은 피부양자 요건을 채우면 0, 못 채우면 혼자 지역가입자', () => {
    // 피부양자 요건: 사업소득 없음 · 합산소득 2,000만 이하 · 재산 과표 5.4억 이하(9억 이하 + 소득 1,000만 이하도 인정)
    expect(hiDependent(0, 2000, null)).toBe(true);
    expect(hiDependent(1, 1, null)).toBe(false);
    expect(hiDependent(0, 2001, null)).toBe(false);
    expect(hiDependent(0, 1500, 54000)).toBe(true);
    expect(hiDependent(0, 1500, 60000)).toBe(false);
    expect(hiDependent(0, 1000, 60000)).toBe(true);
    expect(hiDependent(0, 0, 90001)).toBe(false);
    // 본인(58세)은 62세까지 급여, 배우자는 이미 은퇴(은퇴 나이 0) · 상가 월세 200(연 2,400만, 경비 0)
    const d = retiree();
    const shop = (owner: 'self' | 'spouse', amount = 50000) => ({ name: '상가', type: 'realestate' as const, amount, expectedReturn: 0, volatility: 8, purpose: 'long' as const, nature: 'invest' as const, reUse: 'rental' as const, rent: 200, deposit: 0, renewCycle: 2, renewRate: 0, rentCost: 0, owner });
    const p = { ...d.profile, retireAge: 62, spouseBirthYear: 1973, spouseRetireAge: 0, inflation: 0, nationalPension: 0, spousePension: 0, incomes: [], wageGross: 5000, incomeTax: { ...DEFAULT_TAX_ON, hiNow: 0, hiPropAuto: true } };
    const k = 0.0719 * 1.1314;
    // 상가가 본인(직장가입자) 명의: 배우자는 소득·재산이 없어 피부양자 → 본인 소득월액 보험료만
    const mine = incomeTaxSchedule(p, 2026, undefined, [shop('self')])[0];
    expect(mine.hiMode).toBe('workDep');
    expect(mine.hiMonth).toBeCloseTo((400 / 12) * k, 6);
    expect(mine.hiProp).toBe(0);
    // 상가가 배우자 명의: 임대 사업소득이 있어 피부양자 탈락 → 배우자만 지역가입자(임대소득 전액 + 배우자 명의 재산분), 본인은 급여 외 소득이 없어 0
    const hers = incomeTaxSchedule(p, 2026, undefined, [shop('spouse')])[0];
    expect(hers.hiMode).toBe('workRegion');
    expect(hers.hiWork).toBe(0);
    expect(hers.propBase).toBeCloseTo(50000 * 0.69 * 0.6, 6);
    expect(hers.hiMonth).toBeCloseTo(((2400 / 12) * 0.0719 + hiPropMonthly(50000 * 0.69 * 0.6)) * 1.1314, 6);
    // 공동명의 50%: 본인 몫 1,200만은 2,000만 이하라 0, 배우자는 자기 몫 1,200만 + 자기 지분 재산만
    const joint = incomeTaxSchedule(p, 2026, undefined, [{ ...shop('self'), owner: 'joint' as const, ownerShare: 50 }])[0];
    expect(joint.hiWork).toBe(0);
    expect(joint.hiMonth).toBeCloseTo(((1200 / 12) * 0.0719 + hiPropMonthly(25000 * 0.69 * 0.6)) * 1.1314, 6);
    // 은퇴한 해(2030)부터는 세대 합산 지역가입자
    const later = incomeTaxSchedule(p, 2026, undefined, [shop('spouse')]).find((r) => r.year === 2030)!;
    expect(later.hiMode).toBe('region');
    expect(later.hiMonth).toBeCloseTo(hers.hiMonth, 6);
    // 고지서 역산 방식: 지금 고지서(배우자 지역 보험료) − 배우자 소득분 = 재산분
    const bill = incomeTaxSchedule({ ...p, incomeTax: { ...DEFAULT_TAX_ON, hiNow: 30 } }, 2026, undefined, [shop('spouse')]);
    expect(bill[0].hiMonth).toBeCloseTo(30, 6);
    expect(bill[0].hiProp).toBeCloseTo(30 - (2400 / 12) * k, 6);
    // 공동명의 배우자 40%: 고지서 재산분은 배우자 몫 → 세대 재산분 = 고지서 재산분 ÷ 0.4, 은퇴 후(세대 지역)에는 전체
    const jointShop = { ...shop('self'), owner: 'joint' as const, ownerShare: 60 };
    expect(hiPropShare([jointShop], 2026, 2026, 1)).toBeCloseTo(0.4, 9);
    expect(hiPropShare([], 2026, 2026, 1)).toBeNull();
    const billJoint = incomeTaxSchedule({ ...p, incomeTax: { ...DEFAULT_TAX_ON, hiNow: 30 } }, 2026, undefined, [jointShop]);
    const herQ = ((2400 * 0.4) / 12) * 0.0719;
    expect(billJoint[0].hiMode).toBe('workRegion');
    expect(billJoint[0].hiMonth).toBeCloseTo(30, 6);
    expect(billJoint[0].hiProp).toBeCloseTo(30 - herQ * 1.1314, 6);
    const after = billJoint.find((r) => r.year === 2030)!;
    expect(after.hiMode).toBe('region');
    expect(after.hiProp).toBeCloseTo((30 - herQ * 1.1314) / 0.4, 6);
    // 사업자등록 없음: 임대 외 사업소득 500만 이하면 피부양자, 임대소득은 있으면 탈락
    expect(hiDependent(500, 500, null, { rent: 0 })).toBe(true);
    expect(hiDependent(501, 501, null, { rent: 0 })).toBe(false);
    expect(hiDependent(300, 300, null, { rent: 100 })).toBe(false);
    expect(hiDependent(300, 2100, null, { rent: 0 })).toBe(false);
    const side = { name: '부업', monthly: 50, startAge: 50, endAge: 0, growth: 0, step: 0, kind: 'business' as const, owner: 'spouse' as const, expense: 40 };
    const strict = incomeTaxSchedule({ ...p, incomes: [side] }, 2026, undefined, [])[0];
    expect(strict.hiMode).toBe('workRegion');
    const loose = incomeTaxSchedule({ ...p, incomes: [side], incomeTax: { ...p.incomeTax, hiDepNoReg: true } }, 2026, undefined, [])[0];
    expect(loose.hiMode).toBe('workDep'); // 사업소득금액 600 × 60% = 360만
    expect(loose.hiMonth).toBe(0);
    // 국민연금 몫: 직장가입자는 2,000만 문턱 때문에 국민연금이 문턱을 넘긴 만큼만 건보료가 늘어남
    const np = incomeTaxSchedule({ ...p, nationalPension: 200, nationalPensionAge: 58 }, 2026, undefined, [shop('self')])[1];
    expect(np.hiMonth).toBeCloseTo(((2400 + 1200 - 2000) / 12) * k, 6);
    expect(np.npPart - (np.due - (incomeTaxSchedule(p, 2026, undefined, [shop('self')])[1].due))).toBeCloseTo(1200 * k, 6);
    // 사적연금도 건보료에 반영: 급여가 있는 해에도 사람별로 들어감
    const priv = { ...p, incomeTax: { ...p.incomeTax, hiPrivate: true } };
    // 본인(직장가입자) 연금계좌 과세재원 인출 1,600만: 급여 외 소득 = 임대 2,400 + 1,600 × 50% = 3,200 → 1,200만 초과분
    const slotSelf = new Map<number, [number, number]>([[2026, [1600, 0]]]);
    const ws = incomeTaxSchedule(priv, 2026, slotSelf, [shop('self')])[1];
    expect(ws.hiMode).toBe('workDep');
    expect(ws.hiMonth).toBeCloseTo(((2400 + 800 - 2000) / 12) * k, 6);
    // 끄면 사적연금은 빠짐
    expect(incomeTaxSchedule(p, 2026, slotSelf, [shop('self')])[1].hiMonth).toBeCloseTo((400 / 12) * k, 6);
    // 배우자 사적연금 2,400만(전액 합산 2,000만 초과) → 피부양자 탈락, 배우자만 지역가입자(2,400 × 50%), 본인 급여 외 소득에는 안 들어감
    const slotSp = new Map<number, [number, number]>([[2026, [0, 2400]]]);
    const wr = incomeTaxSchedule(priv, 2026, slotSp, [shop('self')])[1];
    expect(wr.hiMode).toBe('workRegion');
    expect(wr.hiWork).toBeCloseTo((400 / 12) * k, 6);
    expect(wr.hiMonth).toBeCloseTo(((400 + 1200) / 12) * k, 6);
    // 피부양자에서 빠진 이유가 행에 남음
    expect(wr.hiDepWhy).toBe('배우자: 합산소득 2,400만원(사적연금 2,400만원 포함)이 2,000만원 초과');
    expect(ws.hiDepWhy).toBeUndefined();
    expect(hers.hiDepWhy).toBe('배우자: 임대·사업소득 있음(사업자등록 있다고 봄)');
    // 배우자 사적연금 1,800만(2,000만 이하)은 피부양자 유지
    const dep = incomeTaxSchedule(priv, 2026, new Map([[2026, [0, 1800] as [number, number]]]), [shop('self')])[1];
    expect(dep.hiMode).toBe('workDep');
    expect(dep.hiMonth).toBeCloseTo((400 / 12) * k, 6);
  });

  it('부부 모두 직장일 때 사적연금은 각자 급여 외 소득에만 더해져 2,000만 초과분을 따로 계산', () => {
    const d = retiree();
    // 본인(58세)·배우자(53세) 모두 60세 넘어서까지 급여, 소득은 사적연금뿐
    const p = { ...d.profile, retireAge: 62, spouseBirthYear: 1973, spouseRetireAge: 60, spouseWageGross: 4000, inflation: 0, nationalPension: 0, spousePension: 0, incomes: [], wageGross: 5000, incomeTax: { ...DEFAULT_TAX_ON, hiNow: 0, hiPropAuto: true, hiPrivate: true } };
    const k = 0.0719 * 1.1314;
    // 본인 5,000만 → 50% 2,500만(500만 초과), 배우자 3,000만 → 1,500만(문턱 아래)
    const both = incomeTaxSchedule(p, 2026, new Map<number, [number, number]>([[2026, [5000, 3000]]]), [])[1];
    expect(both.hiMode).toBe('work');
    expect(both.hiWork).toBeCloseTo((500 / 12) * k, 6);
    expect(both.hiMonth).toBeCloseTo((500 / 12) * k, 6);
    expect(both.hiDepWhy).toBeUndefined();
    // 같은 합계 8,000만이라도 반씩(4,000·4,000)이면 둘 다 2,000만 → 0 (부부 합산이 아님)
    const half = incomeTaxSchedule(p, 2026, new Map<number, [number, number]>([[2026, [4000, 4000]]]), [])[1];
    expect(half.hiMonth).toBeCloseTo(0, 9);
    // 둘 다 문턱 초과: 각자 초과분 합계
    const over = incomeTaxSchedule(p, 2026, new Map<number, [number, number]>([[2026, [6000, 5000]]]), [])[1];
    expect(over.hiMonth).toBeCloseTo(((1000 + 500) / 12) * k, 6);
    // 끄면 사적연금이 빠져 0
    const off = incomeTaxSchedule({ ...p, incomeTax: { ...p.incomeTax, hiPrivate: false } }, 2026, new Map<number, [number, number]>([[2026, [6000, 5000]]]), [])[1];
    expect(off.hiMonth).toBeCloseTo(0, 9);
  });

  it('은퇴 전 급여가 있으면 ‘첫해 대비’를 은퇴 전·후로 나눠 은퇴 후는 급여가 끝난 해 기준', () => {
    const d = retiree();
    const shop = { name: '상가', type: 'realestate' as const, amount: 50000, expectedReturn: 3, volatility: 8, purpose: 'long' as const, nature: 'invest' as const, reUse: 'rental' as const, rent: 200, deposit: 0, renewCycle: 2, renewRate: 0, rentCost: 0 };
    const base = { ...d.profile, retireAge: 62, spouseBirthYear: 1973, spouseRetireAge: 56, inflation: 0, nationalPension: 0, spousePension: 0, incomes: [], incomeTax: { ...DEFAULT_TAX_ON } };
    const rows = incomeTaxSchedule({ ...base, wageGross: 3000, spouseWageGross: 3000 }, 2026, undefined, [shop]);
    const y = (n: number) => rows.find((x) => x.year === n)!;
    // 2029(배우자만 은퇴)까지는 첫해(2026) 기준, 2030(본인도 은퇴, 급여 0)부터는 2030 기준
    expect(y(2026).baseYear).toBe(2026);
    expect(y(2029).baseYear).toBe(2026);
    expect(y(2029).increase).toBeCloseTo(y(2029).total - y(2026).total, 6);
    expect(y(2030).baseYear).toBe(2030);
    expect(y(2030).increase).toBe(0);
    expect(y(2026).due).toBeGreaterThan(y(2030).due); // 급여가 빠져 세금이 줄어도(건보료는 은퇴 전 직장가입자라 오히려 은퇴 후가 큼)
    expect(rows.filter((r) => r.year >= 2030).every((r) => r.increase > -0.5)).toBe(true); // 은퇴 후엔 마이너스로 안 나옴
    expect(y(2035).increase).toBeCloseTo(y(2035).total - y(2030).total, 6);
    // 급여를 안 넣으면 기준은 계속 첫해
    const none = incomeTaxSchedule(base, 2026, undefined, [shop]);
    expect(none.every((r) => r.baseYear === 2026)).toBe(true);
  });

  it('은퇴 후 변동성 권장 범위: 초과수익 ÷ 샤프 0.4~0.2, 벗어나면 낮음(낙관)·높음(보수)', () => {
    expect(volRange(4)).toEqual({ min: 2.5, max: 5 });
    expect(volRange(6)).toEqual({ min: 7.5, max: 15 });
    expect(volRange(8)).toEqual({ min: 12.5, max: 25 });
    expect(volRange(4.5)).toEqual({ min: 4, max: 7.5 }); // 3.75 → 0.5 단위 반올림
    expect(volRange(2)).toEqual({ min: 0, max: 3 }); // 예금 수준 이하는 0~3
    expect(volCheck(6, 7)).toBe('low');
    expect(volCheck(6, 10)).toBe('ok');
    expect(volCheck(4, 8)).toBe('high');
    expect(volCheck(6, 7.5)).toBe('ok'); // 경계 포함
    // ‘권장값으로 맞추기’ = 범위 가운데(0.5 단위)
    expect(volMid(4)).toBe(4); // 2.5~5 → 3.75 → 4
    expect(volMid(6)).toBe(11.5); // 7.5~15 → 11.25 → 11.5
    expect(volMid(4.5)).toBe(6); // 4~7.5 → 5.75 → 6
    expect(volMid(2)).toBe(1.5); // 0~3
    for (const r of [3.5, 4, 4.5, 5, 6, 7, 8]) expect(volCheck(r, volMid(r))).toBe('ok');
  });

  it('개인·퇴직연금 월액과 자산 탭 연금 계좌 중복 경고', () => {
    const acct = (name: string, owner?: 'self' | 'spouse' | 'joint', amount = 10000) => ({ name, type: 'pension' as const, amount, expectedReturn: 5, volatility: 10, purpose: 'long' as const, nature: 'invest' as const, owner });
    const assets = [acct('연금저축'), acct('IRP', 'spouse'), acct('공동', 'joint'), acct('빈 계좌', 'self', 0), { ...acct('ETF'), type: 'etf' as const }];
    expect(pensionOverlap(0, assets, 'self')).toEqual([]); // 월액 0이면 경고 없음
    expect(pensionOverlap(50, assets, 'self').map((a) => a.name)).toEqual(['연금저축', '공동']);
    expect(pensionOverlap(50, assets, 'spouse').map((a) => a.name)).toEqual(['IRP', '공동']);
    expect(pensionOverlap(50, [], 'self')).toEqual([]);
    // 샘플 데이터는 연금 계좌만 넣고 월액은 0이라 경고가 안 나옴
    const s = sampleData(2026);
    expect(pensionOverlap(s.profile.privatePension, s.assets, 'self')).toEqual([]);
    expect(pensionOverlap(s.profile.spousePrivatePension ?? 0, s.assets, 'spouse')).toEqual([]);
  });

  it('월세 중복 입력 경고: 이름이 비슷하거나 월액이 같으면 겹친다고 봄', () => {
    const a = (name: string, rent: number, rentCost = 0) => ({ name, type: 'realestate' as const, amount: 50000, expectedReturn: 3, volatility: 8, purpose: 'long' as const, nature: 'invest' as const, reUse: 'rental' as const, rent, rentCost });
    const assets = [a('환타지아 상가(미용실)', 150), a('환타지아 상가(병원)', 300, 10)];
    expect(rentDuplicates({ name: '환타지아 미용실 월세', monthly: 80 }, assets)).toEqual([]); // 포함 관계 아님, 금액 다름
    expect(rentDuplicates({ name: '상가(병원) 임대료', monthly: 80 }, assets).map((x) => [x.asset.name, x.by])).toEqual([['환타지아 상가(병원)', 'name']]);
    expect(rentDuplicates({ name: '환타지아', monthly: 80 }, assets)).toHaveLength(2);
    expect(rentDuplicates({ name: '오피스텔', monthly: 150 }, assets).map((x) => x.by)).toEqual(['amount']);
    expect(rentDuplicates({ name: '오피스텔', monthly: 270 }, assets).map((x) => x.asset.name)).toEqual(['환타지아 상가(병원)']); // 경비 10% 뺀 월세
    expect(rentDuplicates({ name: '임대료', monthly: 100 }, assets)).toEqual([]); // 흔한 말만 있으면 이름 비교 안 함
    expect(rentDuplicates({ name: '환타지아', monthly: 80 }, [{ ...assets[0], reUse: 'home' as const }])).toEqual([]);
  });

  it('국민연금 생일 월(첫해 월할)·연 인상률: 엑셀처럼 생일 다음 달부터, 2% 인상', () => {
    const d = retiree();
    d.profile = {
      ...d.profile, spouseBirthYear: 1973, nationalPension: 200, nationalPensionAge: 64, spousePension: 100, spousePensionAge: 65,
      birthMonth: 7, spouseBirthMonth: 11, npGrowth: 2, incomes: [],
      incomeTax: { on: true, rentSpouseShare: 100, rentExpense: 50, npTaxable: 80, npNet: 100, dedSelf: 150, dedSpouse: 150, hiNow: 0, hiRate: 7.19, hiLtc: 13.14, hiPublic: 50, hiPropGrowth: 0, hiPrivate: false, addToDraw: false },
    };
    const rows = incomeTaxSchedule(d.profile, 2026);
    const y = (n: number) => rows.find((r) => r.year === n)!;
    // 남편 2032년(64세): 7월생 → 8~12월 5개월, 명목 2%/년
    expect(y(2032).npSelf).toBeCloseTo(200 * 5 * 1.02 ** 6, 6);
    expect(y(2033).npSelf).toBeCloseTo(2400 * 1.02 ** 7, 6);
    // 엑셀 2034년 남편 국민연금 세전 2,811.98만 → 종소세 91.39만
    expect(y(2034).npSelf).toBeCloseTo(2811.9825144, 4);
    expect(y(2034).taxSelf).toBeCloseTo(91.3854, 3);
    // 아내 2038년(65세): 11월생 → 12월 1개월
    expect(y(2037).npSpouse).toBe(0);
    expect(y(2038).npSpouse).toBeCloseTo(100 * 1 * 1.02 ** 12, 6);
    // 노후 계산(실질): 첫해는 5/12, 이후 명목 2% − 물가 2.5%
    const np = retireIncomes(d.profile, 58).find((x) => x.name === '국민연금')!;
    expect(incomeValue(np, 64, 2.5)).toBeCloseTo((2400 * (5 / 12) * 1.02 ** 6) / 1.025 ** 6, 6);
    expect(incomeValue(np, 70, 2.5)).toBeCloseTo((2400 * 1.02 ** 12) / 1.025 ** 12, 6);
    // 출생 월·인상률이 없으면 첫해도 12개월, 물가만큼
    const plain = retireIncomes({ ...d.profile, birthMonth: 0, npGrowth: undefined }, 58).find((x) => x.name === '국민연금')!;
    expect(incomeValue(plain, 64, 2.5)).toBe(2400);
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

  it('인출순서 조합 비교: ②는 지금 계획(납입 없음)과 같고, 납입 조합은 환급·납입이 생김', () => {
    const d = retiree();
    d.insurance = []; // 인출 순서·세금 비교만 보도록 은퇴 후 보험료 없음
    const base = { type: 'pension' as const, expectedReturn: 4, volatility: 0, purpose: 'long' as const, nature: 'safe' as const, pensionYear1: 2018 };
    d.profile = { ...d.profile, spouseBirthYear: 1968, retireTaxRate: 10, retireTaxYear1: 2025, contrib: undefined, incomes: [{ name: '임대료', monthly: 400, startAge: 58, endAge: 0, growth: 0, step: 1, rent: true }],
      incomeTax: { on: true, rentSpouseShare: 100, rentExpense: 50, npTaxable: 80, npNet: 100, dedSelf: 150, dedSpouse: 150, hiNow: 0, hiRate: 7.19, hiLtc: 13.14, hiPublic: 50, hiPropGrowth: 0, hiPrivate: false, addToDraw: false } };
    d.assets = [
      { ...base, name: 'IRP', amount: 30000, drawOrder: 2 },
      { ...base, name: '키움', amount: 5000, drawStartYear: 2032, drawOrder: 3 },
      { ...base, name: '교보', amount: 8000, drawOrder: 1 },
      { ...base, name: '아내 IRP', amount: 6000, owner: 'spouse', drawStartYear: 2030 },
    ];
    const pi = plan(d);
    const s = summarize(d.profile, d.assets, d.liabilities, d.cashflows, 2026, d.insurance);
    const start = withdrawStart(pi);
    const input = { startAge: start.age, endAge: d.profile.lifeExpectancy, startBalance: start.balance, expenseAnnual: pi.retireExpenseAnnual, inflows: pi.inflows, pensions: pi.pensions, meanReturn: 4, volatility: 10, inflation: 2.5, percentRate: 4, extras: pi.goals.filter((g) => g.age >= start.age), guardrail: DEFAULT_GUARDRAIL };
    const cb = { profile: d.profile, assets: d.assets, liabilities: d.liabilities, goals: d.goals, summary: s, input, strategy: 'fixed' as const, meanReturn: 4 };
    const combos = orderCombos(true);
    expect(combos.map((c) => c.key)).toEqual(['1', '2', '3', '4', '5']);
    expect(orderCombos(false).map((c) => c.key)).toEqual(['1', '2', '3']);
    const c = { self: 900, spouse: 900, from: 2027, to: 2031 };
    const setup = taxSetup(d.profile, d.assets, 2026, start.balance, 4)!;
    const now = summarizeTax(pensionTaxSchedule(compareStrategy('fixed', input, 0).schedule, setup), setup, null);
    const r = combos.map((k) => runCombo(cb, k, c)!);
    expect(r[1].totalTax).toBeCloseTo(now.totalTax, 6);
    expect(r[1].contrib).toBe(0);
    // ①은 순서·시작 연도를 무시 → 첫해 키움·아내 IRP에서도 꺼냄
    expect(r[0].tax.rows[0].accounts.find((a) => a.name === '아내 IRP')!.drawn).toBeGreaterThan(0);
    expect(r[1].tax.rows[0].accounts.find((a) => a.name === '아내 IRP')!.drawn).toBe(0);
    // ⑤ 아내 납입: 임대 종소세가 있어 공제 900 × 16.5%(자동) × 5년, 남편은 종합소득 없음
    expect(r[4].contrib).toBeGreaterThan(0);
    expect(r[4].credit).toBeGreaterThan(0);
    expect(r[2].credit).toBe(0);
    expect(r[4].netTax).toBeCloseTo(r[4].totalTax - r[4].credit, 6);
    // 점검 나이: 90세 전에 바닥나는 조합이 있으면 모든 조합에 잔액이 남은 마지막 나이, 아니면 90세
    const ck = checkAge(r)!;
    expect(ck).toBeLessThanOrEqual(CHECK_AGE);
    for (const x of r) expect(x.tax.rows.filter((y) => y.age <= ck).every((y) => y.left > 0.5)).toBe(true);
    const dep = Math.min(...r.map((x) => x.depletedAge ?? Infinity));
    const at = r[1].tax.rows.find((x) => x.age === ck)!;
    const k = checkAt(r[1], ck);
    expect(k.leftAt).toBeCloseTo(at.left, 6);
    expect(k.taxTo).toBeCloseTo(r[1].tax.rows.filter((x) => x.age <= ck).reduce((a, x) => a + x.tax, 0), 6);
    expect(k.taxTo).toBeLessThanOrEqual(r[1].totalTax + 1e-9);
    // 모두 바닥나도 점검 나이 잔액은 0보다 큼
    if (dep <= CHECK_AGE) expect(k.leftAt!).toBeGreaterThan(0);
    expect(checkAge([{ ...r[1], depletedAge: null }])).toBe(CHECK_AGE);

    // 비교 기준 순서: ①은 입력 순서 대신 이 순서(키움 → 교보 → IRP)로 꺼내고, ②는 영향 없음
    const first = (x: ComboResult, name: string) => x.tax.rows[0].accounts.find((a) => a.name === name)!.drawn;
    expect(hasCompareOrder(d.assets)).toBe(false);
    expect(first(r[0], 'IRP')).toBeGreaterThan(0);
    expect(first(r[0], '키움')).toBe(0);
    const order: Record<string, number> = { 키움: 1, 교보: 2, IRP: 3 };
    const cbo = { ...cb, assets: d.assets.map((a) => ({ ...a, compareOrder: order[a.name] ?? 0 })) };
    expect(hasCompareOrder(cbo.assets)).toBe(true);
    const r1 = runCombo(cbo, combos[0], c)!;
    expect(first(r1, '키움')).toBeGreaterThan(0);
    expect(first(r1, 'IRP')).toBe(0);
    expect(runCombo(cbo, combos[1], c)!.totalTax).toBeCloseTo(r[1].totalTax, 6);
  });
});

describe('올해는 남은 달만 계산(엑셀: 계획 시작월)', () => {
  const flat: PlanInput = { currentAge: 60, retireAge: 60, lifeExpectancy: 63, startBalance: 10000, annualSavings: 0, meanReturn: 0, volatility: 0, inflation: 0, retireExpenseAnnual: 1200, pensions: [{ startAge: 60, annual: 240 }], goals: [] };

  it('첫해는 생활비·소득·저축·수익을 그 기간만큼만, 다음 해부터 1년 단위', () => {
    // 11월(2개월 남음): 첫해 (1,200 − 240) × 2/12 = 160, 그 뒤 해마다 960
    const part = { ...flat, firstYearShare: 2 / 12 };
    expect(yearShareAt(part, 60)).toBeCloseTo(2 / 12, 10);
    expect(yearShareAt(part, 61)).toBe(1);
    expect(deterministicPath(part).balances).toEqual([10000, 10000 - 160, 10000 - 160 - 960, 10000 - 160 - 1920].map((x) => expect.closeTo(x, 6)));
    expect(deterministicPath(flat).balances[1]).toBeCloseTo(10000 - 960, 6);
    // 수익도 그 기간만큼: 연 6% → 첫해 6% × 2/12
    const grow = deterministicPath({ ...part, meanReturn: 6, retireExpenseAnnual: 240 });
    expect(grow.balances[1]).toBeCloseTo(10000 * 1.01, 6);
    // 은퇴 전 저축도 남은 달만큼
    const saving = deterministicPath({ ...part, retireAge: 62, annualSavings: 1200 });
    expect(saving.balances[1]).toBeCloseTo(10000 + 200, 6);
    expect(saving.balances[2]).toBeCloseTo(10000 + 200 + 1200, 6);
  });

  it('한 번 쓰는 지출·일시금은 그대로, 해마다 나가는 지출(flow)만 줄임', () => {
    const inp = { ...flat, firstYearShare: 0.5, goals: [{ age: 60, amount: 1000 }, { age: 60, amount: 600, flow: true }], inflows: [{ age: 60, amount: 300 }] };
    expect(outflowAt(inp, 60, 0, 0.5)).toBeCloseTo(1000 + 300 + 480 - 300, 6);
    expect(deterministicPath(inp).balances[1]).toBeCloseTo(10000 - 1480, 6);
    // 인출률은 연으로 환산한 값이라 첫해 비율과 상관없음
    expect(withdrawStart({ ...flat, firstYearShare: 0.5 }).rate).toBeCloseTo(withdrawStart(flat).rate, 6);
    // 필요자금: 첫해 몫만 줄어듦
    expect(retirementNeed(flat).need - retirementNeed({ ...flat, firstYearShare: 0.5 }).need).toBeCloseTo(480, 6);
  });

  it('요약의 달 → 계획 입력: 1월이면 1년 전체, 11월이면 2/12, 달을 안 넘기면 예전처럼 1년', () => {
    const d = sampleData(2026);
    const sum = (month?: number) => summarize(d.profile, d.assets, d.liabilities, d.cashflows, 2026, d.insurance, month);
    const inp = (month?: number) => buildPlanInput(d.profile, d.assets, d.liabilities, d.goals, sum(month));
    expect(sum().yearShare).toBeUndefined();
    expect(inp().firstYearShare).toBeUndefined();
    expect(inp(1).firstYearShare).toBeUndefined();
    expect(inp(11).firstYearShare).toBeCloseTo(2 / 12, 10);
    // 매년 반복 지출·은퇴 후 보험료는 flow, 한 번 쓰는 목표는 아님
    const goals: Goal[] = [{ name: '여행', category: 'travel', targetAge: 60, amountPV: 500, growthRate: 2, endAge: 70 }, { name: '차', category: 'car', targetAge: 62, amountPV: 3000, growthRate: 2 }];
    const g = buildPlanInput(d.profile, d.assets, d.liabilities, goals, sum(11)).goals;
    expect(g.filter((x) => x.age === 62 && !x.premium).map((x) => !!x.flow).sort()).toEqual([false, true]);
    expect(g.filter((x) => x.premium).every((x) => x.flow)).toBe(true);
  });

  it('인출 스케줄·연금 세금·기준선도 첫해는 남은 달만큼', () => {
    const w = { startAge: 60, endAge: 63, startBalance: 10000, expenseAnnual: 1200, pensions: [{ startAge: 60, annual: 240 }], meanReturn: 0, volatility: 0, inflation: 0, percentRate: 4, firstYearShare: 2 / 12, extras: [{ age: 60, amount: 500 }, { age: 60, amount: 120, flow: true }] };
    expect(needAt(w, 60)).toBeCloseTo(960 + 620, 6); // 연 금액(화면의 인출률·월 금액용)
    expect(needAt(w, 60, shareAt(w, 60))).toBeCloseTo(160 + 500 + 20, 6);
    expect(shareAt(w, 61)).toBe(1);
    const s = compareStrategy('fixed', w, 0).schedule;
    expect(s[0]).toMatchObject({ share: 2 / 12 });
    expect(s[0].withdrawal).toBeCloseTo(680, 6);
    expect(s[0].pension).toBeCloseTo(40, 6);
    expect(s[1].share).toBeUndefined();
    expect(s[1].withdrawal).toBeCloseTo(960, 6);
    const b = guardrailBaseline(w);
    expect(b.share).toBeCloseTo(2 / 12, 10);
    expect(b.balances[1]).toBeCloseTo(10000 - 680, 6);
    expect(guardrailBaseline({ ...w, firstYearShare: undefined }).share).toBeUndefined();
    // 세금 엔진: 첫해 운용수익도 2개월분
    const d = sampleData(2026);
    const profile = { ...d.profile, birthYear: 1966, spouseBirthYear: 0, inflation: 0 };
    const assets = [{ name: '연금저축', type: 'pension' as const, amount: 10000, expectedReturn: 6, volatility: 0, purpose: 'long' as const, nature: 'safe' as const, pensionYear1: 2010 }];
    const row = (share?: number) => ({ age: 60, pension: 0, withdrawal: 0, income: 0, need: 0, endBalance: 0, inflow: 0, ...(share ? { share } : {}) });
    const left = (share?: number) => pensionTaxSchedule([row(share)], taxSetup(profile, assets, 2026, 10000, 6)!).rows[0].left;
    expect(left()).toBeCloseTo(10600, 6);
    expect(left(2 / 12)).toBeCloseTo(10000 * Math.pow(1.06, 2 / 12), 6);
  });
});

describe('다가오는 이정표·할 일, 계좌별 자산 배치', () => {
  const d = sampleData(2026);
  const profile = {
    ...d.profile, birthYear: 1968, birthMonth: 7, retireAge: 58, lifeExpectancy: 100, spouseBirthYear: 1973, spouseBirthMonth: 11,
    nationalPension: 200, nationalPensionAge: 64, spousePension: 100, spousePensionAge: 65, retireTaxYear1: 2025,
    slotFill: true, slotFillFrom: 2027, contrib: { self: 0, spouse: 900, from: 2027, to: 2031, selfRate: 0, spouseRate: 13.2 },
  };
  const base = { type: 'pension' as const, expectedReturn: 5, volatility: 8, purpose: 'long' as const, nature: 'invest' as const };
  const assets = [
    { ...base, name: '퇴직 IRP', amount: 30000, retirePart: 20000, pensionYear1: 2023 },
    { ...base, name: '교보', amount: 8000, pensionYear1: 2018 },
    { ...base, name: '키움', amount: 2000, pensionYear1: 2023, drawStartYear: 2032 },
    { ...base, name: '아내 IRP', amount: 6000, owner: 'spouse' as const, pensionYear1: 2028, drawStartYear: 2028 },
    { name: '노란우산', type: 'other' as const, amount: 4000, expectedReturn: 3, volatility: 0, purpose: 'long' as const, nature: 'safe' as const, lockYear: 2029, lockTax: 4 },
  ];

  it('엑셀 대시보드의 이정표를 시기순으로 만들고 지난 것은 뺌', () => {
    const list = milestones(profile, assets, [{ name: '전세대출', balance: 5000, rate: 4, monthlyPayment: 17, repay: 'bullet', endAge: 62 }], [{ name: '차', category: 'car', targetAge: 61, amountPV: 3000, growthRate: 2 }], 2026, 11);
    const at = (label: string) => list.find((m) => m.label.includes(label));
    expect(list.map((m) => m.year)).toEqual([...list.map((m) => m.year)].sort((a, b) => a - b));
    expect(at('연말결산')).toMatchObject({ year: 2027, month: 1 });
    expect(at('교보 연금수령 11년차')).toMatchObject({ year: 2028, kind: 'limit' }); // 2018년이 1년차
    expect(at('퇴직 IRP·키움 연금수령 11년차')).toMatchObject({ year: 2033 }); // 같은 해는 한 줄
    expect(at('배우자 만 55세')).toMatchObject({ year: 2028, month: 11 });
    expect(at('본인 만 55세')).toBeUndefined(); // 2023년 — 지남
    expect(at('키움 인출 시작')).toMatchObject({ year: 2032, kind: 'open' });
    expect(at('노란우산 수령')).toMatchObject({ year: 2029, kind: 'lump' });
    expect(at('본인 국민연금 개시')).toMatchObject({ year: 2032, month: 8 }); // 7월생 → 8월부터
    expect(at('배우자 국민연금 개시')).toMatchObject({ year: 2038, month: 12 });
    expect(at('퇴직금 연금 실수령 11년차')).toMatchObject({ year: 2035 });
    expect(at('본인 만 70세')).toMatchObject({ year: 2038, month: 7, kind: 'tax' });
    expect(at('연금계좌 추가 납입')).toMatchObject({ year: 2027, month: 12 });
    expect(at('세액공제 환급')).toMatchObject({ year: 2032, month: 5 });
    expect(at('전세대출 만기')).toMatchObject({ year: 2030, kind: 'loan' });
    expect(at('차 지출')).toMatchObject({ year: 2029, kind: 'goal' });
    // 12월생은 다음 해 1월부터 국민연금
    expect(milestones({ ...profile, birthMonth: 12 }, assets, [], [], 2026, 11).find((m) => m.label.includes('본인 국민연금'))).toMatchObject({ year: 2033, month: 1 });
    expect(monthsUntil({ year: 2028, month: 11 }, 2026, 11)).toBe(24);
    expect(untilLabel({ year: 2028, month: 11 }, 2026, 11)).toBe('2년');
    expect(untilLabel({ year: 2027, month: 1 }, 2026, 11)).toBe('2개월');
    expect(untilLabel({ year: 2029, month: 0 }, 2026, 11)).toBe('2년 2개월');
  });

  it('올해·내년 할 일: 개시 신청·추가 납입·환급·최소 인출·연말결산', () => {
    expect(yearTodos(profile, assets, 2026, 2026)).toEqual([]);
    const y27 = yearTodos({ ...profile, retireMinDraw: 12 }, assets, 2026, 2027);
    expect(y27.some((x) => x.includes('연말결산'))).toBe(true);
    expect(y27.some((x) => x.includes('추가 납입: 배우자 900만원'))).toBe(true);
    expect(y27.some((x) => x.includes('최소 12만원 인출'))).toBe(true);
    expect(y27.some((x) => x.includes('환급'))).toBe(false);
    const y28 = yearTodos(profile, assets, 2026, 2028);
    expect(y28.some((x) => x.includes('아내 IRP 연금 개시 신청'))).toBe(true);
    expect(y28.some((x) => x.includes('환급 확인'))).toBe(true);
    expect(yearTodos(profile, assets, 2026, 2029).some((x) => x.includes('노란우산 수령 신청'))).toBe(true);
    expect(yearTodos(profile, assets, 2026, 2032).some((x) => x.includes('본인 국민연금 수령 신청'))).toBe(true);
  });

  it('계좌별 바구니: 앞 2년 인출분은 현금성, 3~5년차는 채권, IRP는 위험자산 70%까지', () => {
    const acct = (name: string, start: number, drawn: number[]) => drawn.map((x) => ({ name, owner: 'self' as const, yearNo: 5, limit: Infinity, start, drawn: x, tax: 0, over: 0, freeLeft: 0, retireLeft: 0 }));
    const a = acct('연금저축', 10000, [1000, 1000, 500, 500, 500, 500]);
    const b = acct('퇴직 IRP', 20000, [0, 0, 0, 0, 0, 0]);
    const rows = a.map((x, i) => ({ accounts: [x, b[i]] })) as unknown as TaxResult['rows'];
    const tax = { rows, totalTax: 0, overYears: [], limitWarnings: [], depletedAge: null };
    const [x, y] = accountBuckets(tax, 0.1);
    expect(x).toMatchObject({ cash: 2000, bond: 1500, alt: 1000, growth: 5500, capped: false });
    // 인출이 없는 IRP: 대체 10% + 성장 60% = 위험자산 70%, 나머지 30%는 채권·배당
    expect(isRiskCapped('퇴직 IRP')).toBe(true);
    expect(y).toMatchObject({ cash: 0, alt: 2000, capped: true });
    expect(y.growth).toBeCloseTo(12000, 6);
    expect(y.bond).toBeCloseTo(6000, 6);
    expect(y.riskShare).toBeCloseTo(70, 6);
    // 첫 행이 올해 남은 달만이면 현금성에 한 해를 더 넣음
    expect(accountBuckets(tax, 0.1, true)[0]).toMatchObject({ cash: 2500, bond: 1500 });
    expect(marketState(-18)).toBe('bear');
    expect(marketState(0)).toBe('peak');
    expect(marketState(-7)).toBe('normal');
    expect(marketRule(-18).text).toContain('주식형 매도를 멈추고');
  });
});

describe('피보험자별 보장 진단', () => {
  const d = sampleData(2026);
  const p = { ...d.profile, spouseIncome: 250 };
  const s = summarize(p, d.assets, d.liabilities, d.cashflows, 2026, d.insurance);
  const base = { death: 0, critical: 0, care: 0, monthlyPremium: 5 };
  const policies = [
    { ...base, name: '본인 종신', death: 10000 },
    { ...base, name: '배우자 암', insured: 'spouse' as const, critical: 2000 },
    { ...base, name: '첫째 실손', insured: 'child' as const, insuredBirthYear: 2015, critical: 1000 },
    { ...base, name: '둘째 암', insured: 'child' as const, insuredBirthYear: 2018, critical: 3000, care: 500 },
  ];
  const ins = insuranceGap(p, s, policies, d.goals);
  it('사람마다 따로 묶고 그 사람 보험만 더함', () => {
    expect(ins.people.map((g) => g.person)).toEqual(['본인', '배우자', '자녀(2015년생)', '자녀(2018년생)']);
    expect(ins.people[0].lines.find((l) => l.key === 'death')!.current).toBe(10000);
    expect(ins.people[0].lines.find((l) => l.key === 'critical')!.current).toBe(0);
    expect(ins.people[1].lines.find((l) => l.key === 'critical')!.current).toBe(2000);
    expect(ins.people[2].count).toBe(1);
  });
  it('필요액: 본인 진단비는 본인 소득, 배우자는 배우자 소득, 자녀는 기준액', () => {
    const need = (i: number, k: string) => ins.people[i].lines.find((l) => l.key === k)?.need;
    expect(need(0, 'critical')).toBe((s.income - 250) * 12 * p.criteria.criticalMultiple);
    expect(need(1, 'critical')).toBe(Math.max(CRITICAL_BASE, 250 * 12 * p.criteria.criticalMultiple));
    expect(need(1, 'death')).toBe(250 * 12 * p.dependentYears);
    expect(need(2, 'critical')).toBe(CRITICAL_BASE);
    expect(need(2, 'death')).toBeUndefined(); // 자녀 사망·간병은 가입한 경우에만 표시
    expect(need(3, 'care')).toBe(0);
    expect(ins.lines).toHaveLength(ins.people.reduce((a, g) => a + g.lines.length, 0));
  });
});

describe('나이 구간별 은퇴 후 생활비', () => {
  const d = sampleData(2026);
  const s = summarize(d.profile, d.assets, d.liabilities, d.cashflows, 2026, d.insurance);
  const base = d.profile.retireMonthlyExpense;
  const p = { ...d.profile, expenseSteps: [{ fromAge: 80, monthly: base * 0.6 }, { fromAge: 70, monthly: base * 0.8 }] };
  const inp = buildPlanInput(p, d.assets, d.liabilities, d.goals, s);
  it('나이순 배율로 바꿔 구간마다 생활비 적용', () => {
    expect(inp.expenseSteps).toEqual([{ fromAge: 70, ratio: 0.8 }, { fromAge: 80, ratio: 0.6 }]);
    expect(expenseAt(inp, 65)).toBeCloseTo(base * 12, 6);
    expect(expenseAt(inp, 70)).toBeCloseTo(base * 12 * 0.8, 6);
    expect(expenseAt(inp, 85)).toBeCloseTo(base * 12 * 0.6, 6);
    expect(expenseRatioAt(undefined, 90)).toBe(1);
  });
  it('구간이 있으면 필요자금이 줄고, 인출액 고정 방식에서는 쓰지 않음', () => {
    const flat = buildPlanInput(d.profile, d.assets, d.liabilities, d.goals, s);
    expect(retirementNeed(inp).need).toBeLessThan(retirementNeed(flat).need);
    expect(expenseSteps({ ...p, expenseMode: 'draw' })).toBeUndefined();
    expect(expenseSteps({ ...p, expenseSteps: [] })).toBeUndefined();
  });
  it('기본 생활비를 바꾸는 시나리오에서는 구간도 같은 비율로 따라감', () => {
    const more = buildPlanInput(p, d.assets, d.liabilities, d.goals, s, { retireMonthlyExpense: base * 2 });
    expect(expenseAt(more, 75)).toBeCloseTo(base * 2 * 12 * 0.8, 6);
  });
});

describe('연말결산 계좌별 이어받기', () => {
  const acct = (id: number, name: string, type: 'pension' | 'etf' | 'realestate' | 'other', amount: number, extra = {}) => ({ id, name, type, amount, expectedReturn: 4, volatility: 8, purpose: 'long' as const, nature: 'invest' as const, ...extra });
  const assets = [
    acct(1, '연금저축', 'pension', 10000, { taxFree: 300, retirePart: 2000 }),
    acct(2, 'IRP', 'pension', 5000, { retirePart: 5000 }),
    acct(3, 'ISA', 'etf', 3000),
    acct(4, '집', 'realestate', 60000),
    acct(5, '노란우산', 'other', 2000, { lockYear: 2030 }),
  ];
  const draws = [
    { month: '2026-11', account: '연금저축', amount: 400 },
    { month: '2026-12', account: '연금저축', amount: 500 },
    { month: '2026-12', account: 'IRP', amount: 100 },
    { month: '2026-12', account: 'ISA·일반', amount: 200 },
    { month: '2027-01', account: '연금저축', amount: 999 },
  ];
  it('입력 대상: 그 해 12월 말에 꺼낼 수 있는 금융자산(부동산·수령 전 자산 제외)', () => {
    expect(yearEndAccounts(assets, 2026).map((a) => a.name)).toEqual(['연금저축', 'IRP', 'ISA']);
    expect(yearEndAccounts(assets, 2030).map((a) => a.name)).toEqual(['연금저축', 'IRP', 'ISA', '노란우산']);
  });
  it('12월 말 평가액이 다음 해 시작 금액이 되고, 그 해 인출만큼 과세제외 → 퇴직금 재원 순으로 줄어듦', () => {
    const rows = carryOverPlan(assets, [{ id: 1, name: '연금저축', balance: 9400 }, { id: 2, name: 'IRP', balance: 5100 }, { id: 3, name: 'ISA', balance: 3000 }], draws, 2026);
    // 연금저축: 그 해 900 인출 → 과세제외 300 모두 소진, 나머지 600은 퇴직금 재원에서
    expect(rows[0]).toMatchObject({ next: 9400, drawn: 900, freeNext: 0, retireNext: 1400, changed: true });
    // IRP: 100 인출 → 퇴직금 재원 4,900(평가액이 올라도 재원은 늘지 않음)
    expect(rows[1]).toMatchObject({ next: 5100, drawn: 100, retireNext: 4900 });
    // 연금계좌가 아니면 금액만, 같으면 바뀐 것 없음
    expect(rows[2]).toMatchObject({ pension: false, drawn: 0, changed: false });
    expect(carryPatch(rows[0])).toEqual({ amount: 9400, taxFree: 0, retirePart: 1400 });
    expect(carryPatch(rows[2])).toEqual({ amount: 3000 });
  });
  it('재원은 새 잔액을 넘지 않고, 재원 줄이기를 끄면 금액만 넘김, 이름이 바뀐 계좌는 id 로·지워진 계좌는 건너뜀', () => {
    const [low] = carryOverPlan(assets, [{ id: 2, name: 'IRP', balance: 3000 }], [], 2026);
    expect(low.retireNext).toBe(3000);
    const [keep] = carryOverPlan(assets, [{ id: 1, name: '연금저축', balance: 9400 }], draws, 2026, false);
    expect(keep).toMatchObject({ next: 9400, freeNext: 300, retireNext: 2000 });
    const rows = carryOverPlan(assets, [{ id: 3, name: '예전 이름', balance: 3500 }, { id: 99, name: '없는 계좌', balance: 1 }, { name: 'IRP', balance: 5000 }], draws, 2026);
    expect(rows.map((r) => [r.name, r.next])).toEqual([['ISA', 3500], ['IRP', 5000]]);
  });
  it('되돌리기: 적용 직전 값을 저장해 두고 그 값으로 복구, 여러 번 적용해도 처음 적용 전으로', () => {
    const rows = carryOverPlan(assets, [{ id: 1, name: '연금저축', balance: 9400 }, { id: 2, name: 'IRP', balance: 5100 }, { id: 3, name: 'ISA', balance: 3000 }], draws, 2026);
    const before = carryBefore(rows);
    // 바뀌지 않은 ISA 는 저장하지 않음
    expect(before).toEqual([{ id: 1, name: '연금저축', amount: 10000, taxFree: 300, retirePart: 2000 }, { id: 2, name: 'IRP', amount: 5000, taxFree: 0, retirePart: 5000 }]);
    const applied = assets.map((a) => { const r = rows.find((x) => x.id === a.id); return r ? { ...a, ...carryPatch(r) } : a; });
    // 두 번째 적용(평가액을 고쳐 다시): 이미 저장된 계좌는 처음 값을 지키고 새로 바뀐 계좌만 더함
    const again = carryOverPlan(applied, [{ id: 1, name: '연금저축', balance: 9000 }, { id: 3, name: 'ISA', balance: 3300 }], draws, 2026, false);
    const before2 = carryBefore(again, before);
    expect(before2.map((b) => [b.id, b.amount])).toEqual([[1, 10000], [2, 5000], [3, 3000]]);
    const applied2 = applied.map((a) => { const r = again.find((x) => x.id === a.id); return r ? { ...a, ...carryPatch(r) } : a; });
    const undo = undoCarryPlan(applied2.filter((a) => a.id !== 2), before2); // IRP 는 그 뒤 지움 → 건너뜀
    expect(undo.map((r) => [r.name, r.amount, r.back, r.changed])).toEqual([['연금저축', 9000, 10000, true], ['ISA', 3300, 3000, true]]);
    expect(undoPatch(undo[0])).toEqual({ amount: 10000, taxFree: 300, retirePart: 2000 });
    expect(undoPatch(undo[1])).toEqual({ amount: 3000 });
    // 이미 같은 값이면 바뀐 것 없음
    expect(undoCarryPlan(assets, before).every((r) => !r.changed)).toBe(true);
  });
});

describe('월별 실제 인출 기록(엑셀: 월별인출표)', () => {
  const acct = (name: string, yearNo: number, start: number, drawn: number, owner: 'self' | 'spouse' = 'self') => ({ name, owner, yearNo, limit: 0, start, drawn, tax: 0, over: 0, freeLeft: 0, retireLeft: 0 });
  const row = { year: 2026, age: 58, otherDrawn: 60, accounts: [acct('교보', 9, 8000, 900), acct('퇴직 IRP', 4, 35000, 12), acct('아내 IRP', 0, 6000, 0, 'spouse')] } as unknown as TaxResult['rows'][number];
  const rec = (month: string, account: string, amount: number, note?: string): Draw => ({ month, account, amount, ...(note ? { note } : {}) });

  it('달 표기: 여러 형식을 YYYY-MM 으로', () => {
    expect(monthKey(2026, 3)).toBe('2026-03');
    expect(parseMonth('2026-11')).toBe('2026-11');
    expect(parseMonth('2026/1')).toBe('2026-01');
    expect(parseMonth('2026.11.03')).toBe('2026-11');
    expect(parseMonth('2026년 7월')).toBe('2026-07');
    expect(parseMonth('202612')).toBe('2026-12');
    expect(parseMonth('2026-13')).toBeNull();
    expect(parseMonth('11월')).toBeNull();
  });

  it('첫해는 계획 시작 달부터: 연 계획 ÷ 남은 달 = 월 정기지급, 지난 달만큼이 지금까지 계획', () => {
    const rv = reviewDraws(row, 2026, [rec('2026-11', '교보', 450), rec('2026-11', '퇴직 IRP', 6)], { firstMonth: 11, nowYear: 2026, nowMonth: 11 });
    expect(rv.months).toBe(2);
    expect(rv.elapsed).toBe(1);
    expect(rv.accounts.map((a) => a.name)).toEqual(['교보', '퇴직 IRP', '아내 IRP', OTHER_ACCOUNT]);
    expect(rv.accounts[0]).toMatchObject({ planYear: 900, planMonth: 450, planToDate: 450, actual: 450, overLimit: 0 });
    expect(rv.accounts[3]).toMatchObject({ planYear: 60, planMonth: 30, limit: null });
    expect(rv.planYear).toBe(972);
    expect(rv.planToDate).toBeCloseTo(486, 6);
    expect(rv.actual).toBe(456);
    // 10월은 계획 기간 밖, 11월은 계획 합계와 실제 합계
    expect(rv.rows[9]).toMatchObject({ m: 10, inPlan: false, plan: 0, actual: 0 });
    expect(rv.rows[10]).toMatchObject({ m: 11, inPlan: true, past: true, actual: 456 });
    expect(rv.rows[10].plan).toBeCloseTo(486, 6);
    expect(rv.rows[11].past).toBe(false);
  });

  it('연 누적이 연금수령한도(연초 평가액 ÷ (11 − 연차) × 120%)를 넘으면 넘은 금액, 수령 전 계좌는 전액', () => {
    // 교보 9년차: 8,000 ÷ 2 × 1.2 = 4,800
    const many = [rec('2027-01', '교보', 3000), rec('2027-02', '교보', 2000), rec('2027-02', '아내 IRP', 100), rec('2027-03', 'ISA·일반', 50, '여행')];
    const rv = reviewDraws({ ...row, year: 2027 }, 2027, many, { nowYear: 2027, nowMonth: 3 });
    expect(rv.months).toBe(12);
    expect(rv.elapsed).toBe(3);
    expect(rv.accounts[0].limit).toBeCloseTo(pensionLimit(8000, 9), 6);
    expect(rv.accounts[0].overLimit).toBeCloseTo(200, 6);
    expect(rv.accounts[1].overLimit).toBe(0);
    // 아내 IRP 는 연금수령 1년차 전(0년차): 한도 0 → 꺼낸 100 전부 한도 밖
    expect(rv.accounts[2]).toMatchObject({ limit: 0, overLimit: 100 });
    expect(rv.accounts[3]).toMatchObject({ actual: 50, overLimit: 0 });
    expect(rv.rows[2].notes).toEqual(['여행']);
    // 다른 해 기록은 섞이지 않음
    expect(reviewDraws({ ...row, year: 2028 }, 2028, many, { nowYear: 2027, nowMonth: 3 })).toMatchObject({ actual: 0, elapsed: 0 });
  });

  it('계획에 없는 이름의 기록·계획 전의 해도 따로 모아 보여 줌', () => {
    const old = [rec('2025-12', '옛 계좌', 300), rec('2026-11', '옛 계좌', 10)];
    const rv = reviewDraws(row, 2026, old, { firstMonth: 11, nowYear: 2026, nowMonth: 11 });
    expect(rv.accounts.at(-1)).toMatchObject({ name: '옛 계좌', planned: false, actual: 10, limit: null });
    const past = reviewDraws(undefined, 2025, old, { nowYear: 2026, nowMonth: 11 });
    expect(past).toMatchObject({ hasPlan: false, actual: 300, planYear: 0, elapsed: 0 });
    expect(past.accounts.map((a) => a.name)).toEqual(['옛 계좌']);
    expect(drawTotal(old, 2025)).toBe(300);
    expect(drawYears(old)).toEqual([2025, 2026]);
  });

  it('연금 세금 계산: 계좌 인출 + ISA·일반 인출(otherDrawn) = 세전 인출 합계', () => {
    const d = sampleData(2026);
    const base = { type: 'pension' as const, expectedReturn: 0, volatility: 0, purpose: 'long' as const, nature: 'safe' as const, pensionYear1: 2023 };
    const profile = { ...d.profile, birthYear: 1968, retireAge: 58, inflation: 2, spouseBirthYear: 0 };
    const assets = [
      { ...base, name: '연금저축', amount: 4000 },
      { name: 'ISA', type: 'etf' as const, amount: 6000, expectedReturn: 0, volatility: 0, purpose: 'long' as const, nature: 'invest' as const },
    ];
    const sched = [58, 59].map((age) => ({ age, pension: 0, withdrawal: 3000, income: 3000, need: 3000, endBalance: 0, inflow: 0 }));
    const t = pensionTaxSchedule(sched, taxSetup(profile, assets, 2026, 10000, 2)!);
    for (const r of t.rows) {
      const defl = Math.pow(1.02, r.year - 2026);
      expect(r.accounts.reduce((a, x) => a + x.drawn, 0) + r.otherDrawn).toBeCloseTo(r.gross * defl, 6);
      expect(r.otherDrawn).toBeGreaterThan(0);
    }
    // 월별 기록 계획의 ISA·일반 칸은 이 금액
    expect(reviewDraws(t.rows[1], 2027, [], { nowYear: 2026, nowMonth: 11 }).accounts.at(-1)).toMatchObject({ name: OTHER_ACCOUNT, planYear: t.rows[1].otherDrawn });
  });
});

describe('수익률 시나리오별 잔액·목돈 지출 민감도(엑셀: 우물 건강도·민감도)', () => {
  const d = sampleData(2026);
  const profile = { ...d.profile, birthYear: 1968, retireAge: 58, lifeExpectancy: 100, inflation: 2, spouseBirthYear: 0, retireMonthlyExpense: 300, incomes: [], incomeTax: undefined, contrib: undefined };
  const pen = { type: 'pension' as const, expectedReturn: 5, volatility: 8, purpose: 'long' as const, nature: 'invest' as const, pensionYear1: 2020 };
  const assets = [
    { ...pen, name: '연금저축', amount: 40000 },
    { name: 'ISA', type: 'etf' as const, amount: 20000, expectedReturn: 5, volatility: 8, purpose: 'long' as const, nature: 'invest' as const },
  ];
  const s = summarize(profile, assets, [], [], 2026, []);
  const extras = [
    ...Array.from({ length: 20 }, (_, i) => ({ age: 60 + i, amount: 800, flow: true })),
    { age: 62, amount: 3000, loan: '전세대출' },
  ];
  const input = { startAge: 58, endAge: 100, startBalance: 60000, expenseAnnual: 3600, pensions: [{ startAge: 65, annual: 1200 }], meanReturn: 5, volatility: 8, inflation: 2, percentRate: 4, extras, guardrail: DEFAULT_GUARDRAIL };
  const cb = { profile, assets, liabilities: [], goals: [], summary: s, input, strategy: 'fixed' as const, meanReturn: 5 };

  it('기본 시나리오는 화면의 연금 세금 계산과 같고, 수익률이 낮을수록 잔액이 적음', () => {
    const [low, base, high] = returnScenarios(cb, 3, 7);
    expect([low.label, base.label, high.label]).toEqual(['비관', '기본', '낙관']);
    expect([low.meanReturn, base.meanReturn, high.meanReturn]).toEqual([3, 5, 7]);
    const tax = pensionTaxSchedule(compareStrategy('fixed', input, 0).schedule, taxSetup(profile, assets, 2026, 60000, 5, 2026)!);
    expect(base.taxed).toBe(true);
    expect(base.depletedAge).toBe(tax.depletedAge);
    expect(base.totalTax).toBeCloseTo(tax.totalTax, 6);
    expect(balanceAt(base, 80)).toBeCloseTo(tax.rows.find((r) => r.age === 80)!.left, 6);
    expect(base.endBalance).toBeCloseTo(tax.rows.at(-1)!.left, 6);
    for (const age of [70, 80, 90]) {
      expect(balanceAt(low, age)!).toBeLessThanOrEqual(balanceAt(base, age)!);
      expect(balanceAt(base, age)!).toBeLessThanOrEqual(balanceAt(high, age)!);
    }
    const dep = (x: { depletedAge: number | null }) => x.depletedAge ?? Infinity;
    expect(dep(low)).toBeLessThanOrEqual(dep(base));
    expect(dep(base)).toBeLessThanOrEqual(dep(high));
    // 점검 나이는 계획 기간 안의 것만
    expect(checkAges(input)).toEqual([80, 90]);
    expect(checkAges({ startAge: 85, endAge: 105 })).toEqual([90, 100]);
    expect(balanceAt(base, 120)).toBeNull();
  });

  it('연금계좌가 없으면 세금 없이 인출 스케줄 잔액', () => {
    const noPen = { ...cb, assets: [assets[1]] };
    const run = runScenario(noPen);
    const sched = compareStrategy('fixed', input, 0).schedule;
    expect(run.taxed).toBe(false);
    expect(run.totalTax).toBe(0);
    expect(balanceAt(run, 75)).toBeCloseTo(sched.find((r) => r.age === 75)!.endBalance, 6);
  });

  it('목돈 지출 배율: 목표 탭 지출만 바꾸고 대출 원금은 그대로, 바꿀 첫 나이 전은 그대로', () => {
    expect(lumpTotal(extras, 58)).toBe(16000);
    expect(lumpTotal(extras, 70)).toBe(8000);
    const half = scaleLumps(extras, 0.5, 70);
    expect(half.find((e) => e.age === 60)!.amount).toBe(800);
    expect(half.find((e) => e.age === 70)!.amount).toBe(400);
    expect(half.find((e) => e.age === 62 && goalKind(e) === 'loan')!.amount).toBe(3000);
    expect(scaleLiving(input, 0.5)).toEqual({ expenseAnnual: 1800 });
    expect(scaleLiving({ ...input, fixedDraw: 4800 }, 0.5)).toEqual({ fixedDraw: 2400 });
  });

  it('고갈 나이 표: 생활비·목돈이 클수록 빨리 바닥나고, 배율 1·1 칸은 그 수익률의 시나리오와 같음', () => {
    const livings = [0.8, 1, 1.5];
    const lumps = [0, 1, 2];
    const grid = lumpGrid(cb, livings, lumps, 58, 3);
    const dep = (v: number | null) => v ?? Infinity;
    expect(grid[1][1]).toBe(runScenario(cb, { meanReturn: 3 }).depletedAge);
    for (let i = 0; i < 3; i++) for (let j = 1; j < 3; j++) expect(dep(grid[i][j])).toBeLessThanOrEqual(dep(grid[i][j - 1]));
    for (let j = 0; j < 3; j++) for (let i = 1; i < 3; i++) expect(dep(grid[i][j])).toBeLessThanOrEqual(dep(grid[i - 1][j]));
    // 생활비 1.5배 + 목돈 2배는 기대수명 전에 바닥남
    expect(grid[2][2]).not.toBeNull();
  });
});

describe('이미 은퇴해 인출 중일 때의 점검·처방', () => {
  const d = sampleData(2026);
  const profile = { ...d.profile, birthYear: 1966, retireAge: 58, monthlyIncome: 200 };
  const s = summarize(profile, d.assets, d.liabilities, d.cashflows, 2026, d.insurance);
  const pi = buildPlanInput(profile, d.assets, d.liabilities, d.goals, s);

  it('비상금: 소득보다 많은 지출은 계획된 인출이라 ‘몇 개월 뒤 바닥’ 경고·점수 상한을 쓰지 않음', () => {
    expect(s.savings).toBeLessThan(0);
    const target = profile.criteria.emergencyMonths;
    expect(emergencyDetail(s, target)).toContain('바닥납니다');
    expect(emergencyDetail(s, target, true)).not.toContain('바닥납니다');
    expect(emergencyDetail(s, target, true)).toContain('자산 배치 가이드');
    expect(emergencyScore(s, target, true)).toBeGreaterThanOrEqual(emergencyScore(s, target));
    const rich = { ...s, emergencyFund: s.expense * target * 2 };
    expect(emergencyScore(rich, target)).toBeLessThan(1);
    expect(emergencyScore(rich, target, true)).toBe(1);
    expect(emergencyPrescription(rich, target, true)).toBeNull();
    expect(emergencyPrescription(rich, target)).not.toBeNull();
    const poor = emergencyPrescription({ ...s, emergencyFund: 0 }, target, true)!;
    expect(poor.level).toBe('danger');
    expect(poor.title).not.toContain('소진');
    // 점검 목록·점수도 같은 기준
    const checks = riskChecks(profile, d.assets, rich, { rate: 3, age: 60, retired: true });
    expect(checks.find((c) => c.key === 'emergency')!.level).toBe('good');
    const ins = insuranceGap(profile, rich, d.insurance, d.goals);
    expect(financialScore(profile, d.assets, rich, 80, ins, { rate: 3, retired: true }).items.find((i) => i.label === '비상금')!.score).toBe(1);
  });

  it('목표: 월 적립 처방 대신 인출 계획에 들어 있다는 참고 안내', () => {
    const goals: Goal[] = [
      { name: '보유세', category: 'other', targetAge: 61, endAge: 90, amountPV: 500, growthRate: 2 },
      { name: '차량 교체', category: 'car', targetAge: 63, amountPV: 4000, growthRate: 2 },
    ];
    const plans = planGoals(goals, d.assets, s.age);
    const rx = retiredGoalPrescription(plans)!;
    expect(rx).toMatchObject({ area: '목표', level: 'good', badge: '참고' });
    expect(rx.title).toContain('2건');
    expect(rx.detail).toContain('보유세(61~90세');
    expect(rx.detail).toContain('차량 교체(63세');
    expect(retiredGoalPrescription([])).toBeNull();
    const ins = insuranceGap(profile, s, d.insurance, goals);
    const list = prescriptions(profile, s, buildPlanInput(profile, d.assets, d.liabilities, goals, s), 50, plans, ins);
    expect(list.some((r) => r.title.includes('인출 계획에 포함됨'))).toBe(true);
    expect(list.some((r) => r.title.includes('월 적립'))).toBe(false);
    expect(list.some((r) => r.title.includes('따로 모으면'))).toBe(false);
    expect(list.some((r) => r.title.includes('뒤 소진'))).toBe(false);
  });

  it('인출액 고정 방식: 생활비 대신 월 고정 인출액을 낮추는 처방', () => {
    const draw = { ...pi, fixedDraw: 700 * 12, startBalance: 30000, pensions: [], goals: [], debts: [], inflows: undefined };
    const ins = insuranceGap(profile, s, d.insurance, []);
    const list = prescriptions({ ...profile, expenseMode: 'draw', fixedDraw: 700 }, s, draw, simulate(draw, 300).successRate, [], ins);
    const rx = list.find((r) => r.title.startsWith('월 고정 인출액'));
    expect(rx).toBeDefined();
    expect(list.some((r) => r.title.startsWith('은퇴 후 월 생활비'))).toBe(false);
  });

  it('보험료 부담은 납입 중인 보험만: 납입이 끝난 보험은 보장만 남음', () => {
    const base = { death: 0, critical: 0, care: 0 };
    const policies = [
      { ...base, name: '납입 끝난 종신', death: 10000, monthlyPremium: 30, payEndAge: 55 },
      { ...base, name: '납입 중 암', critical: 3000, monthlyPremium: 10, payEndAge: 70 },
    ];
    const ins = insuranceGap(profile, s, policies, []);
    expect(ins.premium).toBe(10);
    expect(ins.people[0].premium).toBe(10);
    expect(ins.people[0].count).toBe(2);
    expect(ins.people[0].lines.find((l) => l.key === 'death')!.current).toBe(10000);
  });
});
