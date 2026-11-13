import type { Asset, AssetType, Cashflow, Insurance, Liability, Nature, Profile, Purpose, ReUse, RiskProfile } from '../types';
import { depositOf, RE_USE, reUseOf } from './realestate';

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

/** 같은 계좌로 묶인 연금계좌 줄의 계좌 이름(묶이지 않았으면 '') */
export const groupOf = (a: Asset) => (a.type === 'pension' ? a.group?.trim() || '' : '');

/** 연금계좌 줄이 속한 계좌 이름: 같은 계좌로 묶인 줄(group)은 그 이름, 아니면 자기 이름 */
export const accountName = (a: Asset) => groupOf(a) || a.name;

/**
 * 같은 계좌(group)로 묶인 연금계좌 줄을 계좌 하나로 합침(연금 세금·수령한도·인출 순서·이정표는 계좌 단위).
 * 합친 줄은 처음 나온 줄 자리에 두고, 이름 = 계좌 이름, 금액·과세제외·퇴직금 재원 = 합계,
 * 기대수익률·변동성 = 금액가중 평균, 성격 = 금액이 많은 쪽, 꺼내는 순서·비교 순서 = 줄 가운데 0보다 큰 가장 작은 값.
 * 명의·연금수령 1년차·인출 시작 연도 등 나머지 계좌 속성은 처음 줄 값. 묶이지 않은 줄은 그대로.
 */
export function mergeAccounts(assets: Asset[]): Asset[] {
  const groups = new Map<string, Asset[]>();
  for (const a of assets) {
    const g = groupOf(a);
    if (g) groups.set(g, [...(groups.get(g) ?? []), a]);
  }
  const out: Asset[] = [];
  for (const a of assets) {
    const g = groupOf(a);
    if (!g) {
      out.push(a);
      continue;
    }
    const rows = groups.get(g)!;
    if (rows[0] !== a) continue;
    if (rows.length === 1) {
      out.push({ ...a, name: g });
      continue;
    }
    const amount = sum(rows.map((r) => r.amount));
    const avg = (f: (r: Asset) => number) => (amount > 0 ? sum(rows.map((r) => r.amount * (f(r) || 0))) / amount : f(a));
    const invest = sum(rows.filter((r) => r.nature === 'invest').map((r) => r.amount));
    const minPos = (key: 'drawOrder' | 'compareOrder') => {
      const v = rows.map((r) => r[key] ?? 0).filter((n) => n > 0);
      return v.length ? { [key]: Math.min(...v) } : {};
    };
    const fund = (key: 'taxFree' | 'retirePart') => (rows.some((r) => r[key] !== undefined) ? { [key]: sum(rows.map((r) => r[key] ?? 0)) } : {});
    out.push({
      ...a,
      name: g,
      amount,
      expectedReturn: avg((r) => r.expectedReturn),
      volatility: avg((r) => r.volatility),
      nature: invest * 2 > amount ? 'invest' : invest * 2 < amount ? 'safe' : a.nature,
      ...fund('taxFree'),
      ...fund('retirePart'),
      ...minPos('drawOrder'),
      ...minPos('compareOrder'),
    });
  }
  return out;
}

/**
 * 기대수익률(%)에 맞는 변동성 권장 범위(%). 무위험 3%를 넘는 초과수익 ÷ 샤프비율 0.4~0.2로 잡음
 * (예: 채권 4% → 2.5~5, 주식·채권 반반 6% → 7.5~15, 주식 8% → 12.5~25). 0.5% 단위.
 */
export function volRange(ret: number) {
  const excess = Math.max(0, ret - 3);
  const half = (v: number) => Math.round(v * 2) / 2;
  return { min: half(excess / 0.4), max: Math.max(3, half(excess / 0.2)) };
}

/** 권장 범위 가운데 값(0.5% 단위): ‘권장값으로 맞추기’ 버튼에 씀 */
export function volMid(ret: number) {
  const r = volRange(ret);
  return Math.round(r.min + r.max) / 2;
}

