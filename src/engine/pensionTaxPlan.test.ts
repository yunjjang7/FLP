import { describe, expect, it } from 'vitest';
import { sampleData } from '../db/sample';
import { buildPlanInput } from './goals';
import { deterministicPath, goalBreakdownAt, simulate, withdrawStart } from './montecarlo';
import { withdrawInputOf, withPensionTax } from './pensionTaxPlan';
import { summarize } from './portfolio';
import { pensionTaxSchedule, taxSetup } from './tax';
import { compareStrategy } from './withdrawal';

describe('노후 진단에 연금 인출 세금 반영', () => {
  // 이미 은퇴해 인출 중인 사람(연금계좌에서 바로 꺼냄)
  const d = sampleData(2026);
  const profile = { ...d.profile, birthYear: 1966, retireAge: 58 };
  const s = summarize(profile, d.assets, d.liabilities, d.cashflows, 2026, d.insurance);
  const base = buildPlanInput(profile, d.assets, d.liabilities, d.goals, s);
  const nowYear = profile.birthYear + s.age;
  const taxed = withPensionTax(profile, d.assets, base, nowYear);
  const taxes = taxed.goals.filter((g) => g.pensionTax);

  it('인출 계획과 같은 세금을 나이별 지출로 더함', () => {
    expect(taxes.length).toBeGreaterThan(0);
    const start = withdrawStart(base);
    const wi = withdrawInputOf(base, start, { endAge: profile.lifeExpectancy, inflation: profile.inflation, startBalance: start.balance });
    const setup = taxSetup(profile, d.assets, nowYear, wi.startBalance, wi.meanReturn, profile.birthYear + start.age)!;
    const rows = pensionTaxSchedule(compareStrategy('guardrail', wi, 0).schedule, setup).rows;
    const total = rows.reduce((a, r) => a + r.tax, 0);
    expect(taxes.reduce((a, g) => a + g.amount, 0)).toBeCloseTo(total, 6);
    expect(goalBreakdownAt(taxed, taxes[0].age).pensionTax).toBeCloseTo(taxes[0].amount, 6);
  });
  it('세금을 넣으면 성공확률·잔액이 좋아지지 않음', () => {
    expect(simulate(taxed, 300).successRate).toBeLessThanOrEqual(simulate(base, 300).successRate);
    const a = deterministicPath(taxed).balances;
    const b = deterministicPath(base).balances;
    expect(a[a.length - 1]).toBeLessThanOrEqual(b[b.length - 1]);
  });
  it('두 번 적용해도 세금이 겹치지 않고, 인출 계획 입력에는 세금 지출을 넣지 않음', () => {
    const twice = withPensionTax(profile, d.assets, taxed, nowYear);
    expect(twice.goals.filter((g) => g.pensionTax).length).toBe(taxes.length);
    const wi = withdrawInputOf(taxed, withdrawStart(taxed), { endAge: profile.lifeExpectancy, inflation: profile.inflation, startBalance: 1000 });
    expect(wi.extras!.length).toBe(base.goals.filter((g) => g.age >= wi.startAge).length);
  });
  it('연금계좌가 없으면 그대로', () => {
    const noPen = d.assets.filter((a) => a.type !== 'pension');
    const inp = buildPlanInput(profile, noPen, d.liabilities, d.goals, s);
    expect(withPensionTax(profile, noPen, inp, nowYear).goals).toEqual(inp.goals);
  });
});
