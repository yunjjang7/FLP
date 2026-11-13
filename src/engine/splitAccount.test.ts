import { describe, expect, it } from 'vitest';
import { sampleData } from '../db/sample';
import type { Asset, Draw } from '../types';
import { carryOverPlan, reviewDraws } from './drawLog';
import { milestones, yearTodos } from './milestones';
import { accountName, mergeAccounts } from './portfolio';
import { rebalance, splitAccount, switchPlan } from './rebalance';
import { pensionTaxSchedule, taxSetup } from './tax';

/**
 * 리밸런싱 ‘자산 탭에 반영’으로 연금계좌 한 줄을 투자형·안전형 두 줄로 나눠도
 * 계좌 하나로 계산되는지: 나누기 전과 결과가 같아야 함.
 */
const Y = 2026;
const profile = () => ({ ...sampleData(Y).profile, birthYear: 1968, retireAge: 58, spouseBirthYear: 0, inflation: 0, retireTaxRate: 10, retireTaxYear1: 2024, retireMinDraw: 12 });
const base = { type: 'pension' as const, expectedReturn: 0, volatility: 0, purpose: 'long' as const };
const irp: Asset = { ...base, id: 1, name: '퇴직 IRP', nature: 'safe', amount: 10000, taxFree: 1000, retirePart: 4000, pensionYear1: 2024 };
const saving: Asset = { ...base, id: 2, name: '연금저축', nature: 'invest', amount: 5000, pensionYear1: 2010 };
const isa: Asset = { id: 3, name: 'ISA', type: 'etf', nature: 'invest', amount: 3000, expectedReturn: 0, volatility: 0, purpose: 'long' };
const before = [irp, saving, isa];
// IRP 안전형 10,000 중 4,000을 투자형으로 바꿔 두 줄로 나눔(새 줄은 맨 뒤에 붙음)
const [keep, add] = splitAccount(irp, 4000, before);
const after = [{ ...keep }, saving, isa, { ...add, id: 4 }];
const row = (age: number, withdrawal: number) => ({ age, pension: 0, withdrawal, income: withdrawal, need: withdrawal, endBalance: 0, inflow: 0 });
const sched = [row(58, 0), row(59, 2000), row(60, 3000), row(61, 500)];
const run = (assets: Asset[]) => pensionTaxSchedule(sched, taxSetup(profile(), assets, Y, 18000, 0)!);

describe('나눈 연금계좌는 계좌 하나로 계산', () => {
  it('두 줄 모두 같은 계좌 이름(group)을 갖고, 합치면 나누기 전 줄과 같음', () => {
    expect(keep.group).toBe('퇴직 IRP');
    expect(add.group).toBe('퇴직 IRP');
    expect(accountName(add)).toBe('퇴직 IRP');
    const [m] = mergeAccounts(after);
    expect(m).toMatchObject({ name: '퇴직 IRP', amount: 10000, taxFree: 1000, retirePart: 4000, pensionYear1: 2024, nature: 'safe' });
    expect(mergeAccounts(after)).toHaveLength(3);
    // 묶이지 않은 줄은 그대로
    expect(mergeAccounts(before)).toEqual(before);
  });

  it('연금 세금: 계좌 수·인출 순서·수령한도·세금·퇴직금 최소 인출이 나누기 전과 같음', () => {
    const a = run(before);
    const b = run(after);
    expect(b.rows[0].accounts.map((x) => x.name)).toEqual(['퇴직 IRP', '연금저축']); // 새 줄이 맨 뒤로 가지 않음
    for (let i = 0; i < sched.length; i++) {
      const [x, y] = [a.rows[i], b.rows[i]];
      expect(y.accounts).toHaveLength(x.accounts.length);
      y.accounts.forEach((acc, j) => {
        expect(acc.limit).toBeCloseTo(x.accounts[j].limit, 6);
        expect(acc.drawn).toBeCloseTo(x.accounts[j].drawn, 6);
      });
      expect(y.tax).toBeCloseTo(x.tax, 6);
      expect(y.reinvest).toBeCloseTo(x.reinvest, 6); // 퇴직금 최소 인출이 두 번 잡히지 않음
      expect(y.retireNo).toBe(x.retireNo);
    }
    // 쓸 일이 없는 해의 최소 인출은 한 번(12만)만
    expect(b.rows[0].accounts.reduce((s, x) => s + x.drawn, 0)).toBeCloseTo(12, 6);
    expect(b.totalTax).toBeCloseTo(a.totalTax, 6);
  });

  it('꺼내는 순서를 직접 넣었으면 그 순서(줄 가운데 가장 작은 값)', () => {
    const ordered = after.map((x) => (x.name === '연금저축' ? { ...x, drawOrder: 2 } : x.group ? { ...x, drawOrder: x.id === 4 ? 1 : 3 } : x));
    expect(run(ordered).rows[0].accounts.map((x) => x.name)).toEqual(['퇴직 IRP', '연금저축']);
  });

  it('이정표·올해 할 일에 같은 계좌 이름이 두 번 나오지 않음', () => {
    const p = { ...profile(), birthYear: 1975 };
    const assets = after.map((x) => ({ ...x, pensionYear1: 2030, ...(x.group ? { drawStartYear: 2031 } : {}) }));
    const list = milestones(p, assets, [], [], Y, 1);
    const open = list.find((m) => m.label.includes('인출 시작'))!;
    expect(open.label).toBe('퇴직 IRP 인출 시작 — 연금 개시 신청');
    expect(list.find((m) => m.label.includes('수령한도 없음'))!.label).toBe('퇴직 IRP·연금저축 연금수령 11년차 → 수령한도 없음');
    expect(list.find((m) => m.kind === 'open' && m.label.includes('만 55세'))!.note).toBe('퇴직 IRP, 연금저축');
    expect(yearTodos(p, assets, Y, 2031)[0]).toContain('퇴직 IRP 연금 개시 신청');
    expect(yearTodos(p, assets, Y, 2031).join()).not.toContain('(투자형)');
  });

  it('월별 인출 기록·연말결산: 계좌 이름으로 적은 인출이 두 줄 모두에 반영', () => {
    const tax = run(after);
    const draws: Draw[] = [{ month: '2027-03', account: '퇴직 IRP', amount: 1500 }];
    const rv = reviewDraws(tax.rows[1], 2027, draws, { nowYear: 2027, nowMonth: 12 });
    expect(rv.accounts.filter((a) => a.planned).map((a) => a.name)).toEqual(['퇴직 IRP', '연금저축', 'ISA·일반']);
    expect(rv.accounts[0].actual).toBe(1500);
    // 1,500 인출: 과세제외 1,000 → 퇴직금 재원 500을 두 줄의 재원 비율(6:4)로 나눠 줄임
    const rows = carryOverPlan(after, [{ id: 1, name: keep.name, balance: 5000 }, { id: 4, name: add.name, balance: 3500 }], draws, 2027);
    expect(rows.map((r) => r.drawn)).toEqual([1500, 1500]);
    expect(rows[0]).toMatchObject({ freeNext: 0, retireNext: 2400 - 300 });
    expect(rows[1]).toMatchObject({ freeNext: 0, retireNext: 1600 - 200 });
    // 묶지 않은 한 줄과 합계가 같음
    const [one] = carryOverPlan(before, [{ id: 1, name: '퇴직 IRP', balance: 8500 }], draws, 2027);
    expect(rows[0].freeNext + rows[1].freeNext).toBeCloseTo(one.freeNext, 6);
    expect(rows[0].retireNext + rows[1].retireNext).toBeCloseTo(one.retireNext, 6);
  });
});

