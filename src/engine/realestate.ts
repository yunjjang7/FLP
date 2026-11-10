import type { Asset, Profile, ReUse } from '../types';
import type { IncomeStream } from './montecarlo';

/** 부동산 용도: 거주용 · 임대용 · 투자·기타(토지·분양권 등 시세차익) */
export const RE_USE: Record<ReUse, string> = { home: '거주용', rental: '임대용', land: '투자·기타' };
export const RE_USE_HINT: Record<ReUse, string> = {
  home: '팔기 전까지 노후 자금에 넣지 않음',
  rental: '월세는 은퇴 후 소득, 보증금은 부채',
  land: '팔기 전까지 노후 자금에 넣지 않음',
};

/** 임대 기본값: 주택임대차 2년 계약 · 갱신 시 5% 상한 */
export const RENT_DEFAULT = { renewCycle: 2, renewRate: 5 };

export const isRealEstate = (a: Asset) => a.type === 'realestate';
export const reUseOf = (a: Asset): ReUse => a.reUse ?? 'home';

/** 본인 지분(0~1): 본인 1 · 배우자 0 · 공동명의는 본인 지분율 */
export function selfShare(a: Asset) {
  if (a.owner === 'spouse') return 0;
  if (a.owner === 'joint') return Math.min(100, Math.max(0, a.ownerShare ?? 50)) / 100;
  return 1;
}

/** 임대보증금(돌려줘야 할 돈 → 부채) */
export const depositOf = (a: Asset) => (isRealEstate(a) && reUseOf(a) === 'rental' ? Math.max(0, a.deposit ?? 0) : 0);

/** 월세 순수입(월, 만원): 월세 × (1 − 공실·관리 경비율) */
export const netRentOf = (a: Asset) => (isRealEstate(a) && reUseOf(a) === 'rental' ? Math.max(0, a.rent ?? 0) * (1 - Math.min(100, Math.max(0, a.rentCost ?? 0)) / 100) : 0);

/** 임대수익률(%): 연 월세 ÷ (시세 − 보증금) — 실제 묶인 자기 돈 대비 */
export function rentYield(a: Asset) {
  const equity = a.amount - depositOf(a);
  return equity > 0 ? ((a.rent ?? 0) * 12 * 100) / equity : 0;
}

/** 매각 예정인지(매각 연도가 올해 이후). 주택연금을 쓰면 매각하지 않음 */
export const willSell = (a: Asset, nowYear: number) => isRealEstate(a) && !usesHp(a) && (a.lockYear ?? 0) > nowYear;

export interface SaleInflow {
  name: string;
  year: number;
  age: number; // 본인 나이
  price: number; // 매각 시세(명목)
  cost: number; // 양도세·중개보수 등(명목)
  deposit: number; // 돌려줄 보증금(명목)
  rebuy: number; // 새 집 구입액(명목, 다운사이징)
  nominal: number; // 손에 남는 금액(명목)
  amount: number; // 손에 남는 금액(현재가치)
}

/**
 * 부동산 매각: 시세가 시세 상승률로 매각 연도까지 오른 뒤 비용(양도세·중개보수 실효율)을 떼고,
 * 임대보증금을 돌려주고, 거주용이면 새 집 구입액(오늘 시세, 같은 상승률로 오름)을 뺀 금액이 금융자산으로 들어옴.
 */
export function saleInflow(a: Asset, profile: Profile, nowYear: number): SaleInflow {
  const year = a.lockYear ?? nowYear;
  const n = Math.max(0, year - nowYear);
  const g = Math.pow(1 + a.expectedReturn / 100, n);
  const price = a.amount * g;
  const cost = (price * Math.max(0, a.lockTax ?? 0)) / 100;
  const deposit = depositOf(a);
  const rebuy = reUseOf(a) === 'home' ? Math.max(0, a.reBuy ?? 0) * g : 0;
  const nominal = price - cost - deposit - rebuy;
  return { name: a.name, year, age: year - profile.birthYear, price, cost, deposit, rebuy, nominal, amount: nominal / Math.pow(1 + profile.inflation / 100, n) };
}

/** 매각 예정 부동산 → 시뮬레이션 유입(실질, 본인 나이) */
export function saleInflows(assets: Asset[], profile: Profile, nowYear: number) {
  return assets.filter((a) => willSell(a, nowYear)).map((a) => {
    const s = saleInflow(a, profile, nowYear);
    return { name: s.name, age: s.age, amount: s.amount, kind: 'sale' as const };
  });
}

export interface RentStream extends IncomeStream {
  spouseShare: number; // 임대소득 중 배우자 몫(0~1)
}

