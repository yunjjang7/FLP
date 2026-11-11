import type { Goal, Insurance, InsuredWho, Level, Profile } from '../types';
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
 * - 본인: 사망 = 유족 생활비 × 부양기간 + 부채 + 교육비 − 유동자산, 진단비 = 본인 연소득 × N배, 간병 = 기준액
 * - 배우자: 사망 = 배우자 연소득 × 부양기간(소득 공백), 진단비 = 배우자 연소득 × N배(최소 3,000만), 간병 = 기준액
 * - 자녀: 진단비 3,000만만 필요로 보고, 사망·간병은 가입한 경우에만 보여 줌
 */
export function insuranceGap(profile: Profile, s: Summary, policies: Insurance[], goals: Goal[]): InsuranceGap {
  const c = profile.criteria;
  const hasSpouse = profile.spouseBirthYear > 0;
  const spouseIncome = hasSpouse ? Math.max(0, profile.spouseIncome ?? 0) : 0;
  const selfIncome = Math.max(0, s.income - spouseIncome); // 가구 소득 중 본인 몫
  const eduNeed = goals.filter((g) => g.category === 'education').reduce((a, g) => a + g.amountPV, 0);
  const survivorLiving = s.expense * (c.survivorRatio / 100) * 12 * profile.dependentYears;
  const selfNeed = {
    death: Math.max(0, survivorLiving + s.totalDebt + eduNeed - s.liquidAssets),
    critical: selfIncome > 0 ? selfIncome * 12 * c.criticalMultiple : CRITICAL_BASE,
    care: c.careNeed,
  };
  const spouseNeed = {
    death: spouseIncome * 12 * profile.dependentYears,
    critical: Math.max(CRITICAL_BASE, spouseIncome * 12 * c.criticalMultiple),
    care: c.careNeed,
  };
  const childNeed = { death: 0, critical: CRITICAL_BASE, care: 0 };

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
        return { key, label: LABEL[key], need: need[key], current, gap: need[key] - current, ratio, level: lvl(ratio), person };
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
