import { describe, expect, it } from 'vitest';
import { fromCSV, toCSV } from '../db/csv';
import { sampleData } from '../db/sample';
import type { Asset, Cashflow } from '../types';
import { canMaturity, emergencyLockedOf, goalTimingGaps, maturities, maturityLabel, monthsToMaturity } from './maturity';
import { milestones, yearTodos } from './milestones';
import { summarize } from './portfolio';
import { rebalance } from './rebalance';
import { cashOnHand, cashYears } from './buckets';
import { maturityPrescriptions } from './prescribe';
import { emergencyDetail } from './risk';

const Y = 2026;
const M = 11;
const asset = (name: string, type: Asset['type'], purpose: Asset['purpose'], amount: number, over: Partial<Asset> = {}): Asset => ({
  name, type, amount, purpose, nature: 'safe', expectedReturn: 3, volatility: 0.5, ...over,
});
const spend = (monthly: number) => [{ name: '생활비', kind: 'fixed', monthly } as Cashflow];
const plan = (name: string, years: number, allocated: number) => ({ goal: { name }, years, allocated });

describe('예금·적금 만기 연월', () => {
  it('예금·적금만, 남은 개월(월을 비우면 12월)', () => {
    expect(canMaturity({ type: 'deposit' })).toBe(true);
    expect(canMaturity({ type: 'savings' })).toBe(true);
    expect(canMaturity({ type: 'cash' })).toBe(false);
    expect(canMaturity({ type: 'bond' })).toBe(false);
    expect(monthsToMaturity({ maturityYear: 2027, maturityMonth: 3 }, Y, M)).toBe(4);
    expect(monthsToMaturity({ maturityYear: 2027 }, Y, M)).toBe(13);
    expect(monthsToMaturity({ maturityYear: 2026, maturityMonth: 11 }, Y, M)).toBe(0);
    expect(monthsToMaturity({ maturityYear: 2026, maturityMonth: 5 }, Y, M)).toBe(-6);
    expect(maturityLabel({ maturityYear: 2027, maturityMonth: 3 })).toBe('2027년 3월');
    expect(maturityLabel({ maturityYear: 2027, maturityMonth: 13 })).toBe('2027년');
  });

  it('만기 목록은 빠른 순, 다른 유형·만기 없음·0원은 뺌', () => {
    const rows = maturities([
      asset('적금', 'savings', 'mid', 1200, { maturityYear: 2028, maturityMonth: 6 }),
      asset('예금', 'deposit', 'short', 1000, { maturityYear: 2027, maturityMonth: 1 }),
      asset('채권', 'bond', 'mid', 500, { maturityYear: 2027 }),
      asset('만기 없음', 'deposit', 'short', 300),
      asset('빈 예금', 'deposit', 'short', 0, { maturityYear: 2027 }),
    ], Y, M);
    expect(rows.map((r) => [r.name, r.monthsLeft])).toEqual([['예금', 2], ['적금', 19]]);
  });

  it('비상금 중 만기가 3개월 넘게 남은 돈: 요약·위험 점검 설명', () => {
    const list = [
      asset('파킹통장', 'cash', 'short', 300),
      asset('정기예금', 'deposit', 'short', 1200, { maturityYear: 2027, maturityMonth: 9 }), // 10개월
      asset('곧 만기', 'deposit', 'short', 300, { maturityYear: 2027, maturityMonth: 1 }), // 2개월
    ];
    expect(emergencyLockedOf(maturities(list, Y, M))).toBe(1200);
    const s = summarize(sampleData().profile, list, [], spend(300), Y, [], M);
    expect(s.emergencyFund).toBe(1800);
    expect(s.emergencyLocked).toBe(1200);
    expect(emergencyDetail(s, 6)).toContain('이 가운데 1,200만원은 만기가 3개월 넘게 남은 예금·적금');
    expect(emergencyDetail(s, 6)).toContain('바로 쓸 수 있는 돈은 2.0개월분');
    const none = summarize(sampleData().profile, list.slice(0, 1), [], spend(300), Y, [], M);
    expect(none.emergencyLocked).toBeUndefined();
    expect(emergencyDetail(none, 6)).not.toContain('만기');
  });

  it('목적자금 시점: 목표 해보다 늦게 만기가 오는 중기 예금·적금 몫만큼 부족', () => {
    const rows = maturities([
      asset('적금 A', 'savings', 'mid', 1000, { maturityYear: 2029, maturityMonth: 3 }),
      asset('예금 B', 'deposit', 'mid', 500, { maturityYear: 2027 }),
    ], Y, M);
    // 중기 합계 2,000(적금 1,000 + 예금 500 + 만기 없는 500)
    const gaps = goalTimingGaps([plan('차', 1, 800), plan('여행', 2, 600), plan('결혼', 4, 400)], 2000, rows, Y);
    // 2027(차): 늦게 오는 돈 1,000 → 쓸 수 있는 1,000 ≥ 800 → 괜찮음
    // 2028(여행): 누계 1,400 > 1,000 → 부족 400
    // 2030(결혼): 적금 A 도 만기(2029) → 괜찮음
    expect(gaps).toEqual([{ name: '여행', goalYear: 2028, short: 400, late: [rows[1]] }]);
    expect(rows[1].name).toBe('적금 A');
    // 만기가 목표 해와 같으면 제때 돌아온다고 봄, 중기 만기가 없으면 점검 안 함
    expect(goalTimingGaps([plan('차', 1, 2000)], 2000, rows.filter((r) => r.name === '예금 B'), Y)).toEqual([]);
    expect(goalTimingGaps([plan('차', 1, 2000)], 2000, [], Y)).toEqual([]);
  });

  it('처방: 지난 만기, 비상금이 만기에 묶임, 목표보다 늦은 만기', () => {
    const list = [
      asset('파킹통장', 'cash', 'short', 300),
      asset('정기예금', 'deposit', 'short', 1200, { maturityYear: 2027, maturityMonth: 9 }),
      asset('지난 적금', 'savings', 'mid', 200, { maturityYear: 2026, maturityMonth: 5 }),
      asset('적금 A', 'savings', 'mid', 1000, { maturityYear: 2029, maturityMonth: 3 }),
    ];
    const s = summarize(sampleData().profile, list, [], spend(300), Y, [], M);
    expect(s.midFund).toBe(1200);
    const rx = maturityPrescriptions(s, [plan('여행', 2, 600) as never], Y, 6);
    expect(rx.map((x) => x.title)).toEqual([
      '지난 적금 만기(2026년 5월)가 지났음',
      '비상금 중 1,200만원은 만기 전 — 바로 쓸 수 있는 돈은 1.0개월분',
      '여행(2028년) 목적자금 400만원 — 예금·적금 만기가 목표보다 늦음',
    ]);
    expect(rx[1].detail).toContain('정기예금(2027년 9월 만기)');
    expect(rx[2].detail).toContain('적금 A(2029년 3월 만기, 1,000만원)');
    // 바로 쓸 돈만으로 목표를 채우면 비상금 처방은 없음
    const rich = summarize(sampleData().profile, [asset('파킹통장', 'cash', 'short', 5000), list[1]], [], spend(300), Y, [], M);
    expect(maturityPrescriptions(rich, [], Y, 6)).toEqual([]);
  });

  it('CSV: 만기 연도·월은 예금·적금 행만, 월은 1~12', () => {
    const rows = [
      asset('예금', 'deposit', 'short', 1000, { maturityYear: 2027, maturityMonth: 3 }),
      asset('적금', 'savings', 'mid', 500, { maturityYear: 2028 }),
    ];
    const back = fromCSV('assets', toCSV('assets', rows as never));
    expect(back.errors).toEqual([]);
    expect(back.rows[0]).toMatchObject({ maturityYear: 2027, maturityMonth: 3 });
    expect(back.rows[1]).toMatchObject({ maturityYear: 2028 });
    expect(back.rows[1].maturityMonth).toBeUndefined();
    const csv = ['이름,유형,금액,만기 연도,만기 월', '채권,채권,100,2027,3', '예금,예금,100,2027,13'].join('\n');
    const r = fromCSV('assets', csv);
    expect(r.rows[0].maturityYear).toBeUndefined();
    expect(r.rows[1].maturityYear).toBe(2027);
    expect(r.rows[1].maturityMonth).toBeUndefined();
    expect(r.errors).toEqual(["3행: '만기 월'은(는) 1~12만 넣을 수 있어 비워 두었습니다."]);
  });
});