/**
 * 임대용 부동산의 월세 흐름. 금액은 오늘 기준이고 계약 갱신 주기마다 갱신 인상률만큼 오름(지금부터 셈).
 * 매각 연도 전 해까지 받음. gross=true 면 경비 차감 전(세금 계산용), 아니면 공실·관리 경비를 뺀 순수입(현금흐름용).
 * 시뮬레이션은 은퇴 후에만 소득을 쓰므로 은퇴 전 월세는 세후 월소득에 들어 있는 것으로 봄.
 */
export function rentStreams(assets: Asset[], profile: Profile, currentAge: number, gross = false): RentStream[] {
  const nowYear = profile.birthYear + currentAge;
  return assets
    .filter((a) => isRealEstate(a) && reUseOf(a) === 'rental' && (a.rent ?? 0) > 0 && !((a.lockYear ?? 0) > 0 && a.lockYear! <= nowYear))
    .map((a) => ({
      name: `${a.name || '임대 부동산'} 월세`,
      startAge: gross ? currentAge : Math.max(currentAge, profile.retireAge),
      endAge: willSell(a, nowYear) ? a.lockYear! - profile.birthYear - 1 : undefined,
      annual: (gross ? a.rent ?? 0 : netRentOf(a)) * 12,
      growth: a.renewRate ?? RENT_DEFAULT.renewRate,
      step: Math.max(1, Math.round(a.renewCycle ?? RENT_DEFAULT.renewCycle)),
      baseAge: currentAge,
      spouseShare: 1 - selfShare(a),
    }))
    .filter((s) => s.annual > 0 && (s.endAge === undefined || s.endAge >= s.startAge));
}

/** 이름 비교용: 공백·기호와 ‘월세·임대료·임대·수입’ 같은 흔한 말을 뺌 */
const rentKey = (s: string) => s.toLowerCase().replace(/월세|임대료|임대수입|임대소득|임대|수입|소득/g, '').replace(/[^0-9a-z가-힣]/g, '');

/**
 * ‘그 밖의 은퇴 후 소득’ 임대소득 항목이 자산 탭 임대용 부동산과 겹쳐 보이는지:
 * 이름이 비슷하거나(한쪽이 다른 쪽을 포함, 2글자 이상) 월액이 월세(또는 경비 뺀 월세)와 같으면 그 부동산들을 돌려줌.
 */
export function rentDuplicates(income: { name: string; monthly: number }, assets: Asset[]): { asset: Asset; by: 'name' | 'amount' }[] {
  const k = rentKey(income.name ?? '');
  return assets
    .filter((a) => isRealEstate(a) && reUseOf(a) === 'rental' && (a.rent ?? 0) > 0)
    .flatMap((a): { asset: Asset; by: 'name' | 'amount' }[] => {
      const ak = rentKey(a.name ?? '');
      const near = k.length >= 2 && ak.length >= 2 && (ak.includes(k) || k.includes(ak));
      if (near) return [{ asset: a, by: 'name' as const }];
      const m = income.monthly ?? 0;
      const same = m > 0 && (Math.abs(m - (a.rent ?? 0)) < 0.5 || Math.abs(m - netRentOf(a)) < 0.5);
      return same ? [{ asset: a, by: 'amount' as const }] : [];
    });
}

/**
 * 주택연금(한국주택금융공사, 일반주택 · 종신지급 정액형, 2026.3.1 기준 월지급금 예시).
 * 연령(부부 중 연소자)별 주택가격 1억원당 월지급금과 연령별 월 최대 지급액(만원). 사이 나이는 직선 보간.
 */
const HP_AGES = [55, 60, 65, 70, 75, 80];
const HP_PER_EOK = [15.6, 21.07, 25.29, 30.78, 38.12, 48.3];
const HP_CAP = [187.2, 252.8, 303.5, 341.4, 366.6, 406.0];
/** 가입 가능 주택: 공시가격 12억 이하(시세로 대략 17억 안팎) */
export const HP_PRICE_CAP = 120000;

function interp(xs: number[], ys: number[], x: number) {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  const i = xs.findIndex((v) => v > x) - 1;
  return ys[i] + ((ys[i + 1] - ys[i]) * (x - xs[i])) / (xs[i + 1] - xs[i]);
}

/** 주택연금 월지급금 추정(만원): 주택가격(12억까지) × 1억당 지급액, 연령별 최대 지급액 한도 */
export function hpEstimate(price: number, age: number) {
  return Math.min((interp(HP_AGES, HP_PER_EOK, age) * Math.min(price, HP_PRICE_CAP)) / 10000, interp(HP_AGES, HP_CAP, age));
}

/** 주택연금을 쓰는 거주용 부동산인지(가입 나이 입력) — 이때 매각 계획은 쓰지 않음 */
export const usesHp = (a: Asset) => isRealEstate(a) && reUseOf(a) === 'home' && (a.hpAge ?? 0) > 0;

