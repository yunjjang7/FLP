import type { ReactNode } from 'react';
import { db } from '../db/db';
import { ASSET_CLASSES, allocText, CLASS_LABEL, classGaps, IRP_RISK_CAP, normalizeAlloc, riskPct } from '../engine/allocation';
import { groupOf, isFinancial, RISK_PROFILES } from '../engine/portfolio';
import { allocInDb, switchInDb } from '../db/accountOps';
import type { Alloc, AssetClass } from '../types';
import { rebalance, REBALANCE_BAND, type RebalanceMode, type RebalanceMove, type RebalanceSwitch } from '../engine/rebalance';
import { pct, won } from '../lib/format';
import { useFlp } from '../store/FlpContext';
import { Labeled, NumberField, SelectField } from './fields';
import { JoinAccount, UndoBar } from './JoinAccount';

const MODE_LABELS: Record<RebalanceMode, string> = {
  ratio: '바꿀 수 있는 금액에 비례',
  pensionFirst: '세금 없는 계좌부터(연금 → ISA, 만기 전 예금은 맨 뒤)',
};
import { Badge, Card } from './ui';

/**
 * 연금계좌 한 줄을 남는 줄 + 반대 성격 줄로 나눠 저장(한 트랜잭션). 두 줄은 같은 계좌(group)로 묶여
 * 연금 세금·수령한도·인출 순서·이정표·인출 기록에서 계좌 하나로 계산됨. 같은 계좌에 반대 성격 줄이 이미 있으면 그 줄로 옮김.
 * 계산한 뒤 자산 탭에서 금액·성격을 고쳤으면(계산 때와 다르면) 저장하지 않고 다시 보게 함.
 */
async function applySwitch(x: RebalanceSwitch, fromLabel: string, toLabel: string) {
  if (x.alloc && x.next) return applyAlloc(x);
  const ok = window.confirm(
    `‘${x.name}’을 자산 탭에서 ${fromLabel}·${toLabel} 두 줄로 나눠 저장할까요?\n${fromLabel} ${won(x.keep)} + ${toLabel} ${won(x.move)}\n두 줄은 같은 계좌로 묶여 연금 세금·수령한도를 계좌 하나로 계산합니다.\n\n실제로 계좌에서 상품을 바꾼 뒤 누르세요. 저장한 바로 뒤에는 ‘되돌리기’로 되돌릴 수 있습니다.`,
  );
  if (!ok) return;
  try {
    const done = await switchInDb(x.id, x.amount, fromLabel === '투자형', x.move, x.name);
    if (!done) window.alert('자산 탭의 그 계좌가 계산할 때와 달라 저장하지 않았습니다. 화면을 다시 확인하세요.');
  } catch (e) {
    window.alert(`저장하지 못했습니다: ${e instanceof Error ? e.message : e}`);
  }
}

/** 비율을 넣은 줄: 줄을 나누지 않고 그 줄의 자산배분 비율만 바꿔 저장 */
async function applyAlloc(x: RebalanceSwitch) {
  const ok = window.confirm(
    `‘${x.name}’의 자산배분 비율을 바꿔 저장할까요?\n지금: ${allocText(x.alloc!)}\n바꾼 뒤: ${allocText(x.next!)}\n\n기대수익률·변동성이 ‘배분으로 계산’한 값이면 새 비율로 다시 계산하고, 직접 넣은 값이면 그대로 둡니다. 실제로 계좌에서 상품을 바꾼 뒤 누르세요. 저장한 바로 뒤에는 ‘되돌리기’로 되돌릴 수 있습니다.`,
  );
  if (!ok) return;
  try {
    const done = await allocInDb(x.id, x.amount, x.alloc!, x.next!, x.name);
    if (!done) window.alert('자산 탭의 그 계좌가 계산할 때와 달라 저장하지 않았습니다. 화면을 다시 확인하세요.');
  } catch (e) {
    window.alert(`저장하지 못했습니다: ${e instanceof Error ? e.message : e}`);
  }
}

const TARGET_MODES = { invest: '투자형 비중 하나', classes: '자산군 4개 비율' };

