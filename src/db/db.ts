import Dexie, { type EntityTable } from 'dexie';
import type { Asset, Cashflow, Draw, Goal, Insurance, Liability, Profile, Snapshot, YearEnd } from '../types';
import { defaultProfile, sampleData, DEFAULT_CRITERIA } from './sample';

export class FlpDB extends Dexie {
  profile!: EntityTable<Profile, 'id'>;
  assets!: EntityTable<Asset, 'id'>;
  liabilities!: EntityTable<Liability, 'id'>;
  cashflows!: EntityTable<Cashflow, 'id'>;
  goals!: EntityTable<Goal, 'id'>;
  insurance!: EntityTable<Insurance, 'id'>;
  snapshots!: EntityTable<Snapshot, 'id'>;
  yearEnds!: EntityTable<YearEnd, 'id'>;
  draws!: EntityTable<Draw, 'id'>;

  constructor() {
    super('flp');
    this.version(1).stores({
      profile: 'id',
      assets: '++id, type, purpose',
      liabilities: '++id',
      cashflows: '++id, kind',
      goals: '++id, targetAge',
      insurance: '++id',
      snapshots: '++id, &date',
    });
    // v2: 연말결산(해마다 12월 말 실제 자산·인출액)
    this.version(2).stores({ yearEnds: '++id, &year' });
    // v3: 월별 실제 인출 기록(달·계좌마다 1건)
    this.version(3).stores({ draws: '++id, month' });
  }
}

export const db = new FlpDB();

export const LIST_TABLES = ['assets', 'liabilities', 'cashflows', 'goals', 'insurance'] as const;
export type ListTable = (typeof LIST_TABLES)[number];

export async function getProfile(): Promise<Profile> {
  const p = await db.profile.get('me');
  if (!p) return defaultProfile();
  return { ...defaultProfile(), ...p, criteria: { ...DEFAULT_CRITERIA, ...p.criteria } };
}

export async function loadSample() {
  const d = sampleData();
  await db.transaction('rw', [db.profile, db.assets, db.liabilities, db.cashflows, db.goals, db.insurance, db.snapshots, db.yearEnds, db.draws], async () => {
    await Promise.all([db.assets.clear(), db.liabilities.clear(), db.cashflows.clear(), db.goals.clear(), db.insurance.clear(), db.snapshots.clear(), db.yearEnds.clear(), db.draws.clear()]);
    await db.profile.put(d.profile);
    await db.assets.bulkAdd(d.assets);
    await db.liabilities.bulkAdd(d.liabilities);
    await db.cashflows.bulkAdd(d.cashflows);
    await db.goals.bulkAdd(d.goals);
    await db.insurance.bulkAdd(d.insurance);
  });
}

export async function resetAll() {
  await Promise.all([db.profile.clear(), ...LIST_TABLES.map((t) => db[t].clear()), db.snapshots.clear(), db.yearEnds.clear(), db.draws.clear()]);
}

/** 오늘 날짜 스냅샷 기록(같은 날은 덮어씀) */
export async function recordSnapshot(s: Omit<Snapshot, 'id' | 'date'>) {
  const date = new Date().toLocaleDateString('sv-SE');
  const existing = await db.snapshots.where('date').equals(date).first();
  if (existing) {
    if (existing.netWorth === s.netWorth && existing.totalAssets === s.totalAssets && existing.totalDebt === s.totalDebt) return;
    await db.snapshots.update(existing.id!, s);
  } else {
    await db.snapshots.add({ ...s, date });
  }
}

export interface Backup {
  app: 'flp';
  version: 1;
  exportedAt: string;
  profile: Profile | undefined;
  assets: Asset[];
  liabilities: Liability[];
  cashflows: Cashflow[];
  goals: Goal[];
  insurance: Insurance[];
  snapshots: Snapshot[];
  yearEnds?: YearEnd[];
  draws?: Draw[];
}

export async function exportBackup(): Promise<Backup> {
  return {
    app: 'flp',
    version: 1,
    exportedAt: new Date().toISOString(),
    profile: await db.profile.get('me'),
    assets: await db.assets.toArray(),
    liabilities: await db.liabilities.toArray(),
    cashflows: await db.cashflows.toArray(),
    goals: await db.goals.toArray(),
    insurance: await db.insurance.toArray(),
    snapshots: await db.snapshots.toArray(),
    yearEnds: await db.yearEnds.toArray(),
    draws: await db.draws.toArray(),
  };
}

export async function importBackup(b: Backup) {
  if (b?.app !== 'flp') throw new Error('FLP 백업 파일이 아닙니다.');
  await db.transaction('rw', [db.profile, db.assets, db.liabilities, db.cashflows, db.goals, db.insurance, db.snapshots, db.yearEnds, db.draws], async () => {
    await resetAll();
    if (b.profile) await db.profile.put(b.profile);
    await db.assets.bulkAdd(b.assets ?? []);
    await db.liabilities.bulkAdd(b.liabilities ?? []);
    await db.cashflows.bulkAdd(b.cashflows ?? []);
    await db.goals.bulkAdd(b.goals ?? []);
    await db.insurance.bulkAdd(b.insurance ?? []);
    await db.snapshots.bulkAdd(b.snapshots ?? []);
    await db.yearEnds.bulkAdd(b.yearEnds ?? []);
    await db.draws.bulkAdd(b.draws ?? []);
  });
}

/** 월별 실제 인출 기록 저장: 같은 달·계좌는 1건만 두고, 금액이 0 이하면 지움 */
export async function saveDraw(month: string, account: string, amount: number, note?: string) {
  await db.transaction('rw', db.draws, async () => {
    const same = (await db.draws.where('month').equals(month).toArray()).filter((r) => r.account === account);
    if (!(amount > 0)) {
      await db.draws.bulkDelete(same.map((r) => r.id!));
      return;
    }
    const keep = same[0];
    await db.draws.bulkDelete(same.slice(1).map((r) => r.id!));
    const memo = note === undefined ? keep?.note : note.trim() || undefined;
    if (keep) await db.draws.put({ id: keep.id, month, account, amount, ...(memo ? { note: memo } : {}) });
    else await db.draws.add({ month, account, amount, ...(memo ? { note: memo } : {}) });
  });
}

/** CSV 로 읽은 인출 기록을 넣음: 같은 달·계좌는 덮어씀 */
export async function importDraws(rows: Draw[]) {
  for (const r of rows) await saveDraw(r.month, r.account, r.amount, r.note ?? '');
}
