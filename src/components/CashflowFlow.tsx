import { useLayoutEffect, useMemo, useState } from 'react';
import { yearFlow, type FlowItem } from '../engine/flow';
import { spouseWork } from '../engine/goals';
import { pct, won } from '../lib/format';
import { useFlp } from '../store/FlpContext';
import { Card } from './ui';

const COLOR: Record<FlowItem['tone'], string> = {
  income: 'var(--chart-2)',
  lump: 'var(--chart-6)',
  draw: 'var(--chart-3)',
  short: 'var(--c-warn)',
  living: 'var(--chart-1)',
  debt: 'var(--chart-5)',
  tax: 'var(--chart-4)',
  premium: 'var(--chart-6)',
  goal: 'var(--chart-7)',
  save: 'var(--c-good)',
};

const BAR = 12;
const GAP = 10;
const TOP = 20; // 위쪽 합계 글자(연 ○○원) 자리
const NAME = 12; // 이름 글자 크기(px)
const AMT = 11; // 금액 글자 크기(px)
const LINE = { name: 15, amt: 14 }; // 줄 높이

let ctx: CanvasRenderingContext2D | null | undefined;
/** 글자 폭(px): 화면 글꼴로 재고, 잴 수 없으면 한글 1em · 그 밖 0.6em 으로 어림 */
function textWidth(s: string, size: number) {
  if (ctx === undefined) ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  if (ctx) {
    ctx.font = `${size}px ${getComputedStyle(document.body).fontFamily}`;
    return ctx.measureText(s).width;
  }
  return [...s].reduce((w, c) => w + (/[ㄱ-힝]/.test(c) ? size : size * 0.6), 0);
}

