import { useEffect, useMemo, useRef, useState } from 'react';
import { downloadText, drawsFromCSV, drawsTemplateCSV, drawsToCSV } from '../db/csv';
import { importDraws, saveDraw } from '../db/db';
import { drawYears, monthKey, OTHER_ACCOUNT, reviewDraws } from '../engine/drawLog';
import type { TaxResult } from '../engine/tax';
import { pct, won } from '../lib/format';
import { useFlp } from '../store/FlpContext';
import { groupDigits, SelectField } from './fields';
import { Badge, Button, Card } from './ui';

const round1 = (v: number) => Math.round(v * 10) / 10;

/** 표 안 금액 입력칸: 빈칸이면 계획 금액을 흐리게 보여 주고, 포커스를 벗어날 때 저장 */
function Cell({ value, plan, label, onSave }: { value: number; plan: number; label: string; onSave: (v: number) => void }) {
  const show = (v: number) => (v > 0 ? groupDigits(String(round1(v))) : '');
  const [text, setText] = useState(show(value));
  useEffect(() => setText(show(value)), [value]);
  return (
    <input
      className="w-full min-w-[68px] rounded-md border border-line bg-surface px-1.5 py-1 text-right text-sm outline-none placeholder:text-muted/60 focus:border-brand focus:ring-2 focus:ring-brand-soft"
      inputMode="decimal"
      aria-label={label}
      value={text}
      placeholder={plan > 0.05 ? groupDigits(String(round1(plan))) : ''}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      onBlur={() => {
        const n = Number(text.replace(/[,\s]/g, ''));
        const v = text.trim() === '' || !Number.isFinite(n) || n < 0 ? 0 : n;
        if (Math.abs(v - value) > 1e-9) onSave(v);
        else setText(show(value));
      }}
    />
  );
}

/**
 * 엑셀 ‘월별인출표’: 달마다 계좌에서 실제로 꺼낸 세전 금액을 적어 ‘계좌별 인출 지시’ 계획과 비교.
 * 연 누적이 계좌별 연금수령한도를 넘으면 빨갛게 표시.
 */
