import { useEffect, useMemo, useState } from 'react';
import { runStress, stressCases, summarizeStress, type StressResult } from '../engine/stress';
import { pct, won } from '../lib/format';
import { useFlp } from '../store/FlpContext';
import type { Level } from '../types';
import { Card } from './ui';

/**
 * 노후 진단: 스트레스 테스트. 지금 계획에 나쁜 일 하나(은퇴 직후 폭락·고물가·장수 등)를 더했을 때의 성공확률.
 * 기본 계산과 같은 1,000가지 시장 경로로 돌려 차이는 그 사건의 영향만 남음
 */
export function StressTest() {
  // 상황별 결과가 평균 경로 세금이라 비교 기준도 같은 방식(simFlat)
  const { planInput: inp, retax, profile: p, simFlat: sim } = useFlp();
  const target = p.criteria.successTarget;
  // 상황마다 바뀐 계획(물가·기대수명·연금·저축)에 맞춰 연금 인출 세금을 다시 계산
  const cases = useMemo(() => stressCases(inp).map((c) => ({ ...c, input: retax(c.input) })), [inp, retax]);
  const base = useMemo(() => summarizeStress({ key: 'base', label: '지금 계획', desc: '아무 일도 없을 때', input: inp }, sim), [inp, sim]);

  // 시나리오마다 1,000회 시뮬레이션이라 하나씩 나눠 계산하고 다 될 때까지 빈칸으로 둠
  const [rows, setRows] = useState<StressResult[]>([]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const done: StressResult[] = [];
    setRows([]);
    const step = (i: number) => {
      if (cancelled || i >= cases.length) return;
      done.push(runStress(cases[i]));
      setRows([...done]);
      timer = setTimeout(() => step(i + 1), 0);
    };
    timer = setTimeout(() => step(0), 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [cases]);

  const lvl = (v: number): Level => (v >= target ? 'good' : v >= 60 ? 'caution' : 'danger');
  const tone = (l: Level) => (l === 'good' ? 'bg-good-soft text-good' : l === 'caution' ? 'bg-warn-soft text-warn' : 'bg-bad-soft text-bad');
  const ready = rows.length === cases.length;
  const worst = ready ? rows.reduce((a, r) => (r.successRate < a.successRate ? r : a), rows[0]) : null;
  const failed = rows.filter((r) => r.successRate < target);
  const until = (r: StressResult) => (r.depletedAt === null ? `${r.lifeExpectancy}세까지 유지` : `${r.depletedAt}세에 바닥`);

  return (
    <Card title="스트레스 테스트" className="mt-4" action={<span className="text-xs text-muted">지금 계획 {pct(sim.successRate)} · 목표 {target}%</span>}>
      <p className="mb-3 text-sm text-muted">지금 계획에 나쁜 일 하나를 더했을 때 성공확률이 얼마나 떨어지는지 봅니다. 어느 위험에 가장 약한지 확인하는 용도입니다.</p>
      <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="text-xs text-muted">
              <th className="py-1.5 text-left font-medium">상황</th>
              <th className="font-medium">성공확률</th>
              <th className="font-medium">지금 계획 대비</th>
              <th className="text-right font-medium">평균 수익이면</th>
              <th className="text-right font-medium">남는 자산(중앙값)</th>
            </tr>
          </thead>
          <tbody>
            {[base, ...cases].map((c, i) => {
              const r = i === 0 ? base : rows[i - 1];
              const d = r ? r.successRate - sim.successRate : 0;
              return (
                <tr key={c.key} className="border-t border-line align-top">
                  <td className="py-2 pr-2">
                    <div className={i === 0 ? 'font-semibold' : 'font-medium'}>{c.label}</div>
                    <div className="text-xs text-muted">{c.desc}</div>
                  </td>
                  <td className="px-1 py-2 text-center">
                    {r ? <span className={`inline-block min-w-[56px] rounded-md px-2 py-1 font-semibold ${tone(lvl(r.successRate))}`}>{r.successRate.toFixed(0)}%</span> : <span className="inline-block min-w-[56px] rounded-md bg-sunken px-2 py-1 text-muted">…</span>}
                  </td>
                  <td className={`whitespace-nowrap px-1 py-2 text-center ${i > 0 && r && d < -0.05 ? 'font-semibold text-bad' : 'text-muted'}`}>{i === 0 ? '기준' : r ? `${d > 0.05 ? '+' : d < -0.05 ? '−' : ''}${Math.abs(d).toFixed(1)}%p` : ''}</td>
                  <td className="whitespace-nowrap px-1 py-2 text-right">{r ? until(r) : ''}</td>
                  <td className="whitespace-nowrap py-2 pl-1 text-right">{r ? won(r.endP50) : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {worst && (
        <p className="mt-3 text-sm">
          {worst.successRate < sim.successRate - 0.05 ? (
            <>가장 약한 곳은 <b>{worst.label}</b>입니다: 성공확률 {pct(sim.successRate)} → <b>{pct(worst.successRate)}</b>. </>
          ) : (
            <>어느 상황에서도 성공확률이 거의 떨어지지 않습니다. </>
          )}
          {failed.length === 0 ? `모든 상황에서 목표 ${target}%를 지킵니다.` : `목표 ${target}%에 못 미치는 상황: ${failed.map((r) => r.label).join(' · ')}.`}
        </p>
      )}

      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">
        <li>‘평균 수익이면’은 해마다 기대수익률만 났을 때 자산이 바닥나는 나이, ‘남는 자산’은 1,000가지 경로의 마지막 해 잔액 중앙값(오늘 물가)입니다.</li>
        <li>폭락·수익 없는 해는 그 해 수익률만 바꾸고 나머지 해는 지금 계획과 같은 시장 경로를 씁니다. 은퇴 직후의 손실이 뒤늦은 손실보다 훨씬 아픈 ‘수익률 순서 위험’을 보여 줍니다.</li>
        <li>고물가는 수익률은 그대로 두고 물가만 올려, 실질 수익이 줄고 명목 고정 소득·연금의 가치가 더 빨리 깎이는 효과입니다. 목표 탭 지출·매각대금 등 미리 환산한 금액은 그대로라 어림값입니다.</li>
        <li>연금 인출 세금은 상황마다 바뀐 계획으로 평균 수익 경로에서 다시 계산합니다(폭락·수익 없는 해는 평균 경로에 넣지 않아 세금은 지금 계획과 같음). 비교가 맞도록 ‘지금 계획’도 같은 방식(평균 경로 세금)으로 돌린 값이라, 노후 진단 맨 위 성공확률(경로마다 세금 계산)과 조금 다를 수 있습니다.</li>
        <li>장수는 기간만 늘립니다. 계속 내는 보험료처럼 기대수명까지만 넣은 지출은 늘어난 기간에 들어가지 않습니다.</li>
        <li>대비책은 ‘하락장 가드레일 비교’(폭락·수익 없는 해)와 ‘맞춤 처방’의 조정안, 아래 민감도 표의 국민연금 연기 수령(장수·고물가)을 참고하세요.</li>
      </ul>
    </Card>
  );
}
