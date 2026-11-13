import { describe, expect, it } from 'vitest';
import { yearFlow } from './flow';
import { deterministicPath, type PlanInput } from './montecarlo';

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

  // 예전에는 모자란 800을 ‘금융자산에서 인출’로 그리고 저축 1,200도 함께 그려 꺼내서 다시 저축하는 모양이었음.
  // 시뮬레이션(runPath)은 은퇴 전 소득을 보지 않고 저축 1,200을 그대로 더하므로, 인출이 아니라 ‘소득 초과 저축’으로 표시해 순증감을 엔진과 맞춤
  it('은퇴 전 소득이 저축·대출보다 적으면 생활 지출 0, 모자란 몫은 소득 초과 저축으로(인출과 저축이 함께 나오지 않음)', () => {
    const f = yearFlow(input, 50, 1000);
    expect(keys(f.sources)).toEqual(['income', 'short']);
    expect(f.sources[1]).toMatchObject({ label: '소득 초과 저축', amount: 800, tone: 'short' });
    expect(keys(f.uses)).toEqual(['save', 'debt']);
    expect(f.uses[0].amount).toBeCloseTo(1200, 6);
    balanced(f);
  });

  it('은퇴 전 소득 < 대출+저축이고 목표 지출이 저축보다 크면 순인출만 나오고 저축 줄은 없음', () => {
    const inp: PlanInput = { ...input, goals: [...input.goals, { age: 50, amount: 3000 }] };
    const f = yearFlow(inp, 50, 1000);
    expect(keys(f.sources)).toEqual(['income', 'short', 'draw']);
    expect(f.sources[2].amount).toBeCloseTo(3000 - 1200, 6); // 목표 3,000 − 저축 1,200
    expect(keys(f.uses)).toEqual(['debt', 'goal-goal']);
    expect(f.total).toBeCloseTo(3600, 6);
    balanced(f);
  });

  it('은퇴 전 소득이 충분하고 목표 지출이 있는 해: 인출과 저축을 상계해 순액만', () => {
    // 저축 1,200 · 목표 500 → 저축 줄 700, 인출 없음
    const small: PlanInput = { ...input, goals: [{ age: 50, amount: 500 }] };
    const a = yearFlow(small, 50, 6000);
    expect(keys(a.sources)).toEqual(['income']);
    expect(a.uses.find((x) => x.key === 'save')?.amount).toBeCloseTo(700, 6);
    expect(a.uses.find((x) => x.key === 'living')?.amount).toBeCloseTo(4200, 6);
    balanced(a);
    // 저축 1,200 · 목표 3,000 → 인출 1,800, 저축 줄 없음
    const big: PlanInput = { ...input, goals: [{ age: 50, amount: 3000 }] };
    const b = yearFlow(big, 50, 6000);
    expect(b.sources.find((x) => x.key === 'draw')?.amount).toBeCloseTo(1800, 6);
    expect(keys(b.uses)).toEqual(['living', 'debt', 'goal-goal']);
    balanced(b);
  });

  it('경계: 소득 = 대출 + 저축이면 생활 지출 0, 소득 초과 저축·인출 없이 저축·대출만', () => {
    const f = yearFlow(input, 50, 1800);
    expect(keys(f.sources)).toEqual(['income']);
    expect(f.uses).toEqual([
      { key: 'save', label: '저축·투자', amount: 1200, tone: 'save' },
      { key: 'debt', label: '대출 상환', amount: 600, tone: 'debt' },
    ]);
    expect(f.total).toBe(1800);
    balanced(f);
  });

  it('저축 여력이 마이너스면 저축 줄 없이 부족분을 인출, 생활 지출은 소득 − 대출 + 부족분', () => {
    const f = yearFlow({ ...input, annualSavings: -1200 }, 50, 6000);
    expect(keys(f.sources)).toEqual(['income', 'draw']);
    expect(f.sources[1].amount).toBeCloseTo(1200, 6);
    expect(keys(f.uses)).toEqual(['living', 'debt']);
    expect(f.uses[0].amount).toBeCloseTo(6600, 6);
    balanced(f);
  });

  it('은퇴 전 금융자산 순증감(저축·더함 − 인출)은 시뮬레이션의 수익 전 잔액 변화와 같음', () => {
    const inp: PlanInput = {
      ...input, meanReturn: 0, volatility: 0, inflation: 0,
      goals: [{ age: 45, amount: 3000 }, { age: 47, amount: 800 }],
      inflows: [{ age: 46, amount: 2000, kind: 'sale' }],
      debts: [{ endAge: 48, annual: 600 }],
    };
    const bal = deterministicPath(inp).balances;
    for (const income of [6000, 1500, 500]) {
      for (let age = inp.currentAge; age < inp.retireAge; age++) {
        const f = yearFlow(inp, age, income);
        const net = f.uses.filter((x) => x.tone === 'save').reduce((a, x) => a + x.amount, 0) - (f.sources.find((x) => x.key === 'draw')?.amount ?? 0);
        expect(net).toBeCloseTo(bal[age - inp.currentAge + 1] - bal[age - inp.currentAge], 6);
        expect(keys(f.sources).includes('draw') && f.uses.some((x) => x.tone === 'save')).toBe(false);
        balanced(f);
      }
    }
  });

  it('배우자가 먼저 은퇴하면 그 해부터 소득에서 배우자 몫을 빼 생활 지출이 은퇴 전후로 이어짐', () => {
    // 가구 소득 6,000 중 배우자 1,800, 본인 52세에 배우자 은퇴 → 엔진은 52세부터 저축을 1,800 줄임(buildPlanInput 의 savingsChanges)
    const sw = { annual: 1800, fromAge: 52 };
    const inp: PlanInput = { ...input, savingsChanges: [{ fromAge: 52, annual: -1800, name: '배우자 은퇴' }] };
    const before = yearFlow(inp, 51, 6000, sw);
    const after = yearFlow(inp, 52, 6000, sw);
    expect(before.sources).toEqual([
      { key: 'income', label: '본인 세후 소득', amount: 4200, tone: 'income' },
      { key: 'income-spouse', label: '배우자 세후 소득', amount: 1800, tone: 'income' },
    ]);
    expect(after.sources.filter((x) => x.tone === 'income')).toEqual([{ key: 'income', label: '본인 세후 소득', amount: 4200, tone: 'income' }]);
    const living = (f: ReturnType<typeof yearFlow>) => f.uses.find((x) => x.key === 'living')?.amount;
    expect(living(before)).toBeCloseTo(4200, 6); // 6,000 − 대출 600 − 저축 1,200
    expect(living(after)).toBeCloseTo(living(before)!, 6); // 예전에는 소득을 6,000 그대로 둬 6,000으로 부풀었음
    expect(after.uses.find((x) => x.key === 'save')).toBeUndefined(); // 저축 1,200 − 1,800 = −600 → 저축 줄 없이 부족분 600 인출
    expect(after.sources.find((x) => x.key === 'draw')?.amount).toBeCloseTo(600, 6);
    balanced(before);
    balanced(after);
    // 금융자산 순증감은 그대로 엔진과 같음
    const flat: PlanInput = { ...inp, meanReturn: 0, volatility: 0, inflation: 0 };
    const bal = deterministicPath(flat).balances;
    for (let age = flat.currentAge; age < flat.retireAge; age++) {
      const f = yearFlow(flat, age, 6000, sw);
      const net = f.uses.filter((x) => x.tone === 'save').reduce((a, x) => a + x.amount, 0) - (f.sources.find((x) => x.key === 'draw')?.amount ?? 0);
      expect(net).toBeCloseTo(bal[age - flat.currentAge + 1] - bal[age - flat.currentAge], 6);
      balanced(f);
    }
  });

  it('배우자 소득이 없거나 0이면 기존처럼 세후 소득 한 줄', () => {
    for (const sw of [undefined, { annual: 0, fromAge: 45 }]) {
      for (let age = 40; age <= 90; age++) expect(yearFlow(input, age, 6000, sw)).toEqual(yearFlow(input, age, 6000));
    }
    expect(yearFlow(input, 50, 6000, { annual: 0, fromAge: 45 }).sources).toEqual([{ key: 'income', label: '세후 소득', amount: 6000, tone: 'income' }]);
    // 배우자가 본인 은퇴 뒤에 은퇴하면 은퇴 전 소득 합계는 그대로(본인·배우자 줄로만 나눔)
    const f = yearFlow(input, 59, 6000, { annual: 1800, fromAge: 63 });
    expect(sum(f.sources)).toBe(6000);
    expect(f.uses).toEqual(yearFlow(input, 59, 6000).uses);
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
