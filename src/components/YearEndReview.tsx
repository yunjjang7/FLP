import { useMemo, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { db } from '../db/db';
import { carryBefore, carryOverPlan, carryPatch, drawTotal, undoCarryPlan, undoPatch, yearEndAccounts } from '../engine/drawLog';
import { baseBalanceAt, baseFloorAt, DEFAULT_GUARDRAIL, guardrailBaseline, rebaseDiff, refixBase, restoreBase, reviewYearEnds, yearsToYearEnd, type StrategyResult, type WithdrawInput, type YearEndPosition, type YearEndRow } from '../engine/withdrawal';
import { accountName, groupOf } from '../engine/portfolio';
import { pct, won } from '../lib/format';
import { useFlp } from '../store/FlpContext';
import type { Asset, Level, PlanBase, YearEnd } from '../types';
import { Labeled, NumberField, TextField } from './fields';
import { Badge, Button, Card } from './ui';

/** 가드레일 vs 정액 인출: 감액을 감수한 대가로 자산이 얼마나 오래 버티는지 */
export function GuardrailCompare({ fixed, guard, lifeExpectancy }: { fixed: StrategyResult; guard: StrategyResult; lifeExpectancy: number }) {
  const age = (v: number | null) => (v === null ? `${lifeExpectancy}세까지 유지` : `${v}세`);
  const rows = [
    { label: '생활비 90% 이상 매년 충족', a: pct(fixed.successRate), b: pct(guard.successRate), diff: guard.successRate - fixed.successRate as number | null, unit: '%p' },
    { label: '자산 유지 확률', a: pct(100 - fixed.depletionRate), b: pct(100 - guard.depletionRate), diff: fixed.depletionRate - guard.depletionRate as number | null, unit: '%p' },
    { label: '고갈 나이 중앙값(전체)', a: age(fixed.medianDepletionAge), b: age(guard.medianDepletionAge), diff: null as number | null, unit: '' },
    {
      label: '고갈된 경로의 고갈 나이',
      a: fixed.depletedMedianAge === null ? '없음' : `${fixed.depletedMedianAge}세`,
      b: guard.depletedMedianAge === null ? '없음' : `${guard.depletedMedianAge}세`,
      diff: fixed.depletedMedianAge !== null && guard.depletedMedianAge !== null ? guard.depletedMedianAge - fixed.depletedMedianAge : null,
      unit: '년',
    },
    { label: '인출을 줄인 시나리오', a: '-', b: pct(guard.adjustRate), diff: null as number | null, unit: '' },
  ];
  return (
    <div className="-mx-4 mt-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
      <table className="w-full min-w-[420px] text-sm num-table">
        <thead>
          <tr className="border-b border-line text-right text-xs text-muted">
            <th className="py-1.5 text-left font-medium">정액 인출과 비교</th>
            <th className="font-medium">정액</th>
            <th className="font-medium">가드레일</th>
            <th className="font-medium">차이</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-line text-right last:border-0">
              <td className="py-1.5 text-left">{r.label}</td>
              <td className="text-muted">{r.a}</td>
              <td className="font-semibold">{r.b}</td>
              <td className={r.diff === null || Math.abs(r.diff) < 0.05 ? 'text-muted' : r.diff > 0 ? 'text-good' : 'text-bad'}>
                {r.diff === null ? '' : `${r.diff > 0 ? '+' : ''}${r.unit === '년' ? r.diff : r.diff.toFixed(1)}${r.unit}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted">가드레일은 나쁜 해에 인출을 줄이므로 ‘생활비 충족’은 정액과 비슷하거나 낮을 수 있습니다. 대신 자산 유지 확률과 고갈 시점이 얼마나 나아지는지를 보세요.</p>
    </div>
  );
}

const POSITION: Record<YearEndPosition, { label: string; level: Level }> = {
  below: { label: '하단선 아래', level: 'danger' },
  inside: { label: '기준선 안', level: 'good' },
  above: { label: '상단선 위', level: 'good' },
};

/** 연말결산: 해마다 12월 말 실제 자산·인출액을 기록하고 고정한 기준선과 비교해 가드레일 판정 */
export function YearEndReview({ input, startAge, band, cut, cutOnly }: { input: WithdrawInput; startAge: number; band: number; cut: number; cutOnly: boolean }) {
  const { profile: p, yearEnds, draws, assets } = useFlp();
  const now = new Date();
  const thisYear = now.getFullYear();
  const retiredNow = startAge <= thisYear - p.birthYear;
  // 고정한 기준선이 없으면 지금 계획으로 임시 기준선
  const live = useMemo<PlanBase>(() => {
    const b = guardrailBaseline(input);
    return { savedAt: now.toLocaleDateString('sv-SE'), year: p.birthYear + startAge, month: retiredNow ? now.getMonth() + 1 : 1, inflation: input.inflation, ...b };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, startAge, p.birthYear]);
  const base = p.planBase ?? live;
  const g = { ...DEFAULT_GUARDRAIL, band, cut, raise: cut, cutOnly };
  const rows = reviewYearEnds(base, yearEnds, g);
  const last = rows[rows.length - 1];

  const defaultYear = Math.max(base.year, now.getMonth() >= 11 ? thisYear : thisYear - 1);
  const [year, setYear] = useState(defaultYear);
  const [balance, setBalance] = useState(0);
  const [withdrawn, setWithdrawn] = useState(0);
  const [note, setNote] = useState('');
  const existing = yearEnds.find((r) => r.year === year);
  // 계좌별 입력: 그 해 12월 말에 꺼낼 수 있는 금융자산마다 평가액을 넣으면 합계가 ‘12월 말 금융자산’이 됨
  const list = useMemo(() => yearEndAccounts(assets, year), [assets, year]);
  const [acct, setAcct] = useState<Record<number, number> | null>(null);
  const savedOf = (a: Asset, rec?: YearEnd) => rec?.accounts?.find((b) => (b.id !== undefined ? b.id === a.id : b.name === a.name))?.balance;
  const openAcct = (y: number) => {
    const rec = yearEnds.find((r) => r.year === y);
    setAcct(Object.fromEntries(yearEndAccounts(assets, y).map((a) => [a.id!, savedOf(a, rec) ?? a.amount])));
  };
  const acctSum = acct ? list.reduce((s, a) => s + (acct[a.id!] ?? 0), 0) : 0;
  const total = acct ? acctSum : balance;
  const pickYear = (v: number) => {
    const y = Math.round(v);
    setYear(y);
    setCarry(false);
    if (acct) openAcct(y);
  };
  const saveRecord = async () => {
    const rec: YearEnd = {
      year,
      balance: Math.round(total * 10) / 10,
      withdrawn,
      ...(note.trim() ? { note: note.trim() } : existing?.note ? { note: existing.note } : {}),
      ...(acct ? { accounts: list.map((a) => ({ id: a.id, name: a.name, balance: acct[a.id!] ?? 0 })) } : {}),
      ...(existing?.carried ? { carried: existing.carried } : {}),
    };
    if (existing) await db.yearEnds.put({ id: existing.id, ...rec });
    else await db.yearEnds.add(rec);
    setNote('');
  };
  // 이어받기: 저장한 계좌별 평가액을 자산 탭 금액으로 넘기고, 그 해 인출만큼 과세제외·퇴직금 재원을 줄임(한 번만)
  const [carry, setCarry] = useState(false);
  const [funds, setFunds] = useState(true);
  const fundsDone = existing?.carried?.funds ?? false;
  const carryRows = useMemo(() => (existing?.accounts?.length ? carryOverPlan(assets, existing.accounts, draws, year, funds && !fundsDone) : []), [assets, existing, draws, year, funds, fundsDone]);
  const fundsApply = carryOverPlan(assets, existing?.accounts ?? [], draws, year, true).some((r) => r.pension && r.drawn > 0 && (r.free > 0 || r.retire > 0));
  const applyCarry = async () => {
    if (!existing) return;
    await db.transaction('rw', [db.assets, db.yearEnds], async () => {
      for (const r of carryRows) if (r.changed && r.id !== undefined) await db.assets.update(r.id, carryPatch(r));
      await db.yearEnds.update(existing.id!, { carried: { at: new Date().toLocaleDateString('sv-SE'), funds: fundsDone || (funds && fundsApply), before: carryBefore(carryRows, existing.carried?.before) } });
    });
    setCarry(false);
  };
  // 되돌리기: 적용 직전 값(결산 기록에 저장)으로 자산을 돌리고 이어받은 표시를 지움(재원 줄이기도 다시 가능)
  const undoRows = useMemo(() => undoCarryPlan(assets, existing?.carried?.before ?? []), [assets, existing]);
  const undoCarry = async () => {
    if (!existing?.carried) return;
    const list = undoRows.filter((r) => r.changed);
    const lines = list.map((r) => `· ${r.name}: ${won(r.amount)} → ${won(r.back)}`).join('\n');
    if (!confirm(`${existing.carried.at}에 이어받기 전 값으로 되돌릴까요? 그 뒤 자산 탭에서 직접 고친 금액·과세제외·퇴직금 재원도 적용 전 값으로 돌아갑니다.${lines ? `\n${lines}` : ''}`)) return;
    const { carried: _c, ...rest } = existing;
    await db.transaction('rw', [db.assets, db.yearEnds], async () => {
      for (const r of list) await db.assets.update(r.id, undoPatch(r));
      await db.yearEnds.put(rest);
    });
    setCarry(false);
  };
  // 월별 실제 인출 기록이 있으면 그 해 합계를 바로 넣을 수 있게
  const logged = drawTotal(draws, year);
  // 판정 한 줄: ‘기준선 안(+3.7%) · 2027년 권장 월 300만원’
  const judge = (r: YearEndRow | null) =>
    r ? `${POSITION[r.position].label}(${r.record.balance >= r.baseline ? '+' : ''}${(((r.record.balance - r.baseline) / r.baseline) * 100).toFixed(1)}%)` : '판정 없음';
  const recommend = (r: YearEndRow | null) => (r ? `월 ${won(r.nextRecommended / 12)}` : '-');
  const fixBase = () => {
    if (p.planBase) {
      // 바꾸기 전에 최근 판정·다음 해 권장 인출·빠지는 결산 연도를 지금 값과 나란히 보여 줌
      const d = rebaseDiff(p.planBase, live, yearEnds, g);
      const lines = [
        `지금 계획(${live.year}년 ${live.month}월부터)으로 기준선을 다시 고정할까요?`,
        '',
        d.before || d.after
          ? `· 최근 판정(${(d.after ?? d.before)!.record.year}년 말): ${judge(d.before)} → ${judge(d.after)}`
          : '· 아직 저장한 결산이 없어 판정은 바뀌지 않습니다.',
        ...(d.before || d.after ? [`· ${(d.after ?? d.before)!.record.year + 1}년 권장 인출: ${recommend(d.before)} → ${recommend(d.after)}`] : []),
        `· 판정에서 빠지는 결산: ${d.dropped.length ? d.dropped.map((y) => `${y}년`).join(', ') + '(기록은 지워지지 않음)' : '없음'}`,
        '· 가드레일 감액·증액 누적은 새 기준선에서 처음부터 다시 셉니다.',
        '',
        `지금 기준선(${p.planBase.savedAt} 고정)은 한 단계 보관돼 ‘이전 기준선으로 되돌리기’로 돌아갈 수 있습니다.`,
      ];
      if (!confirm(lines.join('\n'))) return;
    }
    db.profile.put(refixBase(p, live));
  };
  const undoBase = () => {
    if (!p.planBasePrev) return;
    const d = rebaseDiff(p.planBase, p.planBasePrev, yearEnds, g);
    const yr = (d.after ?? d.before)?.record.year;
    const msg = [
      `${p.planBasePrev.savedAt}에 고정했던 이전 기준선으로 되돌릴까요?`,
      ...(yr ? ['', `· 최근 판정(${yr}년 말): ${judge(d.before)} → ${judge(d.after)}`, `· ${yr + 1}년 권장 인출: ${recommend(d.before)} → ${recommend(d.after)}`] : []),
      '',
      '되돌리면 지금 기준선은 보관되지 않습니다(되돌리기는 한 단계만).',
    ];
    if (!confirm(msg.join('\n'))) return;
    db.profile.put(restoreBase(p));
  };

  const lastYear = Math.max(base.year + 10, ...rows.map((r) => r.record.year + 3));
  const chart: { year: number; baseline: number; lower: number; upper: number; actual: number | null }[] = [];
  for (let y = base.year; y <= Math.min(lastYear, base.year + base.balances.length - 2); y++) {
    const bl = baseBalanceAt(base, yearsToYearEnd(base, y));
    chart.push({ year: y, baseline: bl, lower: baseFloorAt(base, yearsToYearEnd(base, y)) * (1 - band), upper: bl * (1 + band), actual: yearEnds.find((r) => r.year === y)?.balance ?? null });
  }
  const gap = last ? ((last.record.balance - last.baseline) / last.baseline) * 100 : 0;

  return (
    <Card
      title="연말결산 — 계획 대비 실제"
      className="mt-4"
      action={
        <div className="flex flex-col items-end gap-1">
          <div className="flex flex-wrap justify-end gap-2">
            {p.planBasePrev && <Button variant="ghost" onClick={undoBase}>이전 기준선으로 되돌리기</Button>}
            <Button variant="ghost" onClick={fixBase}>{p.planBase ? '기준선 다시 고정' : '지금 계획을 기준선으로 고정'}</Button>
          </div>
          {p.planBase && <span className="hidden max-w-[18rem] text-right sm:block lg:max-w-none lg:whitespace-nowrap text-[11px] leading-snug text-muted">계획(은퇴 시점·생활비·수익률)을 바꿨을 때만 누르세요. 자산이 줄었다고 누르면 판정이 의미를 잃습니다.</span>}
        </div>
      }
    >
      <p className="text-xs text-muted">
        {p.planBase
          ? `기준선: ${p.planBase.savedAt}에 고정한 계획(평균수익·정액 인출 경로를 물가 ${p.planBase.inflation}%로 환산한 그 해 금액)입니다. 자산을 고쳐도 기준선은 바뀌지 않습니다.`
          : '아직 기준선을 고정하지 않아 지금 계획으로 임시 계산했습니다. 자산을 고칠 때마다 기준선도 바뀌므로, 계획을 확정했으면 ‘기준선으로 고정’을 누르세요.'}
        {/* 휴대폰에서는 버튼 옆이 좁아 안내를 여기로 */}
        {p.planBase && <span className="sm:hidden"> ‘기준선 다시 고정’은 은퇴 시점·생활비·수익률 같은 계획을 바꿨을 때만 누르세요.</span>}
      </p>

      {last && (
        <div className={`mt-3 rounded-xl px-3 py-2.5 text-sm ${last.position === 'below' ? 'bg-bad-soft' : 'bg-good-soft'}`}>
          <b>{last.record.year}년 말 판정: {POSITION[last.position].label}</b> — 실제 {won(last.record.balance)} / 기준선 {won(last.baseline)} ({gap >= 0 ? '+' : ''}{gap.toFixed(1)}%).{' '}
          {last.record.year + 1}년 권장 자산 인출 <b>월 {won(last.nextRecommended / 12)}</b>
          {last.multiplier !== 1 && <> (계획 월 {won(last.nextPlan / 12)}의 {Math.round(last.multiplier * 100)}%)</>}
          {last.position === 'below' ? ' · 하락장이면 주식 매도는 미루고 현금성·채권에서 꺼내세요.' : last.position === 'above' && cutOnly && last.multiplier >= 1 ? ' · 감액만 방식이라 계획보다 늘리지 않습니다.' : ''}
        </div>
      )}

      {/* 금융자산 칸은 안내 문구가 한 줄에 들어가게 넓히고, 저장 버튼은 메모 아래 오른쪽 */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[7rem_minmax(16.5rem,1.6fr)_1fr_1fr]">
        <Labeled label="결산 연도"><NumberField value={year} unit="년" onChange={pickYear} /></Labeled>
        <Labeled label="12월 말 금융자산" hint={acct ? '아래 계좌별 평가액의 합계' : '평가액 합계(명목) · 수령 전 노란우산 등 제외'}>
          {acct ? <div className="py-1.5 text-lg font-bold">{won(acctSum)}</div> : <NumberField value={balance} unit="만원" onChange={setBalance} />}
          {list.length > 0 && (
            <button type="button" className="mt-1 block max-w-full truncate whitespace-nowrap text-[11px] text-brand hover:underline" title={acct ? undefined : '계좌별 평가액을 넣고 다음 해 계획에 이어받기'} onClick={() => (acct ? (setBalance(Math.round(acctSum * 10) / 10), setAcct(null)) : openAcct(year))}>
              {acct ? '합계만 입력' : '계좌별로 입력(다음 해 계획에 이어받기)'}
            </button>
          )}
        </Labeled>
        <Labeled label="그 해 실제 인출" hint="계좌에서 꺼낸 합계">
          <NumberField value={withdrawn} unit="만원" onChange={setWithdrawn} />
          {logged > 0.5 && Math.abs(logged - withdrawn) > 0.5 && (
            <button type="button" className="mt-1 block text-[11px] text-brand hover:underline" onClick={() => setWithdrawn(Math.round(logged * 10) / 10)}>월별 기록 합계 {won(logged)} 넣기</button>
          )}
        </Labeled>
        <Labeled label="메모(선택)"><TextField value={note} onChange={setNote} /></Labeled>
        <div className="self-end lg:col-start-4 lg:justify-self-end">
          <Button onClick={saveRecord} disabled={total <= 0}>{existing ? '결산 고치기' : '결산 저장'}</Button>
        </div>
      </div>

      {acct && (
        <div className="mt-3 rounded-xl bg-sunken p-3">
          <div className="text-xs text-muted">{year}년 12월 말 계좌별 평가액(명목) — 처음에는 자산 탭의 지금 금액이 들어 있습니다. 증권사·은행 앱의 12월 말 평가액으로 고친 뒤 저장하세요.</div>
          <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {list.map((a) => {
              const d = a.type === 'pension' ? drawTotal(draws.filter((r) => r.account === accountName(a)), year) : 0;
              return (
                <Labeled key={a.id} label={a.name || '이름 없음'} hint={`자산 탭 ${won(a.amount)}${d > 0.5 ? ` · 그 해 ${groupOf(a) ? `${accountName(a)} 계좌 ` : ''}인출 ${won(d)}` : ''}`}>
                  <NumberField value={acct[a.id!] ?? 0} unit="만원" min={0} onChange={(v) => setAcct({ ...acct, [a.id!]: v })} />
                </Labeled>
              );
            })}
          </div>
        </div>
      )}

      {existing?.accounts?.length ? (
        <div className="mt-3 rounded-xl border border-line p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <b>{year + 1}년 계획에 이어받기</b>
              <span className="ml-2 text-xs text-muted">
                {existing.carried ? `${existing.carried.at}에 이어받음` : `${year}년 말 계좌별 평가액을 자산 탭 금액으로 넘깁니다`}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {existing.carried?.before?.length ? <Button variant="ghost" onClick={undoCarry}>이어받기 되돌리기</Button> : null}
              <Button variant="ghost" onClick={() => setCarry(!carry)}>{carry ? '닫기' : existing.carried ? '바뀔 내용 다시 보기' : '바뀔 내용 보기'}</Button>
            </div>
          </div>
          {carry && (
            <>
              <div className="-mx-3 mt-2 overflow-x-auto px-3">
                <table className="w-full min-w-[560px] text-sm num-table">
                  <thead>
                    <tr className="border-b border-line text-right text-xs text-muted">
                      <th className="py-1.5 text-left font-medium">계좌</th>
                      <th className="font-medium">자산 탭 금액</th>
                      <th className="font-medium">그 해 인출<div className="font-normal">월별 기록</div></th>
                      <th className="font-medium">과세제외 금액</th>
                      <th className="font-medium">퇴직금 재원</th>
                    </tr>
                  </thead>
                  <tbody>
                    {carryRows.map((r) => {
                      const move = (a: number, b: number) => (Math.abs(a - b) > 0.05 ? <>{won(a)} → <b>{won(b)}</b></> : a > 0 ? won(a) : '-');
                      return (
                        <tr key={r.id ?? r.name} className={`border-b border-line text-right last:border-0 ${r.changed ? '' : 'text-muted'}`}>
                          <td className="py-1.5 text-left">{r.name}</td>
                          <td className="whitespace-nowrap">{move(r.amount, r.next)}</td>
                          <td>{r.pension && r.drawn > 0.5 ? won(r.drawn) : '-'}</td>
                          <td className="whitespace-nowrap">{r.pension ? move(r.free, r.freeNext) : '-'}</td>
                          <td className="whitespace-nowrap">{r.pension ? move(r.retire, r.retireNext) : '-'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {fundsApply && !fundsDone && (
                <label className="mt-2 flex items-start gap-2 text-xs">
                  <input type="checkbox" className="mt-0.5" checked={funds} onChange={(e) => setFunds(e.target.checked)} />
                  <span>그 해 실제 인출(월별 기록)만큼 과세제외 금액 → 퇴직금 재원 순서로 줄이기. 자산 탭의 두 금액을 이미 인출 뒤 값으로 고쳐 두었다면 끄세요(두 번 빠집니다).</span>
                </label>
              )}
              {fundsDone && <p className="mt-2 text-xs text-muted">과세제외·퇴직금 재원은 이미 한 번 줄였으므로 다시 줄이지 않고, 금액만 넘깁니다.</p>}
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <Button onClick={applyCarry} disabled={!carryRows.some((r) => r.changed)}>자산 탭에 적용</Button>
                <span className="text-xs text-muted">
                  {carryRows.some((r) => r.changed) ? '적용하면 노후 진단·인출 계획이 이 금액에서 다시 계산됩니다. 연금수령연차는 해가 바뀌면 자동으로 올라갑니다.' : '자산 탭이 이미 이 금액과 같습니다.'}
                </span>
              </div>
            </>
          )}
        </div>
      ) : null}

      {rows.length > 0 && (
        <>
          <div className="mt-4 h-56">
            <ResponsiveContainer>
              <LineChart data={chart} margin={{ left: 0, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="year" tickLine={false} axisLine={false} minTickGap={16} />
                <YAxis tickFormatter={(v) => won(v, false)} width={56} tickLine={false} axisLine={false} />
                <Tooltip labelFormatter={(y) => `${y}년 말`} formatter={(v: number) => won(v)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line dataKey="upper" name="상단선" stroke="var(--c-muted)" strokeDasharray="4 4" dot={false} isAnimationActive={false} />
                <Line dataKey="baseline" name="기준선" stroke="var(--chart-1)" strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line dataKey="lower" name="하단선" stroke="var(--c-bad)" strokeDasharray="4 4" dot={false} isAnimationActive={false} />
                <Line dataKey="actual" name="실제" stroke="var(--chart-4)" strokeWidth={2} dot={{ r: 4 }} connectNulls isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="-mx-4 mt-3 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
            <table className="w-full min-w-[720px] text-sm num-table">
              <thead>
                <tr className="border-b border-line text-right text-xs text-muted">
                  <th className="py-1.5 text-left font-medium">연도</th>
                  <th className="font-medium">기준선</th>
                  <th className="font-medium">실제 자산</th>
                  <th className="font-medium">판정</th>
                  <th className="font-medium">계획 인출</th>
                  <th className="font-medium">실제 인출</th>
                  <th className="font-medium">실제 수익률<div className="font-normal">추정</div></th>
                  <th className="font-medium">다음 해 권장(월)</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.record.year} className="border-b border-line text-right last:border-0">
                    <td className="py-1.5 text-left font-medium">
                      {r.record.year}
                      {r.record.note && <span className="ml-1 text-xs font-normal text-muted">{r.record.note}</span>}
                    </td>
                    <td className="text-muted">{won(r.baseline)}</td>
                    <td className="font-semibold">{won(r.record.balance)}</td>
                    <td><Badge level={POSITION[r.position].level}>{POSITION[r.position].label}</Badge></td>
                    <td className="text-muted">{won(r.planWithdrawal)}</td>
                    <td className={r.record.withdrawn > r.planWithdrawal * 1.1 ? 'text-warn' : ''}>{won(r.record.withdrawn)}</td>
                    <td className={r.actualReturn === null ? 'text-muted' : r.actualReturn < 0 ? 'text-bad' : ''}>
                      {r.actualReturn === null ? '-' : `${r.actualReturn >= 0 ? '+' : ''}${(r.actualReturn * 100).toFixed(1)}%`}
                      {r.actualReturn !== null && r.months < 12 && <span className="ml-1 text-xs text-muted">{r.months}개월</span>}
                    </td>
                    <td className="font-semibold">{won(r.nextRecommended / 12)}</td>
                    <td>
                      <button className="text-xs text-bad hover:underline" onClick={() => confirm(`${r.record.year}년 결산을 삭제할까요?`) && db.yearEnds.delete(r.record.id!)}>삭제</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">
        <li>매년 1월에 전년도 12월 말 평가액과 그 해 실제 인출액을 넣으세요. 판정은 1년에 한 번만 하고, 연중 등락에는 반응하지 않습니다.</li>
        <li>기준선과 계획 인출액은 물가를 반영한 그 해 금액입니다. 첫해는 기준선을 고정한 달부터 12월까지만 셉니다.</li>
        <li>
          ‘기준선 다시 고정’은 누른 날의 계획(평균수익·정액 인출 경로)을 새 비교 잣대로 저장합니다. 판정·차이(%)·다음 해 권장 인출이 새 기준선으로 다시 계산되고, 가드레일 감액·증액 누적은 처음부터 다시 셉니다. 새 기준선 시작 연도보다 앞선 결산은 판정 표·그래프에서 빠집니다(기록은 남음). 저장한 결산, 자산 탭 금액, 월별 인출 기록, 인출 계획 전략 비교·세금·건보료 표, 노후 진단·처방은 바뀌지 않습니다. 바뀌는 내용은 확인 창에서 먼저 보여 주고, 직전 기준선은 한 단계 보관돼 ‘이전 기준선으로 되돌리기’로 돌아갈 수 있습니다.
        </li>
        <li>실제 수익률(추정) = 12월 말 자산 ÷ (연초 자산 − 그 해 인출) − 1입니다. 연초 자산은 직전 해 결산값(첫해는 기준선을 고정할 때의 자산)을 쓰고, 직전 해 결산이 없으면 계산하지 않습니다. 연중에 넣은 돈(추가 납입·일시금 수령)이 있으면 그만큼 높게 나옵니다.</li>
        <li>‘계좌별로 입력’으로 저장하면 ‘이어받기’로 자산 탭 금액을 12월 말 평가액으로 한 번에 바꾸고, 연금계좌는 그 해 실제 인출(월별 기록)만큼 과세제외 금액·퇴직금 재원도 줄일 수 있습니다. 잘못 적용했으면 ‘이어받기 되돌리기’로 적용 직전 값으로 돌아갑니다. 합계만 넣었다면 ‘기본 정보 → 자산’ 금액을 직접 12월 말 평가액으로 고쳐야 노후 진단·인출 계획이 그 값에서 다시 계산됩니다.</li>
      </ul>
    </Card>
  );
}
