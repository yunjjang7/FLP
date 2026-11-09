import type { ContribPlan, IncomeTaxSettings, Profile } from '../types';
import { spouseToSelf } from './goals';
import { incomeValue, type IncomeStream } from './montecarlo';

/** 종합소득세·건보료 기본값(2026년 기준 요율) */
export const DEFAULT_INCOME_TAX: IncomeTaxSettings = {
  on: false,
  rentSpouseShare: 0,
  rentExpense: 0,
  npTaxable: 100,
  npNet: 100,
  dedSelf: 150,
  dedSpouse: 150,
  hiNow: 0,
  hiRate: 7.19,
  hiLtc: 13.14,
  hiPublic: 50,
  hiPropGrowth: 0,
  hiPrivate: false,
  addToDraw: false,
};

export const DEFAULT_CONTRIB: ContribPlan = { self: 0, spouse: 0, from: 0, to: 0, selfRate: 0, spouseRate: 0 };

/** 세액공제 대상 납입 한도(연금저축 + IRP, 1인 연 만원) */
export const CREDIT_CAP = 900;

/** 공적연금 연금소득금액 = 총연금액 − 연금소득공제(한도 900만). 만원 */
export function pensionIncomeAmount(x: number) {
  if (x <= 0) return 0;
  const ded = x <= 350 ? x : x <= 700 ? 350 + (x - 350) * 0.4 : x <= 1400 ? 490 + (x - 700) * 0.2 : 630 + (x - 1400) * 0.1;
  return x - Math.min(900, ded);
}

/** 종합소득세 산출세액(2023년~ 누진공제) × 지방소득세 1.1. 과세표준·세액 만원 */
export function incomeTaxAmount(t: number) {
  if (t <= 0) return 0;
  return Math.max(t * 0.06, t * 0.15 - 126, t * 0.24 - 576, t * 0.35 - 1544, t * 0.38 - 1994, t * 0.4 - 2594, t * 0.42 - 3594, t * 0.45 - 6594) * 1.1;
}

/** 연금계좌 세액공제율(%): 종합소득금액 4,500만 이하 16.5 · 초과 13.2 */
export const creditRateFor = (income: number) => (income <= 4500 ? 16.5 : 13.2);

export interface IncomeTaxRow {
  year: number;
  age: number; // 본인 나이
  defl: number; // 명목 ÷ 실질 배율
  rent: number; // 임대수입(연, 명목)
  rentSelf: number; // 본인 임대 사업소득금액
  rentSpouse: number; // 배우자 임대 사업소득금액
  npSelf: number; // 본인 국민연금(연, 세전, 명목)
  npSpouse: number;
  incomeSelf: number; // 본인 종합소득금액(임대 사업소득 + 연금소득금액)
  incomeSpouse: number;
  taxSelf: number; // 본인 종합소득세(지방세 포함)
  taxSpouse: number;
  withheld: number; // 국민연금 원천징수(기납부)
  due: number; // 5월 종합소득세 추가 납부(부부)
  hiMonth: number; // 월 건강보험료(장기요양 포함)
  hiYear: number; // 연 건강보험료
  total: number; // 연 부담 합계(종소세 + 건보료)
  increase: number; // 첫 해 대비 증가분
  npPart: number; // 그중 국민연금 몫
  rentPart: number; // 그중 임대료 인상 몫
}

/**
 * 연도별 종합소득세·지역 건강보험료(명목, 만원). 엑셀 ‘종합소득·건보료’ 시트와 같은 방식:
 * 사적연금(1,500만 이하 분리과세)·퇴직소득·노란우산은 종합소득·건보료에 넣지 않음.
 * 건보료 소득분은 전년도 소득 기준, 재산분은 현재 고지서에서 역산해 고정(증가율 입력 가능).
 * slotByYear: 사적연금도 건보료에 반영할 때 연도별 과세재원 인출액(명목).
 */
