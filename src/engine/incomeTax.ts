import type { Asset, ContribPlan, IncomeTaxSettings, Liability, Profile } from '../types';
import { loanBalanceAt, npTerms, spouseToSelf } from './goals';
import { incomeValue, type IncomeStream } from './montecarlo';
import { rentStreams, reUseOf, usesHp, type RentStream } from './realestate';

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
  hiPropAuto: false,
  hiPubRatio: 69,
  hiFairRatio: 60,
  hiLoanDeduct: false,
  hiPrivate: false,
  addToDraw: false,
};

/** 지역가입자 재산 기본공제(세대당, 만원)와 재산점수당 금액(2026년, 원) */
export const HI_PROP_DEDUCT = 10000;
export const HI_PROP_POINT = 211.5;
/** 재산등급별 점수(국민건강보험법 시행령 별표4): [공제 후 재산금액 상한(만원), 점수], 60등급은 상한 없음 */
const HI_PROP_GRADES: [number, number][] = [
  [450, 22], [900, 44], [1350, 66], [1800, 97], [2250, 122], [2700, 146], [3150, 171], [3600, 195], [4050, 219], [4500, 244],
  [5020, 268], [5590, 294], [6220, 320], [6930, 344], [7710, 365], [8590, 386], [9570, 412], [10700, 439], [11900, 465], [13300, 490],
  [14800, 516], [16400, 535], [18300, 559], [20400, 586], [22700, 611], [25300, 637], [28100, 659], [31300, 681], [34900, 706], [38800, 731],
  [43200, 757], [48100, 785], [53600, 812], [59700, 841], [66500, 881], [74000, 921], [82400, 961], [91800, 1001], [103000, 1041], [114000, 1091],
  [127000, 1141], [142000, 1191], [158000, 1241], [176000, 1291], [196000, 1341], [218000, 1391], [242000, 1451], [270000, 1511], [300000, 1571], [330000, 1641],
  [363000, 1711], [399300, 1781], [439230, 1851], [483153, 1921], [531468, 1991], [584615, 2061], [643077, 2131], [707385, 2201], [778124, 2271], [Infinity, 2341],
];

/** 재산점수: 공제 후 재산금액(만원)이 0 이하면 0점 */
export function hiPropScore(net: number) {
  if (net <= 0) return 0;
  return HI_PROP_GRADES.find(([cap]) => net <= cap)![1];
}

/** 그 해에 가진 부동산(매각 연도부터 제외, 주택연금 주택은 계속 소유) */
const heldIn = (a: Asset, year: number) => a.type === 'realestate' && (usesHp(a) || !((a.lockYear ?? 0) > 0 && year >= a.lockYear!));

/** 주택 구입 대출 공제: 대출 잔액 × 60%(주택 공정시장가액비율과 같음), 1세대 1주택 과표 기준 한도 5,000만원 */
export const HI_LOAN_RATE = 60;
export const HI_LOAN_CAP = 5000;

/**
 * 그 해 주택 구입 대출 공제액(명목, 만원): 부채 탭에서 ‘실거주 주택 구입 대출’로 표시한 대출의 그 해 잔액(원리금 균등 상환) × 60%, 한도 5,000만.
 * 그 해 가진 주택(거주용·임대용)이 2채 이상이면 1세대 1주택이 아니라 0.
 */
export function hiLoanDeduct(assets: Asset[], liabilities: Liability[], nowYear: number, year: number, currentAge: number) {
  const houses = assets.filter((a) => heldIn(a, year) && reUseOf(a) !== 'land').length;
  if (houses > 1) return 0;
  const bal = liabilities.filter((l) => l.homeLoan === 'buy').reduce((sum, l) => sum + loanBalanceAt(l, currentAge, year - nowYear), 0);
  return Math.min(HI_LOAN_CAP, (bal * HI_LOAN_RATE) / 100);
}

/**
 * 그 해 세대 재산 과세표준(명목, 만원): 부동산 시세(시세 상승률로 오름) × 공시가격 비율 × 공정시장가액비율.
 * 건보료 재산은 부부 한 세대 합산이라 명의·지분과 상관없고, 매각 연도부터는 뺌(주택연금 주택은 계속 소유).
 * 임대보증금은 집주인 재산에서 빼지 않음(세입자 쪽 전월세 재산으로 잡힘).
 */
export function hiPropBase(assets: Asset[], nowYear: number, year: number, pubRatio: number, fairRatio: number) {
  const n = year - nowYear;
  return assets
    .filter((a) => heldIn(a, year))
    .reduce((sum, a) => sum + a.amount * Math.pow(1 + a.expectedReturn / 100, n), 0) * (pubRatio / 100) * (fairRatio / 100);
}

