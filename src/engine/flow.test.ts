import { describe, expect, it } from 'vitest';
import { yearFlow } from './flow';
import type { PlanInput } from './montecarlo';

// 40세, 60세 은퇴: 국민연금 65세부터 1,200, 대출 72세까지 연 600, 70세 목표 지출 500·보험료 100
const input: PlanInput = {
  currentAge: 40, retireAge: 60, lifeExpectancy: 90, startBalance: 10000, annualSavings: 1200,
  meanReturn: 5, volatility: 10, inflation: 2, retireExpenseAnnual: 3000,
  pensions: [{ name: '국민연금', startAge: 65, annual: 1200 }],
  goals: [{ age: 70, amount: 500 }, { age: 70, amount: 100, premium: '실손' }, { age: 71, amount: 300, npTax: true }],
  debts: [{ endAge: 72, annual: 600 }],
};

const sum = (list: { amount: number }[]) => list.reduce((a, x) => a + x.amount, 0);
const keys = (list: { key: string }[]) => list.map((x) => x.key);
const balanced = (f: ReturnType<typeof yearFlow>) => {
  expect(sum(f.sources)).toBeCloseTo(sum(f.uses), 6);
  expect(f.total).toBeCloseTo(sum(f.sources), 6);
};

describe('연간 현금흐름 흐름도', () => {
  it('은퇴 후: 소득 줄 + 모자라면 금융자산에서 인출, 생활비·대출·목표 종류별', () => {
    const f = yearFlow(input, 70, 0);
    expect(f.retired).toBe(true);
    expect(f.age).toBe(70);
    expect(f.sources).toEqual([
      { key: 'inc-0', label: '국민연금', amount: 1200, tone: 'income' },
      { key: 'draw', label: '금융자산에서 인출', amount: 3000, tone: 'draw' },
    ]);
    expect(f.uses).toEqual([
      { key: 'living', label: '생활비', amount: 3000, tone: 'living' },
      { key: 'debt', label: '대출 상환', amount: 600, tone: 'debt' },
      { key: 'goal-goal', label: '목표 탭 지출', amount: 500, tone: 'goal' },
      { key: 'goal-premium', label: '은퇴 후 보험료', amount: 100, tone: 'premium' },
    ]);
    expect(f.total).toBeCloseTo(4200, 6);
    balanced(f);
    // 국민연금 몫 세금·건보료는 세금 색
    expect(yearFlow(input, 71, 0).uses.find((x) => x.key === 'goal-npTax')).toMatchObject({ amount: 300, tone: 'tax' });
  });

  it('은퇴 직후 연금이 없으면 지출 전부를 금융자산에서 인출, 은퇴 전 소득은 쓰지 않음', () => {
    const f = yearFlow(input, 60, 9999);
    expect(f.retired).toBe(true);
    expect(keys(f.sources)).toEqual(['draw']);
    expect(f.sources[0].amount).toBeCloseTo(3600, 6);
    expect(keys(f.uses)).toEqual(['living', 'debt']);
    balanced(f);
    // 대출이 끝난 뒤에는 대출 줄이 없음
    expect(keys(yearFlow(input, 72, 0).uses)).toEqual(['living']);
  });

  it('은퇴 전: 세후 소득 → 생활 지출(소득 − 대출 − 저축)·저축·대출', () => {
    const f = yearFlow(input, 50, 6000);
    expect(f.retired).toBe(false);
    expect(f.sources).toEqual([{ key: 'income', label: '세후 소득', amount: 6000, tone: 'income' }]);
    expect(f.uses).toEqual([
      { key: 'living', label: '생활 지출(보험료 포함)', amount: 4200, tone: 'living' },
      { key: 'save', label: '저축·투자', amount: 1200, tone: 'save' },
      { key: 'debt', label: '대출 상환', amount: 600, tone: 'debt' },
    ]);
    expect(f.total).toBe(6000);
    balanced(f);
  });

  it('은퇴 전 소득이 저축·대출보다 적으면 생활 지출 0, 모자란 만큼 금융자산에서 인출', () => {
    const f = yearFlow(input, 50, 1000);
    expect(keys(f.uses)).toEqual(['save', 'debt']);
    expect(f.sources.find((x) => x.key === 'draw')?.amount).toBeCloseTo(800, 6);
    balanced(f);
  });

  it('일시금이 들어와 남는 해: 남는 돈은 금융자산에 더함', () => {
    const inp: PlanInput = {
      ...input,
      inflows: [
        { name: '오피스텔', age: 50, amount: 2000, kind: 'sale' },
        { age: 75, amount: 10000 },
        { age: 75, amount: 300, kind: 'credit' },
        { name: '노란우산', age: 76, amount: 0 },
      ],
    };
    const pre = yearFlow(inp, 50, 6000);
    expect(pre.sources.find((x) => x.key === 'in-0')).toEqual({ key: 'in-0', label: '오피스텔 매각', amount: 2000, tone: 'lump' });
    expect(pre.uses.find((x) => x.key === 'keep')).toEqual({ key: 'keep', label: '금융자산에 더함', amount: 2000, tone: 'save' });
    expect(pre.total).toBe(8000);
    balanced(pre);

    const post = yearFlow(inp, 75, 0);
    expect(post.sources.map((x) => x.label)).toEqual(['국민연금', '일시금 수령', '세액공제 환급']);
    expect(keys(post.sources)).not.toContain('draw');
    expect(post.uses.find((x) => x.key === 'keep')?.amount).toBeCloseTo(1200 + 10000 + 300 - 3000, 6);
    balanced(post);
    // 금액이 0인 유입은 넣지 않음
    expect(keys(yearFlow(inp, 76, 0).sources)).toEqual(['inc-0', 'draw']);
  });

  it('어느 나이든 들어오는 돈 합계 = 나가는 돈 합계 = total', () => {
    const inp: PlanInput = { ...input, inflows: [{ age: 66, amount: 5000, kind: 'sale' }] };
    for (let age = 40; age <= 90; age++) {
      const f = yearFlow(inp, age, 5000);
      balanced(f);
      expect(f.total).toBeGreaterThan(0);
      expect(f.sources.every((x) => x.amount > 0) && f.uses.every((x) => x.amount > 0)).toBe(true);
    }
  });
});
