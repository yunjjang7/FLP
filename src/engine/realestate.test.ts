import { describe, expect, it } from 'vitest';
import { sampleData } from '../db/sample';
import type { Asset } from '../types';
import { buildPlanInput, bulletNoMaturity, bulletRepayments, equalMonthlyDecline, loanSchedule, retirePremiums, equalPrincipal, loanBalanceAt, loanEndAge, planGoals } from './goals';
import { bulletChecks } from './risk';
import { hiLoanDeduct, hiPropBase, hiPropScore, incomeTaxSchedule } from './incomeTax';
import { debtAnnualAt, debtPaymentAt, incomeValue, inflowAt, savingsAt } from './montecarlo';
import { summarize } from './portfolio';
import { bucketMap, bulletPrescriptions } from './prescribe';
import { HP_LOAN, hpEstate, hpEstimate, hpLoanOf, housePension, rentStreams, rentYield, saleInflow, selfShare, willSell } from './realestate';

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
    const base = summarize(d.profile, d.assets, d.liabilities, d.cashflows, Y, d.insurance);
    const assets = [...d.assets, rental()];
    const s = summarize(d.profile, assets, d.liabilities, d.cashflows, Y, d.insurance);
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
    const plan = buildPlanInput(d.profile, [...d.assets, a], d.liabilities, d.goals, summarize(d.profile, [...d.assets, a], d.liabilities, d.cashflows, Y, d.insurance));
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
    const plan = buildPlanInput(d.profile, assets, d.liabilities, d.goals, summarize(d.profile, assets, d.liabilities, d.cashflows, Y, d.insurance));
    expect(inflowAt(plan, 65)).toBeCloseTo(s.amount, 6);
    expect(plan.inflows?.find((x) => x.kind === 'sale')?.age).toBe(65);
    // 매각 연도가 지났으면 무시
    const past = d.assets.map((x) => (x.name === home.name ? { ...home, lockYear: Y - 1 } : x));
    expect(buildPlanInput(d.profile, past, d.liabilities, d.goals, summarize(d.profile, past, d.liabilities, d.cashflows, Y, d.insurance)).inflows ?? []).toEqual([]);
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

  it('주택연금 월지급금 추정: 공사 예시표와 같고 사이 나이는 보간, 12억·연령별 한도', () => {
    expect(hpEstimate(30000, 70)).toBeCloseTo(92.34, 2); // 표: 70세 3억 92.3만
    expect(hpEstimate(30000, 60)).toBeCloseTo(63.21, 2); // 표: 63.2만
    expect(hpEstimate(30000, 62.5)).toBeCloseTo((63.21 + 75.87) / 2, 2);
    expect(hpEstimate(200000, 60)).toBeCloseTo(252.84, 1); // 12억까지만
    expect(hpEstimate(100000, 80)).toBeCloseTo(406, 6); // 80세 한도
  });

  it('주택연금: 연소자 나이 기준, 정액(명목 고정)으로 연금 소득, 매각 계획은 무시', () => {
    const d = sampleData(Y); // 본인 45세, 배우자 2세 아래
    const home: Asset = { ...d.assets.find((x) => x.type === 'realestate')!, hpAge: 65, lockYear: Y + 10 };
    expect(willSell(home, Y)).toBe(false);
    const h = housePension(home, d.profile, 45);
    expect(h.startAge).toBe(65);
    expect(h.calcAge).toBe(65 - (d.profile.spouseBirthYear - d.profile.birthYear));
    expect(h.price).toBeCloseTo(75000 * 1.03 ** 20, 6);
    expect(h.nominal).toBeCloseTo(hpEstimate(h.price, h.calcAge), 9);
    const assets = d.assets.map((x) => (x.type === 'realestate' ? home : x));
    const plan = buildPlanInput(d.profile, assets, d.liabilities, d.goals, summarize(d.profile, assets, d.liabilities, d.cashflows, Y, d.insurance));
    expect(plan.inflows ?? []).toEqual([]);
    const s = plan.pensions.find((x) => x.name === '거주 아파트 주택연금')!;
    expect(s.kind).toBe('pension');
    expect(incomeValue(s, 64, 2.5)).toBe(0);
    expect(incomeValue(s, 65, 2.5)).toBeCloseTo(h.real * 12, 6);
    expect(incomeValue(s, 75, 2.5)).toBeCloseTo((h.nominal * 12) / 1.025 ** 30, 6); // 명목 고정 → 실질 감소
    // 직접 넣은 월 수령액(오늘 기준)은 가입 때 실질 그대로
    expect(housePension({ ...home, hpMonthly: 150 }, d.profile, 45).real).toBeCloseTo(150, 9);
    // 둘 다 55세 미만이면 반영 안 함
    expect(housePension({ ...home, hpAge: 50 }, d.profile, 45).eligible).toBe(false);
  });

  it('주택연금 상속 잔액: 초기보증료 + 월지급금 + 이자·보증료가 기대수명까지 쌓이고, 시세에서 빼되 0 아래로는 안 내려감', () => {
    const d = sampleData(Y);
    const home: Asset = { ...d.assets.find((x) => x.type === 'realestate')!, hpAge: 65, hpMonthly: 150 };
    const h = housePension(home, d.profile, 45);
    const e = hpEstate(home, d.profile, 45);
    const r = (HP_LOAN.rate + HP_LOAN.annualFee) / 100;
    const k = d.profile.lifeExpectancy - 65 + 1; // 받는 햇수
    let bal = (h.price * HP_LOAN.initFee) / 100 * (1 + r) ** k;
    for (let j = 0; j < k; j++) bal += h.nominal * 12 * (1 + r / 2) * (1 + r) ** (k - 1 - j);
    expect(e.age).toBe(d.profile.lifeExpectancy);
    expect(e.paid).toBeCloseTo(h.nominal * 12 * k, 6);
    expect(e.balance).toBeCloseTo(bal, 4);
    expect(e.price).toBeCloseTo(75000 * 1.03 ** (d.profile.lifeExpectancy - 45), 6);
    expect(e.left).toBeCloseTo(Math.max(0, e.price - e.balance), 6);
    expect(e.leftReal).toBeCloseTo(e.left / 1.025 ** (d.profile.lifeExpectancy - 45), 6);
    // 지급액이 커서 잔액이 집값을 넘으면 0(상속인이 차액을 갚지 않음)
    expect(hpEstate({ ...home, hpMonthly: 2000 }, d.profile, 45).left).toBe(0);
    // 순자산·부채에는 넣지 않음
    const assets = d.assets.map((x) => (x.type === 'realestate' ? home : x));
    const base = summarize(d.profile, d.assets, d.liabilities, d.cashflows, Y, d.insurance);
    const s = summarize(d.profile, assets, d.liabilities, d.cashflows, Y, d.insurance);
    expect(s.netWorth).toBe(base.netWorth);
    expect(s.totalDebt).toBe(base.totalDebt);
  });

  it('건보료 재산점수: 시행령 별표4 등급표(공단 예시와 같음)', () => {
    expect(hiPropScore(0)).toBe(0);
    expect(hiPropScore(450)).toBe(22);
    expect(hiPropScore(451)).toBe(44);
    expect(hiPropScore(9000)).toBe(412); // 공단 예시: 과표 9,000만 → 17등급 412점
    expect(hiPropScore(15000)).toBe(535); // 1.5억 → 22등급 535점
    expect(hiPropScore(1e7)).toBe(2341);
  });

  it('건보료 재산분 자산별 추정: 시세 × 공시가격 비율 × 공정시장가액비율 − 1억, 매각 연도부터 제외, 보증금은 빼지 않음', () => {
    const d = sampleData(Y);
    const sold = rental({ amount: 40000, deposit: 10000, lockYear: Y + 5 });
    const assets = [...d.assets, sold];
    expect(hiPropBase(assets, Y, Y, 69, 60)).toBeCloseTo((75000 + 40000) * 0.69 * 0.6, 6);
    expect(hiPropBase(assets, Y, Y + 5, 69, 60)).toBeCloseTo(75000 * 1.03 ** 5 * 0.69 * 0.6, 6); // 매각한 해부터 빠짐
    const p = { ...d.profile, incomes: [], incomeTax: { on: true, hiPropAuto: true, hiPubRatio: 69, hiFairRatio: 60, hiNow: 99 } as never };
    const rows = incomeTaxSchedule(p, Y, undefined, d.assets);
    const base = 75000 * 0.69 * 0.6; // 31,050 → 공제 후 21,050 → 25등급 611점
    expect(rows[0].propBase).toBeCloseTo(base, 6);
    expect(rows[0].hiProp).toBeCloseTo((611 * 211.5) / 10000 * 1.1314, 6);
    expect(rows[0].hiMonth).toBeCloseTo(rows[0].hiProp, 6); // 소득이 없으면 재산분만(고지서 금액은 안 씀)
    // 시세가 오르면 등급이 올라감
    expect(rows[20].hiProp).toBeGreaterThan(rows[0].hiProp);
    // 고지서 역산 방식은 그대로
    const bill = incomeTaxSchedule({ ...p, incomeTax: { on: true, hiNow: 20 } as never }, Y, undefined, d.assets);
    expect(bill[0].hiMonth).toBeCloseTo(20, 6);
    expect(bill[0].propBase).toBe(0);
  });

  it('주택연금 대출 조건: 자산에 넣은 금리·보증료로 상속 잔액 계산, 비우면 기본값', () => {
    const d = sampleData(Y);
    const home: Asset = { ...d.assets.find((x) => x.type === 'realestate')!, hpAge: 65, hpMonthly: 150 };
    expect(hpLoanOf(home)).toEqual(HP_LOAN);
    const custom = { ...home, hpRate: 5, hpInitFee: 0, hpAnnualFee: 0.5 };
    expect(hpLoanOf(custom)).toEqual({ rate: 5, initFee: 0, annualFee: 0.5 });
    const h = housePension(custom, d.profile, 45);
    const e = hpEstate(custom, d.profile, 45);
    const r = 0.055;
    const k = d.profile.lifeExpectancy - 65 + 1;
    let bal = 0;
    for (let j = 0; j < k; j++) bal += h.nominal * 12 * (1 + r / 2) * (1 + r) ** (k - 1 - j);
    expect(e.balance).toBeCloseTo(bal, 4);
    // 금리가 오르면 남는 주택 가치는 줄어듦
    expect(hpEstate({ ...home, hpRate: 6 }, d.profile, 45).left).toBeLessThan(hpEstate(home, d.profile, 45).left);
  });

  it('대출 잔액: 원리금 균등 상환으로 줄고 상환 종료 나이에 0', () => {
    const l = { name: '주담대', balance: 6000, rate: 4, monthlyPayment: 50, endAge: 0 };
    expect(loanBalanceAt(l, 45, 0)).toBe(6000);
    const g = (1 + 4 / 1200) ** 36;
    expect(loanBalanceAt(l, 45, 3)).toBeCloseTo(6000 * g - (50 * (g - 1)) / (4 / 1200), 6);
    expect(loanBalanceAt({ ...l, endAge: 50 }, 45, 5)).toBe(0);
    expect(loanBalanceAt({ ...l, rate: 0 }, 45, 2)).toBe(6000 - 50 * 24);
  });

  it('건보료 재산분 주택 구입 대출 공제: 잔액 × 60%, 한도 5,000만, 1세대 1주택만', () => {
    const d = sampleData(Y);
    const age = Y - d.profile.birthYear;
    const loan = { name: '주담대', balance: 6000, rate: 4, monthlyPayment: 50, endAge: 0, homeLoan: 'buy' as const };
    const p = { ...d.profile, incomes: [], incomeTax: { on: true, hiPropAuto: true, hiLoanDeduct: true } as never };
    const rows = incomeTaxSchedule(p, Y, undefined, d.assets, [loan]);
    const gross = 75000 * 0.69 * 0.6;
    expect(rows[0].loanDed).toBeCloseTo(3600, 6);
    expect(rows[0].propBase).toBeCloseTo(gross - 3600, 6); // 27,450 → 공제 후 17,450 → 23등급 559점
    expect(rows[0].hiProp).toBeCloseTo((559 * 211.5) / 10000 * 1.1314, 6);
    expect(rows[3].loanDed).toBeCloseTo(loanBalanceAt(loan, age, 3) * 0.6, 6); // 잔액이 줄면 공제도 줄어듦
    expect(hiLoanDeduct(d.assets, [{ ...loan, balance: 20000 }], Y, Y, age)).toBe(5000); // 한도
    expect(hiLoanDeduct([...d.assets, rental()], [loan], Y, Y, age)).toBe(0); // 2주택
    expect(hiLoanDeduct(d.assets, [{ ...loan, homeLoan: undefined }], Y, Y, age)).toBe(0); // 표시 안 한 대출
    // 옵션을 끄면 공제 없음
    const off = incomeTaxSchedule({ ...p, incomeTax: { on: true, hiPropAuto: true } as never }, Y, undefined, d.assets, [loan]);
    expect(off[0].loanDed).toBe(0);
    expect(off[0].propBase).toBeCloseTo(gross, 6);
  });

  it('주택 구입 대출 공제 연도별: 만기일시는 만기 전까지 원금 그대로, 만기 해부터 0', () => {
    const d = sampleData(Y);
    const age = Y - d.profile.birthYear;
    const bullet = { name: '만기일시', balance: 6000, rate: 4, monthlyPayment: 20, endAge: age + 5, repay: 'bullet' as const, homeLoan: 'buy' as const };
    const ded = (n: number, l = bullet) => hiLoanDeduct(d.assets, [l], Y, Y + n, age);
    for (let n = 0; n < 5; n++) expect(ded(n)).toBeCloseTo(3600, 9);
    expect(ded(5)).toBe(0);
    expect(ded(8)).toBe(0);
    // 원금이 커도 한도 5,000만, 만기 나이가 비어 있으면 원금이 줄지 않아 계속 공제
    expect(ded(4, { ...bullet, balance: 30000 })).toBe(5000);
    expect(ded(30, { ...bullet, endAge: 0 })).toBeCloseTo(3600, 9);
  });

  it('주택 구입 대출 공제 연도별: 원리금균등은 잔액 × 60%가 해마다 줄고, 한도 아래로 내려오면 그때부터 줄어듦', () => {
    const d = sampleData(Y);
    const age = Y - d.profile.birthYear;
    const amort = { name: '원리금균등', balance: 10000, rate: 4, monthlyPayment: 150, endAge: 0, homeLoan: 'buy' as const };
    const end = loanEndAge(amort, age).age;
    const ded = (n: number) => hiLoanDeduct(d.assets, [amort], Y, Y + n, age);
    let prev = Infinity;
    for (let n = 0; age + n < end; n++) {
      const v = ded(n);
      expect(v).toBeCloseTo(Math.min(5000, loanBalanceAt(amort, age, n) * 0.6), 9);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
    expect(ded(0)).toBe(5000); // 1억 × 60% = 6,000 → 한도
    const firstUnder = Array.from({ length: end - age }, (_, n) => n).find((n) => loanBalanceAt(amort, age, n) * 0.6 < 5000)!;
    expect(firstUnder).toBeGreaterThan(0);
    expect(ded(firstUnder - 1)).toBe(5000);
    expect(ded(firstUnder)).toBeLessThan(5000);
    expect(ded(end - age)).toBe(0); // 상환이 끝난 해
  });

  it('만기 나이 빈 만기일시 대출 판정', () => {
    const b = { name: 'b', balance: 6000, rate: 4, monthlyPayment: 20, endAge: 0, repay: 'bullet' as const };
    expect(bulletNoMaturity(b, 50)).toBe(true);
    expect(bulletNoMaturity({ ...b, endAge: 50 }, 50)).toBe(true); // 만기가 지났거나 올해
    expect(bulletNoMaturity({ ...b, endAge: 55 }, 50)).toBe(false);
    expect(bulletNoMaturity({ ...b, balance: 0 }, 50)).toBe(false);
    expect(bulletNoMaturity({ ...b, repay: undefined }, 50)).toBe(false);
  });
  it('만기 나이 빈 대출은 점검 목록에 위험으로 뜸(재무점수는 financialScore가 따로 계산)', () => {
    const b = { id: 7, name: '사업자금', balance: 6000, rate: 4, monthlyPayment: 20, endAge: 0, repay: 'bullet' as const };
    const c = bulletChecks([b, { ...b, id: 8, endAge: 60 }], 50);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ key: 'bullet-7', label: '사업자금 만기 나이 입력 필요', level: 'danger' });
  });


  it('주택 구입 대출 공제: 2주택인 동안은 0, 한 채를 판 해부터 다시 공제', () => {
    const d = sampleData(Y);
    const age = Y - d.profile.birthYear;
    const loan = { name: '주담대', balance: 6000, rate: 0, monthlyPayment: 0, endAge: 0, repay: 'bullet' as const, homeLoan: 'buy' as const };
    const assets = [...d.assets, rental({ lockYear: Y + 3 })];
    expect(hiLoanDeduct(assets, [loan], Y, Y + 2, age)).toBe(0);
    expect(hiLoanDeduct(assets, [loan], Y, Y + 3, age)).toBeCloseTo(3600, 9);
  });
});

