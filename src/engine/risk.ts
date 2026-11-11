import type { Asset, Level, Profile } from '../types';
import { scale } from './finance';
import type { InsuranceGap } from './insurance';
import { ASSET_TYPES, RISK_PROFILES, type Summary } from './portfolio';

export interface RiskCheck {
  key: string;
  label: string;
  value: string;
  level: Level;
  detail: string;
}

const level = (score: number): Level => (score >= 0.999 ? 'good' : score >= 0.5 ? 'caution' : 'danger');

export function emergencyMonths(s: Summary) {
  return s.expense > 0 ? s.emergencyFund / s.expense : s.emergencyFund > 0 ? 99 : 0;
}

export function concentration(assets: Asset[], s: Summary) {
  if (s.totalAssets <= 0) return { share: 0, name: '-' };
  const top = assets.reduce<Asset | null>((m, a) => (!m || a.amount > m.amount ? a : m), null);
  return { share: top ? (top.amount / s.totalAssets) * 100 : 0, name: top?.name ?? '-' };
}

/** 인출률 판정: 상한의 2/3 이하 양호, 상한 이하 주의, 초과 위험 */
export function withdrawLevel(rate: number, max: number): Level {
  return rate <= (max * 2) / 3 ? 'good' : rate <= max ? 'caution' : 'danger';
}

export function riskChecks(profile: Profile, assets: Asset[], s: Summary, withdraw?: { rate: number; age: number; retired: boolean }): RiskCheck[] {
  const c = profile.criteria;
  const em = emergencyMonths(s);
  const debtRatio = s.totalAssets > 0 ? (s.totalDebt / s.totalAssets) * 100 : s.totalDebt > 0 ? 100 : 0;
  const dsr = s.income > 0 ? (s.debtPayment / s.income) * 100 : 0;
  const conc = concentration(assets, s);
  const reShare = s.totalAssets > 0 ? (s.realEstate / s.totalAssets) * 100 : 0;
  const liquidShare = s.totalAssets > 0 ? (s.liquidAssets / s.totalAssets) * 100 : 0;
  const target = RISK_PROFILES[profile.riskProfile];
  const fitDiff = Math.abs(s.investShare - target.investShare);
  const typeCount = new Set(assets.filter((a) => a.type !== 'realestate').map((a) => a.type)).size;

  const items: (RiskCheck & { score: number })[] = [
    {
      key: 'emergency', label: '비상금', value: `${em.toFixed(1)}개월`,
      score: scale(em, c.emergencyMonths / 2, c.emergencyMonths), level: 'good',
      detail: `단기·비상금 용도 유동자산이 월 지출의 ${em.toFixed(1)}개월분입니다. 목표 ${c.emergencyMonths}개월.`,
    },
    {
      key: 'savings', label: '저축률', value: `${s.savingsRate.toFixed(1)}%`,
      score: scale(s.savingsRate, c.savingsRate / 2, c.savingsRate), level: 'good',
      detail: s.savings < 0 ? `매달 ${Math.round(-s.savings).toLocaleString()}만원이 모자라 금융자산에서 꺼내 씁니다. 목표 저축률 ${c.savingsRate}%.` : `월 저축여력 ${Math.round(s.savings).toLocaleString()}만원. 목표 저축률 ${c.savingsRate}%.`,
    },
    {
      key: 'debt', label: '부채비율', value: `${debtRatio.toFixed(1)}%`,
      score: scale(debtRatio, c.debtRatioMax * 1.5, c.debtRatioMax), level: 'good',
      detail: `총자산 대비 부채. 상한 ${c.debtRatioMax}% 기준.`,
    },
    {
      key: 'dsr', label: '원리금 상환 부담(DSR)', value: `${dsr.toFixed(1)}%`,
      score: scale(dsr, 60, 40), level: 'good',
      detail: '월소득 대비 대출 원리금 상환액. 40% 이하 권장.',
    },
    {
      key: 'concentration', label: '단일 자산 집중도', value: `${conc.share.toFixed(1)}%`,
      score: scale(conc.share, 70, 40), level: 'good',
      detail: `가장 큰 자산은 '${conc.name}'입니다. 단일 자산 40% 이하 권장.`,
    },
    {
      key: 'realestate', label: '부동산 편중', value: `${reShare.toFixed(1)}%`,
      score: scale(reShare, 85, 60), level: 'good',
      detail: '총자산 중 부동산 비중. 노후 현금흐름을 위해 60% 이하 권장.',
    },
    {
      key: 'liquidity', label: '유동성', value: `${liquidShare.toFixed(1)}%`,
      score: scale(liquidShare, 10, 20), level: 'good',
      detail: '바로 현금화 가능한 자산 비중. 20% 이상 권장.',
    },
    {
      key: 'fit', label: '위험성향 적합도', value: `투자형 ${s.investShare.toFixed(0)}%`,
      score: scale(fitDiff, 25, 10), level: 'good',
      detail: `${target.label} 기준 투자형 권장 비중 ${target.investShare}% (차이 ${fitDiff.toFixed(0)}%p).`,
    },
    {
      key: 'diversification', label: '금융자산 분산', value: `${typeCount}종`,
      score: scale(typeCount, 1, 4), level: 'good',
      detail: '금융자산 유형 수. 4종 이상 분산 권장.',
    },
  ];
  if (withdraw && Number.isFinite(withdraw.rate)) {
    const wl = withdrawLevel(withdraw.rate, c.withdrawRateMax);
    items.push({
      key: 'withdraw', label: withdraw.retired ? '인출률' : '은퇴 첫해 인출률(예상)', value: `${withdraw.rate.toFixed(1)}%`,
      score: wl === 'good' ? 1 : wl === 'caution' ? 0.6 : 0, level: 'good',
      detail: `${withdraw.age}세에 금융자산(${withdraw.retired ? '현재 금액' : '평균수익 가정 은퇴 시점 금액'})에서 꺼내는 금액(생활비 − 연금·소득 + 남은 대출 + 그해 지출)의 비율. 상한 ${c.withdrawRateMax}%, ${((c.withdrawRateMax * 2) / 3).toFixed(0)}% 이하 권장.`,
    });
  }
  // 이미 은퇴해 인출 중이면 저축률 대신 인출률로 판단
  return items.filter((x) => !(withdraw?.retired && x.key === 'savings')).map(({ score, ...r }) => ({ ...r, level: level(score) }));
}