export interface HousePension {
  name: string;
  startAge: number; // 받기 시작하는 본인 나이(이미 가입했으면 지금 나이)
  joinYear: number;
  calcAge: number; // 지급액 기준 나이(부부 중 연소자)
  eligible: boolean; // 부부 중 한 명이 55세 이상
  price: number; // 가입 때 예상 시세(명목)
  auto: boolean; // 월 수령액 자동 추정인지
  nominal: number; // 가입 때 월 수령액(명목, 이후 평생 같은 금액)
  real: number; // 가입 때 월 수령액(현재가치)
}

/**
 * 주택연금: 가입 나이(본인 기준)의 예상 시세로 월지급금을 추정하거나 직접 넣은 금액(오늘 기준)을 씀.
 * 정액형이라 가입 뒤에는 명목 금액이 평생 같고(실질로는 물가만큼 줄어듦), 부부 중 한 명이 살아 있는 동안 받음.
 * 대출 형식이라 소득세·건강보험료 대상이 아님.
 */
export function housePension(a: Asset, profile: Profile, currentAge: number): HousePension {
  const startAge = Math.max(currentAge, a.hpAge ?? 0);
  const n = startAge - currentAge;
  const joinYear = profile.birthYear + startAge;
  const spouseAge = profile.spouseBirthYear > 0 ? joinYear - profile.spouseBirthYear : startAge;
  const calcAge = Math.min(startAge, spouseAge);
  const infl = Math.pow(1 + profile.inflation / 100, n);
  const price = a.amount * Math.pow(1 + a.expectedReturn / 100, n);
  const auto = !((a.hpMonthly ?? 0) > 0);
  const nominal = auto ? hpEstimate(price, calcAge) : a.hpMonthly! * infl;
  return { name: `${a.name || '주택'} 주택연금`, startAge, joinYear, calcAge, eligible: Math.max(startAge, spouseAge) >= 55, price, auto, nominal, real: nominal / infl };
}

/** 주택연금 → 은퇴 후 연금 소득(명목 고정: 인상률 0으로 지금부터 물가만큼 실질 감소) */
export function hpStreams(assets: Asset[], profile: Profile, currentAge: number): IncomeStream[] {
  return assets
    .filter(usesHp)
    .map((a) => housePension(a, profile, currentAge))
    .filter((h) => h.eligible && h.nominal > 0)
    .map((h) => ({ name: h.name, kind: 'pension' as const, startAge: h.startAge, annual: h.nominal * 12, growth: 0, step: 1, baseAge: currentAge }));
}

/** 주택연금 대출 조건(한국주택금융공사): 금리 = 신규취급액 COFIX + 0.85%p(COFIX 2.95% 가정), 초기보증료 주택가격 1.0%, 연보증료 잔액 0.95% */
export const HP_LOAN = { rate: 3.8, initFee: 1.0, annualFee: 0.95 };

/** 이 집의 주택연금 대출 조건: 입력값이 없으면 HP_LOAN 기본값 */
export const hpLoanOf = (a: Asset) => ({ rate: a.hpRate ?? HP_LOAN.rate, initFee: a.hpInitFee ?? HP_LOAN.initFee, annualFee: a.hpAnnualFee ?? HP_LOAN.annualFee });

export interface HpEstate {
  age: number; // 본인 기대수명(상속 시점)
  year: number;
  price: number; // 그때 예상 시세(명목)
  paid: number; // 받은 월지급금 합계(명목)
  balance: number; // 대출 잔액 = 월지급금 + 이자 + 보증료(명목)
  left: number; // 상속 시 남는 주택 가치 = 시세 − 잔액(0 미만이면 0: 모자라는 돈은 상속인이 갚지 않음)
  leftReal: number; // 현재가치
}

/**
 * 주택연금 상속 잔액: 가입 때 초기보증료로 시작해 해마다 월지급금(연중 평균 반년치 이자)을 더하고
 * 잔액에 금리 + 연보증료를 붙여 본인 기대수명 해까지 쌓음(금리·보증료는 자산 입력값, 없으면 HP_LOAN). 순자산·부채 계산에는 넣지 않는 참고 값.
 */
export function hpEstate(a: Asset, profile: Profile, currentAge: number): HpEstate {
  const h = housePension(a, profile, currentAge);
  const age = Math.max(h.startAge, profile.lifeExpectancy);
  const loan = hpLoanOf(a);
  const r = (loan.rate + loan.annualFee) / 100;
  let balance = (h.price * loan.initFee) / 100;
  let paid = 0;
  for (let x = h.startAge; x <= age; x++) {
    const pay = h.nominal * 12;
    balance = balance * (1 + r) + pay * (1 + r / 2);
    paid += pay;
  }
  const n = age - currentAge;
  const price = a.amount * Math.pow(1 + a.expectedReturn / 100, n);
  const left = Math.max(0, price - balance);
  return { age, year: profile.birthYear + age, price, paid, balance, left, leftReal: left / Math.pow(1 + profile.inflation / 100, n) };
}
