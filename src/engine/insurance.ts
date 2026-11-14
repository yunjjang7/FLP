import type { Goal, Insurance, InsuredWho, Level, Profile } from '../types';
import { won } from '../lib/format';
import { isPaying, type Summary } from './portfolio';

export interface CoverageLine {
  key: 'death' | 'critical' | 'care';
  label: string;
  need: number;
  current: number;
  gap: number; // 양수 = 부족, 음수 = 초과
  ratio: number; // current/need %
  level: Level;
  /** 피보험자 이름(본인·배우자·자녀(2015년생)) */
  person: string;
  /** 필요액 계산 근거(예: '연소득 4,800만원 × 2배', '은퇴 후라 소득 대신 치료비 기준액 3,000만원') */
  basis?: string;
}

/** 피보험자 한 사람의 보장 진단 */
export interface PersonCoverage {
  who: InsuredWho;
  person: string;
  count: number; // 그 사람 보험 건수
  premium: number; // 그 사람 월 보험료 합계
  lines: CoverageLine[];
}

export interface InsuranceGap {
  /** 모든 사람의 보장 줄(본인 먼저). 점수·처방에 씀 */
  lines: CoverageLine[];
  people: PersonCoverage[];
  premium: number;
  premiumRatio: number; // 보험료 / 소득 %
  premiumLevel: Level;
  notes: string[];
}

/** 소득이 없는 사람(자녀·전업 배우자)의 진단비 기준: 치료비·생활 공백용 최소 금액(만원) */
export const CRITICAL_BASE = 3000;

const lvl = (ratio: number): Level => (ratio >= 100 ? 'good' : ratio >= 70 ? 'caution' : 'danger');
const LABEL = { death: '사망보장', critical: '암·중대질병 진단비', care: '간병·장기요양' } as const;

/**
 * 피보험자별 보장 부족.
 * - 본인: 사망 = 유족 생활비 × 부양기간 + 부채 + 교육비 − 유동자산(이미 은퇴했으면 유족 생활비는 빼고 계산), 진단비 = 본인 연소득 × N배, 간병 = 기준액
 * - 배우자: 사망 = 배우자 연소득 × 부양기간(소득 공백), 진단비 = 배우자 연소득 × N배(최소 3,000만), 간병 = 기준액
 * - 자녀: 진단비 3,000만만 필요로 보고, 사망·간병은 가입한 경우에만 보여 줌
 * - 진단비는 치료 기간의 소득 공백을 메우는 돈이라, 이미 은퇴했으면(본인 은퇴 나이·배우자 은퇴 나이 기준)
 *   연금·월세 소득 × N배 대신 치료비 기준액 3,000만원으로 봄
 * - 배우자 사망보장은 배우자 근로소득 공백을 메우는 돈이라, 배우자가 이미 은퇴했으면 0(근거와 함께 표시)
 */
