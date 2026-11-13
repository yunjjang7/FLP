import { describe, expect, it } from 'vitest';
import type { Asset } from '../types';
import { isRiskCapped } from './buckets';
import { NATURE_DEFAULTS, natureReturn, rebalance, REBALANCE_BAND, splitAccount } from './rebalance';

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
const names = (r: ReturnType<typeof rebalance>) => [...r.general.sell, ...r.general.buy, ...r.pensions].map((x) => x.name);
const pair = (list: { name: string; change: number }[]) => list.map((x) => [x.name, x.change]);

describe('리밸런싱 금액 계산', () => {
  it('목표와 허용 범위(±5%p) 안이면 그대로', () => {
    expect(REBALANCE_BAND).toBe(5);
    const r = rebalance(assets, 77, Y);
    expect(r.total).toBe(10000); // 부동산 제외
    expect(r.invest).toBe(8000);
    expect(r.current).toBeCloseTo(80, 9);
    expect(r.gap).toBeCloseTo(3, 9);
    expect(r).toMatchObject({ needed: false, shift: 0, general: { amount: 0, sell: [], buy: [] }, pensions: [], outside: 0, short: 0 });
    expect(rebalance(assets, 75, Y).needed).toBe(false); // 딱 5%p
    expect(rebalance(assets, 80, Y, 0).needed).toBe(false);
  });

  it('투자형이 넘치면: 일반계좌는 팔아서 일반계좌 안전형을 사고, 연금계좌는 계좌 안에서 바꿈', () => {
    const r = rebalance(assets, 50, Y);
    expect(r.needed).toBe(true);
    expect(r.gap).toBeCloseTo(30, 9);
    expect(r.shift).toBeCloseTo(3000, 9);
    // 줄일 금액은 평가액 비례: 주식 ETF 2,250 · 연금저축 750
    expect(pair(r.general.sell)).toEqual([['주식 ETF', -2250]]);
    expect(r.general.amount).toBeCloseTo(2250, 9);
    // 일반계좌에서 판 돈만 일반계좌 안전형에 평가액 비례로 들어감(연금저축에서 판 돈은 넘어오지 않음)
    expect(pair(r.general.buy)).toEqual([['예금', 1687.5], ['채권', 562.5]]);
    expect(sum(r.general.buy)).toBeCloseTo(-sum(r.general.sell), 9);
    expect(r.pensions).toEqual([{ name: '연금저축', amount: 2000, move: 750, keep: 1250, limit: 2000, capped: false }]);
    // 조정 뒤 투자형 비중 = 목표, 부동산은 목록에 없음
    expect((r.invest - r.shift) / r.total).toBeCloseTo(0.5, 9);
    expect(r.general.amount + r.pensions[0].move).toBeCloseTo(r.shift, 9);
    expect(names(r)).not.toContain('아파트');
    expect(r.outside).toBe(0);
    expect(r.short).toBe(0);
  });

  it('투자형이 모자라면 반대로: 안전형을 팔아 같은 계좌 종류의 투자형을 삼', () => {
    const r = rebalance(assets, 95, Y);
    expect(r.gap).toBeCloseTo(-15, 9);
    expect(r.shift).toBeCloseTo(-1500, 9);
    expect(pair(r.general.sell)).toEqual([['예금', -1125], ['채권', -375]]);
    // 연금저축(투자형)은 다른 계좌라 살 곳이 아님
    expect(pair(r.general.buy)).toEqual([['주식 ETF', 1500]]);
    expect(r.pensions).toEqual([]);
    expect((r.invest - r.shift) / r.total).toBeCloseTo(0.95, 9);
  });

  it('연금계좌가 여럿이면 계좌마다 따로, 살 쪽 연금계좌로 돈이 넘어가지 않음', () => {
    const list = [asset('연금저축', 'pension', 'invest', 3000), asset('개인연금', 'pension', 'invest', 1000), asset('연금 예금', 'pension', 'safe', 1000)];
    const r = rebalance(list, 40, Y);
    expect(r.shift).toBeCloseTo(2000, 9);
    expect(r.pensions.map((x) => [x.name, x.move, x.keep])).toEqual([['연금저축', 1500, 1500], ['개인연금', 500, 500]]);
    expect(r.general).toEqual({ amount: 0, sell: [], buy: [] });
    expect(r.outside).toBe(0);
  });

  it('퇴직연금 계좌는 투자형을 70%까지만: 넘는 몫은 계좌 밖으로 빼야 맞춰지는 금액', () => {
    const list = [asset('IRP', 'pension', 'safe', 6000), asset('예금', 'deposit', 'safe', 2000), asset('주식 ETF', 'etf', 'invest', 2000)];
    // 한도 안: IRP 4,200 · 예금 2,000 가운데 비례로
    const a = rebalance(list, 60, Y);
    expect(a.shift).toBeCloseTo(-4000, 9);
    expect(a.pensions[0]).toMatchObject({ name: 'IRP', limit: 4200, capped: true });
    expect(a.pensions[0].move).toBeCloseTo((4000 * 4200) / 6200, 9);
    expect(a.general.amount).toBeCloseTo((4000 * 2000) / 6200, 9);
    expect(a.outside).toBe(0);
    // 한도 초과: 6,200까지만 계좌 안에서, 나머지 800은 IRP에서 빼야 함
    const b = rebalance(list, 90, Y);
    expect(b.shift).toBeCloseTo(-6200, 9);
    expect(b.pensions[0].move).toBeCloseTo(4200, 9);
    expect(b.pensions[0].keep).toBeCloseTo(1800, 9);
    expect(b.general.sell[0].change).toBeCloseTo(-2000, 9);
    expect(b.general.buy[0]).toMatchObject({ name: '주식 ETF' });
    expect(b.general.buy[0].change).toBeCloseTo(2000, 9);
    expect(b.outside).toBeCloseTo(800, 9);
    expect(b.short).toBeCloseTo(0, 9);
    // 빼야 하는 금액은 한도에 걸린 금액(1,800)까지만, 그 밖의 부족은 short
    const c = rebalance([...list, asset('노란우산', 'other', 'safe', 1000, { lockYear: Y + 3 })], 100, Y);
    expect(c.outside).toBeCloseTo(1800, 9);
    expect(c.short).toBeCloseTo(1000, 9);
    // 투자형을 줄이는 방향이나 연금저축에는 한도가 없음
    expect(rebalance([asset('IRP', 'pension', 'invest', 5000)], 0, Y)).toMatchObject({ shift: 5000, outside: 0, short: 0 });
    expect(rebalance([asset('연금저축', 'pension', 'safe', 5000)], 100, Y)).toMatchObject({ shift: -5000, outside: 0 });
  });

  it('수령 전 묶인 자산은 비중에는 넣되 사고팔 목록에서 뺌', () => {
    const locked = [...assets, asset('노란우산', 'other', 'safe', 2000, { lockYear: Y + 4 })];
    const r = rebalance(locked, 50, Y);
    expect(r.total).toBe(12000);
    expect(r.current).toBeCloseTo((8000 / 12000) * 100, 9);
    expect(r.shift).toBeCloseTo(8000 - 6000, 9);
    expect(names(r)).not.toContain('노란우산');
    expect(pair(r.general.buy)).toEqual([['예금', 1125], ['채권', 375]]);
    // 조정 뒤 비중 = 목표(묶인 자산 포함 합계 기준)
    expect((r.invest - r.shift) / r.total).toBeCloseTo(0.5, 9);
    // 수령 연도가 지났으면 다시 사고팔 수 있음
    expect(rebalance(locked, 50, Y + 4).general.buy.some((x) => x.name === '노란우산')).toBe(true);
  });

  it('팔 쪽이 묶여 있으면 움직일 수 있는 만큼만 옮기고 남는 금액은 short', () => {
    const r = rebalance(assets.map((a) => (a.name === '주식 ETF' ? { ...a, lockYear: Y + 1 } : a)), 50, Y);
    expect(r.shift).toBeCloseTo(2000, 9);
    expect(r.short).toBeCloseTo(1000, 9);
    expect(r.outside).toBe(0);
    expect(r.pensions.map((x) => [x.name, x.move, x.keep])).toEqual([['연금저축', 2000, 0]]);
    expect(r.general).toEqual({ amount: 0, sell: [], buy: [] }); // 일반계좌에서 판 돈이 없어 살 것도 없음
  });

  it('일반계좌에 살 쪽 자산이 없으면 buy 는 빈 배열(팔기만 표시)', () => {
    const only = assets.filter((a) => a.nature === 'invest');
    const r = rebalance(only, 30, Y);
    expect(r.total).toBe(8000);
    expect(r.needed).toBe(true);
    expect(r.shift).toBeCloseTo(8000 * 0.7, 9);
    expect(r.general.sell[0].change).toBeCloseTo(-4200, 9);
    expect(r.pensions[0].move).toBeCloseTo(1400, 9);
    expect(r.general.buy).toEqual([]);
  });

  describe('연금계좌부터 바꾸기(pensionFirst)', () => {
    const first = (list: Asset[], target: number) => rebalance(list, target, Y, REBALANCE_BAND, 'pensionFirst');

    it('기본값은 기존 비례 방식(ratio)과 같음', () => {
      for (const t of [50, 95, 77]) {
        expect(rebalance(assets, t, Y)).toEqual(rebalance(assets, t, Y, REBALANCE_BAND, 'ratio'));
      }
      expect(first(assets, 50).general.amount).not.toBeCloseTo(rebalance(assets, 50, Y).general.amount, 3);
    });

    it('연금계좌로 다 채워지면 일반계좌는 팔지 않음(연금계좌끼리는 바꿀 수 있는 금액 비례)', () => {
      const list = [asset('주식 ETF', 'etf', 'invest', 6000), asset('연금저축', 'pension', 'invest', 2000), asset('개인연금', 'pension', 'invest', 1000), asset('예금', 'deposit', 'safe', 1000)];
      const ratio = rebalance(list, 70, Y);
      const r = first(list, 70);
      expect(r.shift).toBeCloseTo(2000, 9);
      expect(r.shift).toBeCloseTo(ratio.shift, 9);
      expect(r.general).toEqual({ amount: 0, sell: [], buy: [] });
      expect(r.pensions.map((x) => x.name)).toEqual(['연금저축', '개인연금']);
      expect(r.pensions[0].move).toBeCloseTo(4000 / 3, 9);
      expect(r.pensions[1].move).toBeCloseTo(2000 / 3, 9);
      expect(ratio.general.amount).toBeCloseTo((2000 * 6000) / 9000, 9);
      expect(r.outside).toBe(0);
      expect(r.short).toBe(0);
    });

    it('연금계좌가 모자라면 연금계좌를 다 바꾸고 나머지만 일반계좌에서 팖', () => {
      const r = first(assets, 50);
      expect(r.shift).toBeCloseTo(3000, 9);
      expect(r.pensions).toEqual([{ name: '연금저축', amount: 2000, move: 2000, keep: 0, limit: 2000, capped: false }]);
      expect(pair(r.general.sell)).toEqual([['주식 ETF', -1000]]);
      expect(r.general.amount).toBeCloseTo(1000, 9);
      expect(pair(r.general.buy)).toEqual([['예금', 750], ['채권', 250]]);
      expect(r.general.amount + r.pensions[0].move).toBeCloseTo(r.shift, 9);
      expect((r.invest - r.shift) / r.total).toBeCloseTo(0.5, 9);
    });

    it('퇴직연금 70% 한도와 함께: 연금계좌는 한도까지만, outside·short·shift 는 비례 방식과 같음', () => {
      const list = [asset('IRP', 'pension', 'safe', 6000), asset('예금', 'deposit', 'safe', 2000), asset('주식 ETF', 'etf', 'invest', 2000)];
      // 한도 안: IRP 한도(4,200)로 다 채워져 일반계좌는 팔지 않음
      const a = first(list, 60);
      expect(a.shift).toBeCloseTo(-4000, 9);
      expect(a.pensions[0]).toMatchObject({ name: 'IRP', limit: 4200, capped: true });
      expect(a.pensions[0].move).toBeCloseTo(4000, 9);
      expect(a.general.amount).toBe(0);
      // 한도 초과: IRP 4,200 + 예금 2,000, 나머지 800은 IRP에서 빼야 함
      const b = first(list, 90);
      expect(b.pensions[0].move).toBeCloseTo(4200, 9);
      expect(b.general.amount).toBeCloseTo(2000, 9);
      const locked = [...list, asset('노란우산', 'other', 'safe', 1000, { lockYear: Y + 3 })];
      for (const [l, t] of [[list, 60], [list, 90], [locked, 100]] as const) {
        const x = first([...l], t);
        const y = rebalance([...l], t, Y);
        expect(x.shift).toBeCloseTo(y.shift, 9);
        expect(x.outside).toBeCloseTo(y.outside, 9);
        expect(x.short).toBeCloseTo(y.short, 9);
      }
      expect(b.outside).toBeCloseTo(800, 9);
      expect(first(locked, 100)).toMatchObject({ outside: expect.closeTo(1800, 9), short: expect.closeTo(1000, 9) });
    });
  });

  it('평가액 0인 자산은 빼고, 목표는 0~100으로 자름, 금융자산이 없으면 조정 없음', () => {
    const r = rebalance([...assets, asset('빈 계좌', 'fund', 'invest', 0)], 150, Y);
    expect(r.target).toBe(100);
    expect(names(r)).not.toContain('빈 계좌');
    expect(rebalance(assets, -10, Y).target).toBe(0);
    const none = rebalance([asset('아파트', 'realestate', 'invest', 50000)], 50, Y);
    expect(none).toMatchObject({ total: 0, current: 0, needed: false, shift: 0, pensions: [], outside: 0, short: 0 });
  });

  it('연금계좌 줄에 자산 id 를 실어 보냄(없으면 id 필드 없음)', () => {
    const list = [asset('연금저축', 'pension', 'invest', 2000, { id: 7 }), asset('연금저축', 'pension', 'invest', 2000, { id: 9 }), asset('예금', 'deposit', 'safe', 1000, { id: 3 })];
    expect(rebalance(list, 40, Y).pensions.map((x) => x.id)).toEqual([7, 9]);
    expect('id' in rebalance(assets, 50, Y).pensions[0]).toBe(false);
  });
});