/** 이름을 칸 폭에 맞게 여러 줄로 나눔(띄어쓰기·여는 괄호 앞에서 먼저 끊고, 한 낱말이 칸보다 길면 글자 단위로). 줄이지 않음 */
function wrapText(s: string, max: number, measure: (t: string) => number): string[] {
  const out: string[] = [];
  let line = '';
  // 낱말 앞 띄어쓰기는 붙여 둠: 같은 줄에 이어 쓸 때만 살리고 새 줄 첫머리에서는 뺌
  const push = (piece: string) => {
    const word = piece.trimStart();
    const next = line ? line + piece : word;
    if (measure(next) <= max) { line = next; return; }
    if (line) { out.push(line); line = ''; }
    if (measure(word) <= max) { line = word; return; }
    for (const c of word) {
      if (line && measure(line + c) > max) { out.push(line); line = ''; }
      line += c;
    }
  };
  for (const w of s.trim().match(/\s*\(?[^\s(]+|\s*\(/g) ?? []) push(w);
  if (line) out.push(line);
  return out.length ? out : [''];
}

/** 막대 옆 글: 이름(여러 줄) + 금액·비중(칸이 좁으면 두 줄) */
function labelLines(x: FlowItem, total: number, width: number) {
  const name = wrapText(x.label, width, (t) => textWidth(t, NAME));
  const both = `${won(x.amount)} · ${pct((x.amount / total) * 100)}`;
  const amt = textWidth(both, AMT) <= width ? [both] : [won(x.amount), pct((x.amount / total) * 100)];
  return { name, amt, height: name.length * LINE.name + amt.length * LINE.amt };
}

/** 한쪽 막대들의 세로 위치: 금액에 비례하되 줄마다 글이 들어갈 높이를 둠 */
function layout(items: FlowItem[], scale: number, total: number, width: number) {
  let y = 0;
  return items.map((x) => {
    const h = Math.max(3, x.amount * scale);
    const text = labelLines(x, total, width);
    const slot = Math.max(h, text.height + 4);
    const top = y + (slot - h) / 2;
    y += slot + GAP;
    return { x, top, h, slot, text };
  });
}
type Node = ReturnType<typeof layout>[number];

/** 막대 옆 글(이름은 진하게, 금액은 흐리게): 막대 가운데에 맞춤 */
function Label({ n, x, anchor }: { n: Node; x: number; anchor: 'start' | 'end' }) {
  const y0 = n.top + n.h / 2 - n.text.height / 2;
  const lines = [...n.text.name.map((t) => ({ t, size: NAME, h: LINE.name, fill: 'var(--c-ink)' })), ...n.text.amt.map((t) => ({ t, size: AMT, h: LINE.amt, fill: 'var(--c-muted)' }))];
  let y = y0;
  return (
    <>
      {lines.map((l, i) => {
        y += l.h;
        return <text key={i} x={x} y={y - 3} textAnchor={anchor} fontSize={l.size} fill={l.fill}>{l.t}</text>;
      })}
    </>
  );
}

/** 카드 안 폭(px)을 재서 그림을 그 폭에 맞춤: 좁은 화면에서도 옆으로 밀지 않고 다 보이게 */
function useWidth(initial: number) {
  // 그림 칸은 오가는 돈이 있는 해에만 그려지므로 콜백 ref 로 나타날 때마다 다시 잼
  const [el, ref] = useState<HTMLDivElement | null>(null);
  const [w, setW] = useState(initial);
  useLayoutEffect(() => {
    if (!el) return;
    const set = () => setW(Math.round(el.clientWidth) || initial);
    set();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, initial]);
  return [ref, w] as const;
}

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
  // 배우자가 본인보다 먼저 은퇴하면 그 해부터 소득에서 배우자 몫을 뺌(엔진이 저축을 줄이는 것과 같은 나이·금액)
  const sw = useMemo(() => spouseWork(p), [p]);
  const flow = useMemo(() => yearFlow(inp, a, s.income * 12, sw), [inp, a, s.income, sw]);
  const spouseStops = sw !== undefined && sw.fromAge > first && sw.fromAge < inp.retireAge;
  // 눈금으로 건너뛸 나이: 은퇴, 배우자 은퇴, 소득이 시작·끝나는 해, 일시금·목표가 있는 해
  const marks = useMemo(() => {
    const set = new Set<number>([first, inp.retireAge]);
    if (spouseStops) set.add(sw.fromAge);
    for (const x of inp.pensions) { set.add(x.startAge); if (x.endAge) set.add(x.endAge + 1); }
    for (const x of inp.inflows ?? []) set.add(x.age);
    for (const d of inp.debts ?? []) if (Number.isFinite(d.endAge)) set.add(d.endAge);
    return [...set].filter((v) => v >= first && v <= last).sort((x, y) => x - y);
  }, [inp, first, last, spouseStops, sw]);

  const [box, boxW] = useWidth(560);
  const W = Math.max(280, Math.min(720, boxW));
  const TW = Math.min(150, Math.max(84, Math.floor(W * 0.26))); // 양쪽 글 칸 폭
  const LX = TW + 8; // 왼쪽 막대
  const CX = (W - BAR) / 2; // 가운데 막대
  const RX = W - TW - 8 - BAR; // 오른쪽 막대
  const scale = flow.total > 0 ? 200 / flow.total : 0;
  const left = layout(flow.sources, scale, flow.total, TW);
  const right = layout(flow.uses, scale, flow.total, TW);
  const bottom = (l: Node[]) => (l.length ? l[l.length - 1].top + (l[l.length - 1].h + l[l.length - 1].slot) / 2 : 0);
  const H = Math.max(bottom(left), bottom(right), flow.total * scale) + 8;
  const ch = flow.total * scale;
  const cy = (H - ch) / 2;
  // 가운데 막대에서 띠가 차지하는 구간(위에서부터 차례로)
  const stack = (l: Node[]) => {
    let y = cy;
    return l.map((n) => { const h = n.x.amount * scale; const at = y; y += h; return { at, h }; });
  };
  const ls = stack(left);
  const rs = stack(right);
  const year = p.birthYear + a;
  const draw = flow.sources.find((x) => x.key === 'draw')?.amount ?? 0;
  const keep = flow.uses.filter((x) => x.tone === 'save').reduce((t, x) => t + x.amount, 0);
  const over = flow.sources.find((x) => x.key === 'short')?.amount ?? 0; // 은퇴 전 소득으로 못 대는 저축·대출 상환

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
            {m}세{m === inp.retireAge && m > inp.currentAge ? ' 은퇴' : spouseStops && m === sw.fromAge ? ' 배우자 은퇴' : ''}
          </button>
        ))}
      </div>

      {flow.total <= 0.5 ? (
        <p className="rounded-lg bg-sunken px-3 py-4 text-sm text-muted">이 해에는 오가는 돈이 없습니다.</p>
      ) : (
        <div ref={box} className="min-w-0 overflow-hidden">
          <svg viewBox={`0 0 ${W} ${H + TOP}`} className="mx-auto block w-full" style={{ maxWidth: W }} role="img" aria-label={`${a}세 연간 현금흐름: 들어오는 돈 ${won(flow.total)}`}>
            <text x={CX + BAR / 2} y={12} textAnchor="middle" fontSize={12} fill="var(--c-muted)">연 {won(flow.total)}</text>
            <g transform={`translate(0,${TOP})`}>
            {left.map((n, i) => <path key={n.x.key} d={ribbon(LX + BAR, n.top, n.h, CX, ls[i].at, ls[i].h)} fill={COLOR[n.x.tone]} opacity={0.28} />)}
            {right.map((n, i) => <path key={n.x.key} d={ribbon(CX + BAR, rs[i].at, rs[i].h, RX, n.top, n.h)} fill={COLOR[n.x.tone]} opacity={0.28} />)}
            <rect x={CX} y={cy} width={BAR} height={ch} rx={3} fill="var(--c-muted)" />
            {left.map((n) => (
              <g key={n.x.key}>
                <rect x={LX} y={n.top} width={BAR} height={n.h} rx={3} fill={COLOR[n.x.tone]} />
                <Label n={n} x={LX - 8} anchor="end" />
              </g>
            ))}
            {right.map((n) => (
              <g key={n.x.key}>
                <rect x={RX} y={n.top} width={BAR} height={n.h} rx={3} fill={COLOR[n.x.tone]} />
                <Label n={n} x={RX + BAR + 8} anchor="start" />
              </g>
            ))}
            </g>
          </svg>
        </div>
      )}

      <p className="mt-3 text-sm">
        {a}세에는 연 <b>{won(flow.total)}</b>(월 {won(flow.total / 12)})이 오갑니다.{' '}
        {draw > 0.5 ? <>이 가운데 <b>{won(draw)}</b>({pct((draw / flow.total) * 100)})을 금융자산에서 꺼냅니다.</> : keep > 0.5 ? <>{over > 0.5 ? '' : '소득으로 지출을 대고 '}<b>{won(keep)}</b>이 금융자산에 쌓입니다.</> : <>소득과 지출이 맞습니다.</>}
        {over > 0.5 && <> 다만 세후 소득이 대출 상환과 저축의 합보다 <b>{won(over)}</b> 적은데도 시뮬레이션은 저축이 계획대로 쌓인다고 계산합니다(‘소득 초과 저축’). 소득·지출 입력을 확인하세요.</>}
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted">
        <li>금액은 1년 전체 기준의 오늘 물가 금액입니다. 한 번 쓰는 목표·만기에 갚는 대출 원금·일시금 수령은 그 해에만 나타납니다.</li>
        <li>연금계좌에서 꺼낼 때 떼는 연금소득세·퇴직소득세는 여기 들어 있지 않습니다. ‘인출 계획 → 연금 세금 점검’에서 확인하세요.</li>
        {!flow.retired && <li>은퇴 전 생활 지출은 세후 소득에서 대출 상환과 저축을 뺀 금액이라 보험료가 함께 들어 있습니다. 소득이 대출 상환과 저축보다 적은 해에는 0으로 둡니다.{spouseStops ? ` 배우자가 은퇴하는 ${sw.fromAge}세부터는 세후 소득에서 배우자 소득을 빼고, 저축도 그만큼 줄어든 것으로 계산합니다.` : ''}</li>}
        <li>금융자산에서 꺼내는 돈과 저축·투자는 서로 상계해 그 해의 순증감만 한쪽에 표시합니다(시뮬레이션의 수익 전 잔액 변화와 같음).</li>
      </ul>
    </Card>
  );
}
