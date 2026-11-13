import { db } from '../db/db';
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

/**
 * 같은 계좌로 묶인 연금계좌 줄을 한 줄로 합쳐 저장(한 트랜잭션): 금액·과세제외·퇴직금 재원은 합계,
 * 기대수익률·변동성은 금액가중 평균, 처음 줄에 합치고 나머지 줄은 지움. 저장할 때 최신 자산으로 다시 계산.
 */
export async function applyJoin(a: Asset, assets: Asset[]) {
  const plan = joinPlan(a, assets);
  if (!plan) return;
  const g = groupOf(a);
  const ok = window.confirm(
    `‘${g}’ 계좌로 묶인 ${plan.remove.length + 1}줄을 한 줄로 합칠까요?\n합친 결과: ${joinSummary(plan.put[0])}\n\n금액·과세제외·퇴직금 재원은 더하고, 기대수익률·변동성은 금액가중 평균, 성격은 금액이 많은 쪽을 따릅니다. 되돌리려면 자산 탭에서 직접 나눠야 합니다.`,
  );
  if (!ok) return;
  try {
    await db.transaction('rw', db.assets, async () => {
      const now = joinPlan(a, await db.assets.toArray());
      if (!now) return;
      for (const v of now.put) await db.assets.put(v);
      for (const id of now.remove) await db.assets.delete(id);
    });
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
