import { drawAliases, drawRenamePlan } from '../engine/drawLog';
import { accountAttrs, groupOf, groupRows, type AccountKey } from '../engine/portfolio';
import { joinPlan, switchPlan } from '../engine/rebalance';
import type { Asset, Draw } from '../types';
import { db } from './db';

/**
 * 연금계좌 줄 나누기·합치기·묶기를 자산 탭(db)에 저장하는 동작. 확인창은 부르는 쪽(화면)에서 띄움.
 * 나누기·합치기는 바로 앞 상태(자산·인출 기록 전체)를 남겨 두어 한 번 되돌릴 수 있음.
 */

// ---------- 되돌리기 ----------

interface Tables {
  assets: Asset[];
  draws: Draw[];
}
export interface UndoEntry {
  label: string; // 예: ‘퇴직 IRP’ 한 줄로 합치기
  at: number;
  before: Tables;
  after: Tables;
}

const UNDO_KEY = 'flp-asset-undo';
let memo: UndoEntry | null | undefined;
const listeners = new Set<() => void>();

function readUndo(): UndoEntry | null {
  if (memo !== undefined) return memo;
  try {
    const raw = globalThis.localStorage?.getItem(UNDO_KEY);
    memo = raw ? (JSON.parse(raw) as UndoEntry) : null;
  } catch {
    memo = null;
  }
  return memo;
}

function writeUndo(e: UndoEntry | null) {
  memo = e;
  try {
    if (e) globalThis.localStorage?.setItem(UNDO_KEY, JSON.stringify(e));
    else globalThis.localStorage?.removeItem(UNDO_KEY);
  } catch {
    // 저장 공간이 막혀 있어도 이 화면에서는 되돌릴 수 있게 메모리에는 남김
  }
  for (const f of listeners) f();
}

export const undoEntry = () => readUndo();
export const clearUndo = () => writeUndo(null);
export function subscribeUndo(f: () => void) {
  listeners.add(f);
  return () => void listeners.delete(f);
}

const tables = async (): Promise<Tables> => ({ assets: await db.assets.toArray(), draws: await db.draws.toArray() });
const byId = <T extends { id?: number }>(xs: T[]) => [...xs].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
const same = (a: Tables, b: Tables) => JSON.stringify([byId(a.assets), byId(a.draws)]) === JSON.stringify([byId(b.assets), byId(b.draws)]);

/** 자산·인출 기록을 바꾸는 작업을 한 트랜잭션으로 돌리고, 바뀌었으면 되돌리기 기록을 남김 */
async function withUndo(label: string, run: () => Promise<boolean>): Promise<boolean> {
  let entry: UndoEntry | null = null;
  const done = await db.transaction('rw', db.assets, db.draws, async () => {
    const before = await tables();
    if (!(await run())) return false;
    const after = await tables();
    if (!same(before, after)) entry = { label, at: Date.now(), before, after };
    return true;
  });
  if (entry) writeUndo(entry);
  return done;
}

/**
 * 바로 앞 나누기·합치기 되돌리기. 그 뒤 자산 탭·인출 기록을 고쳤으면 force 없이는 'changed' 를 돌려줌(고친 내용도 사라지므로).
 */
export async function undoLast(force = false): Promise<'done' | 'changed' | 'none'> {
  const e = readUndo();
  if (!e) return 'none';
  const res = await db.transaction('rw', db.assets, db.draws, async () => {
    if (!force && !same(await tables(), e.after)) return 'changed' as const;
    await db.assets.clear();
    await db.assets.bulkPut(e.before.assets);
    await db.draws.clear();
    await db.draws.bulkPut(e.before.draws);
    return 'done' as const;
  });
  if (res === 'done') writeUndo(null);
  return res;
}

// ---------- 인출 기록 이름 옮기기 ----------

/** 같은 계좌로 묶인 줄 이름으로 적은 인출 기록을 계좌 이름으로 옮김(트랜잭션 안에서 부름). 옮긴 건수 */
async function moveDraws(assets: Asset[], extra?: Map<string, string>): Promise<number> {
  const alias = new Map([...drawAliases(assets), ...(extra ?? [])]);
  if (!alias.size) return 0;
  const records = await db.draws.toArray();
  const plan = drawRenamePlan(records, alias);
  for (const r of plan.put) await db.draws.put(r);
  if (plan.remove.length) await db.draws.bulkDelete(plan.remove);
  return plan.put.length + plan.remove.length;
}

