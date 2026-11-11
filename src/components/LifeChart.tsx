import { Area, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { SimResult } from '../engine/montecarlo';
import { won } from '../lib/format';

/** 생애 자산 곡선: 10~90 퍼센타일 밴드 + 중앙값 + 결정론적 경로 (+ 비교 중앙값, 예: 하락장 가드레일) */
export function LifeChart({ sim, retireAge, height = 300, compare }: { sim: SimResult; retireAge: number; height?: number; compare?: { name: string; p50: number[] } }) {
  const data = sim.ages.map((age, i) => ({
    age,
    band: [sim.p10[i], sim.p90[i]] as [number, number],
    p50: sim.p50[i],
    det: sim.deterministic[i],
    cmp: compare?.p50[i],
  }));
  return (
    <div style={{ height }}>
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="age" tickLine={false} axisLine={false} unit="세" minTickGap={16} />
          <YAxis tickFormatter={(v) => won(v, false)} width={56} tickLine={false} axisLine={false} />
          <Tooltip
            labelFormatter={(a) => `${a}세`}
            formatter={(v: number | [number, number], name) => (Array.isArray(v) ? [`${won(v[0])} ~ ${won(v[1])}`, name] : [won(v), name])}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <ReferenceLine x={retireAge} stroke="var(--c-muted)" strokeDasharray="4 4" label={{ value: '은퇴', position: 'insideTopRight', fill: 'var(--c-muted)', fontSize: 11 }} />
          <Area dataKey="band" name="범위(하위10%~상위10%)" stroke="none" fill="var(--chart-1)" fillOpacity={0.15} isAnimationActive={false} />
          <Line dataKey="p50" name="중앙값" stroke="var(--chart-1)" strokeWidth={2.5} dot={false} isAnimationActive={false} />
          {compare && <Line dataKey="cmp" name={compare.name} stroke="var(--chart-2)" strokeWidth={2} dot={false} isAnimationActive={false} />}
          <Line dataKey="det"name="평균수익 가정" stroke="var(--chart-3)" strokeWidth={1.5} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