describe('만기 이정표·챙길 일', () => {
  const p = sampleData().profile;
  const list = [
    asset('비상 예금', 'deposit', 'short', 1000, { maturityYear: 2027, maturityMonth: 3 }),
    asset('여행 적금', 'savings', 'mid', 500, { maturityYear: 2028 }),
    asset('지난 예금', 'deposit', 'short', 300, { maturityYear: 2026, maturityMonth: 5 }),
    asset('중개형 ISA', 'etf', 'long', 3000, { nature: 'invest', expectedReturn: 10, acctKind: 'isa', isaEndYear: 2028, isaPaid: 3000 }),
  ];

  it('다가오는 이정표: 예금·적금 만기 연월과 ISA 만기 연도(지난 만기는 뺌)', () => {
    const ms = milestones(p, list, [], [], Y, M).filter((m) => m.kind === 'maturity');
    expect(ms.map((m) => [m.year, m.month, m.label])).toEqual([
      [2027, 3, '비상 예금 만기(예금)'],
      [2028, 0, '여행 적금 만기(적금)'],
      [2028, 0, '중개형 ISA 만기 → 60일 안에 연금저축·IRP로 옮기면 세액공제 대상 +300만원'],
    ]);
    expect(ms[0].note).toBe('1,000만원 · 비상금은 바로 꺼낼 수 있는 통장이나 짧은 만기로');
    // 3,000 × 1.1² = 3,630 → 수익 630 중 한도 200 넘는 430에 9.9%
    expect(ms[2].note).toBe('지금 평가액 3,000만원 · 만기 수익 약 630만원 중 비과세 한도 200만원을 넘는 430만원에 9.9% 약 43만원');
  });

  it('올해·내년 챙길 일: 그 해 만기(올해는 이번 달 이후)', () => {
    const todo = (y: number) => yearTodos(p, list, Y, y, [], M).filter((x) => x.includes('만기'));
    expect(todo(2026)).toEqual([]);
    expect(todo(2027)).toEqual(['3월 비상 예금 만기(예금) 1,000만원 → 비상금은 바로 꺼낼 수 있는 통장이나 짧은 만기로']);
    expect(todo(2028)).toEqual([
      '여행 적금 만기(적금) 500만원 → 목표 시점에 맞춰 다시 맡길 기간을 정함',
      '중개형 ISA 만기 → 60일 안에 연금저축·IRP로 옮기면 세액공제 대상 +300만원',
    ]);
  });
});

