import { describe, expect, it } from 'vitest';
import { sampleData } from '../db/sample';
import { buildPlanInput, planGoals } from './goals';
import { insuranceGap } from './insurance';
import { deterministicPath, retirementNeed, simulate, withdrawStart } from './montecarlo';
import { summarize } from './portfolio';
import { prescriptions } from './prescribe';
import { buildReport, depletionText, depletionWithReturn, livingText } from './report';
import { bulletChecks, retiredBasis, riskChecks } from './risk';

describe('요약 보고서', () => {
  const d = sampleData(2026);
  const loans = [...d.liabilities, { name: '지인 대출', balance: 30000, rate: 4, monthlyPayment: 100, endAge: 0, repay: 'bullet' as const }];
  const s = summarize(d.profile, d.assets, loans, d.cashflows, 2026, d.insurance);
  const inp = buildPlanInput(d.profile, d.assets, loans, d.goals, s);
  const sim = simulate(inp, 200);
  const start = withdrawStart(inp);
  const basis = retiredBasis(s, inp);
  const ins = insuranceGap(d.profile, basis, d.insurance, d.goals);
  const goalPlans = planGoals(d.goals, d.assets, s.age);
  const checks = [...bulletChecks(loans, s.age), ...riskChecks(d.profile, d.assets, basis, start)];
  const rx = prescriptions(d.profile, basis, inp, sim.successRate, goalPlans, ins);
  const report = buildReport({ profile: d.profile, summary: s, planInput: inp, sim, start, need: retirementNeed(inp), liabilities: loans, goals: d.goals, checks, rx, nowYear: 2026 });
  const all = report.flatMap((x) => x.lines.map((l) => l.text)).join('\n');

  it('여섯 부분을 문장으로 채움', () => {
    expect(report.map((x) => x.title)).toEqual(['1. 한눈에 보는 결론', '2. 자산과 부채', '3. 노후 소득과 따로 나가는 돈', '4. 점검이 필요한 항목', '5. 권장 대응', '6. 가정과 한계']);
    for (const sec of report) expect(sec.lines.length).toBeGreaterThan(0);
    expect(all).toContain(`성공확률은 ${Math.round(sim.successRate)}%`);
  });
  it('고갈 나이는 노후 진단과 같은 평균 수익 경로', () => {
    expect(all).toContain(depletionText(deterministicPath(inp).depletedAt, d.profile.lifeExpectancy));
    expect(depletionText(null, 100)).toBe('100세까지 유지');
    expect(depletionText(84, 100)).toBe('84세에 고갈');
  });
  it('수익률이 낮으면 고갈이 늦어지지 않음', () => {
    const lo = depletionWithReturn(inp, -2) ?? Infinity;
    const hi = depletionWithReturn(inp, 2) ?? Infinity;
    expect(lo).toBeLessThanOrEqual(hi);
  });
  it('만기 미정 대출은 이자만 계속 내는 것으로 설명하고, 점검과 처방에 같은 문장을 두 번 쓰지 않음', () => {
    expect(all).toContain('지인 대출: 잔액 3억원, 금리 4%, 월 100만원 · 만기 미정, 이자만 계속 내는 것으로 계산');
    expect(all.split('지인 대출 만기 나이 입력 필요').length - 1).toBe(1);
  });
  it('생활비 문장: 방식별', () => {
    expect(livingText({ ...d.profile, expenseMode: 'draw', fixedDraw: 450, drawIncludes: ['premium'] })).toContain('월 450만원을 금액 그대로');
    expect(livingText({ ...d.profile, expenseMode: 'draw', fixedDraw: 450, drawIncludes: ['premium'] })).toContain('보험료도 이 금액 안에서 냅니다');
    expect(livingText({ ...d.profile, expenseMode: 'real' })).toContain('물가만큼 올라');
  });
});
