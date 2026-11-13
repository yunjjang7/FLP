import type { Asset, ContribPlan, IncomeKind, IncomeTaxSettings, Liability, Profile, RetireIncome } from '../types';
import { loanBalanceAt, npTerms, spouseRetireSelfAge, spouseToSelf } from './goals';
import { incomeValue, type IncomeStream } from './montecarlo';
import { rentStreams, reUseOf, selfShare, usesHp, type RentStream } from './realestate';
import { YU_CEO_WAGE, yuLimit, yuPayments } from './yellowUmbrella';

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
  hiDepNoReg: false,
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

/** 한 사람 명의(공동명의는 지분)의 재산 과세표준(명목, 만원). who: 0 본인 · 1 배우자 */
export function hiPropBaseOf(assets: Asset[], nowYear: number, year: number, pubRatio: number, fairRatio: number, who: 0 | 1) {
  const n = year - nowYear;
  return assets
    .filter((a) => heldIn(a, year))
    .reduce((sum, a) => sum + a.amount * Math.pow(1 + a.expectedReturn / 100, n) * (who === 0 ? selfShare(a) : 1 - selfShare(a)), 0) * (pubRatio / 100) * (fairRatio / 100);
}

/** 직장가입자 소득월액 보험료: 보수(급여) 외 소득이 연 2,000만원을 넘는 부분에만 부과(만원) */
export const HI_WORK_EXTRA = 2000;
/** 피부양자 요건(만원): 합산소득 2,000만 이하 · 재산 과표 5.4억 이하(9억 이하이면서 소득 1,000만 이하도 인정) */
export const HI_DEP_INCOME = 2000;
export const HI_DEP_PROP = 54000;
export const HI_DEP_PROP_MAX = 90000;
export const HI_DEP_PROP_INCOME = 1000;
/** 사업자등록이 없을 때 피부양자로 인정되는 사업소득금액 한도(연, 만원). 임대소득은 등록과 상관없이 있으면 탈락 */
export const HI_DEP_BIZ_FREE = 500;

/**
 * 직장가입자의 피부양자가 될 수 있는지. biz: 사업소득금액(임대 포함), income: 합산소득(사업소득 + 공적연금·근로 총액),
 * propBase: 그 사람 명의 재산 과세표준(모르면 null → 재산 요건은 보지 않음).
 * 임대·사업소득이 조금이라도 있으면 사업자등록이 있다고 보고 탈락(보수적).
 * noReg(사업자등록 없음)를 주면 임대소득(noReg.rent)을 뺀 사업소득이 연 500만 이하일 때는 인정. 임대소득은 그래도 있으면 탈락
 * (주택임대는 등록과 상관없이 탈락, 상가 임대는 사업자등록이 필수).
 */
export function hiDependent(biz: number, income: number, propBase: number | null, noReg?: { rent: number }) {
  return hiDependentWhy(biz, income, propBase, noReg) === null;
}

const man = (v: number) => `${Math.round(v).toLocaleString('ko-KR')}만원`;
const eok = (v: number) => `${(v / 10000).toFixed(1)}억`;

/** 피부양자에서 빠지는 이유(채우면 null). privIncl: 합산소득에 들어간 사적연금(0이면 표시 안 함) */
export function hiDependentWhy(biz: number, income: number, propBase: number | null, noReg?: { rent: number }, privIncl = 0): string | null {
  if (noReg) {
    if (noReg.rent > 0) return '임대소득 있음';
    if (biz - noReg.rent > HI_DEP_BIZ_FREE) return `임대 외 사업소득 ${man(biz - noReg.rent)}(500만원 초과)`;
  } else if (biz > 0) return '임대·사업소득 있음(사업자등록 있다고 봄)';
  if (income > HI_DEP_INCOME) return `합산소득 ${man(income)}${privIncl > 0.5 ? `(사적연금 ${man(privIncl)} 포함)` : ''}이 2,000만원 초과`;
  if (propBase === null) return null;
  if (propBase > HI_DEP_PROP_MAX) return `본인 명의 재산 과표 ${eok(propBase)}이 9억 초과`;
  if (propBase <= HI_DEP_PROP || income <= HI_DEP_PROP_INCOME) return null;
  return `재산 과표 ${eok(propBase)}이 5.4억 초과이고 합산소득 ${man(income)}이 1,000만원 초과`;
}

