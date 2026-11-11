import { useMemo, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { db } from '../db/db';
import { baseBalanceAt, DEFAULT_GUARDRAIL, guardrailBaseline, reviewYearEnds, yearsToYearEnd, type StrategyResult, type WithdrawInput, type YearEndPosition } from '../engine/withdrawal';
import { pct, won } from '../lib/format';
import { useFlp } from '../store/FlpContext';
import type { Level, PlanBase } from '../types';
import { Labeled, NumberField, TextField } from './fields';
import { Badge, Button, Card } from './ui';

/** 가드레일 vs 정액 인출: 감액을 감수한 대가로 자산이 얼마나 오래 버티는지 */
export function GuardrailCompare({ fixed, guard, lifeExpectancy }: { fixed: StrategyResult; guard: StrategyResult; lifeExpectancy: number }) {
  const age = (v: number | null) => (v === null ? `${lifeExpectancy}세까지 유지` : `${v}세`);
  const rows = [
    { label: '생활비 90% 이상 매년 충족', a: pct(fixed.successRate), b: pct(guard.successRate), diff: guard.successRate - fixed.successRate as number | null, unit: '%p' },
    { label: '자산 유지 확률', a: pct(100 - fixed.depletionRate), b: pct(100 - guard.depletionRate), diff: fixed.depletionRate - guard.depletionRate as number | null, unit: '%p' },
    { label: '고갈 나이 중앙값(전체)', a: age(fixed.medianDepletionAge), b: age(guard.medianDepletionAge), diff: null as number | null, unit: '' },
    {
      label: '고갈된 경로의 고갈 나이',
      a: fixed.depletedMedianAge === null ? '없음' : `${fixed.depletedMedianAge}세`,
      b: guard.depletedMedianAge === null ? '없음' : `${guard.depletedMedianAge}세`,
      diff: fixed.depletedMedianAge !== null && guard.depletedMedianAge !== null ? guard.depletedMedianAge - fixed.depletedMedianAge : null,
      unit: '년',
    },
    { label: '인출을 줄인 시나리오', a: '-', b: pct(guard.adjustRate), diff: null as number | null, unit: '' },
  ];
  return (
    <div className="-mx-4 mt-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
      <table className="w-full min-w-[420px] text-sm num-table">
        <thead>
          <tr className="border-b border-line text-right text-xs text-muted">
            <th className="py-1.5 text-left font-medium">정액 인출과 비교</th>
            <th className="font-medium">정액</th>
            <th className="font-medium">가드레일</th>
            <th className="font-medium">차이</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-line text-right last:border-0">
              <td className="py-1.5 text-left">{r.label}</td>
              <td className="text-muted">{r.a}</td>
              <td className="font-semibold">{r.b}</td>
              <td className={r.diff === null || Math.abs(r.diff) < 0.05 ? 'text-muted' : r.diff > 0 ? 'text-good' : 'text-bad'}>
                {r.diff === null ? '' : `${r.diff > 0 ? '+' : ''}${r.unit === '년' ? r.diff : r.diff.toFixed(1)}${r.unit}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted">가드레일은 나쁜 해에 인출을 줄이므로 ‘생활비 충족’은 정액과 비슷하거나 낮을 수 있습니다. 대신 자산 유지 확률과 고갈 시점이 얼마나 나아지는지를 보세요.</p>
    </div>
  );
}

const POSITION: Record<YearEndPosition, { label: string; level: Level }> = {
  below: { label: '하단선 아래', level: 'danger' },
  inside: { label: '기준선 안', level: 'good' },
  above: { label: '상단선 위', level: 'good' },
};

/** 연말결산: 해마다 12월 말 실제 자산·인출액을 기록하고 고정한 기준선과 비교해 가드레일 판정 */
export function YearEndReview({ input, startAge, band, cut, cutOnly }: { input: WithdrawInput; startAge: number; band: number; cut: number; cutOnly: boolean }) {
  const { profile: p, yearEnds } = useFlp();
  const now = new Date();
  const thisYear = now.getFullYear();
  const retiredNow = startAge <= thisYear - p.birthYear;
  // 고정한 기준선이 없으면 지금 계획으로 임시 기준선
  const live = useMemo<PlanBase>(() => {
    const b = guardrailBaseline(input);
    return { savedAt: now.toLocaleDateString('sv-SE'), year: p.birthYear + startAge, month: retiredNow ? now.getMonth() + 1 : 1, inflation: input.inflation, ...b };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, startAge, p.birthYear]);
  const base = p.planBase ?? live;
  const g = { ...DEFAULT_GUARDRAIL, band, cut, raise: cut, cutOnly };
  const rows = reviewYearEnds(base, yearEnds, g);
  const last = rows[rows.length - 1];

  const defaultYear = Math.max(base.year, now.getMonth() >= 11 ? thisYear : thisYear - 1);
  const [year, setYear] = useState(defaultYear);
  const [balance, setBalance] = useState(0);
  const [withdrawn, setWithdrawn] = useState(0);
  const [note, setNote] = useState('');
  const saveRecord = async () => {
    const existing = yearEnds.find((r) => r.year === year);
    const rec = { year, balance, withdrawn, note: note.trim() || undefined };
    if (existing) await db.yearEnds.update(existing.id!, rec);
    else await db.yearEnds.add(rec);
    setNote('');
  };
  const fixBase = () => {
    if (p.planBase && !confirm('지금 계획으로 기준선을 다시 고정할까요? 이전 기준선과의 비교는 사라집니다.')) return;
    db.profile.put({ ...p, planBase: live });
  };

  const lastYear = Math.max(base.year + 10, ...rows.map((r) => r.record.year + 3));
  const chart: { year: number; baseline: number; lower: number; upper: number; actual: number | null }[] = [];
  for (let y = base.year; y <= Math.min(lastYear, base.year + base.balances.length - 2); y++) {
    const bl = baseBalanceAt(base, yearsToYearEnd(base, y));
    chart.push({ year: y, baseline: bl, lower: bl * (1 - band), upper: bl * (1 + band), actual: yearEnds.find((r) => r.year === y)?.balance ?? null });
  }
  const gap = last ? ((last.record.balance - last.baseline) / last.baseline) * 100 : 0;

  return (
    <Card
      title="연말결산 — 계획 대비 실제"
      className="mt-4"
      action={<Button variant="ghost" onClick={fixBase}>{p.planBase ? '기준선 다시 고정' : '지금 계획을 기준선으로 고정'}</Button>}
    >
      <p className="text-xs text-muted">
        {p.planBase
          ? `기준선: ${p.planBase.savedAt}에 고정한 계획(평균수익·정액 인출 경로를 물가 ${p.planBase.inflation}%로 환산한 그 해 금액)입니다. 자산을 고쳐도 기준선은 바뀌지 않습니다.`
          : '아직 기준선을 고정하지 않아 지금 계획으로 임시 계산했습니다. 자산을 고칠 때마다 기준선도 바뀌므로, 계획을 확정했으면 ‘기준선으로 고정’을 누르세요.'}
      </p>

      {last && (
        <div className={`mt-3 rounded-xl px-3 py-2.5 text-sm ${last.position === 'below' ? 'bg-bad-soft' : 'bg-good-soft'}`}>
          <b>{last.record.year}년 말 판정: {POSITION[last.position].label}</b> — 실제 {won(last.record.balance)} / 기준선 {won(last.baseline)} ({gap >= 0 ? '+' : ''}{gap.toFixed(1)}%).{' '}
          {last.record.year + 1}년 권장 자산 인출 <b>월 {won(last.nextRecommended / 12)}</b>
          {last.multiplier !== 1 && <> (계획 월 {won(last.nextPlan / 12)}의 {Math.round(last.multiplier * 100)}%)</>}
          {last.position === 'below' ? ' · 하락장이면 주식 매도는 미루고 현금성·채권에서 꺼내세요.' : last.position === 'above' && cutOnly && last.multiplier >= 1 ? ' · 감액만 방식이라 계획보다 늘리지 않습니다.' : ''}
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Labeled label="결산 연도"><NumberField value={year} unit="년" onChange={(v) => setYear(Math.round(v))} /></Labeled>
        <Labeled label="12월 말 금융자산" hint="평가액 합계(명목) · 수령 전 노란우산 등 제외"><NumberField value={balance} unit="만원" onChange={setBalance} /></Labeled>
        <Labeled label="그 해 실제 인출" hint="계좌에서 꺼낸 합계"><NumberField value={withdrawn} unit="만원" onChange={setWithdrawn} /></Labeled>
        <Labeled label="메모(선택)"><TextField value={note} onChange={setNote} /></Labeled>
        <div className="self-end">
          <Button onClick={saveRecord} disabled={balance <= 0}>{yearEnds.some((r) => r.year === year) ? '결산 고치기' : '결산 저장'}</Button>
        </div>
      </div>

      {rows.length > 0 && (
        <>
          <div className="mt-4 h-56">
            <ResponsiveContainer>
              <LineChart data={chart} margin={{ left: 0, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="year" tickLine={false} axisLine={false} minTickGap={16} />
                <YAxis tickFormatter={(v) => won(v, false)} width={56} tickLine={false} axisLine={false} />
                <Tooltip labelFormatter={(y) => `${y}년 말`} formatter={(v: number) => won(v)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line dataKey="upper" name="상단선" stroke="var(--c-muted)" strokeDasharray="4 4" dot={false} isAnimationActive={false} />
                <Line dataKey="baseline" name="기준선" stroke="var(--chart-1)" strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line dataKey="lower" name="하단선" stroke="var(--c-bad)" strokeDasharray="4 4" dot={false} isAnimationActive={false} />
                <Line dataKey="actual" name="실제" stroke="var(--chart-4)" strokeWidth={2} dot={{ r: 4 }} connectNulls isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="-mx-4 mt-3 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
            <table className="w-full min-w-[640px] text-sm num-table">
              <thead>
                <tr className="border-b border-line text-right text-xs text-muted">
                  <th className="py-1.5 text-left font-medium">연도</th>
                  <th className="font-medium">기준선</th>
                  <th className="font-medium">실제 자산</th>
                  <th className="font-medium">판정</th>
                  <th className="font-medium">계획 인출</th>
                  <th className="font-medium">실제 인출</th>
                  <th className="font-medium">다음 해 권장(월)</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.record.year} className="border-b border-line text-right last:border-0">
                    <td className="py-1.5 text-left font-medium">
                      {r.record.year}
                      {r.record.note && <span className="ml-1 text-xs font-normal text-muted">{r.record.note}</span>}
                    </td>
                    <td className="text-muted">{won(r.baseline)}</td>
                    <td className="font-semibold">{won(r.record.balance)}</td>
                    <td><Badge level={POSITION[r.position].level}>{POSITION[r.position].label}</Badge></td>
                    <td className="text-muted">{won(r.planWithdrawal)}</td>
                    <td className={r.record.withdrawn > r.planWithdrawal * 1.1 ? 'text-warn' : ''}>{won(r.record.withdrawn)}</td>
                    <td className="font-semibold">{won(r.nextRecommended / 12)}</td>
                    <td>
                      <button className="text-xs text-bad hover:underline" onClick={() => confirm(`${r.record.year}년 결산을 삭제할까요?`) && db.yearEnds.delete(r.record.id!)}>삭제</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">
        <li>매년 1월에 전년도 12월 말 평가액과 그 해 실제 인출액을 넣으세요. 판정은 1년에 한 번만 하고, 연중 등락에는 반응하지 않습니다.</li>
        <li>기준선과 계획 인출액은 물가를 반영한 그 해 금액입니다. 첫해는 기준선을 고정한 달부터 12월까지만 셉니다.</li>
        <li>결산을 넣은 뒤 ‘데이터·설정 → 자산’ 금액도 12월 말 평가액으로 고쳐야 노후 진단·인출 계획이 그 값에서 다시 계산됩니다.</li>
      </ul>
    </Card>
  );
}
