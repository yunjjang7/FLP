import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { foldAll, loadFoldedKeys, saveFoldedKeys } from '../db/fold';

/** 바로가기(jumpToTarget)가 접힌 카드를 찾을 때 보내는 이벤트: 그 제목의 카드를 펼침 */
export const UNFOLD_EVENT = 'flp-unfold-card';

export interface FoldScope {
  folded: string[];
  /** 지금 화면에 있는 접을 수 있는 카드 제목 */
  keys: string[];
  /** 보이는 카드가 모두 접혔는지(카드가 없으면 true) */
  allFolded: boolean;
  toggle: (key: string) => void;
  setAll: (fold: boolean) => void;
  register: (key: string) => () => void;
}

const Ctx = createContext<FoldScope | null>(null);

/** 한 화면(탭)의 카드 접기 상태. 접은 제목은 scope 이름으로 브라우저에 저장 */
export function useFoldScope(scope: string): FoldScope {
  const [folded, setFolded] = useState<string[]>(() => loadFoldedKeys(scope));
  const [keys, setKeys] = useState<string[]>([]);
  const update = useCallback(
    (f: (prev: string[]) => string[]) =>
      setFolded((prev) => {
        const next = f(prev);
        if (next.length === prev.length && next.every((k) => prev.includes(k))) return prev;
        saveFoldedKeys(scope, next);
        return next;
      }),
    [scope],
  );
  const register = useCallback((key: string) => {
    setKeys((ks) => (ks.includes(key) ? ks : [...ks, key]));
    return () => setKeys((ks) => ks.filter((k) => k !== key));
  }, []);
  // 다른 화면의 바로가기로 접힌 카드를 찾아오면 그 카드를 펼침
  useEffect(() => {
    const on = (e: Event) => {
      const card = (e as CustomEvent<{ card?: string }>).detail?.card;
      if (card) update((prev) => prev.filter((k) => k !== card));
    };
    window.addEventListener(UNFOLD_EVENT, on);
    return () => window.removeEventListener(UNFOLD_EVENT, on);
  }, [update]);
  return useMemo(
    () => ({
      folded,
      keys,
      allFolded: keys.every((k) => folded.includes(k)),
      toggle: (key: string) => update((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key])),
      setAll: (fold: boolean) => update((prev) => foldAll(prev, keys, fold)),
      register,
    }),
    [folded, keys, update, register],
  );
}

export function FoldProvider({ value, children }: { value: FoldScope; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 접기 범위 안이면 이 카드의 접힘 상태(범위 밖이거나 key 가 없으면 null: 접기 없음) */
export function useFold(key?: string) {
  const ctx = useContext(Ctx);
  const register = ctx?.register;
  useEffect(() => (register && key ? register(key) : undefined), [register, key]);
  if (!ctx || !key) return null;
  return { folded: ctx.folded.includes(key), toggle: () => ctx.toggle(key) };
}

/** 카드 머리의 접기 표시(펼치면 아래, 접으면 오른쪽) */
export function FoldChevron({ folded }: { folded: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className={`h-4 w-4 shrink-0 transition-transform ${folded ? '-rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}