export function insuranceGap(profile: Profile, s: Summary, policies: Insurance[], goals: Goal[]): InsuranceGap {
  const c = profile.criteria;
  const hasSpouse = profile.spouseBirthYear > 0;
  const spouseIncome = hasSpouse ? Math.max(0, profile.spouseIncome ?? 0) : 0;
  const selfIncome = Math.max(0, s.income - spouseIncome); // 가구 소득 중 본인 몫
  const eduNeed = goals.filter((g) => g.category === 'education').reduce((a, g) => a + g.amountPV, 0);
  const selfRetired = s.age >= profile.retireAge;
  // 은퇴 후 s.expense는 은퇴 생활비(retiredBasis)라 연금·월세를 빼지 않은 금액 × 부양기간은 과함.
  // 은퇴 뒤 가족 생활비는 노후 자산·연금으로 이미 계산하고 본인이 먼저 떠나는 경우는 배우자 사별 분석이 다루므로,
  // 은퇴했으면 유족 생활비는 빼고 남는 부채·교육비만 봄
  const survivorLiving = selfRetired ? 0 : s.expense * (c.survivorRatio / 100) * 12 * profile.dependentYears;
  const spouseRetired = hasSpouse && profile.spouseRetireAge > 0 && profile.birthYear + s.age - profile.spouseBirthYear >= profile.spouseRetireAge;
  const base = `기준액 ${won(CRITICAL_BASE)}`;
  // 진단비 필요액과 근거: 은퇴했으면 기준액, 아니면 연소득 × N배(소득이 없으면 기준액, 배우자는 최소 기준액)
  const critical = (monthly: number, retired: boolean, floor: boolean): [number, string] => {
    if (retired) return [CRITICAL_BASE, `은퇴 후라 소득 대신 치료비 ${base}`];
    if (!(monthly > 0)) return [CRITICAL_BASE, `근로소득이 없어 ${base}`];
    const v = monthly * 12 * c.criticalMultiple;
    const why = `연소득 ${won(monthly * 12)} × ${c.criticalMultiple}배`;
    return floor && v < CRITICAL_BASE ? [CRITICAL_BASE, `${why}가 ${base}보다 적어 ${base}`] : [v, why];
  };
  const [selfCrit, selfCritWhy] = critical(selfIncome, selfRetired, false);
  const [spouseCrit, spouseCritWhy] = critical(spouseIncome, spouseRetired, true);
  const selfNeed = {
    death: Math.max(0, survivorLiving + s.totalDebt + eduNeed - s.liquidAssets),
    critical: selfCrit,
    care: c.careNeed,
  };
  const spouseNeed = {
    // 배우자가 이미 은퇴했으면 사망 때 끊길 근로소득이 없어 필요액 0
    death: spouseRetired ? 0 : spouseIncome * 12 * profile.dependentYears,
    critical: spouseCrit,
    care: c.careNeed,
  };
  const childNeed = { death: 0, critical: CRITICAL_BASE, care: 0 };
  const careWhy = '설정의 간병 기준액';
  const why: Record<InsuredWho, Record<CoverageLine['key'], string>> = {
    self: { death: selfRetired ? '은퇴 후라 유족 생활비는 노후 자산·연금으로 계산(배우자 사별 분석 참고): 부채 + 교육비 − 유동자산' : '유족 생활비 × 부양기간 + 부채 + 교육비 − 유동자산', critical: selfCritWhy, care: careWhy },
    spouse: { death: spouseRetired ? '배우자가 은퇴해 사망 때 끊길 근로소득이 없어 0' : `배우자 연소득 ${won(spouseIncome * 12)} × 부양기간 ${profile.dependentYears}년`, critical: spouseCritWhy, care: careWhy },
    child: { death: '', critical: `자녀 ${base}`, care: '' },
  };

  // 보험료는 아직 납입 중인 보험만(납입이 끝난 보험은 보장만 남고 보험료는 나가지 않음)
  const paying = (p: Insurance) => isPaying(p, s.age, profile);
  // 사람별로 묶기: 자녀는 출생연도마다 따로(출생연도가 없으면 '자녀' 하나로)
  const groups: { who: InsuredWho; person: string; list: Insurance[] }[] = [{ who: 'self', person: '본인', list: [] }];
  if (hasSpouse) groups.push({ who: 'spouse', person: '배우자', list: [] });
  for (const p of policies) {
    const who: InsuredWho = p.insured === 'spouse' ? 'spouse' : p.insured === 'child' ? 'child' : 'self';
    const person = who === 'self' ? '본인' : who === 'spouse' ? '배우자' : (p.insuredBirthYear ?? 0) > 0 ? `자녀(${p.insuredBirthYear}년생)` : '자녀';
    let g = groups.find((x) => x.person === person);
    if (!g) groups.push((g = { who, person, list: [] }));
    g.list.push(p);
  }

  const people: PersonCoverage[] = groups.map(({ who, person, list }) => {
    const need = who === 'self' ? selfNeed : who === 'spouse' ? spouseNeed : childNeed;
    const lines = (['death', 'critical', 'care'] as const)
      .map((key): CoverageLine => {
        const current = list.reduce((a, p) => a + (p[key] || 0), 0);
        const ratio = need[key] > 0 ? (current / need[key]) * 100 : 100;
        return { key, label: LABEL[key], need: need[key], current, gap: need[key] - current, ratio, level: lvl(ratio), person, ...(why[who][key] ? { basis: why[who][key] } : {}) };
      })
      // 본인은 세 줄 모두, 나머지는 필요액이나 가입액이 있는 줄만
      .filter((l) => who === 'self' || l.need > 0 || l.current > 0);
    return { who, person, count: list.length, premium: list.filter(paying).reduce((a, p) => a + p.monthlyPremium, 0), lines };
  });

  const premium = policies.filter(paying).reduce((a, p) => a + p.monthlyPremium, 0);
  const premiumRatio = s.income > 0 ? (premium / s.income) * 100 : 0;
  const premiumLevel: Level = premiumRatio <= 10 ? 'good' : premiumRatio <= 15 ? 'caution' : 'danger';

  const notes: string[] = [];
  for (const g of people) {
    for (const l of g.lines) {
      const holders = groups.find((x) => x.person === g.person)!.list.filter((p) => (p[l.key] || 0) > 0).length;
      if (l.need > 0 && l.ratio >= 150 && holders >= 2)
        notes.push(`${g.person} ${l.label}이(가) 필요액의 ${Math.round(l.ratio)}%로 ${holders}개 보험에 중복됩니다. 보험료 절감을 검토하세요.`);
    }
  }
  if (premiumLevel !== 'good') notes.push(`월 보험료가 소득의 ${premiumRatio.toFixed(1)}%입니다. 일반적 권장선(10%)을 넘습니다.`);
  return { lines: people.flatMap((g) => g.lines), people, premium, premiumRatio, premiumLevel, notes };
}
