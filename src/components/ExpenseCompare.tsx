import { useMemo } from 'react';
import { deterministicPath, expenseAt, nominalFactor, pensionAt, publicPensionAt, retireOutflowAt, simulate, type PlanInput } from '../engine/montecarlo';
import { pct, won } from '../lib/format';
import { useFlp } from '../store/FlpContext';
import type { ExpenseMode } from '../types';
import { Card } from './ui';

const RUNS = 500;

interface Row {
  key: string;
  mode: ExpenseMode;
  label: string;
  desc: string;
  input: PlanInput;
}

/** 은퇴 후 생활비 가정(물가 연동 / 명목 고정 / 인출액 고정)별 결과 비교 */
export function ExpenseCompare({ className = 'mt-4' }: { className?: string }) {
  const { planInput: inp, profile: p, start } = useFlp();
  const target = p.criteria.successTarget;
  const base = Math.max(inp.currentAge, inp.retireAge);
  const later = Math.min(p.lifeExpectancy - 1, base + 20);

  const rows = useMemo<(Row & { rate: number; depleted: number | null; firstDraw: number; livingNow: number; livingLater: number })[]>(() => {
    const real: PlanInput = { ...inp, expenseGrowth: undefined, fixedDraw: undefined };
    // 연금으로 쓰는 금액 고정: 직접 넣은 금액, 없으면 물가 연동 첫해 (자산 인출 + 국민·개인연금)
    const draw = p.fixedDraw && p.fixedDraw > 0 ? p.fixedDraw * 12 : Math.max(0, retireOutflowAt(real, base)) + publicPensionAt(real, base);
    const list: Row[] = [
      { key: 'real', mode: 'real', label: '물가 연동', desc: '생활비가 물가만큼 올라 생활 수준 유지', input: real },
      { key: 'flat', mode: 'growth', label: '생활비 명목 고정', desc: `생활비 월 ${won(p.retireMonthlyExpense)}을 금액 그대로 유지`, input: { ...real, expenseGrowth: 0 } },
      { key: 'draw', mode: 'draw', label: '연금 생활비 명목 고정(엑셀 방식)', desc: `연금계좌 + 국민연금으로 월 ${won(draw / 12)}을 금액 그대로 쓰고, 임대료 등은 따로 모두 씀`, input: { ...real, fixedDraw: draw } },
    ];
    if (p.expenseMode === 'growth' && (p.expenseGrowth ?? 0) !== 0) {
      list.splice(1, 0, { key: 'growth', mode: 'growth', label: `생활비 명목 ${p.expenseGrowth}% 증가`, desc: '지금 설정', input: { ...real, expenseGrowth: p.expenseGrowth } });
    }
    /** 해당 나이의 월 생활비(현재가치): 인출액 고정이면 임대료 등 소득 + max(고정액, 국민·개인연금) */
    const living = (x: PlanInput, age: number) => {
      if (x.fixedDraw === undefined) return expenseAt(x, age) / 12;
      const pub = publicPensionAt(x, age);
      return (pensionAt(x, age) - pub + Math.max(pub, x.fixedDraw * nominalFactor(0, x.inflation, age - base))) / 12;
    };
    return list.map((r) => {
      const d = deterministicPath(r.input);
      return {
        ...r,
        rate: simulate(r.input, RUNS, 7).successRate,
        depleted: d.depletedAt,
        firstDraw: Math.max(0, retireOutflowAt(r.input, base)) / 12,
        livingNow: living(r.input, base),
        livingLater: living(r.input, later),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inp, p.fixedDraw, p.expenseMode, p.expenseGrowth, p.retireMonthlyExpense]);

  const current = (r: Row) =>
    (p.expenseMode ?? 'real') === r.mode && (r.mode !== 'growth' || (r.key === 'flat' ? (p.expenseGrowth ?? 0) === 0 : true));
  const cut20 = (1 - nominalFactor(0, inp.inflation, 20)) * 100;

  return (
    <Card title="생활비 가정 비교" className={className} action={<span className="text-xs text-muted">시나리오 {RUNS}개 · 현재가치</span>}>
      <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
        <table className="w-full min-w-[620px] text-sm">
          <thead>
            <tr className="border-b border-line text-right text-xs text-muted">
              <th className="py-1.5 text-left font-medium">생활비 가정</th>
              <th className="font-medium">성공확률</th>
              <th className="font-medium">고갈 나이</th>
              <th className="font-medium">첫해 자산 인출</th>
              <th className="font-medium">월 생활비 {base}세</th>
              <th className="font-medium">→ {later}세</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={`border-b border-line text-right last:border-0 ${current(r) ? 'font-semibold' : ''}`}>
                <td className="py-2 text-left">
                  <div>{r.label}{current(r) && <span className="ml-1.5 rounded bg-brand-soft px-1.5 py-0.5 text-[11px] font-medium text-brand">지금 설정</span>}</div>
                  <div className="text-xs font-normal text-muted">{r.desc}</div>
                </td>
                <td className={r.rate >= target ? 'text-good' : r.rate >= 60 ? 'text-warn' : 'text-bad'}>{pct(r.rate)}</td>
                <td>{r.depleted === null ? `${p.lifeExpectancy}세까지 유지` : `${r.depleted}세`}</td>
                <td>{won(r.firstDraw)}/월</td>
                <td>{won(r.livingNow)}</td>
                <td className={r.livingLater < r.livingNow * 0.9 ? 'text-warn' : ''}>{won(r.livingLater)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">
        고갈 나이는 매년 평균수익만 났을 때입니다. 금액을 명목 그대로 두면 물가가 연 {inp.inflation}% 오를 때 20년 뒤 실제 가치가 약 {cut20.toFixed(0)}% 줄어, 그만큼 생활 수준을 낮춘다는 뜻입니다. 오른쪽 두 열은 그 변화를 오늘 물가로 보여 줍니다.
        {start.retired ? '' : ' 은퇴 전까지는 모든 가정에서 물가만큼 오릅니다.'} 바꾸려면 ‘데이터·설정 → 프로필 → 노후 계획’에서 고릅니다.
      </p>
    </Card>
  );
}
