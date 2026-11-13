import { describe, expect, it } from 'vitest';
import { sampleData } from '../db/sample';
import { fromCSV, toCSV } from '../db/csv';
import type { Asset, Profile } from '../types';
import { buildPlanInput, lockedInflow } from './goals';
import { incomeTaxSchedule, personIncomeTax, wageIncomeAmount } from './incomeTax';
import { goalKind } from './montecarlo';
import { summarize } from './portfolio';
import { convertedDeduction, retireIncomeTax, serviceDeduction, yuLimit, yuPayments, yuPayout, yuPayTo } from './yellowUmbrella';

const Y = 2026;
/** 50세 자영업자(배우자 없음), 60세 은퇴, 사업소득 연 bizIncome(오늘 기준)을 은퇴 전까지 */
function setup(bizIncome: number, extra: Partial<Profile> = {}) {
  const d = sampleData(Y);
  const profile: Profile = {
    ...d.profile,
    birthYear: 1976,
    retireAge: 60,
    lifeExpectancy: 90,
    inflation: 0,
    spouseBirthYear: 0,
    wageGross: 0,
    spouseWageGross: 0,
    incomes: bizIncome > 0 ? [{ name: '가게', monthly: bizIncome / 12, startAge: 50, endAge: 59, growth: 0, step: 1, kind: 'business', expense: 0 }] : [],
    incomeTax: { ...(d.profile.incomeTax ?? {}), on: true, dedSelf: 150 } as Profile['incomeTax'],
    contrib: undefined,
    ...extra,
  };
  const yu: Asset = { name: '노란우산', type: 'other', amount: 3000, expectedReturn: 3, volatility: 0, purpose: 'long', nature: 'safe', lockYear: 2036, yu: true, yuPay: 1200, yuJoin: 2016, taxFree: 500 };
  return { d, profile, yu };
}