describe('원금균등 상환 대출', () => {
  const d = sampleData(Y);
  const s = summarize(d.profile, d.assets, d.liabilities, d.cashflows, Y, d.insurance);
  // 잔액 1.2억, 금리 6%, 월 원금 100 → 이번 달 이자 60, 월 상환액 160
  const eq = { name: '원금균등', balance: 12000, rate: 6, monthlyPayment: 160, endAge: 0, repay: 'equal' as const };
  it('월 원금 = 월 상환액 − 이자, 잔액은 원금만큼 일정하게 줄고 10년에 끝남', () => {
    expect(equalPrincipal(eq, s.age)).toBeCloseTo(100, 9);
    expect(loanEndAge(eq, s.age).age).toBe(s.age + 10);
    expect(loanBalanceAt(eq, s.age, 3)).toBeCloseTo(12000 - 3600, 6);
    expect(loanBalanceAt(eq, s.age, 10)).toBe(0);
    // 상환 종료 나이를 넣으면 월 원금 = 잔액 ÷ 남은 개월
    expect(equalPrincipal({ ...eq, endAge: s.age + 20 }, s.age)).toBeCloseTo(50, 9);
    expect(loanEndAge({ ...eq, monthlyPayment: 50 }, s.age).age).toBe(Infinity); // 이자(60)보다 적음
  });
  it('상환액이 해마다 이자만큼 줄고, 줄어든 만큼 저축이 늘어남', () => {
    expect(equalMonthlyDecline(eq, s.age)).toBeCloseTo(6, 9); // 100 × 12 × 0.5%
    const plan = buildPlanInput(d.profile, d.assets, [...d.liabilities, eq], d.goals, s);
    const debt = plan.debts!.find((x) => x.name === '원금균등')!;
    expect(debt).toMatchObject({ endAge: s.age + 10, annual: 1920, fromAge: s.age });
    expect(debt.decline).toBeCloseTo(72, 9);
    expect(debtAnnualAt(debt, s.age)).toBe(1920);
    expect(debtAnnualAt(debt, s.age + 3)).toBeCloseTo(1920 - 216, 9);
    expect(debtAnnualAt(debt, s.age + 10)).toBe(0);
    const base = buildPlanInput(d.profile, d.assets, d.liabilities, d.goals, s);
    expect(savingsAt(plan, s.age + 3) - savingsAt(base, s.age + 3)).toBeCloseTo(216, 9);
    expect(debtPaymentAt(plan, s.age + 3) - debtPaymentAt(base, s.age + 3)).toBeCloseTo(1920 - 216, 9);
  });
});

