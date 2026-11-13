import { describe, expect, it } from 'vitest';
import { sampleData } from '../db/sample';
import { fromCSV, toCSV } from '../db/csv';
import type { Asset, Profile } from '../types';
import { buildPlanInput, lockedInflow } from './goals';
import { contribSchedule, creditInflows, incomeTaxSchedule, personIncomeTax, wageIncomeAmount } from './incomeTax';
import { goalKind, outflowAt } from './montecarlo';
import { milestones, yearTodos } from './milestones';
import { summarize } from './portfolio';
import { taxSetup } from './tax';
import { convertedDeduction, retireIncomeTax, serviceDeduction, yuLimit, yuPayments, yuPayout, yuPayTo, yuService } from './yellowUmbrella';

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
    // 공제가 0이면 앞으로 낼 부금 전부가 ‘공제 안 받은 부금’(비과세): 지금까지 입력한 500과 합쳐 과세 대상에서 빠짐
    const out = lockedInflow(yu, profile, Y, incomeTaxSchedule(profile, Y, undefined, [yu])).yu!;
    expect(out.futureNonDed).toBeCloseTo(1200 * 10, 6);
    expect(out.nonDed).toBeCloseTo(500 + 1200 * 10, 6);
    expect(out.taxable).toBeCloseTo(out.fv - out.nonDed, 6);
    // 사업소득이 있으면 한도(600)를 넘는 부금만 비과세
    const { profile: biz } = setup(3000);
    expect(lockedInflow(yu, biz, Y, incomeTaxSchedule(biz, Y, undefined, [yu])).yu!.futureNonDed).toBeCloseTo(600 * 10, 6);
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

  it('올해 남은 달이 6개월이면 올해 부금·소득공제·금융자산 지출이 모두 연 납입액의 절반, 다음 해부터 1년치', () => {
    const { d, profile, yu: base } = setup(3000);
    const yu: Asset = { ...base, yuPay: 400 }; // 한도(600) 안이라 낸 만큼 모두 공제
    const assets: Asset[] = [{ name: '예금', type: 'deposit', amount: 10000, expectedReturn: 3, volatility: 0.5, purpose: 'short', nature: 'safe' }, yu];
    const s = summarize(profile, assets, [], d.cashflows, Y, d.insurance, 7); // 7월: 7~12월 6개월 남음
    expect(s.yearShare).toBeCloseTo(0.5, 10);
    const inp = buildPlanInput(profile, assets, [], [], s);
    // 금융자산 지출: 올해 200(시뮬레이션이 첫해를 또 줄이지 않음), 다음 해 400
    const pays = inp.goals.filter((g) => goalKind(g) === 'yuPay');
    expect(pays[0].amount * (pays[0].flow ? 0.5 : 1)).toBeCloseTo(200, 10);
    expect(outflowAt(inp, 50, 0, 0.5) - outflowAt({ ...inp, goals: inp.goals.filter((g) => goalKind(g) !== 'yuPay') }, 50, 0, 0.5)).toBeCloseTo(200, 10);
    expect(pays[1].amount).toBeCloseTo(400, 10);
    // 소득공제·종소세 감소: 올해 200, 다음 해 400
    const rows = incomeTaxSchedule(profile, Y, undefined, assets, [], s.yearShare);
    expect(rows[0].yuPaySelf).toBeCloseTo(200, 10);
    expect(rows[0].yuDedSelf).toBeCloseTo(200, 10);
    expect(rows[1].yuPaySelf).toBeCloseTo(400, 10);
    expect(rows[1].yuDedSelf).toBeCloseTo(400, 10);
    const save = inp.inflows!.filter((x) => x.kind === 'yuSave');
    expect(save[0].amount).toBeCloseTo(personIncomeTax(3000, 150) - personIncomeTax(3000, 350), 6);
    expect(save[1].amount).toBeCloseTo(personIncomeTax(3000, 150) - personIncomeTax(3000, 550), 6);
    // 적립금: 같은 부금(올해 200 + 400 × 9년)
    const out = yuPayout(yu, profile, Y, undefined, s.yearShare);
    expect(out.paid).toBeCloseTo(200 + 400 * 9, 10);
    expect(yuPayments([yu], profile, Y, s.yearShare).map((x) => x.amount)).toEqual([200, ...Array(9).fill(400)]);
  });

  it('마지막 해 3개월이면 그 해 부금·소득공제가 1/4이고 수령액이 그만큼 줄어듦, 비우면 지금과 같음', () => {
    const { profile, yu: base } = setup(3000);
    const yu: Asset = { ...base, yuPay: 400 }; // 한도(600) 안
    const short: Asset = { ...yu, yuLastMonths: 3 };
    const pays = yuPayments([short], profile, Y);
    expect(pays.at(-1)).toMatchObject({ year: 2035, amount: 100 });
    expect(pays.slice(0, -1).every((x) => x.amount === 400)).toBe(true);
    const rows = incomeTaxSchedule(profile, Y, undefined, [short]);
    expect(rows.find((r) => r.year === 2035)!.yuDedSelf).toBeCloseTo(100, 10);
    expect(rows.find((r) => r.year === 2034)!.yuDedSelf).toBeCloseTo(400, 10);
    const full = yuPayout(yu, profile, Y);
    const cut = yuPayout(short, profile, Y);
    // 2035년 말 납입분은 2036년 수령까지 불어나지 않으므로 적립금이 정확히 300 줄고, 모두 공제받은 부금이라 과세 대상도 300 줄어듦
    expect(full.fv - cut.fv).toBeCloseTo(300, 8);
    expect(full.taxable - cut.taxable).toBeCloseTo(300, 8);
    expect(cut.tax).toBeLessThan(full.tax);
    // 비우면(또는 12개월) 지금과 같은 결과, 1~12 밖의 값은 비운 것으로 봄
    for (const v of [undefined, 12, 0, 13, 2.5]) expect(yuPayout({ ...yu, yuLastMonths: v }, profile, Y)).toEqual(full);
  });

  it('마지막 납입 연도가 올해면 올해 남은 달과 마지막 해 개월이 겹치는 기간만 냄', () => {
    const { profile, yu: base } = setup(3000);
    const yu: Asset = { ...base, yuPay: 1200, yuPayTo: Y };
    const nov = 2 / 12; // 11월: 11·12월 남음
    const now = yuPayments([yu], profile, Y, nov);
    expect(now).toHaveLength(1);
    expect(now[0].amount).toBeCloseTo(200, 10);
    expect(yuPayments([{ ...yu, yuLastMonths: 11 }], profile, Y, nov)[0].amount).toBeCloseTo(100, 10);
    expect(yuPayments([{ ...yu, yuLastMonths: 3 }], profile, Y, nov)).toEqual([]); // 3월에 이미 끝남
    expect(incomeTaxSchedule(profile, Y, undefined, [{ ...yu, yuLastMonths: 3 }], [], nov)[0].yuDedSelf).toBe(0);
  });

  it('프로필 ‘올해 소득공제 1~12월 기준’: 올해 소득공제만 1~12월 전체 납입액으로, 적립금·지출은 남은 달 기준 그대로', () => {
    const { d, profile: base, yu: y0 } = setup(3000);
    const yu: Asset = { ...y0, yuPay: 400 }; // 한도(600) 안이라 낸 만큼 모두 공제
    const assets: Asset[] = [{ name: '예금', type: 'deposit', amount: 10000, expectedReturn: 3, volatility: 0.5, purpose: 'short', nature: 'safe' }, yu];
    const s = summarize(base, assets, [], d.cashflows, Y, d.insurance, 7); // 6개월 남음
    const full: Profile = { ...base, yuDedFullYear: true };
    // 소득공제: 기본은 남은 달분 200, 옵션을 켜면 1~12월 400(다음 해부터는 같음)
    const off = incomeTaxSchedule(base, Y, undefined, assets, [], s.yearShare);
    const on = incomeTaxSchedule(full, Y, undefined, assets, [], s.yearShare);
    expect(off[0].yuDedSelf).toBeCloseTo(200, 10);
    expect(on[0].yuPaySelf).toBeCloseTo(400, 10);
    expect(on[0].yuDedSelf).toBeCloseTo(400, 10);
    expect(on[1].yuDedSelf).toBeCloseTo(off[1].yuDedSelf, 10);
    expect(on[0].yuSave).toBeCloseTo(personIncomeTax(3000, 150) - personIncomeTax(3000, 550), 6);
    // 노후 진단: 절세 유입만 커지고, 금융자산 지출(부금)과 수령 적립금은 같음
    const inpOff = buildPlanInput(base, assets, [], [], s);
    const inpOn = buildPlanInput(full, assets, [], [], s);
    const pay = (inp: typeof inpOff) => inp.goals.filter((g) => goalKind(g) === 'yuPay').map((g) => g.amount);
    expect(pay(inpOn)).toEqual(pay(inpOff));
    expect(pay(inpOn)[0]).toBeCloseTo(200, 10);
    const saveOf = (inp: typeof inpOff) => inp.inflows!.filter((x) => x.kind === 'yuSave')[0].amount;
    expect(saveOf(inpOn)).toBeGreaterThan(saveOf(inpOff));
    expect(yuPayout(yu, full, Y, undefined, s.yearShare).fv).toBeCloseTo(yuPayout(yu, base, Y, undefined, s.yearShare).fv, 10);
    // 올해가 마지막 해(3개월)이고 11월이면: 남은 달 납입은 없지만, 옵션을 켜면 1~3월 납입분 300을 올해 공제
    const last: Asset = { ...y0, yuPay: 1200, yuPayTo: Y, yuLastMonths: 3 };
    const nov = 2 / 12;
    expect(yuPayments([last], full, Y, nov)).toEqual([]);
    expect(incomeTaxSchedule(base, Y, undefined, [last], [], nov)[0].yuDedSelf).toBe(0);
    expect(incomeTaxSchedule(full, Y, undefined, [last], [], nov)[0].yuDedSelf).toBeCloseTo(300, 10);
  });

  it('tax.ts: 연금 추가 납입 세액공제가 노후 진단과 같은 올해 남은 달 기준(노란우산 소득공제로 줄어든 종소세 한도)', () => {
    // 사업소득이 적어 세액공제가 그 해 종소세에서 막히는 경우: 올해 노란우산 공제가 200이냐 400이냐에 따라 세액공제가 달라짐
    const { d, profile: p0, yu: y0 } = setup(1500, { contrib: { self: 900, spouse: 0, from: Y, to: Y + 1, selfRate: 16.5, spouseRate: 0 } });
    const yu: Asset = { ...y0, yuPay: 400 };
    const irp: Asset = { name: 'IRP', type: 'pension', amount: 5000, expectedReturn: 3, volatility: 5, purpose: 'long', nature: 'invest' };
    const assets: Asset[] = [{ name: '예금', type: 'deposit', amount: 10000, expectedReturn: 3, volatility: 0.5, purpose: 'short', nature: 'safe' }, irp, yu];
    for (const profile of [p0, { ...p0, yuDedFullYear: true }]) {
      const s = summarize(profile, assets, [], d.cashflows, Y, d.insurance, 7);
      const inp = buildPlanInput(profile, assets, [], [], s);
      const setupTax = taxSetup(profile, assets, Y, 15000, 3, Y, s.yearShare)!;
      // 노후 진단의 세액공제 환급(다음 해 유입)과 tax.ts 의 세액공제가 같은 금액
      const credits = inp.inflows!.filter((x) => x.kind === 'credit').map((x) => x.amount);
      expect(credits.length).toBe(2);
      expect(creditInflows(profile, Y, setupTax.contrib).map((x) => x.amount)).toEqual(credits);
      expect(setupTax.contrib).toEqual(contribSchedule(profile, incomeTaxSchedule(profile, Y, undefined, assets, [], s.yearShare)));
    }
    // 남은 달 비율을 넘기지 않으면(예전 동작) 올해 공제가 1년치로 커져 세액공제가 달라짐 → 비율이 실제로 쓰인다는 확인
    const s = summarize(p0, assets, [], d.cashflows, Y, d.insurance, 7);
    const share = taxSetup(p0, assets, Y, 15000, 3, Y, s.yearShare)!.contrib[0].creditSelf;
    const whole = taxSetup(p0, assets, Y, 15000, 3, Y)!.contrib[0].creditSelf;
    expect(share).toBeGreaterThan(whole);
  });

  it('이정표·할 일: 소득공제로 줄어든 종합소득세를 납입 다음 해 5월 ‘노란우산 절세 환급’으로, 올해분은 남은 달 기준', () => {
    const { profile, yu: base } = setup(3000);
    const yu: Asset = { ...base, yuPay: 400 }; // 한도(600) 안
    const rows = incomeTaxSchedule(profile, Y, undefined, [yu], [], 0.5); // 7월: 6개월 남음
    const list = milestones(profile, [yu], [], [], Y, 7).filter((m) => m.label === '노란우산 절세 환급');
    // 2026~2035년 납입분 → 2027~2036년 5월, 해마다 한 줄
    expect(list.map((m) => m.year)).toEqual(Array.from({ length: 10 }, (_, i) => Y + 1 + i));
    expect(list.every((m) => m.month === 5 && m.kind === 'tax')).toBe(true);
    expect(list[0].note).toContain(`약 ${Math.round(rows[0].yuSave).toLocaleString('ko-KR')}만원(2026년 납입분`);
    expect(rows[0].yuSave).toBeCloseTo(personIncomeTax(3000, 150) - personIncomeTax(3000, 350), 6); // 올해는 200만 공제
    expect(list[1].note).toContain(`약 ${Math.round(rows[1].yuSave).toLocaleString('ko-KR')}만원(2027년 납입분`);
    // 할 일: 내년(2027) 5월 신고 때 지난해분 환급 확인, 올해는 지난해 납입이 없어 없음
    const todo = yearTodos(profile, [yu], Y, Y + 1, [], 7).find((x) => x.includes('노란우산 절세 환급'));
    expect(todo).toBe(`5월 종합소득세 신고 때 노란우산 절세 환급 확인(지난해 납입분 소득공제, 약 ${Math.round(rows[0].yuSave).toLocaleString('ko-KR')}만원)`);
    expect(yearTodos(profile, [yu], Y, Y, [], 7).some((x) => x.includes('노란우산'))).toBe(false);
    // 사업소득이 없어 공제가 0이면 환급 항목도 없음
    const { profile: none } = setup(0);
    expect(milestones(none, [yu], [], [], Y, 7).some((m) => m.label === '노란우산 절세 환급')).toBe(false);
    expect(yearTodos(none, [yu], Y, Y + 1, [], 7).some((x) => x.includes('노란우산 절세'))).toBe(false);
  });

  it('근속연수: 가입한 달부터 수령한 달까지 개월 수 ÷ 12 올림(1년 미만은 1년), 월을 비우면 연도 차이', () => {
    const { profile, yu } = setup(3000);
    const at = (join: number, jm: number | undefined, lock: number, pm: number | undefined) => yuService({ ...yu, yuJoin: join, yuJoinMonth: jm, lockYear: lock, yuPayoutMonth: pm }, Y);
    expect(at(2020, 9, 2040, 3)).toEqual({ years: 20, months: 234 }); // 19년 6개월
    expect(at(2020, 9, 2040, 10)).toEqual({ years: 21, months: 241 }); // 20년 1개월
    expect(at(2039, 11, 2040, 3)).toEqual({ years: 1, months: 4 }); // 1년 미만 → 1년
    expect(at(2020, 9, 2040, 9)).toEqual({ years: 20, months: 240 });
    expect(at(2020, undefined, 2040, undefined)).toEqual({ years: 20, months: 240 }); // 비우면 연도 차이
    expect(at(2020, 13, 2040, 0)).toEqual({ years: 20, months: 240 }); // 1~12 밖은 비운 것
    // 월을 비우면 수령액·세금이 예전과 같고, 수령 월이 가입 월보다 늦으면 근속연수가 1년 길어져 세금이 줄어듦
    const blank = yuPayout(yu, profile, Y);
    expect(blank.years).toBe(20);
    expect(blank.tax).toBeCloseTo(retireIncomeTax(blank.taxable, 20), 8);
    const later = yuPayout({ ...yu, yuJoinMonth: 1, yuPayoutMonth: 12 }, profile, Y);
    expect(later.years).toBe(21);
    expect(later.tax).toBeCloseTo(retireIncomeTax(blank.taxable, 21), 8);
    expect(later.tax).toBeLessThan(blank.tax);
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

  it('CSV: 마지막 해 납입 개월·가입 월·수령 월 왕복, 1~12 밖은 빈칸, 예전 파일(열 없음)은 빈칸으로 읽음', () => {
    const { yu } = setup(3000);
    const full: Asset = { ...yu, yuLastMonths: 3, yuJoinMonth: 9, yuPayoutMonth: 3 };
    const plain: Asset = { name: '예금', type: 'deposit', amount: 100, expectedReturn: 3, volatility: 0.5, purpose: 'short', nature: 'safe', yuLastMonths: 5 };
    const csv = toCSV('assets', [full, plain] as never);
    const head = csv.split(/\r?\n/)[0];
    for (const l of ['마지막 해 납입 개월', '노란우산 가입 월', '노란우산 수령 월']) expect(head).toContain(l);
    const { rows, errors } = fromCSV('assets', csv);
    expect(errors).toEqual([]);
    expect(rows[0]).toEqual(full);
    expect(rows[1]).not.toHaveProperty('yuLastMonths');
    const old = fromCSV('assets', '이름,유형,금액,수령·매각 연도,노란우산공제,노란우산 연 납입액\n노란우산,기타,3000,2036,예,1200');
    expect(old.errors).toEqual([]);
    expect(old.rows[0]).toMatchObject({ yu: true, yuPay: 1200 });
    for (const k of ['yuLastMonths', 'yuJoinMonth', 'yuPayoutMonth']) expect(old.rows[0]).not.toHaveProperty(k);
    const bad = fromCSV('assets', '이름,유형,금액,수령·매각 연도,노란우산공제,마지막 해 납입 개월,노란우산 수령 월\n노란우산,기타,3000,2036,예,13,0.5');
    expect(bad.errors).toHaveLength(2);
    expect(bad.rows[0]).not.toHaveProperty('yuLastMonths');
    expect(bad.rows[0]).not.toHaveProperty('yuPayoutMonth');
  });
});
