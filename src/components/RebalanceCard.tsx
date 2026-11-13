import { db } from '../db/db';
import { IRP_RISK_CAP } from '../engine/buckets';
import { RISK_PROFILES } from '../engine/portfolio';
import { rebalance, REBALANCE_BAND, type RebalanceMode, type RebalanceMove } from '../engine/rebalance';
import { pct, won } from '../lib/format';
import { useFlp } from '../store/FlpContext';
import { Labeled, NumberField, SelectField } from './fields';

const MODE_LABELS: Record<RebalanceMode, string> = {
  ratio: '바꿀 수 있는 금액에 비례',
  pensionFirst: '연금계좌부터 먼저',
};
import { Badge, Card } from './ui';

/** 투자 점검: 목표 투자형 비중에 맞추려면 어느 자산을 얼마나 사고팔지 */
export function RebalanceCard() {
  const { profile: p, assets, summary: s } = useFlp();
  const base = RISK_PROFILES[p.riskProfile];
  const own = (p.targetInvest ?? 0) > 0;
  const target = own ? p.targetInvest! : base.investShare;
  const mode: RebalanceMode = p.rebalanceMode ?? 'ratio';
  const nowYear = p.birthYear + s.age;
  const ratioGen = rebalance(assets, target, nowYear, REBALANCE_BAND, 'ratio').general.amount;
  const firstGen = rebalance(assets, target, nowYear, REBALANCE_BAND, 'pensionFirst').general.amount;
  const r = rebalance(assets, target, nowYear, REBALANCE_BAND, mode);
  if (r.total <= 0) return null;
  const saved = ratioGen - firstGen; // 연금계좌부터 바꾸면 일반계좌에서 덜 파는 금액
  const toSafe = r.shift > 0;
  const fromLabel = toSafe ? '투자형' : '안전형';
  const toLabel = toSafe ? '안전형' : '투자형';
  const afterShare = ((r.invest - r.shift) / r.total) * 100;

  const Table = ({ title, rows }: { title: string; rows: RebalanceMove[] }) => (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-semibold text-muted">{title}</div>
      <table className="w-full text-sm">
        <tbody>
          {rows.map((m, i) => (
            <tr key={`${m.name}-${i}`} className="border-t border-line">
              <td className="py-1.5 pr-2">
                {m.name}
                <div className="text-xs text-muted">{won(m.amount)} → {won(m.after)}</div>
              </td>
              <td className={`whitespace-nowrap py-1.5 text-right font-semibold ${m.change < 0 ? 'text-bad' : 'text-good'}`}>{m.change < 0 ? '−' : '+'} {won(Math.abs(m.change))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  const pensionSum = r.pensions.reduce((a, x) => a + x.move, 0);
  const moved = Math.abs(r.shift);

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

      <div className="mt-3 grid gap-4 sm:grid-cols-[minmax(0,12rem)_1fr] sm:items-end">
        <Labeled label="줄이는 순서">
          <SelectField value={mode} options={MODE_LABELS} onChange={(v) => db.profile.put({ ...p, rebalanceMode: v === 'pensionFirst' ? 'pensionFirst' : 'ratio' })} />
        </Labeled>
        {r.needed && (
          <p className="min-w-0 break-keep text-sm text-muted">
            {saved > 0.5 ? (
              <>연금계좌부터 바꾸면 일반계좌에서 파는 금액이 <b className="whitespace-nowrap text-ink">{won(ratioGen)} → {won(firstGen)}</b> <span className="whitespace-nowrap">({won(saved)} 줄어듦)</span></>
            ) : (
              <>어느 순서로 줄여도 일반계좌에서 파는 금액은 <b className="whitespace-nowrap">{won(firstGen)}</b>으로 차이가 없습니다.</>
            )}
          </p>
        )}
      </div>

      {r.needed ? (
        <>
          <p className="mt-3 rounded-lg bg-sunken px-3 py-2 text-sm">
            {moved > 0.5 ? (
              <>{fromLabel} 자산 <b>{won(moved)}</b>을 팔아 {toLabel}으로 옮기면 투자형 비중이 <b>{pct(afterShare)}</b>가 됩니다. 이 가운데 연금계좌 안에서 바꾸는 금액이 <b>{won(pensionSum)}</b>, 일반계좌에서 사고파는 금액이 <b>{won(r.general.amount)}</b>입니다.</>
            ) : (
              <>지금 바로 사고팔 수 있는 {fromLabel} 자산이 없습니다.</>
            )}
          </p>

          {r.pensions.length > 0 && (
            <div className="mt-4">
              <div className="mb-1 text-sm font-semibold">연금계좌 <span className="font-normal text-muted">· 계좌 안에서 상품만 바꿈(세금 없음)</span></div>
              <table className="w-full text-sm">
                <tbody>
                  {r.pensions.map((x, i) => (
                    <tr key={`${x.name}-${i}`} className="border-t border-line">
                      <td className="py-1.5 pr-2">
                        {x.name}
                        <div className="text-xs text-muted">
                          {fromLabel} {won(x.amount)} → {fromLabel} {won(x.keep)} + {toLabel} {won(x.move)}
                          {x.capped && ` · 위험자산 ${IRP_RISK_CAP * 100}% 한도(${won(x.limit)}까지)`}
                        </div>
                      </td>
                      <td className="whitespace-nowrap py-1.5 text-right font-semibold">{won(x.move)} 교체</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {r.general.amount > 0.5 && (
            <div className="mt-4">
              <div className="mb-1 text-sm font-semibold">일반계좌 <span className="font-normal text-muted">· 팔 때 세금·수수료가 생길 수 있음</span></div>
              <div className="grid gap-4 md:grid-cols-2">
                <Table title={`팔 것 (${fromLabel})`} rows={r.general.sell} />
                {r.general.buy.length > 0 ? <Table title={`살 것 (${toLabel})`} rows={r.general.buy} /> : <p className="text-sm text-muted">일반계좌에 {toLabel} 자산이 아직 없습니다. 판 돈 {won(r.general.amount)}으로 {toLabel} 상품을 새로 사고 자산 탭에 추가하세요.</p>}
              </div>
            </div>
          )}

          <p className={`mt-4 rounded-lg px-3 py-2 text-sm ${r.outside > 0.5 ? 'bg-warn-soft text-warn' : 'bg-sunken text-muted'}`}>
            {r.outside > 0.5 ? (
              <>연금계좌 밖으로 빼야 맞춰지는 금액: <b>{won(r.outside)}</b>. 퇴직연금 계좌(IRP·DC)는 투자형을 평가액의 {IRP_RISK_CAP * 100}%까지만 담을 수 있어 계좌 안에서는 더 바꿀 수 없습니다. 이 돈을 빼면 연금 외 수령으로 세금(16.5% 등)을 내므로, 빼지 않고 투자형 비중 <b>{pct(afterShare)}</b>에서 멈추는 편이 보통 유리합니다.</>
            ) : (
              <>연금계좌 밖으로 빼야 맞춰지는 금액은 없습니다. 연금계좌 몫은 모두 계좌 안에서 바꿀 수 있습니다.</>
            )}
            {r.short > 0.5 && <> 수령 전이라 묶인 자산 때문에 <b>{won(r.short)}</b>은 지금 맞출 수 없습니다.</>}
          </p>
        </>
      ) : (
        <p className="mt-3 rounded-lg bg-sunken px-3 py-2 text-sm">목표와의 차이가 ±{REBALANCE_BAND}%p 안이라 지금은 사고팔 필요가 없습니다.</p>
      )}

      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">
        <li>
          {mode === 'pensionFirst'
            ? '넘치는 쪽 자산 가운데 세금 없는 연금계좌부터 바꿀 수 있는 만큼 먼저 바꾸고(연금계좌끼리는 바꿀 수 있는 금액에 비례), 모자란 만큼만 일반계좌에서 비례해 파는 계산입니다.'
            : '넘치는 쪽 자산을 바꿀 수 있는 금액에 비례해 줄이는 계산입니다.'}{' '}
          어느 상품을 사고팔지는 직접 정하면 되고, 상품 추천이 아닙니다.</li>
        <li>연금계좌는 자산 탭의 한 줄을 계좌 하나로 보고, 판 돈으로 <b>같은 계좌 안에서</b> 반대 성격 상품을 사는 것으로 계산합니다. 바꾼 뒤에는 자산 탭에서 그 계좌를 투자형·안전형 두 줄로 나눠 적어야 비중이 맞게 나옵니다.</li>
        <li>이름에 IRP·DC·퇴직이 들어간 계좌는 퇴직연금으로 보고 위험자산 {IRP_RISK_CAP * 100}% 한도를 적용합니다. 일반계좌는 새로 넣는 돈이나 인출할 돈으로 먼저 맞추면 팔 때 드는 세금·수수료를 줄일 수 있습니다.</li>
        <li>수령 연도 전이라 묶인 자산(노란우산 등)은 비중에는 넣되 사고팔 목록에서는 뺐습니다. 안전형·투자형 구분은 자산 탭의 ‘성격’을 따릅니다.</li>
      </ul>
    </Card>
  );
}
