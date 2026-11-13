import 'fake-indexeddb/auto';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { joinConfirmText, JoinAccount, joinSummary } from '../components/JoinAccount';
import { carryOverPlan, drawAliases, drawRenamePlan, staleDraws } from '../engine/drawLog';
import { accountMismatch, groupNames, groupNotes } from '../engine/portfolio';
import type { Asset, Draw } from '../types';
import { alignAccount, clearUndo, joinInDb, renameStaleDraws, setAccountKey, setGroupInDb, switchInDb, undoEntry, undoLast } from './accountOps';
import { db } from './db';

const base = { type: 'pension' as const, purpose: 'long' as const, expectedReturn: 3, volatility: 1 };
const irp: Asset = { ...base, id: 1, name: '퇴직 IRP', nature: 'safe', amount: 10000, taxFree: 1000, retirePart: 4000, pensionYear1: 2024, drawOrder: 2 };
const saving: Asset = { ...base, id: 2, name: '연금저축', nature: 'invest', amount: 5000, expectedReturn: 6, volatility: 15 };

async function reset(assets: Asset[], draws: Draw[] = []) {
  await db.assets.clear();
  await db.draws.clear();
  await db.assets.bulkAdd(assets);
  if (draws.length) await db.draws.bulkAdd(draws);
  clearUndo();
}
const pensions = async () => (await db.assets.toArray()).filter((a) => a.type === 'pension');

describe('계좌 속성·같은 계좌 이름 점검', () => {
  const a: Asset = { ...irp, group: '퇴직 IRP' };
  const b: Asset = { ...irp, id: 3, name: '퇴직 IRP (투자형)', nature: 'invest', amount: 2000, group: '퇴직 IRP' };

  it('accountMismatch: 묶인 줄끼리 명의·연금수령 1년차 등이 다르면 그 항목', () => {
    expect(accountMismatch(a, [a, b])).toEqual([]);
    const b2 = { ...b, owner: 'spouse' as const, pensionYear1: 2025 };
    expect(accountMismatch(a, [a, b2])).toEqual(['owner', 'pensionYear1']);
    expect(accountMismatch(b2, [a, b2])).toEqual(['owner', 'pensionYear1']);
    // 비어 있음(undefined)과 0·본인은 같은 값
    expect(accountMismatch({ ...a, drawStartYear: 0 }, [{ ...a, drawStartYear: 0 }, b])).toEqual([]);
    expect(accountMismatch(saving, [saving, a, b])).toEqual([]);
  });

  it('groupNotes: 혼자 남은 이름, 띄어쓰기·대소문자만 다른 이름', () => {
    expect(groupNotes(a, [a, b])).toEqual({ lone: false });
    expect(groupNotes(a, [a, saving])).toEqual({ lone: true });
    const c: Asset = { ...saving, group: '퇴직irp' };
    expect(groupNotes(c, [a, b, c])).toEqual({ lone: true, near: '퇴직 IRP' });
    expect(groupNotes(saving, [saving])).toEqual({ lone: false });
    expect(groupNames([a, b, c, saving])).toEqual(['퇴직 IRP', '퇴직irp']);
  });
});

