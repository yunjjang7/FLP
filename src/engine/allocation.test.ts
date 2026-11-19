import { describe, expect, it } from 'vitest';
import { sampleData } from '../db/sample';
import type { Asset } from '../types';
import {
  allocOf,
  allocReturn,
  allocText,
  classAmounts,
  classGaps,
  defaultClass,
  hasAlloc,
  investAmountOf,
  isCappedAsset,
  mixAlloc,
  natureOfAlloc,
  normalizeAlloc,
  riskShareOf,
  shiftAlloc,
} from './allocation';
import { accountBuckets, bucketAltDefault, bucketAltShare, bucketGap, bucketTotalGap, safeYears } from './buckets';
import { bucketRebalanceTodo, yearTodos } from './milestones';
import { mergeAccounts, summarize } from './portfolio';
import { allocSwitch, rebalance } from './rebalance';
import { riskChecks } from './risk';
import type { TaxResult } from './tax';

const Y = 2026;
const asset = (name: string, type: Asset['type'], nature: Asset['nature'], amount: number, over: Partial<Asset> = {}): Asset => ({
  name, type, amount, nature, expectedReturn: 5, volatility: 10, purpose: 'long', ...over,
});

describe('자산배분 비율 기본 계산', () => {
  it('비율이 없으면 성격·유형으로 한 자산군 100%', () => {
    expect(defaultClass({ type: 'stock', nature: 'invest' })).toBe('equity');
    expect(defaultClass({ type: 'other', nature: 'invest' })).toBe('alt');
    expect(defaultClass({ type: 'bond', nature: 'safe' })).toBe('bond');
    expect(defaultClass({ type: 'pension', nature: 'safe' })).toBe('cash');
    expect(allocOf({ type: 'deposit', nature: 'safe' })).toEqual({ equity: 0, bond: 0, alt: 0, cash: 100 });
    // 성격과 위험자산 여부가 늘 같음(예전 계산과 같은 투자형 금액)
    expect(riskShareOf({ type: 'etf', nature: 'invest' })).toBe(100);
    expect(riskShareOf({ type: 'pension', nature: 'safe' })).toBe(0);
  });

  it('비율은 넣을 수 있는 유형에서만 쓰고 합계를 100으로 맞춰 비례로 계산', () => {
    expect(hasAlloc({ type: 'deposit', alloc: { cash: 100 } })).toBe(false);
    expect(hasAlloc({ type: 'pension', alloc: { equity: 0, bond: 0 } })).toBe(false);
    const x = { equity: 30, bond: 30 };
    expect(normalizeAlloc(x)).toEqual({ equity: 50, bond: 50, alt: 0, cash: 0 });
    // 반올림 오차는 가장 큰 칸에서 맞춰 합계 100
    const n = normalizeAlloc({ equity: 1, bond: 1, alt: 1 })!;
    expect(n.equity + n.bond + n.alt + n.cash).toBeCloseTo(100, 9);
    const a = asset('IRP', 'pension', 'safe', 1000, { alloc: { equity: 60, bond: 20, alt: 10, cash: 10 } });
    expect(riskShareOf(a)).toBe(70);
    expect(investAmountOf(a)).toBeCloseTo(700, 9);
    expect(natureOfAlloc(allocOf(a))).toBe('invest');
    expect(natureOfAlloc({ equity: 40, bond: 50, alt: 0, cash: 10 })).toBe('safe');
    expect(allocText(allocOf(a))).toBe('주식형 60 · 채권형 20 · 대체자산 10 · 현금성 10');
  });

  it('배분으로 계산한 기대수익률·변동성은 자산군 가정값의 가중평균', () => {
    // 주식형 7·16, 채권형 3.5·5, 대체 5·15, 현금성 2.5·0.5
    expect(allocReturn({ equity: 50, bond: 50, alt: 0, cash: 0 })).toEqual({ ret: 5.3, vol: 10.5 });
    expect(allocReturn({ equity: 100, bond: 0, alt: 0, cash: 0 })).toEqual({ ret: 7, vol: 16 });
    expect(allocReturn({ equity: 0, bond: 0, alt: 0, cash: 100 })).toEqual({ ret: 2.5, vol: 0.5 });
  });

  it('여러 줄 자산군 금액·합친 비율', () => {
    const rows = [
      asset('IRP', 'pension', 'invest', 1000, { alloc: { equity: 50, bond: 50, alt: 0, cash: 0 } }),
      asset('예금', 'deposit', 'safe', 1000),
    ];
    expect(classAmounts(rows)).toEqual({ equity: 500, bond: 500, alt: 0, cash: 1000 });
    expect(mixAlloc(rows)).toEqual({ equity: 25, bond: 25, alt: 0, cash: 50 });
  });

  it('위험자산 비율 옮기기: 줄이는 쪽은 지금 비율대로, 늘리는 쪽은 목표 → 지금 비율 → 기본 순', () => {
    const x = { equity: 60, bond: 20, alt: 20, cash: 0 };
    // 위험자산 80 → 60: 주식형·대체를 3:1로 줄이고 채권형(지금 비율)으로
    expect(shiftAlloc(x, -20)).toEqual({ equity: 45, bond: 40, alt: 15, cash: 0 });
    // 목표 비율이 있으면 늘리는 쪽(채권형:현금성 = 1:1)을 목표대로
    expect(shiftAlloc(x, -20, { equity: 50, bond: 25, alt: 0, cash: 25 })).toEqual({ equity: 45, bond: 30, alt: 15, cash: 10 });
    // 안전형이 하나도 없을 때 늘리면 위험자산 쪽 기본은 주식형
    expect(shiftAlloc({ equity: 0, bond: 0, alt: 0, cash: 100 }, 30)).toEqual({ equity: 30, bond: 0, alt: 0, cash: 70 });
    // 범위를 넘으면 0~100으로 자름
    expect(shiftAlloc(x, 50)).toEqual({ equity: 75, bond: 0, alt: 25, cash: 0 });
  });

  it('70% 한도 계좌: 계좌 종류를 고르면 그대로, 비우면 계좌 이름으로', () => {
    expect(isCappedAsset({ type: 'pension', name: '연금저축', pensionKind: 'irp' })).toBe(true);
    expect(isCappedAsset({ type: 'pension', name: '퇴직 IRP', pensionKind: 'savings' })).toBe(false);
    expect(isCappedAsset({ type: 'pension', name: '퇴직 IRP (안전형)' })).toBe(true);
    expect(isCappedAsset({ type: 'pension', name: '아무 이름', group: 'DC' })).toBe(true);
    expect(isCappedAsset({ type: 'stock', name: 'IRP', pensionKind: 'irp' })).toBe(false);
  });
});

