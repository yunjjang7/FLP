import { db, type ListTable } from './db';

/**
 * 기본 정보 화면 카드 순서. 목록마다 order(작을수록 위)를 저장하고, 없으면 id(추가한 순서)로 정렬.
 * 화면에 보여 주는 순서일 뿐 계산에는 쓰지 않음: 계산은 지금처럼 추가한 순서(id)를 쓰고,
 * 연금 인출 순서는 따로 ‘꺼내는 순서’(drawOrder)를 씀.
 */
interface Ordered {
  id?: number;
  order?: number;
}

const keyOf = (r: Ordered) => (typeof r.order === 'number' && Number.isFinite(r.order) ? r.order : (r.id ?? 0));

/** 화면 순서로 정렬한 새 배열(같은 순서면 id 순) */
export function byOrder<T extends Ordered>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => keyOf(a) - keyOf(b) || (a.id ?? 0) - (b.id ?? 0));
}

/**
 * id 줄을 한 칸 위(-1)·아래(+1)로 옮긴 뒤의 순서: 모든 줄에 0부터 다시 매긴 order. 끝에서 더 못 가면 null
 */
export function moveOrder(rows: readonly Ordered[], id: number, dir: -1 | 1): { id: number; order: number }[] | null {
  const list = byOrder(rows);
  const i = list.findIndex((r) => r.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return null;
  [list[i], list[j]] = [list[j], list[i]];
  return list.filter((r) => r.id !== undefined).map((r, k) => ({ id: r.id!, order: k }));
}

/** 다음에 추가할 줄의 order: 지금 맨 아래보다 하나 뒤 */
export const nextOrder = (rows: readonly Ordered[]) => rows.reduce((m, r) => Math.max(m, keyOf(r)), -1) + 1;

/** 기본 정보 목록의 한 줄을 한 칸 위·아래로 옮겨 저장 */
export async function moveRow(table: ListTable, id: number, dir: -1 | 1) {
  const tbl = db[table] as unknown as { toArray: () => Promise<Ordered[]>; update: (id: number, p: object) => Promise<number> };
  await db.transaction('rw', db[table], async () => {
    const next = moveOrder(await tbl.toArray(), id, dir);
    if (next) for (const x of next) await tbl.update(x.id, { order: x.order });
  });
}

/** 배열(프로필의 소득·생활비 구간 등)에서 i 번째를 한 칸 옮긴 새 배열. 못 옮기면 그대로 */
export function moveItem<T>(list: readonly T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return [...list];
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** CSV 가져오기: ‘기존 데이터에 추가’면 가져온 줄의 화면 순서를 지금 맨 아래 뒤로 밀어 기존 순서를 지킴 */
export function appendOrders<T extends Ordered>(existing: readonly Ordered[], rows: T[]): T[] {
  const base = nextOrder(existing);
  return rows.map((r, k) => ({ ...r, order: base + (typeof r.order === 'number' ? r.order : k) }));
}