/** 투자 점검: 목표 투자형 비중에 맞추려면 어느 자산을 얼마나 사고팔지 */
export function RebalanceCard() {
  const { profile: p, assets, summary: s } = useFlp();
  const base = RISK_PROFILES[p.riskProfile];
  const own = (p.targetInvest ?? 0) > 0;
  // 자산군 목표: 있으면 목표 투자형 비중 = 주식형 + 대체, 계좌 안 비율을 바꿀 때 늘리는 쪽을 목표 비율대로 나눔
  const goal = normalizeAlloc(p.targetAlloc);
  const plain = own ? p.targetInvest! : base.investShare;
  const target = goal ? riskPct(goal) : plain;
  const mode: RebalanceMode = p.rebalanceMode ?? 'ratio';
  const nowYear = p.birthYear + s.age;
  const nowMonth = new Date().getMonth() + 1;
  // 연금계좌·ISA 밖(팔 때 세금이 붙을 수 있는 계좌)에서 파는 금액
  const ratioGen = rebalance(assets, target, nowYear, REBALANCE_BAND, 'ratio', goal, nowMonth).taxable;
  const firstGen = rebalance(assets, target, nowYear, REBALANCE_BAND, 'pensionFirst', goal, nowMonth).taxable;
  const r = rebalance(assets, target, nowYear, REBALANCE_BAND, mode, goal, nowMonth);
  const earlySum = r.early.reduce((a, m) => a - m.change, 0);
  const gaps = goal ? classGaps(assets.filter((a) => isFinancial(a) && a.amount > 0), goal) : [];
  const goalRaw = p.targetAlloc;
  const goalSum = goalRaw ? ASSET_CLASSES.reduce((a, k) => a + (goalRaw[k] || 0), 0) : 0;
  const setGoal = (k: AssetClass, v: number) => db.profile.put({ ...p, targetAlloc: { ...(goalRaw ?? defaultGoal(plain)), [k]: Math.max(0, Math.min(100, v)) } });
  if (r.total <= 0) return null;
  const saved = ratioGen - firstGen; // 세금 없는 계좌부터 바꾸면 과세 계좌에서 덜 파는 금액
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
                <div className="text-xs text-muted">{won(m.amount)} → {won(m.after)}{m.maturity && <span className="text-warn"> · {m.maturity} 만기 전(중도해지)</span>}</div>
              </td>
              <td className={`whitespace-nowrap py-1.5 text-right font-semibold ${m.change < 0 ? 'text-bad' : 'text-good'}`}>{m.change < 0 ? '−' : '+'} {won(Math.abs(m.change))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  const pensionSum = r.pensions.reduce((a, x) => a + x.move, 0);
  const acctSum = r.accounts.reduce((a, x) => a + x.move, 0);
  // 같은 계좌로 나뉜 연금계좌: 아래 연금계좌 표에 나온 계좌는 그 계좌의 첫 줄 밑에, 나머지는 따로 ‘한 줄로 합치기’를 보여 줌
  const assetOf = (id?: number) => (id === undefined ? undefined : assets.find((a) => a.id === id));
  const joinAt = new Map<number, string>();
  if (r.needed) {
    for (const x of r.pensions) {
      const a = assetOf(x.id);
      const g = a ? groupOf(a) : '';
      if (g && a?.id !== undefined && ![...joinAt.values()].includes(g)) joinAt.set(a.id, g);
    }
  }
  const shown = new Set(joinAt.values());
  const restGroups = [...new Set(assets.map(groupOf).filter((g) => g && !shown.has(g)))];
  const moved = Math.abs(r.shift);

  return (
    <Card title="리밸런싱 금액 계산" className="mt-4" action={<Badge level={r.needed ? 'caution' : 'good'}>{r.needed ? '조정 필요' : '범위 안'}</Badge>}>
      <div className="mb-3 grid gap-4 sm:grid-cols-[minmax(0,12rem)_1fr] sm:items-end">
        <Labeled label="목표 정하는 방식">
          <SelectField
            value={goalRaw ? 'classes' : 'invest'}
            options={TARGET_MODES}
            onChange={(v) => {
              const { targetAlloc: _t, ...rest } = p;
              void _t;
              db.profile.put(v === 'classes' ? { ...p, targetAlloc: defaultGoal(plain) } : rest);
            }}
          />
        </Labeled>
        <p className="text-xs text-muted">
          {goalRaw
            ? '주식형·채권형·대체·현금성 목표 비율을 정하면 목표 투자형 비중은 주식형 + 대체로 정해지고, 계좌 안 비율을 바꿀 때 늘리는 쪽을 목표 비율대로 나눕니다.'
            : '투자형(주식형 + 대체) 비중 하나만 맞춥니다. 자산군 4개를 따로 맞추려면 ‘자산군 4개 비율’을 고르세요.'}
        </p>
      </div>
      {goalRaw && (
        <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          {ASSET_CLASSES.map((k) => (
            <Labeled key={k} label={`목표 ${CLASS_LABEL[k]}(%)`}>
              <NumberField value={goalRaw[k] ?? 0} min={0} onChange={(v) => setGoal(k, v)} />
            </Labeled>
          ))}
          {Math.abs(goalSum - 100) > 0.05 && (
            <p className="col-span-2 text-xs text-warn md:col-span-4">
              목표 합계가 {pct(goalSum)}라 100으로 보고 비례로 계산합니다.{' '}
              <button type="button" className="font-semibold text-brand hover:underline" onClick={() => goal && db.profile.put({ ...p, targetAlloc: goal })}>100으로 맞추기</button>
            </p>
          )}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-[minmax(0,12rem)_1fr] sm:items-end">
        {goal ? (
          <Labeled label="목표 투자형 비중" hint="주식형 + 대체(자산군 목표로 정해짐)">
            <div className="py-2 text-sm font-semibold">{pct(target)}</div>
          </Labeled>
        ) : (
          <Labeled label="목표 투자형 비중" hint={own ? `0으로 두면 ${base.label} 권장 ${base.investShare}%` : `${base.label} 권장값 사용 중 · 직접 정하려면 입력`}>
            <NumberField value={p.targetInvest ?? 0} unit="%" min={0} onChange={(v) => db.profile.put({ ...p, targetInvest: Math.min(100, Math.max(0, v)) })} />
          </Labeled>
        )}
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
              <>세금 없는 계좌부터 바꾸면 연금계좌·ISA 밖에서 파는 금액이 <b className="whitespace-nowrap text-ink">{won(ratioGen)} → {won(firstGen)}</b> <span className="whitespace-nowrap">({won(saved)} 줄어듦)</span></>
            ) : (
              <>어느 순서로 줄여도 연금계좌·ISA 밖에서 파는 금액은 <b className="whitespace-nowrap">{won(firstGen)}</b>으로 차이가 없습니다.</>
            )}
          </p>
        )}
      </div>

      {gaps.length > 0 && (
        <div className="mt-4 -mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
          <table className="w-full min-w-[520px] text-sm num-table">
            <thead>
              <tr className="border-b border-line text-right text-xs text-muted">
                <th className="py-1.5 text-left font-medium">자산군</th>
                <th className="font-medium">지금</th>
                <th className="font-medium">목표</th>
                <th className="font-medium">맞추려면</th>
              </tr>
            </thead>
            <tbody>
              {gaps.map((g) => (
                <tr key={g.key} className="border-b border-line text-right">
                  <td className="py-1.5 text-left">{CLASS_LABEL[g.key]}</td>
                  <td>{won(g.now)} <span className="text-xs text-muted">{pct(g.nowPct)}</span></td>
                  <td>{won(g.target)} <span className="text-xs text-muted">{pct(g.targetPct)}</span></td>
                  <td className={`font-semibold ${Math.abs(g.diff) < 0.5 ? 'text-muted' : g.diff > 0 ? 'text-good' : 'text-bad'}`}>{Math.abs(g.diff) < 0.5 ? '그대로' : `${g.diff > 0 ? '+' : '−'} ${won(Math.abs(g.diff))}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-muted">비율을 넣지 않은 자산은 유형·성격으로 나눕니다(현금·예금·적금·안전형 연금 → 현금성, 채권 → 채권형, 투자형 → 주식형, 투자형 기타 → 대체). 아래 계좌별 금액은 투자형 비중을 맞추는 몫이고, 같은 쪽 안에서 주식형↔대체, 채권형↔현금성 비율은 이 표를 보고 맞추세요.</p>
        </div>
      )}

      {r.needed ? (
        <>
          <p className="mt-3 rounded-lg bg-sunken px-3 py-2 text-sm">
            {moved > 0.5 ? (
              <>{fromLabel} 자산 <b>{won(moved)}</b>을 팔아 {toLabel}으로 옮기면 투자형 비중이 <b>{pct(afterShare)}</b>가 됩니다. 이 가운데 연금계좌 안에서 바꾸는 금액이 <b>{won(pensionSum)}</b>{acctSum > 0.5 && <>, 비율을 넣은 일반 계좌 안에서 바꾸는 금액이 <b>{won(acctSum)}</b></>}, 일반계좌에서 사고파는 금액이 <b>{won(r.general.amount)}</b>입니다.</>
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
                    <SwitchRow key={`${x.name}-${i}`} x={x} fromLabel={fromLabel} toLabel={toLabel} join={x.id !== undefined && joinAt.has(x.id) ? <JoinAccount a={assetOf(x.id)!} assets={assets} className="mt-1" /> : null} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {r.accounts.length > 0 && (
            <div className="mt-4">
              <div className="mb-1 text-sm font-semibold">비율을 넣은 일반 계좌 <span className="font-normal text-muted">· 계좌 안에서 비중만 바꿈(팔 때 세금·수수료가 생길 수 있음)</span></div>
              <table className="w-full text-sm">
                <tbody>
                  {r.accounts.map((x, i) => (
                    <SwitchRow key={`${x.name}-${i}`} x={x} fromLabel={fromLabel} toLabel={toLabel} />
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
                {r.general.buy.length > 0 ? (
                  <Table title={`살 것 (${toLabel})`} rows={r.general.buy} />
                ) : (
                  // 팔 것 표와 같은 제목·구분선을 둬 첫 줄 높이에 맞춤
                  <div className="min-w-0">
                    <div className="mb-1 text-xs font-semibold text-muted">살 것 ({toLabel})</div>
                    <p className="border-t border-line py-1.5 text-sm text-muted">일반계좌에 {toLabel} 자산이 아직 없습니다. 판 돈 {won(r.general.amount)}으로 {toLabel} 상품을 새로 사고 자산 탭에 추가하세요.</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {earlySum > 0.5 && (
            <p className="mt-4 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
              만기 전 예금·적금을 깨는 금액: <b>{won(earlySum)}</b>({r.early.map((m) => `${m.name} ${m.maturity} 만기`).join(', ')}). 중도해지하면 약정 이자 대신 낮은 중도해지 이율을 받습니다.
              {mode === 'pensionFirst' ? ' 다른 자산으로 다 못 맞춘 몫이라, 만기까지 기다렸다 옮기거나 새로 넣는 돈으로 맞추는 편이 나을 수 있습니다.' : ' ‘세금 없는 계좌부터’로 바꾸면 만기 전 예금·적금은 맨 마지막에 줄입니다.'}
            </p>
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

      <UndoBar className="mt-4" />

      {restGroups.length > 0 && (
        <div className="mt-4">
          <div className="mb-1 text-sm font-semibold">같은 계좌로 나뉜 연금계좌 <span className="font-normal text-muted">· 다시 한 줄로 합칠 수 있음</span></div>
          {restGroups.map((g) => (
            <div key={g} className="border-t border-line py-1.5">
              <JoinAccount a={assets.find((a) => groupOf(a) === g)!} assets={assets} />
            </div>
          ))}
        </div>
      )}

      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">
        <li>
          {mode === 'pensionFirst'
            ? '넘치는 쪽 자산 가운데 세금 없는 연금계좌부터 바꿀 수 있는 만큼 먼저 바꾸고(연금계좌끼리는 바꿀 수 있는 금액에 비례), 모자라면 계좌 구분을 ISA로 고른 주식·펀드·ETF(계좌 안에서 사고팔아도 만기까지 과세하지 않음)에서, 그래도 모자란 만큼만 나머지 계좌에서 비례해 파는 계산입니다. 만기 연월을 넣은 예금·적금 가운데 만기 전인 것은 중도해지 손해가 있어 맨 마지막에 줄입니다.'
            : '넘치는 쪽 자산을 바꿀 수 있는 금액에 비례해 줄이는 계산입니다.'}{' '}
          어느 상품을 사고팔지는 직접 정하면 되고, 상품 추천이 아닙니다.</li>
        <li>연금계좌는 자산 탭의 한 줄을 계좌 하나로 보고, 판 돈으로 <b>같은 계좌 안에서</b> 반대 성격 상품을 사는 것으로 계산합니다. 계좌에서 실제로 바꾼 뒤 ‘자산 탭에 반영’을 누르면 그 계좌를 투자형·안전형 두 줄로 나눠 저장합니다(새 줄 이름은 ‘계좌 이름 (안전형|투자형)’, 과세제외·퇴직금 재원은 금액 비례로 나누고 명의·연금수령 1년차·인출 순서 등은 그대로 복사, 새 줄의 기대수익률·변동성은 가진 같은 성격 자산의 평균).</li>
        <li>자산 탭에 자산배분 비율(주식형·채권형·대체·현금성)을 넣은 계좌는 위험자산(주식형+대체) 몫만 투자형으로 세고, ‘자산 탭에 반영’을 누르면 줄을 나누지 않고 그 계좌의 비율만 바꿉니다.</li>
        <li>계좌 종류를 IRP·DC로 고른 계좌(비우면 이름에 IRP·DC·퇴직이 들어간 계좌)는 퇴직연금으로 보고 위험자산 {IRP_RISK_CAP * 100}% 한도를 적용합니다. 일반계좌는 새로 넣는 돈이나 인출할 돈으로 먼저 맞추면 팔 때 드는 세금·수수료를 줄일 수 있습니다.</li>
        <li>수령 연도 전이라 묶인 자산(노란우산 등)은 비중에는 넣되 사고팔 목록에서는 뺐습니다. 비율을 넣지 않은 자산의 안전형·투자형 구분은 자산 탭의 ‘성격’을 따릅니다.</li>
      </ul>
    </Card>
  );
}

/** 자산군 목표를 처음 켤 때 기본값: 지금 목표 투자형 비중을 주식형:대체 = 9:1, 나머지를 채권형:현금성 = 7:3 으로 */
function defaultGoal(invest: number): Alloc {
  const inv = Math.round(invest);
  const equity = Math.round(inv * 0.9);
  const alt = inv - equity;
  const bond = Math.round((100 - inv) * 0.7);
  return { equity, bond, alt, cash: 100 - equity - alt - bond };
}

/** 계좌 안 교체 한 줄: 비율을 넣은 줄은 비율이 어떻게 바뀌는지, 아니면 두 줄로 나뉘는 금액 */
function SwitchRow({ x, fromLabel, toLabel, join }: { x: RebalanceSwitch; fromLabel: string; toLabel: string; join?: ReactNode }) {
  return (
    <tr className="border-t border-line">
      <td className="py-1.5 pr-2">
        {x.name}
        <div className="text-xs text-muted">
          {x.alloc && x.next ? (
            <>위험자산 {pct(riskPct(x.alloc))} → {pct(riskPct(x.next))} · 바꾼 뒤 {allocText(x.next)}</>
          ) : (
            <>{fromLabel} {won(x.amount)} → {fromLabel} {won(x.keep)} + {toLabel} {won(x.move)}</>
          )}
          {x.capped && ` · 위험자산 ${IRP_RISK_CAP * 100}% 한도(${won(x.limit)}까지)`}
        </div>
        {join}
      </td>
      <td className="whitespace-nowrap py-1.5 text-right align-top">
        <div className="font-semibold">{won(x.move)} 교체</div>
        <button type="button" className="mt-1 rounded-lg border border-line px-2 py-1 text-xs font-semibold text-ink transition hover:bg-sunken" onClick={() => void applySwitch(x, fromLabel, toLabel)}>
          자산 탭에 반영
        </button>
      </td>
    </tr>
  );
}