describe('자산배분 비율이 기능에 반영됨', () => {
  it('요약: 투자형 비중·안전형/투자형·자산군 구성이 위험자산 몫만 투자형으로', () => {
    const d = sampleData(Y);
    const base = summarize(d.profile, d.assets, d.liabilities, d.cashflows, Y);
    // 비율을 넣지 않으면 예전과 같고 자산군 합계는 금융자산과 같음
    expect(base.byClass.reduce((a, c) => a + c.value, 0)).toBeCloseTo(base.financialAssets, 6);
    const assets = d.assets.map((a) => (a.name === '퇴직연금(DC)' ? { ...a, alloc: { equity: 50, bond: 30, alt: 0, cash: 20 } } : a));
    const s = summarize(d.profile, assets, d.liabilities, d.cashflows, Y);
    const dc = d.assets.find((a) => a.name === '퇴직연금(DC)')!.amount;
    expect(s.investShare).toBeCloseTo(base.investShare - ((dc * 0.5) / base.financialAssets) * 100, 6);
    expect(s.byNature.find((n) => n.key === 'invest')!.value + s.byNature.find((n) => n.key === 'safe')!.value).toBeCloseTo(s.financialAssets, 6);
    expect(s.byClass.find((c) => c.key === 'bond')!.value).toBeCloseTo(base.byClass.find((c) => c.key === 'bond')!.value + dc * 0.3, 6);
  });

  it('한 줄로 합치기: 비율이 있는 줄이 있으면 합친 줄도 금액가중 비율, 성격은 비율로', () => {
    const rows = [
      asset('IRP', 'pension', 'invest', 3000, { group: '퇴직 IRP', alloc: { equity: 100, bond: 0, alt: 0, cash: 0 } }),
      asset('IRP (안전형)', 'pension', 'safe', 7000, { group: '퇴직 IRP' }),
    ];
    const [m] = mergeAccounts(rows);
    expect(m.alloc).toEqual({ equity: 30, bond: 0, alt: 0, cash: 70 });
    expect(m.nature).toBe('safe');
    // 비율이 하나도 없으면 예전처럼 alloc 없음
    const plain = rows.map((r) => {
      const { alloc: _a, ...rest } = r;
      void _a;
      return rest;
    });
    expect(mergeAccounts(plain)[0].alloc).toBeUndefined();
  });

  it('리밸런싱: 비율을 넣은 줄은 위험자산 몫만 투자형으로 세고, 줄을 나누지 않고 비율만 바꿈', () => {
    const assets = [
      asset('연금저축', 'pension', 'invest', 4000, { id: 1, alloc: { equity: 80, bond: 10, alt: 10, cash: 0 } }),
      asset('ISA', 'etf', 'invest', 4000, { id: 2, alloc: { equity: 75, bond: 25, alt: 0, cash: 0 } }),
      asset('예금', 'deposit', 'safe', 2000, { id: 3 }),
    ];
    // 투자형 = 3600 + 3000 = 6600(66%) → 목표 50%: 1,600을 안전형으로
    const r = rebalance(assets, 50, Y);
    expect(r.invest).toBeCloseTo(6600, 9);
    expect(r.needed).toBe(true);
    expect(r.shift).toBeCloseTo(1600, 9);
    expect(r.general.amount).toBe(0); // 비율 없는 예금은 안전형이라 팔 것이 없음
    expect(r.pensions).toHaveLength(1);
    expect(r.accounts).toHaveLength(1);
    // 바꿀 수 있는 금액(위험자산 몫) 3600 : 3000 비례
    expect(r.pensions[0].move).toBeCloseTo((1600 * 3600) / 6600, 6);
    expect(r.pensions[0].alloc).toEqual({ equity: 80, bond: 10, alt: 10, cash: 0 });
    const next = r.pensions[0].next!;
    expect(next.equity + next.alt).toBeCloseTo(90 - (r.pensions[0].move / 4000) * 100, 0);
    expect(r.accounts[0].name).toBe('ISA');
    // 바꾼 뒤 전체 투자형이 목표와 같음
    const after = assets.map((a) => (a.id === 1 ? { ...a, alloc: next } : a.id === 2 ? { ...a, alloc: r.accounts[0].next! } : a));
    expect(rebalance(after, 50, Y).current).toBeCloseTo(50, 0);
  });

  it('리밸런싱: IRP 70% 한도는 비율의 위험자산 몫으로 계좌 전체를 봄', () => {
    const assets = [
      asset('퇴직 IRP', 'pension', 'safe', 10000, { id: 1, pensionKind: 'irp', alloc: { equity: 60, bond: 20, alt: 0, cash: 20 } }),
      asset('예금', 'deposit', 'safe', 2000, { id: 2 }),
    ];
    // 투자형 6000(50%) → 목표 80%(3,600 더): IRP 안에서는 7000 − 6000 = 1000까지만, 예금 2000을 더해도 600 모자람
    const r = rebalance(assets, 80, Y);
    expect(r.pensions[0]).toMatchObject({ capped: true });
    expect(r.pensions[0].limit).toBeCloseTo(1000, 6);
    expect(r.pensions[0].move).toBeCloseTo(1000, 6);
    expect(r.outside).toBeCloseTo(600, 6); // 한도에 걸려 계좌 밖으로 빼야 맞춰지는 금액
  });

  it('비율 반영: 기대수익률·변동성이 배분 계산값이면 새 비율로 다시, 직접 넣은 값이면 그대로', () => {
    const x = { equity: 60, bond: 25, alt: 5, cash: 10 };
    const auto = asset('IRP', 'pension', 'invest', 1000, { alloc: x, expectedReturn: allocReturn(x).ret, volatility: allocReturn(x).vol });
    const next = { equity: 40, bond: 45, alt: 5, cash: 10 };
    const out = allocSwitch(auto, next);
    expect(out).toMatchObject({ alloc: next, nature: 'safe', ...((r) => ({ expectedReturn: r.ret, volatility: r.vol }))(allocReturn(next)) });
    const own = allocSwitch({ ...auto, expectedReturn: 6, volatility: 12 }, next);
    expect(own).toMatchObject({ expectedReturn: 6, volatility: 12 });
  });

  it('자산군 목표와 지금의 차이', () => {
    const rows = [asset('ETF', 'etf', 'invest', 6000), asset('예금', 'deposit', 'safe', 4000)];
    const g = classGaps(rows, { equity: 50, bond: 30, alt: 10, cash: 10 });
    expect(g.map((x) => [x.key, Math.round(x.diff)])).toEqual([['equity', -1000], ['bond', 3000], ['alt', 1000], ['cash', -3000]]);
  });

  it('분산 점검: 비율을 넣었으면 자산군 수와 주식형 쏠림도 봄', () => {
    const d = sampleData(Y);
    const plain = riskChecks(d.profile, d.assets, summarize(d.profile, d.assets, d.liabilities, d.cashflows, Y)).find((c) => c.key === 'diversification')!;
    expect(plain.value).toMatch(/^\d+종$/);
    const assets = d.assets.map((a) => (a.type === 'pension' ? { ...a, alloc: { equity: 60, bond: 40, alt: 0, cash: 0 } } : a));
    const c = riskChecks(d.profile, assets, summarize(d.profile, assets, d.liabilities, d.cashflows, Y)).find((x) => x.key === 'diversification')!;
    expect(c.value).toMatch(/종 · 자산군 \d개$/);
    expect(c.detail).toContain('주식형');
  });

  it('인출 바구니: 비율을 넣은 연금계좌는 지금 배분과 목표 차이, 하락장에 버틸 햇수', () => {
    const acct = (name: string, start: number, drawn: number[]) => drawn.map((x) => ({ name, owner: 'self' as const, yearNo: 5, limit: Infinity, start, drawn: x, tax: 0, over: 0, freeLeft: 0, retireLeft: 0 }));
    const a = acct('연금저축', 10000, [1000, 1000, 500, 500, 500, 500]);
    const rows = a.map((x) => ({ accounts: [x] })) as unknown as TaxResult['rows'];
    const tax = { rows, totalTax: 0, overYears: [], limitWarnings: [], depletedAge: null } as unknown as TaxResult;
    const assets = [asset('연금저축', 'pension', 'invest', 10000, { alloc: { equity: 70, bond: 10, alt: 10, cash: 10 } })];
    const [b] = accountBuckets(tax, 0.1, false, assets);
    expect(b.now).toEqual({ equity: 7000, bond: 1000, alt: 1000, cash: 1000 });
    expect(bucketGap(b)).toEqual({ cash: 1000, bond: 500, growth: -1500, alt: 0 });
    expect(b.yearDraw).toBe(1000);
    expect(safeYears(b)).toBeCloseTo(2, 9);
    // 비율이 없으면 지금 배분 없음
    expect(accountBuckets(tax, 0.1, false, [asset('연금저축', 'pension', 'invest', 10000)])[0].now).toBeUndefined();
    // 계좌 종류로 70% 한도
    expect(accountBuckets(tax, 0.1, false, [{ ...assets[0], pensionKind: 'dc' }])[0].capped).toBe(true);
  });

  it('인출 바구니 합계: 비율을 넣은 계좌만 더한 지금 배분과 목표 차이, 첫 인출 연도', () => {
    const acct = (name: string, start: number, drawn: number[]) => drawn.map((x, i) => ({ year: 2026 + i, x: { name, owner: 'self' as const, yearNo: 5, limit: Infinity, start, drawn: x, tax: 0, over: 0, freeLeft: 0, retireLeft: 0 } }));
    const a = acct('연금저축', 10000, [1000, 1000, 500, 500, 500, 500]);
    // 55세 전이라 2027년부터 꺼내는 IRP
    const b = acct('배우자 IRP', 5000, [0, 400, 400, 400, 400, 400]);
    const rows = a.map((r, i) => ({ year: r.year, accounts: [r.x, b[i].x] })) as unknown as TaxResult['rows'];
    const tax = { rows, totalTax: 0, overYears: [], limitWarnings: [], depletedAge: null } as unknown as TaxResult;
    const withAlloc = [asset('연금저축', 'pension', 'invest', 10000, { alloc: { equity: 70, bond: 10, alt: 10, cash: 10 } })];
    const list = accountBuckets(tax, 0.1, false, withAlloc);
    expect(list.map((x) => x.firstDraw)).toEqual([2026, 2027]);
    expect(list[1].cash).toBe(400);
    // ① 현금성 기간 가운데 실제로 꺼내는 해만(55세 전인 2026년은 없음)
    expect(list[1].cashDraws).toEqual([{ year: 2027, amount: 400 }]);
    expect(list[0].cashDraws).toEqual([{ year: 2026, amount: 1000 }, { year: 2027, amount: 1000 }]);
    // 첫해가 일부면 3년치
    expect(accountBuckets(tax, 0.1, true)[1].cashDraws.map((x) => x.year)).toEqual([2027, 2028]);
    // 비율 없는 IRP는 합계 차이에서 뺌
    const t = bucketTotalGap(list)!;
    expect(t).toMatchObject({ count: 1, all: false, balance: 10000 });
    expect(t.gap).toEqual(bucketGap(list[0]));
    expect(t.riskShare).toBeCloseTo(80, 9);
    // 둘 다 비율을 넣으면 두 계좌를 더함
    const both = accountBuckets(tax, 0.1, false, [...withAlloc, asset('배우자 IRP', 'pension', 'invest', 5000, { alloc: { equity: 0, bond: 0, alt: 0, cash: 100 } })]);
    const t2 = bucketTotalGap(both)!;
    expect(t2.all).toBe(true);
    expect(t2.now.cash).toBeCloseTo(6000, 9);
    expect(t2.gap.cash).toBeCloseTo(2400 - 6000, 9);
    expect(bucketTotalGap(accountBuckets(tax, 0.1))).toBeUndefined();
  });

  it('1월 리밸런싱 할 일: 바구니 합계 차이로 자산군별 더 채울·줄일 금액', () => {
    const g = { count: 2, all: true, balance: 10000, now: { cash: 0, bond: 0, equity: 0, alt: 0 }, gap: { cash: 1200, bond: -30, growth: -1500, alt: 330 }, riskShare: 0 };
    // 평가액의 0.5%(50만원) 미만 차이(채권 −30만원)는 뺌
    expect(bucketRebalanceTodo(g, '1월 리밸런싱')).toBe('1월 리밸런싱 때 연금계좌 바구니 맞추기: 현금성 1,200만원 더 채우기 · 성장 1,500만원 줄이기 · 대체 330만원 더 채우기');
    expect(bucketRebalanceTodo({ ...g, all: false, count: 1 }, '1월 리밸런싱')!.endsWith('(비율을 넣은 1개 계좌 기준)')).toBe(true);
    expect(bucketRebalanceTodo({ ...g, gap: { cash: 10, bond: -10, growth: 0, alt: 0 } }, '1월 리밸런싱')).toBeUndefined();
    // 이정표: 2월부터는 내년 할 일에
    const p = sampleData().profile;
    const rebal = { gap: g, nextYear: true, when: '내년 1월 리밸런싱(2027년 1월)' };
    expect(yearTodos(p, [], 2026, 2026, [], 3, [], undefined, null, null, null, rebal).some((x) => x.includes('바구니 맞추기'))).toBe(false);
    expect(yearTodos(p, [], 2026, 2027, [], 3, [], undefined, null, null, null, rebal)).toContain('내년 1월 리밸런싱(2027년 1월) 때 연금계좌 바구니 맞추기: 현금성 1,200만원 더 채우기 · 성장 1,500만원 줄이기 · 대체 330만원 더 채우기');
  });

  it('바구니 대체자산 비중: 저장값이 없으면 연금계좌 비율의 대체자산 비중, 비율이 없으면 10%', () => {
    expect(bucketAltDefault([])).toBe(10);
    const xs = [asset('연금저축', 'pension', 'invest', 1000, { alloc: { equity: 60, bond: 20, alt: 20, cash: 0 } })];
    expect(bucketAltDefault(xs)).toBe(20);
    expect(bucketAltShare(undefined, xs)).toBeCloseTo(0.2, 9);
    expect(bucketAltShare(80, xs)).toBe(0.5);
  });
});