describe('인출 기록 이름 옮기기', () => {
  const a: Asset = { ...irp, group: '퇴직 IRP' };
  const b: Asset = { ...irp, id: 3, name: 'IRP 투자', nature: 'invest', amount: 2000, group: '퇴직 IRP' };
  const records: Draw[] = [
    { id: 1, month: '2026-01', account: '퇴직 IRP', amount: 100, note: '정기' },
    { id: 2, month: '2026-01', account: 'IRP 투자', amount: 50, note: '추가' },
    { id: 3, month: '2026-02', account: 'IRP 투자', amount: 70 },
    { id: 4, month: '2026-02', account: '연금저축', amount: 30 },
  ];

  it('drawAliases·staleDraws: 계좌 이름과 다른 줄 이름 → 계좌 이름', () => {
    expect([...drawAliases([a, b, saving])]).toEqual([['IRP 투자', '퇴직 IRP']]);
    expect(staleDraws([a, b, saving], records).map((r) => r.id)).toEqual([2, 3]);
    // 같은 이름을 묶이지 않은 자산이 쓰면 옮기지 않음
    expect(drawAliases([a, b, { ...saving, name: 'IRP 투자' }]).size).toBe(0);
  });

  it('drawRenamePlan: 같은 달 계좌 이름 기록이 있으면 더해 한 건으로, 없으면 이름만 바꿈', () => {
    const plan = drawRenamePlan(records, drawAliases([a, b]));
    expect(plan.remove).toEqual([2]);
    expect(plan.put).toEqual([
      { id: 1, month: '2026-01', account: '퇴직 IRP', amount: 150, note: '정기 / 추가' },
      { id: 3, month: '2026-02', account: '퇴직 IRP', amount: 70 },
    ]);
  });

  it('연말결산 이어받기는 옮기기 전 기록도 그 계좌 인출로 셈', () => {
    const rows = carryOverPlan([a, b], [{ id: 1, name: '퇴직 IRP', balance: 8000 }, { id: 3, name: 'IRP 투자', balance: 2000 }], records, 2026);
    expect(rows.map((r) => r.drawn)).toEqual([220, 220]);
  });
});

describe('자산 탭 저장 동작(나누기·합치기·묶기·되돌리기)', () => {
  beforeEach(() => reset([irp, saving]));

  it('나누기(자산 탭에 반영) 뒤 되돌리면 나누기 전과 같음', async () => {
    expect(await switchInDb(1, 10000, false, 4000, '퇴직 IRP')).toBe(true);
    expect((await pensions()).map((a) => [a.name, a.amount, a.group])).toEqual([
      ['퇴직 IRP', 6000, '퇴직 IRP'],
      ['연금저축', 5000, undefined],
      ['퇴직 IRP (투자형)', 4000, '퇴직 IRP'],
    ]);
    expect(undoEntry()?.label).toBe('‘퇴직 IRP’ 자산 탭에 반영');
    expect(await undoLast()).toBe('done');
    expect(await db.assets.toArray()).toEqual([irp, saving]);
    expect(undoEntry()).toBeNull();
    expect(await undoLast()).toBe('none');
  });

  it('계산할 때와 금액·성격이 다르면 저장하지 않음', async () => {
    expect(await switchInDb(1, 9000, false, 4000, '퇴직 IRP')).toBe(false);
    expect(await switchInDb(1, 10000, true, 4000, '퇴직 IRP')).toBe(false);
    expect(await db.assets.toArray()).toEqual([irp, saving]);
    expect(undoEntry()).toBeNull();
  });

  it('합치기: 처음 줄로 합치고 줄 이름 기록은 계좌 이름으로, 되돌리면 두 줄·기록 모두 복구', async () => {
    await switchInDb(1, 10000, false, 4000, '퇴직 IRP');
    const added = (await pensions()).find((a) => a.name === '퇴직 IRP (투자형)')!;
    await db.draws.bulkAdd([
      { month: '2026-03', account: '퇴직 IRP (투자형)', amount: 40 },
      { month: '2026-03', account: '퇴직 IRP', amount: 60 },
    ]);
    const split = { assets: await db.assets.toArray(), draws: await db.draws.toArray() };
    expect(await joinInDb(added)).toBe(true);
    const [m] = await pensions();
    expect(m).toMatchObject({ id: 1, name: '퇴직 IRP', amount: 10000, taxFree: 1000, retirePart: 4000, nature: 'safe', drawOrder: 2 });
    expect('group' in m).toBe(false);
    expect(await pensions()).toHaveLength(2);
    expect((await db.draws.toArray()).map((r) => [r.account, r.amount])).toEqual([['퇴직 IRP', 100]]);
    expect(await undoLast()).toBe('done');
    expect(await db.assets.toArray()).toEqual(split.assets);
    expect(await db.draws.toArray()).toEqual(split.draws);
  });

  it('되돌리기 전에 다른 내용을 고쳤으면 확인을 받도록 changed, force 면 되돌림', async () => {
    await switchInDb(1, 10000, false, 4000, '퇴직 IRP');
    await db.assets.update(2, { amount: 5500 });
    expect(await undoLast()).toBe('changed');
    expect(undoEntry()).not.toBeNull();
    expect(await undoLast(true)).toBe('done');
    expect(await db.assets.toArray()).toEqual([irp, saving]);
  });

  it('같은 계좌 이름을 이미 쓰는 이름으로 바꾸면 그 계좌의 속성을 복사하고 이 줄 이름 기록을 옮김', async () => {
    await reset([{ ...irp, group: '퇴직 IRP' }, { ...saving, owner: 'spouse', drawStartYear: 2030 }], [{ month: '2026-01', account: '연금저축', amount: 10 }]);
    await setGroupInDb(2, '퇴직 IRP');
    const s = (await db.assets.get(2))!;
    expect(s).toMatchObject({ group: '퇴직 IRP', pensionYear1: 2024, drawOrder: 2 });
    expect(s.owner).toBeUndefined();
    expect(s.drawStartYear).toBeUndefined();
    expect((await db.draws.toArray()).map((r) => r.account)).toEqual(['퇴직 IRP']);
    // 비우면 묶음만 지움
    await setGroupInDb(2, '  ');
    expect('group' in (await db.assets.get(2))!).toBe(false);
  });

  it('묶인 줄의 계좌 속성을 고치면 다른 줄도 함께, 맞추기는 첫 줄 값으로', async () => {
    await reset([{ ...irp, group: 'G' }, { ...saving, group: 'G', pensionYear1: 2030 }, { ...saving, id: 9, name: '따로' }]);
    expect(accountMismatch((await db.assets.get(1))!, await db.assets.toArray())).toEqual(['pensionYear1', 'drawOrder']);
    await alignAccount((await db.assets.get(2))!);
    expect((await db.assets.get(2))!).toMatchObject({ pensionYear1: 2024, drawOrder: 2 });
    await setAccountKey(2, 'drawStartYear', 2031);
    expect((await db.assets.toArray()).map((a) => a.drawStartYear)).toEqual([2031, 2031, undefined]);
  });

  it('renameStaleDraws: 묶인 줄 이름으로 적힌 기록을 모두 옮김', async () => {
    await reset([{ ...irp, group: '퇴직 IRP' }, { ...saving, group: '퇴직 IRP' }], [{ month: '2026-01', account: '연금저축', amount: 10 }, { month: '2026-02', account: '연금저축', amount: 5 }]);
    expect(await renameStaleDraws()).toBe(2);
    expect((await db.draws.toArray()).map((r) => r.account)).toEqual(['퇴직 IRP', '퇴직 IRP']);
    expect(await renameStaleDraws()).toBe(0);
  });
});

