import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Donut } from '../components/Donut';
import { Badge, Bar, Card, Disclaimer, EmptyState, PageHeader, Stat } from '../components/ui';
import { pct, won } from '../lib/format';
import { useFlp } from '../store/FlpContext';
import type { Level } from '../types';

export default function Home() {
  const d = useFlp();
  const [view, setView] = useState<'type' | 'purpose'>('type');
  if (!d.hasData) return <><PageHeader title="내 자산 한눈에" /><EmptyState /></>;
  const s = d.summary;
  const scoreLevel: Level = d.score.total >= 75 ? 'good' : d.score.total >= 50 ? 'caution' : 'danger';
  const alerts = d.checks.filter((c) => c.level !== 'good').sort((a, b) => (a.level === 'danger' ? -1 : 0) - (b.level === 'danger' ? -1 : 0)).slice(0, 3);
  const successLevel: Level = d.sim.successRate >= d.profile.criteria.successTarget ? 'good' : d.sim.successRate >= 60 ? 'caution' : 'danger';

  return (
    <>
      <PageHeader title={`${d.profile.name ? d.profile.name + '님의 ' : ''}자산 한눈에`} desc={`${s.age}세 · 은퇴 목표 ${d.profile.retireAge}세 · 기준일 ${new Date().toLocaleDateString('ko-KR')}`} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="text-sm text-muted">순자산</div>
          <div className="mt-1 text-4xl font-extrabold tracking-tight">{won(s.netWorth)}</div>
          <div className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-4">
            <Stat label="총자산" value={won(s.totalAssets)} />
            <Stat label="부채" value={won(s.totalDebt)} sub={s.depositDebt > 0 ? `임대보증금 ${won(s.depositDebt)} 포함` : undefined} />
            <Stat label="금융자산" value={won(s.financialAssets)} sub={`부동산 ${won(s.realEstate)}`} />
          </div>
        </Card>
        <Card>
          <div className="flex items-start justify-between">
            <div className="text-sm text-muted">종합 재무점수</div>
            <Badge level={scoreLevel} />
          </div>
          <div className="mt-1 text-4xl font-extrabold tracking-tight">
            {d.score.total}
            <span className="text-lg font-semibold text-muted">/100</span>
          </div>
          <ul className="mt-3 space-y-1.5">
            {d.score.items.map((i) => (
              <li key={i.label} className="flex items-center gap-2 text-xs">
                <span className="w-16 shrink-0 text-muted">{i.label}</span>
                <Bar value={i.score * 100} level={i.score >= 0.999 ? 'good' : i.score >= 0.5 ? 'caution' : 'danger'} />
                <span className="w-10 shrink-0 text-right">{Math.round(i.score * i.weight)}/{i.weight}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card
          title="자산 구성"
          action={
            <div className="flex rounded-lg bg-sunken p-0.5 text-xs">
              {(['type', 'purpose'] as const).map((v) => (
                <button key={v} onClick={() => setView(v)} className={`rounded-md px-2.5 py-1 font-medium ${view === v ? 'bg-surface shadow-sm' : 'text-muted'}`}>
                  {v === 'type' ? '유형별' : '용도별'}
                </button>
              ))}
            </div>
          }
        >
          <Donut data={view === 'type' ? s.byType : [...s.byPurpose, ...s.byReUse]} />
        </Card>

        <Card title="월 현금흐름">
          <div className="space-y-2.5 text-sm">
            <Row label="세후 소득" value={won(s.income)} />
            <Row label="고정비" value={`− ${won(s.fixed)}`} muted />
            <Row label="변동비" value={`− ${won(s.variable)}`} muted />
            <Row label="대출 원리금" value={`− ${won(s.debtPayment)}`} muted />
            {s.insurance > 0 && <Row label="보험료(보험 탭)" value={`− ${won(s.insurance)}`} muted />}
            <div className="border-t border-line pt-2.5">
              <Row label="저축 여력" value={won(s.savings)} strong />
            </div>
          </div>
          <div className="mt-4">
            <div className="mb-1 flex justify-between text-xs text-muted">
              <span>저축률 {pct(s.savingsRate, 1)}</span>
              <span>목표 {d.profile.criteria.savingsRate}%</span>
            </div>
            <Bar value={s.savingsRate} max={Math.max(d.profile.criteria.savingsRate, s.savingsRate)} level={s.savingsRate >= d.profile.criteria.savingsRate ? 'good' : s.savingsRate >= d.profile.criteria.savingsRate / 2 ? 'caution' : 'danger'} />
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="주요 점검 사항" className="lg:col-span-2" action={<Link to="/invest" className="text-xs font-medium text-brand">전체 보기</Link>}>
          {alerts.length === 0 ? (
            <p className="text-sm text-muted">모든 점검 항목이 양호합니다.</p>
          ) : (
            <ul className="divide-y divide-line">
              {alerts.map((a) => (
                <li key={a.key} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                  <Badge level={a.level} />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold">{a.label} · {a.value}</div>
                    <div className="text-xs text-muted">{a.detail}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="노후 준비" action={<Link to="/retire" className="text-xs font-medium text-brand">진단 보기</Link>}>
          <Stat label="은퇴 성공확률(몬테카를로 1,000회)" value={pct(d.sim.successRate)} tone={successLevel} />
          <div className="mt-3">
            <Stat label="은퇴 준비율" value={pct(d.need.ratio)} sub={`필요 ${won(d.need.need)} · 예상 ${won(d.need.projected)}`} />
          </div>
        </Card>
      </div>

      <Card title="순자산 추이" className="mt-4" action={<span className="text-xs text-muted">데이터가 바뀌면 그날의 값이 자동 기록됩니다</span>}>
        {d.snapshots.length < 2 ? (
          <p className="py-6 text-center text-sm text-muted">기록이 쌓이면 추이가 표시됩니다. (현재 {d.snapshots.length}건)</p>
        ) : (
          <div className="h-56">
            <ResponsiveContainer>
              <AreaChart data={d.snapshots} margin={{ left: 0, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={24} />
                <YAxis tickFormatter={(v) => won(v, false)} width={56} tickLine={false} axisLine={false} />
                <Tooltip formatter={(v: number) => won(v)} labelFormatter={(l) => l} />
                <Area dataKey="netWorth" name="순자산" stroke="var(--chart-1)" fill="var(--chart-1)" fillOpacity={0.15} strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>
      <Disclaimer />
    </>
  );
}

function Row({ label, value, muted, strong }: { label: string; value: string; muted?: boolean; strong?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className={muted ? 'text-muted' : ''}>{label}</span>
      <span className={strong ? 'text-base font-bold' : 'font-medium'}>{value}</span>
    </div>
  );
}
