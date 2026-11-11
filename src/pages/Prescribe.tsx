import { useMemo, useState } from 'react';
import { Slider } from '../components/fields';
import { LifeChart } from '../components/LifeChart';
import { Badge, Bar, Button, Card, Disclaimer, EmptyState, PageHeader, Stat } from '../components/ui';
import { db } from '../db/db';
import { GOAL_CATEGORY } from '../db/schema';
import { buildPlanInput, type PlanOverrides } from '../engine/goals';
import { simulate } from '../engine/montecarlo';
import { bucketMap, prescriptions } from '../engine/prescribe';
import { pct, won } from '../lib/format';
import { useFlp } from '../store/FlpContext';
import type { Level } from '../types';

export default function Prescribe() {
  const d = useFlp();
  if (!d.hasData) return <><PageHeader title="처방 실행" /><EmptyState /></>;
  // 데이터가 바뀌면(저축 여력·수익률·은퇴 나이·생활비) What-if 슬라이더 시작값도 새로 맞춤
  const s = d.summary;
  return <PrescribeInner key={`${Math.round(s.savings)}|${s.portfolioReturn.toFixed(1)}|${d.profile.retireAge}|${d.profile.retireMonthlyExpense}`} />;
}

function PrescribeInner() {
  const d = useFlp();
  const { profile: p, summary: s } = d;
  const rx = useMemo(() => prescriptions(p, s, d.planInput, d.sim.successRate, d.goalPlans, d.ins), [p, s, d.planInput, d.sim.successRate, d.goalPlans, d.ins]);
  const buckets = useMemo(() => bucketMap(p, s, d.goalPlans), [p, s, d.goalPlans]);

  // 저축 여력이 마이너스면(매달 금융자산에서 꺼내 씀) 그 값에서 시작해야 ‘현재 계획’과 같은 계산이 됨
  const initial = { monthlySavings: Math.round(s.savings), meanReturn: +s.portfolioReturn.toFixed(1), retireAge: p.retireAge, retireMonthlyExpense: p.retireMonthlyExpense };
  const [o, setO] = useState<Required<Omit<PlanOverrides, 'volatility'>>>(initial);
  const changed = JSON.stringify(o) !== JSON.stringify(initial);
  const whatIf = useMemo(() => {
    if (!changed) return d.sim;
    // 수익률을 올리면 변동성도 비례해 커진다고 가정
    const volatility = s.portfolioReturn > 0 ? s.portfolioVol * (o.meanReturn / s.portfolioReturn) : s.portfolioVol;
    return simulate(buildPlanInput(p, d.assets, d.liabilities, d.goals, s, { ...o, volatility }), 1000);
  }, [changed, d.sim, o, p, d.assets, d.liabilities, d.goals, s]);
  const delta = whatIf.successRate - d.sim.successRate;
  const lvl = (v: number): Level => (v >= p.criteria.successTarget ? 'good' : v >= 60 ? 'caution' : 'danger');

  return (
    <>
      <PageHeader title="처방 실행" desc="진단 결과를 바탕으로 행동 지침을 제시하고, 계획을 바꿨을 때의 결과를 바로 확인합니다." />

      <Card title="처방전" action={<span className="text-xs text-muted">목표 성공확률 {p.criteria.successTarget}% 기준</span>}>
        <ul className="divide-y divide-line">
          {rx.map((r, i) => (
            <li key={i} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
              <span className="mt-0.5 w-12 shrink-0 text-xs font-semibold text-muted">{r.area}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-semibold">{r.title}</span>
                  <Badge level={r.level} />
                </div>
                <p className="mt-0.5 text-sm text-muted">{r.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="계획 바꿔보기 (What-if)" className="mt-4" action={changed && <button className="text-xs font-medium text-brand" onClick={() => setO(initial)}>원래대로</button>}>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
          <div className="space-y-5">
            <Slider label="월 저축액" value={o.monthlySavings} min={s.savings < 0 ? Math.floor((s.savings - 100) / 10) * 10 : 0} max={Math.max(500, Math.round(s.income), -Math.round(s.savings))} step={10} display={o.monthlySavings < 0 ? `월 ${won(-o.monthlySavings)} 부족 (금융자산에서 꺼냄)` : `${won(o.monthlySavings)} (저축률 ${s.income > 0 ? pct((o.monthlySavings / s.income) * 100) : '-'})`} onChange={(v) => setO({ ...o, monthlySavings: v })} />
            <Slider label={p.retireSeparate ? '기대수익률(은퇴 전)' : '기대수익률'} value={o.meanReturn} min={1} max={10} step={0.1} display={`${o.meanReturn.toFixed(1)}%`} onChange={(v) => setO({ ...o, meanReturn: v })} />
            {!d.start.retired && <Slider label="은퇴 나이" value={o.retireAge} min={Math.max(s.age, 45)} max={75} step={1} display={`${o.retireAge}세`} onChange={(v) => setO({ ...o, retireAge: v })} />}
            <Slider label="은퇴 후 월 생활비" value={o.retireMonthlyExpense} min={100} max={Math.max(800, p.retireMonthlyExpense + 200)} step={10} display={won(o.retireMonthlyExpense)} onChange={(v) => setO({ ...o, retireMonthlyExpense: v })} />
            <div className="grid grid-cols-2 gap-3 rounded-xl bg-sunken p-3">
              <Stat label="현재 계획" value={pct(d.sim.successRate)} tone={lvl(d.sim.successRate)} />
              <Stat label="바꾼 계획" value={pct(whatIf.successRate)} tone={lvl(whatIf.successRate)} sub={changed ? `${delta >= 0 ? '+' : ''}${delta.toFixed(0)}%p` : '슬라이더를 움직여 보세요'} />
            </div>
            {changed && (o.retireAge !== p.retireAge || o.retireMonthlyExpense !== p.retireMonthlyExpense) && (
              <Button variant="ghost" className="w-full" onClick={() => db.profile.put({ ...p, retireAge: o.retireAge, retireMonthlyExpense: o.retireMonthlyExpense })}>
                은퇴 나이·생활비를 내 계획에 반영
              </Button>
            )}
            <p className="text-xs text-muted">저축액·수익률은 실제 지출과 자산 구성을 바꿔야 반영됩니다. 월 저축액이 마이너스면 은퇴 전에도 그만큼을 매달 금융자산에서 꺼내 쓰는 것으로 계산합니다. 수익률을 올리면 변동성도 같은 비율로 커진다고 가정합니다.{p.retireSeparate && ' 은퇴 후 수익률은 프로필 설정값을 그대로 씁니다.'}{d.liabilities.length > 0 && ' 대출 상환이 끝나면 그 상환액만큼 저축이 늘어납니다.'}</p>
          </div>
          <LifeChart sim={whatIf} retireAge={o.retireAge} height={320} />
        </div>
      </Card>

      <Card title="재무목표별 필요 적립액" className="mt-4">
        {d.goalPlans.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted">등록된 재무목표가 없습니다. ‘데이터·설정 → 재무목표’에서 추가하세요.</p>
        ) : (
          <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="py-2 font-medium">목표</th>
                  <th className="font-medium">시기</th>
                  <th className="text-right font-medium">현재가치</th>
                  <th className="text-right font-medium">미래 필요액</th>
                  <th className="text-right font-medium">배정 자산</th>
                  <th className="text-right font-medium">월 적립 필요</th>
                  <th className="w-28 pl-3 font-medium">준비율</th>
                </tr>
              </thead>
              <tbody>
                {d.goalPlans.map((g) => (
                  <tr key={g.goal.id} className="border-b border-line last:border-0">
                    <td className="py-2.5"><div className="font-medium">{g.goal.name}</div><div className="text-xs text-muted">{GOAL_CATEGORY[g.goal.category]} · 상승률 {g.goal.growthRate}%</div></td>
                    <td>{g.goal.targetAge}세 <span className="text-xs text-muted">({g.years}년 후)</span></td>
                    <td className="text-right">{won(g.goal.amountPV)}</td>
                    <td className="text-right font-medium">{won(g.futureValue)}</td>
                    <td className="text-right">{won(g.allocated)}</td>
                    <td className="text-right font-semibold">{won(g.monthlyNeeded)}</td>
                    <td className="pl-3"><Bar value={g.fundedRatio} level={g.fundedRatio >= 100 ? 'good' : g.fundedRatio >= 50 ? 'caution' : 'danger'} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-muted">‘중기·목적자금’ 용도 자산을 시기가 빠른 목표부터 배정하고, 부족분을 해당 자산의 기대수익률로 월 적립액을 계산했습니다.</p>
          </div>
        )}
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="목적별 자산 바구니">
          <div className="space-y-4">
            {buckets.map((b) => {
              const ratio = b.target > 0 ? (b.current / b.target) * 100 : 100;
              return (
                <div key={b.key}>
                  <div className="mb-1 flex items-baseline justify-between text-sm">
                    <span className="font-semibold">{b.label}</span>
                    <span><b>{won(b.current)}</b> <span className="text-xs text-muted">/ 권장 {won(b.target)}</span></span>
                  </div>
                  <Bar value={Math.min(ratio, 100)} level={ratio >= 90 && ratio <= 150 ? 'good' : ratio < 60 || ratio > 200 ? 'danger' : 'caution'} />
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-muted">비상금 = 월 지출 × {p.criteria.emergencyMonths}개월, 목적자금 = 10년 이내 목표의 현재 필요액, 노후자금 = 나머지 금융자산(부동산은 제외 · 매각 계획은 노후 진단에 반영).</p>
        </Card>

        <Card title="보장 갭 분석" action={<Badge level={d.ins.premiumLevel}>보험료 {pct(d.ins.premiumRatio, 1)}</Badge>}>
          <div className="space-y-5">
            {d.ins.people.map((g) => (
              <div key={g.person}>
                {d.ins.people.length > 1 && (
                  <div className="mb-2 flex items-baseline justify-between gap-2 border-b border-line pb-1">
                    <span className="text-sm font-bold">{g.person}</span>
                    <span className="text-xs text-muted">{g.count}건 · 월 {won(g.premium)}</span>
                  </div>
                )}
                {g.count === 0 && g.who !== 'self' && <p className="mb-2 text-xs text-muted">가입한 보험이 없습니다. 보험 탭에서 피보험자를 {g.person}로 지정하면 여기에 모입니다.</p>}
                <div className="space-y-4">
            {g.lines.map((l) => (
              <div key={l.key}>
                <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 text-sm">
                  <span className="font-semibold">{l.label}</span>
                  <span>
                    <b>{won(l.current)}</b> <span className="text-xs text-muted">/ 필요 {won(l.need)}</span>
                  </span>
                </div>
                <Bar value={Math.min(100, l.ratio)} level={l.level} />
                <div className="mt-1 text-xs text-muted">{l.gap > 0 ? `${won(l.gap)} 부족` : l.gap < 0 ? `${won(-l.gap)} 초과` : '적정'}</div>
              </div>
            ))}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted">필요 사망보장 = 유족 생활비 × 부양기간 + 부채 + 교육비 − 유동자산. 진단비 = 그 사람 연소득 × {p.criteria.criticalMultiple}배(소득이 없으면 3,000만원). 배우자 사망보장 = 배우자 연소득 × 부양기간, 자녀는 진단비만 필요액으로 봅니다.</p>
        </Card>
      </div>
      <Disclaimer />
    </>
  );
}
