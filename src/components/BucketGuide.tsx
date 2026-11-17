import { Fragment, useMemo } from 'react';
import { db } from '../db/db';
import { accountBuckets, BEAR_DROP, MARKET_INPUT_HELP, bucketGap, cashSourceLabel, cashYears, pensionFrom55, pensionFrom55Note, pensionOutNote, IRP_RISK_CAP, marketRule, maturityLabel, safeYears } from '../engine/buckets';
import { classAmounts, hasAlloc } from '../engine/allocation';
import { useFlp } from '../store/FlpContext';
import { SetupLink } from './SetupLink';
import type { TaxResult } from '../engine/tax';
import { pct, won } from '../lib/format';
import { Labeled, NumberField } from './fields';
import { Card } from './ui';

/**
 * 인출용 자산 배치 가이드(엑셀 ‘투자배분’): 전체 기준 현금성 2년 · 채권·배당 3~5년차 · 대체 · 나머지 성장.
 * 연금 세금 계산이 있으면 계좌마다 그 계좌에서 빠져나갈 금액으로 바구니 목표를 따로 보여 줌.
 */
export function BucketGuide({ firstNeed, balance, tax, hasSpouse, partialFirst = false }: { firstNeed: number; balance: number; tax: TaxResult | null; hasSpouse: boolean; partialFirst?: boolean }) {
  const { assets, cash: hand, runCash, start, profile } = useFlp();
  // 대체자산 목표 비중 기본값: 연금계좌에 비율을 넣었으면 지금 대체자산 비중(반올림), 아니면 10%
  // 두 칸은 프로필에 저장(화면을 옮겨도 유지). 넣은 적이 없으면 기본값
  const altDefault = useMemo(() => {
    const pen = assets.filter((a) => a.type === 'pension' && a.amount > 0);
    const withAlloc = pen.filter(hasAlloc);
    if (!withAlloc.length) return 10;
    const amt = withAlloc.reduce((s, a) => s + a.amount, 0);
    return amt > 0 ? Math.round((classAmounts(withAlloc).alt / amt) * 100) : 10;
  }, [assets]);
  const altPct = profile.bucketAltPct ?? altDefault;
  const drawdown = profile.marketDrawdown ?? 0;
  const setAltPct = (v: number) => db.profile.put({ ...profile, bucketAltPct: Math.min(50, Math.max(0, v)) });
  const setDrawdown = (v: number) => db.profile.put({ ...profile, marketDrawdown: Math.max(-100, Math.min(100, v)) });
  const rule = marketRule(drawdown);
  // 연금계좌 밖 현금·예금·적금(hand): 바로 쓸 돈과 만기가 3개월 넘게 남은 예금·적금.
  // 버틸 햇수는 홈 점검과 같은 숫자: 점검기준 설정이 예면 연금계좌 안 현금성도 더한 runCash 를 노후 진단 첫해 인출(start.outflow)로 나눔
  const handYears = cashYears(runCash, start.outflow);
  const alt0 = Math.min(50, Math.max(0, altPct)) / 100;
  const cash = Math.min(balance, firstNeed * 2);
  const bond = Math.min(balance - cash, firstNeed * 3);
  const alt = Math.max(0, Math.min(balance - cash - bond, balance * alt0));
  const growth = Math.max(0, balance - cash - bond - alt);
  const rows = [
    { label: '현금성(MMF·예금)', amount: cash, note: '1~2년차 인출분. 매달 여기서 꺼내 씀' },
    { label: '채권·배당', amount: bond, note: '3~5년차 인출분. 현금이 줄면 여기서 채움' },
    { label: '대체자산(금·리츠 등)', amount: alt, note: `전체의 약 ${altPct}%. 주식과 다르게 움직이는 완충재` },
    { label: '성장자산(주식형)', amount: growth, note: '6년차 이후 몫. 오른 해에 일부 팔아 앞 바구니를 채움' },
  ];
  const accounts = useMemo(() => (tax ? accountBuckets(tax, alt0, partialFirst, assets).filter((a) => a.balance > 0.5) : []), [tax, alt0, partialFirst, assets]);
  const anyNow = accounts.some((a) => a.now);
  const noAlloc = accounts.filter((a) => !a.now).map((a) => a.name);
  // 하락장: 비율을 넣은 계좌마다 지금 현금성+채권형으로 몇 년치 인출을 버티는지
  const bearYears = rule.state === 'bear' ? accounts.filter((a) => a.now && a.yearDraw > 0.5).map((a) => ({ name: a.name, years: safeYears(a)! })) : [];
  const sign = (v: number) => (Math.abs(v) < 0.5 ? '0' : `${v > 0 ? '+' : '−'}${won(Math.abs(v))}`);
  const gapCls = (v: number) => (Math.abs(v) < 0.5 ? 'text-muted' : v > 0 ? 'text-warn' : 'text-muted');
  const total = (f: (a: (typeof accounts)[number]) => number) => accounts.reduce((s, a) => s + f(a), 0);
  const year = tax?.rows[0]?.year;
  return (
    <Card title="인출용 자산 배치 가이드" className="mt-4" action={<span className="text-xs text-muted">첫해 인출 연 {won(firstNeed)} 기준</span>}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map((r) => (
          <div key={r.label} className="rounded-xl bg-sunken p-3">
            <div className="text-xs text-muted">{r.label}</div>
            <div className="mt-0.5 text-lg font-bold">{won(r.amount)}</div>
            <div className="text-xs text-muted">{balance > 0 ? pct((r.amount / balance) * 100) : '-'} · {r.note}</div>
          </div>
        ))}
      </div>

      {runCash.total > 0.5 && (
        <p className="mt-3 rounded-lg bg-sunken px-3 py-2 text-sm">
          지금 연금계좌 밖 현금성(현금·예금·적금) <b>{won(hand.total)}</b> 가운데 바로 쓸 수 있는 돈 <b>{won(hand.usable)}</b>
          {hand.locked > 0.5 ? (
            <>
              , 만기가 3개월 넘게 남은 예금·적금 <b className="text-warn">{won(hand.locked)}</b>
              <span className="text-muted">({hand.lockedRows.map((r) => `${r.name} ${maturityLabel({ maturityYear: r.year, maturityMonth: r.month })} 만기`).join(', ')})</span>
              . 만기 전에 깨면 약정 이자 대신 중도해지 이율을 받으니, ① 현금성 목표 {won(cash)}는 바로 쓸 돈으로 채우는 편이 안전합니다.
            </>
          ) : (
            <>입니다.</>
          )}
          {runCash.pension ? <> 점검기준 설정에 따라 연금계좌 안 현금성 <b>{won(runCash.pension)}</b>도 바로 쓸 돈에 더합니다(모두 {won(runCash.usable)}).</> : null}
          {runCash.pensionOut ? <span className="text-muted">{pensionOutNote(runCash)}{pensionFrom55Note(pensionFrom55(runCash, profile.birthYear, profile.spouseBirthYear))}</span> : null}
          {handYears && <span className="text-muted"> 노후 진단 첫해 인출(연 {won(start.outflow)}, 홈 점검과 같은 기준)로 나누면 바로 쓸 돈만으로 약 {handYears.usable.toFixed(1)}년치입니다.</span>}
        </p>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Labeled label="대체자산 목표 비중" hint="금·리츠 ETF 등, 평가액 대비. 위 ④ 대체자산 금액과 아래 계좌별 목표에 씀(0~50%)">
          <NumberField value={altPct} unit="%" min={0} onChange={setAltPct} />
        </Labeled>
        <Labeled label="주식형 지수 고점 대비 등락률" hint={`예: −18 = 고점보다 18% 하락. ${MARKET_INPUT_HELP}`}>
          <NumberField value={drawdown} unit="%" onChange={setDrawdown} />
        </Labeled>
        <div className={`self-start rounded-xl px-3 py-2.5 text-sm sm:col-span-2 ${rule.state === 'bear' ? 'bg-bad-soft' : rule.state === 'peak' ? 'bg-good-soft' : 'bg-sunken'}`}>
          <b>지금 적용할 규칙</b> — {rule.text}
          {bearYears.length > 0 && (
            <div className="mt-1 text-xs">
              지금 담은 현금성+채권형으로 주식을 팔지 않고 버틸 수 있는 기간:{' '}
              {bearYears.map((b, i) => (
                <span key={b.name}>
                  {i > 0 && ' · '}
                  {b.name} <b className={b.years < 2 ? 'text-bad' : ''}>{Number.isFinite(b.years) ? `약 ${b.years.toFixed(1)}년` : '인출 없음'}</b>
                </span>
              ))}
              {bearYears.some((b) => b.years < 2) && ' — 2년이 안 되는 계좌는 회복을 기다리기 어려우니 다음 고점에 현금성을 먼저 채우세요.'}
            </div>
          )}
          {rule.state === 'bear' && handYears && runCash.total > 0.5 && (
            <div className="mt-1 text-xs">
              {cashSourceLabel(runCash)}으로 버틸 수 있는 기간(첫해 인출 기준): 바로 쓸 돈만 <b className={handYears.usable < 2 ? 'text-bad' : ''}>약 {handYears.usable.toFixed(1)}년</b>
              {hand.locked > 0.5 && <>, 만기 전 예금·적금 {won(hand.locked)}까지 깨면 약 {handYears.all.toFixed(1)}년(중도해지 이율)</>}
            </div>
          )}
        </div>
      </div>

      {accounts.length > 0 && (
        <div className="mt-4">
          <div className="mb-1 text-xs font-medium text-muted">계좌별 바구니 목표 — 인출이 나가는 그 계좌 안에 현금성을 둠 ({year}년 초 평가액 · 그 해 금액)</div>
          <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
            <table className="w-full min-w-[720px] text-sm num-table">
              <thead>
                <tr className="border-b border-line text-right text-xs text-muted">
                  <th className="py-1.5 text-left font-medium">계좌</th>
                  <th className="font-medium">평가액</th>
                  <th className="font-medium">① 현금성<div className="font-normal">앞 2년 인출분</div></th>
                  <th className="font-medium">② 채권·배당<div className="font-normal">3~5년차 인출분</div></th>
                  <th className="font-medium">③ 성장<div className="font-normal">지수 ETF 등</div></th>
                  <th className="font-medium">④ 대체<div className="font-normal">금·리츠 ETF</div></th>
                  <th className="font-medium">위험자산<div className="font-normal">③+④</div></th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const g = bucketGap(a);
                  return (
                  <Fragment key={a.name}>
                  <tr className={`${a.now ? '' : 'border-b'} border-line text-right`}>
                    <td className="py-1.5 text-left">
                      {a.name}
                      {hasSpouse && <span className="ml-1 text-xs text-muted">{a.owner === 'spouse' ? '배우자' : '본인'}</span>}
                      {a.capped && <span className="ml-1 text-xs text-muted">· 70% 한도</span>}
                    </td>
                    <td>{won(a.balance)}</td>
                    <td className="font-semibold">{won(a.cash)}</td>
                    <td>{won(a.bond)}</td>
                    <td>{won(a.growth)}</td>
                    <td>{won(a.alt)}</td>
                    <td className={a.capped && a.riskShare >= IRP_RISK_CAP * 100 - 0.05 ? 'text-warn' : ''}>{pct(a.riskShare)}</td>
                  </tr>
                  {a.now && g && (
                    <tr className="border-b border-line text-right text-xs">
                      <td className="py-1 pl-3 text-left text-muted">지금 배분 · 목표와 차이</td>
                      <td />
                      <td>{won(a.now.cash)}<div className={gapCls(g.cash)}>{sign(g.cash)}</div></td>
                      <td>{won(a.now.bond)}<div className={gapCls(g.bond)}>{sign(g.bond)}</div></td>
                      <td>{won(a.now.equity)}<div className={gapCls(g.growth)}>{sign(g.growth)}</div></td>
                      <td>{won(a.now.alt)}<div className={gapCls(g.alt)}>{sign(g.alt)}</div></td>
                      <td className={a.capped && ((a.now.equity + a.now.alt) / a.balance) * 100 > IRP_RISK_CAP * 100 + 0.05 ? 'text-bad' : ''}>{pct(((a.now.equity + a.now.alt) / a.balance) * 100)}</td>
                    </tr>
                  )}
                  </Fragment>
                  );
                })}
                <tr className="text-right font-semibold">
                  <td className="py-1.5 text-left">합계</td>
                  <td>{won(total((a) => a.balance))}</td>
                  <td>{won(total((a) => a.cash))}</td>
                  <td>{won(total((a) => a.bond))}</td>
                  <td>{won(total((a) => a.growth))}</td>
                  <td>{won(total((a) => a.alt))}</td>
                  <td>{total((a) => a.balance) > 0 ? pct((total((a) => a.growth + a.alt) / total((a) => a.balance)) * 100) : '-'}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {anyNow && (
            <p className="mt-1 text-xs text-muted">
              ‘지금 배분’은 자산 탭에 넣은 계좌 안 자산배분 비율로 나눈 금액이고, 아래 숫자는 목표 − 지금입니다(+ 는 더 채울 금액, − 는 넘치는 금액). 비율이 없는 줄은 성격대로(투자형 = 주식형, 안전형 = 현금성) 셉니다.
              {noAlloc.length > 0 && <> 비율을 넣지 않은 계좌({noAlloc.join('·')})는 목표만 보여 줍니다.</>}
            </p>
          )}
          {!anyNow && (
            <p className="mt-1 text-xs text-muted">
              <SetupLink tab="assets">자산 탭</SetupLink>에서 연금계좌의 자산배분 비율(주식형·채권형·대체·현금성)을 넣으면 계좌마다 지금 배분과 목표의 차이를 함께 보여 줍니다.
            </p>
          )}
          <p className="mt-1 text-xs text-muted">
            ‘연금 세금 점검’의 계좌별 인출 계획으로 계산했습니다. 인출 시작 전이라 5년 안에 꺼내지 않는 계좌는 현금성 없이 대부분 성장자산으로 둡니다. 계좌 종류가 IRP·DC이거나(비우면 이름에 IRP·DC·퇴직이 들어간 계좌) 퇴직연금으로 보고 위험자산(③+④, ETF는 주식형으로 봄)을 평가액의 {IRP_RISK_CAP * 100}%까지만 잡고 넘는 몫은 ②로 돌렸습니다. 상품 추천이 아닌 금액 배분 기준입니다.
          </p>
        </div>
      )}

      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">
        <li>주식이 고점보다 {BEAR_DROP}% 넘게 떨어진 해에는 주식을 팔지 말고 현금성·채권에서만 꺼내 쓰고, 회복한 뒤 다시 채웁니다.</li>
        <li>퇴직연금(DC·IRP)은 위험자산을 70%까지만 담을 수 있으니, 성장자산은 연금저축·일반 계좌에 나눠 둡니다.</li>
        <li>임대용 부동산이 있으면 부동산 비중이 이미 높으니, 대체자산 안에서도 리츠는 작게 잡습니다.</li>
        <li>1년에 한 번(예: 1월) ②에서 ①로 옮겨 채우고 바구니 비율을 점검합니다. 가드레일을 쓴다면 같은 날 인출액도 함께 조정합니다.</li>
      </ul>
    </Card>
  );
}
