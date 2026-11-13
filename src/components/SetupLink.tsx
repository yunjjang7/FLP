import { useEffect, type ReactNode } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';

/** 기본 정보 화면의 탭 */
export type SetupTab = 'profile' | 'assets' | 'liabilities' | 'cashflows' | 'goals' | 'insurance' | 'criteria' | 'backup';

/** 기본 정보 화면의 탭(→ 카드 → 칸)으로 가는 주소. 기본 정보 화면이 그 칸으로 스크롤하고 잠깐 강조함 */
export function setupHref(tab: SetupTab, card?: string, field?: string) {
  const q = new URLSearchParams({ tab });
  if (card) q.set('card', card);
  if (field) q.set('field', field);
  return `/data?${q}`;
}

/** 안내 문구 속 메뉴 경로를 누르면 그 설정 칸으로 이동 */
export function SetupLink({ tab, card, field, inherit, children }: { tab: SetupTab; card?: string; field?: string; /** 경고 상자처럼 글자색이 정해진 곳에서는 그 색 그대로 */ inherit?: boolean; children: ReactNode }) {
  return (
    <Link
      to={setupHref(tab, card, field)}
      className={`font-medium underline underline-offset-2 ${inherit ? 'decoration-current/50 hover:decoration-current' : 'text-brand decoration-brand/40 hover:decoration-brand'}`}
    >
      {children}
    </Link>
  );
}

/**
 * card(data-card)·field(data-field)를 찾아 화면 가운데로 스크롤하고 잠깐 강조. 정리 함수를 돌려줌.
 * 내용이 그려질 때까지(데이터 로딩·계산 포함) 잠깐 기다리며 찾고, 칸이 숨겨져 있으면 카드로
 */
export function jumpToTarget(card: string | null, field: string | null, maxTries = 20) {
  let tries = 0;
  let timer = 0;
  let fix = 0;
  const find = () => {
    const scope: ParentNode | null = card ? document.querySelector(`[data-card="${CSS.escape(card)}"]`) : document;
    const el = (field && scope?.querySelector<HTMLElement>(`[data-field="${CSS.escape(field)}"]`)) || (scope instanceof HTMLElement ? scope : null);
    if (!el) {
      if (++tries < maxTries) timer = window.setTimeout(find, 100);
      return;
    }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // 부드러운 스크롤이 막히거나(아래 표가 계산되며 길이가 바뀌는 경우 등) 덜 갔으면 바로 이동
    fix = window.setTimeout(() => {
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) el.scrollIntoView({ block: 'center' });
    }, 900);
    el.classList.remove('setup-target');
    void el.offsetWidth; // 같은 칸을 다시 눌러도 강조가 다시 보이게
    el.classList.add('setup-target');
    el.querySelector<HTMLElement>('input, select')?.focus({ preventScroll: true });
    timer = window.setTimeout(() => el.classList.remove('setup-target'), 2600);
  };
  timer = window.setTimeout(find, 50);
  return () => {
    window.clearTimeout(timer);
    window.clearTimeout(fix);
  };
}

/** 주소의 ?card= 로 그 화면의 카드를 찾아 강조(기본 정보가 아닌 분석 화면용) */
export function useCardTarget() {
  const [sp] = useSearchParams();
  const { key } = useLocation();
  useEffect(() => {
    const card = sp.get('card');
    if (!card) return;
    return jumpToTarget(card, null, 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** 다른 분석 화면의 카드로 가는 링크(그 카드로 스크롤하고 잠깐 강조) */
export function CardLink({ to, card, children }: { to: string; card: string; children: ReactNode }) {
  return (
    <Link to={`${to}?${new URLSearchParams({ card })}`} className="font-medium text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand">
      {children}
    </Link>
  );
}
