import { useSyncExternalStore } from 'react';
import { clearUndo, joinInDb, subscribeUndo, undoEntry, undoLast } from '../db/accountOps';
import { groupOf, NATURE_LABEL } from '../engine/portfolio';
import { joinPlan } from '../engine/rebalance';
import { won } from '../lib/format';
import type { Asset } from '../types';

/** 합친 한 줄의 값(금액·성격·기대수익률·변동성·과세제외·퇴직금 재원)을 한 줄 문장으로 */
export function joinSummary(m: Asset) {
  return [
    won(m.amount),
    NATURE_LABEL[m.nature],
    `기대수익률 ${m.expectedReturn}%`,
    `변동성 ${m.volatility}`,
    `과세제외 ${won(m.taxFree ?? 0)}`,
    `퇴직금 재원 ${won(m.retirePart ?? 0)}`,
  ].join(' · ');
}

/** 합치기 확인창 문구. 합칠 줄이 없으면 null */
export function joinConfirmText(a: Asset, assets: Asset[]): string | null {
  const plan = joinPlan(a, assets);
  if (!plan) return null;
  return [
    `‘${groupOf(a)}’ 계좌로 묶인 ${plan.remove.length + 1}줄을 한 줄로 합칠까요?`,
    `합친 결과: ${joinSummary(plan.put[0])}`,
    '',
    '금액·과세제외·퇴직금 재원은 더하고, 기대수익률·변동성은 금액가중 평균, 성격은 금액이 많은 쪽을 따릅니다.',
    '나눌 때 새 줄에는 가진 같은 성격 자산의 평균 수익률·변동성을 넣었으므로, 나누기 전 값과 다를 수 있습니다. 필요하면 합친 뒤 고치세요.',
    '합친 바로 뒤에는 ‘되돌리기’로 되돌릴 수 있습니다.',
  ].join('\n');
}

/** 같은 계좌로 묶인 줄을 확인받고 한 줄로 합쳐 저장 */
export async function applyJoin(a: Asset, assets: Asset[]) {
  const text = joinConfirmText(a, assets);
  if (!text || !window.confirm(text)) return;
  try {
    await joinInDb(a);
  } catch (e) {
    window.alert(`합치지 못했습니다: ${e instanceof Error ? e.message : e}`);
  }
}

/** ‘한 줄로 합치기’ 버튼과 합친 결과 미리보기. 같은 계좌로 묶인 줄이 둘 이상일 때만 보임 */
export function JoinAccount({ a, assets, className = '' }: { a: Asset; assets: Asset[]; className?: string }) {
  const plan = joinPlan(a, assets);
  if (!plan) return null;
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${className}`}>
      <button type="button" className="rounded-lg border border-line bg-surface px-2 py-1 text-xs font-semibold text-ink transition hover:bg-sunken" onClick={() => void applyJoin(a, assets)}>
        한 줄로 합치기
      </button>
      <span className="min-w-0 text-xs text-muted">
        ‘{groupOf(a)}’ {plan.remove.length + 1}줄 → {joinSummary(plan.put[0])}
      </span>
    </div>
  );
}

/** 바로 앞 ‘자산 탭에 반영’·‘한 줄로 합치기’를 되돌리는 줄. 되돌릴 것이 없으면 안 보임 */
export function UndoBar({ className = '' }: { className?: string }) {
  const e = useSyncExternalStore(subscribeUndo, undoEntry, () => null);
  if (!e) return null;
  const undo = async () => {
    try {
      let res = await undoLast();
      if (res === 'changed') {
        if (!window.confirm(`그 뒤 자산 탭이나 인출 기록을 고쳤습니다. 되돌리면 ${e.label} 바로 앞 상태로 돌아가 그 뒤에 고친 내용도 사라집니다. 되돌릴까요?`)) return;
        res = await undoLast(true);
      }
    } catch (err) {
      window.alert(`되돌리지 못했습니다: ${err instanceof Error ? err.message : err}`);
    }
  };
  return (
    <div role="status" className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-sunken px-3 py-2 text-xs ${className}`}>
      <span className="min-w-0 text-muted">방금 저장한 작업: {e.label}</span>
      <button type="button" className="rounded-lg border border-line bg-surface px-2 py-1 font-semibold text-ink transition hover:bg-sunken" onClick={() => void undo()}>
        되돌리기
      </button>
      <button type="button" className="font-medium text-muted hover:underline" onClick={clearUndo}>
        닫기
      </button>
    </div>
  );
}
