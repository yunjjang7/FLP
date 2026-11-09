import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { won } from '../lib/format';
import { CHART_COLORS } from './ui';

export function Donut({ data, center }: { data: { label: string; value: number }[]; center?: string }) {
  const total = data.reduce((a, d) => a + d.value, 0);
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row">
      <div className="relative h-40 w-40 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="label" innerRadius={50} outerRadius={75} paddingAngle={1.5} stroke="var(--c-surface)" strokeWidth={2} isAnimationActive={false}>
              {data.map((_, i) => (
                <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip formatter={(v: number) => won(v)} />
          </PieChart>
        </ResponsiveContainer>
        {center && <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm font-bold">{center}</div>}
      </div>
      <ul className="w-full min-w-0 flex-1 space-y-1.5 text-sm">
        {data.map((d, i) => (
          <li key={d.label} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
            <span className="min-w-0 flex-1 truncate">{d.label}</span>
            <span className="shrink-0 text-muted">{total > 0 ? ((d.value / total) * 100).toFixed(1) : 0}%</span>
            <span className="w-[4.5rem] shrink-0 text-right font-medium">{won(d.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