describe('대출 연도별 상환표', () => {
  const age = 45;
  it('원금균등은 상환액이 해마다 줄고 잔액이 일정하게 줄어 끝남', () => {
    const eq = { name: '원금균등', balance: 12000, rate: 6, monthlyPayment: 160, endAge: 0, repay: 'equal' as const };
    const t = loanSchedule(eq, age, age + 11);
    expect(t).toHaveLength(12);
    expect(t[0]).toMatchObject({ age, payment: 1920, principal: 0 });
    expect(t[1].payment).toBeCloseTo(1920 - 72, 9);
    expect(t[0].balance).toBeCloseTo(12000 - 1200, 6);
    expect(t[9].balance).toBe(0); // 55세에 상환 종료 → 54세 말 잔액 0
    expect(t[10].payment).toBe(0);
  });
  it('만기일시는 이자만 내다가 만기 나이에 원금', () => {
    const b = { name: '만기', balance: 5000, rate: 4, monthlyPayment: 17, endAge: age + 3, repay: 'bullet' as const };
    const t = loanSchedule(b, age, age + 3);
    expect(t.map((y) => y.payment)).toEqual([204, 204, 204, 0]);
    expect(t.map((y) => y.principal)).toEqual([0, 0, 0, 5000]);
    expect(t[1].balance).toBe(5000);
    expect(t[2].balance).toBe(0);
  });
});

