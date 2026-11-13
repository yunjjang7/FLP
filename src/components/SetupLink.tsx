import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

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
