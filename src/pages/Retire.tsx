import { useMemo } from 'react';
import { Bar as RBar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ExpenseCompare } from '../components/ExpenseCompare';
import { GuardrailCompare } from '../components/GuardrailCompare';
import { LifeChart } from '../components/LifeChart';
import { Sensitivity } from '../components/Sensitivity';
import { debtAnnualAt, expenseAt, expenseRatioAt, GOAL_KIND_LABEL, goalBreakdownAt, goalKind, guardrailSim, incomeValue, nominalFactor } from '../engine/montecarlo';
import { withdrawLevel } from '../engine/risk';
import { goalItemsFrom, loanEndAge, loanSchedule } from '../engine/goals';
import { hpEstate, housePension, RE_USE, reUseOf, usesHp, willSell } from '../engine/realestate';
import { Bar, Card, Disclaimer, EmptyState, PageHeader, Stat } from '../components/ui';
import { pct, won } from '../lib/format';
import { useFlp } from '../store/FlpContext';
import type { Insurance, Level, Liability, Profile } from '../types';
import { INSURED_WHO } from '../db/schema';
import { payEndSelfAge } from '../engine/portfolio';

export default function Retire() {
  const d = useFlp();
  // 하락장 가드레일 중앙값(비교 카드와 같은 결과를 함께 씀)
  const { guardrailDrop: gDrop, guardrailCut: gCut } = d.profile.criteria;
  const gsim = useMemo(() => (d.hasData && gDrop > 0 && gCut > 0 ? guardrailSim(d.planInput, { drop: gDrop, cut: gCut }) : null), [d.hasData, d.planInput, gDrop, gCut]);
  if (!d.hasData) return <><PageHeader title="노후 진단" /><EmptyState /></>;
  const { sim, need, planInput: inp, profile: p, start } = d;
  const retired = start.retired;
  const target = p.criteria.successTarget;
  const level: Level = sim.successRate >= target ? 'good' : sim.successRate >= 60 ? 'caution' : 'danger';
  const failRate = 100 - sim.successRate;
  // 모든 소득이 개시된 나이 기준 자산 인출액
  const fullAge = Math.max(start.age, ...inp.pensions.map((x) => x.startAge));
  const draw = inp.fixedDraw !== undefined;
  // 소득 − 지출 = 월 수지(fullAge 기준, 현재가치). 인출액 고정이면 고정액에서 국민·개인연금만 빼고 나머지는 연금계좌 등 금융자산에서 인출
  // 인출액 고정 방식은 노후 인출과 같이 생활비 = 국민·개인연금과 고정 인출액 중 큰 쪽 + 그 밖의 소득(월세 등, 받는 만큼 더 씀)
  const incomeRows = inp.pensions
    .map((x) => ({ x, monthly: incomeValue({ ...x, firstShare: undefined }, fullAge, inp.inflation) / 12 }))
    .filter((r) => r.monthly > 0.5);
  const incomeMonthly = incomeRows.reduce((a, r) => a + r.monthly, 0);
  const publicMonthly = incomeRows.filter((r) => r.x.kind === 'pension').reduce((a, r) => a + r.monthly, 0);
  const otherIncomeMonthly = incomeMonthly - publicMonthly;
  const drawMonthly = ((inp.fixedDraw ?? 0) * nominalFactor(0, inp.inflation, fullAge - Math.max(inp.currentAge, inp.retireAge))) / 12;
  const livingMonthly = draw ? Math.max(drawMonthly, publicMonthly) : expenseAt(inp, fullAge) / 12;
  const balanceMonthly = incomeMonthly - livingMonthly - (draw ? otherIncomeMonthly : 0);
  const gapMonthly = Math.max(0, -balanceMonthly);
  // 그 해 지출을 홈 카드와 같은 종류로 나눔(보험료는 아래에서 보험별로 따로 보여 줌)
  const fullBy = goalBreakdownAt(inp, fullAge);
  const extraRows = (['goal', 'loan', 'npTax'] as const).map((k) => ({ key: k, label: `− ${GOAL_KIND_LABEL[k]} (${fullAge}세 그 해, 월 환산)`, monthly: fullBy[k] / 12 })).filter((x) => x.monthly > 0.5);
  const expenseNote = draw ? `연금 생활비 명목 고정(월 ${won((inp.fixedDraw ?? 0) / 12)})` : inp.expenseGrowth !== undefined ? `생활비 명목 ${inp.expenseGrowth}% 증가` : '물가 연동';
  const wLevel = withdrawLevel(start.rate, p.criteria.withdrawRateMax);
  const lateDebts = (inp.debts ?? []).filter((x) => x.endAge > inp.retireAge);
  // 은퇴 뒤까지 내는 보험료: 보험별 첫해 금액(실질)과 마지막 납입 나이
  const premiumRows = inp.goals.filter((g) => g.premium);
  const premiums = [...new Set(premiumRows.map((g) => g.premium!))].map((name) => {
    const rows = premiumRows.filter((g) => g.premium === name);
    return { name, first: rows[0], last: rows[rows.length - 1].age, total: rows.reduce((a, g) => a + g.amount, 0) };
  });
  const goalRows = inp.goals.filter((g) => goalKind(g) === 'goal');
  const npTaxRows = inp.goals.filter((g) => goalKind(g) === 'npTax');
  // 나이 구간별 생활비: 은퇴 이후에 시작하는 구간만 표시
  const steps = draw ? [] : (inp.expenseSteps ?? []).filter((x) => x.fromAge > inp.retireAge && x.fromAge <= p.lifeExpectancy);
  // 은퇴 전 저축 변화: 보험 납입 완료·배우자 은퇴(저축 증감)와 은퇴 전에 끝나는 대출 상환
  const preChanges = retired
    ? []
    : [
        ...(inp.savingsChanges ?? []).filter((x) => x.fromAge > inp.currentAge && x.fromAge < inp.retireAge).map((x) => ({ age: x.fromAge, label: changeLabel(x.name ?? '', x.fromAge, d.insurance, p), monthly: x.annual / 12 })),
        ...(inp.debts ?? [])
          .filter((x) => x.endAge > inp.currentAge && x.endAge < inp.retireAge && !x.bullet)
          .map((x) => ({ age: x.endAge, label: `${x.name ?? '대출'} 상환 완료 (본인 ${x.endAge}세)`, monthly: debtAnnualAt(x, x.endAge - 1) / 12 })),
      ].sort((a, b) => a.age - b.age);
  // 부동산: 보유 중엔 운용자산에서 빼고, 임대 월세는 소득, 매각 예정이면 매각 연도에 순매각대금 유입
  const nowYear = p.birthYear + d.summary.age;
  const re = d.assets.filter((a) => a.type === 'realestate');
  const reNote =
    re.length === 0
      ? '없음'
      : re.map((a) => `${a.name}(${RE_USE[reUseOf(a)]}${usesHp(a) ? ` · ${a.hpAge}세 주택연금` : willSell(a, nowYear) ? ` · ${a.lockYear}년 매각` : ''}${reUseOf(a) === 'rental' && (a.rent ?? 0) > 0 ? ' · 월세 소득' : ''})`).join(' · ') + ' — 보유 중엔 시뮬레이션 제외';
  // 주택연금: 기대수명 때 대출 잔액을 빼고 상속으로 남는 주택 가치(참고 · 순자산·부채에는 넣지 않음)
  const hpNote = re.filter((a) => usesHp(a) && housePension(a, p, d.summary.age).eligible).map((a) => { const e = hpEstate(a, p, d.summary.age); return `${a.name} ${won(e.left)}(현재가치 ${won(e.leftReal)}, ${e.age}세 · 시세 ${won(e.price)} − 대출 잔액 ${won(e.balance)})`; }).join(' · ');
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

      <GuardrailCompare />

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
        <LifeChart sim={sim} retireAge={inp.retireAge} compare={gsim ? { name: `하락장 가드레일 중앙값(−${gDrop}%·생활비 −${gCut}%)`, p50: gsim.p50 } : undefined} />
        {!retired && inp.annualSavings < 0 && (
          <p role="alert" className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
            지금은 지출이 소득보다 많아 매달 {won(-inp.annualSavings / 12)}을 금융자산에서 꺼내 쓰는 것으로 계산했습니다. 은퇴({inp.retireAge}세) 전 {inp.retireAge - inp.currentAge}년 동안 약 {won((-inp.annualSavings * (inp.retireAge - inp.currentAge)))}(오늘 물가, 수익 제외)이 빠져 곡선이 은퇴 전부터 내려갑니다{(inp.savingsChanges ?? []).length > 0 || (inp.debts ?? []).some((x) => x.endAge < inp.retireAge) ? '(대출 상환 완료·보험 납입 완료로 줄어드는 부족분은 따로 반영)' : ''}. 이미 은퇴했다면 ‘데이터·설정 → 노후 계획’의 은퇴 희망 나이를 지금 나이 이하로 바꾸세요.
          </p>
        )}
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="은퇴 후 월 현금흐름 (현재가치)" action={<span className="text-xs text-muted">{fullAge}세 기준 · 오늘 물가</span>}>
          {/* 소득 − 지출 = 월 수지, 모자라는 만큼 금융자산에서 인출 */}
          <div className="space-y-2.5 text-sm">
            <div className="text-xs font-semibold text-muted">소득{draw ? ' (연금계좌 인출은 아래 ‘금융자산에서 인출’에 포함)' : ''}</div>
            {incomeRows.length === 0 && <Line label="연금·소득 없음" value={won(0)} muted />}
            {incomeRows.map(({ x, monthly }, i) => (
              <Line key={i} label={`${x.name} (${x.startAge}세~${x.endAge ? `${x.endAge}세` : ''}${x.growth === 0 ? ', 명목 고정' : ''})`} value={won(monthly)} />
            ))}
            <div className="pt-1 text-xs font-semibold text-muted">지출</div>
            <Line label={draw ? (drawMonthly >= publicMonthly ? '연금 생활비 (명목 고정, 물가 반영 후)' : '연금 생활비 (국민·개인연금이 고정액보다 많아 연금 전액)') : `은퇴 후 생활비${inp.expenseGrowth !== undefined || steps.length ? ` (${fullAge}세)` : ''}`} value={`− ${won(livingMonthly)}`} muted />
            {draw && otherIncomeMonthly > 0.5 && <Line label="그 밖의 소득(월세 등)만큼 더 쓰는 생활비" value={`− ${won(otherIncomeMonthly)}`} muted />}
            {steps.map((x) => (
              <Line key={`step-${x.fromAge}`} label={`· ${x.fromAge}세부터 생활비`} value={`− ${won(expenseAt(inp, x.fromAge) / 12)}`} muted />
            ))}
            <div className="border-t border-line pt-2.5">
              <Line label={gapMonthly > 0.5 ? '월 수지 (소득 − 지출, 부족)' : '월 수지 (소득 − 지출)'} value={gapMonthly > 0.5 ? `− ${won(gapMonthly)}` : won(balanceMonthly)} strong />
            </div>
            {gapMonthly > 0.5 ? (
              <div className="flex items-center justify-between rounded-lg bg-sunken px-3 py-2">
                <span>→ 부족분은 금융자산에서 인출</span>
                <span className="text-base font-bold">{won(gapMonthly)}</span>
              </div>
            ) : (
              <div className="rounded-lg bg-sunken px-3 py-2 text-xs text-muted">연금·소득으로 생활비가 충당되어 생활비 때문에 꺼낼 금액은 없습니다.</div>
            )}
            {(premiums.length > 0 || lateDebts.length > 0 || (inp.inflows ?? []).length > 0 || extraRows.length > 0) && (
              <div className="space-y-1.5 border-t border-line pt-2.5">
                <div className="text-xs font-semibold text-muted">월 수지 밖에서 따로 오가는 돈 (금융자산에서 추가 인출·유입)</div>
                {extraRows.map((x) => <Line key={x.key} label={x.label} value={won(x.monthly)} muted />)}
                {lateDebts.map((x) => (
                  <Line key={x.name} label={`− ${x.name} 상환 (${Number.isFinite(x.endAge) ? `${x.endAge - 1}세까지` : '종료 없음'}${x.decline ? ', 해마다 줄어듦' : ''}, 월)`} value={won(debtAnnualAt(x, inp.retireAge) / 12)} muted />
                ))}
                {premiums.map((x) => (
                  <Line key={`prem-${x.name}`} label={`− ${GOAL_KIND_LABEL.premium} · ${x.name} (${x.last}세까지, 명목 고정, 월)`} value={won(x.first.amount / 12)} muted />
                ))}
                {(inp.inflows ?? []).map((x) => (
                  <Line key={`${x.name}-${x.age}`} label={x.kind === 'credit' ? `+ 세액공제 환급(${x.age}세, 일시금)` : x.kind === 'sale' ? `+ ${x.name} 매각(${x.age}세, 비용·보증금·새 집 뺀 금액)` : `+ ${x.name} 수령(${x.age}세, 세후 일시금)`} value={won(x.amount)} muted />
                ))}
              </div>
            )}
          </div>
          {preChanges.length > 0 && (
            <div className="mt-3 space-y-1.5 border-t border-line pt-2.5 text-sm">
              <div className="text-xs font-semibold text-muted">은퇴 전 저축 변화 (월, 그 나이부터){inp.annualSavings < 0 && ` · 지금 월 ${won(-inp.annualSavings / 12)} 부족에서 +는 부족분 감소`}</div>
              {preChanges.map((x) => (
                <Line key={`${x.label}-${x.age}`} label={x.label} value={`${x.monthly >= 0 ? '+' : '−'}${won(Math.abs(x.monthly))}`} muted />
              ))}
            </div>
          )}
          <div className="mt-3 rounded-lg bg-sunken px-3 py-2 text-sm">
            <Line label={`${retired ? '현재' : `은퇴 첫해(${start.age}세)`} 인출률`} value={`${pct(start.rate, 1)} · 상한 ${p.criteria.withdrawRateMax}%`} />
            <div className="mt-0.5 text-xs text-muted">연 {won(start.outflow)} ÷ {retired ? '현재 금융자산' : '평균수익 가정 은퇴 시점 금융자산'} {won(start.balance)} · 노후 인출 화면과 같은 기준</div>
          </div>
          <p className="mt-3 text-xs text-muted">소득 개시 전 기간에는 그만큼 더 자산에서 인출합니다. 인상률을 넣은 소득은 물가보다 덜 오르면 실질 금액이 줄어듭니다.{lateDebts.length > 0 && ' 은퇴 후에도 남는 대출 상환액은 상환이 끝날 때까지 추가로 인출합니다.'}{premiums.length > 0 && ' 은퇴 뒤까지 내는 보험료도 납입이 끝날 때까지 추가로 인출합니다.'}</p>
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

      <LoanTable liabilities={d.liabilities} age={d.summary.age} retireAge={inp.retireAge} lifeExpectancy={p.lifeExpectancy} birthYear={p.birthYear} />

      <Card title="시뮬레이션 가정" className="mt-4">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-4">
          <Assume k="시작 금융자산" v={won(inp.startBalance)} />
          <Assume k="연 저축액(은퇴 전)" v={inp.annualSavings < 0 ? `연 ${won(-inp.annualSavings)} 부족 · 금융자산에서 인출` : won(inp.annualSavings)} />
          <Assume k={inp.retireMeanReturn === undefined ? '기대수익률 / 변동성' : '은퇴 전 수익률 / 변동성'} v={`${inp.meanReturn.toFixed(1)}% / ${inp.volatility.toFixed(1)}%`} />
          {inp.retireMeanReturn !== undefined && <Assume k="은퇴 후 수익률 / 변동성" v={`${inp.retireMeanReturn.toFixed(1)}% / ${(inp.retireVolatility ?? inp.volatility).toFixed(1)}%`} />}
          {(inp.debts ?? []).map((x) => (
            <Assume
              key={x.name}
              k={`대출 상환 · ${x.name}`}
              v={(x.decline ? '원금균등 · ' : '') + (!Number.isFinite(x.endAge) ? `월 ${won(x.annual / 12)} · 상환 미종료` : x.endAge === inp.retireAge ? `${x.endAge}세(은퇴 시점) 상환 종료` : x.endAge < inp.retireAge ? `${x.endAge}세부터 월 ${won(x.annual / 12)} 저축 증가` : `은퇴 후 ${x.endAge - 1}세까지 월 ${won(debtAnnualAt(x, inp.retireAge) / 12)} 지출`)}
            />
          ))}
          <Assume k="물가상승률" v={`${inp.inflation}%`} />
          <Assume k="은퇴 후 생활비" v={expenseNote + (steps.length ? ` · 나이 구간별(${[{ fromAge: inp.retireAge, ratio: expenseRatioAt(inp.expenseSteps, inp.retireAge) }, ...steps].map((x) => `${x.fromAge}세~ ${won((inp.retireExpenseAnnual * x.ratio) / 12)}`).join(' → ')})` : '')} />
          {(inp.inflows ?? []).some((x) => !x.kind) && <Assume k="수령 전 자산(시작 자산에서 제외)" v={(inp.inflows ?? []).filter((x) => !x.kind).map((x) => `${x.name} ${x.age}세`).join(' · ')} />}
          <Assume k={GOAL_KIND_LABEL.goal} v={`${goalItemsFrom(d.goals, inp.currentAge).length}건 · 총 ${won(goalRows.reduce((a, g) => a + g.amount, 0))}`} />
          {npTaxRows.length > 0 && <Assume k={GOAL_KIND_LABEL.npTax} v={`${npTaxRows[0].age}~${npTaxRows[npTaxRows.length - 1].age}세 · 총 ${won(npTaxRows.reduce((a, g) => a + g.amount, 0))}`} />}
          {premiums.length > 0 && <Assume k={GOAL_KIND_LABEL.premium} v={premiums.map((x) => `${x.name} ${x.first.age}~${x.last}세 · 총 ${won(x.total)}`).join(' · ')} />}
          <Assume k="부동산" v={reNote} />
          {hpNote && <Assume k="주택연금 상속 시 남는 주택 가치" v={hpNote} />}
        </dl>
      </Card>
      <Disclaimer />
    </>
  );
}

