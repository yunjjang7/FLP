import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { db, getProfile, loadPlan } from '../db/db';
import { sampleData } from '../db/sample';
import type { SavedPlan } from '../types';
import { buildPlanInput } from './goals';
import { simulate } from './montecarlo';
import { makePlan, MAX_PLANS, planMetrics, withoutPlan, withPlan } from './plans';
import { summarize } from './portfolio';

const TODAY = '2026-11-13';

describe('저장한 계획 비교', () => {
  it('makePlan: 안쪽 프로필에 plans 를 넣지 않고 draft 를 덮어씀', () => {
    const d = sampleData();
    const old = makePlan('이전안', d, TODAY);
    const data = { ...d, profile: { ...d.profile, plans: [old] } };
    const plan = makePlan('63세 은퇴안', data, TODAY, { retireAge: 63, retireMonthlyExpense: 300 });
    expect(plan.name).toBe('63세 은퇴안');
    expect(plan.savedAt).toBe(TODAY);
    expect(plan.profile.plans).toBeUndefined();
    expect('plans' in plan.profile).toBe(false);
    expect(plan.profile.retireAge).toBe(63);
    expect(plan.profile.retireMonthlyExpense).toBe(300);
    // 원본 데이터는 바뀌지 않고, 저장본은 복사본
    expect(data.profile.retireAge).toBe(d.profile.retireAge);
    expect(plan.assets).toEqual(d.assets);
    expect(plan.assets).not.toBe(d.assets);
    // 이름을 비우면 저장일로 이름 붙임
    expect(makePlan('  ', d, TODAY).name).toBe(`계획 ${TODAY}`);
  });

  it('planMetrics: 화면과 같은 방식(summarize → buildPlanInput → simulate)이라 성공확률이 같음', () => {
    const d = sampleData();
    const month = 6;
    const s = summarize(d.profile, d.assets, d.liabilities, d.cashflows, undefined, d.insurance, month);
    const sim = simulate(buildPlanInput(d.profile, d.assets, d.liabilities, d.goals, s), 1000);
    const m = planMetrics(d, month);
    expect(m.successRate).toBe(sim.successRate);
    expect(m.endP50).toBe(sim.p50[sim.p50.length - 1]);
    expect(m.age).toBe(s.age);
    expect(m.financialAssets).toBe(s.financialAssets);
    expect(m.netWorth).toBe(s.netWorth);
    expect(m.retireAge).toBe(d.profile.retireAge);
    expect(m.living).toBe(d.profile.retireMonthlyExpense);
    expect(m.drawMode).toBe(false);
    // 저장한 계획으로 돌려도 같은 값
    expect(planMetrics(makePlan('지금', d, TODAY), month).successRate).toBe(sim.successRate);
  });

  it('은퇴 나이만 다른 두 계획은 지표가 달라짐', () => {
    const d = sampleData();
    const a = planMetrics(makePlan('60세', d, TODAY, { retireAge: 60 }), 6);
    const b = planMetrics(makePlan('65세', d, TODAY, { retireAge: 65 }), 6);
    expect(a.retireAge).toBe(60);
    expect(b.retireAge).toBe(65);
    expect(b.startAge).toBe(65);
    expect(a.financialAssets).toBe(b.financialAssets); // 지금 자산은 같음
    // 늦게 은퇴하면 저축 기간이 늘고 인출 기간이 줄어 성공확률이 오르고, 평균 수익일 때 더 오래 버팀
    expect(b.successRate).toBeGreaterThan(a.successRate);
    expect(b.depletedAt ?? b.lifeExpectancy + 1).toBeGreaterThan(a.depletedAt ?? a.lifeExpectancy);
    expect(b.endP50).toBeGreaterThanOrEqual(a.endP50);
  });

  it('인출액 고정 방식이면 월 생활비 대신 월 고정 인출액', () => {
    const d = sampleData();
    const m = planMetrics(makePlan('고정', d, TODAY, { expenseMode: 'draw', fixedDraw: 280 }), 6);
    expect(m.drawMode).toBe(true);
    expect(m.living).toBe(280);
  });

  it('목록 헬퍼: 추가·같은 id 교체·최대 개수·삭제', () => {
    const d = sampleData();
    const ps: SavedPlan[] = Array.from({ length: MAX_PLANS }, (_, i) => ({ ...makePlan(`안${i}`, d, TODAY), id: `p${i}` }));
    let list = withPlan(undefined, ps[0]);
    expect(list.map((x) => x.id)).toEqual(['p0']);
    for (const x of ps.slice(1)) list = withPlan(list, x);
    expect(list).toHaveLength(MAX_PLANS);
    // 가득 차면 더 넣지 않음
    expect(withPlan(list, { ...ps[0], id: 'extra' })).toHaveLength(MAX_PLANS);
    // 같은 id 는 바꿔 넣음
    const renamed = withPlan(list, { ...ps[2], name: '바꾼 이름' });
    expect(renamed).toHaveLength(MAX_PLANS);
    expect(renamed[2].name).toBe('바꾼 이름');
    expect(withoutPlan(list, 'p1').map((x) => x.id)).toEqual(['p0', 'p2', 'p3', 'p4']);
    expect(withoutPlan(undefined, 'p1')).toEqual([]);
  });

  it('loadPlan: 목록 데이터와 프로필을 계획으로 바꾸되 저장 계획 목록·순자산 추이는 유지', async () => {
    const d = sampleData();
    const plan = makePlan('63세 은퇴안', d, TODAY, { retireAge: 63 });
    const other = { ...plan, id: 'other', name: '다른 안' };
    await db.profile.put({ ...d.profile, retireAge: 58, plans: [plan, other] });
    await db.assets.bulkAdd([{ ...d.assets[0], id: undefined, name: '지울 자산' }]);
    await db.snapshots.add({ date: '2026-01-01', netWorth: 1, totalAssets: 1, totalDebt: 0 });
    await loadPlan(plan);
    const p = await getProfile();
    expect(p.retireAge).toBe(63);
    expect(p.plans?.map((x) => x.id)).toEqual([plan.id, 'other']);
    const assets = await db.assets.toArray();
    expect(assets.map((a) => a.name)).toEqual(d.assets.map((a) => a.name));
    expect(await db.goals.count()).toBe(d.goals.length);
    expect(await db.snapshots.count()).toBe(1);
  });
});
