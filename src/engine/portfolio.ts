import type { Asset, AssetType, Cashflow, Liability, Nature, Profile, Purpose, RiskProfile } from '../types';

export const ASSET_TYPES: Record<AssetType, { label: string; ret: number; vol: number; purpose: Purpose; nature: Nature; liquid: boolean }> = {
  cash: { label: '현금·입출금', ret: 1.5, vol: 0, purpose: 'short', nature: 'safe', liquid: true },
  deposit: { label: '예금', ret: 3, vol: 0.5, purpose: 'short', nature: 'safe', liquid: true },
  savings: { label: '적금', ret: 3.2, vol: 0.5, purpose: 'mid', nature: 'safe', liquid: true },
  bond: { label: '채권', ret: 4, vol: 5, purpose: 'mid', nature: 'safe', liquid: true },
  fund: { label: '펀드', ret: 6, vol: 14, purpose: 'long', nature: 'invest', liquid: true },
  etf: { label: 'ETF', ret: 7, vol: 16, purpose: 'long', nature: 'invest', liquid: true },
  stock: { label: '주식', ret: 8, vol: 22, purpose: 'long', nature: 'invest', liquid: true },
  pension: { label: '연금', ret: 5, vol: 10, purpose: 'long', nature: 'invest', liquid: false },
  realestate: { label: '부동산', ret: 3, vol: 8, purpose: 'long', nature: 'invest', liquid: false },
  other: { label: '기타', ret: 3, vol: 5, purpose: 'mid', nature: 'safe', liquid: false },
};

export const PURPOSE_LABEL: Record<Purpose, string> = {
  short: '단기·비상금',
  mid: '중기·목적자금',
  long: '장기·노후',
};
export const NATURE_LABEL: Record<Nature, string> = { safe: '안전형', invest: '투자형' };

export const RISK_PROFILES: Record<RiskProfile, { label: string; investShare: number }> = {
  conservative: { label: '안정형', investShare: 20 },
  moderate: { label: '안정추구형', investShare: 35 },
  balanced: { label: '위험중립형', investShare: 50 },
  growth: { label: '적극투자형', investShare: 65 },
  aggressive: { label: '공격투자형', investShare: 80 },
};

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export const isFinancial = (a: Asset) => a.type !== 'realestate';

export interface Summary {
  totalAssets: number;
  financialAssets: number;
  realEstate: number;
  totalDebt: number;
  netWorth: number;
  income: number;
  fixed: number;
  variable: number;
  debtPayment: number;
  expense: number; // 월 총지출(고정+변동+대출상환)
  savings: number; // 월 저축여력
  savingsRate: number; // %
  byType: { key: AssetType; label: string; value: number }[];
  byPurpose: { key: Purpose; label: string; value: number }[];
  byNature: { key: Nature; label: string; value: number }[];
  portfolioReturn: number; // 금융자산 가중 기대수익률 %
  portfolioVol: number; // 금융자산 가중 변동성 % (단순 가중, 보수적)
  investShare: number; // 금융자산 중 투자형 비중 %
  liquidAssets: number;
  emergencyFund: number; // 단기 용도 + 유동성 자산
  age: number;
}

export function summarize(profile: Profile, assets: Asset[], liabilities: Liability[], cashflows: Cashflow[], year = new Date().getFullYear()): Summary {
  const totalAssets = sum(assets.map((a) => a.amount));
  const fin = assets.filter(isFinancial);
  const financialAssets = sum(fin.map((a) => a.amount));
  const realEstate = totalAssets - financialAssets;
  const totalDebt = sum(liabilities.map((l) => l.balance));
  const fixed = sum(cashflows.filter((c) => c.kind === 'fixed').map((c) => c.monthly));
  const variable = sum(cashflows.filter((c) => c.kind === 'variable').map((c) => c.monthly));
  const debtPayment = sum(liabilities.map((l) => l.monthlyPayment));
  const expense = fixed + variable + debtPayment;
  const income = profile.monthlyIncome;
  const savings = income - expense;

  const group = <K extends string>(keyOf: (a: Asset) => K, labels: Record<K, string>, list = assets) =>
    (Object.keys(labels) as K[])
      .map((k) => ({ key: k, label: labels[k], value: sum(list.filter((a) => keyOf(a) === k).map((a) => a.amount)) }))
      .filter((g) => g.value > 0);

  const typeLabels = Object.fromEntries(Object.entries(ASSET_TYPES).map(([k, v]) => [k, v.label])) as Record<AssetType, string>;

  const w = (f: (a: Asset) => number) => (financialAssets > 0 ? sum(fin.map((a) => (a.amount / financialAssets) * f(a))) : 0);
  const investAmt = sum(fin.filter((a) => a.nature === 'invest').map((a) => a.amount));
  const liquidAssets = sum(assets.filter((a) => ASSET_TYPES[a.type].liquid).map((a) => a.amount));
  const emergencyFund = sum(assets.filter((a) => a.purpose === 'short' && ASSET_TYPES[a.type].liquid).map((a) => a.amount));

  return {
    totalAssets,
    financialAssets,
    realEstate,
    totalDebt,
    netWorth: totalAssets - totalDebt,
    income,
    fixed,
    variable,
    debtPayment,
    expense,
    savings,
    savingsRate: income > 0 ? (savings / income) * 100 : 0,
    byType: group((a) => a.type, typeLabels),
    byPurpose: group((a) => a.purpose, PURPOSE_LABEL),
    byNature: group((a) => a.nature, NATURE_LABEL, fin),
    portfolioReturn: financialAssets > 0 ? w((a) => a.expectedReturn) : 3,
    portfolioVol: financialAssets > 0 ? w((a) => a.volatility) : 5,
    investShare: financialAssets > 0 ? (investAmt / financialAssets) * 100 : 0,
    liquidAssets,
    emergencyFund,
    age: year - profile.birthYear,
  };
}