/** 저축 변화 이름 → "종신보험 납입 완료 (배우자 60세 · 본인 62세)" */
function changeLabel(name: string, age: number, policies: Insurance[], p: Profile) {
  const pol = name.endsWith(' 납입 완료') ? policies.find((x) => `${x.name} 납입 완료` === name && payEndSelfAge(x, p) === age) : undefined;
  if (pol && (pol.insured ?? 'self') !== 'self' && payEndSelfAge(pol, p) !== pol.payEndAge) return `${name} (${INSURED_WHO[pol.insured!]} ${pol.payEndAge}세 · 본인 ${age}세)`;
  return `${name} (본인 ${age}세)`;
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

const REPAY_LABEL = { amort: '원리금균등', equal: '원금균등', bullet: '만기일시' } as const;

/** 대출별 연도별 상환액·연말 잔액(지금 금액 기준 추정). 원금균등은 해마다 줄고, 만기일시는 만기 나이에 원금을 한 번에 갚음 */
function LoanTable({ liabilities, age, retireAge, lifeExpectancy, birthYear }: { liabilities: Liability[]; age: number; retireAge: number; lifeExpectancy: number; birthYear: number }) {
  const loans = liabilities.filter((l) => l.balance > 0);
  if (loans.length === 0) return null;
  // 상환이 끝나는 마지막 해까지(만기일시는 만기 나이, 끝나지 않으면 기대수명까지)
  const lastOf = (l: Liability) => {
    const end = loanEndAge(l, age).age;
    if (!Number.isFinite(end)) return lifeExpectancy;
    return l.repay === 'bullet' ? end : end - 1;
  };
  const lastAge = Math.min(lifeExpectancy, Math.max(age, ...loans.map(lastOf)));
  const rows = loans.map((l) => ({ l, end: lastOf(l), years: loanSchedule(l, age, lastAge) }));
  const ages = rows[0].years.map((y) => y.age);
  return (
    <Card title="대출 연도별 상환" className="mt-4">
      <div className="max-h-96 overflow-auto">
        <table className="w-full min-w-max text-sm">
          <thead className="sticky top-0 bg-surface">
            <tr className="border-b border-line text-right text-xs text-muted">
              <th className="py-2 text-left font-medium" rowSpan={2}>나이</th>
              {rows.map(({ l }) => (
                <th key={l.id ?? l.name} colSpan={2} className="px-2 pt-2 text-center font-semibold text-ink">
                  {l.name}
                  <div className="text-xs font-normal text-muted">{REPAY_LABEL[l.repay ?? 'amort']} · {l.rate}%</div>
                </th>
              ))}
            </tr>
            <tr className="border-b border-line text-right text-xs text-muted">
              {rows.flatMap(({ l }) => [
                <th key={`${l.id ?? l.name}-p`} className="px-2 py-1 font-medium">연 상환액</th>,
                <th key={`${l.id ?? l.name}-b`} className="px-2 py-1 font-medium">연말 잔액</th>,
              ])}
            </tr>
          </thead>
          <tbody>
            {ages.map((a, i) => (
              <tr key={a} className={`border-b border-line text-right last:border-0 ${a === retireAge ? 'bg-sunken' : ''}`}>
                <td className="py-1.5 text-left font-medium">
                  {a}세<span className="ml-1 text-xs font-normal text-muted">{birthYear + a}{a === retireAge ? ' · 은퇴' : ''}</span>
                </td>
                {rows.flatMap(({ l, end, years }) => {
                  const y = years[i];
                  if (a > end) return [<td key={`${l.id ?? l.name}-p`} className="px-2 text-muted">—</td>, <td key={`${l.id ?? l.name}-b`} className="px-2 text-muted">—</td>];
                  return [
                    <td key={`${l.id ?? l.name}-p`} className="whitespace-nowrap px-2">
                      {y.payment > 0 ? won(y.payment) : ''}
                      {y.principal > 0 && <div className="text-xs font-semibold text-warn">원금 {won(y.principal)} 일시 상환</div>}
                    </td>,
                    <td key={`${l.id ?? l.name}-b`} className="px-2 text-muted">{won(y.balance)}</td>,
                  ];
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">
        지금 월 상환액·잔액·금리로 추정한 금액(물가 반영 전)입니다. 원리금균등은 매년 같고, 원금균등은 이자가 줄어 해마다 줄며, 만기일시는 이자만 내다가 만기 나이에 원금을 한 번에 갚습니다(노란 글씨).
        상환이 끝나지 않는 대출은 기대수명까지 보여 줍니다. 회색 행은 은퇴 나이입니다.
      </p>
    </Card>
  );
}
