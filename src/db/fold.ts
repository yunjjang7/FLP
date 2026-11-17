import { won } from '../lib/format';
import type { ListTable } from './db';
import { TABLES } from './schema';

/**
 * 기본 정보 목록 카드 접기: 접은 카드 id 를 목록마다 브라우저에 저장(이 브라우저에서만, 계산에는 쓰지 않음).
 * 저장소를 못 쓰면(사생활 보호 창 등) 접기는 되고 새로고침하면 펼친 상태로 돌아감.
 */
const KEY = (table: ListTable) => `flp-folded-${table}`;

/** 저장된 문자열 → 접은 id 목록(숫자만, 잘못된 값은 빈 목록) */
export function parseFolded(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : [];
  } catch {
    return [];
  }
}

export function loadFolded(table: ListTable): number[] {
  try {
    return parseFolded(globalThis.localStorage?.getItem(KEY(table)));
  } catch {
    return [];
  }
}

export function saveFolded(table: ListTable, ids: number[]) {
  try {
    if (ids.length) globalThis.localStorage?.setItem(KEY(table), JSON.stringify(ids));
    else globalThis.localStorage?.removeItem(KEY(table));
  } catch {
    // 저장 못 해도 화면 접기는 그대로
  }
}

/** id 하나 접기·펼치기 */
export const toggleFolded = (ids: number[], id: number) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);

/** 지금 목록에 없는 id(삭제한 카드)는 버림 */
export const pruneFolded = (ids: number[], rows: { id?: number }[]) => ids.filter((id) => rows.some((r) => r.id === id));

/**
 * 접은 카드 머리에 보일 한 줄 요약: 첫 선택 칸(유형·분류 등)의 값과 첫 금액 칸.
 * 이름 칸은 따로 보여 주므로 빼고, 값이 없는 칸은 건너뜀
 */
export function rowSummary(table: ListTable, r: Record<string, unknown>): string {
  const { fields } = TABLES[table];
  const parts: string[] = [];
  const sel = fields.find((f) => f.kind === 'select');
  if (sel) {
    const v = r[sel.key];
    const label = v === undefined || v === null || v === '' ? undefined : sel.options?.[String(v)];
    if (label) parts.push(label);
  }
  const amt = fields.find((f) => f.unit === '만원');
  if (amt) parts.push(won(Number(r[amt.key] ?? 0)));
  return parts.join(' · ');
}