describe('나눈 퇴직연금 계좌의 위험자산 70% 한도는 계좌 전체로', () => {
  const others: Asset[] = [{ id: 9, name: '예금', type: 'deposit', nature: 'safe', amount: 10000, expectedReturn: 0, volatility: 0, purpose: 'short' }];
  it('이미 투자형 4,000을 담았으면 안전형 줄에서 바꿀 수 있는 금액은 7,000 − 4,000 = 3,000', () => {
    const r = rebalance([...after, ...others].filter((x) => x.name !== '연금저축' && x.name !== 'ISA'), 100, Y);
    const sw = r.pensions.find((x) => x.id === 1)!;
    expect(sw.limit).toBeCloseTo(3000, 6);
    expect(sw.move).toBeCloseTo(3000, 6);
    // 나누기 전(한 줄)에는 7,000까지
    expect(rebalance([irp, ...others], 100, Y).pensions[0].limit).toBeCloseTo(7000, 6);
  });

  it('70%를 다 채운 계좌는 더 바꾸라고 하지 않음', () => {
    const [k, a] = splitAccount(irp, 7000);
    const r = rebalance([k, { ...a, id: 4 }, ...others], 100, Y);
    expect(r.pensions.find((x) => x.id === 1)?.move ?? 0).toBeCloseTo(0, 6);
  });
});

describe('같은 계좌에 반대 성격 줄이 있으면 새 줄을 만들지 않고 옮김(switchPlan)', () => {
  const rows = [{ ...keep }, { ...add, id: 4 }];
  it('일부만 옮기면 두 줄 금액·재원만 바뀜', () => {
    const plan = switchPlan(rows[1], 1000, rows); // 투자형 4,000 → 안전형으로 1,000
    expect(plan.add).toEqual([]);
    expect(plan.remove).toEqual([]);
    const [k2, s2] = plan.put;
    expect(k2).toMatchObject({ id: 4, amount: 3000, nature: 'invest' });
    expect(s2).toMatchObject({ id: 1, amount: 7000, nature: 'safe', name: '퇴직 IRP' });
    expect(k2.taxFree! + s2.taxFree!).toBeCloseTo(1000, 6);
    expect(k2.retirePart! + s2.retirePart!).toBeCloseTo(4000, 6);
  });

  it('다 옮기면 원래 줄을 지우고, 반대 성격 줄이 없으면 두 줄로 나눔', () => {
    const all = switchPlan(rows[1], 4000, rows);
    expect(all.remove).toEqual([4]);
    expect(all.put[0]).toMatchObject({ id: 1, amount: 10000, taxFree: 1000, retirePart: 4000 });
    const fresh = switchPlan(irp, 2000, [irp]);
    expect(fresh.put).toHaveLength(1);
    expect(fresh.add).toHaveLength(1);
    expect(fresh.add[0]).toMatchObject({ group: '퇴직 IRP', nature: 'invest', amount: 2000 });
  });
});