export function DrawLog({ tax, firstMonths, hasSpouse }: { tax: TaxResult; firstMonths: number; hasSpouse: boolean }) {
  const { draws } = useFlp();
  const now = new Date();
  const nowYear = now.getFullYear();
  const nowMonth = now.getMonth() + 1;
  const planYear0 = tax.rows[0]?.year ?? nowYear;
  // 고를 수 있는 해: 기록이 있는 해 + 계획 첫해부터 내년까지
  const years = useMemo(() => {
    const set = new Set(drawYears(draws));
    for (let y = planYear0; y <= Math.max(planYear0, nowYear + 1); y++) if (tax.rows.some((r) => r.year === y)) set.add(y);
    return [...set].sort((a, b) => a - b);
  }, [draws, tax, planYear0, nowYear]);
  const [picked, setPicked] = useState(0);
  const year = years.includes(picked) ? picked : years.includes(nowYear) ? nowYear : years[0] ?? nowYear;
  const row = tax.rows.find((r) => r.year === year);
  const firstMonth = row && row === tax.rows[0] ? 13 - Math.min(12, Math.max(1, firstMonths)) : 1;
  const rv = useMemo(() => reviewDraws(row, year, draws, { firstMonth, nowYear, nowMonth }), [row, year, draws, firstMonth, nowYear, nowMonth]);
  const [msg, setMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const over = rv.accounts.filter((a) => a.overLimit > 0.5);
  const gap = rv.actual - rv.planToDate;
  const stamp = now.toLocaleDateString('sv-SE');
  const fillPlan = async (m: number) => {
    const r = rv.rows[m - 1];
    for (const [i, a] of rv.accounts.entries()) if (a.planMonth > 0.05 && !(r.cells[i] > 0)) await saveDraw(r.month, a.name, round1(a.planMonth));
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const { rows, errors } = drawsFromCSV(await f.text());
    await importDraws(rows);
    setMsg(`${rows.length}건을 넣었습니다(같은 달·계좌는 덮어씀).${errors.length ? ` 건너뛴 줄: ${errors.slice(0, 3).join(' ')}${errors.length > 3 ? ` 외 ${errors.length - 3}건` : ''}` : ''}`);
    if (fileRef.current) fileRef.current.value = '';
  };
  const limitText = (limit: number | null) => (limit === null ? '-' : limit === Infinity ? '한도 없음' : limit <= 0 ? '수령 전' : won(limit));

  return (
    <Card
      title="월별 실제 인출 기록 — 계획 대비"
      className="mt-4"
      action={over.length > 0 ? <Badge level="danger">수령한도 초과 {over.length}개 계좌</Badge> : rv.actual > 0.5 ? <Badge level="good">한도 안</Badge> : undefined}
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="block w-32">
          <span className="mb-1 block text-xs font-medium text-muted">기록할 해</span>
          <SelectField value={String(year)} onChange={(v) => setPicked(Number(v))} options={Object.fromEntries(years.map((y) => [String(y), `${y}년`]))} />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => downloadText(`FLP_월별인출_${stamp}.csv`, drawsToCSV(draws))} disabled={draws.length === 0}>CSV 내보내기</Button>
          <Button variant="ghost" onClick={() => fileRef.current?.click()}>CSV 가져오기</Button>
          <Button variant="ghost" onClick={() => downloadText('FLP_월별인출_양식.csv', drawsTemplateCSV(monthKey(year, Math.max(rv.firstMonth, year === nowYear ? nowMonth : 1)), rv.accounts.filter((a) => a.planned).map((a) => a.name)))}>양식 내려받기</Button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
        </div>
      </div>
      {msg && <p className="mt-2 text-xs text-muted">{msg}</p>}

      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-xl bg-sunken p-3">
          <div className="text-xs text-muted">{year}년 계획(세전){rv.hasPlan && rv.months < 12 ? ` · ${rv.months}개월` : ''}</div>
          <div className="mt-0.5 text-lg font-bold">{rv.hasPlan ? won(rv.planYear) : '-'}</div>
          <div className="text-xs text-muted">{rv.hasPlan ? `월 ${won(rv.planYear / rv.months)}` : '지금 계획이 시작되기 전의 해'}</div>
        </div>
        <div className="rounded-xl bg-sunken p-3">
          <div className="text-xs text-muted">지금까지 계획</div>
          <div className="mt-0.5 text-lg font-bold">{rv.hasPlan ? won(rv.planToDate) : '-'}</div>
          <div className="text-xs text-muted">{rv.hasPlan ? `${rv.elapsed}개월분` : ''}</div>
        </div>
        <div className="rounded-xl bg-sunken p-3">
          <div className="text-xs text-muted">실제 인출 누적</div>
          <div className="mt-0.5 text-lg font-bold">{won(rv.actual)}</div>
          <div className="text-xs text-muted">세전 · 그 해 금액</div>
        </div>
        <div className="rounded-xl bg-sunken p-3">
          <div className="text-xs text-muted">계획 대비</div>
          <div className={`mt-0.5 text-lg font-bold ${!rv.hasPlan || rv.elapsed === 0 ? '' : gap > rv.planToDate * 0.1 + 0.5 ? 'text-warn' : 'text-good'}`}>
            {!rv.hasPlan || rv.elapsed === 0 ? '-' : `${gap >= 0 ? '+' : '−'}${won(Math.abs(gap))}`}
          </div>
          <div className="text-xs text-muted">{!rv.hasPlan || rv.elapsed === 0 ? '' : gap > 0.5 ? '계획보다 더 꺼냄' : gap < -0.5 ? '계획보다 덜 꺼냄' : '계획대로'}</div>
        </div>
      </div>

      {over.length > 0 && (
        <div className="mt-3 rounded-xl border border-bad/40 bg-bad-soft p-3 text-sm">
          <div className="font-semibold text-bad">올해 누적 인출이 연금수령한도를 넘었습니다</div>
          <ul className="mt-1 space-y-0.5">
            {over.map((a) => (
              <li key={a.name}>{a.name}: 누적 {won(a.actual)} / 한도 {limitText(a.limit)} — {a.limit !== null && a.limit <= 0 ? '아직 연금수령을 할 수 없는 계좌라 전액이' : `넘은 ${won(a.overLimit)}이`} 연금외수령(16.5% 또는 퇴직소득세 전액)으로 과세될 수 있습니다.</li>
            ))}
          </ul>
        </div>
      )}

      <div className="-mx-4 mt-3 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
        <table className="w-full text-sm num-table" style={{ minWidth: 320 + rv.accounts.length * 96 }}>
          <thead>
            <tr className="border-b border-line text-right text-xs text-muted">
              <th className="py-1.5 text-left font-medium">월</th>
              {rv.accounts.map((a) => (
                <th key={a.name} className="px-1 font-medium">
                  {a.name}
                  <div className="font-normal">
                    {a.planned ? (a.planMonth > 0.05 ? `계획 월 ${won(a.planMonth)}` : '계획 없음') : '지금 계획에 없는 계좌'}
                    {hasSpouse && a.owner === 'spouse' ? ' · 배우자' : ''}
                  </div>
                </th>
              ))}
              <th className="font-medium">실제 합계</th>
              <th className="font-medium">계획 합계</th>
              <th className="font-medium">차이</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rv.rows.map((r) => {
              const diff = r.actual - r.plan;
              const empty = r.actual <= 0;
              return (
                <tr key={r.month} className={`border-b border-line text-right ${!r.inPlan && empty ? 'text-muted' : ''}`}>
                  <td className="whitespace-nowrap py-1 text-left font-medium" title={r.notes.join(' / ')}>
                    {r.m}월{year === nowYear && r.m === nowMonth && <span className="ml-1 text-xs font-normal text-brand">이번 달</span>}
                  </td>
                  {rv.accounts.map((a, i) => (
                    <td key={a.name} className="px-1 py-1">
                      <Cell value={r.cells[i]} plan={r.inPlan ? a.planMonth : 0} label={`${r.m}월 ${a.name}`} onSave={(v) => saveDraw(r.month, a.name, v)} />
                    </td>
                  ))}
                  <td className="font-semibold">{empty ? '-' : won(r.actual)}</td>
                  <td className="text-muted">{r.inPlan ? won(r.plan) : '-'}</td>
                  <td className={empty || !r.inPlan ? 'text-muted' : diff > r.plan * 0.1 + 0.5 ? 'text-warn' : ''}>{empty || !r.inPlan ? '-' : Math.abs(diff) < 0.5 ? '0' : `${diff > 0 ? '+' : '−'}${won(Math.abs(diff))}`}</td>
                  <td className="whitespace-nowrap pl-2 text-left">
                    {r.inPlan && r.plan > 0.5 && rv.accounts.some((a, i) => a.planMonth > 0.05 && !(r.cells[i] > 0)) && (
                      <button className="text-xs text-brand hover:underline" onClick={() => fillPlan(r.m)}>계획대로</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-b border-line text-right font-semibold">
              <td className="whitespace-nowrap py-1.5 text-left">연 누적 실제</td>
              {rv.accounts.map((a) => <td key={a.name} className={`px-1 ${a.overLimit > 0.5 ? 'text-bad' : ''}`}>{won(a.actual)}</td>)}
              <td>{won(rv.actual)}</td>
              <td className="text-muted">{rv.hasPlan ? won(rv.planToDate) : '-'}</td>
              <td colSpan={2} />
            </tr>
            {rv.hasPlan && (
              <tr className="border-b border-line text-right text-muted">
                <td className="whitespace-nowrap py-1.5 text-left">올해 계획</td>
                {rv.accounts.map((a) => <td key={a.name} className="px-1">{a.planned ? won(a.planYear) : '-'}</td>)}
                <td />
                <td>{won(rv.planYear)}</td>
                <td colSpan={2} />
              </tr>
            )}
            {rv.hasPlan && (
              <tr className="border-b border-line text-right text-muted">
                <td className="whitespace-nowrap py-1.5 text-left">연금수령한도</td>
                {rv.accounts.map((a) => <td key={a.name} className="px-1">{limitText(a.limit)}</td>)}
                <td colSpan={4} />
              </tr>
            )}
            {rv.hasPlan && (
              <tr className="text-right">
                <td className="whitespace-nowrap py-1.5 text-left text-muted">한도 사용</td>
                {rv.accounts.map((a) => (
                  <td key={a.name} className={`px-1 ${a.overLimit > 0.5 ? 'font-semibold text-bad' : 'text-muted'}`}>
                    {a.overLimit > 0.5 ? `초과 ${won(a.overLimit)}` : a.limit !== null && a.limit !== Infinity && a.limit > 0 ? pct((a.actual / a.limit) * 100) : '-'}
                  </td>
                ))}
                <td colSpan={4} />
              </tr>
            )}
          </tfoot>
        </table>
      </div>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">
        <li>증권사에서 실제로 지급된 세전 금액(만원)을 달마다 계좌 칸에 적으세요. 빈칸의 흐린 숫자는 그 달 계획(‘계좌별 인출 지시’의 월 정기지급)이고, ‘계획대로’를 누르면 빈칸을 계획 금액으로 채웁니다. 칸을 비우면 기록이 지워집니다.</li>
        <li>연 누적 실제 인출이 계좌별 연금수령한도(연초 평가액 ÷ (11 − 연금수령연차) × 120%)를 넘으면 빨갛게 표시합니다. 한도는 지금 자산으로 계산한 값이니, 정확한 한도는 증권사 화면에서 확인하세요.</li>
        <li>계획은 지금 자산·설정으로 다시 계산한 값이라 자산을 고치면 함께 바뀝니다. {OTHER_ACCOUNT} 칸에는 연금계좌 밖(ISA·일반계좌·예금)에서 생활비로 꺼낸 돈을 적습니다(재투자로 옮긴 돈은 적지 않음).</li>
        <li>여기 적은 그 해 합계는 ‘연말결산’의 ‘그 해 실제 인출’에 바로 넣을 수 있습니다. 백업 파일에도 함께 저장됩니다.</li>
      </ul>
    </Card>
  );
}
