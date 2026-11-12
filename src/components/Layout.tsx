import type { ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { applySwUpdate, useSwUpdateReady } from '../lib/swUpdate';
import { ErrorBoundary } from './ErrorBoundary';

const I = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);

export const NAV: { to: string; label: string; icon: ReactNode }[] = [
  { to: '/', label: '홈', icon: <I d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" /> },
  { to: '/invest', label: '투자 점검', icon: <I d="M4 19V5M4 19h16M8 15l3-4 3 2 5-6" /> },
  { to: '/retire', label: '노후 진단', icon: <I d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2" /> },
  { to: '/prescribe', label: '처방', icon: <I d="M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9" /> },
  { to: '/withdraw', label: '인출 계획', icon: <I d="M3 7h18v10H3zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM7 7V5h10v2" /> },
];

const SettingsIcon = <I d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />;

/** 새 버전이 받아졌을 때 새로고침 안내(모바일은 하단 탭바 위, PC는 오른쪽 아래) */
function UpdateBanner() {
  const ready = useSwUpdateReady();
  if (!ready) return null;
  return (
    <div role="status" className="fixed inset-x-3 z-20 mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 shadow-lg bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] md:inset-x-auto md:right-6 md:bottom-6">
      <span className="min-w-0 flex-1 text-sm">
        <span className="font-semibold">새 버전이 있습니다.</span>
        <span className="text-muted"> 새로고침하면 최신 화면이 열립니다(입력한 데이터는 그대로).</span>
      </span>
      <button type="button" onClick={applySwUpdate} className="shrink-0 rounded-xl bg-brand px-3 py-2 text-sm font-semibold text-white">
        새로고침
      </button>
    </div>
  );
}

export function Layout() {
  const { pathname } = useLocation();
  return (
    <div className="min-h-dvh md:flex">
      {/* PC 사이드바 */}
      <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-line bg-surface px-3 py-5 md:flex">
        <div className="mb-6 flex items-center gap-2 px-2">
          <img src="./icon.svg" alt="" className="h-8 w-8" />
          <div>
            <div className="text-[15px] font-bold leading-tight">Financial Life Planning</div>
            <div className="text-[11px] text-muted">자산관리</div>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-1">
          {/* 데이터·설정은 인출 계획 바로 아래 */}
          {[...NAV, { to: '/data', label: '데이터·설정', icon: SettingsIcon }].map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium ${isActive ? 'bg-brand-soft text-brand' : 'text-muted hover:bg-sunken hover:text-ink'}`}>
              {n.icon}
              {n.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="min-w-0 flex-1">
        {/* 모바일 상단바 */}
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-surface/90 px-4 py-3 backdrop-blur md:hidden" style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}>
          <div className="flex items-center gap-2">
            <img src="./icon.svg" alt="" className="h-7 w-7" />
            <span className="font-bold">Financial Life Planning</span>
          </div>
          <NavLink to="/data" aria-label="데이터·설정" className={({ isActive }) => `rounded-lg p-1.5 ${isActive ? 'text-brand' : 'text-muted'}`}>
            {SettingsIcon}
          </NavLink>
        </header>

        <main className="mx-auto w-full max-w-5xl px-4 pb-28 pt-5 md:px-8 md:pb-10 md:pt-8">
          <ErrorBoundary resetKey={pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>

        <UpdateBanner />

        {/* 모바일 하단 탭바 */}
        <nav className="fixed inset-x-0 bottom-0 z-10 grid grid-cols-5 border-t border-line bg-surface/95 backdrop-blur md:hidden" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${isActive ? 'text-brand' : 'text-muted'}`}>
              {n.icon}
              {n.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}
