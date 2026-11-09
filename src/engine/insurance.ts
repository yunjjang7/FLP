import type { Goal, Insurance, Level, Profile } from '../types';
import type { Summary } from './portfolio';

export interface CoverageLine {
  key: 'death' | 'critical' | 'care';
  label: string;
  need: number;
  current: number;
  gap: number; // 양수 = 부족, 음수 = 초과
  ratio: number; // current/need %
  level: Level;
}

export interface InsuranceGap {
  lines: CoverageLine[];
  premium: number;
  premiumRatio: number; // 보험료 / 소득 %
  premiumLevel: Level;
  notes: string[];
}

const lvl = (ratio: number): Level => (ratio >= 100 ? 'good' : ratio >= 70 ? 'caution' : 'danger');

export function insuranceGap(profile: Profile, s: Summary, policies: Insurance[], goals: Goal[]): InsuranceGap {
  const c = profile.criteria;
  const eduNeed = goals.filter((g) => g.category === 'education').reduce((a, g) => a + g.amountPV, 0);
  // 필요 사망보장 = 유족 생활비 × 부양기간 + 부채 + 교육비 − 유동 금융자산
  const survivorLiving = s.expense * (c.survivorRatio / 100) * 12 * profile.dependentYears;
  const deathNeed = Math.max(0, survivorLiving + s.totalDebt + eduNeed - s.liquidAssets);
  const criticalNeed = s.income * 12 * c.criticalMultiple;
  const careNeed = c.careNeed;

  const total = (k: 'death' | 'critical' | 'care') => policies.reduce((a, p) => a + (p[k] || 0), 0);
  const make = (key: CoverageLine['key'], label: string, need: number): CoverageLine => {
    const current = total(key);
    const ratio = need > 0 ? (current / need) * 100 : 100;
    return { key, label, need, current, gap: need - current, ratio, level: lvl(ratio) };
  };
  const lines = [make('death', '사망보장', deathNeed), make('critical', '암·중대질병 진단비', criticalNeed), make('care', '간병·장기요양', careNeed)];

  const premium = policies.reduce((a, p) => a + p.monthlyPremium, 0);
  const premiumRatio = s.income > 0 ? (premium / s.income) * 100 : 0;
  const premiumLevel: Level = premiumRatio <= 10 ? 'good' : premiumRatio <= 15 ? 'caution' : 'danger';

  const notes: string[] = [];
  for (const l of lines) {
    const holders = policies.filter((p) => (p[l.key] || 0) > 0).length;
    if (l.need > 0 && l.ratio >= 150 && holders >= 2)
      notes.push(`${l.label}이(가) 필요액의 ${Math.round(l.ratio)}%로 ${holders}개 보험에 중복됩니다. 보험료 절감을 검토하세요.`);
  }
  if (premiumLevel !== 'good') notes.push(`월 보험료가 소득의 ${premiumRatio.toFixed(1)}%입니다. 일반적 권장선(10%)을 넘습니다.`);
  return { lines, premium, premiumRatio, premiumLevel, notes };
}
