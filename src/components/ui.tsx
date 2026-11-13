import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Level } from '../types';
import { LEVEL_LABEL } from '../engine/risk';

export function Card({ title, action, children, className = '' }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section data-card={typeof title === 'string' ? title : undefined} className={`min-w-0 rounded-2xl border border-line bg-surface p-4 sm:p-5 ${className}`}>
      {(title || action) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
          {title && <h2 className="min-w-0 text-[15px] font-semibold">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Level }) {
  const color = tone === 'good' ? 'text-good' : tone === 'caution' ? 'text-warn' : tone === 'danger' ? 'text-bad' : '';
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted">{label}</div>
      <div className={`mt-0.5 truncate text-xl font-bold tracking-tight ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function Badge({ level, children }: { level: Level; children?: ReactNode }) {
  const cls = level === 'good' ? 'bg-good-soft text-good' : level === 'caution' ? 'bg-warn-soft text-warn' : 'bg-bad-soft text-bad';
  return <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{children ?? LEVEL_LABEL[level]}</span>;
}

export function PageHeader({ title, desc }: { title: string; desc?: ReactNode }) {
  return (
    <header className="mb-4">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      {desc && <p className="mt-1 text-sm text-muted">{desc}</p>}
    </header>
  );
}

export function Bar({ value, max = 100, level }: { value: number; max?: number; level?: Level }) {
  const w = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  const bg = level === 'good' ? 'bg-good' : level === 'caution' ? 'bg-warn' : level === 'danger' ? 'bg-bad' : 'bg-brand';
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-sunken">
      <div className={`h-full rounded-full ${bg}`} style={{ width: `${w}%` }} />
    </div>
  );
}

export function Button({ children, onClick, variant = 'primary', type = 'button', className = '', disabled }: { children: ReactNode; onClick?: () => void; variant?: 'primary' | 'ghost' | 'danger'; type?: 'button' | 'submit'; className?: string; disabled?: boolean }) {
  const cls =
    variant === 'primary'
      ? 'bg-brand text-white hover:opacity-90'
      : variant === 'danger'
        ? 'border border-line text-bad hover:bg-bad-soft'
        : 'border border-line text-ink hover:bg-sunken';
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${cls} ${className}`}>
      {children}
    </button>
  );
}

export function EmptyState() {
  return (
    <Card className="mx-auto max-w-lg">
      <div className="py-6">
        <h2 className="text-lg font-bold">아직 입력된 자산이 없습니다</h2>
        <p className="mt-2 text-sm text-muted">프로필과 자산을 입력하면 자산 현황·위험 점검·노후 진단이 자동으로 계산됩니다. 먼저 샘플 데이터로 둘러볼 수도 있습니다.</p>
        <Link to="/data" className="mt-5 inline-flex rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white">데이터 입력하러 가기</Link>
      </div>
    </Card>
  );
}

export function Disclaimer() {
  return <p className="mt-6 text-xs text-muted">계산 결과는 입력값과 가정에 기반한 참고용 추정치이며, 투자 권유나 금융 자문이 아닙니다.</p>;
}

export const CHART_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)', 'var(--chart-7)'];

/**
 * 카드 순서 바꾸기: 위·아래로 한 칸씩(휴대폰에서도 누르기 쉬운 크기). 옮긴 뒤 같은 버튼에 초점을 남겨 연달아 누를 수 있음
 */
export function MoveButtons({ name, index, count, onMove }: { name: string; index: number; count: number; onMove: (dir: -1 | 1) => void }) {
  if (count < 2) return null;
  const cls = 'inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line text-ink transition hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-30';
  return (
    <span className="inline-flex items-center gap-1" role="group" aria-label={`${name || '항목'} 순서`}>
      <button type="button" className={cls} disabled={index === 0} onClick={() => onMove(-1)} aria-label={`${name || '항목'} 위로 옮기기`} title="위로">
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 10l4-4 4 4" /></svg>
      </button>
      <button type="button" className={cls} disabled={index === count - 1} onClick={() => onMove(1)} aria-label={`${name || '항목'} 아래로 옮기기`} title="아래로">
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l4 4 4-4" /></svg>
      </button>
    </span>
  );
}
