import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildPlanInput } from '../engine/goals';
import { summarize } from '../engine/portfolio';
import { taxSetup } from '../engine/tax';
import type { Asset, Goal } from '../types';
import { fromCSV, toCSV } from './csv';
import { db, exportBackup, importBackup } from './db';
import { appendOrders, byOrder, moveItem, moveOrder, moveRow, nextOrder } from './order';
import { sampleData } from './sample';

const names = (xs: { name: string }[]) => xs.map((x) => x.name);

describe('기본 정보 카드 순서', () => {
  const rows = [
    { id: 1, name: 'A' },
    { id: 2, name: 'B' },
    { id: 3, name: 'C' },
  ];

  it('순서가 없으면 추가한 순서(id), 있으면 그 순서. 같으면 id 순', () => {
    expect(names(byOrder(rows))).toEqual(['A', 'B', 'C']);
    expect(names(byOrder([{ ...rows[0], order: 2 }, { ...rows[1], order: 0 }, { ...rows[2], order: 1 }]))).toEqual(['B', 'C', 'A']);
    // 나눈 줄은 원래 줄의 순서를 물려받아 바로 아래
    expect(names(byOrder([{ id: 9, name: 'A2', order: 0 }, { id: 1, name: 'A', order: 0 }, { id: 2, name: 'B', order: 1 }]))).toEqual(['A', 'A2', 'B']);
  });

  it('한 칸 옮기면 모든 줄에 0부터 다시 매김, 끝에서는 못 옮김', () => {
    expect(moveOrder(rows, 3, -1)).toEqual([{ id: 1, order: 0 }, { id: 3, order: 1 }, { id: 2, order: 2 }]);
    expect(moveOrder(rows, 1, -1)).toBeNull();
    expect(moveOrder(rows, 3, 1)).toBeNull();
    expect(moveOrder(rows, 99, 1)).toBeNull();
    expect(nextOrder(rows)).toBe(4);
    expect(nextOrder([])).toBe(0);
    expect(moveItem(['x', 'y', 'z'], 2, -1)).toEqual(['x', 'z', 'y']);
    expect(moveItem(['x', 'y'], 0, -1)).toEqual(['x', 'y']);
  });

  it('CSV 추가 가져오기는 가져온 줄을 지금 카드 아래에 붙임', () => {
    const got = appendOrders(rows, [{ name: 'D', order: 1 }, { name: 'E' }] as { name: string; order?: number }[]);
    expect(got.map((r) => r.order)).toEqual([5, 5]);
    const plain: { name: string; order?: number }[] = [{ name: 'D' }, { name: 'E' }];
    expect(appendOrders([{ id: 1, order: 7 }], plain).map((r) => r.order)).toEqual([8, 9]);
  });

  it('CSV 왕복: 모든 목록에 ‘화면 순서’ 열, 비어 있으면 값 없음', () => {
    const goals: Goal[] = [
      { name: '등록금', category: 'education', targetAge: 55, amountPV: 4000, growthRate: 4, endAge: 0, order: 1 },
      { name: '차', category: 'car', targetAge: 50, amountPV: 3000, growthRate: 2, endAge: 0 },
    ];
    const csv = toCSV('goals', goals as never);
    expect(csv.split(/\r?\n/)[0]).toContain('화면 순서');
    const { rows: back, errors } = fromCSV('goals', csv);
    expect(errors).toEqual([]);
    expect(back[0]).toMatchObject({ order: 1 });
    expect(back[1]).not.toHaveProperty('order');
    for (const t of ['assets', 'liabilities', 'cashflows', 'insurance'] as const) expect(toCSV(t, []).split(/\r?\n/)[0]).toContain('화면 순서');
  });

  it('카드 순서는 계산에 쓰지 않음: 순서를 뒤집어도 노후 진단 입력·연금 인출 순서가 같음', () => {
    const d = sampleData(2026);
    const s = (assets: Asset[]) => summarize(d.profile, assets, d.liabilities, d.cashflows, 2026, d.insurance);
    const reordered = d.assets.map((a, i) => ({ ...a, order: d.assets.length - i }));
    expect(buildPlanInput(d.profile, reordered, d.liabilities, d.goals, s(reordered))).toEqual(buildPlanInput(d.profile, d.assets, d.liabilities, d.goals, s(d.assets)));
    const pen = (a: Asset[]) => taxSetup(d.profile, a, 2026, 50000, 0)?.accounts.map((x) => x.name);
    expect(pen(reordered)).toEqual(pen(d.assets));
  });
});

describe('카드 순서 저장(Dexie)', () => {
  beforeEach(async () => {
    await db.liabilities.clear();
    await db.liabilities.bulkAdd([
      { name: '주담대', balance: 20000, rate: 4, monthlyPayment: 100 },
      { name: '신용', balance: 1000, rate: 6, monthlyPayment: 30 },
      { name: '학자금', balance: 500, rate: 2, monthlyPayment: 10 },
    ]);
  });

  it('위·아래로 옮기면 order 가 저장되고 백업·복원 뒤에도 그대로', async () => {
    const ids = (await db.liabilities.toArray()).map((l) => l.id!);
    await moveRow('liabilities', ids[2], -1);
    await moveRow('liabilities', ids[2], -1);
    expect(names(byOrder(await db.liabilities.toArray()))).toEqual(['학자금', '주담대', '신용']);
    await moveRow('liabilities', ids[2], -1); // 맨 위라 그대로
    expect(names(byOrder(await db.liabilities.toArray()))).toEqual(['학자금', '주담대', '신용']);
    const backup = await exportBackup();
    await db.liabilities.clear();
    await importBackup(backup);
    expect(names(byOrder(await db.liabilities.toArray()))).toEqual(['학자금', '주담대', '신용']);
    // 계산이 쓰는 배열 순서(추가한 순서)는 그대로
    expect(names(await db.liabilities.toArray())).toEqual(['주담대', '신용', '학자금']);
  });
});
