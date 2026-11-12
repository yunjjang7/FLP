import { db } from '../db/db';
import { RISK_PROFILES } from '../engine/portfolio';
import { rebalance, REBALANCE_BAND, type RebalanceMove } from '../engine/rebalance';
import { pct, won } from '../lib/format';
import { useFlp } from '../store/FlpContext';
import { Labeled, NumberField } from './fields';
import { Badge, Card } from './ui';

/** 투자 점검: 목표 투자형 비중에 맞추려면 어느 자산을 얼마나 사고팔지 */
export function RebalanceCard() {
  const { profile: p, assets, summary: s } = useFlp();
  const base = RISK_PROFILES[p.riskProfile];
  const own = (p.targetInvest ?? 0) > 0;
  const target = own ? p.targetInvest! : base.investShare;
  const r = rebalance(assets, target, p.birthYear + s.age);
  if (r.total <= 0) return null;
  const toSafe = r.shift > 0;
  const fromLabel = toSafe ? '투자형' : '안전형';
  const toLabel = toSafe ? '안전형' : '투자형';
  const afterShare = ((r.invest - r.shift) / r.total) * 100;

  const Table = ({ title, rows }: { title: string; rows: RebalanceMove[] }) => (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-semibold text-muted">{title}</div>
      <table className="w-full text-sm">
        <tbody>
          {rows.map((m) => (
            <tr key={m.name} className="border-t border-line">
              <td className="py-1.5 pr-2">
                {m.name}
                {m.pension && <span className="ml-1 text-xs text-muted">연금계좌</span>}
                <div className="text-xs text-muted">{won(m.amount)} → {won(m.after)}</div>
              </td>
              <td className={`whitespace-nowrap py-1.5 text-right font-semibold ${m.change < 0 ? 'text-bad' : 'text-good'}`}>{m.change < 0 ? '−' : '+'} {won(Math.abs(m.change))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <Card title="리밸런싱 금액 계산" className="mt-4" action={<Badge level={r.needed ? 'caution' : 'good'}>{r.needed ? '조정 필요' : '범위 안'}</Badge>}>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,12rem)_1fr] sm:items-end">
        <Labeled label="목표 투자형 비중" hint={own ? `0으로 두면 ${base.label} 권장 ${base.investShare}%` : `${base.label} 권장값 사용 중 · 직접 정하려면 입력`}>
          <NumberField value={p.targetInvest ?? 0} unit="%" min={0} onChange={(v) => db.profile.put({ ...p, targetInvest: Math.min(100, Math.max(0, v)) })} />
        </Labeled>
        <p className="text-sm">
          지금 투자형 <b>{pct(r.current)}</b> · 목표 <b>{pct(r.target)}</b> · 차이 <b className={r.needed ? 'text-warn' : ''}>{r.gap > 0 ? '+' : r.gap < 0 ? '−' : ''}{Math.abs(r.gap).toFixed(1)}%p</b>
          <span className="text-muted"> (금융자산 {won(r.total)})</span>
        </p>
      </div>

      {r.needed ? (
        <>
          <p className="mt-3 rounded-lg bg-sunken px-3 py-2 text-sm">
            {fromLabel} 자산 <b>{won(Math.abs(r.shift))}</b>을 팔아 {toLabel}으로 옮기면 투자형 비중이 <b>{pct(afterShare)}</b>가 됩니다.
            {r.short > 0.5 && ` 움직일 수 있는 ${fromLabel} 자산이 모자라 ${won(r.short)}은 맞추지 못합니다.`}
          </p>
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <Table title={`팔 것 (${fromLabel})`} rows={r.sell} />
            {r.buy.length > 0 ? <Table title={`살 것 (${toLabel})`} rows={r.buy} /> : <p className="text-sm text-muted">{toLabel} 자산이 아직 없습니다. 판 돈 {won(Math.abs(r.shift))}으로 {toLabel} 상품을 새로 사고 자산 탭에 추가하세요.</p>}
          </div>
        </>
      ) : (
        <p className="mt-3 rounded-lg bg-sunken px-3 py-2 text-sm">목표와의 차이가 ±{REBALANCE_BAND}%p 안이라 지금은 사고팔 필요가 없습니다.</p>
      )}

      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">
        <li>넘치는 쪽 자산을 평가액에 비례해 팔고 모자란 쪽 자산을 평가액에 비례해 사는 계산입니다. 어느 상품을 사고팔지는 직접 정하면 되고, 상품 추천이 아닙니다.</li>
        <li>금액은 계좌 구분 없이 비례로 나눈 값입니다. 연금계좌에서 판 돈은 <b>그 계좌 안에서</b> 다른 상품을 사야 세금이 없고, 계좌 밖으로 빼면 연금 외 수령으로 세금(16.5% 등)을 냅니다. 일반계좌는 팔 때 세금·수수료가 생길 수 있으니 새로 넣는 돈이나 인출할 돈으로 먼저 맞추는 편이 유리합니다.</li>
        <li>수령 연도 전이라 묶인 자산(노란우산 등)은 비중에는 넣되 사고팔 목록에서는 뺐습니다. 안전형·투자형 구분은 자산 탭의 ‘성격’을 따릅니다.</li>
      </ul>
    </Card>
  );
}