describe('연금계좌 두 줄로 나누기(splitAccount)', () => {
  const irp = asset('퇴직 IRP', 'pension', 'invest', 10000, {
    id: 5, expectedReturn: 6, volatility: 12, owner: 'spouse', taxFree: 1000, retirePart: 3001,
    pensionYear1: 2030, drawStartYear: 2032, drawOrder: 2, compareOrder: 1, lockYear: 2029,
  });

  it('남는 줄은 원래 자산 그대로 금액만 줄고, 새 줄은 반대 성격 · 금액 = move · id 없음', () => {
    const [keep, add, ...more] = splitAccount(irp, 3000);
    expect(more).toEqual([]);
    expect(keep).toEqual({ ...irp, amount: 7000, taxFree: 700, retirePart: 2100.7 });
    expect(add).not.toHaveProperty('id');
    expect(add).toMatchObject({ amount: 3000, nature: 'safe', name: '퇴직 IRP (안전형)' });
    expect(keep.amount + add.amount).toBe(irp.amount);
  });

  it('과세제외·퇴직금 재원은 금액 비례로 나누고 합계 보존, 계좌 속성은 두 줄에 같게', () => {
    const [keep, add] = splitAccount(irp, 3333);
    expect(add.taxFree).toBeCloseTo(333.3, 9);
    expect(keep.taxFree! + add.taxFree!).toBeCloseTo(1000, 9);
    expect(keep.retirePart! + add.retirePart!).toBeCloseTo(3001, 9);
    expect(add.retirePart).toBeCloseTo(1000.2, 9);
    for (const k of ['type', 'owner', 'pensionYear1', 'drawStartYear', 'drawOrder', 'compareOrder', 'purpose', 'lockYear'] as const) {
      expect(add[k]).toBe(irp[k]);
      expect(keep[k]).toBe(irp[k]);
    }
    // 원래 없던 세금 재원은 두 줄 모두 없음, 공동명의 지분도 그대로
    const [k2, a2] = splitAccount(asset('연금저축', 'pension', 'safe', 1000, { ownerShare: 40 }), 400);
    expect(k2).not.toHaveProperty('taxFree');
    expect(a2).not.toHaveProperty('retirePart');
    expect([k2.ownerShare, a2.ownerShare]).toEqual([40, 40]);
    expect(a2).toMatchObject({ name: '연금저축 (투자형)', nature: 'invest', amount: 400 });
    expect(k2).toMatchObject({ name: '연금저축', nature: 'safe', amount: 600 });
  });

  it('새 줄 이름이 원래 이름을 품어 퇴직연금(IRP·DC·퇴직) 판단이 유지됨', () => {
    for (const name of ['IRP', '퇴직연금(DC)', '회사 퇴직금']) {
      const [keep, add] = splitAccount(asset(name, 'pension', 'safe', 5000), 2000);
      expect(isRiskCapped(keep.name)).toBe(true);
      expect(isRiskCapped(add.name)).toBe(true);
      expect(add.name.startsWith(name)).toBe(true);
    }
    expect(isRiskCapped(splitAccount(asset('연금저축', 'pension', 'safe', 5000), 2000)[1].name)).toBe(false);
    expect(splitAccount(asset('', 'pension', 'safe', 5000), 2000)[1].name).toBe('연금계좌 (투자형)');
  });

  it('새 줄 기대수익률·변동성: 같은 성격 금융자산의 금액가중 평균, 없으면 기본값', () => {
    // 안전형: 예금 3,000(3%·0.5) + 채권 1,000(4%·5) → 3.25% · 1.625 → 0.1 단위
    const others = [asset('예금', 'deposit', 'safe', 3000, { expectedReturn: 3, volatility: 0.5 }), asset('채권', 'bond', 'safe', 1000, { expectedReturn: 4, volatility: 5 }), asset('아파트', 'realestate', 'invest', 50000, { expectedReturn: 2 })];
    expect(natureReturn(others, 'safe')).toEqual({ ret: 3.3, vol: 1.6 });
    const [, add] = splitAccount(irp, 3000, [irp, ...others]);
    expect(add).toMatchObject({ expectedReturn: 3.3, volatility: 1.6 });
    // 부동산은 금융자산이 아니라 투자형 평균에서 빠짐 → 다른 투자형은 IRP 자신뿐
    expect(natureReturn(others, 'invest')).toEqual(NATURE_DEFAULTS.invest);
    expect(splitAccount(irp, 3000)[1]).toMatchObject({ expectedReturn: NATURE_DEFAULTS.safe.ret, volatility: NATURE_DEFAULTS.safe.vol });
    expect(NATURE_DEFAULTS).toEqual({ safe: { ret: 3, vol: 0.5 }, invest: { ret: 5, vol: 10 } });
    // 남는 줄은 원래 값 그대로
    expect(splitAccount(irp, 3000, others)[0]).toMatchObject({ expectedReturn: 6, volatility: 12 });
  });

  it('경계: move 가 0 이하면 그대로, 평가액 이상이면 나누지 않고 성격만 바꿈(id·이름 유지), 만원 단위로 맞춤', () => {
    expect(splitAccount(irp, 0)).toEqual([irp]);
    expect(splitAccount(irp, -5)).toEqual([irp]);
    expect(splitAccount(irp, 0.4)).toEqual([irp]);
    for (const m of [10000, 12000, 9999.6]) {
      const out = splitAccount(irp, m);
      expect(out).toHaveLength(1);
      expect(out[0]).toEqual({ ...irp, nature: 'safe', expectedReturn: NATURE_DEFAULTS.safe.ret, volatility: NATURE_DEFAULTS.safe.vol });
    }
    const [keep, add] = splitAccount(irp, 1249.6);
    expect([keep.amount, add.amount]).toEqual([8750, 1250]);
    expect(splitAccount(asset('빈 계좌', 'pension', 'invest', 0), 100)).toHaveLength(1);
  });

  it('리밸런싱 결과대로 나누면 목표 비중이 됨', () => {
    const r = rebalance(assets, 50, Y, REBALANCE_BAND, 'pensionFirst');
    const pen = assets.find((a) => a.name === '연금저축')!;
    const split = splitAccount(pen, r.pensions[0].move, assets);
    const general = assets.filter((a) => a !== pen).map((a) => {
      const m = [...r.general.sell, ...r.general.buy].find((x) => x.name === a.name);
      return m ? { ...a, amount: m.after } : a;
    });
    const after = rebalance([...general, ...split], 50, Y);
    expect(after.current).toBeCloseTo(50, 9);
    expect(after.needed).toBe(false);
  });
});