describe('은퇴 후 보험료', () => {
  const d = sampleData(Y); // 본인 45세, 은퇴 60세
  const [a, ...rest] = d.insurance;
  const ins = [{ ...a, payEndAge: 65 }, ...rest];
  const s = summarize(d.profile, d.assets, d.liabilities, d.cashflows, Y, ins);
  it('납입 종료 나이가 은퇴보다 늦으면 은퇴~종료 전 해까지 매년 자산에서 뺌(실질)', () => {
    const p = retirePremiums(s, 60, d.profile.inflation);
    expect(p.map((x) => x.age)).toEqual([60, 61, 62, 63, 64]);
    expect(p[0].premium).toBe(a.name);
    expect(p[0].amount).toBeCloseTo((a.monthlyPremium * 12) / Math.pow(1 + d.profile.inflation / 100, 15), 6);
    const plan = buildPlanInput(d.profile, d.assets, d.liabilities, d.goals, s);
    expect(plan.goals.filter((g) => g.premium)).toEqual(p);
    // 은퇴 전에 끝나거나(저축 증가로 처리) 0이면 은퇴 후 보험료 없음
    expect(retirePremiums(summarize(d.profile, d.assets, d.liabilities, d.cashflows, Y, [{ ...a, payEndAge: 55 }, ...rest]), 60, 2.5)).toEqual([]);
    expect(retirePremiums(summarize(d.profile, d.assets, d.liabilities, d.cashflows, Y, d.insurance), 60, 2.5)).toEqual([]);
  });
  it('은퇴 나이를 바꾸면 기간이 따라 바뀌고, 지출에 보험료 항목이 따로 있으면 넣지 않음', () => {
    expect(buildPlanInput(d.profile, d.assets, d.liabilities, d.goals, s, { retireAge: 63 }).goals.filter((g) => g.premium).map((g) => g.age)).toEqual([63, 64]);
    const dup = summarize(d.profile, d.assets, d.liabilities, [...d.cashflows, { name: '보험료', kind: 'fixed' as const, category: '보험', monthly: 45 }], Y, ins);
    expect(retirePremiums(dup, 60, 2.5)).toEqual([]);
  });
});

