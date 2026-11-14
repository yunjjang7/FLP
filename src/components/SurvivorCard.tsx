import { useState } from 'react';
import { SURVIVOR_LIVING, SURVIVOR_OVERLAP, SURVIVOR_RATES } from '../engine/survivor';
import { pct, won } from '../lib/format';
import { useFlp } from '../store/FlpContext';
import { SURVIVOR_RATE, useSurvivor } from '../store/useSurvivor';
import type { Level } from '../types';
import { Labeled, NumberField, SelectField } from './fields';
import { Card } from './ui';

/**
 * 노후 진단: 배우자 사별 분석. 부부 중 한 사람이 먼저 떠났을 때 남은 사람의 생활비·연금이 어떻게 바뀌고
 * 자산이 끝까지 버티는지. 기본 계산과 같은 1,000가지 시장 경로로 돌림(계산은 useSurvivor, 요약보고·보험 탭과 같은 결과)
 */
export function SurvivorCard() {
  const { planInput: inp, profile: p, simFlat: sim } = useFlp();
  const [living, setLiving] = useState(SURVIVOR_LIVING);
  const [rate, setRate] = useState(SURVIVOR_RATE);
  const target = p.criteria.successTarget;
  const { hasSpouse, cases, rows, worst: w, benefits } = useSurvivor(living, rate);

  if (!hasSpouse || cases.length === 0) return null;
  const lvl = (v: number): Level => (v >= target ? 'good' : v >= 60 ? 'caution' : 'danger');
  const tone = (l: Level) => (l === 'good' ? 'bg-good-soft text-good' : l === 'caution' ? 'bg-warn-soft text-warn' : 'bg-bad-soft text-bad');
  const worst = w;
  const draw = inp.fixedDraw !== undefined;

  return (
    <Card title="배우자 사별 분석" className="mt-4" action={<span className="text-xs text-muted">지금 계획 {pct(sim.successRate)} · 목표 {target}%</span>}>
      <p className="mb-3 text-sm text-muted">부부 중 한 사람이 먼저 세상을 떠나면 생활비는 줄지만 그 사람의 연금도 끊깁니다. 남은 사람 혼자서 자산이 끝까지 버티는지 봅니다.</p>
      <div className="mb-3 grid grid-cols-2 gap-3 sm:max-w-md">
        <Labeled label="혼자일 때 생활비" hint={draw ? '인출액 고정 방식에서는 반영 안 됨' : '부부 생활비 대비'}>
          <NumberField value={living} unit="%" min={0} onChange={(v) => setLiving(Math.min(100, Math.max(30, v)))} />
        </Labeled>
        <Labeled label="유족연금 지급률" hint="떠난 사람의 가입기간">
          <SelectField value={String(rate)} onChange={(v) => setRate(Number(v))} options={Object.fromEntries(SURVIVOR_RATES.map((r) => [String(r), `${r}% (${r === 40 ? '10년 미만' : r === 50 ? '10~20년' : '20년 이상'})`]))} />
        </Labeled>
      </div>
      <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
        <table className="w-full min-w-[700px] text-sm">
          <thead>
            <tr className="text-xs text-muted">
              <th className="py-1.5 text-left font-medium">경우</th>
              <th className="font-medium">성공확률</th>
              <th className="whitespace-nowrap px-2 font-medium">지금 계획 대비</th>
              <th className="whitespace-nowrap px-2 font-medium">사망보장 · 없으면</th>
              <th className="text-right font-medium">연금·소득(월)</th>
              <th className="text-right font-medium">평균 수익이면</th>
            </tr>
          </thead>
          <tbody>
            {cases.map((c, i) => {
              const r = rows[i];
              const d = r ? r.successRate - sim.successRate : 0;
              return (
                <tr key={c.key} className="border-t border-line align-top">
                  <td className="py-2 pr-2">
                    <div className="font-medium">{c.label}</div>
                    <div className="text-xs text-muted">{c.desc}</div>
                  </td>
                  <td className="px-1 py-2 text-center">
                    {r ? <span className={`inline-block min-w-[56px] rounded-md px-2 py-1 font-semibold ${tone(lvl(r.successRate))}`}>{r.successRate.toFixed(0)}%</span> : <span className="inline-block min-w-[56px] rounded-md bg-sunken px-2 py-1 text-muted">…</span>}
                  </td>
                  <td className={`whitespace-nowrap px-1 py-2 text-center ${r && d < -0.05 ? 'font-semibold text-bad' : 'text-muted'}`}>{r ? `${d > 0.05 ? '+' : d < -0.05 ? '−' : ''}${Math.abs(d).toFixed(1)}%p` : ''}</td>
                  <td className="whitespace-nowrap px-1 py-2 text-center">
                    {c.benefit > 0 ? (
                      <>
                        <div>{won(c.benefit)}</div>
                        <div className="text-xs text-muted">{r ? (r.plain !== undefined ? `없으면 ${r.plain.toFixed(0)}%` : `없어도 ${r.successRate.toFixed(0)}%`) : "…"}</div>
                      </>
                    ) : (
                      <span className="text-muted">없음</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-1 py-2 text-right">{won(c.incomeBefore / 12)} → <b>{won(c.incomeAfter / 12)}</b></td>
                  <td className="whitespace-nowrap py-2 pl-1 text-right">{r ? (r.depletedAt === null ? `${r.lifeExpectancy}세까지 유지` : `${r.depletedAt}세에 바닥`) : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {worst && (
        <p className="mt-3 text-sm">
          {worst.successRate < sim.successRate - 0.05 ? (
            <>
              가장 어려운 경우는 <b>{worst.label}</b> 떠날 때입니다: 성공확률 {pct(sim.successRate)} → <b>{pct(worst.successRate)}</b>.
              {worst.plain !== undefined && <> 보험 탭 사망보장 {won(worst.benefit)}이 없으면 <b>{pct(worst.plain)}</b>입니다.</>}
            </>
          ) : (
            <>어느 경우에도 성공확률이 지금 계획보다 떨어지지 않습니다. 줄어드는 생활비가 끊기는 연금보다 큽니다.</>
          )}
        </p>
      )}

      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">
        <li>나이는 본인 나이 기준이고, ‘연금·소득’은 사별 다음 해의 월액(오늘 물가)을 사별이 없을 때 → 혼자일 때로 보여 줍니다. 월세 등 그 밖의 소득은 그대로 이어받는다고 봅니다.</li>
        <li>떠난 사람의 국민연금은 끊기고 유족연금(떠난 사람 연금액 × 지급률)이 나옵니다. 남은 사람이 자기 노령연금을 받고 있으면 ‘노령연금 + 유족연금의 {SURVIVOR_OVERLAP * 100}%’와 ‘유족연금만’ 가운데 큰 쪽으로 계산했습니다.</li>
        <li>떠난 사람의 개인·퇴직연금 월액과 근로소득은 끊기는 것으로 보았고, 보험 탭의 사망보장(본인 {won(benefits.self)} · 배우자 {won(benefits.spouse)}, 떠난 사람 피보험자 보험의 사망보장 합계)은 그 해에 금융자산으로 들어옵니다. ‘사망보장 · 없으면’ 칸은 들어간 보험금과, 보험금 없이 같은 사별을 돌린 성공확률입니다(보험이 성공확률을 얼마나 올리는지 비교). 연금계좌·금융자산은 배우자가 그대로 이어받는다고 가정합니다.</li>
        <li>연금 인출 세금은 경우마다 다시 계산합니다. 떠난 사람의 연금계좌는 그 해부터 남은 사람이 승계해 남은 사람 나이의 연금소득세율과 1,500만 한도 하나로 계산하고(연금수령연차는 계좌 그대로), 떠난 사람의 추가 납입은 없앱니다. 한도가 하나로 줄면 한 해에 과세재원을 덜 꺼내고 ISA·일반계좌를 먼저 써서, 세금이 앞에서 줄고 뒤로 미뤄질 수 있습니다. 비교가 맞도록 ‘지금 계획’도 평균 경로 세금으로 돌린 값입니다.</li>
        <li>본인이 먼저 떠나는 경우는 배우자의 기대수명까지 계산하므로, 배우자가 어리면 그만큼 기간이 길어집니다.</li>
        <li>상속세, 떠난 사람 보험료가 끝나는 효과, 건강보험료·종합소득세 변화, 유족연금의 나이 요건(지급 정지 기간)은 넣지 않은 어림값입니다. 정확한 유족연금은 국민연금공단에서 확인하세요.</li>
      </ul>
    </Card>
  );
}
