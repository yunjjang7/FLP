import { useLiveQuery } from 'dexie-react-hooks';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { db, getProfile, recordSnapshot } from '../db/db';
import { buildPlanInput, planGoals, type GoalPlan } from '../engine/goals';
import { insuranceGap, type InsuranceGap } from '../engine/insurance';
import { retirementNeed, simulate, withdrawStart, type PathTax, type PlanInput, type SimResult } from '../engine/montecarlo';
import { summarize, type Summary } from '../engine/portfolio';
import { makePathTax, makeRetax, type Retax } from '../engine/pensionTaxPlan';
import { bulletChecks, cashRunwayChecks, marketChecks, financialScore, retiredBasis, riskChecks, type RiskCheck } from '../engine/risk';
import { bearPlan, bondsOnHand, normalPlan, peakPlan, pensionClassParts, type BearPlan, type PeakPlan, cashMoveRows, cashOnHand, cashRunway, pensionBondParts, pensionCashParts, startAges, withPensionCash, type BondsOnHand, type CashOnHand } from '../engine/buckets';
import type { MaturityRow } from '../engine/maturity';
import type { Asset, Cashflow, Goal, Insurance, Liability, Profile, Snapshot, YearEnd, Draw } from '../types';

export interface FlpData {
  loading: boolean;
  hasData: boolean;
  profile: Profile;
  assets: Asset[];
  liabilities: Liability[];
  cashflows: Cashflow[];
  goals: Goal[];
  insurance: Insurance[];
  snapshots: Snapshot[];
  yearEnds: YearEnd[];
  draws: Draw[]; // 월별 실제 인출 기록
  summary: Summary;
  basis: Summary; // 점검·처방 기준: 은퇴 후에는 월소득·월 지출을 은퇴 후 흐름으로 바꾼 값(은퇴 전이면 summary 와 같음)
  planInput: PlanInput;
  retax: Retax; // 계획을 바꿔 다시 계산할 때 연금 인출 세금도 바뀐 계획에 맞춰 다시 넣음(설정이 아니오면 세금을 뺌)
  sim: SimResult; // 노후 진단 기본 결과(연금 인출 세금을 경로마다 계산)
  simFlat: SimResult; // 같은 계획을 평균 경로 세금으로 돌린 결과: 가드레일·스트레스·사별처럼 여러 번 돌려 비교하는 표의 기준
  pathTax?: PathTax; // 경로별 세금 함수(연금 인출 세금을 반영할 때만)
  need: ReturnType<typeof retirementNeed>;
  start: ReturnType<typeof withdrawStart>; // 인출 시작 나이·자산·첫해 인출률
  goalPlans: GoalPlan[];
  ins: InsuranceGap;
  checks: RiskCheck[];
  cash: CashOnHand; // 연금계좌 밖 현금성: 바로 쓸 수 있는 돈과 만기가 3개월 넘게 남은 예금·적금(요약 보고 현금성 문장)
  runCash: CashOnHand; // 버틸 햇수 점검·처방용: 프로필 설정이 예면 연금계좌 안 현금성도 더함
  bonds: BondsOnHand; // 하락장 처방용 채권형: 인출 시작 해에 55세 전인 계좌 주인의 연금계좌 안 채권형은 뺌
  bear: BearPlan | null; // 하락장이고 바로 쓸 돈이 2년치에 못 미칠 때 채권형에서 먼저 꺼낼 금액(이정표 할 일)
  equity: BondsOnHand; // 고점 부근 처방용 주식형: 인출 시작 해에 55세 전인 계좌 주인의 연금계좌 안 주식형은 뺌
  peak: PeakPlan | null; // 고점 부근이고 바로 쓸 돈이 2년치에 못 미칠 때 주식형을 팔아 채울 현금성(이정표 할 일·인출 바구니)
  normal: BearPlan | null; // 보통 구간이고 바로 쓸 돈이 2년치에 못 미칠 때 1월 리밸런싱 때 채권형에서 옮길 현금성(이정표 할 일·인출 바구니)
  cashMove: MaturityRow[]; // 바로 쓸 돈이 2년치에 못 미쳐 만기 뒤 현금성 바구니로 옮길 예금·적금(이정표 할 일)
  score: ReturnType<typeof financialScore>;
}

const Ctx = createContext<FlpData | null>(null);

