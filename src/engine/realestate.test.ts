import { describe, expect, it } from 'vitest';
import { sampleData } from '../db/sample';
import type { Asset } from '../types';
import { buildPlanInput, planGoals } from './goals';
import { incomeTaxSchedule } from './incomeTax';
import { incomeValue, inflowAt } from './montecarlo';
import { summarize } from './portfolio';
import { bucketMap } from './prescribe';
import { rentStreams, rentYield, saleInflow, selfShare } from './realestate';

const Y = 2026;
const rental = (over: Partial<Asset> = {}): Asset => ({
  name: '오피스텔', type: 'realestate', amount: 30000, expectedReturn: 3, volatility: 8, purpose: 'long', nature: 'invest',
  reUse: 'rental', rent: 100, deposit: 5000, renewCycle: 2, renewRate: 5, rentCost: 10, ...over,
});

describe('부동산', () => {
  it('지분: 본인 1 · 배우자 0 · 공동명의는 본인 지분율', () => {
    expect(selfShare(rental())).toBe(1);
    expect(selfShare(rental({ owner: 'spouse' }))).toBe(0);
    expect(selfShare(rental({ owner: 'joint' }))).toBe(0.5);
    expect(selfShare(rental({ owner: 'joint', ownerShare: 70 }))).toBeCloseTo(0.7, 9);
  });

  it('임대보증금은 부채, 부동산은 용도 바구니·목적자금에서 빠짐', () => {
    const d = sampleData(Y);
    const base = summarize(d.profile, d.assets, d.liabilities, d.cashflows, Y);
    const assets = [...d.assets, rental()];
    const s = summarize(d.profile, assets, d.liabilities, d.cashflows, Y);
    expect(s.depositDebt).toBe(5000);
    expect(s.totalDebt).toBe(base.totalDebt + 5000);
    expect(s.netWorth).toBe(base.netWorth + 30000 - 5000);
    // 용도별 합계는 금융자산만, 부동산은 용도별로 따로
    expect(s.byPurpose.reduce((a, x) => a + x.value, 0)).toBe(s.financialAssets);
    expect(s.byReUse.find((x) => x.key === 'home')?.value).toBe(75000);
    expect(s.byReUse.find((x) => x.key === 'rental')?.value).toBe(30000);
    const b = bucketMap(d.profile, s, []);
    expect(b.reduce((a, x) => a + x.target, 0)).toBeCloseTo(s.financialAssets, 6);
    // 중기 용도로 잘못 넣어도 목적자금 배정에 쓰지 않음
    const mid = [...d.assets.filter((a) => a.purpose !== 'mid'), { ...rental(), purpose: 'mid' as const }];
    expect(planGoals(d.goals, mid, 45).every((g) => g.allocated === 0)).toBe(true);
  });

  it('임대수익률 = 연 월세 ÷ (시세 − 보증금)', () => {
    expect(rentYield(rental())).toBeCloseTo((100 * 12 * 100) / 25000, 9);
  });

  it('월세: 은퇴 후 소득(경비 차감), 갱신 주기마다 인상, 매각 전 해까지', () => {
    const d = sampleData(Y); // 45세, 은퇴 60세
    const a = rental({ lockYear: Y + 25 }); // 70세 매각
    const [cash] = rentStreams([a], d.profile, 45);
    expect(cash.startAge).toBe(60);
    expect(cash.endAge).toBe(69);
    expect(cash.annual).toBeCloseTo(100 * 12 * 0.9, 9);
    // 45세부터 2년마다 5%: 60세는 7회 인상
    expect(incomeValue(cash, 60, 0)).toBeCloseTo(1080 * 1.05 ** 7, 6);
    expect(incomeValue(cash, 70, 0)).toBe(0);
    const [gross] = rentStreams([a], d.profile, 45, true);
    expect(gross.startAge).toBe(45);
    expect(gross.annual).toBe(1200);
    // 노후 진단 입력에 월세가 소득으로 들어감
    const plan = buildPlanInput(d.profile, [...d.assets, a], d.liabilities, d.goals, summarize(d.profile, [...d.assets, a], d.liabilities, d.cashflows, Y));
    expect(plan.pensions.some((x) => x.name === '오피스텔 월세')).toBe(true);
  });

  it('매각: 시세 상승 − 비용 − 보증금 − 새 집 = 순매각대금(현재가치)이 매각 나이에 들어옴', () => {
    const d = sampleData(Y);
    const home: Asset = { ...d.assets.find((x) => x.type === 'realestate')!, lockYear: Y + 20, lockTax: 1, reBuy: 40000 };
    const s = saleInflow(home, d.profile, Y);
    const g = 1.03 ** 20;
    expect(s.price).toBeCloseTo(75000 * g, 6);
    expect(s.nominal).toBeCloseTo(75000 * g * 0.99 - 40000 * g, 6);
    expect(s.amount).toBeCloseTo(s.nominal / 1.025 ** 20, 6);
    const r = saleInflow(rental({ lockYear: Y + 10, lockTax: 0 }), d.profile, Y);
    expect(r.nominal).toBeCloseTo(30000 * 1.03 ** 10 - 5000, 6); // 보증금 반환
    const assets = d.assets.map((x) => (x.name === home.name ? home : x));
    const plan = buildPlanInput(d.profile, assets, d.liabilities, d.goals, summarize(d.profile, assets, d.liabilities, d.cashflows, Y));
    expect(inflowAt(plan, 65)).toBeCloseTo(s.amount, 6);
    expect(plan.inflows?.find((x) => x.kind === 'sale')?.age).toBe(65);
    // 매각 연도가 지났으면 무시
    const past = d.assets.map((x) => (x.name === home.name ? { ...home, lockYear: Y - 1 } : x));
    expect(buildPlanInput(d.profile, past, d.liabilities, d.goals, summarize(d.profile, past, d.liabilities, d.cashflows, Y)).inflows ?? []).toEqual([]);
  });

  it('임대소득 종소세: 부동산 자산은 명의·지분대로 나눔', () => {
    const d = sampleData(Y);
    const p = { ...d.profile, incomes: [], incomeTax: { on: true } as never };
    const joint = incomeTaxSchedule(p, Y, undefined, [rental({ owner: 'joint', ownerShare: 70 })])[0];
    expect(joint.rent).toBeCloseTo(1200, 6);
    expect(joint.rentSelf).toBeCloseTo(1200 * 0.7, 6);
    expect(joint.rentSpouse).toBeCloseTo(1200 * 0.3, 6);
    const sp = incomeTaxSchedule(p, Y, undefined, [rental({ owner: 'spouse' })])[0];
    expect(sp.rentSelf).toBe(0);
    expect(sp.rentSpouse).toBeCloseTo(1200, 6);
  });
});
