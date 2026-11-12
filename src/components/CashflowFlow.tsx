import { useMemo, useState } from 'react';
import { yearFlow, type FlowItem } from '../engine/flow';
import { pct, won } from '../lib/format';
import { useFlp } from '../store/FlpContext';
import { Card } from './ui';

const COLOR: Record<FlowItem['tone'], string> = {
  income: 'var(--chart-2)',
  lump: 'var(--chart-6)',
  draw: 'var(--chart-3)',
  living: 'var(--chart-1)',
  debt: 'var(--chart-5)',
  tax: 'var(--chart-4)',
  premium: 'var(--chart-6)',
  goal: 'var(--chart-7)',
  save: 'var(--c-good)',
};

const W = 560;
const BAR = 12;
const LX = 150; // 왼쪽 막대
const CX = (W - BAR) / 2; // 가운데 막대
const RX = W - 150 - BAR; // 오른쪽 막대
const GAP = 10;
const ROW = 34; // 한 줄 최소 높이(이름·금액 두 줄이 겹치지 않게)

/** 한쪽 막대들의 세로 위치: 금액에 비례하되 줄마다 최소 높이를 둠 */
function layout(items: FlowItem[], scale: number) {
  let y = 0;
  return items.map((x) => {
    const h = Math.max(3, x.amount * scale);
    const slot = Math.max(h, ROW);
    const top = y + (slot - h) / 2;
    y += slot + GAP;
    return { x, top, h };
  });
}

/** 막대 옆 칸에 들어가게 이름을 줄임 */
const short = (s: string) => (s.length > 11 ? `${s.slice(0, 10)}…` : s);

/** 왼쪽(x0, y0~y0+h0)에서 오른쪽(x1, y1~y1+h1)으로 이어지는 띠 */
function ribbon(x0: number, y0: number, h0: number, x1: number, y1: number, h1: number) {
  const m = (x0 + x1) / 2;
  return `M${x0},${y0} C${m},${y0} ${m},${y1} ${x1},${y1} L${x1},${y1 + h1} C${m},${y1 + h1} ${m},${y0 + h0} ${x0},${y0 + h0} Z`;
}

/**
 * 노후 진단: 연간 현금흐름 흐름도. 한 해 동안 들어오는 돈(소득·일시금·금융자산 인출)이
 * 어디로 나가는지(생활비·대출·세금·보험료·목표 지출·저축)를 굵기로 보여 줌
 */
