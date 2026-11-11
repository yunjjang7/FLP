import { useMemo, useState } from 'react';
import { accountBuckets, BEAR_DROP, IRP_RISK_CAP, marketRule } from '../engine/buckets';
import type { TaxResult } from '../engine/tax';
import { pct, won } from '../lib/format';
import { Labeled, NumberField } from './fields';
import { Card } from './ui';

/**
 * 인출용 자산 배치 가이드(엑셀 ‘투자배분’): 전체 기준 현금성 2년 · 채권·배당 3~5년차 · 대체 · 나머지 성장.
 * 연금 세금 계산이 있으면 계좌마다 그 계좌에서 빠져나갈 금액으로 바구니 목표를 따로 보여 줌.
 */
export function BucketGuide({ firstNeed, balance, tax, hasSpouse, partialFirst = false }: { firstNeed: number; balance: number; tax: TaxResult | null; hasSpouse: boolean; partialFirst?: boolean }) {
  const [altPct, setAltPct] = useState(10);
  const [drawdown, setDrawdown] = useState(0);
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
  const accounts = useMemo(() => (tax ? accountBuckets(tax, alt0, partialFirst).filter((a) => a.balance > 0.5) : []), [tax, alt0, partialFirst]);
  const total = (f: (a: (typeof accounts)[number]) => number) => accounts.reduce((s, a) => s + f(a), 0);
  const year = tax?.rows[0]?.year;
  const rule = marketRule(drawdown);
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

      <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,180px)_minmax(0,220px)_minmax(0,1fr)]">
        <Labeled label="대체자산 목표 비중" hint="금·리츠 ETF 등, 평가액 대비">
          <NumberField value={altPct} unit="%" min={0} onChange={setAltPct} />
        </Labeled>
        <Labeled label="주식형 지수 고점 대비 등락률" hint="예: −18 = 고점보다 18% 하락">
          <NumberField value={drawdown} unit="%" onChange={setDrawdown} />
        </Labeled>
        <div className={`self-start rounded-xl px-3 py-2.5 text-sm ${rule.state === 'bear' ? 'bg-bad-soft' : rule.state === 'peak' ? 'bg-good-soft' : 'bg-sunken'}`}>
          <b>지금 적용할 규칙</b> — {rule.text}
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
                {accounts.map((a) => (
                  <tr key={a.name} className="border-b border-line text-right">
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
                ))}
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
          <p className="mt-1 text-xs text-muted">
            ‘연금 세금 점검’의 계좌별 인출 계획으로 계산했습니다. 인출 시작 전이라 5년 안에 꺼내지 않는 계좌는 현금성 없이 대부분 성장자산으로 둡니다. 이름에 IRP·DC·퇴직이 들어간 계좌는 퇴직연금으로 보고 위험자산(③+④, ETF는 주식형으로 봄)을 평가액의 {IRP_RISK_CAP * 100}%까지만 잡고 넘는 몫은 ②로 돌렸습니다. 상품 추천이 아닌 금액 배분 기준입니다.
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