export function incomeTaxSchedule(profile: Profile, nowYear: number, slotByYear?: Map<number, number>): IncomeTaxRow[] {
  const s = { ...DEFAULT_INCOME_TAX, ...(profile.incomeTax ?? {}) };
  const inf = profile.inflation / 100;
  const currentAge = nowYear - profile.birthYear;
  const toSelf = (age: number, owner?: string) => (owner === 'spouse' ? spouseToSelf(profile, age) : age);
  const rents: IncomeStream[] = (profile.incomes ?? [])
    .filter((i) => i.rent)
    .map((i) => ({ startAge: toSelf(i.startAge, i.owner), endAge: i.endAge > 0 ? toSelf(i.endAge, i.owner) : undefined, annual: i.monthly * 12, growth: i.growth, step: i.step, baseAge: currentAge }));
  const net = Math.max(1, s.npNet) / 100;
  const share = s.rentSpouseShare / 100;
  const keep = 1 - s.rentExpense / 100;
  const ltc = 1 + s.hiLtc / 100;
  const rate = s.hiRate / 100;
  const pub = s.hiPublic / 100;
  const rows: IncomeTaxRow[] = [];
  let prop = 0;
  let prevP = 0;
  let prevNP = 0;
  let prevSlot = 0;
  const lastYear = profile.birthYear + profile.lifeExpectancy;
  for (let year = nowYear; year <= lastYear; year++) {
    const n = year - nowYear;
    const age = year - profile.birthYear;
    const defl = Math.pow(1 + inf, n);
    const rent = rents.reduce((a, r) => a + incomeValue(r, age, profile.inflation), 0) * defl;
    const rentSpouse = rent * share * keep;
    const rentSelf = rent * (1 - share) * keep;
    const npSelf = profile.nationalPension > 0 && age >= profile.nationalPensionAge ? (profile.nationalPension * 12 * defl) / net : 0;
    const spouseAge = profile.spouseBirthYear > 0 ? year - profile.spouseBirthYear : -1;
    const npSpouse = profile.spousePension > 0 && spouseAge >= profile.spousePensionAge ? (profile.spousePension * 12 * defl) / net : 0;
    const incomeSelf = rentSelf + pensionIncomeAmount(npSelf * (s.npTaxable / 100));
    const incomeSpouse = rentSpouse + pensionIncomeAmount(npSpouse * (s.npTaxable / 100));
    const taxSelf = incomeTaxAmount(incomeSelf - s.dedSelf);
    const taxSpouse = incomeTaxAmount(incomeSpouse - s.dedSpouse);
    const np = npSelf + npSpouse;
    const withheld = np * (1 - net);
    const due = taxSelf + taxSpouse - withheld;
    const P = rentSelf + rentSpouse + np * pub;
    if (n === 0) {
      prevP = P;
      prevNP = np;
      prevSlot = slotByYear?.get(year) ?? 0;
      prop = Math.max(0, s.hiNow / ltc - (P / 12) * rate);
    }
    const Q = (prevP / 12) * rate;
    const R = prop * Math.pow(1 + s.hiPropGrowth / 100, n);
    const Z = s.hiPrivate ? (prevSlot * pub * rate) / 12 : 0;
    const hiMonth = (Q + R + Z) * ltc;
    const hiYear = hiMonth * 12;
    const total = due + hiYear;
    const increase = n === 0 ? 0 : total - rows[0].total;
    const taxNoNP = incomeTaxAmount(rentSelf - s.dedSelf) + incomeTaxAmount(rentSpouse - s.dedSpouse);
    const npPart = due - taxNoNP + prevNP * pub * rate * ltc;
    rows.push({ year, age, defl, rent, rentSelf, rentSpouse, npSelf, npSpouse, incomeSelf, incomeSpouse, taxSelf, taxSpouse, withheld, due, hiMonth, hiYear, total, increase, npPart, rentPart: increase - npPart });
    prevP = P;
    prevNP = np;
    prevSlot = slotByYear?.get(year) ?? 0;
  }
  return rows;
}

export interface ContribYear {
  year: number;
  self: number; // 납입액(명목)
  spouse: number;
  rateSelf: number; // 세액공제율(%)
  rateSpouse: number;
  creditSelf: number; // 세액공제(환급, 명목): 다음 해 5월 ISA·일반계좌로
  creditSpouse: number;
  taxedSelf: number; // 공제받은 납입액 → 과세재원(나머지는 과세제외)
  taxedSpouse: number;
}

/**
 * 추가 납입 세액공제: 공제 대상 = min(납입, 900만) × 공제율, 그 해 종합소득세까지만(종소세 추정을 켰을 때).
 * 공제율을 직접 넣지 않으면 종합소득금액으로 자동(4,500만 이하 16.5% · 초과 13.2%).
 */
export function contribSchedule(profile: Profile, taxRows: IncomeTaxRow[]): ContribYear[] {
  const c = { ...DEFAULT_CONTRIB, ...(profile.contrib ?? {}) };
  if ((c.self <= 0 && c.spouse <= 0) || c.from <= 0) return [];
  const capByTax = profile.incomeTax?.on ?? false;
  const out: ContribYear[] = [];
  for (const r of taxRows) {
    if (r.year < c.from || r.year > (c.to || c.from)) continue;
    const one = (amount: number, fixed: number, income: number, tax: number) => {
      const rate = fixed > 0 ? fixed : creditRateFor(income);
      const full = (Math.min(amount, CREDIT_CAP) * rate) / 100;
      const credit = capByTax ? Math.min(full, Math.max(0, tax)) : full;
      return { rate, credit, taxed: rate > 0 ? Math.min(amount, (credit / rate) * 100) : 0 };
    };
    const s = one(c.self, c.selfRate, r.incomeSelf, r.taxSelf);
    const w = profile.spouseBirthYear > 0 ? one(c.spouse, c.spouseRate, r.incomeSpouse, r.taxSpouse) : { rate: 0, credit: 0, taxed: 0 };
    out.push({
      year: r.year,
      self: c.self,
      spouse: profile.spouseBirthYear > 0 ? c.spouse : 0,
      rateSelf: s.rate,
      rateSpouse: w.rate,
      creditSelf: c.self > 0 ? s.credit : 0,
      creditSpouse: c.spouse > 0 ? w.credit : 0,
      taxedSelf: c.self > 0 ? s.taxed : 0,
      taxedSpouse: c.spouse > 0 ? w.taxed : 0,
    });
  }
  return out;
}

/** 세액공제 환급(다음 해 들어오는 실질 금액, 본인 나이) */
export function creditInflows(profile: Profile, nowYear: number, contrib: ContribYear[]) {
  return contrib
    .filter((c) => c.creditSelf + c.creditSpouse > 0)
    .map((c) => ({
      name: '세액공제 환급',
      kind: 'credit' as const,
      age: c.year + 1 - profile.birthYear,
      amount: (c.creditSelf + c.creditSpouse) / Math.pow(1 + profile.inflation / 100, c.year + 1 - nowYear),
    }));
}

/** 국민연금 때문에 늘어나는 종소세·건보료(실질, 본인 나이별) — ‘인출에 더하기’를 켰을 때 지출로 반영 */
export function npCostOutflows(rows: IncomeTaxRow[]) {
  return rows.filter((r) => r.npPart > 0).map((r) => ({ age: r.age, amount: r.npPart / r.defl }));
}
