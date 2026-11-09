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

/** 매각 예정인지(매각 연도가 올해 이후) */
export const willSell = (a: Asset, nowYear: number) => isRealEstate(a) && (a.lockYear ?? 0) > nowYear;

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
