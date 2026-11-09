import { useMemo, useState } from 'react';
import { DEFAULT_CONTRIB } from '../engine/incomeTax';
import { CHECK_AGE, checkAge, checkAt, hasCompareOrder, orderCombos, runCombo, summarizeTax, type CompareBase, type ComboResult, type CompareContrib } from '../engine/orderCompare';
import type { TaxResult, TaxSetup } from '../engine/tax';
import { won, yearRanges } from '../lib/format';
import { Labeled, NumberField } from './fields';
import { Card } from './ui';

/** 엑셀 ‘인출순서비교’: 꺼내는 순서·인출 시작 연도·추가 납입 조합별 세금·한도 초과·고갈 나이 */
export function OrderCompare({ base, tax, setup }: { base: CompareBase; tax: TaxResult; setup: TaxSetup }) {
  const p = base.profile;
  const nowYear = p.birthYear + base.summary.age;
  const hasSpouse = p.spouseBirthYear > 0;
  const cur = { ...DEFAULT_CONTRIB, ...(p.contrib ?? {}) };
  const [c, setC] = useState<CompareContrib>(() => {
    const from = cur.from || nowYear + 1;
    return { self: cur.self || 900, spouse: cur.spouse || 900, from, to: cur.to || from + 4 };
  });
  const combos = useMemo(() => orderCombos(hasSpouse), [hasSpouse]);
  const rows = useMemo(() => combos.map((k) => runCombo(base, k, c)).filter((x): x is ComboResult => !!x), [base, combos, c]);
  const now = useMemo(() => summarizeTax(tax, setup, null), [tax, setup]);
  if (rows.length === 0) return null;

  const minNet = Math.min(...rows.map((r) => r.netTax));
  const depKey = (r: ComboResult) => r.depletedAge ?? Infinity;
  const bestDep = Math.max(...rows.map(depKey));
  const maxEnd = Math.max(...rows.map((r) => r.endBalance));
  const showEnd = maxEnd > 0.5 || now.endBalance > 0.5;
  // 점검 나이 열(기본 90세, 그 전에 바닥나면 모든 조합에 잔액이 남은 마지막 나이)
  const ck = checkAge(rows);
  const showAt = ck !== null;
  const at = (r: ComboResult) => checkAt(r, ck ?? 0);
  const minTaxTo = Math.min(...rows.map((r) => at(r).taxTo));
  const maxAt = Math.max(...rows.map((r) => at(r).leftAt ?? 0));
  const leftCls = (r: ComboResult, isNow: boolean) => {
    const v = at(r).leftAt;
    return !isNow && v !== null && v >= maxAt - 0.5 && v > 0.5 ? best : '';
  };
  const cmpOrder = hasCompareOrder(base.assets);
  const best = 'font-semibold text-good';
  const dep = (r: ComboResult) => (r.depletedAge === null ? `${p.lifeExpectancy}세까지 유지` : `${r.depletedAge}세`);
  const upd = (patch: Partial<CompareContrib>) => setC((x) => ({ ...x, ...patch }));

  const line = (r: ComboResult, isNow: boolean) => (
    <tr key={r.combo?.key ?? 'now'} className={`border-b border-line text-right last:border-0 ${isNow ? 'italic text-muted' : ''}`}>
      <td className="py-1.5 pr-2 text-left">
        <div className={isNow ? '' : 'font-medium text-ink'}>{isNow ? '지금 계획' : r.combo!.label}</div>
        {r.combo?.note && <div className="text-xs text-muted">{r.combo.key === '1' ? (cmpOrder ? '비교 기준 순서 · 인출 시작 연도 안 씀' : '입력 순서 · 인출 시작 연도 안 씀') : r.combo.note}</div>}
      </td>
      <td>{won(r.totalTax)}</td>
      <td>{r.credit > 0.5 ? won(r.credit) : '-'}</td>
      <td className={!isNow && r.netTax <= minNet + 0.5 ? best : ''}>{won(r.netTax)}</td>
      <td className="whitespace-nowrap">{r.overYears.length ? <>{r.overYears.length}개 연도<div className="text-xs text-muted">{yearRanges(r.overYears)}</div></> : '없음'}</td>
      <td>{r.overAmount > 0.5 ? won(r.overAmount) : '-'}</td>
      <td className={r.limitAccounts > 0 ? 'text-bad' : ''}>{r.limitAccounts > 0 ? `${r.limitAccounts}개` : '없음'}</td>
      <td>{r.contrib > 0.5 ? won(r.contrib) : '-'}</td>
      <td className={!isNow && depKey(r) >= bestDep ? best : ''}>{dep(r)}</td>
      {showAt && <td className={!isNow && at(r).taxTo <= minTaxTo + 0.5 ? best : ''}>{won(at(r).taxTo)}</td>}
      {showAt && <td className={leftCls(r, isNow)}>{at(r).leftAt === null ? '-' : won(at(r).leftAt!)}</td>}
      {showEnd && <td className={!isNow && r.endBalance >= maxEnd - 0.5 && r.endBalance > 0 ? best : ''}>{won(r.endBalance)}</td>}
    </tr>
  );

  return (
    <Card title="인출 순서·추가 납입 비교" className="mt-4" action={<span className="text-xs text-muted">평균수익 가정 · 금액은 오늘 물가</span>}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Labeled label="본인 추가 납입(연)" hint="조합 ③·④">
          <NumberField value={c.self} unit="만원" onChange={(v) => upd({ self: v })} />
        </Labeled>
        {hasSpouse && (
          <Labeled label="배우자 추가 납입(연)" hint="조합 ④·⑤">
            <NumberField value={c.spouse} unit="만원" onChange={(v) => upd({ spouse: v })} />
          </Labeled>
        )}
        <Labeled label="납입 시작 연도">
          <NumberField value={c.from} unit="년" onChange={(v) => upd({ from: v })} />
        </Labeled>
        <Labeled label="납입 마지막 연도">
          <NumberField value={c.to} unit="년" onChange={(v) => upd({ to: v })} />
        </Labeled>
      </div>
      <div className="mt-3 -mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
        <table className="w-full min-w-[1180px] text-sm">
          <thead>
            <tr className="border-b border-line text-right text-xs text-muted">
              <th className="py-2 text-left font-medium">조합</th>
              <th className="font-medium">세금 합계</th>
              <th className="font-medium">세액공제 환급</th>
              <th className="font-medium">순 세금</th>
              <th className="font-medium">1,500만 초과 연도</th>
              <th className="font-medium">초과 인출<div className="font-normal">16.5% 과세</div></th>
              <th className="font-medium">수령한도 초과</th>
              <th className="font-medium">추가 납입 합계</th>
              <th className="font-medium">고갈 나이<div className="font-normal">세금 반영</div></th>
              {showAt && <th className="font-medium">{ck}세까지 세금</th>}
              {showAt && <th className="font-medium">{ck}세 연말 잔액<div className="font-normal">세금 반영</div></th>}
              {showEnd && <th className="font-medium">{p.lifeExpectancy}세 연말 잔액</th>}
            </tr>
          </thead>
          <tbody>
            {line(now, true)}
            {rows.map((r) => line(r, false))}
          </tbody>
        </table>
      </div>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">
        <li>①은 계좌별 ‘비교 기준 순서’(모두 0이면 자산 목록 순서)대로 꺼내고, 모든 연금계좌를 바로 인출합니다. ②~⑤는 계좌별 ‘꺼내는 순서’와 ‘인출 시작 연도’를 그대로 씁니다.</li>
        {showAt && (
          <li>
            {ck}세 열은 조합이 모두 바닥나도 차이를 보려고 넣었습니다{ck !== CHECK_AGE ? ` (${CHECK_AGE}세 전에 바닥나는 조합이 있어, 모든 조합에 잔액이 남아 있는 마지막 나이로 맞춤)` : ''}. 같은 생활비를 쓰므로 이 나이 잔액이 많을수록 유리한 조합입니다. 다만 납입 조합은 낸 돈만큼 덜 쓴 효과가 섞여 있습니다.
          </li>
        )}
        <li>추가 납입은 인출 시작 전인 계좌(없으면 첫 계좌)로 넣고, 세액공제율은 데이터·설정의 추가 납입 설정(비우면 종합소득금액으로 자동)을 따릅니다. 공제는 그 해 종합소득세까지만 받고 환급은 다음 해 들어옵니다.</li>
        <li>납입금은 ISA·일반계좌에서 먼저 내고, 모자라면 연금계좌에서 더 꺼냅니다. 납입 조합의 고갈 나이·잔액이 좋아 보이는 것은 대부분 덜 쓰고 모은 효과이니, 세금 효과는 ‘순 세금’과 ‘초과 인출’로 비교하세요.</li>
        <li>여기 입력한 납입액은 비교에만 쓰입니다. 계획에 넣으려면 데이터·설정의 ‘추가 납입’에 입력하세요. 초록 굵은 글씨는 조합 가운데 가장 좋은 값입니다.</li>
      </ul>
    </Card>
  );
}
