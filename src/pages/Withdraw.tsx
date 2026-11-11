import { useMemo, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Labeled, NumberField, SelectField, Slider } from '../components/fields';
import { Badge, Card, Disclaimer, EmptyState, PageHeader } from '../components/ui';
import { GuardrailCompare, YearEndReview } from '../components/YearEndReview';
import { db } from '../db/db';
import { withdrawLevel } from '../engine/risk';
import { ExpenseCompare } from '../components/ExpenseCompare';
import { IncomeTaxCard } from '../components/IncomeTaxCard';
import { OrderCompare } from '../components/OrderCompare';
import type { CompareBase } from '../engine/orderCompare';
import { OVER_RATE, PENSION_SLOT, pensionTaxSchedule, taxSetup, type TaxResult } from '../engine/tax';
import { compareStrategy, DEFAULT_GUARDRAIL, livingOf, needAt, spendAt, STRATEGIES, type StrategyKey, type WithdrawInput } from '../engine/withdrawal';
import { pct, won, yearRanges } from '../lib/format';
import { useFlp } from '../store/FlpContext';
import type { Level } from '../types';
import { debtAnnualAt, GOAL_KIND_LABEL, goalKind, incomeValue } from '../engine/montecarlo';
import { goalItemsFrom } from '../engine/goals';

type Basis = 'avg' | 'p50' | 'p10' | 'custom';
const basisLabel = (b: Basis, retired: boolean) => (b === 'avg' ? (retired ? '현재 자산' : '평균수익') : b === 'p50' ? '중앙값' : b === 'p10' ? '비관' : '직접');

const KEYS: StrategyKey[] = ['fixed', 'percent', 'bucket', 'guardrail'];
const COLORS: Record<StrategyKey, string> = { fixed: 'var(--chart-3)', percent: 'var(--chart-2)', bucket: 'var(--chart-1)', guardrail: 'var(--chart-4)' };

export default function Withdraw() {
  const d = useFlp();
  if (!d.hasData) return <><PageHeader title="노후 인출" /><EmptyState /></>;
  return <WithdrawInner />;
}

