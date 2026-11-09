import Dexie, { type EntityTable } from 'dexie';
import type { Asset, Cashflow, Goal, Insurance, Liability, Profile, Snapshot, YearEnd } from '../types';
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
  await db.transaction('rw', [db.profile, db.assets, db.liabilities, db.cashflows, db.goals, db.insurance, db.snapshots, db.yearEnds], async () => {
    await Promise.all([db.assets.clear(), db.liabilities.clear(), db.cashflows.clear(), db.goals.clear(), db.insurance.clear(), db.snapshots.clear(), db.yearEnds.clear()]);
    await db.profile.put(d.profile);
    await db.assets.bulkAdd(d.assets);
    await db.liabilities.bulkAdd(d.liabilities);
    await db.cashflows.bulkAdd(d.cashflows);
    await db.goals.bulkAdd(d.goals);
    await db.insurance.bulkAdd(d.insurance);
  });
}

export async function resetAll() {
  await Promise.all([db.profile.clear(), ...LIST_TABLES.map((t) => db[t].clear()), db.snapshots.clear(), db.yearEnds.clear()]);
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
  };
}

export async function importBackup(b: Backup) {
  if (b?.app !== 'flp') throw new Error('FLP 백업 파일이 아닙니다.');
  await db.transaction('rw', [db.profile, db.assets, db.liabilities, db.cashflows, db.goals, db.insurance, db.snapshots, db.yearEnds], async () => {
    await resetAll();
    if (b.profile) await db.profile.put(b.profile);
    await db.assets.bulkAdd(b.assets ?? []);
    await db.liabilities.bulkAdd(b.liabilities ?? []);
    await db.cashflows.bulkAdd(b.cashflows ?? []);
    await db.goals.bulkAdd(b.goals ?? []);
    await db.insurance.bulkAdd(b.insurance ?? []);
    await db.snapshots.bulkAdd(b.snapshots ?? []);
    await db.yearEnds.bulkAdd(b.yearEnds ?? []);
  });
}
