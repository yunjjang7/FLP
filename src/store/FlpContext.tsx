import { useLiveQuery } from 'dexie-react-hooks';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { db, getProfile, recordSnapshot } from '../db/db';
import { buildPlanInput, planGoals, type GoalPlan } from '../engine/goals';
import { insuranceGap, type InsuranceGap } from '../engine/insurance';
import { retirementNeed, simulate, withdrawStart, type PlanInput, type SimResult } from '../engine/montecarlo';
import { summarize, type Summary } from '../engine/portfolio';
import { financialScore, riskChecks, type RiskCheck } from '../engine/risk';
import type { Asset, Cashflow, Goal, Insurance, Liability, Profile, Snapshot, YearEnd } from '../types';

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
  summary: Summary;
  planInput: PlanInput;
  sim: SimResult;
  need: ReturnType<typeof retirementNeed>;
  start: ReturnType<typeof withdrawStart>; // 인출 시작 나이·자산·첫해 인출률
  goalPlans: GoalPlan[];
  ins: InsuranceGap;
  checks: RiskCheck[];
  score: ReturnType<typeof financialScore>;
}

const Ctx = createContext<FlpData | null>(null);

export function FlpProvider({ children }: { children: ReactNode }) {
  const raw = useLiveQuery(async () => {
    const [profile, assets, liabilities, cashflows, goals, insurance, snapshots, stored, yearEnds] = await Promise.all([
      getProfile(),
      db.assets.toArray(),
      db.liabilities.toArray(),
      db.cashflows.toArray(),
      db.goals.toArray(),
      db.insurance.toArray(),
      db.snapshots.orderBy('date').toArray(),
      db.profile.get('me'),
      db.yearEnds.orderBy('year').toArray(),
    ]);
    return { profile, assets, liabilities, cashflows, goals, insurance, snapshots, yearEnds, hasProfile: !!stored };
  }, []);

  const value = useMemo<FlpData | null>(() => {
    if (!raw) return null;
    const { profile, assets, liabilities, cashflows, goals, insurance, snapshots, yearEnds } = raw;
    const summary = summarize(profile, assets, liabilities, cashflows, undefined, insurance);
    const planInput = buildPlanInput(profile, assets, liabilities, goals, summary);
    const sim = simulate(planInput, 1000);
    const ins = insuranceGap(profile, summary, insurance, goals);
    const start = withdrawStart(planInput);
    return {
      loading: false,
      hasData: raw.hasProfile || assets.length > 0,
      profile, assets, liabilities, cashflows, goals, insurance, snapshots, yearEnds,
      summary, planInput, sim,
      need: retirementNeed(planInput),
      start,
      goalPlans: planGoals(goals, assets, summary.age),
      ins,
      checks: riskChecks(profile, assets, summary, start),
      score: financialScore(profile, assets, summary, sim.successRate, ins, start),
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