/** 한 사람 명의(공동명의는 지분) 부동산이 그 해 세대 부동산 시세에서 차지하는 비율(0~1). 부동산이 없으면 null */
export function hiPropShare(assets: Asset[], nowYear: number, year: number, who: 0 | 1) {
  const all = hiPropBase(assets, nowYear, year, 100, 100);
  return all > 0 ? hiPropBaseOf(assets, nowYear, year, 100, 100, who) / all : null;
}

/** 그 해 건보료 자격: region 세대 모두 지역 · work 모두 직장 · workDep 한 명 직장 + 한 명 피부양자 · workRegion 한 명 직장 + 한 명 지역 */
export type HiMode = 'region' | 'work' | 'workDep' | 'workRegion';

export const DEFAULT_CONTRIB: ContribPlan = { self: 0, spouse: 0, from: 0, to: 0, selfRate: 0, spouseRate: 0 };

/** 세액공제 대상 납입 한도(연금저축 + IRP, 1인 연 만원) */
export const CREDIT_CAP = 900;

/** 공적연금 연금소득금액 = 총연금액 − 연금소득공제(한도 900만). 만원 */
export function pensionIncomeAmount(x: number) {
  if (x <= 0) return 0;
  const ded = x <= 350 ? x : x <= 700 ? 350 + (x - 350) * 0.4 : x <= 1400 ? 490 + (x - 700) * 0.2 : 630 + (x - 1400) * 0.1;
  return x - Math.min(900, ded);
}

/** 소득 종류 이름 */
export const INCOME_KIND: Record<IncomeKind, string> = {
  rent: '임대소득',
  wage: '근로소득',
  business: '사업소득',
  publicPension: '공적연금(공무원·사학·군인)',
  privatePension: '사적연금',
  other: '그 밖(비과세·분리과세)',
};

/** 소득 종류별 세금 계산 방식 안내 */
export const INCOME_KIND_HINT: Record<IncomeKind, string> = {
  rent: '임대 필요경비율을 뺀 사업소득 → 종소세·건보료',
  wage: '근로소득공제·세액공제 · 연말정산 세금은 기납부로 뺌 · 건보료는 총급여 × 반영률',
  business: '수입 − 필요경비 = 사업소득 → 종소세·건보료',
  publicPension: '국민연금과 합쳐 연금소득공제 · 건보료는 × 반영률',
  privatePension: '1,500만 이하 분리과세로 종소세 제외 · 건보료는 ‘사적연금도 반영’일 때만',
  other: '이자·비과세 등: 종소세·건보료 계산에서 뺌',
};

/** 소득 종류(예전 데이터는 rent 체크 여부로 판단) */
export const incomeKindOf = (i: RetireIncome): IncomeKind => i.kind ?? (i.rent ? 'rent' : 'other');

/** 근로소득금액 = 총급여 − 근로소득공제(한도 2,000만). 만원 */
export function wageIncomeAmount(x: number) {
  if (x <= 0) return 0;
  const ded = x <= 500 ? x * 0.7 : x <= 1500 ? 350 + (x - 500) * 0.4 : x <= 4500 ? 750 + (x - 1500) * 0.15 : x <= 10000 ? 1200 + (x - 4500) * 0.05 : 1475 + (x - 10000) * 0.02;
  return x - Math.min(2000, ded);
}

/** 종합소득세 산출세액(2023년~ 누진공제) × 지방소득세 1.1. 과세표준·세액 만원 */
export function incomeTaxAmount(t: number) {
  if (t <= 0) return 0;
  return Math.max(t * 0.06, t * 0.15 - 126, t * 0.24 - 576, t * 0.35 - 1544, t * 0.38 - 1994, t * 0.4 - 2594, t * 0.42 - 3594, t * 0.45 - 6594) * 1.1;
}

/** 근로소득자 표준세액공제(만원): 특별세액공제를 따로 받지 않을 때 */
export const WAGE_STD_CREDIT = 13;

/**
 * 근로소득세액공제(만원, 소득세법 59조): 근로소득분 산출세액 130만 이하 55%, 넘는 부분 30%.
 * 한도는 총급여 3,300만 이하 74만 · 7,000만 이하 74만 − (총급여 − 3,300만) × 0.8%(최소 66만)
 * · 1.2억 이하 66만 − (총급여 − 7,000만) × 1/2(최소 50만) · 그 초과 50만 − (총급여 − 1.2억) × 1/2(최소 20만).
 * wageCalc: 지방세 빼고 근로소득분 산출세액, gross: 총급여
 */
