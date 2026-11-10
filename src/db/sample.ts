import type { Asset, Cashflow, Criteria, Goal, Insurance, Liability, Profile } from '../types';

export const DEFAULT_CRITERIA: Criteria = {
  emergencyMonths: 6,
  savingsRate: 30,
  debtRatioMax: 40,
  successTarget: 80,
  withdrawRateMax: 6,
  criticalMultiple: 2,
  careNeed: 5000,
  survivorRatio: 70,
};

export function defaultProfile(year = new Date().getFullYear()): Profile {
  return {
    id: 'me',
    name: '',
    birthYear: year - 40,
    retireAge: 60,
    lifeExpectancy: 100,
    monthlyIncome: 0,
    inflation: 2.5,
    riskProfile: 'balanced',
    retireMonthlyExpense: 300,
    dependentYears: 15,
    nationalPension: 0,
    nationalPensionAge: 65,
    privatePension: 0,
    privatePensionAge: 60,
    spouseBirthYear: 0,
    spousePension: 0,
    spousePensionAge: 65,
    spouseIncome: 0,
    spouseRetireAge: 60,
    spousePrivatePension: 0,
    spousePrivatePensionAge: 60,
    incomes: [],
    retireSeparate: false,
    retireReturn: 4,
    retireVolatility: 7,
    criteria: { ...DEFAULT_CRITERIA },
  };
}

export function sampleData(year = new Date().getFullYear()) {
  const profile: Profile = {
    ...defaultProfile(year),
    name: '홍길동',
    birthYear: year - 45,
    retireAge: 60,
    monthlyIncome: 650,
    riskProfile: 'balanced',
    retireMonthlyExpense: 350,
    dependentYears: 12,
    nationalPension: 120,
    nationalPensionAge: 65,
    privatePension: 60,
    privatePensionAge: 60,
    retireSeparate: true,
    retireReturn: 4.5,
    retireVolatility: 8,
    spouseBirthYear: year - 43,
    spousePension: 50,
    spousePensionAge: 65,
    incomes: [{ name: '오피스텔 월세', monthly: 60, startAge: 60, endAge: 80, growth: 5, step: 2 }],
  };
  const assets: Asset[] = [
    { name: '입출금 통장', type: 'cash', amount: 800, expectedReturn: 1.5, volatility: 0, purpose: 'short', nature: 'safe' },
    { name: '정기예금', type: 'deposit', amount: 2500, expectedReturn: 3, volatility: 0.5, purpose: 'short', nature: 'safe' },
    { name: '자녀 교육 적금', type: 'savings', amount: 3000, expectedReturn: 3.2, volatility: 0.5, purpose: 'mid', nature: 'safe' },
    { name: '국내 주식', type: 'stock', amount: 4500, expectedReturn: 8, volatility: 22, purpose: 'long', nature: 'invest' },
    { name: '해외 지수 ETF', type: 'etf', amount: 6000, expectedReturn: 7, volatility: 16, purpose: 'long', nature: 'invest' },
    { name: '채권형 펀드', type: 'bond', amount: 2000, expectedReturn: 4, volatility: 5, purpose: 'mid', nature: 'safe' },
    { name: '퇴직연금(DC)', type: 'pension', amount: 12000, expectedReturn: 5, volatility: 10, purpose: 'long', nature: 'invest' },
    { name: '연금저축', type: 'pension', amount: 3500, expectedReturn: 5.5, volatility: 12, purpose: 'long', nature: 'invest' },
    { name: '거주 아파트', type: 'realestate', amount: 75000, expectedReturn: 3, volatility: 8, purpose: 'long', nature: 'invest', reUse: 'home', owner: 'joint', ownerShare: 50 },
  ];
  const liabilities: Liability[] = [
    { name: '주택담보대출', balance: 28000, rate: 4.2, monthlyPayment: 150 },
    { name: '신용대출', balance: 2000, rate: 6.5, monthlyPayment: 40 },
  ];
  const cashflows: Cashflow[] = [
    { name: '관리비·공과금', kind: 'fixed', category: '주거', monthly: 35 },
    { name: '통신·구독료', kind: 'fixed', category: '구독료', monthly: 15 },
    { name: '자녀 학원비', kind: 'fixed', category: '교육', monthly: 80 },
    { name: '식비·생활비', kind: 'variable', category: '생활비', monthly: 130 },
    { name: '교통·차량', kind: 'variable', category: '교통', monthly: 30 },
    { name: '여가·기타', kind: 'variable', category: '기타', monthly: 25 },
  ];
  const goals: Goal[] = [
    { name: '첫째 대학 등록금', category: 'education', targetAge: 49, amountPV: 4000, growthRate: 4 },
    { name: '둘째 대학 등록금', category: 'education', targetAge: 52, amountPV: 4000, growthRate: 4 },
    { name: '차량 교체', category: 'car', targetAge: 50, amountPV: 4000, growthRate: 2.5 },
    { name: '자녀 결혼 지원', category: 'other', targetAge: 58, amountPV: 5000, growthRate: 2.5 },
    { name: '은퇴 후 여행', category: 'travel', targetAge: 61, amountPV: 500, growthRate: 2.5, endAge: 75 },
  ];
  const insurance: Insurance[] = [
    { name: '종신보험', death: 10000, critical: 0, care: 0, monthlyPremium: 22 },
    { name: '실손·건강보험', death: 0, critical: 3000, care: 1000, monthlyPremium: 15 },
    { name: '암보험', death: 0, critical: 2000, care: 0, monthlyPremium: 8 },
  ];
  return { profile, assets, liabilities, cashflows, goals, insurance };
}