export function CashflowFlow() {
  const { planInput: inp, summary: s, profile: p } = useFlp();
  const first = inp.currentAge + (inp.firstYearShare !== undefined && inp.firstYearShare < 1 ? 1 : 0); // 올해가 몇 달 안 남았으면 내년부터
  const last = Math.max(first, inp.lifeExpectancy - 1);
  const [age, setAge] = useState(Math.min(last, Math.max(first, inp.retireAge)));
  const a = Math.min(last, Math.max(first, age));
  const flow = useMemo(() => yearFlow(inp, a, s.income * 12), [inp, a, s.income]);
  // 눈금으로 건너뛸 나이: 은퇴, 소득이 시작·끝나는 해, 일시금·목표가 있는 해
  const marks = useMemo(() => {
    const set = new Set<number>([first, inp.retireAge]);
    for (const x of inp.pensions) { set.add(x.startAge); if (x.endAge) set.add(x.endAge + 1); }
    for (const x of inp.inflows ?? []) set.add(x.age);
    for (const d of inp.debts ?? []) if (Number.isFinite(d.endAge)) set.add(d.endAge);
    return [...set].filter((v) => v >= first && v <= last).sort((x, y) => x - y);
  }, [inp, first, last]);

  const scale = flow.total > 0 ? 200 / flow.total : 0;
  const left = layout(flow.sources, scale);
  const right = layout(flow.uses, scale);
  const bottom = (l: ReturnType<typeof layout>) => (l.length ? l[l.length - 1].top + Math.max(l[l.length - 1].h, ROW) : 0);
  const H = Math.max(bottom(left), bottom(right), flow.total * scale) + 8;
  const ch = flow.total * scale;
  const cy = (H - ch) / 2;
  // 가운데 막대에서 띠가 차지하는 구간(위에서부터 차례로)
  const stack = (l: ReturnType<typeof layout>) => {
    let y = cy;
    return l.map((n) => { const h = n.x.amount * scale; const at = y; y += h; return { at, h }; });
  };
  const ls = stack(left);
  const rs = stack(right);
  const year = p.birthYear + a;
  const draw = flow.sources.find((x) => x.key === 'draw')?.amount ?? 0;
  const keep = flow.uses.filter((x) => x.tone === 'save').reduce((t, x) => t + x.amount, 0);

  return (
    <Card title="연간 현금흐름 흐름도" className="mt-4" action={<span className="text-xs text-muted">{year}년 · 본인 {a}세 · 1년 기준 · 오늘 물가</span>}>
      <p className="mb-3 text-sm text-muted">한 해 동안 들어오는 돈이 어디로 나가는지 굵기로 보여 줍니다. 왼쪽이 들어오는 돈, 오른쪽이 나가는 돈입니다.</p>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input type="range" aria-label="나이" className="min-w-40 flex-1 accent-[var(--c-brand)]" min={first} max={last} step={1} value={a} onChange={(e) => setAge(Number(e.target.value))} />
        <span className="w-14 text-right text-sm font-semibold">{a}세</span>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {marks.map((m) => (
          <button key={m} type="button" onClick={() => setAge(m)} className={`rounded-full px-2.5 py-1 text-xs font-medium ${m === a ? 'bg-brand text-white' : 'bg-sunken text-muted hover:text-ink'}`}>
            {m}세{m === inp.retireAge && m > inp.currentAge ? ' 은퇴' : ''}
          </button>
        ))}
      </div>

      {flow.total <= 0.5 ? (
        <p className="rounded-lg bg-sunken px-3 py-4 text-center text-sm text-muted">이 해에는 오가는 돈이 없습니다.</p>
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[420px]" role="img" aria-label={`${a}세 연간 현금흐름: 들어오는 돈 ${won(flow.total)}`}>
            {left.map((n, i) => <path key={n.x.key} d={ribbon(LX + BAR, n.top, n.h, CX, ls[i].at, ls[i].h)} fill={COLOR[n.x.tone]} opacity={0.28} />)}
            {right.map((n, i) => <path key={n.x.key} d={ribbon(CX + BAR, rs[i].at, rs[i].h, RX, n.top, n.h)} fill={COLOR[n.x.tone]} opacity={0.28} />)}
            <rect x={CX} y={cy} width={BAR} height={ch} rx={3} fill="var(--c-muted)" />
            {left.map((n) => (
              <g key={n.x.key}>
                <rect x={LX} y={n.top} width={BAR} height={n.h} rx={3} fill={COLOR[n.x.tone]} />
                <text x={LX - 8} y={n.top + n.h / 2 - 3} textAnchor="end" fontSize={12} fill="var(--c-ink)">{short(n.x.label)}</text>
                <text x={LX - 8} y={n.top + n.h / 2 + 13} textAnchor="end" fontSize={11} fill="var(--c-muted)">{won(n.x.amount)} · {pct((n.x.amount / flow.total) * 100)}</text>
              </g>
            ))}
            {right.map((n) => (
              <g key={n.x.key}>
                <rect x={RX} y={n.top} width={BAR} height={n.h} rx={3} fill={COLOR[n.x.tone]} />
                <text x={RX + BAR + 8} y={n.top + n.h / 2 - 3} fontSize={12} fill="var(--c-ink)">{short(n.x.label)}</text>
                <text x={RX + BAR + 8} y={n.top + n.h / 2 + 13} fontSize={11} fill="var(--c-muted)">{won(n.x.amount)} · {pct((n.x.amount / flow.total) * 100)}</text>
              </g>
            ))}
            <text x={CX + BAR / 2} y={Math.max(12, cy - 6)} textAnchor="middle" fontSize={12} fill="var(--c-muted)">연 {won(flow.total)}</text>
          </svg>
        </div>
      )}

      <p className="mt-3 text-sm">
        {a}세에는 연 <b>{won(flow.total)}</b>(월 {won(flow.total / 12)})이 오갑니다.{' '}
        {draw > 0.5 ? <>이 가운데 <b>{won(draw)}</b>({pct((draw / flow.total) * 100)})을 금융자산에서 꺼냅니다.</> : keep > 0.5 ? <>소득으로 지출을 대고 <b>{won(keep)}</b>이 금융자산에 쌓입니다.</> : <>소득과 지출이 맞습니다.</>}
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted">
        <li>금액은 1년 전체 기준의 오늘 물가 금액입니다. 한 번 쓰는 목표·만기에 갚는 대출 원금·일시금 수령은 그 해에만 나타납니다.</li>
        <li>연금계좌에서 꺼낼 때 떼는 연금소득세·퇴직소득세는 여기 들어 있지 않습니다. ‘인출 계획 → 연금 세금 점검’에서 확인하세요.</li>
        {!flow.retired && <li>은퇴 전 생활 지출은 세후 소득에서 대출 상환과 저축을 뺀 금액이라 보험료가 함께 들어 있습니다.</li>}
      </ul>
    </Card>
  );
}