/** 변동성이 수익률에 비해 낮음(결과 낙관적) · 높음(보수적) · 적정 */
export function volCheck(ret: number, vol: number): 'low' | 'high' | 'ok' {
  const r = volRange(ret);
  return vol < r.min ? 'low' : vol > r.max ? 'high' : 'ok';
}

/**
 * 프로필 ‘개인·퇴직연금 월액’과 겹칠 수 있는 자산 탭 연금 계좌. 월액이 0보다 클 때만:
 * 본인 칸 = 본인·공동·명의 없음 계좌, 배우자 칸 = 배우자·공동 명의 계좌.
 */
export function pensionOverlap(monthly: number, assets: Asset[], who: 'self' | 'spouse'): Asset[] {
  if (!(monthly > 0)) return [];
  return assets.filter((a) => a.type === 'pension' && a.amount > 0 && (who === 'self' ? a.owner !== 'spouse' : a.owner === 'spouse' || a.owner === 'joint'));
}

export interface Summary {
  totalAssets: number;
  financialAssets: number;
  realEstate: number;
  totalDebt: number; // 대출 + 임대보증금
  depositDebt: number; // 임대보증금(돌려줄 돈)
  netWorth: number;
  income: number;
  fixed: number;
  variable: number;
  debtPayment: number;
  /** 지출에 자동으로 더한 보험 탭 월 보험료(중복 의심이면 0) */
  insurance: number;
  /** 보험 탭 월 보험료 합계 */
  insuranceTotal: number;
  /** 보험료로 보이는 지출 항목 이름(있으면 보험 탭 보험료를 더하지 않음) */
  insuranceDup: string[];
  /** 지금 납입 중인 보험 건수 */
  insuranceCount: number;
  /** 앞으로 납입이 끝나는 보험: 그 나이부터 월 보험료만큼 지출이 줄어듦 */
  insuranceEnds: { name: string; age: number; monthly: number }[];
  /** 납입 종료 나이가 없는(0) 보험: 은퇴 후에도 기대수명까지 계속 냄 */
  insuranceOngoing: { name: string; monthly: number }[];
  expense: number; // 월 총지출(고정+변동+대출상환+보험료)
  savings: number; // 월 저축여력
  savingsRate: number; // %
  byType: { key: AssetType; label: string; value: number }[];
  byPurpose: { key: Purpose; label: string; value: number }[]; // 금융자산만
  byReUse: { key: ReUse; label: string; value: number }[]; // 부동산 용도별
  byNature: { key: Nature; label: string; value: number }[];
  portfolioReturn: number; // 금융자산 가중 기대수익률 %
  portfolioVol: number; // 금융자산 가중 변동성 % (단순 가중, 보수적)
  investShare: number; // 금융자산 중 투자형 비중 %
  liquidAssets: number;
  emergencyFund: number; // 단기 용도 + 유동성 자산
  age: number;
  /** 올해 남은 기간(이번 달 포함, 1 = 1년 전체). 없으면 1: 노후 계산의 첫해를 남은 달만큼만 셈 */
  yearShare?: number;
}

/** 지출 항목 중 보험료로 보이는 것(이름·분류에 '보험') */
export const isInsuranceCashflow = (c: Cashflow) => /보험/.test(`${c.name} ${c.category}`);

/** 피보험자 출생연도: 배우자는 프로필의 배우자 출생연도, 자녀는 보험에 넣은 출생연도. 모르면 본인 */
export function insuredBirthYear(p: Insurance, profile: Profile) {
  if (p.insured === 'spouse' && profile.spouseBirthYear > 0) return profile.spouseBirthYear;
  if (p.insured === 'child' && (p.insuredBirthYear ?? 0) > 0) return p.insuredBirthYear!;
  return profile.birthYear;
}

/** 납입 종료 나이(피보험자 나이)를 본인 나이로 바꿈. 0이면 계속 납입 */
export function payEndSelfAge(p: Insurance, profile: Profile) {
  const end = p.payEndAge ?? 0;
  return end > 0 ? end + insuredBirthYear(p, profile) - profile.birthYear : 0;
}