describe('리밸런싱: 만기 전 예금·적금', () => {
  const list = [
    asset('정기예금', 'deposit', 'short', 5000, { maturityYear: 2027, maturityMonth: 9 }),
    asset('파킹통장', 'cash', 'short', 1000),
    asset('ETF', 'etf', 'long', 4000, { nature: 'invest', expectedReturn: 6, volatility: 15 }),
  ];

  it('세금 없는 계좌부터: 만기 전 예금은 맨 마지막에 깨고 따로 알려 줌', () => {
    // 투자형 40% → 목표 60%: 안전형 2,000을 팔아야 함
    const r = rebalance(list, 60, Y, 5, 'pensionFirst', undefined, M);
    expect(r.general.sell.map((m) => [m.name, Math.round(m.change)])).toEqual([['정기예금', -1000], ['파킹통장', -1000]]);
    expect(r.early).toEqual([{ name: '정기예금', amount: 5000, change: -1000, after: 4000, maturity: '2027년 9월' }]);
    expect(r.taxable).toBeCloseTo(2000);
  });

  it('비례 방식은 그대로 나누되 만기 전 몫을 알려 줌, 만기가 없거나 지났으면 없음', () => {
    const r = rebalance(list, 60, Y, 5, 'ratio', undefined, M);
    expect(r.early[0].change).toBeCloseTo(-5000 / 3);
    const plain = list.map((a) => (a.type === 'deposit' ? { ...a, maturityYear: undefined, maturityMonth: undefined } : a));
    expect(rebalance(plain, 60, Y, 5, 'pensionFirst', undefined, M).early).toEqual([]);
    const past = list.map((a) => (a.type === 'deposit' ? { ...a, maturityYear: 2026, maturityMonth: 5 } : a));
    const rp = rebalance(past, 60, Y, 5, 'pensionFirst', undefined, M);
    expect(rp.early).toEqual([]);
    expect(rp.general.sell.map((m) => Math.round(m.change))).toEqual([-1667, -333]);
  });
});

describe('인출 바구니: 만기 전 예금·적금은 바로 쓸 돈과 따로', () => {
  it('연금계좌 밖 현금·예금·적금을 바로 쓸 돈과 만기가 3개월 넘게 남은 돈으로 나눔', () => {
    const list = [
      asset('파킹통장', 'cash', 'short', 1000),
      asset('정기예금', 'deposit', 'short', 2000, { maturityYear: 2027, maturityMonth: 9 }), // 10개월 → 묶임
      asset('곧 만기 적금', 'savings', 'mid', 500, { maturityYear: 2027, maturityMonth: 1 }), // 2개월 → 바로 씀
      asset('만기 없는 예금', 'deposit', 'short', 500),
      asset('채권', 'bond', 'mid', 3000),
      asset('IRP', 'pension', 'long', 5000),
    ];
    const c = cashOnHand(list, Y, M);
    expect(c).toMatchObject({ total: 4000, usable: 2000, locked: 2000 });
    expect(c.lockedRows.map((r) => r.name)).toEqual(['정기예금']);
    // 첫해 인출 1,000 기준: 바로 쓸 돈만 2년, 만기 전 예금까지 깨면 4년
    expect(cashYears(c, 1000)).toEqual({ usable: 2, all: 4 });
    expect(cashYears(c, 0)).toBeUndefined();
    // 만기가 없으면 모두 바로 쓸 돈
    expect(cashOnHand(list.filter((a) => a.name !== '정기예금'), Y, M)).toMatchObject({ total: 2000, usable: 2000, locked: 0 });
  });
});
