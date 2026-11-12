import { describe, expect, it } from 'vitest';
import type { Asset } from '../types';
import { rebalance, REBALANCE_BAND } from './rebalance';

const Y = 2026;
const asset = (name: string, type: Asset['type'], nature: Asset['nature'], amount: number, over: Partial<Asset> = {}): Asset => ({
  name, type, amount, nature, expectedReturn: 5, volatility: 10, purpose: 'long', ...over,
});
// 투자형 8,000(80%) · 안전형 2,000, 부동산은 따로
const assets: Asset[] = [
  asset('주식 ETF', 'etf', 'invest', 6000),
  asset('연금저축', 'pension', 'invest', 2000),
  asset('예금', 'deposit', 'safe', 1500),
  asset('채권', 'bond', 'safe', 500),
  asset('아파트', 'realestate', 'invest', 50000),
];

const sum = (list: { change: number }[]) => list.reduce((a, x) => a + x.change, 0);
const investAfter = (r: ReturnType<typeof rebalance>, names: string[]) =>
  [...r.sell, ...r.buy].filter((x) => names.includes(x.name)).reduce((a, x) => a + x.after, 0);

describe('리밸런싱 금액 계산', () => {
  it('목표와 허용 범위(±5%p) 안이면 그대로', () => {
    expect(REBALANCE_BAND).toBe(5);
    const r = rebalance(assets, 77, Y);
    expect(r.total).toBe(10000); // 부동산 제외
    expect(r.invest).toBe(8000);
    expect(r.current).toBeCloseTo(80, 9);
    expect(r.gap).toBeCloseTo(3, 9);
    expect(r.needed).toBe(false);
    expect(r.shift).toBe(0);
    expect(r.sell).toEqual([]);
    expect(r.buy).toEqual([]);
    expect(r.short).toBe(0);
    expect(rebalance(assets, 75, Y).needed).toBe(false); // 딱 5%p
    expect(rebalance(assets, 80, Y, 0).needed).toBe(false);
  });

  it('투자형이 넘치면 투자형을 평가액 비례로 팔고 안전형을 평가액 비례로 삼', () => {
    const r = rebalance(assets, 50, Y);
    expect(r.needed).toBe(true);
    expect(r.gap).toBeCloseTo(30, 9);
    expect(r.shift).toBeCloseTo(3000, 9);
    expect(r.sell.map((x) => [x.name, x.change])).toEqual([['주식 ETF', -2250], ['연금저축', -750]]);
    expect(r.buy.map((x) => [x.name, x.change])).toEqual([['예금', 2250], ['채권', 750]]);
    expect(-sum(r.sell)).toBeCloseTo(3000, 9);
    expect(sum(r.buy)).toBeCloseTo(3000, 9);
    expect(r.sell[1]).toMatchObject({ amount: 2000, after: 1250, pension: true });
    expect(r.sell[0].pension).toBe(false);
    // 조정 뒤 투자형 비중 = 목표, 부동산은 목록에 없음
    expect(investAfter(r, ['주식 ETF', '연금저축']) / r.total).toBeCloseTo(0.5, 9);
    expect([...r.sell, ...r.buy].some((x) => x.name === '아파트')).toBe(false);
    expect(r.short).toBe(0);
  });

  it('투자형이 모자라면 반대로: 안전형을 팔아 투자형을 삼', () => {
    const r = rebalance(assets, 95, Y);
    expect(r.gap).toBeCloseTo(-15, 9);
    expect(r.shift).toBeCloseTo(-1500, 9);
    expect(r.sell.map((x) => [x.name, x.change])).toEqual([['예금', -1125], ['채권', -375]]);
    expect(r.buy.map((x) => [x.name, x.change])).toEqual([['주식 ETF', 1125], ['연금저축', 375]]);
    expect(-sum(r.sell)).toBeCloseTo(Math.abs(r.shift), 9);
    expect(sum(r.buy)).toBeCloseTo(Math.abs(r.shift), 9);
    expect(investAfter(r, ['주식 ETF', '연금저축']) / r.total).toBeCloseTo(0.95, 9);
  });

  it('수령 전 묶인 자산은 비중에는 넣되 사고팔 목록에서 뺌', () => {
    const locked = [...assets, asset('노란우산', 'other', 'safe', 2000, { lockYear: Y + 4 })];
    const r = rebalance(locked, 50, Y);
    expect(r.total).toBe(12000);
    expect(r.current).toBeCloseTo((8000 / 12000) * 100, 9);
    expect(r.shift).toBeCloseTo(8000 - 6000, 9);
    expect([...r.sell, ...r.buy].some((x) => x.name === '노란우산')).toBe(false);
    expect(r.buy.map((x) => [x.name, x.change])).toEqual([['예금', 1500], ['채권', 500]]);
    // 조정 뒤 비중 = 목표(묶인 자산 포함 합계 기준)
    expect(investAfter(r, ['주식 ETF', '연금저축']) / r.total).toBeCloseTo(0.5, 9);
    // 수령 연도가 지났으면 다시 사고팔 수 있음
    expect(rebalance(locked, 50, Y + 4).buy.some((x) => x.name === '노란우산')).toBe(true);
  });

  it('팔 쪽이 묶여 있으면 움직일 수 있는 만큼만 옮기고 남는 금액은 short', () => {
    const r = rebalance(assets.map((a) => (a.name === '주식 ETF' ? { ...a, lockYear: Y + 1 } : a)), 50, Y);
    expect(r.shift).toBeCloseTo(2000, 9);
    expect(r.short).toBeCloseTo(1000, 9);
    expect(r.sell.map((x) => [x.name, x.change])).toEqual([['연금저축', -2000]]);
    expect(sum(r.buy)).toBeCloseTo(2000, 9);
  });

  it('살 쪽 자산이 없으면 buy 는 빈 배열(팔기만 표시)', () => {
    const only = assets.filter((a) => a.nature === 'invest');
    const r = rebalance(only, 30, Y);
    expect(r.total).toBe(8000);
    expect(r.needed).toBe(true);
    expect(r.shift).toBeCloseTo(8000 * 0.7, 9);
    expect(-sum(r.sell)).toBeCloseTo(5600, 9);
    expect(r.buy).toEqual([]);
  });

  it('평가액 0인 자산은 빼고, 목표는 0~100으로 자름, 금융자산이 없으면 조정 없음', () => {
    const r = rebalance([...assets, asset('빈 계좌', 'fund', 'invest', 0)], 150, Y);
    expect(r.target).toBe(100);
    expect([...r.sell, ...r.buy].some((x) => x.name === '빈 계좌')).toBe(false);
    expect(rebalance(assets, -10, Y).target).toBe(0);
    const none = rebalance([asset('아파트', 'realestate', 'invest', 50000)], 50, Y);
    expect(none).toMatchObject({ total: 0, current: 0, needed: false, shift: 0, sell: [], buy: [] });
  });
});
