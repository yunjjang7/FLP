import type { Asset, IncomeOwner, Profile } from '../types';
import { incomeTaxAmount } from './incomeTax';

/**
 * 노란우산공제(소기업·소상공인 공제부금, 조세특례제한법 86조의3). 금액 단위: 만원
 * - 납입하는 해: 사업소득금액(부동산임대업 소득 제외) 구간별 한도까지 소득공제 → 종합소득세가 줄어듦.
 *   법인 대표자는 총급여 8,000만원 이하일 때 근로소득금액 기준으로 같은 한도(2025년 납입분부터).
 * - 폐업·노령(60세 이상·10년 이상 납입) 등으로 받을 때: 소득공제 받은 부금과 운용수익은 퇴직소득으로 과세,
 *   소득공제를 받지 못한 부금은 과세하지 않음. 임의 해지는 기타소득(16.5%)이라 이 계산에 넣지 않음.
 */

/** 소득공제 한도(2025년 납입분부터): 사업소득금액 4,000만 이하 600 · 6,000만 이하 500 · 1억 이하 400 · 초과 200 */
export function yuLimit(bizIncome: number) {
  if (bizIncome <= 0) return 0;
  return bizIncome <= 4000 ? 600 : bizIncome <= 6000 ? 500 : bizIncome <= 10000 ? 400 : 200;
}

/** 법인 대표자 소득공제 요건: 총급여 8,000만원 이하(2025년 납입분부터, 그 전 7,000만원) */
export const YU_CEO_WAGE = 8000;

/** 노란우산공제로 계산하는 자산: 표시했고 수령 연도가 있는 금융자산 */
export const isYu = (a: Asset) => !!a.yu && a.type !== 'realestate';

/** 명의자가 은퇴하는 해(본인 나이 기준 은퇴 나이, 배우자는 배우자 은퇴 나이) */
function ownerRetireYear(a: Asset, profile: Profile) {
  return a.owner === 'spouse' && profile.spouseBirthYear > 0 ? profile.spouseBirthYear + (profile.spouseRetireAge ?? 0) : profile.birthYear + profile.retireAge;
}

/** 1~12 정수인 월·개월 수만 받음(그 밖은 없음) */
export const validMonths = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 12 ? v : undefined);

/** 마지막 납입 연도에 낸 개월 수(1~12, 비우면 12) */
export const yuLastMonthsOf = (a: Asset) => validMonths(a.yuLastMonths) ?? 12;

/**
 * 퇴직소득세 근속연수(가입 기간): 가입한 달부터 수령한 달까지 개월 수를 12로 나눠 올림(1년 미만은 1년), 최소 1년.
 * 예: 2020년 9월 가입 → 2040년 3월 수령 = 19년 6개월 → 20년, 2040년 10월 수령 = 20년 1개월 → 21년.
 * 가입 월·수령 월을 둘 다 비우면 예전처럼 ‘수령 연도 − 가입 연도’(가입 연도를 비우면 올해). 하나만 넣으면 비운 쪽은 1월
 */
export function yuService(a: Asset, nowYear: number): { years: number; months: number } {
  const join = (a.yuJoin ?? 0) > 0 ? a.yuJoin! : nowYear;
  const payout = a.lockYear ?? nowYear;
  const jm = validMonths(a.yuJoinMonth);
  const pm = validMonths(a.yuPayoutMonth);
  if (jm === undefined && pm === undefined) return { years: Math.max(1, payout - join), months: Math.max(0, (payout - join) * 12) };
  const months = Math.max(0, (payout - join) * 12 + (pm ?? 1) - (jm ?? 1));
  return { years: Math.max(1, Math.ceil(months / 12)), months };
}

/** 마지막 납입 연도: 직접 넣으면 그 해, 비우면 명의자 은퇴 전 해. 수령 연도 전 해를 넘지 않음 */
export function yuPayTo(a: Asset, profile: Profile) {
  const to = (a.yuPayTo ?? 0) > 0 ? a.yuPayTo! : ownerRetireYear(a, profile) - 1;
  return (a.lockYear ?? 0) > 0 ? Math.min(to, a.lockYear! - 1) : to;
}

export interface YuPayment {
  asset: Asset;
  year: number;
  owner: IncomeOwner;
  amount: number; // 그 해 납입액(명목). 올해는 남은 달 비율만큼, 다음 해부터 1년치
}

/**
 * 앞으로 낼 노란우산 부금(올해부터 마지막 납입 연도까지, 명목 고정).
 * firstShare: 올해 남은 달 비율(Summary.yearShare). 지난 달 납입분은 이미 ‘지금 금액’에 들어 있으므로 올해는 그만큼만 냄.
 * 마지막 납입 연도는 1월부터 yuLastMonths 개월(비우면 12)만 냄. 그 해가 올해면 두 조건이 겹치는 달만
 * (예: 11월 계산, 남은 2개월 · 마지막 해 12개월 → 2/12, 마지막 해 3개월 → 이미 끝나 0).
 * 적립금(yuPayout)·소득공제(incomeTaxSchedule)·금융자산 지출(yuPayOutflows)이 모두 이 금액을 씀
 */
