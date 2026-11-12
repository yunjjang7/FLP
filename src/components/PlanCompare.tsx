import { useMemo, useState, type ReactNode } from 'react';
import { db, loadPlan } from '../db/db';
import { makePlan, MAX_PLANS, metricsFrom, planMetrics, withoutPlan, withPlan, type PlanMetrics } from '../engine/plans';
import { pct, won } from '../lib/format';
import { useFlp } from '../store/FlpContext';
import type { Level, Profile, SavedPlan } from '../types';
import { Labeled, TextField } from './fields';
import { Button, Card } from './ui';

/**
 * 처방: 저장한 계획끼리 나란히 비교(예: 60세 은퇴안 vs 63세 은퇴안).
 * draft 가 있으면(What-if 로 은퇴 나이·생활비를 바꾼 상태) 그 조정안을 프로필에 덮어써 저장할 수 있음
 */
export function PlanCompare({ draft }: { draft?: Partial<Profile> }) {
  const d = useFlp();
  const p = d.profile;
  const target = p.criteria.successTarget;
  const plans = p.plans ?? [];
  const full = plans.length >= MAX_PLANS;
  const [name, setName] = useState('');

  const cur = useMemo(() => metricsFrom(p, d.summary, d.planInput, d.sim), [p, d.summary, d.planInput, d.sim]);
  // 계획마다 1,000회 시뮬레이션이라 계획 목록(추가·삭제)이 바뀔 때만 다시 계산. 오늘 날짜 기준으로 다시 돌린 값
  const planKey = plans.map((x) => x.id).join('|');
  const saved = useMemo(() => {
    const month = new Date().getMonth() + 1;
    return plans.map((x) => ({ plan: x, m: planMetrics(x, month) }));
  }, [planKey]);

  const save = (useDraft: boolean) => {
    if (full) return;
    const today = new Date().toLocaleDateString('sv-SE');
    const dr = useDraft ? draft : undefined;
    const fallback = `${dr?.retireAge ?? p.retireAge}세 은퇴 · 월 ${won(dr?.fixedDraw ?? dr?.retireMonthlyExpense ?? cur.living)}`;
    const plan = makePlan(name.trim() || fallback, d, today, useDraft ? draft : undefined);
    db.profile.put({ ...p, plans: withPlan(p.plans, plan) });
    setName('');
  };
  const load = (x: SavedPlan) => {
    if (!window.confirm(`‘${x.name}’ 계획을 불러올까요?\n지금 입력한 데이터가 이 계획으로 바뀝니다. 지금 계획을 먼저 저장했는지 확인하세요.`)) return;
    loadPlan(x).catch((e) => window.alert(`불러오지 못했습니다: ${e instanceof Error ? e.message : e}`));
  };
  const remove = (x: SavedPlan) => {
    if (!window.confirm(`‘${x.name}’ 계획을 지울까요? 되돌릴 수 없습니다.`)) return;
    db.profile.put({ ...p, plans: withoutPlan(p.plans, x.id) });
  };

  const lvl = (v: number): Level => (v >= target ? 'good' : v >= 60 ? 'caution' : 'danger');
  const tone = (l: Level) => (l === 'good' ? 'bg-good-soft text-good' : l === 'caution' ? 'bg-warn-soft text-warn' : 'bg-bad-soft text-bad');
  const until = (m: PlanMetrics) => (m.depletedAt === null ? `${m.lifeExpectancy}세까지 유지` : `${m.depletedAt}세에 바닥`);
  const rate = (m: PlanMetrics) => `${pct(m.startRate, 1)} (${m.startAge}세)`;
  // 행: 표시 문자열이 지금 계획과 다르면 굵게
  const rows: { label: string; text: (m: PlanMetrics) => string; cell?: (m: PlanMetrics, first: boolean) => ReactNode }[] = [
    { label: '은퇴 나이', text: (m) => `${m.retireAge}세` },
    { label: '은퇴 후 월 생활비', text: (m) => `${won(m.living)}${m.drawMode ? ' (고정 인출)' : ''}` },
    { label: '금융자산', text: (m) => won(m.financialAssets) },
    { label: '순자산', text: (m) => won(m.netWorth) },
    {
      label: '성공확률',
      text: (m) => m.successRate.toFixed(0),
      cell: (m, first) => {
        const diff = m.successRate - cur.successRate;
        return (
          <>
            <span className={`inline-block min-w-[56px] rounded-md px-2 py-1 font-semibold ${tone(lvl(m.successRate))}`}>{m.successRate.toFixed(0)}%</span>
            {!first && <div className="mt-0.5 text-xs text-muted">{Math.abs(diff) < 0.05 ? '차이 없음' : `${diff > 0 ? '+' : '−'}${Math.abs(diff).toFixed(1)}%p`}</div>}
          </>
        );
      },
    },
    { label: '평균 수익이면', text: until },
    { label: '첫해 인출률', text: rate },
    { label: '기대수명 때 남는 자산(중앙값)', text: (m) => won(m.endP50) },
  ];

  return (
    <Card title="계획 저장·비교" className="mt-4" action={<span className="text-xs text-muted">{plans.length}/{MAX_PLANS}개 저장</span>}>
      {full ? (
        <p className="mb-3 rounded-lg bg-sunken px-3 py-2 text-sm text-muted">계획은 최대 {MAX_PLANS}개까지 저장할 수 있습니다. 새로 저장하려면 아래 표에서 하나를 지워 주세요.</p>
      ) : (
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <div className="min-w-[200px] flex-1">
            <Labeled label="계획 이름">
              <TextField value={name} onChange={setName} placeholder="예: 63세 은퇴안 (비우면 은퇴 나이·생활비로 이름 붙임)" />
            </Labeled>
          </div>
          <Button onClick={() => save(false)}>지금 계획 저장</Button>
          {draft && <Button variant="ghost" onClick={() => save(true)}>바꾼 계획(What-if)으로 저장</Button>}
        </div>
      )}
      {draft && !full && <p className="mb-3 text-xs text-muted">바꾼 계획으로 저장하면 What-if 의 은퇴 나이·{draft.fixedDraw !== undefined ? '월 고정 인출액' : '생활비'}만 들어갑니다. 저축액·수익률 슬라이더는 실제 데이터 값이 아니라 저장되지 않습니다.</p>}

      {saved.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted">저장한 계획이 없습니다. 지금 계획에 이름을 붙여 저장해 두고, What-if 로 은퇴 나이·생활비를 바꾼 안도 저장하면 성공확률·남는 자산을 나란히 비교할 수 있습니다. 저장한 계획은 언제든 다시 불러올 수 있습니다.</p>
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
          <table className="w-full text-sm" style={{ minWidth: 160 + 140 * (saved.length + 1) }}>
            <thead>
              <tr className="align-bottom text-xs text-muted">
                <th className="py-1.5 pr-2 text-left font-medium">항목</th>
                <th className="px-1 py-1.5 text-right font-medium">
                  <div className="font-semibold text-ink">지금 계획</div>
                  <div>지금 입력값</div>
                </th>
                {saved.map(({ plan }) => (
                  <th key={plan.id} className="px-1 py-1.5 text-right font-medium">
                    <div className="truncate font-semibold text-ink" title={plan.name} style={{ maxWidth: 180, marginLeft: 'auto' }}>{plan.name}</div>
                    <div>{plan.savedAt} 저장</div>
                    <div className="mt-1 flex justify-end gap-2">
                      <button type="button" className="text-xs font-medium text-brand" onClick={() => load(plan)}>불러오기</button>
                      <button type="button" className="text-xs font-medium text-bad" onClick={() => remove(plan)}>삭제</button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const base = r.text(cur);
                return (
                  <tr key={r.label} className="border-t border-line align-top">
                    <td className="py-2 pr-2 text-muted">{r.label}</td>
                    <td className="whitespace-nowrap px-1 py-2 text-right font-semibold">{r.cell ? r.cell(cur, true) : base}</td>
                    {saved.map(({ plan, m }) => (
                      <td key={plan.id} className={`whitespace-nowrap px-1 py-2 text-right ${r.text(m) !== base ? 'font-semibold' : ''}`}>{r.cell ? r.cell(m, false) : r.text(m)}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">
        <li>저장되는 범위: 프로필·자산·부채·수입지출·재무목표·보험. 순자산 추이·연말결산·월별 인출 기록은 계획에 들어가지 않고, 불러와도 그대로 남습니다.</li>
        <li>저장한 계획의 값은 저장 당시 결과가 아니라 오늘 날짜(나이·올해 남은 달) 기준으로 다시 계산한 값입니다. 지금 계획과 다른 칸은 굵게 표시합니다.</li>
        <li>‘평균 수익이면’은 해마다 기대수익률만 났을 때 자산이 바닥나는 나이, ‘남는 자산’은 1,000가지 경로의 기대수명 때 잔액 중앙값(오늘 물가), 첫해 인출률은 인출을 시작하는 해의 꺼내 쓰는 금액 ÷ 그때 금융자산입니다.</li>
        <li>저장한 계획은 프로필에 들어 있어 백업 파일에도 함께 저장됩니다. 최대 {MAX_PLANS}개까지 저장할 수 있습니다.</li>
      </ul>
    </Card>
  );
}
