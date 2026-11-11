import { useMemo } from 'react';
import { contribSchedule, incomeTaxSchedule } from '../engine/incomeTax';
import type { TaxResult } from '../engine/tax';
import { won } from '../lib/format';
import { useFlp } from '../store/FlpContext';
import { Card } from './ui';

const HI_MODE = { work: '직장', workDep: '직장+피부양', workRegion: '직장+지역' } as const;

/** 종합소득세·지역 건강보험료 추정(명목)과 추가 납입 세액공제 */
export function IncomeTaxCard({ tax }: { tax: TaxResult | null }) {
  const { profile: p, summary, assets, liabilities } = useFlp();
  const nowYear = p.birthYear + summary.age;
  const slotByYear = useMemo(() => (tax ? new Map(tax.rows.map((r) => [r.year, r.slot.self + r.slot.spouse])) : undefined), [tax]);
  const rows = useMemo(() => incomeTaxSchedule(p, nowYear, slotByYear, assets, liabilities), [p, nowYear, slotByYear, assets, liabilities]);
  const contrib = useMemo(() => contribSchedule(p, rows), [p, rows]);
  if (rows.length === 0) return null;
  const hasSpouse = p.spouseBirthYear > 0;
  const first = rows[0];
  const npStart = rows.find((r) => r.npSelf + r.npSpouse > 0);
  const after = npStart ? rows.find((r) => r.year === npStart.year + 2) ?? rows[rows.length - 1] : rows[Math.min(10, rows.length - 1)];
  const npTotal = rows.reduce((a, r) => a + Math.max(0, r.npPart) / r.defl, 0);
  const addToDraw = p.incomeTax?.addToDraw ?? false;
  const propAuto = p.incomeTax?.hiPropAuto ?? false;
  const loanDed = propAuto && rows.some((r) => r.loanDed > 0);
  // 대출 공제가 끝나는 해: 공제가 있다가 처음 0이 되는 해(상환 끝 또는 2주택)
  const loanEnd = loanDed ? rows.find((r, i) => i > 0 && r.loanDed <= 0 && rows[i - 1].loanDed > 0) : undefined;
  const hasOther = rows.some((r) => r.other > 0);
  const hasSalary = rows.some((r) => r.salary > 0);
  const postBase = rows.find((r) => r.baseYear !== first.year);
  const splitBase = !!postBase;
  return (
    <Card title="종합소득세·건강보험료" className="mt-4" action={<span className="text-xs text-muted">추정 · 명목 금액</span>}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-xl bg-sunken p-3">
          <div className="text-xs text-muted">{first.year}년 연 부담</div>
          <div className="mt-0.5 text-lg font-bold">{won(first.total)}</div>
          <div className="text-xs text-muted">종소세 {won(first.taxSelf + first.taxSpouse)} · 건보료 월 {won(first.hiMonth)}{propAuto ? `(재산분 ${won(first.hiProp)})` : ''}</div>
        </div>
        <div className="rounded-xl bg-sunken p-3">
          <div className="text-xs text-muted">{after.year}년 연 부담{npStart ? ' (국민연금 2년 뒤)' : ''}</div>
          <div className="mt-0.5 text-lg font-bold">{won(after.total)}</div>
          <div className="text-xs text-muted">{after.baseYear === first.year ? '첫해' : `${after.baseYear}년(은퇴 후 첫해)`}보다 {won(after.increase)} · 건보료 월 {won(after.hiMonth)}</div>
        </div>
        <div className="rounded-xl bg-sunken p-3">
          <div className="text-xs text-muted">그중 국민연금 몫(합계)</div>
          <div className="mt-0.5 text-lg font-bold">{won(npTotal)}</div>
          <div className="text-xs text-muted">오늘 물가 · {addToDraw ? '연금계좌 인출에 더함' : '인출에는 넣지 않음'}</div>
        </div>
        <div className="rounded-xl bg-sunken p-3">
          <div className="text-xs text-muted">추가 납입 세액공제</div>
          <div className="mt-0.5 text-lg font-bold">{contrib.length ? won(contrib.reduce((a, c) => a + c.creditSelf + c.creditSpouse, 0)) : '없음'}</div>
          <div className="text-xs text-muted">{contrib.length ? `${contrib[0].year}~${contrib[contrib.length - 1].year}년 납입 · 다음 해 환급` : '데이터·설정에서 입력'}</div>
        </div>
      </div>

      {contrib.length > 0 && (
        <div className="mt-3 -mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
          <table className="w-full min-w-[520px] text-sm num-table">
            <thead>
              <tr className="border-b border-line text-right text-xs text-muted">
                <th className="py-1.5 text-left font-medium">납입 연도</th>
                <th className="font-medium">본인 납입 · 공제율</th>
                {hasSpouse && <th className="font-medium">배우자 납입 · 공제율</th>}
                <th className="font-medium">세액공제(환급)</th>
                <th className="font-medium">과세제외로 쌓임</th>
              </tr>
            </thead>
            <tbody>
              {contrib.map((c) => (
                <tr key={c.year} className="border-b border-line text-right last:border-0">
                  <td className="py-1.5 text-left">{c.year}년</td>
                  <td>{c.self > 0 ? `${won(c.self)} · ${c.rateSelf}%` : '-'}</td>
                  {hasSpouse && <td>{c.spouse > 0 ? `${won(c.spouse)} · ${c.rateSpouse}%` : '-'}</td>}
                  <td className="font-semibold">{won(c.creditSelf + c.creditSpouse)}</td>
                  <td className="text-muted">{won(c.self + c.spouse - c.taxedSelf - c.taxedSpouse)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-3 -mx-4 max-h-[360px] overflow-auto px-4 sm:-mx-5 sm:px-5">
        <table className="w-full text-sm num-table" style={{ minWidth: (loanDed ? 1100 : propAuto ? 1000 : 860) + (hasOther ? 100 : 0) + (hasSalary ? 100 : 0) }}>
          <thead className="sticky top-0 bg-surface">
            <tr className="border-b border-line text-right text-xs text-muted">
              <th className="py-2 text-left font-medium">연도</th>
              {hasSalary && <th className="font-medium">은퇴 전 급여</th>}
              <th className="font-medium">임대수입</th>
              {hasOther && <th className="font-medium">그 밖의 소득</th>}
              <th className="font-medium">국민연금(세전)</th>
              <th className="font-medium">종소세{hasSpouse ? ' 본인/배우자' : ''}</th>
              <th className="font-medium">5월 추가납부</th>
              {loanDed && <th className="font-medium">대출 공제</th>}
              {propAuto && <th className="font-medium">재산 과표 · 월 재산분</th>}
              <th className="font-medium">월 건보료</th>
              <th className="font-medium">연 부담</th>
              <th className="font-medium">{splitBase ? '기준 해 대비' : '첫해 대비'}</th>
              <th className="font-medium">국민연금 몫</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.year} className="border-b border-line text-right last:border-0">
                <td className="py-1.5 text-left font-medium">
                  {r.year}
                  <span className="ml-1 text-xs font-normal text-muted">{r.age}세</span>
                  {splitBase && r.year === r.baseYear && <span className="ml-1 rounded bg-sunken px-1 text-[10px] font-normal text-muted">{r.year === first.year ? '은퇴 전 기준' : '은퇴 후 기준'}</span>}
                </td>
                {hasSalary && <td>{won(r.salary)}</td>}
                <td>{won(r.rent)}</td>
                {hasOther && <td>{won(r.other)}</td>}
                <td>{won(r.npSelf + r.npSpouse)}</td>
                <td className="whitespace-nowrap">{won(r.taxSelf, false)}{hasSpouse && <> / {won(r.taxSpouse, false)}</>}</td>
                <td>{won(r.due)}</td>
                {loanDed && (
                  <td className={r === loanEnd ? 'font-semibold text-warn' : 'text-muted'}>
                    {r.loanDed > 0 ? `−${won(r.loanDed)}` : r === loanEnd ? '0 (공제 끝)' : '-'}
                  </td>
                )}
                {propAuto && <td className="whitespace-nowrap text-muted">{won(r.propBase)} · {won(r.hiProp)}</td>}
                <td className="whitespace-nowrap">
                  {r.hiMode !== 'region' && <span className="mr-1 rounded bg-sunken px-1 text-[10px] text-muted">{HI_MODE[r.hiMode]}</span>}
                  {won(r.hiMonth)}
                </td>
                <td className="font-semibold">{won(r.total)}</td>
                <td className={r.increase > 0.5 ? 'text-warn' : ''}>{won(r.increase)}</td>
                <td className="text-muted">{won(r.npPart)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">
        {hasSalary && <li>은퇴 전 급여 = 프로필의 ‘은퇴 전 세전 총급여’(부부 합계, 물가만큼 오름)입니다. 은퇴 전 해까지 월세 등과 합쳐 종합소득세를 계산하고, 회사에서 연말정산으로 낸 세금(급여만 있다고 본 결정세액)은 기납부로 빼서 5월 추가납부에는 월세 등 때문에 늘어난 세금만 들어갑니다. 급여에 붙는 건보료는 직장에서 낸다고 보고 넣지 않습니다.</li>}
        {hasSalary && <li>급여가 있는 사람은 그 해 직장가입자로 봅니다(표의 ‘직장’ 표시). 재산분이 없고, 급여 외 소득(임대·사업소득 + 공적연금·근로소득 × 반영률)이 연 2,000만원을 넘는 부분에만 소득월액 보험료가 붙습니다.{hasSpouse ? ' 부부 중 한 명만 일하는 해에는 다른 한 명이 피부양자 요건(임대·사업소득 없음 · 연금 등 합산소득 2,000만원 이하 · 재산분을 부동산 자산으로 추정할 때는 본인 명의 재산 과표 5.4억 이하, 소득 1,000만원 이하면 9억 이하)을 채우면 보험료가 없고(‘직장+피부양’), 못 채우면 그 사람만 지역가입자로 본인 소득과 본인 명의 재산분을 냅니다(‘직장+지역’). 임대·사업소득이 조금이라도 있으면 사업자등록이 있다고 보고 피부양자에서 뺐습니다.' : ''}{propAuto ? '' : ' 고지서 역산 방식에서는 명의를 나눌 수 없어 ‘직장+지역’인 해에 세대 재산분 전체를 넣습니다.'} 둘 다 은퇴한 해부터는 부부 한 세대 지역가입자입니다.</li>}
        {hasOther && <li>그 밖의 소득 = 데이터·설정 ‘그 밖의 은퇴 후 소득’ 중 근로·사업·공적연금·사적연금으로 고른 항목의 세전 수입입니다. 근로소득은 근로소득공제·근로소득세액공제·표준세액공제 13만을 하고, 연말정산으로 이미 낸 세금(근로소득만 있다고 본 결정세액)을 기납부로 빼서 5월 추가납부에는 다른 소득과 합쳐 늘어난 세금만 들어갑니다. 사업소득은 필요경비율을 빼고, 공무원·사학·군인연금은 국민연금과 합쳐 연금소득공제를 합니다. 사적연금은 종소세에서 빼고 ‘사적연금도 건보료에 반영’일 때만 건보료에 넣습니다.</li>}
        <li>사적연금(1,500만원 이하 분리과세)·퇴직소득·노란우산은 종합소득과 건보료에 들어가지 않습니다(2026년 기준). {hasSalary ? '급여가 없는 해는 ' : ''}부부 한 세대 지역가입자로 계산하고, 세율·보험료율은 지금 기준으로 고정합니다.</li>
        <li>건보료 소득분은 전년도 소득(임대·사업소득 + (공적연금·근로소득) × 반영률)으로, 재산분은 {propAuto ? '부동산 자산 시세로 구한 재산 과세표준(부부 합산, 매각 연도부터 제외)에서 기본공제 1억을 빼고 재산등급 점수 × 211.5원(2026년)으로 해마다 추정합니다' + (loanDed ? '. 대출 공제 = 실거주 주택 구입 대출의 그 해 잔액 × 60%(한도 5,000만, 1세대 1주택일 때만)를 재산 과표에서 뺀 금액입니다' + (loanEnd ? `. ${loanEnd.year}년(${loanEnd.age}세)부터는 대출 상환이 끝나거나 주택이 2채 이상이 되어 공제가 없어지고 재산분이 그만큼 오릅니다` : '. 표의 마지막 해까지 공제가 이어집니다') : '') : '지금 고지서에서 역산합니다'}. 국민연금 몫 = 국민연금 때문에 늘어난 종소세(원천징수 뺌) + 건보료 소득분.</li>
        {postBase && <li>기준 해 대비 = 은퇴 전 급여가 있는 해는 {first.year}년과, 급여가 모두 끝난 {postBase.baseYear}년부터는 {postBase.baseYear}년(은퇴 후 첫해)과 비교한 금액입니다. 은퇴하면 급여 때문에 높던 세율이 내려가 세금이 줄어드는데, 이를 ‘감소’로 보이지 않게 은퇴 후는 따로 비교합니다.</li>}
        <li>{postBase ? '기준 해' : '첫해'} 부담은 이미 생활비에 들어 있다고 봅니다. 늘어나는 금액은 {addToDraw ? '국민연금 몫만큼 해마다 연금계좌에서 더 꺼내도록 노후 진단·인출에 반영했습니다.' : '생활비 안에서 쓰는 것으로 보고 인출에는 넣지 않았습니다(데이터·설정에서 바꿀 수 있음).'}</li>
      </ul>
    </Card>
  );
}
