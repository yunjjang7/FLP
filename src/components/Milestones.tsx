import { useMemo, useState } from 'react';
import { MILESTONE_KIND, milestones, untilLabel, yearTodos } from '../engine/milestones';
import { useFlp } from '../store/FlpContext';
import { Card } from './ui';

const SHOWN = 8;

/** 엑셀 대시보드 ‘올해·내년 할 일’과 ‘다가오는 이정표’ */
export function Milestones() {
  const { profile, assets, liabilities, goals } = useFlp();
  const [all, setAll] = useState(false);
  const now = new Date();
  const nowYear = now.getFullYear();
  const nowMonth = now.getMonth() + 1;
  const list = useMemo(() => milestones(profile, assets, liabilities, goals, nowYear, nowMonth), [profile, assets, liabilities, goals, nowYear, nowMonth]);
  const todos = useMemo(
    () => [nowYear, nowYear + 1].map((y) => ({ year: y, items: yearTodos(profile, assets, nowYear, y, liabilities, nowMonth) })).filter((t) => t.items.length > 0),
    [profile, assets, liabilities, nowYear, nowMonth],
  );
  if (list.length === 0 && todos.length === 0) return null;
  const shown = all ? list : list.slice(0, SHOWN);
  return (
    <Card title="다가오는 이정표·할 일" className="mt-4" action={<span className="text-xs text-muted">{nowYear}년 {nowMonth}월 기준</span>}>
      {todos.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {todos.map((t) => (
            <div key={t.year} className="rounded-xl bg-sunken p-3">
              <div className="text-xs font-medium text-muted">{t.year === nowYear ? `올해(${t.year})` : `내년(${t.year})`} 할 일</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm">
                {t.items.map((x) => <li key={x}>{x}</li>)}
              </ul>
            </div>
          ))}
        </div>
      )}
      {shown.length > 0 && (
        <div className={`-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5 ${todos.length ? 'mt-3' : ''}`}>
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="py-1.5 font-medium">시점</th>
                <th className="font-medium">구분</th>
                <th className="font-medium">내용</th>
                <th className="text-right font-medium">남은 기간</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((m, i) => (
                <tr key={`${m.year}-${m.month}-${m.label}-${i}`} className="border-b border-line align-top last:border-0">
                  <td className="whitespace-nowrap py-1.5 font-medium tabular-nums">{m.year}{m.month ? `-${String(m.month).padStart(2, '0')}` : '년'}</td>
                  <td className="whitespace-nowrap pr-2 text-xs text-muted">{MILESTONE_KIND[m.kind]}</td>
                  <td>
                    {m.label}
                    {m.note && <div className="text-xs text-muted">{m.note}</div>}
                  </td>
                  <td className="whitespace-nowrap text-right tabular-nums text-muted">{untilLabel(m, nowYear, nowMonth)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.length > SHOWN && (
        <button className="mt-2 text-xs font-medium text-brand hover:underline" onClick={() => setAll((v) => !v)}>
          {all ? '가까운 것만 보기' : `뒤의 ${list.length - SHOWN}건 더 보기`}
        </button>
      )}
      <p className="mt-2 text-xs text-muted">프로필(출생 월·국민연금·추가 납입)과 자산(연금수령 1년차·인출 시작 연도·수령 연도·매각 연도), 부채·목표에 넣은 값으로 만든 일정입니다. 연금 개시·노란우산 수령 요건은 금융사·공제회에 미리 확인하세요.</p>
    </Card>
  );
}