export function yuPayments(assets: Asset[], profile: Profile, nowYear: number, firstShare = 1): YuPayment[] {
  const passed = 1 - Math.min(1, Math.max(0, firstShare)); // 올해 이미 지난 비율
  const out: YuPayment[] = [];
  for (const a of assets) {
    if (!isYu(a) || !((a.yuPay ?? 0) > 0) || !((a.lockYear ?? 0) > nowYear)) continue;
    const owner: IncomeOwner = a.owner === 'spouse' && profile.spouseBirthYear > 0 ? 'spouse' : 'self';
    const last = yuPayTo(a, profile);
    for (let year = nowYear; year <= last; year++) {
      // 그 해 낸 기간 = (끝: 마지막 해면 개월 ÷ 12, 아니면 1) − (시작: 올해면 지난 비율, 아니면 0)
      const share = Math.max(0, (year === last ? yuLastMonthsOf(a) / 12 : 1) - (year === nowYear ? passed : 0));
      if (share > 0) out.push({ asset: a, year, owner, amount: a.yuPay! * share });
    }
  }
  return out;
}

/** 근속연수공제(2023년~): 5년 이하 100만 × 연수, 10년 이하 500 + 200 × (연수 − 5), 20년 이하 1,500 + 250 × (연수 − 10), 초과 4,000 + 300 × (연수 − 20) */
export function serviceDeduction(years: number) {
  const n = Math.max(1, Math.ceil(years));
  return n <= 5 ? 100 * n : n <= 10 ? 500 + 200 * (n - 5) : n <= 20 ? 1500 + 250 * (n - 10) : 4000 + 300 * (n - 20);
}

/** 환산급여공제: 800만 이하 전액, 7,000만 이하 800 + 초과분 60%, 1억 이하 4,520 + 55%, 3억 이하 6,170 + 45%, 초과 15,170 + 35% */
export function convertedDeduction(x: number) {
  if (x <= 800) return x;
  return x <= 7000 ? 800 + (x - 800) * 0.6 : x <= 10000 ? 4520 + (x - 7000) * 0.55 : x <= 30000 ? 6170 + (x - 10000) * 0.45 : 15170 + (x - 30000) * 0.35;
}

/**
 * 퇴직소득세(지방소득세 포함, 만원): (퇴직소득 − 근속연수공제) × 12 ÷ 근속연수 = 환산급여,
 * 환산급여 − 환산급여공제 = 과세표준, 기본세율 산출세액 × 근속연수 ÷ 12. 노란우산은 가입 기간을 근속연수로 봄
 */
export function retireIncomeTax(amount: number, years: number) {
  if (amount <= 0) return 0;
  const n = Math.max(1, Math.ceil(years));
  const conv = (Math.max(0, amount - serviceDeduction(n)) * 12) / n;
  return (incomeTaxAmount(conv - convertedDeduction(conv)) * n) / 12;
}

/** 그 해 그 사람 납입액 중 소득공제를 받은 비율(0~1). 종합소득세 추정 행(yuPaySelf·yuDedSelf 등)에서 구함 */
export type YuDedFrac = (year: number, owner: IncomeOwner) => number;

export interface YuPayout {
  year: number;
  fv: number; // 수령 연도 적립금(명목, 세전)
  paid: number; // 앞으로 낼 부금 합계(명목)
  nonDed: number; // 소득공제를 받지 않은 부금(과세제외 + 앞으로 공제 못 받을 부금)
  futureNonDed: number; // 그중 앞으로 낼 부금에서 공제 못 받는 금액(사업소득이 없거나 한도 초과) → 비과세
  taxable: number; // 퇴직소득으로 과세되는 금액(소득공제 받은 부금 + 운용수익)
  years: number; // 가입 기간(근속연수, 1년 미만은 올림)
  months: number; // 실제 가입 기간(개월, 가입 월·수령 월을 비우면 연도 차이 × 12)
  tax: number; // 세금(명목)
  auto: boolean; // 퇴직소득세를 자동 계산했는지(수령 시 세율을 직접 넣으면 false)
  rate: number; // 실효세율(적립금 대비 %)
}

/**
 * 노란우산 수령액: 지금 적립금과 앞으로 낼 부금(그 해 말 납입)이 기대수익률로 수령 연도까지 불어남.
 * 수령 시 세율을 직접 넣으면 적립금 × 세율, 비우면(0) 퇴직소득세를 자동 계산.
 * firstShare: 올해 남은 달 비율(올해 부금은 그만큼만 셈), dedFrac 이 없으면 앞으로 낼 부금은 모두 소득공제 받는다고 봄.
 */
export function yuPayout(a: Asset, profile: Profile, nowYear: number, dedFrac?: YuDedFrac, firstShare = 1): YuPayout {
  const year = a.lockYear ?? nowYear;
  const r = 1 + a.expectedReturn / 100;
  const owner: IncomeOwner = a.owner === 'spouse' && profile.spouseBirthYear > 0 ? 'spouse' : 'self';
  let fv = a.amount * Math.pow(r, Math.max(0, year - nowYear));
  let paid = 0;
  const pastNonDed = Math.max(0, a.taxFree ?? 0);
  let nonDed = pastNonDed;
  for (const p of yuPayments([a], profile, nowYear, firstShare)) {
    const amt = p.amount;
    paid += amt;
    fv += amt * Math.pow(r, Math.max(0, year - p.year - 1));
    nonDed += amt * (1 - (dedFrac ? Math.min(1, Math.max(0, dedFrac(p.year, owner))) : 1));
  }
  const taxable = Math.max(0, fv - nonDed);
  const { years, months } = yuService(a, nowYear);
  const auto = !((a.lockTax ?? 0) > 0);
  const tax = auto ? retireIncomeTax(taxable, years) : (fv * a.lockTax!) / 100;
  return { year, fv, paid, nonDed, futureNonDed: nonDed - pastNonDed, taxable, years, months, tax, auto, rate: fv > 0 ? (tax / fv) * 100 : 0 };
}
