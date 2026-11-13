import { describe, expect, it } from 'vitest';
import { sampleData } from '../db/sample';
import { buildPlanInput } from './goals';
import { deterministicPath, goalBreakdownAt, simulate, withdrawStart } from './montecarlo';
import { makePathTax, makeRetax, pensionTaxTotal, withdrawInputOf, withPensionTax } from './pensionTaxPlan';
import { stressCases } from './stress';
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
  it('설정이 아니오면 세금 지출을 빼고 돌려줌(엑셀과 같은 기준)', () => {
    const off = withPensionTax({ ...profile, planPensionTax: false }, d.assets, taxed, nowYear);
    expect(off.goals.some((g) => g.pensionTax)).toBe(false);
    expect(off.goals).toEqual(base.goals);
  });
  it('바꾼 계획(생활비·수익률·물가·기대수명)마다 세금을 다시 계산', () => {
    const retax = makeRetax(profile, d.assets, nowYear);
    const more = pensionTaxTotal(retax({ ...taxed, retireExpenseAnnual: taxed.retireExpenseAnnual * 1.3 })).total;
    const now = pensionTaxTotal(taxed).total;
    expect(more).toBeGreaterThan(now);
    // 고물가 스트레스: 바뀐 물가로 세금도 달라짐
    const infl = stressCases(taxed).find((c) => c.key === 'inflation')!;
    expect(pensionTaxTotal(retax(infl.input)).total).not.toBeCloseTo(now, 3);
  });
  it('세금 다시 계산은 시뮬레이션보다 훨씬 빠름(민감도 표 72칸이 느려지지 않음)', () => {
    const retax = makeRetax(profile, d.assets, nowYear);
    let t0 = performance.now();
    for (let i = 0; i < 72; i++) retax({ ...taxed, retireExpenseAnnual: taxed.retireExpenseAnnual + i });
    const taxMs = performance.now() - t0;
    t0 = performance.now();
    for (let i = 0; i < 5; i++) simulate(taxed, 300, 7);
    const simMs = ((performance.now() - t0) / 5) * 72;
    console.log(`세금 다시 계산 72칸 ${taxMs.toFixed(0)}ms, 시뮬레이션 300회 72칸 ${simMs.toFixed(0)}ms`);
    expect(taxMs).toBeLessThan(simMs / 2);
  });
  describe('몬테카를로 경로별 세금', () => {
    const pathTax = makePathTax(profile, d.assets, taxed, nowYear)!;
    it('평균 수익만 나는 경로면 평균 경로 세금과 같음', () => {
      const flat = Math.pow(1 + taxed.retireMeanReturn! / 100, 1) / (1 + taxed.inflation / 100);
      const avg = taxes.reduce((a, g) => a + g.amount, 0);
      // 첫해 짧은 기간(firstYearShare)만 복리 방식이 조금 달라 1% 안쪽 차이
      const got = pathTax((age) => (age === taxed.currentAge ? Math.pow(flat, taxed.firstYearShare ?? 1) : flat)).reduce((a, g) => a + g.amount, 0);
      expect(Math.abs(got - avg) / avg).toBeLessThan(0.01);
    });
    it('수익이 나쁘면 세금이 줄고 좋으면 늘어남(운용수익 = 과세재원)', () => {
      const sum = (g: number) => pathTax(() => g).reduce((a, x) => a + x.amount, 0);
      expect(sum(0.98)).toBeLessThan(sum(1.02));
      expect(sum(1.02)).toBeLessThan(sum(1.06));
    });
    it('경로별 세금 시뮬레이션은 같은 시장 경로를 쓰고, 세금 반영을 끄면 만들지 않음', () => {
      // 세금을 0으로 돌려주면 세금 없는 계획과 똑같음 → 난수 순서가 같다는 뜻
      expect(simulate(taxed, 300, 42, () => []).successRate).toBe(simulate(base, 300).successRate);
      expect(simulate(taxed, 300, 42, () => []).p50).toEqual(simulate(base, 300).p50);
      expect(makePathTax({ ...profile, planPensionTax: false }, d.assets, taxed, nowYear)).toBeUndefined();
    });
  });
  it('사별: 떠난 사람 연금계좌를 남은 사람이 승계해 남은 사람의 1,500만 한도 하나로 계산', () => {
    const st = withdrawStart(base);
    const wi = withdrawInputOf(base, st, { endAge: profile.lifeExpectancy, inflation: profile.inflation, startBalance: st.balance });
    const setup = taxSetup(profile, d.assets, nowYear, wi.startBalance, wi.meanReturn, profile.birthYear + st.age)!;
    const year = profile.birthYear + st.age + 3;
    const sched = compareStrategy('guardrail', wi, 0).schedule;
    const before = pensionTaxSchedule(sched, setup).rows;
    expect(before.some((r) => r.accounts.some((a) => a.owner === 'self'))).toBe(true);
    const rows = pensionTaxSchedule(sched, { ...setup, death: { owner: 'self', year } }).rows;
    for (const r of rows.filter((x) => x.year >= year)) {
      expect(r.slot.self).toBe(0);
      expect(r.accounts.every((a) => a.owner === 'spouse')).toBe(true);
    }
    // 사별 전 해는 그대로
    expect(rows.filter((x) => x.year < year)).toEqual(before.filter((x) => x.year < year));
  });
});