export function wageTaxCredit(wageCalc: number, gross: number) {
  if (wageCalc <= 0 || gross <= 0) return 0;
  const credit = wageCalc <= 130 ? wageCalc * 0.55 : 71.5 + (wageCalc - 130) * 0.3;
  const cap =
    gross <= 3300 ? 74 : gross <= 7000 ? Math.max(66, 74 - (gross - 3300) * 0.008) : gross <= 12000 ? Math.max(50, 66 - (gross - 7000) * 0.5) : Math.max(20, 50 - (gross - 12000) * 0.5);
  return Math.min(credit, cap);
}

/**
 * 한 사람의 종합소득세 결정세액(지방세 포함, 만원). 근로소득이 있으면 근로소득세액공제
 * (산출세액 × 근로소득금액 ÷ 종합소득금액 기준)와 표준세액공제 13만을 뺌.
 * income: 종합소득금액, ded: 종합소득공제, wageGross: 그 사람 총급여
 */
export function personIncomeTax(income: number, ded: number, wageGross = 0) {
  const calc = incomeTaxAmount(income - ded) / 1.1;
  if (calc <= 0 || wageGross <= 0) return calc * 1.1;
  const share = income > 0 ? Math.min(1, wageIncomeAmount(wageGross) / income) : 0;
  return Math.max(0, calc - wageTaxCredit(calc * share, wageGross) - WAGE_STD_CREDIT) * 1.1;
}

/** 근로소득 원천징수(연말정산 결정세액, 지방세 포함): 근로소득만 있다고 보고 계산한 세금. 5월 신고 때 기납부세액 */
export const wageWithholding = (wageGross: number, ded: number) => personIncomeTax(wageIncomeAmount(wageGross), ded, wageGross);

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
  other: number; // ‘그 밖의 은퇴 후 소득’ 중 근로·사업·공적연금·사적연금 수입(연, 세전, 명목)
  salary: number; // 은퇴 전 세전 총급여(부부, 연, 명목): 근로소득으로 종소세에 합산, 건보료(보수월액분)는 직장에서 내므로 제외
  hiMode: HiMode; // 그 해 건보료 자격(급여가 있는 사람은 직장가입자)
  hiDepWhy?: string; // workRegion 일 때 피부양자에서 빠진 이유(예: "배우자: 합산소득 2,400만원(사적연금 2,400만원 포함)이 2,000만원 초과")
  hiWork: number; // 월 소득월액 보험료(직장가입자의 급여 외 소득 2,000만 초과분, 장기요양 포함)
  incomeSelf: number; // 본인 종합소득금액(임대·사업소득 + 근로소득금액 + 연금소득금액)
  incomeSpouse: number;
  taxSelf: number; // 본인 종합소득세 결정세액(지방세 포함, 근로소득세액공제 뒤)
  taxSpouse: number;
  withheld: number; // 기납부세액: 국민연금 원천징수 + 근로소득 연말정산 세액
  wageWithheld: number; // 그중 근로소득 원천징수(연말정산 결정세액)
  due: number; // 5월 종합소득세 추가 납부(부부)
  propBase: number; // 재산 과세표준(자산별 추정일 때, 대출 공제 뒤, 명목)
  loanDed: number; // 그중 주택 구입 대출 공제액(명목)
  hiProp: number; // 월 재산분(장기요양 포함)
  hiMonth: number; // 월 건강보험료(장기요양 포함)
  hiYear: number; // 연 건강보험료
  total: number; // 연 부담 합계(종소세 + 건보료)
  increase: number; // 기준 해(baseYear) 대비 증가분
  baseYear: number; // 비교 기준 해: 첫해. 은퇴 전 급여가 있으면 급여가 모두 끝난 해부터는 그 해(은퇴 후 구간)
  npPart: number; // 그중 국민연금 몫
  rentPart: number; // 그중 임대료 인상 몫
  yuPaySelf: number; // 노란우산 소득공제 기준 납입액(본인, 명목): 올해는 남은 달분, 프로필 yuDedFullYear 면 1~12월 전체
  yuPaySpouse: number;
  yuDedSelf: number; // 노란우산 소득공제(본인, 명목): 사업소득금액(임대 제외) 구간별 한도, 법인 대표자는 근로소득금액
  yuDedSpouse: number;
  yuSave: number; // 노란우산 소득공제로 줄어든 종합소득세(부부, 지방세 포함, 명목): 다음 해 5월에 돌려받는 돈으로 봄
}

