import { describe, expect, it } from 'vitest';
import { fromCSV, toCSV } from '../db/csv';
import type { Asset } from '../types';
import { acctAmounts, canAcctKind, isaMaturities, isaTransferBase, isIsa } from './account';
import { summarize } from './portfolio';
import { isaPrescriptions } from './prescribe';
import { rebalance, REBALANCE_BAND } from './rebalance';
import { sampleData } from '../db/sample';

const Y = 2026;
const asset = (name: string, type: Asset['type'], nature: Asset['nature'], amount: number, over: Partial<Asset> = {}): Asset => ({
  name, type, amount, nature, expectedReturn: 5, volatility: 10, purpose: 'long', ...over,
});

describe('ISA·일반 계좌 구분', () => {
  it('주식·펀드·ETF만 계좌 구분을 씀', () => {
    expect(canAcctKind({ type: 'stock' })).toBe(true);
    expect(canAcctKind({ type: 'fund' })).toBe(true);
    expect(canAcctKind({ type: 'etf' })).toBe(true);
    expect(canAcctKind({ type: 'pension' })).toBe(false);
    expect(canAcctKind({ type: 'deposit' })).toBe(false);
    expect(isIsa({ type: 'etf', acctKind: 'isa' })).toBe(true);
    expect(isIsa({ type: 'deposit', acctKind: 'isa' })).toBe(false); // 유형이 바뀌어 남은 값은 무시
    expect(isIsa({ type: 'etf', acctKind: 'general' })).toBe(false);
  });

  it('계좌 구분별 금액(주식·펀드·ETF만, 0인 칸은 뺌)', () => {
    const list = [
      asset('ISA', 'etf', 'invest', 2000, { acctKind: 'isa' }),
      asset('위탁', 'stock', 'invest', 1500, { acctKind: 'general' }),
      asset('펀드', 'fund', 'invest', 500),
      asset('예금', 'deposit', 'safe', 3000, { acctKind: 'isa' }),
    ];
    expect(acctAmounts(list)).toEqual([
      { key: 'isa', label: 'ISA', value: 2000 },
      { key: 'general', label: '일반', value: 1500 },
      { key: 'none', label: '구분 안 함', value: 500 },
    ]);
    expect(acctAmounts([asset('예금', 'deposit', 'safe', 100)])).toEqual([]);
    const s = summarize(sampleData().profile, list, [], [], Y);
    expect(s.byAcct.map((g) => g.value)).toEqual([2000, 1500, 500]);
  });

  it('ISA 연금 이전 세액공제 대상: 10%, 최대 300만', () => {
    expect(isaTransferBase(2000)).toBe(200);
    expect(isaTransferBase(3000)).toBe(300);
    expect(isaTransferBase(8000)).toBe(300);
    expect(isaTransferBase(-5)).toBe(0);
  });

  it('만기 연도를 넣은 ISA 만 만기 순으로, 공제율은 13.2~16.5% 또는 직접 넣은 값', () => {
    const list = [
      asset('ISA 2', 'etf', 'invest', 4000, { acctKind: 'isa', isaEndYear: 2029 }),
      asset('ISA 1', 'fund', 'invest', 2000, { acctKind: 'isa', isaEndYear: 2027 }),
      asset('만기 없음', 'etf', 'invest', 1000, { acctKind: 'isa' }),
      asset('일반', 'stock', 'invest', 1000, { acctKind: 'general', isaEndYear: 2027 }),
    ];
    const m = isaMaturities(list, {});
    expect(m.map((x) => x.name)).toEqual(['ISA 1', 'ISA 2']);
    expect(m[0]).toMatchObject({ amount: 2000, endYear: 2027, base: 200 });
    expect(m[0].creditLow).toBeCloseTo(26.4, 9);
    expect(m[0].creditHigh).toBeCloseTo(33, 9);
    expect(m[1].base).toBe(300);
    const fixed = isaMaturities(list, { contrib: { self: 0, spouse: 0, from: 0, to: 0, selfRate: 16.5, spouseRate: 0 } as never });
    expect(fixed[0].creditLow).toBeCloseTo(33, 9);
    expect(fixed[0].creditHigh).toBeCloseTo(33, 9);
  });

  it('처방: 올해·내년 만기는 주의, 더 뒤면 참고, 지난 만기는 확인 안내', () => {
    const list = [
      asset('ISA 가', 'etf', 'invest', 2000, { acctKind: 'isa', isaEndYear: 2027 }),
      asset('ISA 나', 'etf', 'invest', 2000, { acctKind: 'isa', isaEndYear: 2030 }),
      asset('ISA 다', 'etf', 'invest', 2000, { acctKind: 'isa', isaEndYear: 2024 }),
    ];
    const rx = isaPrescriptions({ isa: isaMaturities(list, {}) }, Y);
    expect(rx.map((x) => x.level)).toEqual(['caution', 'caution', 'good']);
    expect(rx[0].title).toBe('ISA 다 만기 연도(2024년)가 지났음');
    expect(rx[1].title).toBe('ISA 가 2027년 만기 — 연금계좌로 옮기면 세액공제 대상 200만원 추가');
    expect(rx[1].detail).toContain('환급 약 26만~33만원(공제율 13.2~16.5%)');
    expect(rx[2].badge).toBe('참고');
    expect(isaPrescriptions({}, Y)).toEqual([]);
  });

  describe('리밸런싱 ‘세금 없는 계좌부터’: 연금계좌 → ISA → 나머지', () => {
    // 투자형 6,000(60%) → 목표 30%: 3,000을 안전형으로
    const list = [
      asset('연금저축', 'pension', 'invest', 1000),
      asset('ISA', 'etf', 'invest', 2000, { acctKind: 'isa' }),
      asset('위탁 ETF', 'etf', 'invest', 3000, { acctKind: 'general' }),
      asset('예금', 'deposit', 'safe', 4000),
    ];
    const sold = (r: ReturnType<typeof rebalance>) => Object.fromEntries(r.general.sell.map((x) => [x.name, -x.change]));

    it('연금계좌를 다 바꾸고 ISA, 그다음 일반 계좌', () => {
      const r = rebalance(list, 30, Y, REBALANCE_BAND, 'pensionFirst');
      expect(r.shift).toBeCloseTo(3000, 9);
      expect(r.pensions[0].move).toBeCloseTo(1000, 9);
      expect(sold(r)['ISA']).toBeCloseTo(2000, 9);
      expect(sold(r)['위탁 ETF']).toBeCloseTo(0, 9);
      expect(r.taxable).toBeCloseTo(0, 9);
      // 더 많이 줄여야 하면 남은 만큼만 일반 계좌에서
      const more = rebalance(list, 10, Y, REBALANCE_BAND, 'pensionFirst');
      expect(sold(more)['ISA']).toBeCloseTo(2000, 9);
      expect(sold(more)['위탁 ETF']).toBeCloseTo(2000, 9);
      expect(more.taxable).toBeCloseTo(2000, 9);
    });

    it('비례 방식은 계좌 구분과 상관없이 금액 비례, 과세 계좌 몫을 taxable 로', () => {
      const r = rebalance(list, 30, Y, REBALANCE_BAND, 'ratio');
      expect(r.pensions[0].move).toBeCloseTo(500, 9);
      expect(sold(r)['ISA']).toBeCloseTo(1000, 9);
      expect(sold(r)['위탁 ETF']).toBeCloseTo(1500, 9);
      expect(r.taxable).toBeCloseTo(1500, 9);
    });

    it('ISA 가 없으면 예전 ‘연금계좌부터’와 같음', () => {
      const plain = list.map((a) => ({ ...a, acctKind: undefined }));
      const r = rebalance(plain, 30, Y, REBALANCE_BAND, 'pensionFirst');
      expect(r.pensions[0].move).toBeCloseTo(1000, 9);
      expect(sold(r)['ISA']).toBeCloseTo(800, 9);
      expect(sold(r)['위탁 ETF']).toBeCloseTo(1200, 9);
      expect(r.taxable).toBeCloseTo(2000, 9);
    });
  });

  it('CSV: 계좌 구분·ISA 만기 연도 왕복, 다른 유형·일반 계좌는 읽지 않음', () => {
    const rows = [
      asset('ISA', 'etf', 'invest', 2000, { acctKind: 'isa', isaEndYear: 2028 }),
      asset('위탁', 'stock', 'invest', 1000, { acctKind: 'general' }),
    ];
    const { rows: back, errors } = fromCSV('assets', toCSV('assets', rows as never));
    expect(errors).toEqual([]);
    expect(back[0]).toMatchObject({ acctKind: 'isa', isaEndYear: 2028 });
    expect(back[1]).toMatchObject({ acctKind: 'general' });
    expect(back[1].isaEndYear).toBeUndefined();
    const csv = ['이름,유형,금액,계좌 구분,ISA 만기 연도', '예금,예금,100,ISA,2028', '위탁,주식,100,일반,2028', '중개형,ETF,100,ISA,2028'].join('\n');
    const r = fromCSV('assets', csv);
    expect(r.errors).toEqual([]);
    expect(r.rows[0].acctKind).toBeUndefined();
    expect(r.rows[0].isaEndYear).toBeUndefined();
    expect(r.rows[1]).toMatchObject({ acctKind: 'general' });
    expect(r.rows[1].isaEndYear).toBeUndefined();
    expect(r.rows[2]).toMatchObject({ acctKind: 'isa', isaEndYear: 2028 });
  });
});
