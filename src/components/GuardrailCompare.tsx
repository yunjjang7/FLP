import { useMemo } from 'react';
import { expenseAt, nominalFactor, simulate, type SimResult } from '../engine/montecarlo';
import { pct, won } from '../lib/format';
import { useFlp } from '../store/FlpContext';
import type { Level } from '../types';
import { Badge, Card } from './ui';

/**
 * 노후 진단: 지금 방식(생활비 그대로)과 하락장 가드레일(시장이 최고점보다 drop% 이상 낮은 해 생활비 cut% 감축)의 성공확률 비교.
 * 같은 시드(42)·같은 횟수로 돌려 두 방식이 같은 시장 경로를 지나므로 차이는 가드레일 효과만 남음
 */
export function GuardrailCompare() {
  const { planInput: inp, profile: p, sim, start } = useFlp();
  const { guardrailDrop: drop, guardrailCut: cut, successTarget: target } = p.criteria;
  const on = cut > 0 && drop > 0;
  const gsim = useMemo(() => (on ? simulate({ ...inp, guardrail: { drop, cut } }, 1000) : null), [inp, on, drop, cut]);
  const lvl = (v: number): Level => (v >= target ? 'good' : v >= 60 ? 'caution' : 'danger');

  if (!gsim) {
    return (
      <Card title="하락장 가드레일 비교" className="mt-4">
        <p className="text-sm text-muted">‘데이터·설정 → 점검 기준’에서 하락장 기준과 하락장 생활비 감축을 0보다 크게 넣으면 하락장에 생활비를 줄였을 때의 성공확률을 함께 보여 줍니다.</p>
      </Card>
    );
  }

  // 하락장 해에 줄어드는 월 생활비(은퇴 첫해·지금 기준, 오늘 물가)
  const living = inp.fixedDraw !== undefined ? inp.fixedDraw * nominalFactor(0, inp.inflation, start.age - Math.max(inp.currentAge, inp.retireAge)) : expenseAt(inp, start.age);
  const cutMonthly = (living * cut) / 100 / 12;
  const delta = gsim.successRate - sim.successRate;
  const cols: { key: string; label: string; desc: string; s: SimResult }[] = [
    { key: 'now', label: '지금 방식', desc: '하락장에도 생활비 그대로', s: sim },
    { key: 'guard', label: '하락장 가드레일', desc: `하락장인 해 생활비 ${cut}% 감축`, s: gsim },
  ];

  return (
    <Card title="하락장 가드레일 비교" className="mt-4" action={<span className="text-xs text-muted">최고점 대비 −{drop}% 이하인 해 · 생활비 −{cut}%</span>}>
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
              {key === 'guard' && <span className={`text-sm font-semibold ${delta > 0.05 ? 'text-good' : 'text-muted'}`}>{delta >= 0 ? '+' : '−'}{Math.abs(delta).toFixed(1)}%p</span>}
            </div>
            <div className="mt-1 text-xs">
              고갈 나이 중앙값 <b>{s.medianDepletionAge === null ? `${p.lifeExpectancy}세까지 유지` : `${s.medianDepletionAge}세`}</b>
              {key === 'guard' && <> · 생활비 줄인 해 평균 <b>{gsim.cutYearsAvg.toFixed(1)}년</b></>}
            </div>
          </div>
        ))}
      </div>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">
        <li>하락장: 시장(명목 누적수익률)이 그때까지의 최고점보다 {drop}% 이상 낮은 해입니다. 자산에서 꺼낸 돈은 빼고 시장 흐름만으로 판단합니다.</li>
        <li>하락장인 해에는 은퇴 후 생활비{inp.fixedDraw !== undefined ? '(연금 생활비 고정액)' : ''}를 {cut}% 줄입니다. {start.age}세 기준 월 약 {won(cutMonthly)}입니다. 시장이 회복해 최고점 대비 낙폭이 {drop}% 안으로 들어오면 원래 생활비로 돌아갑니다. 대출 상환·목표 탭 지출·보험료는 줄이지 않습니다.</li>
        <li>두 방식 모두 같은 1,000가지 시장 경로로 계산해 차이는 가드레일 효과만 나타냅니다. 위 성공확률·처방·민감도는 지금 방식 기준입니다.</li>
        <li>노후 인출의 ‘가드레일’ 전략은 평균수익 계획의 기준선과 자산을 비교하는 다른 방식입니다. 기준은 ‘데이터·설정 → 점검 기준’에서 바꿉니다.</li>
      </ul>
    </Card>
  );
}