describe('만기일시 상환 대출', () => {
  const d = sampleData(Y);
  const s = summarize(d.profile, d.assets, d.liabilities, d.cashflows, Y, d.insurance);
  const bullet = { name: '만기 대출', balance: 10000, rate: 4, monthlyPayment: 33, endAge: s.age + 5, repay: 'bullet' as const };
  it('잔액은 만기까지 그대로, 만기 나이가 없으면 끝나지 않음', () => {
    expect(loanBalanceAt(bullet, s.age, 4)).toBe(10000);
    expect(loanBalanceAt(bullet, s.age, 5)).toBe(0);
    expect(loanEndAge({ ...bullet, endAge: 0 }, s.age).age).toBe(Infinity);
    expect(bulletRepayments([{ ...bullet, endAge: 0 }], s.age, 2.5)).toEqual([]);
  });
  it('만기 나이에 원금(실질)을 자산에서 한 번에 뺌, 이자는 만기 전까지 상환액으로', () => {
    const plan = buildPlanInput(d.profile, d.assets, [...d.liabilities, bullet], d.goals, s);
    const base = buildPlanInput(d.profile, d.assets, d.liabilities, d.goals, s);
    const real = 10000 / Math.pow(1 + d.profile.inflation / 100, 5);
    const added = plan.goals.filter((g) => !base.goals.some((b) => b.age === g.age && b.amount === g.amount));
    expect(added).toHaveLength(1);
    expect(added[0].age).toBe(s.age + 5);
    expect(added[0].amount).toBeCloseTo(real, 6);
    expect(added[0].loan).toBe('만기 대출');
    expect(plan.debts?.find((x) => x.name === '만기 대출')).toEqual({ name: '만기 대출', endAge: s.age + 5, annual: 33 * 12, bullet: true });
  });
  it('처방: 만기 나이가 없으면 입력 경고, 있으면 만기 원금 상환 가능 여부', () => {
    const noEnd = buildPlanInput(d.profile, d.assets, [...d.liabilities, { ...bullet, endAge: 0 }], d.goals, s);
    const warn = bulletPrescriptions(noEnd);
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatchObject({ level: 'danger', title: '만기 대출 만기 나이 입력 필요' });
    const ok = bulletPrescriptions(buildPlanInput(d.profile, d.assets, [...d.liabilities, bullet], d.goals, s));
    expect(ok).toHaveLength(1);
    expect(ok[0].title).toContain(`${s.age + 5}세 만기 원금`);
    expect(ok[0].level).not.toBe('danger');
    const huge = bulletPrescriptions(buildPlanInput(d.profile, d.assets, [...d.liabilities, { ...bullet, balance: 9_000_000 }], d.goals, s));
    expect(huge[0]).toMatchObject({ level: 'danger' });
    expect(huge[0].title).toContain('금융자산 부족');
  });
});
