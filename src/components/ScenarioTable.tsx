import { useMemo, useState } from 'react';
import type { CompareBase } from '../engine/orderCompare';
import { balanceAt, checkAges, lumpGrid, lumpTotal, returnScenarios, type ReturnScenario } from '../engine/scenarios';
import { pct, won } from '../lib/format';
import { Labeled, NumberField } from './fields';
import { sensitivityExpenses } from './Sensitivity';
import { Card } from './ui';

const LUMP_FACTORS = [0, 0.5, 0.75, 1, 1.25, 1.5];

/**
 * 엑셀 대시보드 ‘우물 건강도’(수익률 시나리오별 80·90·100세 잔액)와 ‘민감도’ 시트의 목돈 지출 표.
 * 매년 그 수익률만 났다고 본 평균 경로이고, 연금계좌가 있으면 연금 세금을 반영한 잔액.
 */
export function ScenarioTable({ base }: { base: CompareBase }) {
  const p = base.profile;
  const inp = base.input;
  const baseReturn = inp.meanReturn;
  const [low, setLow] = useState(() => Math.max(0, +(baseReturn - 2).toFixed(1)));
  const [high, setHigh] = useState(() => +(baseReturn + 2).toFixed(1));
  const [pick, setPick] = useState<ReturnScenario['key']>('low');
  const startYear = p.birthYear + inp.startAge;
  const [fromYear, setFromYear] = useState(startYear);

  const scenarios = useMemo(() => returnScenarios(base, low, high), [base, low, high]);
  const ages = checkAges(inp);
  const lastAge = inp.endAge - 1;
  const taxed = scenarios[0]?.taxed ?? false;

  // 목돈 민감도: 생활비(또는 고정 인출액) × 목표 탭 지출 배율
  const fromAge = Math.max(inp.startAge, Math.round(fromYear) - p.birthYear);
  const lumps = lumpTotal(inp.extras, fromAge);
  const drawMode = inp.fixedDraw !== undefined;
  const baseMonthly = Math.round((drawMode ? inp.fixedDraw ?? 0 : inp.expenseAnnual) / 12);
  const livings = useMemo(() => (baseMonthly > 0 ? sensitivityExpenses(baseMonthly) : []), [baseMonthly]);
  const chosen = scenarios.find((s) => s.key === pick) ?? scenarios[0];
  const grid = useMemo(
    () => (lumps > 0.5 && livings.length ? lumpGrid(base, livings.map((e) => e / baseMonthly), LUMP_FACTORS, fromAge, chosen.meanReturn) : []),
    [base, livings, baseMonthly, fromAge, chosen.meanReturn, lumps],
  );
  const cur = { row: livings.indexOf(baseMonthly), col: LUMP_FACTORS.indexOf(1) };
  // 대응책 요약: 기대수명까지 유지되는 가장 큰 생활비(목돈 그대로) · 가장 큰 목돈 배율(생활비 그대로)
  const maxLiving = grid.length ? livings.filter((_, i) => grid[i][cur.col] === null).pop() : undefined;
  const maxLump = grid.length && cur.row >= 0 ? LUMP_FACTORS.filter((_, j) => grid[cur.row][j] === null).pop() : undefined;

  const dep = (v: number | null) => (v === null ? { text: '유지', cls: 'bg-good-soft text-good' } : { text: `${v}세`, cls: v >= p.lifeExpectancy - 10 ? 'bg-warn-soft text-warn' : 'bg-bad-soft text-bad' });
  const money = (v: number | null) => (v === null ? '-' : v <= 0.5 ? <span className="text-bad">0</span> : won(v));

  return (
    <Card title="수익률 시나리오별 잔액 · 목돈 지출 민감도" className="mt-4" action={<span className="text-xs text-muted">평균 경로 · 오늘 물가{taxed ? ' · 연금 세금 반영' : ''}</span>}>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,160px)_minmax(0,160px)_minmax(0,1fr)]">
        <Labeled label="비관 수익률" hint={`기본 ${baseReturn.toFixed(1)}%`}>
          <NumberField value={low} unit="%" step={0.5} onChange={setLow} />
        </Labeled>
        <Labeled label="낙관 수익률">
          <NumberField value={high} unit="%" step={0.5} onChange={setHigh} />
        </Labeled>
        <p className="self-center text-xs text-muted">
          은퇴 후 수익률이 해마다 이 값으로만 났을 때의 연말 잔액입니다. 위 전략 카드의 확률(오르내리는 시장 1,000가지)과 달리 한 가지 경로이므로, 비관 수익률에서도 버티는지 보는 용도로 쓰세요.
        </p>
      </div>

      <div className="-mx-4 mt-3 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
        <table className="w-full min-w-[560px] text-sm num-table">
          <thead>
            <tr className="border-b border-line text-right text-xs text-muted">
              <th className="py-1.5 text-left font-medium">시나리오</th>
              <th className="font-medium">수익률</th>
              {ages.map((a) => <th key={a} className="font-medium">{a}세<div className="font-normal">{p.birthYear + a}년 말</div></th>)}
              <th className="font-medium">{lastAge}세<div className="font-normal">마지막 해</div></th>
              <th className="font-medium">자산 고갈</th>
              {taxed && <th className="font-medium">세금 합계</th>}
            </tr>
          </thead>
          <tbody>
            {scenarios.map((s) => (
              <tr key={s.key} className={`border-b border-line text-right last:border-0 ${s.key === 'base' ? 'font-semibold' : ''}`}>
                <td className="py-1.5 text-left">{s.label}</td>
                <td>{pct(s.meanReturn, 1)}</td>
                {ages.map((a) => <td key={a}>{money(balanceAt(s, a))}</td>)}
                <td>{money(s.endBalance)}</td>
                <td className={s.depletedAge === null ? 'text-good' : s.depletedAge >= p.lifeExpectancy - 10 ? 'text-warn' : 'text-bad'}>{s.depletedAge === null ? `${p.lifeExpectancy}세까지 유지` : `${s.depletedAge}세`}</td>
                {taxed && <td className="font-normal text-muted">{won(s.totalTax)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {grid.length > 0 ? (
        <div className="mt-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">목돈 지출 민감도 — 자산이 바닥나는 나이</div>
              <div className="text-xs text-muted">세로: {drawMode ? '월 고정 인출액' : '월 생활비'} · 가로: 목표 탭 지출(목적자금·반복 지출)을 몇 %로 줄이거나 늘릴지</div>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <Labeled label="바꿀 첫 해" hint="이 해부터의 지출만 조정">
                <div className="w-28"><NumberField value={fromYear} unit="년" min={startYear} onChange={(v) => setFromYear(Math.round(v))} /></div>
              </Labeled>
              <div className="flex rounded-lg bg-sunken p-0.5 text-xs">
                {scenarios.map((s) => (
                  <button key={s.key} onClick={() => setPick(s.key)} className={`whitespace-nowrap rounded-md px-2 py-1.5 font-medium ${pick === s.key ? 'bg-surface shadow-sm' : 'text-muted'}`}>
                    {s.label} {s.meanReturn.toFixed(1)}%
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="-mx-4 mt-2 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="text-xs text-muted">
                  <th className="py-1.5 text-left font-medium">{drawMode ? '월 고정 인출액' : '월 생활비'} \ 목돈 지출</th>
                  {LUMP_FACTORS.map((f) => (
                    <th key={f} className={`font-medium ${f === 1 ? 'text-ink' : ''}`}>{Math.round(f * 100)}%<div className="font-normal">{won(lumps * f)}</div></th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {livings.map((e, i) => (
                  <tr key={e}>
                    <td className={`whitespace-nowrap py-1 pr-2 ${i === cur.row ? 'font-semibold' : 'text-muted'}`}>{won(e)}</td>
                    {LUMP_FACTORS.map((f, j) => {
                      const c = dep(grid[i][j]);
                      return (
                        <td key={f} className="p-0.5">
                          <div className={`rounded-md py-1.5 text-center font-semibold ${c.cls} ${i === cur.row && j === cur.col ? 'ring-2 ring-ink' : ''}`}>{c.text}</div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted">
            {chosen.label} 수익률 {chosen.meanReturn.toFixed(1)}%가 이어질 때입니다. ‘유지’는 {p.lifeExpectancy}세까지 자산이 남는다는 뜻이고, 테두리 칸이 지금 계획입니다. {fromAge > inp.startAge ? `${p.birthYear + fromAge}년 전의 지출은 그대로 두었습니다. ` : ''}
            {maxLiving !== undefined
              ? `목돈 지출을 그대로 두면 ${drawMode ? '월 고정 인출액' : '월 생활비'} ${won(maxLiving)}까지는 유지됩니다${maxLiving < baseMonthly ? '(지금보다 줄여야 함)' : ''}. `
              : '표의 범위에서는 목돈 지출을 그대로 두고 유지되는 생활비가 없습니다. '}
            {maxLump !== undefined
              ? `${drawMode ? '인출액을' : '생활비를'} 그대로 두면 목돈 지출을 ${Math.round(maxLump * 100)}%(${won(lumps * maxLump)})까지 써도 유지됩니다.`
              : cur.row >= 0 ? `${drawMode ? '인출액을' : '생활비를'} 그대로 두면 목돈 지출을 모두 없애도 바닥납니다 — 생활비부터 조정해야 합니다.` : ''}
            {' '}줄일 수 있는 목돈 지출부터 줄이고, 그래도 모자라면 생활비를 줄이는 순서를 권합니다(가드레일 참고).
          </p>
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted">은퇴 후 목표 탭 지출(목적자금·반복 지출)이 없어 목돈 지출 민감도 표는 생략했습니다. 생활비 × 수익률 민감도는 ‘노후 진단’ 화면에 있습니다.</p>
      )}
    </Card>
  );
}