describe('합치기 미리보기·확인창 문구', () => {
  const a: Asset = { ...irp, group: '퇴직 IRP', amount: 3000, expectedReturn: 3, volatility: 1 };
  const b: Asset = { ...irp, id: 3, name: '퇴직 IRP (투자형)', nature: 'invest', amount: 7000, expectedReturn: 7, volatility: 15, group: '퇴직 IRP', taxFree: 0, retirePart: 0 };

  it('미리보기에 합친 금액·성격·수익률·변동성·재원, 묶인 줄이 하나면 안 보임', () => {
    const html = renderToStaticMarkup(<JoinAccount a={a} assets={[a, b, saving]} />);
    expect(html).toContain('한 줄로 합치기');
    expect(html).toContain('2줄 →');
    expect(html).toContain(joinSummary({ ...a, amount: 10000, nature: 'invest', expectedReturn: 5.8, volatility: 10.8 }));
    expect(html).toContain('기대수익률 5.8%');
    expect(html).toContain('투자형');
    expect(renderToStaticMarkup(<JoinAccount a={a} assets={[a, saving]} />)).toBe('');
  });

  it('확인창: 줄 수·합친 결과·수익률이 처음 값과 다를 수 있다는 안내·되돌리기', () => {
    const t = joinConfirmText(a, [a, b])!;
    expect(t).toContain('‘퇴직 IRP’ 계좌로 묶인 2줄을 한 줄로 합칠까요?');
    expect(t).toContain('기대수익률 5.8% · 변동성 10.8');
    expect(t).toContain('나누기 전 값과 다를 수 있습니다');
    expect(t).toContain('되돌리기');
    expect(joinConfirmText(saving, [saving])).toBeNull();
  });
});
