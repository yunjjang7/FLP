import { useEffect, useMemo, useState } from 'react';
import { NPS_DEFER, NPS_EARLY, npsFactor } from '../engine/finance';
import { deterministicPath, simulate, type PlanInput } from '../engine/montecarlo';
import { won } from '../lib/format';
import { useFlp } from '../store/FlpContext';
import { Card } from './ui';

const RUNS = 300;

type Metric = 'rate' | 'age';

/** 민감도 표 생활비 행: 지금 생활비에서 50만원씩 내려 300만원 이상인 데까지(지금이 낮으면 −100까지), 위로는 +100 */
export function sensitivityExpenses(current: number) {
  const down = Math.max(2, Math.floor((current - 300) / 50));
  return Array.from({ length: down + 3 }, (_, i) => current + (i - down) * 50).filter((x) => x > 0);
}

function evaluate(input: PlanInput, metric: Metric) {
  if (metric === 'rate') return simulate(input, RUNS, 7).successRate;
  return deterministicPath(input).depletedAt;
}

export function Sensitivity() {
  const { planInput: inp, retax, profile: p, start, summary } = useFlp();
  const [metric, setMetric] = useState<Metric>('rate');
  const target = p.criteria.successTarget;
  const baseReturn = inp.retireMeanReturn ?? inp.meanReturn;
  const vol = inp.retireVolatility ?? inp.volatility;

  // 생활비: 300만원(또는 지금 −100) 근처부터 지금 +100까지 50만원 간격, 수익률: 지금 −2%p ~ +3%p
  // 연금 생활비 명목 고정 방식은 생활비 대신 월 고정 인출액을 바꿔 봄(생활비를 바꿔도 결과가 같으므로)
  const drawMode = inp.fixedDraw !== undefined;
  const baseExpense = drawMode ? Math.round((inp.fixedDraw ?? 0) / 12) : p.retireMonthlyExpense;
  const expenses = sensitivityExpenses(baseExpense);
  const returns = [-2, -1, 0, 1, 2, 3].map((x) => +(baseReturn + x).toFixed(1)).filter((x) => x > 0);

  // 칸이 많아(최대 12×6, 시뮬레이션 72번) 한 번에 계산하면 화면이 멈추므로 한 줄씩 나눠 계산하고 다 될 때까지 빈칸으로 둠
  const [grid, setGrid] = useState<(number | null)[][]>([]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const rows: (number | null)[][] = [];
    setGrid([]);
    const step = (i: number) => {
      if (cancelled || i >= expenses.length) return;
      rows.push(returns.map((r) => evaluate(retax({ ...inp, ...(drawMode ? { fixedDraw: expenses[i] * 12 } : { retireExpenseAnnual: expenses[i] * 12 }), retireMeanReturn: r, retireVolatility: vol }), metric)));
      setGrid([...rows]);
      timer = setTimeout(() => step(i + 1), 0);
    };
    timer = setTimeout(() => step(0), 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inp, retax, metric, baseExpense, baseReturn, vol]);

  // 국민연금 개시 나이: 아직 받기 전일 때만 바꿔 볼 수 있음
  const nps = inp.pensions.find((x) => x.name === '국민연금');
  const npsRows = useMemo(() => {
    if (!nps || summary.age >= nps.startAge) return [];
    const normal = p.nationalPensionAge;
    return Array.from({ length: 11 }, (_, i) => normal - 5 + i)
      .filter((a) => a >= Math.max(summary.age, 55))
      .map((a) => {
        const annual = nps.annual * npsFactor(a, normal);
        const input = retax({ ...inp, pensions: inp.pensions.map((x) => (x === nps ? { ...x, startAge: a, annual } : x)) });
        return { age: a, monthly: annual / 12, rate: simulate(input, RUNS, 7).successRate, depleted: deterministicPath(input).depletedAt };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inp, retax, p.nationalPensionAge, summary.age]);

  const cell = (v: number | null) => {
    if (metric === 'rate') {
      const n = v ?? 0;
      return { text: `${n.toFixed(0)}%`, cls: n >= target ? 'bg-good-soft text-good' : n >= 60 ? 'bg-warn-soft text-warn' : 'bg-bad-soft text-bad' };
    }
    if (v === null) return { text: '유지', cls: 'bg-good-soft text-good' };
    return { text: `${v}세`, cls: v >= p.lifeExpectancy - 10 ? 'bg-warn-soft text-warn' : 'bg-bad-soft text-bad' };
  };

  return (
    <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <Card
        title={`민감도 — ${drawMode ? '고정 인출액' : '생활비'} × 은퇴 후 수익률`}
        action={
          <div className="flex rounded-lg bg-sunken p-0.5 text-xs">
            {(['rate', 'age'] as const).map((m) => (
              <button key={m} onClick={() => setMetric(m)} className={`whitespace-nowrap rounded-md px-2 py-1 font-medium ${metric === m ? 'bg-surface shadow-sm' : 'text-muted'}`}>
                {m === 'rate' ? '성공확률' : '고갈 나이'}
              </button>
            ))}
          </div>
        }
      >
        <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="text-xs text-muted">
                <th className="py-1.5 text-left font-medium">{drawMode ? '월 고정 인출액' : '월 생활비'} \ 수익률</th>
                {returns.map((r) => (
                  <th key={r} className={`font-medium ${r === baseReturn ? 'text-ink' : ''}`}>{r.toFixed(1)}%</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {expenses.map((e, i) => (
                <tr key={e}>
                  <td className={`whitespace-nowrap py-1 pr-2 ${e === baseExpense ? 'font-semibold' : 'text-muted'}`}>{won(e)}</td>
                  {returns.map((_, j) => {
                    if (!grid[i]) return <td key={j} className="p-0.5"><div className="rounded-md bg-sunken py-1.5 text-center text-muted">…</div></td>;
                    const c = cell(grid[i][j]);
                    const current = e === baseExpense && returns[j] === baseReturn;
                    return (
                      <td key={j} className="p-0.5">
                        <div className={`rounded-md py-1.5 text-center font-semibold ${c.cls} ${current ? 'ring-2 ring-ink' : ''}`}>{c.text}</div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted">
          {metric === 'rate'
            ? `시나리오 ${RUNS}개로 계산한 ${p.lifeExpectancy}세까지 자산 유지 확률입니다(목표 ${target}%).`
            : `매년 평균수익만 났을 때 자산이 바닥나는 나이입니다. ‘유지’는 ${p.lifeExpectancy}세까지 남는다는 뜻입니다. 실제 시장은 오르내리므로 성공확률과 함께 보세요.`}{' '}
          테두리 칸이 지금 계획입니다{start.retired ? '' : ' (수익률은 은퇴 후 기준)'}.{inp.goals.some((g) => g.pensionTax) ? ' 연금 인출 세금은 칸마다 그 생활비·수익률로 다시 계산했습니다.' : ''}
        </p>
      </Card>

      {npsRows.length > 0 && (
        <Card title="국민연금 개시 나이 비교">
          <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
            <table className="num-table w-full min-w-[340px] text-sm">
              <thead>
                <tr className="border-b border-line text-right text-xs text-muted">
                  <th className="py-1.5 text-left font-medium">개시 나이</th>
                  <th className="font-medium">월액</th>
                  <th className="font-medium">성공확률</th>
                  <th className="font-medium">고갈 나이</th>
                </tr>
              </thead>
              <tbody>
                {npsRows.map((r) => (
                  <tr key={r.age} className={`border-b border-line text-right last:border-0 ${r.age === p.nationalPensionAge ? 'font-semibold' : ''}`}>
                    <td className="py-1.5 text-left">
                      {r.age}세 <span className="text-xs font-normal text-muted">{r.age < p.nationalPensionAge ? '조기' : r.age > p.nationalPensionAge ? '연기' : '지금'}</span>
                    </td>
                    <td>{won(r.monthly)}</td>
                    <td className={r.rate >= target ? 'text-good' : r.rate >= 60 ? 'text-warn' : 'text-bad'}>{r.rate.toFixed(0)}%</td>
                    <td>{r.depleted === null ? '유지' : `${r.depleted}세`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted">
            입력한 월액을 {p.nationalPensionAge}세 수령액으로 보고, 1년 일찍 받을 때마다 {NPS_EARLY * 100}% 감액, 1년 늦게 받을 때마다 {(NPS_DEFER * 100).toFixed(1)}% 증액(각각 최대 5년)해 계산했습니다. 고갈 나이는 평균수익 가정입니다.
          </p>
        </Card>
      )}
    </div>
  );
}
