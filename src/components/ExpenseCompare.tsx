import { useMemo } from 'react';
import { debtPaymentAt, deterministicPath, expenseAt, nominalFactor, pensionAt, publicPensionAt, retireOutflowAt, simulate, type PlanInput } from '../engine/montecarlo';
import { pct, won } from '../lib/format';
import { drawCovers, retirePremiums } from '../engine/goals';
import { useFlp } from '../store/FlpContext';
import type { ExpenseMode } from '../types';
import { SetupLink } from './SetupLink';
import { Card } from './ui';

const RUNS = 500;

interface Row {
  key: string;
  mode: ExpenseMode;
  label: string;
  desc: string;
  input: PlanInput;
  /** 나이 구간별 생활비를 뺀 비교 행 */
  noSteps?: boolean;
}

/** 은퇴 후 생활비 가정(물가 연동 / 명목 고정 / 인출액 고정)별 결과 비교 */
export function ExpenseCompare({ className = 'mt-4' }: { className?: string }) {
  const { planInput: inp, retax, profile: p, start, summary } = useFlp();
  const target = p.criteria.successTarget;
  const base = Math.max(inp.currentAge, inp.retireAge);
  const later = Math.min(p.lifeExpectancy - 1, base + 20);

  const isCurrent = (r: Row) =>
    !r.noSteps && (p.expenseMode ?? 'real') === r.mode && (r.mode !== 'growth' || (r.key === 'flat' ? (p.expenseGrowth ?? 0) === 0 : true));

  const rows = useMemo<(Row & { rate: number; depleted: number | null; firstDraw: number; livingNow: number; livingLater: number })[]>(() => {
    // 고정액 방식에서 월 금액에 포함해 뺀 보험료·대출 상환은 다른 행에서는 다시 따로 지출
    const cur = drawCovers(p);
    const premiums = cur.has('premium') ? retirePremiums(summary, inp.retireAge, inp.inflation, p.lifeExpectancy) : [];
    const real: PlanInput = { ...inp, expenseGrowth: undefined, fixedDraw: undefined, goals: inp.goals.concat(premiums), debts: inp.debts?.map(({ inDraw: _, ...x }) => x) };
    // 엑셀 방식 행은 지금 생활비 방식과 상관없이 '월 금액에 포함' 설정을 따름
    const cov = drawCovers({ expenseMode: 'draw', drawIncludes: p.drawIncludes });
    const drawPart: Partial<PlanInput> = {
      ...(cov.has('premium') ? { goals: real.goals.filter((g) => !g.premium) } : {}),
      ...(cov.has('debt') ? { debts: real.debts?.map((x) => ({ ...x, inDraw: true })) } : {}),
    };
    const covNote = [cov.has('debt') && '대출 상환', cov.has('premium') && '보험료'].filter(Boolean).join('·');
    // 연금으로 쓰는 금액 고정: 직접 넣은 금액, 없으면 물가 연동 첫해 (자산 인출 + 국민·개인연금)
    const draw = p.fixedDraw && p.fixedDraw > 0 ? p.fixedDraw * 12 : Math.max(0, retireOutflowAt(real, base)) + publicPensionAt(real, base);
    const list: Row[] = [
      { key: 'real', mode: 'real', label: '물가 연동', desc: '생활비가 물가만큼 올라 생활 수준 유지', input: real },
      { key: 'flat', mode: 'growth', label: '생활비 명목 고정', desc: `생활비 월 ${won(p.retireMonthlyExpense)}을 금액 그대로 유지`, input: { ...real, expenseGrowth: 0 } },
      { key: 'draw', mode: 'draw', label: '연금 생활비 명목 고정(엑셀 방식)', desc: `연금계좌 + 국민연금으로 월 ${won(draw / 12)}을 금액 그대로 쓰고, 임대료 등은 따로 모두 씀${covNote ? ` · 이 금액에 ${covNote} 포함` : ''}`, input: { ...real, ...drawPart, fixedDraw: draw } },
    ];
    if (p.expenseMode === 'growth' && (p.expenseGrowth ?? 0) !== 0) {
      list.splice(1, 0, { key: 'growth', mode: 'growth', label: `생활비 명목 ${p.expenseGrowth}% 증가`, desc: '지금 설정', input: { ...real, expenseGrowth: p.expenseGrowth } });
    }
    // 나이 구간별 생활비가 있으면: 구간을 쓰는 행에 표시하고, 지금 설정 바로 아래에 '구간 없이 일정' 행을 붙여 비교
    if (inp.expenseSteps?.length) {
      for (const r of list) if (r.mode !== 'draw') r.desc += ' · 나이 구간별 적용';
      const i = list.findIndex((r) => isCurrent(r));
      if (i >= 0) {
        const cur = list[i];
        list.splice(i + 1, 0, {
          key: `${cur.key}-flat`,
          mode: cur.mode,
          label: '↳ 나이 구간 없이 일정',
          desc: `같은 가정에서 월 ${won(p.retireMonthlyExpense)}을 끝까지 같은 수준으로`,
          input: { ...cur.input, expenseSteps: undefined },
          noSteps: true,
        });
      }
    }
    /** 해당 나이의 월 생활비(현재가치): 인출액 고정이면 임대료 등 소득 + max(고정액, 국민·개인연금) */
    const living = (x: PlanInput, age: number) => {
      if (x.fixedDraw === undefined) return expenseAt(x, age) / 12;
      const pub = publicPensionAt(x, age);
      return (pensionAt(x, age) - pub + Math.max(pub, x.fixedDraw * nominalFactor(0, x.inflation, age - base))) / 12;
    };
    // 가정마다 인출액이 달라 연금 인출 세금도 그 가정으로 다시 계산
    for (const r of list) r.input = retax(r.input);
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
  }, [inp, retax, summary, p.fixedDraw, p.expenseMode, p.expenseGrowth, p.retireMonthlyExpense, p.drawIncludes, p.lifeExpectancy]);

  const current = isCurrent;
  // 구간 적용(지금 설정) 대비 일정 행의 성공확률 차이
  const stepDiff = (r: Row & { rate: number }) => {
    const cur = rows.find((x) => current(x));
    return r.noSteps && cur ? r.rate - cur.rate : null;
  };
  const cut20 = (1 - nominalFactor(0, inp.inflation, 20)) * 100;
  const debtNow = debtPaymentAt(inp, base);
  const drawRow = rows.find((r) => r.key === 'draw');
  const realRow = rows.find((r) => r.key === 'real');
  // 임대료 등 연금 외 소득(월, 오늘 가치)
  const otherNow = (pensionAt(inp, base) - publicPensionAt(inp, base)) / 12;

  return (
    <Card title="생활비 가정 비교" className={className} action={<span className="text-xs text-muted">시나리오 {RUNS}개 · 현재가치</span>}>
      <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
        <table className="w-full min-w-[680px] text-sm num-table">
          <thead>
            <tr className="border-b border-line text-right text-xs text-muted">
              <th className="min-w-[200px] py-1.5 text-left font-medium">생활비 가정</th>
              <th className="font-medium">성공확률</th>
              <th className="font-medium">고갈 나이</th>
              <th className="font-medium">첫해 자산 인출</th>
              <th className="font-medium">월 생활비 {base}세</th>
              <th className="font-medium">→ {later}세</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const diff = stepDiff(r);
              return (
              <tr key={r.key} className={`border-b border-line text-right last:border-0 ${current(r) ? 'font-semibold' : ''} ${r.noSteps ? 'bg-sunken/60' : ''}`}>
                <td className={`py-2 text-left ${r.noSteps ? 'pl-3' : ''}`}>
                  <div>{r.label}{current(r) && <span className="ml-1.5 rounded bg-brand-soft px-1.5 py-0.5 text-[11px] font-medium text-brand">지금 설정</span>}</div>
                  <div className="text-xs font-normal text-muted">{r.desc}</div>
                </td>
                <td className={r.rate >= target ? 'text-good' : r.rate >= 60 ? 'text-warn' : 'text-bad'}>
                  {pct(r.rate)}
                  {diff !== null && Math.round(diff) !== 0 && <div className="text-[11px] font-normal text-muted">구간 적용 대비 {diff > 0 ? '+' : ''}{Math.round(diff)}%p</div>}
                </td>
                <td>{r.depleted === null ? `${p.lifeExpectancy}세까지 유지` : `${r.depleted}세`}</td>
                <td>{won(r.firstDraw)}/월</td>
                <td>{won(r.livingNow)}</td>
                <td className={r.livingLater < r.livingNow * 0.9 ? 'text-warn' : ''}>{won(r.livingLater)}</td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-muted">
        <li><b className="font-medium text-ink">고갈 나이</b>: 해마다 평균 수익만 난다고 볼 때 자산이 바닥나는 나이입니다.</li>
        <li>
          <b className="font-medium text-ink">첫해 자산 인출</b>: 연금계좌·투자 자산에서 꺼내는 돈입니다.
          {debtNow > 0 && ` 남은 대출 상환액(월 ${won(debtNow / 12)})이 들어 있습니다${p.drawIncludes?.includes('debt') ? '(연금 생활비 명목 고정 행은 월 금액에 포함해 따로 더하지 않음)' : ''}.`}
        </li>
        <li>
          <b className="font-medium text-ink">오른쪽 두 열</b>: 월 생활비를 오늘 돈 가치로 바꾼 금액입니다. 금액을 그대로 두면(명목 고정) 물가가 연 {inp.inflation}% 오를 때 20년 뒤 같은 돈으로 살 수 있는 것이 약 {cut20.toFixed(0)}% 줄어, {later}세 열이 작아집니다.
          {start.retired ? '' : ' 은퇴 전까지는 모든 가정에서 물가만큼 오릅니다.'}
        </li>
        {drawRow && (
          <li>
            <b className="font-medium text-ink">연금 생활비 명목 고정</b>: 연금계좌·국민연금에서 월 {won(drawRow.livingNow - otherNow)}을 금액 그대로 꺼내고, 임대료 등 다른 소득(월 {won(otherNow)})은 저축하지 않고 모두 씁니다.
            그래서 {base}세 생활비가 {won(drawRow.livingNow)}입니다.
            {realRow && drawRow.firstDraw > realRow.firstDraw && ` 물가 연동보다 자산에서 월 ${won(drawRow.firstDraw - realRow.firstDraw)}을 더 꺼내 성공확률이 낮아집니다.`}
            {' '}대출 상환액·보험료는 <SetupLink tab="profile" card="노후 계획" field="월 금액에 대출 상환액 포함">‘월 금액에 … 포함’</SetupLink>을 ‘예’로 하면 이 월 금액 안에서 내는 것으로 보고 따로 꺼내지 않습니다(지금: 대출 {p.drawIncludes?.includes('debt') ? '포함' : '따로'} · 보험료 {p.drawIncludes?.includes('premium') ? '포함' : '따로'}).
            {' '}꺼내는 금액은 그대로라 물가가 오를수록 실제 가치가 줄고, {later}세 열에는 줄어든 연금 몫과 오른 임대료가 함께 들어갑니다.
          </li>
        )}
        {inp.expenseSteps?.length ? <li><b className="font-medium text-ink">나이 구간 없이 일정</b>: 지금 설정에서 나이 구간별 생활비만 빼고 기본 생활비를 끝까지 쓴 결과입니다. 연금 생활비 명목 고정에는 나이 구간을 쓰지 않습니다.</li> : null}
        <li>
          <b className="font-medium text-ink">가정 바꾸기</b>: <SetupLink tab="profile" card="노후 계획" field="은퇴 후 생활비 변화">‘기본 정보 → 프로필 → 노후 계획’의 ‘은퇴 후 생활비 변화’</SetupLink>에서 고릅니다.
        </li>
      </ul>
    </Card>
  );
}
