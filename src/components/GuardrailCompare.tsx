import { useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { expenseAt, GUARD_CUTS, GUARD_DROPS, guardrailSim, nominalFactor, type SimResult } from '../engine/montecarlo';
import { pct, won } from '../lib/format';
import { useFlp } from '../store/FlpContext';
import type { Level } from '../types';
import { SetupLink } from './SetupLink';
import { Badge, Card } from './ui';

/**
 * 노후 진단: 지금 방식(생활비 그대로)과 하락장 가드레일(시장이 최고점보다 drop% 이상 낮은 해 생활비 cut% 감축)의 성공확률 비교.
 * 같은 시드(42)·같은 횟수로 돌려 두 방식이 같은 시장 경로를 지나므로 차이는 가드레일 효과만 남음
 */
export function GuardrailCompare() {
  // 가드레일 시뮬레이션이 평균 경로 세금이라 비교 기준도 같은 방식(simFlat)
  const { planInput: inp, profile: p, simFlat: sim, start } = useFlp();
  const { guardrailDrop: drop, guardrailCut: cut, successTarget: target } = p.criteria;
  const on = cut > 0 && drop > 0;
  const gsim = useMemo(() => (on ? guardrailSim(inp, { drop, cut }) : null), [inp, on, drop, cut]);
  const lvl = (v: number): Level => (v >= target ? 'good' : v >= 60 ? 'caution' : 'danger');

  // 강도별 표: 칸마다 1,000회 시뮬레이션이라 한 줄씩 나눠 계산하고 다 될 때까지 빈칸으로 둠
  const [grid, setGrid] = useState<number[][]>([]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const rows: number[][] = [];
    setGrid([]);
    const step = (i: number) => {
      if (cancelled || i >= GUARD_DROPS.length) return;
      rows.push(GUARD_CUTS.map((c) => guardrailSim(inp, { drop: GUARD_DROPS[i], cut: c }).successRate));
      setGrid([...rows]);
      timer = setTimeout(() => step(i + 1), 0);
    };
    timer = setTimeout(() => step(0), 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [inp]);

  // 하락장 해에 줄어드는 월 생활비(은퇴 첫해·지금 기준, 오늘 물가)
  const living = inp.fixedDraw !== undefined ? inp.fixedDraw * nominalFactor(0, inp.inflation, start.age - Math.max(inp.currentAge, inp.retireAge)) : expenseAt(inp, start.age);
  const signed = (d: number) => `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}%p`;
  const cols: { key: string; label: string; desc: string; s: SimResult }[] = [{ key: 'now', label: '지금 방식', desc: '하락장에도 생활비 그대로', s: sim }];
  if (gsim) cols.push({ key: 'guard', label: '하락장 가드레일', desc: `하락장인 해 생활비 ${cut}% 감축`, s: gsim });

  return (
    <Card title="하락장 가드레일 비교" className="mt-4" action={on ? <span className="text-xs text-muted">최고점 대비 −{drop}% 이하인 해 · 생활비 −{cut}%</span> : undefined}>
      {!on && <p className="mb-3 text-sm text-muted"><SetupLink tab="criteria" card="점검 기준" field="하락장 생활비 감축">‘기본 정보 → 점검 기준’</SetupLink>에서 ‘하락장 기준’과 ‘하락장 생활비 감축’을 0보다 크게 넣으면 그 설정으로 지금 방식과 나란히 비교합니다. 아래 강도별 표는 설정과 관계없이 보여 줍니다.</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {cols.map(({ key, label, desc, s }) => (
          <div key={key} className={`rounded-xl border p-4 ${key === 'guard' ? 'border-brand/40' : 'border-line'}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[15px] font-semibold">{label}</span>
              <Badge level={lvl(s.successRate)} />
            </div>
            <div className="text-xs text-muted">{desc}</div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-3xl font-extrabold tracking-tight">{pct(s.successRate)}</span>
              {key === 'guard' && <span className={`text-sm font-semibold ${s.successRate - sim.successRate > 0.05 ? 'text-good' : 'text-muted'}`}>{signed(s.successRate - sim.successRate)}</span>}
            </div>
            <div className="mt-1 text-xs">
              고갈 나이 중앙값 <b>{s.medianDepletionAge === null ? `${p.lifeExpectancy}세까지 유지` : `${s.medianDepletionAge}세`}</b>
              {key === 'guard' && <> · 생활비 줄인 해 평균 <b>{s.cutYearsAvg.toFixed(1)}년</b> · 줄이는 금액 월 약 <b>{won((living * cut) / 100 / 12)}</b></>}
            </div>
          </div>
        ))}
      </div>

      {gsim && <CutHistogram s={gsim} last={p.lifeExpectancy - 1} />}

      <div className="mt-4">
        <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
          <span className="font-semibold">강도별 성공확률</span>
          <span className="text-xs text-muted">지금 방식 {pct(sim.successRate)} 대비 · 테두리는 지금 설정</span>
        </div>
        <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
          <table className="w-full min-w-[340px] text-sm">
            <thead>
              <tr className="text-xs text-muted">
                <th className="py-1.5 text-left font-medium">하락장 기준 \ 생활비 감축</th>
                {GUARD_CUTS.map((c) => (
                  <th key={c} className={`font-medium ${c === cut ? 'text-ink' : ''}`}>−{c}%<div className="font-normal">월 약 {won((living * c) / 100 / 12)}</div></th>
                ))}
              </tr>
            </thead>
            <tbody>
              {GUARD_DROPS.map((dr, i) => (
                <tr key={dr}>
                  <td className={`whitespace-nowrap py-1 pr-2 ${dr === drop ? 'font-semibold' : 'text-muted'}`}>최고점 −{dr}%</td>
                  {GUARD_CUTS.map((c, j) => {
                    if (!grid[i]) return <td key={c} className="p-0.5"><div className="rounded-md bg-sunken py-1.5 text-center text-muted">…</div></td>;
                    const v = grid[i][j];
                    const l = lvl(v);
                    const current = on && dr === drop && c === cut;
                    return (
                      <td key={c} className="p-0.5">
                        <div className={`rounded-md py-1 text-center ${l === 'good' ? 'bg-good-soft text-good' : l === 'caution' ? 'bg-warn-soft text-warn' : 'bg-bad-soft text-bad'} ${current ? 'ring-2 ring-ink' : ''}`}>
                          <div className="font-semibold">{v.toFixed(0)}%</div>
                          <div className="text-[11px] opacity-80">{signed(v - sim.successRate)}</div>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1.5 text-xs text-muted">하락장 기준이 낮을수록(−10%) 작은 하락에도 자주 줄이고, 감축이 클수록 한 번에 많이 줄입니다. 효과가 큰 칸일수록 생활비를 줄여야 하는 해도 많습니다.</p>
      </div>

      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">
        <li>하락장: 시장(명목 누적수익률)이 그때까지의 최고점보다 기준 이상 낮은 해입니다. 자산에서 꺼낸 돈은 빼고 시장 흐름만으로 판단합니다.</li>
        <li>하락장인 해에는 은퇴 후 생활비{inp.fixedDraw !== undefined ? '(연금 생활비 고정액)' : ''}를 줄입니다(줄이는 금액은 {start.age}세 기준, 오늘 물가). 시장이 회복해 최고점 대비 낙폭이 기준 안으로 들어오면 원래 생활비로 돌아갑니다. 대출 상환·목표 탭 지출·보험료는 줄이지 않습니다.</li>
        <li>모든 방식이 같은 1,000가지 시장 경로로 계산해 차이는 가드레일 효과만 나타냅니다. 위 성공확률·처방·민감도는 지금 방식 기준입니다. 생애 자산 곡선에는 지금 설정의 가드레일 중앙값을 함께 그립니다.</li>
        <li>인출 계획의 ‘가드레일’ 전략은 평균수익 계획의 기준선과 자산을 비교하는 다른 방식입니다. 기준은 <SetupLink tab="criteria" card="점검 기준" field="하락장 기준">‘기본 정보 → 점검 기준’</SetupLink>의 ‘하락장 기준’·‘하락장 생활비 감축’에서 바꿉니다.</li>
      </ul>
    </Card>
  );
}

/** 생활비를 줄인 해가 나이 구간(5세)별로 얼마나 나오는지: 시나리오 평균 연수. 은퇴 초기에 몰리는지 확인 */
function CutHistogram({ s, last }: { s: SimResult; last: number }) {
  const h = s.cutHistogram;
  if (h.length === 0) return <p className="mt-3 text-xs text-muted">이 설정에서는 생활비를 줄인 해가 없습니다.</p>;
  const total = h.reduce((a, x) => a + x.years, 0);
  const early = h.slice(0, 2).reduce((a, x) => a + x.years, 0);
  const peak = h.reduce((a, x) => (x.years > a.years ? x : a), h[0]);
  const label = (a: number) => `${a}~${Math.min(a + 4, last)}세`;
  const data = h.map((x) => ({ ...x, label: label(x.age), share: total > 0 ? (x.years / total) * 100 : 0 }));
  return (
    <div className="mt-4">
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className="font-semibold">생활비를 줄인 해 · 나이 구간별</span>
        <span className="text-xs text-muted">시나리오 평균 연수 · 합계 {total.toFixed(1)}년</span>
      </div>
      <div style={{ height: 176 }}>
        <ResponsiveContainer>
          <BarChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} interval={0} tick={{ fontSize: 11 }} />
            <YAxis width={36} tickLine={false} axisLine={false} tickFormatter={(v: number) => v.toFixed(1)} />
            <Tooltip formatter={(v: number, _n, item) => [`${v.toFixed(2)}년 (전체 감축의 ${(item.payload as { share: number }).share.toFixed(0)}%)`, '평균 감축 연수']} cursor={{ fill: 'var(--c-sunken)' }} />
            <Bar dataKey="years" fill="var(--chart-2)" radius={[6, 6, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-xs text-muted">
        은퇴 후 첫 10년({h[0].age}~{Math.min(h[0].age + 9, last)}세)에 전체 감축의 <b className="text-ink">{total > 0 ? ((early / total) * 100).toFixed(0) : 0}%</b>가 나오고, 가장 많은 구간은 {label(peak.age)}입니다.
        자산이 바닥난 뒤의 해는 세지 않아, 고갈이 잦은 계획은 뒤쪽 구간이 작게 나옵니다.
      </p>
    </div>
  );
}
