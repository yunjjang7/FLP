import { describe, expect, it } from 'vitest';
import { deterministicPath, expenseRatioAt, incomeValue, pensionAt, type PlanInput } from './montecarlo';
import { SURVIVOR_OVERLAP, survivorCases, survivorIncomes, survivorInput, survivorSteps } from './survivor';

const base: PlanInput = {
  currentAge: 60,
  retireAge: 60,
  lifeExpectancy: 95,
  startBalance: 80000,
  annualSavings: 0,
  meanReturn: 5,
  volatility: 10,
  inflation: 2,
  retireExpenseAnnual: 6000,
  pensions: [
    { name: '국민연금', kind: 'pension', startAge: 64, annual: 2400 },
    { name: '배우자 국민연금', kind: 'pension', startAge: 70, annual: 1200 },
    { name: '개인·퇴직연금', kind: 'pension', startAge: 60, annual: 600 },
    { name: '상가 월세', startAge: 60, annual: 3600 },
  ],
  goals: [],
};
const at = (list: PlanInput['pensions'], age: number) => list.reduce((a, p) => a + incomeValue(p, age, 2), 0);
const opt = { livingRatio: 70, rate: 60, spouseGap: 5 };

describe('배우자 사별 분석', () => {
  it('본인이 먼저: 본인 국민연금·개인연금은 끊기고, 배우자는 자기 연금 전까지 유족연금만 받다가 유리한 쪽을 고름', () => {
    const list = survivorIncomes(base.pensions, { ...opt, dies: 'self', age: 66 });
    // 66~69세: 유족연금 2400 × 60% = 1440 + 월세
    expect(at(list, 66)).toBeCloseTo(1440 + 3600, 6);
    // 70세부터: 배우자 노령 1200 + 유족 30%(432) = 1632 > 유족연금만 1440
    expect(at(list, 70)).toBeCloseTo(1200 + 1440 * SURVIVOR_OVERLAP + 3600, 6);
    expect(at(list, 65)).toBeCloseTo(2400 + 600 + 3600, 6); // 사별 전은 그대로
  });

  it('배우자가 먼저: 본인 노령연금이 크면 노령연금 + 유족연금의 30%', () => {
    const list = survivorIncomes(base.pensions, { ...opt, dies: 'spouse', age: 75 });
    expect(at(list, 74)).toBeCloseTo(2400 + 1200 + 600 + 3600, 6);
    expect(at(list, 75)).toBeCloseTo(2400 + 1200 * 0.6 * SURVIVOR_OVERLAP + 600 + 3600, 6);
  });

  it('유족연금만 받는 편이 크면 자기 노령연금 대신 유족연금', () => {
    const p = [{ name: '국민연금', kind: 'pension' as const, startAge: 64, annual: 3000 }, { name: '배우자 국민연금', kind: 'pension' as const, startAge: 64, annual: 300 }];
    // 배우자: 300 + 1800 × 30% = 840 < 유족연금 1800
    expect(at(survivorIncomes(p, { ...opt, dies: 'self', age: 70 }), 70)).toBeCloseTo(1800, 6);
  });

  it('받기 전에 떠나도 예상 연금액 기준으로 유족연금이 나오고, 인상 조건은 떠난 사람 연금을 따름', () => {
    const p = [{ name: '국민연금', kind: 'pension' as const, startAge: 64, annual: 2400, growth: 2, baseAge: 60 }];
    const list = survivorIncomes(p, { ...opt, dies: 'self', age: 62 });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: '유족연금', startAge: 62, annual: 1440, growth: 2, baseAge: 60 });
  });

  it('혼자가 되는 나이부터 생활비 비율을 곱하고, 이미 있던 나이 구간은 유지', () => {
    const steps = survivorSteps([{ fromAge: 70, ratio: 0.8 }], 75, 0.7);
    expect(expenseRatioAt(steps, 69)).toBe(1);
    expect(expenseRatioAt(steps, 72)).toBeCloseTo(0.8, 9);
    expect(expenseRatioAt(steps, 75)).toBeCloseTo(0.56, 9);
    expect(expenseRatioAt(survivorSteps(undefined, 65, 0.7), 80)).toBeCloseTo(0.7, 9);
  });

  it('본인이 먼저 떠나면 배우자 기대수명까지 계산하고, 사망보험금은 그 해 물가로 환산해 들어옴', () => {
    const next = survivorInput(base, { ...opt, dies: 'self', age: 70, deathBenefit: 10000 });
    expect(next.lifeExpectancy).toBe(100); // 배우자가 5살 어림
    expect(next.inflows).toEqual([{ name: '사망보험금', age: 70, amount: 10000 / Math.pow(1.02, 10) }]);
    expect(survivorInput(base, { ...opt, dies: 'spouse', age: 70 }).lifeExpectancy).toBe(95);
    // 인출액 고정 방식은 생활비 구간을 건드리지 않음
    expect(survivorInput({ ...base, fixedDraw: 5000 }, { ...opt, dies: 'self', age: 70 }).expenseSteps).toBeUndefined();
  });

  it('경우 목록: 지난 나이는 빼고 사별 다음 해 소득 변화를 함께 돌려줌', () => {
    const cases = survivorCases({ ...base, currentAge: 66 }, opt, { self: 0, spouse: 0 });
    expect(cases.map((c) => c.key)).toEqual(['self-75', 'self-85', 'spouse-75', 'spouse-85']);
    const c = cases[0];
    expect(c.label).toBe('본인이 75세에 먼저');
    expect(c.incomeBefore).toBeCloseTo(pensionAt(base, 76), 6);
    expect(c.incomeAfter).toBeCloseTo(1200 + 1440 * SURVIVOR_OVERLAP + 3600, 6);
    // 생활비가 30% 줄어도 끊기는 연금이 더 크면 자산이 더 빨리 줄어듦
    const alone = deterministicPath(survivorInput({ ...base, currentAge: 66 }, { ...opt, livingRatio: 100, dies: 'self', age: 75 }));
    const both = deterministicPath({ ...base, currentAge: 66, lifeExpectancy: 100 });
    expect(alone.balances[alone.balances.length - 1]).toBeLessThan(both.balances[both.balances.length - 1]);
  });
  it('사별 계획에는 누가 몇 세에 떠나는지 남겨 연금 인출 세금에서 계좌를 승계', () => {
    const c = survivorCases(base, { livingRatio: 70, rate: 60, spouseGap: 3 }, { self: 0, spouse: 0 })[0];
    expect(c.input.death).toEqual({ who: c.dies, age: c.age });
  });

  it('사망보장: 떠난 사람 보험금 금액과 보험금 없이 돌린 계획을 함께 돌려줌', () => {
    const cases = survivorCases(base, opt, { self: 20000, spouse: 0 });
    const self = cases.find((c) => c.key === 'self-75')!;
    expect(self.benefit).toBe(20000);
    expect(self.input.inflows?.some((f) => f.name === '사망보험금')).toBe(true);
    expect(self.noBenefit).toBeDefined();
    expect(self.noBenefit!.inflows ?? []).toEqual([]);
    // 보험금 외에는 같은 사별 계획
    expect(self.noBenefit!.pensions).toEqual(self.input.pensions);
    expect(self.noBenefit!.lifeExpectancy).toBe(self.input.lifeExpectancy);
    // 보험금이 있으면 평균 수익 경로의 마지막 잔액이 더 큼
    const withB = deterministicPath(self.input), noB = deterministicPath(self.noBenefit!);
    expect(withB.balances[withB.balances.length - 1]).toBeGreaterThan(noB.balances[noB.balances.length - 1]);
    // 배우자 쪽은 사망보장이 없어 비교 계획도 없음
    const sp = cases.find((c) => c.key === 'spouse-75')!;
    expect(sp.benefit).toBe(0);
    expect(sp.noBenefit).toBeUndefined();
  });
});