/**
 * 연도별 종합소득세·지역 건강보험료(명목, 만원). 엑셀 ‘종합소득·건보료’ 시트와 같은 방식:
 * 사적연금(1,500만 이하 분리과세)·퇴직소득·노란우산은 종합소득·건보료에 넣지 않음.
 * ‘그 밖의 은퇴 후 소득’은 종류별로: 임대 = 필요경비율 차감(설정의 배우자 몫), 근로 = 근로소득공제·근로소득세액공제·표준세액공제,
 * 연말정산으로 낸 세금(근로소득만 있다고 본 결정세액)은 기납부로 빼서 5월에는 다른 소득과 합쳐 늘어난 만큼만 냄, 건보료 총급여 × 반영률,
 * 사업 = 항목별 필요경비율 차감·건보료 100%, 공적연금 = 국민연금과 합쳐 연금소득공제·건보료 × 반영률,
 * 사적연금 = 종소세 제외·건보료는 hiPrivate 일 때만, 그 밖 = 계산 제외. 임대 외에는 ‘나이 기준’ 사람의 소득으로 봄.
 * 은퇴 전 세전 총급여(wageGross·spouseWageGross)는 각자 은퇴 전 해까지 근로소득으로 합쳐 세율 구간·근로소득세액공제·기납부에 반영하고,
 * 급여(보수월액)분 건보료는 직장에서 이미 냈다고 보고 넣지 않음.
 * 급여가 있는 사람은 그 해 직장가입자: 재산분이 없고, 급여 외 소득(임대·사업 + (공적연금·근로) × 반영률)이 연 2,000만을 넘는 부분에만 소득월액 보험료.
 * 부부 중 한 명만 일하면 다른 한 명은 피부양자 요건(hiDependent: 사업소득 없음 · 합산소득 2,000만 이하 · 자산별 추정일 때 본인 명의 재산 과표)을
 * 채우면 0, 못 채우면 그 사람만 지역가입자(본인 소득 + 본인 명의 재산분, 고지서 역산 방식이면 세대 재산분 × 본인 명의 부동산 비율)로 계산.
 * hiDepNoReg(사업자등록 없음)이면 임대 외 사업소득 연 500만 이하는 피부양자로 인정.
 * 건보료 소득분은 전년도 소득 기준, 재산분은 현재 고지서에서 역산해 고정(증가율 입력 가능)하거나 부동산 자산으로 연도별 추정(hiPropAuto).
 * slotByYear: 사적연금도 건보료에 반영할 때 연도별 과세재원 인출액(명목). [본인, 배우자]로 주면 사람별, 숫자 하나면 본인 몫으로 봄.
 * hiPrivate 이면 급여가 있는 해에도 사적연금을 사람별로 넣음: 직장가입자 급여 외 소득(× 반영률), 피부양자 판정 합산소득(전액), 지역가입자 본인 소득(× 반영률).
 * liabilities: 자산별 추정에서 주택 구입 대출 공제(hiLoanDeduct)를 켰을 때 쓰는 부채 목록.
 * 노란우산공제(자산에서 표시하고 연 납입액을 넣은 것)는 납입하는 해에 소득공제로 종합소득세를 줄임(건보료는 소득공제 전 소득이라 그대로).
 * firstShare: 올해 남은 달 비율(Summary.yearShare). 올해 노란우산 부금은 그만큼만 낸다고 보고 소득공제도 그 금액으로 셈.
 * 프로필 yuDedFullYear 면 올해 소득공제는 실제 세법처럼 1~12월 전체 납입액(지난 달 납입분 포함) 기준. 이때 행의 yuPaySelf·yuPaySpouse 도 그 금액.
 */