export interface ScoreItem { label: string; weight: number; score: number }

/** 종합 재무점수(100점) */
export function financialScore(profile: Profile, assets: Asset[], s: Summary, successRate: number, ins: InsuranceGap, withdraw?: { rate: number; retired: boolean }) {
  const c = profile.criteria;
  const debtRatio = s.totalAssets > 0 ? (s.totalDebt / s.totalAssets) * 100 : 0;
  const fitDiff = Math.abs(s.investShare - RISK_PROFILES[profile.riskProfile].investShare);
  const conc = concentration(assets, s).share;
  const covRatio = ins.lines.reduce((a, l) => a + Math.min(1, l.need > 0 ? l.current / l.need : 1), 0) / ins.lines.length;
  const items: ScoreItem[] = [
    withdraw?.retired
      ? { label: '인출률', weight: 20, score: scale(withdraw.rate, c.withdrawRateMax * 1.5, (c.withdrawRateMax * 2) / 3) }
      : { label: '저축률', weight: 20, score: scale(s.savingsRate, 0, c.savingsRate) },
    { label: '비상금', weight: 15, score: scale(emergencyMonths(s), 0, c.emergencyMonths) },
    { label: '부채', weight: 15, score: scale(debtRatio, c.debtRatioMax * 2, c.debtRatioMax / 2) },
    { label: '노후 준비', weight: 25, score: scale(successRate, 30, c.successTarget) },
    { label: '분산·적합', weight: 10, score: (scale(fitDiff, 40, 10) + scale(conc, 80, 40)) / 2 },
    { label: '보장', weight: 15, score: covRatio },
  ];
  const total = items.reduce((a, i) => a + i.weight * i.score, 0);
  return { total: Math.round(total), items };
}

export const LEVEL_LABEL: Record<Level, string> = { good: '양호', caution: '주의', danger: '위험' };
export const liquidLabel = (t: Asset['type']) => (ASSET_TYPES[t].liquid ? '유동' : '비유동');
