import type { AcctKind, Asset, AssetType, Profile } from '../types';

/** 연금 밖 투자 계좌 구분(주식·펀드·ETF): ISA 는 운용 중 손익을 통산해 만기에 비과세 한도 뒤 9.9% 분리과세, 일반은 그때그때 과세 */
export const ACCT_KIND_LABEL: Record<AcctKind, string> = { isa: 'ISA', general: '일반' };
/** 계좌 구분을 넣을 수 있는 유형 */
export const ACCT_KIND_TYPES: AssetType[] = ['stock', 'fund', 'etf'];
export const canAcctKind = (a: Pick<Asset, 'type'>) => ACCT_KIND_TYPES.includes(a.type);
/** ISA 로 고른 줄(유형이 주식·펀드·ETF일 때만) */
export const isIsa = (a: Pick<Asset, 'type' | 'acctKind'>) => canAcctKind(a) && a.acctKind === 'isa';

/** ISA 만기 자금을 연금계좌로 옮기면 옮긴 금액의 10%(최대 300만)를 그 해 연금계좌 세액공제 대상에 더함 */
export const ISA_TRANSFER_RATE = 0.1;
export const ISA_TRANSFER_CAP = 300;
/** 연금계좌 세액공제율 범위(%): 종합소득금액 4,500만 초과 13.2 · 이하 16.5 */
const RATE_LOW = 13.2;
const RATE_HIGH = 16.5;

/** ISA 만기 금액 amount(만원)를 연금계좌로 옮길 때 늘어나는 세액공제 대상 금액 */
export const isaTransferBase = (amount: number) => Math.min(Math.max(0, amount) * ISA_TRANSFER_RATE, ISA_TRANSFER_CAP);

/** ISA 만기 비과세 한도(만원): 일반형 200 · 서민형·농어민형 400. 넘는 수익은 9.9%(지방소득세 포함) 분리과세 */
export const ISA_TAXFREE = { general: 200, low: 400 } as const;
export const ISA_SEP_TAX = 9.9;
export const ISA_TYPE_LABEL = { '': '일반형', low: '서민형·농어민' } as const;
export const isaLimitOf = (a: Pick<Asset, 'isaType'>) => (a.isaType === 'low' ? ISA_TAXFREE.low : ISA_TAXFREE.general);

export interface IsaTax {
  paid: number; // 납입 원금
  value: number; // 만기 평가액 추정(명목): 지금 평가액을 기대수익률로 만기 연도까지 불림
  gain: number; // 만기 수익(평가액 − 원금, 손실이면 음수)
  limit: number; // 비과세 한도
  taxable: number; // 한도를 넘는 수익
  tax: number; // 9.9% 분리과세
}

/**
 * ISA 만기 세금 추정: 원금은 그대로(앞으로 더 넣지 않음), 평가액은 기대수익률로 만기 연도까지 불린 값.
 * 손익은 계좌 안에서 통산하므로 만기 평가액 − 원금을 수익으로 봄. 원금을 안 넣었으면 undefined
 */
export function isaTax(a: Pick<Asset, 'amount' | 'expectedReturn' | 'isaPaid' | 'isaType' | 'isaEndYear'>, nowYear?: number): IsaTax | undefined {
  const paid = a.isaPaid ?? 0;
  if (!(paid > 0)) return undefined;
  const years = nowYear !== undefined && a.isaEndYear ? Math.max(0, a.isaEndYear - nowYear) : 0;
  const value = Math.max(0, a.amount) * Math.pow(1 + (a.expectedReturn ?? 0) / 100, years);
  const gain = value - paid;
  const limit = isaLimitOf(a);
  const taxable = Math.max(0, gain - limit);
  return { paid, value, gain, limit, taxable, tax: (taxable * ISA_SEP_TAX) / 100 };
}

export interface IsaMaturity {
  name: string;
  amount: number; // 지금 평가액(만원)
  endYear: number; // 만기 연도
  base: number; // 연금계좌로 옮기면 늘어나는 세액공제 대상 금액
  creditLow: number; // 예상 환급(공제율 13.2% 또는 직접 넣은 공제율)
  creditHigh: number; // 예상 환급(공제율 16.5% 또는 직접 넣은 공제율)
  /** 납입 원금을 넣었으면 만기 세금 추정 */
  tax?: IsaTax;
}

/**
 * 만기 연도를 넣은 ISA(평가액 > 0)의 연금계좌 이전 효과. 공제율은 추가 납입 설정에 본인 공제율을 직접 넣었으면 그 값, 아니면 13.2~16.5% 범위.
 * 만기 연도가 지난 ISA 도 돌려줌(endYear < nowYear: 연장했으면 새 만기로 고치라는 안내용).
 * nowYear 를 주면 만기 세금 추정에서 평가액을 만기까지 불림(없으면 지금 평가액 그대로).
 */
export function isaMaturities(assets: Asset[], profile: Pick<Profile, 'contrib'>, nowYear?: number): IsaMaturity[] {
  const fixed = profile.contrib?.selfRate ?? 0;
  return assets
    .filter((a) => isIsa(a) && a.amount > 0 && (a.isaEndYear ?? 0) > 0)
    .map((a) => {
      const base = isaTransferBase(a.amount);
      const tax = isaTax(a, nowYear);
      return {
        name: a.name || 'ISA',
        amount: a.amount,
        endYear: a.isaEndYear!,
        base,
        creditLow: (base * (fixed > 0 ? fixed : RATE_LOW)) / 100,
        creditHigh: (base * (fixed > 0 ? fixed : RATE_HIGH)) / 100,
        ...(tax ? { tax } : {}),
      };
    })
    .sort((x, y) => x.endYear - y.endYear);
}

/** 주식·펀드·ETF 평가액을 계좌 구분별로(ISA · 일반 · 구분 안 함). 금액이 0인 칸은 뺌 */
export function acctAmounts(assets: Asset[]): { key: AcctKind | 'none'; label: string; value: number }[] {
  const rows = assets.filter(canAcctKind);
  const sum = (f: (a: Asset) => boolean) => rows.filter(f).reduce((s, a) => s + a.amount, 0);
  return [
    { key: 'isa' as const, label: ACCT_KIND_LABEL.isa, value: sum((a) => a.acctKind === 'isa') },
    { key: 'general' as const, label: ACCT_KIND_LABEL.general, value: sum((a) => a.acctKind === 'general') },
    { key: 'none' as const, label: '구분 안 함', value: sum((a) => !a.acctKind) },
  ].filter((g) => g.value > 0.005);
}