function WithdrawInner() {
  const d = useFlp();
  const { profile: p, sim, planInput, start } = d;
  const retired = start.retired;
  const startAge = start.age;
  // 기본은 평균수익 가정 자산: 투자 점검·노후 진단의 인출률과 같은 기준
  const [basis, setBasis] = useState<Basis>('avg');
  const [custom, setCustom] = useState(Math.round(retired ? planInput.startBalance : sim.balanceAtRetire.p50));
  const [rate, setRate] = useState(4);
  const [band, setBand] = useState(DEFAULT_GUARDRAIL.band * 100);
  const [cut, setCut] = useState(DEFAULT_GUARDRAIL.cut * 100);
  const [cutOnly, setCutOnly] = useState(DEFAULT_GUARDRAIL.cutOnly);
  const [selected, setSelected] = useState<StrategyKey>('guardrail');

  const retMean = planInput.retireMeanReturn ?? planInput.meanReturn;
  const retVol = planInput.retireVolatility ?? planInput.volatility;
  const lateDebts = (planInput.debts ?? []).filter((x) => x.endAge > startAge);
  // 이미 은퇴했으면 지금 금융자산에서 바로 시작
  const startBalance = basis === 'custom' ? custom : basis === 'avg' ? start.balance : sim.balanceAtRetire[basis];
  const input: WithdrawInput = useMemo(
    () => ({
      startAge,
      endAge: p.lifeExpectancy,
      startBalance,
      expenseAnnual: planInput.retireExpenseAnnual,
      expenseGrowth: planInput.expenseGrowth,
      expenseSteps: planInput.expenseSteps,
      fixedDraw: planInput.fixedDraw,
      inflows: planInput.inflows?.filter((x) => x.age >= startAge),
      pensions: planInput.pensions,
      meanReturn: retMean,
      volatility: retVol,
      inflation: p.inflation,
      percentRate: rate,
      debts: lateDebts,
      extras: planInput.goals.filter((g) => g.age >= startAge),
      guardrail: { ...DEFAULT_GUARDRAIL, band: band / 100, cut: cut / 100, raise: cut / 100, cutOnly },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p, startAge, startBalance, planInput, rate, retMean, retVol, band, cut, cutOnly],
  );
  const results = useMemo(() => KEYS.map((k) => compareStrategy(k, input, 1000)), [input]);
  const chart = results[0].ages.map((age, i) => ({ age, ...Object.fromEntries(results.map((r) => [r.key, r.p50[i]])) }));
  const incomeChart = results[0].ages.map((age, i) => ({ age, need: livingOf(input, age) / 12, ...Object.fromEntries(results.map((r) => [r.key, r.medianIncome[i] / 12])) }));
  const sel = results.find((r) => r.key === selected)!;
  const nowYear = p.birthYear + d.summary.age;
  const setup = useMemo(() => taxSetup(p, d.assets, nowYear, startBalance, retMean), [p, d.assets, nowYear, startBalance, retMean]);
  const tax = useMemo(() => (setup ? pensionTaxSchedule(sel.schedule, setup) : null), [setup, sel]);
  const compareBase: CompareBase = useMemo(
    () => ({ profile: p, assets: d.assets, liabilities: d.liabilities, goals: d.goals, summary: d.summary, input, strategy: selected, meanReturn: retMean }),
    [p, d.assets, d.liabilities, d.goals, d.summary, input, selected, retMean],
  );
  const hasSpouse = p.spouseBirthYear > 0;
  const hasInflow = sel.schedule.some((r) => r.inflow > 0);
  const hasIsa = !!tax && tax.rows.some((r) => r.reinvest > 0.5 || r.contrib > 0.5);
  const lvl = (v: number): Level => (v >= p.criteria.successTarget ? 'good' : v >= 60 ? 'caution' : 'danger');
  const saveProfile = (patch: Partial<typeof p>) => db.profile.put({ ...p, ...patch });

  const firstNeed = needAt(input, startAge);
  // 첫해 소득 − 필요 지출(생활비 + 남은 대출 + 목적자금·보험료) = 수지, 모자라는 만큼 자산에서 인출
  const firstIncome = input.pensions.reduce((a, x) => a + incomeValue(x, startAge, input.inflation), 0);
  const firstSpend = spendAt(input, startAge);
  const wRate = startBalance > 0 ? (firstNeed / startBalance) * 100 : 0;
  const wLevel = withdrawLevel(wRate, p.criteria.withdrawRateMax);
  const others = planInput.pensions.filter((x) => x.name !== '국민연금' && x.name !== '개인·퇴직연금');
  // 만기일시 대출 원금 상환은 재무목표 지출과 나눠 보여 줌
  const loanRepays = planInput.goals.filter((g) => g.loan && g.age >= startAge);
  const premiums = planInput.goals.filter((g) => g.premium && g.age >= startAge);
  const extras = planInput.goals.filter((g) => goalKind(g) === 'goal' && g.age >= startAge);
  const npTaxes = planInput.goals.filter((g) => goalKind(g) === 'npTax' && g.age >= startAge);
  const loanAt = (age: number) => loanRepays.filter((g) => g.age === age);
  const premiumAt = (age: number) => premiums.filter((g) => g.age === age).reduce((a, g) => a + g.amount, 0);
  const extraAt = (age: number) => extras.filter((g) => g.age === age).reduce((a, g) => a + g.amount, 0);
  const npTaxAt = (age: number) => npTaxes.filter((g) => g.age === age).reduce((a, g) => a + g.amount, 0);
  // 보험별 은퇴 후 납입 기간
  const premiumNames = [...new Set(premiums.map((g) => g.premium!))].map((name) => {
    const ages = premiums.filter((g) => g.premium === name).map((g) => g.age);
    return `${name} ${Math.min(...ages)}~${Math.max(...ages)}세`;
  });

  return (
    <>
      <PageHeader title="노후 인출" desc="은퇴 후 자산을 어떤 방식으로 꺼내 쓸지 전략별로 비교합니다. 금액은 현재 물가 기준입니다." />

      <Card title="인출 조건" action={retired && <Badge level="good">{startAge}세 · 인출 중</Badge>}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Labeled label={retired ? '현재 금융자산(인출 시작)' : '은퇴 시점 자산 가정'}>
            <div className="flex rounded-lg bg-sunken p-0.5 text-xs">
              {(retired ? (['avg', 'custom'] as const) : (['avg', 'p50', 'p10', 'custom'] as const)).map((b) => (
                <button key={b} onClick={() => setBasis(b)} className={`flex-1 whitespace-nowrap rounded-md px-2 py-1.5 font-medium ${basis === b ? 'bg-surface shadow-sm' : 'text-muted'}`}>
                  {basisLabel(b, retired)}
                </button>
              ))}
            </div>
            <div className="mt-1.5">{basis === 'custom' ? <NumberField value={custom} unit="만원" onChange={setCustom} /> : <div className="text-lg font-bold">{won(startBalance)}</div>}</div>
          </Labeled>
          <Labeled label="국민연금 월액 · 개시 나이">
            <div className="grid grid-cols-2 gap-2">
              <NumberField value={p.nationalPension} unit="만원" onChange={(v) => saveProfile({ nationalPension: v })} />
              <NumberField value={p.nationalPensionAge} unit="세" onChange={(v) => saveProfile({ nationalPensionAge: v })} />
            </div>
          </Labeled>
          <Labeled label="개인·퇴직연금 월액 · 개시 나이">
            <div className="grid grid-cols-2 gap-2">
              <NumberField value={p.privatePension} unit="만원" onChange={(v) => saveProfile({ privatePension: v })} />
              <NumberField value={p.privatePensionAge} unit="세" onChange={(v) => saveProfile({ privatePensionAge: v })} />
            </div>
          </Labeled>
          <div className="self-end">
            <Slider label="정률 인출 비율" value={rate} min={2} max={8} step={0.5} display={`${rate}%`} onChange={setRate} />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-1 rounded-xl bg-sunken px-3 py-2.5 text-sm">
          <span>
            {startAge}세 월 소득 <b>{won(firstIncome / 12)}</b> − 필요 지출 <b>{won(firstSpend / 12)}</b> = 수지 <b className={firstIncome - firstSpend < -0.5 ? 'text-bad' : 'text-good'}>{firstIncome - firstSpend < -0.5 ? `− ${won((firstSpend - firstIncome) / 12)}` : won((firstIncome - firstSpend) / 12)}</b>
            {firstNeed > 0.5 && <> → 부족분은 금융자산에서 인출 <b>{won(firstNeed / 12)}</b>/월</>}
          </span>
          <span>인출률 <b className={wLevel === 'good' ? 'text-good' : wLevel === 'caution' ? 'text-warn' : 'text-bad'}>{pct(wRate, 1)}</b> <span className="text-xs text-muted">(상한 {p.criteria.withdrawRateMax}% · {((p.criteria.withdrawRateMax * 2) / 3).toFixed(0)}% 이하 권장)</span></span>
          <span className="text-xs text-muted">{basis === 'avg' ? (retired ? '현재 금융자산 기준 · 노후 진단·투자 점검과 같은 값' : '평균수익 가정 은퇴 시점 자산 기준 · 노후 진단·투자 점검과 같은 값') : basis === 'custom' ? '직접 넣은 자산 기준' : `시뮬레이션 ${basis === 'p50' ? '중앙값' : '하위 10%'} 자산 기준 · 노후 진단의 인출률(평균수익 가정)과 다를 수 있음`}</span>
        </div>

        <p className="mt-3 text-xs text-muted">
          {retired ? `이미 은퇴 나이(${p.retireAge}세)가 지나 현재 ${startAge}세부터 인출합니다` : `은퇴 ${p.retireAge}세부터 인출`} · 월 생활비 {won(p.retireMonthlyExpense)}{planInput.expenseSteps?.length ? '(나이 구간별로 바뀜)' : ''} · 은퇴 후 기대수익률 {retMean.toFixed(1)}% / 변동성 {retVol.toFixed(1)}%{planInput.retireMeanReturn === undefined && ' (은퇴 전과 같음)'} (‘데이터·설정 → 프로필’에서 변경)
        </p>
        {others.length > 0 && (
          <p className="mt-1 text-xs text-muted">
            그 밖의 소득: {others.map((x) => `${x.name} 월 ${won((x.growth === 0 ? incomeValue(x, x.startAge, planInput.inflation) : x.annual) / 12)}(${x.startAge}세~${x.endAge ? `${x.endAge}세` : ''}${x.growth === 0 ? ', 명목 고정' : x.growth !== undefined ? `, ${x.step ?? 1}년마다 ${x.growth}% 인상` : ''})`).join(', ')}
          </p>
        )}
        {extras.length > 0 && (
          <p className="mt-1 text-xs text-muted">은퇴 후 {GOAL_KIND_LABEL.goal}(목적자금·반복 지출) {goalItemsFrom(d.goals, startAge).length}건(합계 {won(extras.reduce((a, e) => a + e.amount, 0))})을 해당 연도 인출액에 더했습니다(스케줄의 ‘{GOAL_KIND_LABEL.goal}’ 표시).</p>
        )}
        {loanRepays.length > 0 && (
          <p className="mt-1 text-xs text-warn">{GOAL_KIND_LABEL.loan} 상환 {loanRepays.map((g) => `${g.loan} ${g.age}세 ${won(g.amount)}`).join(', ')}을 그 해 인출액에 더했습니다(스케줄의 ‘{GOAL_KIND_LABEL.loan}’ 표시).</p>
        )}
        {premiums.length > 0 && (
          <p className="mt-1 text-xs text-warn">{GOAL_KIND_LABEL.premium} {premiumNames.join(', ')}(합계 {won(premiums.reduce((a, g) => a + g.amount, 0))}, 명목 고정이라 실질로는 해마다 줄어듦)를 그 해 인출액에 더했습니다(스케줄의 ‘{GOAL_KIND_LABEL.premium}’ 표시).</p>
        )}
        {npTaxes.length > 0 && (
          <p className="mt-1 text-xs text-muted">{GOAL_KIND_LABEL.npTax} {npTaxes[0].age}~{npTaxes[npTaxes.length - 1].age}세(합계 {won(npTaxes.reduce((a, g) => a + g.amount, 0))})를 그 해 인출액에 더했습니다(프로필 종합소득세의 ‘인출에 더하기’ 설정 · 스케줄의 ‘{GOAL_KIND_LABEL.npTax}’ 표시).</p>
        )}
        {lateDebts.length > 0 && (
          <p className="mt-1 text-xs text-warn">은퇴 후에도 남는 대출 상환 {lateDebts.map((x) => `${x.name} 월 ${won(debtAnnualAt(x, startAge) / 12)}${x.decline ? '부터 점점 줄어듦' : ''}(${Number.isFinite(x.endAge) ? `${x.endAge - 1}세까지` : '상환 미종료'})`).join(', ')}을 인출액에 포함했습니다.</p>
        )}
      </Card>

      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {results.map((r) => (
          <button key={r.key} onClick={() => setSelected(r.key)} className={`rounded-2xl border bg-surface p-4 text-left transition sm:p-5 ${selected === r.key ? 'border-brand ring-2 ring-brand-soft' : 'border-line hover:border-muted'}`}>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-[15px] font-semibold">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLORS[r.key] }} />
                {STRATEGIES[r.key].label}{r.key === 'percent' && ` ${rate}%`}
              </span>
              <Badge level={lvl(r.successRate)} />
            </div>
            <div className="mt-3 text-3xl font-extrabold tracking-tight">{pct(r.successRate)}</div>
            <div className="text-xs text-muted">생활비 90% 이상 매년 충족 확률</div>
            <div className="mt-2 text-xs">자산 유지 확률 <b>{pct(100 - r.depletionRate)}</b> · 고갈 나이 중앙값 <b>{r.medianDepletionAge === null ? `${p.lifeExpectancy}세까지 유지` : `${r.medianDepletionAge}세`}</b></div>
            <div className="text-xs">첫해 인출 <b>{won(r.schedule[0]?.withdrawal ?? 0)}</b>{r.depletedMedianAge !== null && <> · 고갈 경로 중앙 <b>{r.depletedMedianAge}세</b></>}</div>
            {r.key === 'guardrail' && (
              <div className="mt-1 text-xs">감액 발생 <b>{pct(r.adjustRate)}</b> · 나쁜 10% 경로 최저 <b>{Math.round(r.minMultiplier * 100)}%</b>까지 감액</div>
            )}
            <p className="mt-2 text-xs leading-relaxed text-muted">{STRATEGIES[r.key].desc}</p>
          </button>
        ))}
      </div>

      {selected === 'guardrail' && (
        <Card title="가드레일 설정" className="mt-4">
          <div className="grid gap-4 md:grid-cols-3">
            <Slider label="기준선에서 벗어나는 폭" value={band} min={5} max={30} step={1} display={`±${band}%`} onChange={setBand} />
            <Slider label="한 번에 줄이는(되돌리는) 비율" value={cut} min={5} max={20} step={1} display={`${cut}%`} onChange={setCut} />
            <Labeled label="조정 방식">
              <SelectField value={cutOnly ? 'cut' : 'both'} onChange={(v) => setCutOnly(v === 'cut')} options={{ cut: '감액만(계획보다 늘리지 않음)', both: '감액·증액(최고 130%)' }} />
            </Labeled>
          </div>
          <p className="mt-3 text-xs text-muted">
            기준선은 평균수익으로 정액 인출했을 때의 연초 자산입니다. 매년 초 자산이 기준선보다 {band}% 넘게 적으면 그해 인출을 직전보다 {cut}% 줄이고(계획의 {DEFAULT_GUARDRAIL.floor * 100}% 아래로는 내리지 않음), {band}% 넘게 많으면 {cut}%씩 {cutOnly ? '줄였던 만큼만 되돌립니다' : `늘립니다(계획의 ${DEFAULT_GUARDRAIL.ceil * 100}%까지)`}. 판정은 1년에 한 번만 합니다.
          </p>
          <GuardrailCompare fixed={results[0]} guard={sel} lifeExpectancy={p.lifeExpectancy} />
        </Card>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="전략별 잔액 (중앙값)">
          <div className="h-64">
            <ResponsiveContainer>
              <LineChart data={chart} margin={{ left: 0, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="age" unit="세" tickLine={false} axisLine={false} minTickGap={16} />
                <YAxis tickFormatter={(v) => won(v, false)} width={56} tickLine={false} axisLine={false} />
                <Tooltip labelFormatter={(a) => `${a}세`} formatter={(v: number) => won(v)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {KEYS.map((k) => <Line key={k} dataKey={k} name={STRATEGIES[k].label} stroke={COLORS[k]} strokeWidth={k === selected ? 2.5 : 1.5} dot={false} isAnimationActive={false} />)}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title="월 소득 (연금 + 인출, 중앙값)">
          <div className="h-64">
            <ResponsiveContainer>
              <LineChart data={incomeChart} margin={{ left: 0, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="age" unit="세" tickLine={false} axisLine={false} minTickGap={16} />
                <YAxis tickFormatter={(v) => won(v, false)} width={56} tickLine={false} axisLine={false} />
                <Tooltip labelFormatter={(a) => `${a}세`} formatter={(v: number) => won(v)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line dataKey="need" name="목표 생활비" stroke="var(--c-muted)" strokeDasharray="4 4" dot={false} isAnimationActive={false} />
                {KEYS.map((k) => <Line key={k} dataKey={k} name={STRATEGIES[k].label} stroke={COLORS[k]} strokeWidth={k === selected ? 2.5 : 1.5} dot={false} isAnimationActive={false} />)}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <ExpenseCompare />

      <YearEndReview input={{ ...input, startBalance: start.balance }} startAge={startAge} band={band / 100} cut={cut / 100} cutOnly={cutOnly} />

      <BucketGuide firstNeed={firstNeed} balance={startBalance} />

      {tax && setup && <TaxSummary tax={tax} scheduleDepleted={sel.schedule.find((r) => r.endBalance <= 0 && r.withdrawal > 0)?.age ?? null} hasSpouse={hasSpouse} retireBase={setup.retireBase} />}
      {tax && setup && <OrderCompare base={compareBase} tax={tax} setup={setup} />}
      {p.incomeTax?.on && <IncomeTaxCard tax={tax} />}

      <Card title={`연도별 인출 스케줄 — ${STRATEGIES[selected].label}`} className="mt-4" action={<span className="text-xs text-muted">평균수익 가정 · 연 단위</span>}>
        <div className="-mx-4 max-h-[420px] overflow-auto px-4 sm:-mx-5 sm:px-5">
          <table className={`w-full text-sm num-table ${tax ? 'min-w-[900px]' : 'min-w-[560px]'}`}>
            <thead className="sticky top-0 bg-surface">
              <tr className="border-b border-line text-right text-xs text-muted">
                <th className="py-2 text-left font-medium">나이</th>
                <th className="font-medium">소득<div className="font-normal">연금·월세 등</div></th>
                <th className="font-medium">필요 지출<div className="font-normal">생활비·대출·목표</div></th>
                <th className="font-medium">수지<div className="font-normal">소득 − 지출</div></th>
                <th className="font-medium">→ 자산 인출{tax ? '(세후)' : ''}<div className="font-normal">금융자산에서</div></th>
                {tax && <th className="font-medium">세금</th>}
                {tax && <th className="font-medium">세전 인출</th>}
                {hasIsa && <th className="font-medium">ISA 재투자<div className="font-normal">납입 · 연말 잔액</div></th>}
                {tax && <th className="font-medium">1,500만 한도{hasSpouse ? ' 본인/배우자' : ''}<div className="font-normal">명목</div></th>}
                {hasInflow && <th className="font-medium">일시금·매각·환급<div className="font-normal">자산에 더함</div></th>}
                <th className="font-medium">쓸 수 있는 돈<div className="font-normal">소득 + 인출</div></th>
                <th className="font-medium">연말 잔액</th>
              </tr>
            </thead>
            <tbody>
              {sel.schedule.map((r, i) => {
                const t = tax?.rows[i];
                const slotOver = t ? t.over.self + t.over.spouse > 0.5 : false;
                const limitOver = t ? t.limitOver > 0.5 : false;
                const over = slotOver || limitOver;
                const slotCell = (o: 'self' | 'spouse') => (
                  <span className={t && t.over[o] > 0.5 ? 'font-semibold text-bad' : ''}>{t ? won(t.slot[o] + t.over[o], false) : '-'}</span>
                );
                return (
                <tr key={r.age} className={`border-b border-line text-right last:border-0 ${r.income < r.need * 0.9 ? 'text-bad' : over ? 'bg-warn-soft' : ''}`}>
                  <td className="py-1.5 text-left font-medium">{r.age}세{t && <span className="ml-1 text-xs font-normal text-muted">{t.year}</span>}</td>
                  <td>{won(r.pension)}</td>
                  <td className="whitespace-nowrap text-muted">
                    − {won(r.need)}
                    {loanAt(r.age).map((g) => (
                      <div key={g.loan} className="text-xs font-semibold text-warn">{GOAL_KIND_LABEL.loan} {won(g.amount)}</div>
                    ))}
                    {extraAt(r.age) > 0.5 && <div className="text-xs text-muted">{GOAL_KIND_LABEL.goal} {won(extraAt(r.age))}</div>}
                    {premiumAt(r.age) > 0 && <div className="text-xs text-muted">{GOAL_KIND_LABEL.premium} {won(premiumAt(r.age))}</div>}
                    {npTaxAt(r.age) > 0.5 && <div className="text-xs text-muted">{GOAL_KIND_LABEL.npTax} {won(npTaxAt(r.age))}</div>}
                  </td>
                  <td className="whitespace-nowrap">{r.pension - r.need < -0.5 ? `− ${won(r.need - r.pension)}` : won(r.pension - r.need)}</td>
                  <td className="font-semibold">{won(r.withdrawal)}</td>
                  {t && <td className="text-muted">{won(t.tax)}</td>}
                  {t && <td>{won(t.gross)}{t.short > 0.5 && <span className="ml-1 text-xs text-bad">부족 {won(t.short)}</span>}</td>}
                  {hasIsa && t && (
                    <td className="whitespace-nowrap">
                      {t.reinvest > 0.5 ? won(t.reinvest) : ''}
                      <div className="text-xs text-muted">{t.contrib > 0.5 ? `납입 ${won(t.contrib)} · ` : ''}{won(t.isa)}</div>
                    </td>
                  )}
                  {t && <td className="whitespace-nowrap">{slotCell('self')}{hasSpouse && <> / {slotCell('spouse')}</>}{slotOver && <span className="ml-1 text-xs font-semibold text-bad">초과</span>}{limitOver && <span className="ml-1 text-xs font-semibold text-bad">수령한도↑</span>}</td>}
                  {hasInflow && <td>{r.inflow > 0 ? `+ ${won(r.inflow)}` : ''}</td>}
                  <td>{won(r.income)}</td>
                  <td>{won(r.endBalance)}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted">
          한 해씩 소득 − 필요 지출(생활비 + 남은 대출 상환 + 목표 탭 지출 + 만기일시 대출 원금 + 은퇴 후 보험료 + 국민연금 몫 세금·건보료) = 수지이고, 모자라는 만큼 금융자산에서 인출합니다. 정률·가드레일 전략은 인출액이 부족분과 다를 수 있습니다. 일시금·매각·환급은 쓰지 않고 자산에 더합니다. 빨간 행은 쓸 수 있는 돈(소득 + 인출)이 필요 지출의 90%에 못 미치는 해입니다. 필요 지출 아래 작은 글씨는 그 가운데 목표 탭 지출, 만기에 한 번에 갚는 대출 원금, 은퇴 뒤까지 내는 보험료, 국민연금 때문에 늘어나는 세금·건보료입니다.
          {tax && ` 노란 행은 과세재원 인출이 1인 연 ${PENSION_SLOT.toLocaleString()}만원(세전, 명목)을 넘어 초과분에 ${OVER_RATE}% 분리과세가 붙거나, 계좌별 연금수령한도를 넘어 연금외수령이 생기는(‘수령한도↑’) 해입니다. 한도 열은 그 해 과세재원 인출액(만원, 명목)입니다. 세금·세전 인출은 오늘 물가 기준입니다.`}
        </p>
      </Card>
      <Disclaimer />
    </>
  );
}

/** 연금 세금 점검: 세전 인출액·세금·1,500만 한도 초과 연도 */
function TaxSummary({ tax, scheduleDepleted, hasSpouse, retireBase }: { tax: TaxResult; scheduleDepleted: number | null; hasSpouse: boolean; retireBase: number }) {
  const first = tax.rows[0];
  const eff = first && first.gross > 0 ? (first.tax / first.gross) * 100 : 0;
  const overRows = tax.rows.filter((r) => r.over.self + r.over.spouse > 0.5);
  const ranges = yearRanges(tax.overYears);
  const reinvest = tax.rows.reduce((a, r) => a + r.reinvest, 0);
  const contrib = tax.rows.reduce((a, r) => a + r.contrib, 0);
  return (
    <Card
      title="연금 세금 점검"
      className="mt-4"
      action={
        tax.limitWarnings.length > 0 ? <Badge level="danger">수령한도 초과 {tax.limitWarnings.length}개 계좌</Badge>
        : overRows.length > 0 ? <Badge level="caution">한도 초과 {overRows.length}개 연도</Badge>
        : <Badge level="good">한도 안</Badge>
      }
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-xl bg-sunken p-3">
          <div className="text-xs text-muted">첫해 세전 인출 · 세금</div>
          <div className="mt-0.5 text-lg font-bold">{won(first?.gross ?? 0)}</div>
          <div className="text-xs text-muted">세금 {won(first?.tax ?? 0)} · 실효 {eff.toFixed(1)}%</div>
        </div>
        <div className="rounded-xl bg-sunken p-3">
          <div className="text-xs text-muted">계획 기간 세금 합계</div>
          <div className="mt-0.5 text-lg font-bold">{won(tax.totalTax)}</div>
          <div className="text-xs text-muted">오늘 물가 기준</div>
        </div>
        <div className="rounded-xl bg-sunken p-3">
          <div className="text-xs text-muted">1,500만 한도 초과</div>
          <div className={`mt-0.5 text-lg font-bold ${overRows.length ? 'text-warn' : 'text-good'}`}>{overRows.length ? ranges : '없음'}</div>
          <div className="text-xs text-muted">{overRows.length ? `초과분 ${OVER_RATE}% 분리과세(또는 종합과세)` : '과세재원 인출이 매년 1인 한도 안'}</div>
        </div>
        <div className="rounded-xl bg-sunken p-3">
          <div className="text-xs text-muted">세금 반영 시 자산 고갈</div>
          <div className={`mt-0.5 text-lg font-bold ${tax.depletedAge ? 'text-bad' : 'text-good'}`}>{tax.depletedAge ? `${tax.depletedAge}세` : '유지'}</div>
          <div className="text-xs text-muted">세금 빼고 계산하면 {scheduleDepleted ? `${scheduleDepleted + 1}세` : '유지'}</div>
        </div>
      </div>
      {tax.limitWarnings.length > 0 && (
        <div className="mt-3 rounded-xl border border-bad/40 bg-bad-soft p-3 text-sm">
          <div className="font-semibold text-bad">연금수령한도를 넘는 계좌가 있습니다</div>
          <ul className="mt-1 space-y-0.5">
            {tax.limitWarnings.map((w) => (
              <li key={w.name}>
                {w.name}{hasSpouse ? ` (${w.owner === 'spouse' ? '배우자' : '본인'})` : ''}: {yearRanges(w.years)} — 한도를 넘는 금액이 해마다 최대 {won(w.maxOver)}(명목)
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-muted">넘는 금액은 연금외수령이라 과세재원은 {OVER_RATE}%, 퇴직금 재원은 퇴직소득세 {retireBase}% 전액이 붙습니다. 한도에 여유가 있는 다른 계좌에서 먼저 꺼내거나, 인출을 다음 해로 나누면 피할 수 있습니다.</p>
        </div>
      )}
      {first && first.accounts.length > 0 && <AccountLimits row={first} hasSpouse={hasSpouse} />}
      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">
        <li>
          꺼내는 순서(계좌별 연금수령한도 안에서): 과세제외 원금 → 과세재원(1인 연 {PENSION_SLOT.toLocaleString()}만원까지 연금소득세 5.5%·70대 4.4%·80세 이상 3.3%) → 퇴직금 재원(퇴직소득세 {retireBase}%의 70%, 11년차부터 60%) → 연금계좌 밖 자산 → 과세재원 1,500만 초과분({OVER_RATE}%) → 그래도 모자라면 연금수령한도를 넘겨 꺼냄(연금외수령). 같은 사람 계좌는 ‘꺼내는 순서’대로, ‘인출 시작 연도’ 전 계좌는 꺼내지 않습니다.
          {hasSpouse && ' 배우자 연금계좌는 배우자가 55세가 된 해부터 꺼냅니다.'}
        </li>
        <li>자산 인출(세후)이 생활비로 쓰는 돈이고, 세금만큼 더 꺼내야 합니다. 성공확률·전략 비교는 세금을 빼고 계산한 값이니 이 카드의 ‘세금 반영 시 자산 고갈’과 함께 보세요.</li>
        {(reinvest > 0.5 || contrib > 0.5) && (
          <li>
            {reinvest > 0.5 && `1,500만 한도를 채우려고 더 꺼내 ISA·일반계좌로 옮긴 세후 금액은 계획 기간 합계 ${won(reinvest)}입니다(오늘 물가). `}
            {contrib > 0.5 && `연금계좌 추가 납입은 합계 ${won(contrib)}이고, 세액공제 환급은 다음 해 ‘일시금·환급’으로 들어옵니다.`}
          </li>
        )}
        <li>국민연금·임대소득에 붙는 종합소득세·건강보험료는 ‘종합소득세·건강보험료’ 카드에서 따로 추정합니다(데이터·설정 → 프로필에서 켬).</li>
      </ul>
    </Card>
  );
}

/** 첫해 계좌별 연금수령연차·한도·인출액(명목) */
function AccountLimits({ row, hasSpouse }: { row: TaxResult['rows'][number]; hasSpouse: boolean }) {
  return (
    <div className="mt-3">
      <div className="mb-1 text-xs font-medium text-muted">{row.year}년 계좌별 연금수령한도 (명목)</div>
      <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
        <table className="w-full min-w-[480px] text-sm num-table">
          <thead>
            <tr className="border-b border-line text-right text-xs text-muted">
              <th className="py-1.5 text-left font-medium">계좌</th>
              <th className="font-medium">연차</th>
              <th className="font-medium">수령한도</th>
              <th className="font-medium">세전 인출</th>
              <th className="font-medium">여유</th>
            </tr>
          </thead>
          <tbody>
            {row.accounts.map((a) => {
              const closed = a.yearNo < 1 || (a.limit === 0 && a.drawn === 0);
              return (
                <tr key={a.name} className={`border-b border-line text-right last:border-0 ${a.over > 0.5 ? 'text-bad' : ''}`}>
                  <td className="py-1.5 text-left">{a.name}{hasSpouse && <span className="ml-1 text-xs text-muted">{a.owner === 'spouse' ? '배우자' : '본인'}</span>}</td>
                  <td>{a.yearNo >= 1 ? `${a.yearNo}년차` : '수령 전'}</td>
                  <td>{closed ? '-' : a.limit === Infinity ? '한도 없음' : won(a.limit)}</td>
                  <td>{won(a.drawn)}</td>
                  <td>{closed ? '-' : a.limit === Infinity ? '-' : a.over > 0.5 ? `초과 ${won(a.over)}` : won(a.limit - a.drawn)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** [2031, 2032, 2033, 2040] → "2031~2033, 2040년" */
/** 인출용 자산 배치 가이드: 현금성 2년 · 채권·배당 3~5년차 · 대체 10% · 나머지 성장 */
function BucketGuide({ firstNeed, balance }: { firstNeed: number; balance: number }) {
  const cash = Math.min(balance, firstNeed * 2);
  const bond = Math.min(balance - cash, firstNeed * 3);
  const alt = Math.max(0, Math.min(balance - cash - bond, balance * 0.1));
  const growth = Math.max(0, balance - cash - bond - alt);
  const rows = [
    { label: '현금성(MMF·예금)', amount: cash, note: '1~2년차 인출분. 매달 여기서 꺼내 씀' },
    { label: '채권·배당', amount: bond, note: '3~5년차 인출분. 현금이 줄면 여기서 채움' },
    { label: '대체자산(금·리츠 등)', amount: alt, note: '전체의 약 10%. 주식과 다르게 움직이는 완충재' },
    { label: '성장자산(주식형)', amount: growth, note: '6년차 이후 몫. 오른 해에 일부 팔아 앞 바구니를 채움' },
  ];
  return (
    <Card title="인출용 자산 배치 가이드" className="mt-4" action={<span className="text-xs text-muted">첫해 인출 {won(firstNeed)} 기준</span>}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map((r) => (
          <div key={r.label} className="rounded-xl bg-sunken p-3">
            <div className="text-xs text-muted">{r.label}</div>
            <div className="mt-0.5 text-lg font-bold">{won(r.amount)}</div>
            <div className="text-xs text-muted">{balance > 0 ? pct((r.amount / balance) * 100) : '-'} · {r.note}</div>
          </div>
        ))}
      </div>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">
        <li>주식이 고점보다 15% 넘게 떨어진 해에는 주식을 팔지 말고 현금성·채권에서만 꺼내 씁니다.</li>
        <li>퇴직연금(DC·IRP)은 위험자산을 70%까지만 담을 수 있으니, 성장자산은 연금저축·일반 계좌에 나눠 둡니다.</li>
        <li>1년에 한 번(예: 1월) 바구니 비율을 점검하고, 가드레일을 쓴다면 같은 날 인출액도 함께 조정합니다.</li>
      </ul>
    </Card>
  );
}