/** 월 재산보험료(장기요양 제외, 만원) */
export const hiPropMonthly = (base: number) => (hiPropScore(base - HI_PROP_DEDUCT) * HI_PROP_POINT) / 10000;

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
  propBase: number; // 재산 과세표준(자산별 추정일 때, 대출 공제 뒤, 명목)
  loanDed: number; // 그중 주택 구입 대출 공제액(명목)
  hiProp: number; // 월 재산분(장기요양 포함)
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
 * 건보료 소득분은 전년도 소득 기준, 재산분은 현재 고지서에서 역산해 고정(증가율 입력 가능)하거나 부동산 자산으로 연도별 추정(hiPropAuto).
 * slotByYear: 사적연금도 건보료에 반영할 때 연도별 과세재원 인출액(명목).
 * liabilities: 자산별 추정에서 주택 구입 대출 공제(hiLoanDeduct)를 켰을 때 쓰는 부채 목록.
 */
export function incomeTaxSchedule(profile: Profile, nowYear: number, slotByYear?: Map<number, number>, assets: Asset[] = [], liabilities: Liability[] = []): IncomeTaxRow[] {
  const s = { ...DEFAULT_INCOME_TAX, ...(profile.incomeTax ?? {}) };
  const inf = profile.inflation / 100;
  const currentAge = nowYear - profile.birthYear;
  const toSelf = (age: number, owner?: string) => (owner === 'spouse' ? spouseToSelf(profile, age) : age);
  // ‘그 밖의 은퇴 후 소득’ 임대료는 설정의 배우자 몫, 임대용 부동산 자산은 자산 명의·지분으로 나눔(세금은 경비 차감 전 월세 기준)
  const hasSpouse = profile.spouseBirthYear > 0;
  const rents: RentStream[] = [
    ...(profile.incomes ?? [])
      .filter((i) => i.rent)
      .map((i) => ({ startAge: toSelf(i.startAge, i.owner), endAge: i.endAge > 0 ? toSelf(i.endAge, i.owner) : undefined, annual: i.monthly * 12, growth: i.growth, step: i.step, baseAge: currentAge, spouseShare: s.rentSpouseShare / 100 })),
    ...rentStreams(assets, profile, currentAge, true),
  ].map((r) => (hasSpouse ? r : { ...r, spouseShare: 0 }));
  const npStreams: IncomeStream[] = [
    { startAge: profile.nationalPensionAge, annual: profile.nationalPension * 12, ...npTerms(profile, profile.birthMonth, currentAge) },
    { startAge: spouseToSelf(profile, profile.spousePensionAge), annual: profile.spouseBirthYear > 0 ? profile.spousePension * 12 : 0, ...npTerms(profile, profile.spouseBirthMonth, currentAge) },
  ];
  const net = Math.max(1, s.npNet) / 100;
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
    const rentBy = rents.map((r) => ({ v: incomeValue(r, age, profile.inflation) * defl, w: r.spouseShare }));
    const rent = rentBy.reduce((a, r) => a + r.v, 0);
    const rentSpouse = rentBy.reduce((a, r) => a + r.v * r.w, 0) * keep;
    const rentSelf = rentBy.reduce((a, r) => a + r.v * (1 - r.w), 0) * keep;
    const npSelf = (incomeValue(npStreams[0], age, profile.inflation) * defl) / net;
    const npSpouse = (incomeValue(npStreams[1], age, profile.inflation) * defl) / net;
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
    const gross = s.hiPropAuto ? hiPropBase(assets, nowYear, year, s.hiPubRatio ?? 69, s.hiFairRatio ?? 60) : 0;
    const loanDed = s.hiPropAuto && s.hiLoanDeduct ? Math.min(gross, hiLoanDeduct(assets, liabilities, nowYear, year, currentAge)) : 0;
    const propBase = gross - loanDed;
    const R = s.hiPropAuto ? hiPropMonthly(propBase) : prop * Math.pow(1 + s.hiPropGrowth / 100, n);
    const Z = s.hiPrivate ? (prevSlot * pub * rate) / 12 : 0;
    const hiMonth = (Q + R + Z) * ltc;
    const hiYear = hiMonth * 12;
    const total = due + hiYear;
    const increase = n === 0 ? 0 : total - rows[0].total;
    const taxNoNP = incomeTaxAmount(rentSelf - s.dedSelf) + incomeTaxAmount(rentSpouse - s.dedSpouse);
    const npPart = due - taxNoNP + prevNP * pub * rate * ltc;
    rows.push({ year, age, defl, rent, rentSelf, rentSpouse, npSelf, npSpouse, incomeSelf, incomeSpouse, taxSelf, taxSpouse, withheld, due, propBase, loanDed, hiProp: R * ltc, hiMonth, hiYear, total, increase, npPart, rentPart: increase - npPart });
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
