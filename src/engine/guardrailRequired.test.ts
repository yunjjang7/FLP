import { describe, expect, it } from 'vitest';
import type { PlanBase } from '../types';
import { baseBalanceAt, baseFloorAt, baseRequiredAt, compareStrategy, DEFAULT_GUARDRAIL, guardrailBaseline, nextGuardrail, requiredBalances, reviewYearEnds, type WithdrawInput } from './withdrawal';

const g = DEFAULT_GUARDRAIL; // ±15%, 10% 감액·증액, 감액만

describe('가드레일 필요 자산 보정: nextGuardrail', () => {
  it('필요 자산을 주지 않으면 예전과 같음: 하단선 아래면 감액, 사이면 그대로', () => {
    expect(nextGuardrail(1, 8000, 10000, g)).toBeCloseTo(0.9, 9); // 8000 < 8500
    expect(nextGuardrail(0.9, 9000, 10000, g)).toBe(0.9); // 하단선과 상단선 사이
    expect(nextGuardrail(0.9, 12000, 10000, g)).toBeCloseTo(0.99, 9); // 상단선 위 → 되돌림
    expect(nextGuardrail(1, 12000, 10000, g)).toBe(1); // 감액만: 계획보다 늘리지 않음
    expect(nextGuardrail(0.7, 1000, 10000, g)).toBe(0.7); // 최저 배율
  });

  it('감액 판정선은 기준선과 필요 자산 중 낮은 쪽', () => {
    // 기준선 하단선(8500)보다 낮아도 필요 자산 하단선(6000 × 0.85 = 5100)보다 높으면 줄이지 않음
    expect(nextGuardrail(1, 8000, 10000, g, 6000)).toBe(1);
    expect(nextGuardrail(1, 5000, 10000, g, 6000)).toBeCloseTo(0.9, 9);
    // 필요 자산이 기준선보다 크면 기준선으로 판정(예전과 같음)
    expect(nextGuardrail(1, 8000, 10000, g, 20000)).toBeCloseTo(0.9, 9);
    // 필요 자산 0(음수는 0으로 봄)이면 줄이지 않음
    expect(nextGuardrail(1, 100, 10000, g, 0)).toBe(1);
    expect(nextGuardrail(1, 100, 10000, g, -500)).toBe(1);
  });

  it('줄였던 배율은 낮은 판정선의 상단선만 넘어도 되돌리되 1까지만', () => {
    // 필요 자산 6000의 상단선 6900을 넘음(기준선 상단선 11500 아래)
    expect(nextGuardrail(0.9, 9000, 10000, g, 6000)).toBeCloseTo(0.99, 9);
    expect(nextGuardrail(0.95, 9000, 10000, g, 6000)).toBe(1);
    // 필요 자산 없이는 같은 자산에서 그대로
    expect(nextGuardrail(0.9, 9000, 10000, g)).toBe(0.9);
    // 상단선 아래(6900 이하)면 그대로
    expect(nextGuardrail(0.9, 6500, 10000, g, 6000)).toBe(0.9);
    // 줄이지 않은 배율(1)은 늘리지 않음
    expect(nextGuardrail(1, 9000, 10000, g, 6000)).toBe(1);
    // 감액·증액 방식이면 기준선 상단선 위에서는 1을 넘어 늘릴 수 있음(필요 자산 상단선만으로는 1까지만)
    const both = { ...g, cutOnly: false };
    expect(nextGuardrail(1, 12000, 10000, both, 6000)).toBeCloseTo(1.1, 9);
    expect(nextGuardrail(0.95, 9000, 10000, both, 6000)).toBe(1);
  });
});

const flat: WithdrawInput = { startAge: 60, endAge: 63, startBalance: 10000, expenseAnnual: 1000, pensions: [], meanReturn: 2, volatility: 10, inflation: 2, percentRate: 4 };

describe('필요 자산: requiredBalances', () => {
  it('실질수익 0%면 남은 해의 인출 합, 마지막 원소는 0', () => {
    expect(requiredBalances(flat)).toEqual([3000, 2000, 1000, 0]);
  });

  it('평균 수익(실질)으로 할인', () => {
    const r = 1.05 / 1.02 - 1;
    const req = requiredBalances({ ...flat, meanReturn: 5 });
    expect(req).toHaveLength(4);
    expect(req[3]).toBe(0);
    expect(req[2]).toBeCloseTo(1000, 9);
    expect(req[1]).toBeCloseTo(1000 + 1000 / (1 + r), 9);
    expect(req[0]).toBeCloseTo(1000 + req[1] / (1 + r), 9);
  });

  it('연금은 빼고, 남은 대출 상환·목적자금은 더함', () => {
    const req = requiredBalances({ ...flat, pensions: [{ startAge: 62, annual: 400 }], debts: [{ endAge: 61, annual: 300 }], extras: [{ age: 61, amount: 500 }] });
    expect(req).toEqual([1300 + 1500 + 600, 1500 + 600, 600, 0]);
  });

  it('뒤에 들어올 유입은 그 해부터의 필요액에서 빼되 그 전 해 인출은 그대로 필요', () => {
    // 62세에 5000이 들어오면 62세 이후는 0, 그 전 두 해(60·61세) 인출은 그대로
    expect(requiredBalances({ ...flat, inflows: [{ age: 62, amount: 5000 }] })).toEqual([2000, 1000, 0, 0]);
    // 61세 유입 1500: 61세 필요액 1000 + 62세 1000 − 1500 = 500
    expect(requiredBalances({ ...flat, inflows: [{ age: 61, amount: 1500 }] })).toEqual([1500, 500, 1000, 0]);
  });

  it('필요 자산으로 시작해 평균 수익이 나면 해마다 연초 자산 = 필요 자산, 끝에 0', () => {
    const inp = { ...flat, endAge: 70, meanReturn: 5, inflows: [{ age: 66, amount: 2000 }] };
    const req = requiredBalances(inp);
    const b = guardrailBaseline({ ...inp, startBalance: req[0] });
    b.balances.forEach((x, i) => expect(x).toBeCloseTo(req[i], 6));
    expect(b.balances[b.balances.length - 1]).toBeCloseTo(0, 6);
  });

  it('guardrailBaseline 이 필요 자산을 함께 돌려줌', () => {
    const inp = { ...flat, inflows: [{ age: 62, amount: 5000 }] };
    const b = guardrailBaseline(inp);
    expect(b.required).toEqual(requiredBalances(inp));
    expect(b.required).toHaveLength(b.balances.length);
  });
});