/** 지금 묶인 줄 이름으로 적힌 인출 기록을 모두 계좌 이름으로 옮김(연말결산·월별 기록의 안내 버튼) */
export async function renameStaleDraws(): Promise<number> {
  return db.transaction('rw', db.assets, db.draws, async () => moveDraws(await db.assets.toArray()));
}

// ---------- 나누기·합치기·묶기 ----------

/**
 * 리밸런싱 ‘자산 탭에 반영’: 연금계좌 줄 id 에서 move 만큼을 반대 성격으로 바꿔 저장(switchPlan).
 * 계산할 때와 금액·성격이 달라졌으면 저장하지 않고 false.
 */
export async function switchInDb(id: number | undefined, amount: number, fromInvest: boolean, move: number, name: string): Promise<boolean> {
  return withUndo(`‘${name}’ 자산 탭에 반영`, async () => {
    const all = await db.assets.toArray();
    const a = id !== undefined ? all.find((v) => v.id === id) : undefined;
    if (!a || a.type !== 'pension' || Math.abs(a.amount - amount) > 0.5 || (a.nature === 'invest') !== fromInvest) return false;
    const plan = switchPlan(a, move, all);
    for (const v of plan.put) await db.assets.put(v);
    for (const v of plan.add) await db.assets.add(v);
    for (const x of plan.remove) await db.assets.delete(x);
    await moveDraws(await db.assets.toArray());
    return true;
  });
}

/** 같은 계좌로 묶인 줄을 한 줄로 합쳐 저장(joinPlan). 합친 줄 이름으로 적힌 기록도 계좌 이름으로 옮김 */
export async function joinInDb(a: Asset): Promise<boolean> {
  return withUndo(`‘${groupOf(a)}’ 한 줄로 합치기`, async () => {
    const all = await db.assets.toArray();
    const plan = joinPlan(a, all);
    if (!plan) return false;
    // 합치기 전 줄 이름 → 계좌 이름(합친 뒤엔 묶음이 없어 drawAliases 로 못 찾음)
    const alias = drawAliases(all.filter((x) => groupOf(x) === groupOf(a)));
    for (const v of plan.put) await db.assets.put(v);
    for (const x of plan.remove) await db.assets.delete(x);
    await moveDraws([], alias);
    return true;
  });
}

/**
 * 연금계좌 줄의 ‘같은 계좌’ 이름을 바꿈. 이미 다른 줄이 쓰는 이름이면 그 계좌의 첫 줄 계좌 속성(명의·연금수령 1년차 등)을
 * 이 줄에 복사해 한 계좌로 맞추고, 이 줄 이름으로 적은 인출 기록을 계좌 이름으로 옮김.
 */
export async function setGroupInDb(id: number, group: string | undefined) {
  await db.transaction('rw', db.assets, db.draws, async () => {
    const all = await db.assets.toArray();
    const a = all.find((x) => x.id === id);
    if (!a) return;
    const g = group?.trim() || undefined;
    const next: Asset = { ...a, group: g };
    if (!g) delete next.group;
    const first = g ? all.find((x) => x.id !== id && groupOf(x) === g) : undefined;
    if (first) Object.assign(next, accountAttrs(first));
    await db.assets.put(next);
    await moveDraws(await db.assets.toArray());
  });
}

/** 연금계좌 줄의 계좌 속성을 바꾸면 같은 계좌로 묶인 다른 줄도 같은 값으로 */
export async function setAccountKey(id: number, key: AccountKey, v: unknown) {
  await db.transaction('rw', db.assets, async () => {
    const all = await db.assets.toArray();
    const a = all.find((x) => x.id === id);
    if (!a) return;
    for (const r of groupRows(a, all)) if (r.id !== undefined) await db.assets.update(r.id, { [key]: v });
  });
}

/** 묶인 줄의 계좌 속성을 첫 줄 값으로 모두 맞춤(계산이 쓰는 값) */
export async function alignAccount(a: Asset) {
  await db.transaction('rw', db.assets, async () => {
    const rows = groupRows(a, await db.assets.toArray());
    const attrs = accountAttrs(rows[0]);
    for (const r of rows.slice(1)) await db.assets.put({ ...r, ...attrs });
  });
}