export function incomeTaxSchedule(profile: Profile, nowYear: number, slotByYear?: Map<number, number | [number, number]>, assets: Asset[] = [], liabilities: Liability[] = [], firstShare = 1): IncomeTaxRow[] {
  const s = { ...DEFAULT_INCOME_TAX, ...(profile.incomeTax ?? {}) };
  const inf = profile.inflation / 100;
  const currentAge = nowYear - profile.birthYear;
  const toSelf = (age: number, owner?: string) => (owner === 'spouse' ? spouseToSelf(profile, age) : age);
  // ‘그 밖의 은퇴 후 소득’ 임대료는 설정의 배우자 몫, 임대용 부동산 자산은 자산 명의·지분으로 나눔(세금은 경비 차감 전 월세 기준)
  const hasSpouse = profile.spouseBirthYear > 0;
  const rents: RentStream[] = [
    ...(profile.incomes ?? [])
      .filter((i) => incomeKindOf(i) === 'rent')
      .map((i) => ({ startAge: toSelf(i.startAge, i.owner), endAge: i.endAge > 0 ? toSelf(i.endAge, i.owner) : undefined, annual: i.monthly * 12, growth: i.growth, step: i.step, baseAge: currentAge, spouseShare: s.rentSpouseShare / 100 })),
    ...rentStreams(assets, profile, currentAge, true),
  ].map((r) => (hasSpouse ? r : { ...r, spouseShare: 0 }));
  const others = (profile.incomes ?? [])
    .map((i) => ({
      kind: incomeKindOf(i),
      spouse: hasSpouse && i.owner === 'spouse' ? 1 : 0,
      keep: 1 - Math.min(100, Math.max(0, i.expense ?? 0)) / 100,
      s: { startAge: toSelf(i.startAge, i.owner), endAge: i.endAge > 0 ? toSelf(i.endAge, i.owner) : undefined, annual: i.monthly * 12, growth: i.growth, step: i.step, baseAge: currentAge } as IncomeStream,
    }))
    .filter((o) => o.kind !== 'rent' && o.kind !== 'other');
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
  // 노란우산 소득공제 기준 납입액(연도별 [본인, 배우자], 명목): 올해는 남은 달분, yuDedFullYear 면 1~12월 전체
  const yuPay = new Map<number, [number, number]>();
  for (const x of yuPayments(assets, profile, nowYear, profile.yuDedFullYear ? 1 : firstShare)) {
    const v = yuPay.get(x.year) ?? [0, 0];
    v[x.owner === 'spouse' ? 1 : 0] += x.amount;
    yuPay.set(x.year, v);
  }
  let prop = 0;
  let prevP = 0;
  let prevNP = 0;
  let prevSlot = 0;
  let prevPriv = 0;
  // 사람별 사적연금(과세재원 인출 + ‘그 밖의 소득’ 사적연금, hiPrivate 일 때만), 전년도
  let prevPrivBy: [number, number] = [0, 0];
  const slotOf = (year: number): [number, number] => {
    const v = slotByYear?.get(year);
    return v === undefined ? [0, 0] : typeof v === 'number' ? [v, 0] : [v[0], hasSpouse ? v[1] : 0];
  };
  const privOf = (year: number, b: Record<string, [number, number]>): [number, number] => {
    if (!s.hiPrivate) return [0, 0];
    const sl = slotOf(year);
    return [sl[0] + b.privatePension[0], sl[1] + b.privatePension[1]];
  };
  let prevBy: { biz: [number, number]; rent: [number, number]; pen: [number, number]; wage: [number, number]; np: [number, number] } = { biz: [0, 0], rent: [0, 0], pen: [0, 0], wage: [0, 0], np: [0, 0] };
  let base = { year: nowYear, total: 0 };
  let baseSwitched = false;
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
    // 근로(총급여)·사업(경비 뺀 소득금액)·공적연금·사적연금 수입, [본인, 배우자]
    const by: Record<string, [number, number]> = { wage: [0, 0], business: [0, 0], publicPension: [0, 0], privatePension: [0, 0] };
    let other = 0;
    for (const o of others) {
      const v = incomeValue(o.s, age, profile.inflation) * defl;
      other += v;
      by[o.kind][o.spouse] += o.kind === 'business' ? v * o.keep : v;
    }
    const sum = (k: string) => by[k][0] + by[k][1];
    // 은퇴 전 세전 총급여(오늘 기준 → 명목): 은퇴한 해부터 0. 종소세 근로소득에만 합치고 건보료(직장가입자)에는 넣지 않음
    const salSelf = age < profile.retireAge ? Math.max(0, profile.wageGross ?? 0) * defl : 0;
    const salSpouse = hasSpouse && age < spouseRetireSelfAge(profile) ? Math.max(0, profile.spouseWageGross ?? 0) * defl : 0;
    const wage: [number, number] = [by.wage[0] + salSelf, by.wage[1] + salSpouse];
    // 사람별 종합소득금액(np: 그 사람 국민연금 세전 연액)
    const incomeOf = (k: 0 | 1, rentK: number, npK: number) =>
      rentK + wageIncomeAmount(wage[k]) + by.business[k] + pensionIncomeAmount(npK * (s.npTaxable / 100) + by.publicPension[k]);
    const incomeSelf = incomeOf(0, rentSelf, npSelf);
    const incomeSpouse = incomeOf(1, rentSpouse, npSpouse);
    // 노란우산 소득공제: 사업소득금액(임대 제외)이 있으면 그 금액 기준 한도, 없고 총급여 8,000만 이하면 법인 대표자로 보고 근로소득금액 기준
    const pay = yuPay.get(year) ?? [0, 0];
    const yuDedOf = (k: 0 | 1) => {
      if (!(pay[k] > 0)) return 0;
      const base = by.business[k] > 0 ? by.business[k] : wage[k] > 0 && wage[k] <= YU_CEO_WAGE ? wageIncomeAmount(wage[k]) : 0;
      return Math.min(pay[k], yuLimit(base), base);
    };
    const yuDed: [number, number] = [yuDedOf(0), hasSpouse ? yuDedOf(1) : 0];
    const dedSelf = s.dedSelf + yuDed[0];
    const dedSpouse = s.dedSpouse + yuDed[1];
    const taxSelf = personIncomeTax(incomeSelf, dedSelf, wage[0]);
    const taxSpouse = personIncomeTax(incomeSpouse, dedSpouse, wage[1]);
    const yuSave = yuDed[0] + yuDed[1] > 0 ? personIncomeTax(incomeSelf, s.dedSelf, wage[0]) + personIncomeTax(incomeSpouse, s.dedSpouse, wage[1]) - taxSelf - taxSpouse : 0;
    const np = npSelf + npSpouse;
    const wageWithheld = wageWithholding(wage[0], s.dedSelf) + wageWithholding(wage[1], s.dedSpouse);
    const withheld = np * (1 - net) + wageWithheld;
    const due = taxSelf + taxSpouse - withheld;
    const P = rentSelf + rentSpouse + sum('business') + (np + sum('publicPension') + sum('wage')) * pub;
    // 사람별 건보료 소득: 사업소득금액(임대 포함) · 공적연금 총액 · 근로 총급여(은퇴 전 급여 제외)
    const biz: [number, number] = [rentSelf + by.business[0], rentSpouse + by.business[1]];
    const pen: [number, number] = [npSelf + by.publicPension[0], npSpouse + by.publicPension[1]];
    const npBy: [number, number] = [npSelf, npSpouse];
    const emp: [boolean, boolean] = [salSelf > 0, salSpouse > 0];
    const anyWork = emp[0] || emp[1];
    if (n === 0) {
      prevP = P;
      prevNP = np;
      prevSlot = slotOf(year)[0] + slotOf(year)[1];
      prevPriv = sum('privatePension');
      prevPrivBy = privOf(year, by);
      prevBy = { biz, rent: [rentSelf, rentSpouse], pen, wage: [by.wage[0], by.wage[1]], np: npBy };
    }
    const gross = s.hiPropAuto ? hiPropBase(assets, nowYear, year, s.hiPubRatio ?? 69, s.hiFairRatio ?? 60) : 0;
    const loanFull = s.hiPropAuto && s.hiLoanDeduct ? Math.min(gross, hiLoanDeduct(assets, liabilities, nowYear, year, currentAge)) : 0;
    const Z = s.hiPrivate ? ((prevSlot + prevPriv) * pub * rate) / 12 : 0;
    // 급여가 있는 해: 일하는 사람은 직장가입자(소득월액 보험료), 나머지 한 명은 피부양자 또는 혼자 지역가입자. dropNP: 국민연금을 뺀 경우(국민연금 몫 계산용)
    // 사적연금(hiPrivate)은 사람별로 연금처럼: 급여 외 소득·지역 소득분은 × 반영률, 피부양자 판정 합산소득은 전액
    const mixed = (propNow: number, dropNP = false) => {
      const penOf = (k: number) => prevBy.pen[k] - (dropNP ? prevBy.np[k] : 0) + prevPrivBy[k];
      const extra = (k: number) => prevBy.biz[k] + (penOf(k) + prevBy.wage[k]) * pub;
      const who = hasSpouse ? [0, 1] : [0];
      const work = who.filter((k) => emp[k]).reduce((a, k) => a + (Math.max(0, extra(k) - HI_WORK_EXTRA) / 12) * rate, 0);
      const k = who.find((x) => !emp[x]);
      if (k === undefined) return { mode: 'work' as HiMode, work, Q: 0, R: 0, Z: 0, share: 1, propBase: 0, loanDed: 0 };
      const own = s.hiPropAuto ? hiPropBaseOf(assets, nowYear, year, s.hiPubRatio ?? 69, s.hiFairRatio ?? 60, k as 0 | 1) : 0;
      const loanDed = gross > 0 ? (loanFull * own) / gross : 0;
      const propBase = own - loanDed;
      const noReg = s.hiDepNoReg ? { rent: prevBy.rent[k] } : undefined;
      const why = hiDependentWhy(prevBy.biz[k], prevBy.biz[k] + penOf(k) + prevBy.wage[k], s.hiPropAuto ? propBase : null, noReg, prevPrivBy[k]);
      if (why === null) return { mode: 'workDep' as HiMode, work, Q: 0, R: 0, Z: 0, share: 1, propBase: 0, loanDed: 0 };
      const depWhy = `${k === 0 ? '본인' : '배우자'}: ${why}`;
      // 고지서 역산 방식: 세대 재산분을 그 사람 명의 부동산 비율만큼만(부동산 자산이 없으면 나눌 수 없어 전체)
      const share = s.hiPropAuto ? 1 : (hiPropShare(assets, nowYear, year, k as 0 | 1) ?? 1);
      return { mode: 'workRegion' as HiMode, work, Q: (extra(k) / 12) * rate, R: s.hiPropAuto ? hiPropMonthly(propBase) : propNow * share, Z: 0, share, propBase, loanDed, depWhy }; // 사적연금은 extra 에 들어 있어 Z 는 0
    };
    if (n === 0) {
      // 재산분 역산: 지금 고지서에서 소득분을 뺀 나머지. 한 명 직장 + 한 명 지역이면 소득월액 보험료와 지역 소득분을 뺌.
      // 세대에 지역가입자가 없으면(모두 직장·피부양자) 입력값을 ‘지역가입자가 됐을 때의 보험료’로 보고 예전처럼 역산(은퇴 후 재산분에만 쓰임)
      const m0 = anyWork ? mixed(0) : null;
      // ‘직장+지역’이면 고지서 재산분은 그 사람 명의 몫이므로 명의 비율로 나눠 세대 재산분으로 되돌림(명의 부동산이 없으면 그대로)
      prop = Math.max(0, m0?.mode === 'workRegion' ? (s.hiNow / ltc - m0.work - m0.Q - m0.Z) / (m0.share > 0 ? m0.share : 1) : s.hiNow / ltc - (P / 12) * rate);
    }
    const propNow = prop * Math.pow(1 + s.hiPropGrowth / 100, n);
    const hi = anyWork
      ? mixed(propNow)
      : { mode: 'region' as HiMode, work: 0, Q: (prevP / 12) * rate, R: s.hiPropAuto ? hiPropMonthly(gross - loanFull) : propNow, Z, propBase: gross - loanFull, loanDed: loanFull };
    const { R, propBase, loanDed } = hi;
    const hiMonth = (hi.work + hi.Q + hi.R + hi.Z) * ltc;
    const hiYear = hiMonth * 12;
    const total = due + hiYear;
    // 은퇴 전 급여가 있으면 급여가 모두 끝난 해를 은퇴 후 구간의 기준으로 삼음(급여가 빠져 세금이 줄어든 걸 ‘감소’로 보이지 않게)
    const salary = salSelf + salSpouse;
    if (n === 0) base = { year, total };
    else if (!baseSwitched && rows[0].salary > 0 && salary === 0) {
      base = { year, total };
      baseSwitched = true;
    }
    const increase = total - base.total;
    // 국민연금이 없을 때 5월 납부액(근로 원천징수는 그대로 빠짐)
    const taxNoNP = personIncomeTax(incomeOf(0, rentSelf, 0), dedSelf, wage[0]) + personIncomeTax(incomeOf(1, rentSpouse, 0), dedSpouse, wage[1]) - wageWithheld;
    // 건보료 중 국민연금 몫: 지역은 전년도 국민연금 × 반영률 × 요율, 직장가입자가 있는 해는 국민연금을 뺐을 때와의 차이
    let npHi = prevNP * pub * rate * ltc;
    if (anyWork) {
      const no = mixed(propNow, true);
      npHi = hiYear - (no.work + no.Q + no.R + no.Z) * ltc * 12;
    }
    const npPart = due - taxNoNP + npHi;
    rows.push({ year, age, defl, rent, rentSelf, rentSpouse, npSelf, npSpouse, other, salary, hiMode: hi.mode, hiDepWhy: 'depWhy' in hi ? hi.depWhy : undefined, hiWork: hi.work * ltc, incomeSelf, incomeSpouse, taxSelf, taxSpouse, withheld, wageWithheld, due, propBase, loanDed, hiProp: R * ltc, hiMonth, hiYear, total, increase, baseYear: base.year, npPart, rentPart: increase - npPart, yuPaySelf: pay[0], yuPaySpouse: hasSpouse ? pay[1] : 0, yuDedSelf: yuDed[0], yuDedSpouse: yuDed[1], yuSave });
    prevP = P;
    prevNP = np;
    prevSlot = slotOf(year)[0] + slotOf(year)[1];
    prevPriv = sum('privatePension');
    prevPrivBy = privOf(year, by);
    prevBy = { biz, rent: [rentSelf, rentSpouse], pen, wage: [by.wage[0], by.wage[1]], np: npBy };
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

/** 노란우산 소득공제로 줄어든 종합소득세(다음 해 들어오는 실질 금액, 본인 나이) */
export function yuSaveInflows(profile: Profile, nowYear: number, rows: IncomeTaxRow[]) {
  return rows
    .filter((r) => r.yuSave > 0)
    .map((r) => ({ name: '노란우산 소득공제 절세', kind: 'yuSave' as const, age: r.year + 1 - profile.birthYear, amount: r.yuSave / Math.pow(1 + profile.inflation / 100, r.year + 1 - nowYear) }));
}

/** 그 해 그 사람 노란우산 납입액 중 소득공제 받은 비율(종소세 추정 행 기준). 그 해 행이 없으면 모두 공제받는다고 봄 */
/**
 * 자산 탭 노란우산 안내용: 이 계좌가 처음 납입하는 해의 납입액(올해는 남은 달만큼)과 그중 소득공제 받는 금액, 그 해 줄어든 종합소득세(부부 합계).
 * 공제 기준 납입액은 프로필 ‘올해 소득공제 1~12월 기준’이면 올해만 1~12월 전체, 공제액 = 공제 기준 납입액 × 명의자 공제 비율.
 * rows는 incomeTaxSchedule(…, firstShare)와 같은 비율로 만든 행(종합소득세 카드·이정표와 같은 금액)
 */
export function yuAssetDed(a: Asset, profile: Profile, nowYear: number, firstShare: number, rows: IncomeTaxRow[]) {
  const owner = a.owner === 'spouse' && profile.spouseBirthYear > 0 ? 'spouse' : 'self';
  const row = rows.find((r) => (owner === 'spouse' ? r.yuPaySpouse : r.yuPaySelf) > 0);
  if (!row) return undefined;
  const amt = (share: number) => yuPayments([a], profile, nowYear, share).find((x) => x.year === row.year)?.amount ?? 0;
  const dedBase = amt(profile.yuDedFullYear ? 1 : firstShare);
  return { row, owner, pay: amt(firstShare), dedBase, ded: dedBase * yuDedFracOf(rows)(row.year, owner), save: row.yuSave };
}

export function yuDedFracOf(rows: IncomeTaxRow[]) {
  const by = new Map(rows.map((r) => [r.year, r]));
  return (year: number, owner: 'self' | 'spouse') => {
    const r = by.get(year);
    if (!r) return 1;
    const pay = owner === 'spouse' ? r.yuPaySpouse : r.yuPaySelf;
    const ded = owner === 'spouse' ? r.yuDedSpouse : r.yuDedSelf;
    return pay > 0 ? ded / pay : 1;
  };
}

/** 국민연금 때문에 늘어나는 종소세·건보료(실질, 본인 나이별) — ‘인출에 더하기’를 켰을 때 지출로 반영 */
export function npCostOutflows(rows: IncomeTaxRow[]) {
  return rows.filter((r) => r.npPart > 0).map((r) => ({ age: r.age, amount: r.npPart / r.defl, npTax: true as const, flow: true as const }));
}