export function FlpProvider({ children }: { children: ReactNode }) {
  const raw = useLiveQuery(async () => {
    const [profile, assets, liabilities, cashflows, goals, insurance, snapshots, stored, yearEnds, draws] = await Promise.all([
      getProfile(),
      db.assets.toArray(),
      db.liabilities.toArray(),
      db.cashflows.toArray(),
      db.goals.toArray(),
      db.insurance.toArray(),
      db.snapshots.orderBy('date').toArray(),
      db.profile.get('me'),
      db.yearEnds.orderBy('year').toArray(),
      db.draws.orderBy('month').toArray(),
    ]);
    return { profile, assets, liabilities, cashflows, goals, insurance, snapshots, yearEnds, draws, hasProfile: !!stored };
  }, []);

  const value = useMemo<FlpData | null>(() => {
    if (!raw) return null;
    const { profile, assets, liabilities, cashflows, goals, insurance, snapshots, yearEnds, draws } = raw;
    // 올해는 남은 달(이번 달 포함)만큼만 노후 계산에 넣음
    const summary = summarize(profile, assets, liabilities, cashflows, undefined, insurance, new Date().getMonth() + 1);
    // 연금계좌 인출 세금(인출 계획과 같은 계산)을 나이별 지출로 더해 성공확률·고갈 나이에 반영
    const retax = makeRetax(profile, assets, profile.birthYear + summary.age);
    const planInput = retax(buildPlanInput(profile, assets, liabilities, goals, summary));
    // 성공확률은 경로마다 그 경로의 수익률로 연금 인출 세금을 계산(평균 경로 세금보다 정확하지만 약 4배 느려 기본 계산에만)
    const pathTax = makePathTax(profile, assets, planInput, profile.birthYear + summary.age);
    const simFlat = simulate(planInput, 1000);
    const sim = pathTax ? simulate(planInput, 1000, 42, pathTax) : simFlat;
    // 이미 은퇴했으면 비상금·DSR·보험료 부담은 지출 탭·세후 월소득 대신 은퇴 후 흐름 기준
    const basis = retiredBasis(summary, planInput);
    const ins = insuranceGap(profile, basis, insurance, goals);
    const start = withdrawStart(planInput);
    const cash = cashOnHand(assets, profile.birthYear + summary.age, new Date().getMonth() + 1);
    const ages = startAges(start.age, profile.birthYear, profile.spouseBirthYear);
    const runCash = profile.cashRunwayPension ? withPensionCash(cash, pensionCashParts(assets, profile.spouseBirthYear > 0), ages) : cash;
    const bonds = bondsOnHand(summary.byClass.find((x) => x.key === 'bond')?.value ?? 0, pensionBondParts(assets, profile.spouseBirthYear > 0), ages);
    const equity = bondsOnHand(summary.byClass.find((x) => x.key === 'equity')?.value ?? 0, pensionClassParts(assets, profile.spouseBirthYear > 0, 'equity'), ages);
    const run = cashRunway(runCash, start, planInput.currentAge);
    return {
      loading: false,
      hasData: raw.hasProfile || assets.length > 0,
      profile, assets, liabilities, cashflows, goals, insurance, snapshots, yearEnds, draws,
      summary, basis, planInput, retax, sim, simFlat, pathTax,
      need: retirementNeed(planInput),
      start,
      goalPlans: planGoals(goals, assets, summary.age),
      ins,
      cash, runCash, bonds, bear: bearPlan(profile.marketDrawdown, runCash.usable, start.outflow, bonds),
      equity, peak: peakPlan(profile.marketDrawdown, runCash.usable, start.outflow, equity),
      normal: normalPlan(profile.marketDrawdown, runCash.usable, start.outflow, bonds), cashMove: cashMoveRows(runCash, run),
      checks: [...bulletChecks(liabilities, summary.age), ...riskChecks(profile, assets, basis, start), ...cashRunwayChecks(runCash, run, profile), ...marketChecks(profile, runCash, start.outflow, new Date(), equity)],
      score: financialScore(profile, assets, basis, sim.successRate, ins, start),
    };
  }, [raw]);

  // 순자산 추이 자동 기록(하루 1건, 같은 날은 갱신)
  useEffect(() => {
    if (!value?.hasData || value.assets.length === 0) return;
    const { netWorth, totalAssets, totalDebt } = value.summary;
    recordSnapshot({ netWorth, totalAssets, totalDebt }).catch(() => {});
  }, [value?.hasData, value?.assets.length, value?.summary.netWorth, value?.summary.totalAssets, value?.summary.totalDebt]);

  if (!value) {
    return <div className="flex h-dvh items-center justify-center text-muted">불러오는 중…</div>;
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFlp() {
  const v = useContext(Ctx);
  if (!v) throw new Error('FlpProvider 밖에서 사용됨');
  return v;
}