describe('노란우산공제', () => {
  it('소득공제 한도: 사업소득금액 4,000만 이하 600 · 6,000만 이하 500 · 1억 이하 400 · 초과 200', () => {
    expect(yuLimit(0)).toBe(0);
    expect(yuLimit(4000)).toBe(600);
    expect(yuLimit(4001)).toBe(500);
    expect(yuLimit(6000)).toBe(500);
    expect(yuLimit(10000)).toBe(400);
    expect(yuLimit(10001)).toBe(200);
  });

  it('퇴직소득세: 근속연수공제 → 환산급여 → 환산급여공제 → 기본세율 × 연수 ÷ 12(지방세 포함)', () => {
    expect(serviceDeduction(3)).toBe(300);
    expect(serviceDeduction(10)).toBe(1500);
    expect(serviceDeduction(20)).toBe(4000);
    expect(serviceDeduction(25)).toBe(5500);
    expect(convertedDeduction(500)).toBe(500);
    expect(convertedDeduction(10200)).toBeCloseTo(6260, 6);
    // 1억, 10년: (10,000 − 1,500) × 12 ÷ 10 = 10,200 → 과표 3,940 → 465 × 10/12 × 1.1
    expect(retireIncomeTax(10000, 10)).toBeCloseTo((465 * 10) / 12 * 1.1, 6);
    expect(retireIncomeTax(0, 10)).toBe(0);
  });

  it('납입은 명의자 은퇴 전 해까지(수령 연도 전 해를 넘지 않음), 마지막 납입 연도를 넣으면 그 해까지', () => {
    const { profile, yu } = setup(3000);
    expect(yuPayTo(yu, profile)).toBe(2035); // 은퇴 2036 − 1, 수령 2036 − 1
    expect(yuPayTo({ ...yu, lockYear: 2030 }, profile)).toBe(2029);
    expect(yuPayTo({ ...yu, yuPayTo: 2028 }, profile)).toBe(2028);
    expect(yuPayments([yu], profile, Y)).toHaveLength(10);
    // 표시하지 않았거나 수령 연도가 없으면 납입 없음
    expect(yuPayments([{ ...yu, yu: undefined }], profile, Y)).toHaveLength(0);
    expect(yuPayments([{ ...yu, lockYear: 0 }], profile, Y)).toHaveLength(0);
  });

  it('납입하는 해에 사업소득금액 구간 한도까지 소득공제해 종합소득세가 줄어듦', () => {
    const { profile, yu } = setup(3000);
    const r = incomeTaxSchedule(profile, Y, undefined, [yu])[0];
    expect(r.yuPaySelf).toBe(1200);
    expect(r.yuDedSelf).toBe(600);
    expect(r.taxSelf).toBeCloseTo(personIncomeTax(3000, 750), 6);
    expect(r.yuSave).toBeCloseTo(personIncomeTax(3000, 150) - personIncomeTax(3000, 750), 6);
    // 1억 넘으면 200만
    const big = incomeTaxSchedule(setup(12000).profile, Y, undefined, [yu])[0];
    expect(big.yuDedSelf).toBe(200);
    // 은퇴(2036년) 뒤에는 납입·공제 없음
    expect(incomeTaxSchedule(profile, Y, undefined, [yu]).find((x) => x.year === 2036)!.yuDedSelf).toBe(0);
  });

  it('사업소득이 없으면: 총급여 8,000만 이하면 법인 대표자로 근로소득금액 기준, 넘으면 공제 없음', () => {
    const { profile, yu } = setup(0);
    expect(incomeTaxSchedule(profile, Y, undefined, [yu])[0].yuDedSelf).toBe(0);
    const ceo = incomeTaxSchedule({ ...profile, wageGross: 6000 }, Y, undefined, [yu])[0];
    expect(wageIncomeAmount(6000)).toBeCloseTo(4725, 6);
    expect(ceo.yuDedSelf).toBe(500);
    expect(incomeTaxSchedule({ ...profile, wageGross: 9000 }, Y, undefined, [yu])[0].yuDedSelf).toBe(0);
  });

  it('수령액: 앞으로 낼 부금까지 불리고, 소득공제 받은 부금·운용수익만 퇴직소득세(공제 못 받은 부금은 비과세)', () => {
    const { profile, yu } = setup(3000);
    const rows = incomeTaxSchedule(profile, Y, undefined, [yu]);
    const out = lockedInflow(yu, profile, Y, rows);
    let fv = 3000 * Math.pow(1.03, 10);
    for (let y = Y; y <= 2035; y++) fv += 1200 * Math.pow(1.03, 2036 - y - 1);
    // 해마다 1,200 중 600만 공제 → 600 × 10년 + 이미 공제 못 받은 500 은 비과세
    const nonDed = 500 + 600 * 10;
    expect(out.yu!.fv).toBeCloseTo(fv, 4);
    expect(out.yu!.nonDed).toBeCloseTo(nonDed, 4);
    expect(out.yu!.years).toBe(20);
    expect(out.yu!.tax).toBeCloseTo(retireIncomeTax(fv - nonDed, 20), 4);
    expect(out.nominal).toBeCloseTo(fv - out.yu!.tax, 4);
    // 수령 시 세율을 직접 넣으면 적립금 × 세율(예전 방식)
    const fixed = yuPayout({ ...yu, lockTax: 4 }, profile, Y);
    expect(fixed.auto).toBe(false);
    expect(fixed.tax).toBeCloseTo(fv * 0.04, 4);
  });

  it('노후 진단 입력: 납입은 해마다 금융자산에서 빠지고, 줄어든 종소세는 다음 해 들어옴', () => {
    const { d, profile, yu } = setup(3000);
    const assets: Asset[] = [{ name: '예금', type: 'deposit', amount: 10000, expectedReturn: 3, volatility: 0.5, purpose: 'short', nature: 'safe' }, yu];
    const s = summarize(profile, assets, [], d.cashflows, Y, d.insurance);
    const inp = buildPlanInput(profile, assets, [], [], s);
    const pays = inp.goals.filter((g) => goalKind(g) === 'yuPay');
    expect(pays.map((g) => g.age)).toEqual([50, 51, 52, 53, 54, 55, 56, 57, 58, 59]);
    expect(pays[0].amount).toBe(1200);
    const save = inp.inflows!.filter((x) => x.kind === 'yuSave');
    expect(save[0].age).toBe(51);
    expect(save[0].amount).toBeCloseTo(personIncomeTax(3000, 150) - personIncomeTax(3000, 750), 6);
    const lump = inp.inflows!.find((x) => !x.kind)!;
    expect(lump.age).toBe(60);
    expect(lump.amount).toBeCloseTo(lockedInflow(yu, profile, Y, incomeTaxSchedule(profile, Y, undefined, assets), s.yearShare ?? 1).amount, 4);
  });

  it('CSV 왕복: 노란우산 열은 노란우산 행에서만, 과세제외 금액은 연금·노란우산 행에서만', () => {
    const { yu } = setup(3000);
    const plain: Asset = { name: '예금', type: 'deposit', amount: 100, expectedReturn: 3, volatility: 0.5, purpose: 'short', nature: 'safe', taxFree: 9, yuPay: 7 };
    const csv = toCSV('assets', [yu, plain] as never);
    expect(csv.split(/\r?\n/)[0]).toContain('노란우산 연 납입액');
    const { rows, errors } = fromCSV('assets', csv);
    expect(errors).toEqual([]);
    expect(rows[0]).toEqual(yu);
    expect(rows[0]).toMatchObject({ yu: true, yuPay: 1200, yuJoin: 2016, taxFree: 500, lockYear: 2036 });
    expect(rows[1]).not.toHaveProperty('taxFree');
    expect(rows[1]).not.toHaveProperty('yuPay');
    expect(rows[1]).not.toHaveProperty('yu');
  });
});