describe('연말결산 기준선의 필요 자산', () => {
  const pb: PlanBase = { savedAt: '2026-01-05', year: 2026, month: 1, inflation: 0, balances: [10000, 9000, 8000, 7000], withdrawals: [1000, 1000, 1000] };
  const withReq: PlanBase = { ...pb, required: [5000, 4000, 3000, 0] };

  it('예전에 고정해 필요 자산이 없는 기준선: baseRequiredAt 은 undefined, 판정선은 기준선', () => {
    expect(baseRequiredAt(pb, 1)).toBeUndefined();
    expect(baseRequiredAt({ ...pb, required: [] }, 1)).toBeUndefined();
    expect(baseFloorAt(pb, 1.5)).toBeCloseTo(baseBalanceAt(pb, 1.5), 9);
  });

  it('필요 자산: 보간·명목 환산, 판정선은 둘 중 낮은 쪽', () => {
    expect(baseRequiredAt(withReq, 1)).toBeCloseTo(4000, 9);
    expect(baseRequiredAt(withReq, 1.5)).toBeCloseTo(3500, 9);
    expect(baseRequiredAt({ ...withReq, inflation: 2 }, 1)).toBeCloseTo(4000 * 1.02, 9);
    expect(baseFloorAt(withReq, 1)).toBeCloseTo(4000, 9);
    // 필요 자산이 기준선보다 크면 기준선
    expect(baseFloorAt({ ...pb, required: [20000, 20000, 20000, 20000] }, 1)).toBeCloseTo(9000, 9);
  });

  it('reviewYearEnds: 하단선을 낮은 쪽으로 잡아 불필요한 감액을 하지 않음', () => {
    const rec = [{ year: 2026, balance: 7000, withdrawn: 1000 }];
    const old = reviewYearEnds(pb, rec, g)[0];
    expect(old.lower).toBeCloseTo(9000 * 0.85, 6);
    expect(old.position).toBe('below');
    expect(old.multiplier).toBeCloseTo(0.9, 9);
    const now = reviewYearEnds(withReq, rec, g)[0];
    expect(now.baseline).toBeCloseTo(9000, 6);
    expect(now.lower).toBeCloseTo(4000 * 0.85, 6);
    expect(now.upper).toBeCloseTo(9000 * 1.15, 6); // 상단선은 기준선 그대로
    expect(now.position).toBe('inside');
    expect(now.multiplier).toBe(1);
  });

  it('reviewYearEnds: 필요 자산 아래로 떨어져 줄였다가, 그 상단선을 넘으면 되돌림', () => {
    const rows = reviewYearEnds(withReq, [{ year: 2026, balance: 3000, withdrawn: 1000 }, { year: 2027, balance: 3600, withdrawn: 900 }], g);
    expect(rows[0].position).toBe('below'); // 3000 < 3400
    expect(rows[0].multiplier).toBeCloseTo(0.9, 9);
    expect(rows[1].position).toBe('inside'); // 2027 말 하단선 2550 ~ 상단선 9200
    expect(rows[1].multiplier).toBeCloseTo(0.99, 9); // 필요 자산 3000의 상단선 3450 위
  });
});

describe('가드레일 회귀: 시작 자산이 작고 뒤에 매각대금이 들어오는 계획', () => {
  // 기준선은 매각대금이 들어온 뒤 크게 뛰지만, 실제로는 자산이 충분해 줄일 이유가 없음
  const inp: WithdrawInput = {
    startAge: 60, endAge: 95, startBalance: 20000, expenseAnnual: 3000,
    pensions: [{ startAge: 65, annual: 1500 }], meanReturn: 5, volatility: 12, inflation: 2, percentRate: 4,
    inflows: [{ name: '아파트 매각', age: 65, amount: 80000 }],
  };

  it('가드레일 성공률이 정액 인출보다 크게 낮지 않음(예전엔 99% 대 27%)', () => {
    const f = compareStrategy('fixed', inp, 500);
    const gr = compareStrategy('guardrail', inp, 500);
    expect(f.successRate).toBeGreaterThan(80);
    expect(gr.successRate).toBeGreaterThanOrEqual(f.successRate - 5);
  });

  it('평균 수익 경로에서는 한 번도 줄이지 않음', () => {
    const gr = compareStrategy('guardrail', inp, 50);
    gr.schedule.forEach((row) => expect(row.withdrawal).toBeCloseTo(Math.max(0, 3000 - (row.age >= 65 ? 1500 : 0)), 6));
  });
});
