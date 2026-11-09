import { Bar as RBar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ExpenseCompare } from '../components/ExpenseCompare';
import { LifeChart } from '../components/LifeChart';
import { Sensitivity } from '../components/Sensitivity';
import { expenseAt, pensionAt, retireOutflowAt } from '../engine/montecarlo';
import { withdrawLevel } from '../engine/risk';
import { RE_USE, reUseOf, willSell } from '../engine/realestate';
import { Bar, Card, Disclaimer, EmptyState, PageHeader, Stat } from '../components/ui';
import { pct, won } from '../lib/format';
import { useFlp } from '../store/FlpContext';
import type { Level } from '../types';

export default function Retire() {
  const d = useFlp();
  if (!d.hasData) return <><PageHeader title="노후 진단" /><EmptyState /></>;
  const { sim, need, planInput: inp, profile: p, start } = d;
  const retired = start.retired;
  const target = p.criteria.successTarget;
  const level: Level = sim.successRate >= target ? 'good' : sim.successRate >= 60 ? 'caution' : 'danger';
  const failRate = 100 - sim.successRate;
  // 모든 소득이 개시된 나이 기준 자산 인출액
  const fullAge = Math.max(start.age, ...inp.pensions.map((x) => x.startAge));
  const draw = inp.fixedDraw !== undefined;
  const gapMonthly = draw ? retireOutflowAt(inp, fullAge) / 12 : Math.max(0, expenseAt(inp, fullAge) / 12 - pensionAt(inp, fullAge) / 12);
  const expenseNote = draw ? `연금 생활비 명목 고정(월 ${won((inp.fixedDraw ?? 0) / 12)})` : inp.expenseGrowth !== undefined ? `생활비 명목 ${inp.expenseGrowth}% 증가` : '물가 연동';
  const wLevel = withdrawLevel(start.rate, p.criteria.withdrawRateMax);
  const lateDebts = (inp.debts ?? []).filter((x) => x.endAge > inp.retireAge);
  // 부동산: 보유 중엔 운용자산에서 빼고, 임대 월세는 소득, 매각 예정이면 매각 연도에 순매각대금 유입
  const nowYear = p.birthYear + d.summary.age;
  const re = d.assets.filter((a) => a.type === 'realestate');
  const reNote =
    re.length === 0
      ? '없음'
      : re.map((a) => `${a.name}(${RE_USE[reUseOf(a)]}${willSell(a, nowYear) ? ` · ${a.lockYear}년 매각` : ''}${reUseOf(a) === 'rental' && (a.rent ?? 0) > 0 ? ' · 월세 소득' : ''})`).join(' · ') + ' — 보유 중엔 시뮬레이션 제외';
  const readyLevel: Level = need.ratio >= 100 ? 'good' : need.ratio >= 70 ? 'caution' : 'danger';

  const verdict =
    sim.successRate >= target
      ? `현재 소비와 투자 성향을 유지하면 ${p.lifeExpectancy}세까지 자산이 유지될 확률이 ${pct(sim.successRate)}입니다.`
      : sim.medianDepletionAge
        ? `현재 소비와 투자 성향을 유지할 경우, ${sim.medianDepletionAge}세 무렵 자산이 고갈될 가능성이 높습니다(고갈 확률 ${pct(failRate)}).`
        : `현재 계획으로는 ${p.lifeExpectancy}세 이전에 자산이 고갈될 확률이 ${pct(failRate)}입니다.`;

  return (
    <>
      <PageHeader title="노후 진단" desc="수익률의 변동성을 반영한 1,000가지 시장 시나리오로 평생 자산 흐름을 시뮬레이션합니다. 모든 금액은 현재 물가 기준(실질)입니다." />

      <Card className={level === 'good' ? 'border-good/40 bg-good-soft' : level === 'caution' ? 'border-warn/40 bg-warn-soft' : 'border-bad/40 bg-bad-soft'}>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div>
            <div className="text-xs font-medium text-muted">은퇴 성공확률</div>
            <div className={`text-5xl font-extrabold tracking-tight ${level === 'good' ? 'text-good' : level === 'caution' ? 'text-warn' : 'text-bad'}`}>{pct(sim.successRate)}</div>
          </div>
          <p className="min-w-0 flex-1 basis-64 text-[15px] font-medium leading-relaxed">{verdict}</p>
        </div>
      </Card>

      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card><Stat label={retired ? '앞으로 필요한 자금' : '은퇴 시점 필요자금'} value={won(need.need)} sub={`${start.age}세~${p.lifeExpectancy}세 부족 생활비·지출의 현재가치`} /></Card>
        <Card><Stat label={retired ? '현재 금융자산' : '은퇴 시점 예상자산'} value={won(need.projected)} sub={retired ? `${start.age}세 · 인출 중` : '평균수익 가정, 목적자금 지출 후'} /></Card>
        <Card>
          <Stat label="은퇴 준비율" value={pct(need.ratio)} tone={readyLevel} />
          <div className="mt-2"><Bar value={need.ratio} level={readyLevel} /></div>
        </Card>
        {retired ? (
          <Card><Stat label="현재 인출률" value={pct(start.rate, 1)} tone={wLevel} sub={`연 ${won(start.outflow)} 인출 · 상한 ${p.criteria.withdrawRateMax}%`} /></Card>
        ) : (
          <Card><Stat label="은퇴 시점 자산 범위" value={won(sim.balanceAtRetire.p50)} sub={`비관 ${won(sim.balanceAtRetire.p10)} · 낙관 ${won(sim.balanceAtRetire.p90)}`} /></Card>
        )}
      </div>

      <Card title="생애 자산 잔액 곡선" className="mt-4" action={<span className="text-xs text-muted">{inp.currentAge}세 → {p.lifeExpectancy}세</span>}>
        <LifeChart sim={sim} retireAge={inp.retireAge} />
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="은퇴 후 월 현금흐름 (현재가치)">
          <div className="space-y-2.5 text-sm">
            {draw ? (
              <Line label="연금계좌 + 국민·개인연금(명목 고정, 오늘 가치)" value={won((inp.fixedDraw ?? 0) / 12)} />
            ) : (
              <Line label={`목표 생활비${inp.expenseGrowth !== undefined ? ` (${fullAge}세)` : ''}`} value={won(expenseAt(inp, fullAge) / 12)} />
            )}
            {inp.pensions.map((x, i) => (
              <Line key={i} label={`− ${x.name} (${x.startAge}세~${x.endAge ? `${x.endAge}세` : ''})`} value={won(x.annual / 12)} muted />
            ))}
            <div className="border-t border-line pt-2.5"><Line label={draw ? `자산 인출액(${fullAge}세, 물가 반영 후)` : `자산에서 인출할 금액(${fullAge}세 기준)`} value={won(gapMonthly)} strong /></div>
            {(inp.inflows ?? []).map((x) => (
              <Line key={`${x.name}-${x.age}`} label={x.kind === 'credit' ? `+ 세액공제 환급(${x.age}세)` : x.kind === 'sale' ? `+ ${x.name} 매각(${x.age}세, 비용·보증금·새 집 뺀 금액)` : `+ ${x.name} 수령(${x.age}세, 세후 일시금)`} value={won(x.amount)} muted />
            ))}
            {lateDebts.map((x) => (
              <Line key={x.name} label={`+ ${x.name} 상환 (${Number.isFinite(x.endAge) ? `${x.endAge - 1}세까지` : '종료 없음'})`} value={won(x.annual / 12)} muted />
            ))}
          </div>
          <div className="mt-3 rounded-lg bg-sunken px-3 py-2 text-sm">
            <Line label={`${retired ? '현재' : `은퇴 첫해(${start.age}세)`} 인출률`} value={`${pct(start.rate, 1)} · 상한 ${p.criteria.withdrawRateMax}%`} />
            <div className="mt-0.5 text-xs text-muted">연 {won(start.outflow)} ÷ {retired ? '현재 금융자산' : '평균수익 가정 은퇴 시점 금융자산'} {won(start.balance)} · 노후 인출 화면과 같은 기준</div>
          </div>
          <p className="mt-3 text-xs text-muted">소득 개시 전 기간에는 그만큼 더 자산에서 인출합니다. 인상률을 넣은 소득은 물가보다 덜 오르면 실질 금액이 줄어듭니다.{lateDebts.length > 0 && ' 은퇴 후에도 남는 대출 상환액은 상환이 끝날 때까지 추가로 인출합니다.'}</p>
        </Card>
        <Card title="자산 고갈 시점 분포">
          {sim.depletionHistogram.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">1,000개 시나리오 모두 {p.lifeExpectancy}세까지 자산이 유지되었습니다.</p>
          ) : (
            <div className="h-52">
              <ResponsiveContainer>
                <BarChart data={sim.depletionHistogram.map((h) => ({ ...h, label: h.age >= p.lifeExpectancy ? `${p.lifeExpectancy}세` : `${h.age}~${Math.min(h.age + 4, p.lifeExpectancy)}세`, rate: (h.count / 10) }))} margin={{ left: 0, right: 8, top: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} />
                  <YAxis unit="%" width={40} tickLine={false} axisLine={false} />
                  <Tooltip formatter={(v: number) => [`${v.toFixed(1)}%`, '시나리오 비율']} cursor={{ fill: 'var(--c-sunken)' }} />
                  <RBar dataKey="rate" fill="var(--c-bad)" radius={[6, 6, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>

      <Sensitivity />

      <ExpenseCompare />

      <Card title="시뮬레이션 가정" className="mt-4">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-4">
          <Assume k="시작 금융자산" v={won(inp.startBalance)} />
          <Assume k="연 저축액(은퇴 전)" v={won(inp.annualSavings)} />
          <Assume k={inp.retireMeanReturn === undefined ? '기대수익률 / 변동성' : '은퇴 전 수익률 / 변동성'} v={`${inp.meanReturn.toFixed(1)}% / ${inp.volatility.toFixed(1)}%`} />
          {inp.retireMeanReturn !== undefined && <Assume k="은퇴 후 수익률 / 변동성" v={`${inp.retireMeanReturn.toFixed(1)}% / ${(inp.retireVolatility ?? inp.volatility).toFixed(1)}%`} />}
          {(inp.debts ?? []).map((x) => (
            <Assume
              key={x.name}
              k={`대출 상환 · ${x.name}`}
              v={!Number.isFinite(x.endAge) ? `월 ${won(x.annual / 12)} · 상환 미종료` : x.endAge === inp.retireAge ? `${x.endAge}세(은퇴 시점) 상환 종료` : x.endAge < inp.retireAge ? `${x.endAge}세부터 월 ${won(x.annual / 12)} 저축 증가` : `은퇴 후 ${x.endAge - 1}세까지 월 ${won(x.annual / 12)} 지출`}
            />
          ))}
          <Assume k="물가상승률" v={`${inp.inflation}%`} />
          <Assume k="은퇴 후 생활비" v={expenseNote} />
          {(inp.inflows ?? []).some((x) => !x.kind) && <Assume k="수령 전 자산(시작 자산에서 제외)" v={(inp.inflows ?? []).filter((x) => !x.kind).map((x) => `${x.name} ${x.age}세`).join(' · ')} />}
          <Assume k="목적자금·반복 지출" v={`${d.goals.filter((g) => g.category !== 'retirement').length}건 · 총 ${won(inp.goals.reduce((a, g) => a + g.amount, 0))}`} />
          <Assume k="부동산" v={reNote} />
        </dl>
      </Card>
      <Disclaimer />
    </>
  );
}

function Line({ label, value, muted, strong }: { label: string; value: string; muted?: boolean; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className={muted ? 'text-muted' : ''}>{label}</span>
      <span className={`shrink-0 ${strong ? 'text-base font-bold' : 'font-medium'}`}>{value}</span>
    </div>
  );
}

function Assume({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{k}</dt>
      <dd className="font-medium">{v}</dd>
    </div>
  );
}