/** 본인 나이 age에 아직 보험료를 내는지(납입 종료 나이가 0이거나 아직 그 나이 전이면 납입 중) */
export const isPaying = (p: Insurance, age: number, profile: Profile) => {
  const end = payEndSelfAge(p, profile);
  return !(end > 0 && age >= end);
};

export function summarize(profile: Profile, assets: Asset[], liabilities: Liability[], cashflows: Cashflow[], year = new Date().getFullYear(), policies: Insurance[] = [], month?: number): Summary {
  const totalAssets = sum(assets.map((a) => a.amount));
  const fin = assets.filter(isFinancial);
  const financialAssets = sum(fin.map((a) => a.amount));
  const realEstate = totalAssets - financialAssets;
  const depositDebt = sum(assets.map(depositOf));
  const totalDebt = sum(liabilities.map((l) => l.balance)) + depositDebt;
  const fixed = sum(cashflows.filter((c) => c.kind === 'fixed').map((c) => c.monthly));
  const variable = sum(cashflows.filter((c) => c.kind === 'variable').map((c) => c.monthly));
  const debtPayment = sum(liabilities.map((l) => l.monthlyPayment));
  // 보험 탭 보험료는 자동으로 지출에 더함. 지출에 보험료 항목이 이미 있으면 두 번 빠지지 않게 더하지 않음
  // 납입이 끝난 보험은 빼고, 앞으로 끝나는 보험은 그 나이부터 저축이 늘도록 따로 모음
  const age = year - profile.birthYear;
  const paying = policies.filter((p) => isPaying(p, age, profile) && p.monthlyPremium > 0);
  const insuranceTotal = sum(paying.map((p) => p.monthlyPremium));
  const insuranceEnds = paying.filter((p) => payEndSelfAge(p, profile) > age).map((p) => ({ name: p.name, age: payEndSelfAge(p, profile), monthly: p.monthlyPremium }));
  const insuranceOngoing = paying.filter((p) => !(payEndSelfAge(p, profile) > 0)).map((p) => ({ name: p.name, monthly: p.monthlyPremium }));
  const insuranceDup = cashflows.filter(isInsuranceCashflow).map((c) => c.name);
  const insurance = insuranceDup.length ? 0 : insuranceTotal;
  const expense = fixed + variable + debtPayment + insurance;
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
  const emergencyFund = sum(fin.filter((a) => a.purpose === 'short' && ASSET_TYPES[a.type].liquid).map((a) => a.amount));

  return {
    totalAssets,
    financialAssets,
    realEstate,
    totalDebt,
    depositDebt,
    netWorth: totalAssets - totalDebt,
    income,
    fixed,
    variable,
    debtPayment,
    insurance,
    insuranceTotal,
    insuranceDup,
    insuranceCount: paying.length,
    insuranceEnds,
    insuranceOngoing,
    expense,
    savings,
    savingsRate: income > 0 ? (savings / income) * 100 : 0,
    byType: group((a) => a.type, typeLabels),
    byPurpose: group((a) => a.purpose, PURPOSE_LABEL, fin),
    byReUse: group(reUseOf, Object.fromEntries(Object.entries(RE_USE).map(([k, v]) => [k, `부동산·${v}`])) as Record<ReUse, string>, assets.filter((a) => !isFinancial(a))),
    byNature: group((a) => a.nature, NATURE_LABEL, fin),
    portfolioReturn: financialAssets > 0 ? w((a) => a.expectedReturn) : 3,
    portfolioVol: financialAssets > 0 ? w((a) => a.volatility) : 5,
    investShare: financialAssets > 0 ? (investAmt / financialAssets) * 100 : 0,
    liquidAssets,
    emergencyFund,
    age,
    ...(month !== undefined && month >= 1 && month <= 12 ? { yearShare: (13 - Math.round(month)) / 12 } : {}),
  };
}
