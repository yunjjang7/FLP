import { describe, expect, it } from 'vitest';
import { fromCSV, toCSV } from '../db/csv';
import { sampleData } from '../db/sample';
import type { Asset, Cashflow } from '../types';
import { canMaturity, emergencyLockedOf, goalTimingGaps, maturities, maturityLabel, monthsToMaturity } from './maturity';
import { CASH_MOVE_TODO, cashFrom55Note, maturityTodo, milestones, yearTodos } from './milestones';
import { summarize } from './portfolio';
import { rebalance } from './rebalance';
import { cashMoveRows, cashOnHand, cashRunway, cashSourceLabel, cashYears, pensionCash, pensionCashParts, pensionFrom55, pensionFrom55Note, pensionOutNote, startAges, withPensionCash } from './buckets';
import { buildPlanInput } from './goals';
import { insuranceGap } from './insurance';
import { withdrawStart } from './montecarlo';
import { cashBucketPrescription, maturityPrescriptions, pensionOutPrescription, prescriptions } from './prescribe';
import { cashRunwayChecks, emergencyDetail } from './risk';

const Y = 2026;
const M = 11;
const asset = (name: string, type: Asset['type'], purpose: Asset['purpose'], amount: number, over: Partial<Asset> = {}): Asset => ({
  name, type, amount, purpose, nature: 'safe', expectedReturn: 3, volatility: 0.5, ...over,
});
const spend = (monthly: number) => [{ name: '생활비', kind: 'fixed', monthly } as Cashflow];
const plan = (name: string, years: number, allocated: number) => ({ goal: { name }, years, allocated });

describe('예금·적금 만기 연월', () => {
  it('예금·적금만, 남은 개월(월을 비우면 12월)', () => {
    expect(canMaturity({ type: 'deposit' })).toBe(true);
    expect(canMaturity({ type: 'savings' })).toBe(true);
    expect(canMaturity({ type: 'cash' })).toBe(false);
    expect(canMaturity({ type: 'bond' })).toBe(false);
    expect(monthsToMaturity({ maturityYear: 2027, maturityMonth: 3 }, Y, M)).toBe(4);
    expect(monthsToMaturity({ maturityYear: 2027 }, Y, M)).toBe(13);
    expect(monthsToMaturity({ maturityYear: 2026, maturityMonth: 11 }, Y, M)).toBe(0);
    expect(monthsToMaturity({ maturityYear: 2026, maturityMonth: 5 }, Y, M)).toBe(-6);
    expect(maturityLabel({ maturityYear: 2027, maturityMonth: 3 })).toBe('2027년 3월');
    expect(maturityLabel({ maturityYear: 2027, maturityMonth: 13 })).toBe('2027년');
  });

  it('만기 목록은 빠른 순, 다른 유형·만기 없음·0원은 뺌', () => {
    const rows = maturities([
      asset('적금', 'savings', 'mid', 1200, { maturityYear: 2028, maturityMonth: 6 }),
      asset('예금', 'deposit', 'short', 1000, { maturityYear: 2027, maturityMonth: 1 }),
      asset('채권', 'bond', 'mid', 500, { maturityYear: 2027 }),
      asset('만기 없음', 'deposit', 'short', 300),
      asset('빈 예금', 'deposit', 'short', 0, { maturityYear: 2027 }),
    ], Y, M);
    expect(rows.map((r) => [r.name, r.monthsLeft])).toEqual([['예금', 2], ['적금', 19]]);
  });

  it('비상금 중 만기가 3개월 넘게 남은 돈: 요약·위험 점검 설명', () => {
    const list = [
      asset('파킹통장', 'cash', 'short', 300),
      asset('정기예금', 'deposit', 'short', 1200, { maturityYear: 2027, maturityMonth: 9 }), // 10개월
      asset('곧 만기', 'deposit', 'short', 300, { maturityYear: 2027, maturityMonth: 1 }), // 2개월
    ];
    expect(emergencyLockedOf(maturities(list, Y, M))).toBe(1200);
    const s = summarize(sampleData().profile, list, [], spend(300), Y, [], M);
    expect(s.emergencyFund).toBe(1800);
    expect(s.emergencyLocked).toBe(1200);
    expect(emergencyDetail(s, 6)).toContain('이 가운데 1,200만원은 만기가 3개월 넘게 남은 예금·적금');
    expect(emergencyDetail(s, 6)).toContain('바로 쓸 수 있는 돈은 2.0개월분');
    const none = summarize(sampleData().profile, list.slice(0, 1), [], spend(300), Y, [], M);
    expect(none.emergencyLocked).toBeUndefined();
    expect(emergencyDetail(none, 6)).not.toContain('만기');
  });

  it('목적자금 시점: 목표 해보다 늦게 만기가 오는 중기 예금·적금 몫만큼 부족', () => {
    const rows = maturities([
      asset('적금 A', 'savings', 'mid', 1000, { maturityYear: 2029, maturityMonth: 3 }),
      asset('예금 B', 'deposit', 'mid', 500, { maturityYear: 2027 }),
    ], Y, M);
    // 중기 합계 2,000(적금 1,000 + 예금 500 + 만기 없는 500)
    const gaps = goalTimingGaps([plan('차', 1, 800), plan('여행', 2, 600), plan('결혼', 4, 400)], 2000, rows, Y);
    // 2027(차): 늦게 오는 돈 1,000 → 쓸 수 있는 1,000 ≥ 800 → 괜찮음
    // 2028(여행): 누계 1,400 > 1,000 → 부족 400
    // 2030(결혼): 적금 A 도 만기(2029) → 괜찮음
    expect(gaps).toEqual([{ name: '여행', goalYear: 2028, short: 400, late: [rows[1]] }]);
    expect(rows[1].name).toBe('적금 A');
    // 만기가 목표 해와 같으면 제때 돌아온다고 봄, 중기 만기가 없으면 점검 안 함
    expect(goalTimingGaps([plan('차', 1, 2000)], 2000, rows.filter((r) => r.name === '예금 B'), Y)).toEqual([]);
    expect(goalTimingGaps([plan('차', 1, 2000)], 2000, [], Y)).toEqual([]);
  });

  it('처방: 지난 만기, 비상금이 만기에 묶임, 목표보다 늦은 만기', () => {
    const list = [
      asset('파킹통장', 'cash', 'short', 300),
      asset('정기예금', 'deposit', 'short', 1200, { maturityYear: 2027, maturityMonth: 9 }),
      asset('지난 적금', 'savings', 'mid', 200, { maturityYear: 2026, maturityMonth: 5 }),
      asset('적금 A', 'savings', 'mid', 1000, { maturityYear: 2029, maturityMonth: 3 }),
    ];
    const s = summarize(sampleData().profile, list, [], spend(300), Y, [], M);
    expect(s.midFund).toBe(1200);
    const rx = maturityPrescriptions(s, [plan('여행', 2, 600) as never], Y, 6);
    expect(rx.map((x) => x.title)).toEqual([
      '지난 적금 만기(2026년 5월)가 지났음',
      '비상금 중 1,200만원은 만기 전 — 바로 쓸 수 있는 돈은 1.0개월분',
      '여행(2028년) 목적자금 400만원 — 예금·적금 만기가 목표보다 늦음',
    ]);
    expect(rx[1].detail).toContain('정기예금(2027년 9월 만기)');
    expect(rx[2].detail).toContain('적금 A(2029년 3월 만기, 1,000만원)');
    // 바로 쓸 돈만으로 목표를 채우면 비상금 처방은 없음
    const rich = summarize(sampleData().profile, [asset('파킹통장', 'cash', 'short', 5000), list[1]], [], spend(300), Y, [], M);
    expect(maturityPrescriptions(rich, [], Y, 6)).toEqual([]);
  });

  it('CSV: 만기 연도·월은 예금·적금 행만, 월은 1~12', () => {
    const rows = [
      asset('예금', 'deposit', 'short', 1000, { maturityYear: 2027, maturityMonth: 3 }),
      asset('적금', 'savings', 'mid', 500, { maturityYear: 2028 }),
    ];
    const back = fromCSV('assets', toCSV('assets', rows as never));
    expect(back.errors).toEqual([]);
    expect(back.rows[0]).toMatchObject({ maturityYear: 2027, maturityMonth: 3 });
    expect(back.rows[1]).toMatchObject({ maturityYear: 2028 });
    expect(back.rows[1].maturityMonth).toBeUndefined();
    const csv = ['이름,유형,금액,만기 연도,만기 월', '채권,채권,100,2027,3', '예금,예금,100,2027,13'].join('\n');
    const r = fromCSV('assets', csv);
    expect(r.rows[0].maturityYear).toBeUndefined();
    expect(r.rows[1].maturityYear).toBe(2027);
    expect(r.rows[1].maturityMonth).toBeUndefined();
    expect(r.errors).toEqual(["3행: '만기 월'은(는) 1~12만 넣을 수 있어 비워 두었습니다."]);
  });
});

describe('만기 이정표·챙길 일', () => {
  const p = sampleData().profile;
  const list = [
    asset('비상 예금', 'deposit', 'short', 1000, { maturityYear: 2027, maturityMonth: 3 }),
    asset('여행 적금', 'savings', 'mid', 500, { maturityYear: 2028 }),
    asset('지난 예금', 'deposit', 'short', 300, { maturityYear: 2026, maturityMonth: 5 }),
    asset('중개형 ISA', 'etf', 'long', 3000, { nature: 'invest', expectedReturn: 10, acctKind: 'isa', isaEndYear: 2028, isaPaid: 3000 }),
  ];

  it('다가오는 이정표: 예금·적금 만기 연월과 ISA 만기 연도(지난 만기는 뺌)', () => {
    const ms = milestones(p, list, [], [], Y, M).filter((m) => m.kind === 'maturity');
    expect(ms.map((m) => [m.year, m.month, m.label])).toEqual([
      [2027, 3, '비상 예금 만기(예금)'],
      [2028, 0, '여행 적금 만기(적금)'],
      [2028, 0, '중개형 ISA 만기 → 60일 안에 연금저축·IRP로 옮기면 세액공제 대상 +300만원'],
    ]);
    expect(ms[0].note).toBe('1,000만원 · 비상금은 바로 꺼낼 수 있는 통장이나 짧은 만기로');
    // 3,000 × 1.1² = 3,630 → 수익 630 중 한도 200 넘는 430에 9.9%
    expect(ms[2].note).toBe('지금 평가액 3,000만원 · 만기 수익 약 630만원 중 비과세 한도 200만원을 넘는 430만원에 9.9% 약 43만원');
  });

  it('올해·내년 챙길 일: 그 해 만기(올해는 이번 달 이후)', () => {
    const todo = (y: number) => yearTodos(p, list, Y, y, [], M).filter((x) => x.includes('만기'));
    expect(todo(2026)).toEqual([]);
    expect(todo(2027)).toEqual(['3월 비상 예금 만기(예금) 1,000만원 → 비상금은 바로 꺼낼 수 있는 통장이나 짧은 만기로']);
    expect(todo(2028)).toEqual([
      '여행 적금 만기(적금) 500만원 → 목표 시점에 맞춰 다시 맡길 기간을 정함',
      '중개형 ISA 만기 → 60일 안에 연금저축·IRP로 옮기면 세액공제 대상 +300만원',
    ]);
  });
});

describe('리밸런싱: 만기 전 예금·적금', () => {
  const list = [
    asset('정기예금', 'deposit', 'short', 5000, { maturityYear: 2027, maturityMonth: 9 }),
    asset('파킹통장', 'cash', 'short', 1000),
    asset('ETF', 'etf', 'long', 4000, { nature: 'invest', expectedReturn: 6, volatility: 15 }),
  ];

  it('세금 없는 계좌부터: 만기 전 예금은 맨 마지막에 깨고 따로 알려 줌', () => {
    // 투자형 40% → 목표 60%: 안전형 2,000을 팔아야 함
    const r = rebalance(list, 60, Y, 5, 'pensionFirst', undefined, M);
    expect(r.general.sell.map((m) => [m.name, Math.round(m.change)])).toEqual([['정기예금', -1000], ['파킹통장', -1000]]);
    expect(r.early).toEqual([{ name: '정기예금', amount: 5000, change: -1000, after: 4000, maturity: '2027년 9월' }]);
    expect(r.taxable).toBeCloseTo(2000);
  });

  it('비례 방식은 그대로 나누되 만기 전 몫을 알려 줌, 만기가 없거나 지났으면 없음', () => {
    const r = rebalance(list, 60, Y, 5, 'ratio', undefined, M);
    expect(r.early[0].change).toBeCloseTo(-5000 / 3);
    const plain = list.map((a) => (a.type === 'deposit' ? { ...a, maturityYear: undefined, maturityMonth: undefined } : a));
    expect(rebalance(plain, 60, Y, 5, 'pensionFirst', undefined, M).early).toEqual([]);
    const past = list.map((a) => (a.type === 'deposit' ? { ...a, maturityYear: 2026, maturityMonth: 5 } : a));
    const rp = rebalance(past, 60, Y, 5, 'pensionFirst', undefined, M);
    expect(rp.early).toEqual([]);
    expect(rp.general.sell.map((m) => Math.round(m.change))).toEqual([-1667, -333]);
  });
});

describe('인출 바구니: 만기 전 예금·적금은 바로 쓸 돈과 따로', () => {
  it('연금계좌 밖 현금·예금·적금을 바로 쓸 돈과 만기가 3개월 넘게 남은 돈으로 나눔', () => {
    const list = [
      asset('파킹통장', 'cash', 'short', 1000),
      asset('정기예금', 'deposit', 'short', 2000, { maturityYear: 2027, maturityMonth: 9 }), // 10개월 → 묶임
      asset('곧 만기 적금', 'savings', 'mid', 500, { maturityYear: 2027, maturityMonth: 1 }), // 2개월 → 바로 씀
      asset('만기 없는 예금', 'deposit', 'short', 500),
      asset('채권', 'bond', 'mid', 3000),
      asset('IRP', 'pension', 'long', 5000),
    ];
    const c = cashOnHand(list, Y, M);
    expect(c).toMatchObject({ total: 4000, usable: 2000, locked: 2000 });
    expect(c.lockedRows.map((r) => r.name)).toEqual(['정기예금']);
    // 첫해 인출 1,000 기준: 바로 쓸 돈만 2년, 만기 전 예금까지 깨면 4년
    expect(cashYears(c, 1000)).toEqual({ usable: 2, all: 4 });
    expect(cashYears(c, 0)).toBeUndefined();
    // 만기가 없으면 모두 바로 쓸 돈
    expect(cashOnHand(list.filter((a) => a.name !== '정기예금'), Y, M)).toMatchObject({ total: 2000, usable: 2000, locked: 0 });
  });

  const locked = (amt: number, free = 0) => cashOnHand([
    asset('파킹통장', 'cash', 'short', free),
    asset('정기예금', 'deposit', 'short', amt, { maturityYear: 2027, maturityMonth: 9 }),
  ], Y, M);

  it('버틸 햇수는 은퇴했거나 은퇴가 5년 안일 때만, 첫해 인출 기준', () => {
    const c = locked(2000, 1000);
    expect(cashRunway(c, { age: 60, retired: true, outflow: 1000 }, 60)).toEqual({ usable: 1, all: 3, yearDraw: 1000, retired: true });
    expect(cashRunway(c, { age: 60, retired: false, outflow: 1000 }, 55)).toMatchObject({ usable: 1 });
    expect(cashRunway(c, { age: 60, retired: false, outflow: 1000 }, 54)).toBeUndefined();
    expect(cashRunway(c, { age: 60, retired: true, outflow: 0 }, 60)).toBeUndefined();
    expect(cashRunway(cashOnHand([], Y, M), { age: 60, retired: true, outflow: 1000 }, 60)).toBeUndefined();
  });

  it('홈 점검: 바로 쓸 돈이 2년치에 못 미치면 주의, 만기 전 예금은 따로 적음', () => {
    const c = locked(2000, 1000);
    const [chk] = cashRunwayChecks(c, cashRunway(c, { age: 60, retired: true, outflow: 1000 }, 60));
    expect(chk).toMatchObject({ key: 'cashRunway', label: '하락장 버틸 햇수(바로 쓸 돈)', value: '1.0년치', level: 'caution' });
    expect(chk.detail).toContain('바로 쓸 수 있는 돈 1,000만원을 올해 인출(연 1,000만원)로 나눈 값');
    expect(chk.detail).toContain('예금·적금 2,000만원은 넣지 않았습니다(깨면 중도해지 이율, 넣으면 약 3.0년치)');
    const ok = locked(0, 2500);
    expect(cashRunwayChecks(ok, cashRunway(ok, { age: 60, retired: false, outflow: 1000 }, 57))[0]).toMatchObject({ value: '2.5년치', level: 'good' });
    expect(cashRunwayChecks(ok, undefined)).toEqual([]);
  });

  it('처방: 2년치에 못 미치고 만기 전 예금·적금이 있으면 만기 뒤 현금성 바구니로', () => {
    const run = (c: ReturnType<typeof cashOnHand>) => cashRunway(c, { age: 60, retired: true, outflow: 1000 }, 60);
    const a = locked(2000, 500);
    const rx = cashBucketPrescription(a, run(a))!;
    expect(rx).toMatchObject({ area: '노후', level: 'caution', title: '만기 전 예금·적금 2,000만원 — 만기 뒤 현금성 바구니로' });
    expect(rx.detail).toContain('바로 쓸 수 있는 돈 500만원은 올해 인출(연 1,000만원) 기준 약 0.5년치로 2년치(2,000만원)에 못 미칩니다');
    expect(rx.detail).toContain('정기예금(2027년 9월 만기, 2,000만원)');
    expect(rx.detail).toContain('모두 옮기면 약 2.5년치가 됩니다');
    // 다 옮겨도 모자라면 남는 금액
    const b = locked(800, 200);
    expect(cashBucketPrescription(b, run(b))!.detail).toContain('모두 옮겨도 약 1.0년치라, 나머지 1,000만원은 고점 부근에 주식형 일부를 팔아 채우세요');
    // 이미 2년치이거나 만기 전 예금이 없으면 처방 없음
    const c = locked(1000, 2000);
    expect(cashBucketPrescription(c, run(c))).toBeNull();
    const e = locked(0, 500);
    expect(cashBucketPrescription(e, run(e))).toBeNull();
  });

  it('맞춤 처방 목록에 함께 나옴(현금성을 넘길 때만)', () => {
    const d = sampleData(Y);
    const s = summarize(d.profile, d.assets, d.liabilities, d.cashflows, Y, d.insurance);
    const inp = { ...buildPlanInput(d.profile, d.assets, d.liabilities, d.goals, s), retireAge: s.age };
    const st = withdrawStart(inp);
    expect(st.outflow).toBeGreaterThan(0);
    const c = locked(st.outflow * 3);
    const ins = insuranceGap(d.profile, s, d.insurance, d.goals);
    const has = (cash?: ReturnType<typeof cashOnHand>) => prescriptions(d.profile, s, inp, 99, [], ins, undefined, cash).some((r) => r.title.endsWith('만기 뒤 현금성 바구니로'));
    expect(has(c)).toBe(true);
    expect(has()).toBe(false);
  });

  it('옵션: 연금계좌 안 현금성(계좌 안 자산배분 비율)도 바로 쓸 돈에 함께 셈', () => {
    const irp = asset('IRP', 'pension', 'long', 5000, { alloc: { equity: 50, bond: 30, alt: 0, cash: 20 } });
    const plain = asset('연금저축', 'pension', 'long', 3000);
    expect(pensionCash([irp, plain, asset('파킹통장', 'cash', 'short', 700)])).toBe(1000);
    expect(pensionCash([plain])).toBe(0);
    const c = locked(2000, 500);
    expect(withPensionCash(c, 0)).toBe(c);
    const w = withPensionCash(c, pensionCash([irp]));
    expect(w).toMatchObject({ total: 3500, usable: 1500, locked: 2000, pension: 1000 });
    const run = cashRunway(w, { age: 60, retired: true, outflow: 1000 }, 60);
    expect(run).toMatchObject({ usable: 1.5, all: 3.5 });
    const [chk] = cashRunwayChecks(w, run);
    expect(chk).toMatchObject({ value: '1.5년치', level: 'caution' });
    expect(chk.detail).toContain('바로 쓸 수 있는 돈 500만원과 연금계좌 안 현금성 1,000만원, 모두 1,500만원을 올해 인출(연 1,000만원)로 나눈 값');
    expect(cashBucketPrescription(w, run)!.detail).toContain('바로 쓸 수 있는 돈 1,500만원(연금계좌 안 현금성 1,000만원 포함)은 올해 인출');
    // 연금계좌 안 현금성까지 더해 2년치가 넘으면 점검 양호, 처방 없음
    const big = withPensionCash(c, 2000);
    const run2 = cashRunway(big, { age: 60, retired: true, outflow: 1000 }, 60);
    expect(cashRunwayChecks(big, run2)[0].level).toBe('good');
    expect(cashBucketPrescription(big, run2)).toBeNull();
    expect(cashMoveRows(big, run2)).toEqual([]);
  });

  it('55세 전 인출 시작이면 연금계좌 안 현금성은 버틸 햇수에서 빼고 안내', () => {
    const c = locked(2000, 500);
    const w = withPensionCash(c, 1000, 54);
    expect(w).toMatchObject({ total: 2500, usable: 500, pensionOut: 1000 });
    expect(w.pension).toBeUndefined();
    expect(withPensionCash(c, 1000, 55)).toMatchObject({ usable: 1500, pension: 1000 });
    expect(withPensionCash(c, 1000)).toMatchObject({ usable: 1500, pension: 1000 });
    expect(withPensionCash(c, 0, 50)).toBe(c);
    const note = ' 연금계좌 안 현금성 1,000만원은 55세 전에는 연금계좌에서 꺼내기 어려워 제외했습니다.';
    expect(pensionOutNote(w)).toBe(note);
    expect(pensionOutNote(c)).toBe('');
    expect(cashSourceLabel(w)).toBe('연금계좌 밖 현금성');
    const run = cashRunway(w, { age: 54, retired: false, outflow: 1000 }, 50)!;
    expect(run.usable).toBe(0.5);
    const [chk] = cashRunwayChecks(w, run);
    expect(chk.detail.endsWith(note)).toBe(true);
    expect(chk.detail).not.toContain('연금계좌 안 현금성 1,000만원, 모두');
    expect(cashBucketPrescription(w, run)!.detail.endsWith(note)).toBe(true);
    // 인출 바구니도 같은 숫자(바로 쓸 돈만 0.5년치)
    expect(cashYears(w, 1000)!.usable).toBe(0.5);
  });

  it('55세 기준은 연금계좌 주인별: 배우자 연금계좌는 배우자 나이로', () => {
    const irp = asset('IRP', 'pension', 'long', 5000, { alloc: { equity: 50, bond: 30, alt: 0, cash: 20 } });
    const sp = asset('배우자 IRP', 'pension', 'long', 3000, { owner: 'spouse', alloc: { equity: 50, bond: 0, alt: 0, cash: 50 } });
    expect(pensionCashParts([irp, sp], true)).toEqual({ self: 1000, spouse: 1500 });
    // 배우자가 없으면 명의가 배우자여도 본인 몫
    expect(pensionCashParts([irp, sp], false)).toEqual({ self: 2500, spouse: 0 });
    expect(pensionCash([irp, sp])).toBe(2500);
    // 인출 시작 해 나이: 배우자는 나이 차만큼
    expect(startAges(56, 1970, 1974)).toEqual({ self: 56, spouse: 52 });
    expect(startAges(56, 1970, 0)).toEqual({ self: 56 });
    const c = locked(2000, 500);
    const parts = { self: 1000, spouse: 1500 };
    // 본인 56세·배우자 52세: 본인 몫만 더하고 배우자 몫은 제외
    const w = withPensionCash(c, parts, { self: 56, spouse: 52 });
    expect(w).toMatchObject({ usable: 1500, pension: 1000, pensionOut: 1500, pensionOutParts: { self: 0, spouse: 1500 } });
    expect(pensionOutNote(w)).toBe(' 배우자 연금계좌 안 현금성 1,500만원은 55세 전에는 연금계좌에서 꺼내기 어려워 제외했습니다.');
    // 두 사람 모두 55세 전이면 모두 제외, 주인별 금액을 함께 적음
    const both = withPensionCash(c, parts, { self: 54, spouse: 52 });
    expect(both).toMatchObject({ usable: 500, pensionOut: 2500 });
    expect(both.pension).toBeUndefined();
    expect(pensionOutNote(both)).toBe(' 연금계좌 안 현금성 2,500만원(본인 1,000만원, 배우자 1,500만원)은 55세 전에는 연금계좌에서 꺼내기 어려워 제외했습니다.');
    // 본인만 55세 전이면 본인 몫만 제외(안내는 예전과 같은 문구)
    const self = withPensionCash(c, parts, { self: 54, spouse: 57 });
    expect(self).toMatchObject({ usable: 2000, pension: 1500, pensionOut: 1000 });
    expect(pensionOutNote(self)).toBe(' 연금계좌 안 현금성 1,000만원은 55세 전에는 연금계좌에서 꺼내기 어려워 제외했습니다.');
    // 모두 55세 이상이면 모두 더함
    expect(withPensionCash(c, parts, { self: 58, spouse: 55 })).toMatchObject({ usable: 3000, pension: 2500 });
    expect(withPensionCash(c, parts, { self: 58, spouse: 55 }).pensionOut).toBeUndefined();
  });

  it('인출 바구니 55세 연도: 뺀 몫마다 그 사람이 만 55세가 되는 해', () => {
    const c = locked(2000, 500);
    const both = withPensionCash(c, { self: 1000, spouse: 1500 }, { self: 50, spouse: 48 });
    const rows = pensionFrom55(both, 1976, 1978);
    expect(rows).toEqual([{ who: '본인', year: 2031, amount: 1000 }, { who: '배우자', year: 2033, amount: 1500 }]);
    expect(pensionFrom55Note(rows)).toBe(' 본인 만 55세가 되는 2031년부터 1,000만원, 배우자 만 55세가 되는 2033년부터 1,500만원도 버틸 햇수에 셉니다.');
    // 배우자 몫만 뺐으면 배우자만
    const sp = withPensionCash(c, { self: 1000, spouse: 1500 }, { self: 56, spouse: 52 });
    expect(pensionFrom55(sp, 1970, 1974)).toEqual([{ who: '배우자', year: 2029, amount: 1500 }]);
    // 뺀 몫이 없으면 빈 목록·빈 문자열
    expect(pensionFrom55(c, 1970, 1974)).toEqual([]);
    expect(pensionFrom55Note([])).toBe('');
  });

  it('올해·내년 할 일 55세: 이정표 메모와 같은 문구', () => {
    const p = { ...sampleData(Y).profile, birthYear: Y - 50, spouseBirthYear: Y - 48 };
    const list = [
      asset('IRP', 'pension', 'long', 5000, { alloc: { equity: 50, bond: 30, alt: 0, cash: 20 } }),
      asset('배우자 IRP', 'pension', 'long', 3000, { owner: 'spouse', alloc: { equity: 50, bond: 0, alt: 0, cash: 50 } }),
    ];
    const parts = { self: 0, spouse: 1500 };
    const todo = (year: number, who: string, from?: typeof parts) => yearTodos(p, list, Y, year, [], M, [], from).find((x) => x.startsWith(`${who} 만 55세`));
    expect(todo(Y + 7, '배우자', parts)).toBe(`배우자 만 55세: 연금계좌 개시 가능(배우자 IRP) · ${cashFrom55Note(1500)}`);
    // 이정표 메모와 같은 문구
    const ms = milestones(p, list, [], [], Y, M, [], parts).find((x) => x.label === '배우자 만 55세 → 연금계좌 인출 가능')!;
    expect(todo(Y + 7, '배우자', parts)!.endsWith(ms.note!.slice(ms.note!.indexOf(' · ')))).toBe(true);
    // 뺀 몫이 없는 사람·넘기지 않았을 때는 원래 문구
    expect(todo(Y + 5, '본인', parts)).toBe('본인 만 55세: 연금계좌 개시 가능(IRP)');
    expect(todo(Y + 7, '배우자')).toBe('배우자 만 55세: 연금계좌 개시 가능(배우자 IRP)');
  });

  it('점검·처방에도 만 55세가 되는 해부터 셈 안내', () => {
    const w = withPensionCash(locked(2000, 500), { self: 1000, spouse: 1500 }, { self: 50, spouse: 48 });
    const run = cashRunway(w, { age: 50, retired: false, outflow: 1000 }, 48)!;
    expect(run.usable).toBe(0.5);
    const births = { birthYear: 1976, spouseBirthYear: 1978 };
    const tail = `${pensionOutNote(w)}${pensionFrom55Note(pensionFrom55(w, 1976, 1978))}`;
    expect(tail).toContain(' 본인 만 55세가 되는 2031년부터 1,000만원, 배우자 만 55세가 되는 2033년부터 1,500만원도 버틸 햇수에 셉니다.');
    expect(cashRunwayChecks(w, run, births)[0].detail.endsWith(tail)).toBe(true);
    expect(cashBucketPrescription(w, run, births)!.detail.endsWith(tail)).toBe(true);
    // 출생연도를 넘기지 않으면 제외 안내만
    expect(cashRunwayChecks(w, run)[0].detail).not.toContain('만 55세가 되는');
    expect(cashBucketPrescription(w, run)!.detail.endsWith(pensionOutNote(w))).toBe(true);
  });

  it('55세 전 현금성 부족 처방: 만기 전 예금이 없어도 연금계좌 안 현금성을 빼서 2년치에 못 미치면', () => {
    const c = cashOnHand([asset('파킹통장', 'cash', 'short', 500)], Y, M);
    const w = withPensionCash(c, { self: 1000, spouse: 0 }, { self: 50 });
    const st = { age: 50, retired: false, outflow: 1000 };
    const run = cashRunway(w, st, 48)!;
    expect(run.usable).toBe(0.5);
    // 만기 전 예금이 없어 기존 처방은 없음
    expect(cashBucketPrescription(w, run)).toBeNull();
    const rx = pensionOutPrescription(w, run, { birthYear: 1976, spouseBirthYear: 0 })!;
    expect(rx).toMatchObject({ area: '노후', level: 'caution', title: '55세 전 현금성 부족 — 연금계좌 밖 현금성 1,500만원 더 필요' });
    expect(rx.detail).toContain('바로 쓸 수 있는 돈 500만원은 은퇴 첫해 인출(연 1,000만원) 기준 약 0.5년치로 2년치(2,000만원)에 못 미칩니다.');
    expect(rx.detail).toContain(`${pensionOutNote(w)} 본인 만 55세가 되는 2031년부터 1,000만원도 버틸 햇수에 셉니다.`);
    expect(rx.detail).toContain('모자란 1,500만원을');
    // 2년치가 넘거나, 뺀 몫이 없거나, 만기 전 예금 처방이 나오면 없음
    expect(pensionOutPrescription(w, cashRunway(w, { ...st, outflow: 200 }, 48))).toBeNull();
    expect(pensionOutPrescription(c, cashRunway(c, st, 48))).toBeNull();
    const lw = withPensionCash(locked(2000, 500), 1000, 50);
    const lrun = cashRunway(lw, st, 48);
    expect(cashBucketPrescription(lw, lrun)).not.toBeNull();
    expect(pensionOutPrescription(lw, lrun)).toBeNull();
    // 맞춤 처방 목록에 함께 나옴
    const d = sampleData(Y);
    const s = summarize(d.profile, d.assets, d.liabilities, d.cashflows, Y, d.insurance);
    const inp = { ...buildPlanInput(d.profile, d.assets, d.liabilities, d.goals, s), retireAge: s.age };
    const ws = withdrawStart(inp);
    const ins = insuranceGap(d.profile, s, d.insurance, d.goals);
    const few = withPensionCash(cashOnHand([asset('파킹통장', 'cash', 'short', ws.outflow)], Y, M), ws.outflow, 50);
    const titles = prescriptions(d.profile, s, inp, 99, [], ins, undefined, few).map((r) => r.title);
    expect(titles.some((t) => t.startsWith('55세 전 현금성 부족'))).toBe(true);
    expect(titles.some((t) => t.endsWith('만기 뒤 현금성 바구니로'))).toBe(false);
  });

  it('55세 이정표 메모: 뺀 연금계좌 안 현금성을 이때부터 버틸 햇수에 셈', () => {
    const p = { ...sampleData(Y).profile, birthYear: Y - 50, spouseBirthYear: Y - 48 };
    const list = [
      asset('IRP', 'pension', 'long', 5000, { alloc: { equity: 50, bond: 30, alt: 0, cash: 20 } }),
      asset('배우자 IRP', 'pension', 'long', 3000, { owner: 'spouse', alloc: { equity: 50, bond: 0, alt: 0, cash: 50 } }),
    ];
    const open = (from?: { self: number; spouse: number }) => milestones(p, list, [], [], Y, M, [], from).filter((x) => x.kind === 'open');
    const w = withPensionCash(locked(2000, 500), pensionCashParts(list, true), { self: 56, spouse: 54 });
    const [me, sp] = open(w.pensionOutParts);
    expect(me.label).toBe('본인 만 55세 → 연금계좌 인출 가능');
    expect(me.note).toBe('IRP');
    expect(sp.label).toBe('배우자 만 55세 → 연금계좌 인출 가능');
    expect(sp.note).toBe(`배우자 IRP · ${cashFrom55Note(1500)}`);
    expect(cashFrom55Note(1500)).toBe('이때부터 연금계좌 안 현금성 1,500만원도 버틸 햇수에 셈');
    // 뺀 금액이 없으면 메모는 계좌 이름만
    expect(open().map((x) => x.note)).toEqual(['IRP', '배우자 IRP']);
  });

  it('이정표 할 일: 처방 조건이면 만기 예금·적금 할 일을 현금성 바구니로 옮김으로', () => {
    const p = sampleData(Y).profile;
    const list = [asset('파킹통장', 'cash', 'short', 500), asset('정기예금', 'deposit', 'short', 2000, { maturityYear: 2027, maturityMonth: 9 })];
    const c = cashOnHand(list, Y, M);
    const move = cashMoveRows(c, cashRunway(c, { age: 60, retired: true, outflow: 1000 }, 60));
    expect(move.map((r) => r.name)).toEqual(['정기예금']);
    const todo = (m: typeof move) => yearTodos(p, list, Y, 2027, [], M, m).find((x) => x.includes('정기예금'));
    expect(todo(move)).toBe(`9월 정기예금 만기(예금) 2,000만원 → ${CASH_MOVE_TODO}`);
    expect(CASH_MOVE_TODO).toBe('다시 맡기지 말고 현금성 바구니로 옮김');
    // 2년치가 넘으면 원래 할 일(비상금용)
    const rich = cashMoveRows(c, cashRunway(c, { age: 60, retired: true, outflow: 100 }, 60));
    expect(rich).toEqual([]);
    expect(todo(rich)).toBe('9월 정기예금 만기(예금) 2,000만원 → 비상금은 바로 꺼낼 수 있는 통장이나 짧은 만기로');
  });

  it('인출 바구니 햇수: 옵션이 예면 연금계좌 안 현금성까지, 홈 점검과 같은 숫자', () => {
    const irp = asset('IRP', 'pension', 'long', 5000, { alloc: { equity: 50, bond: 30, alt: 0, cash: 20 } });
    const c = locked(2000, 500);
    const st = { age: 60, retired: true, outflow: 1000 };
    for (const run of [c, withPensionCash(c, pensionCash([irp]))]) {
      // BucketGuide 는 cashYears(runCash, start.outflow), 홈 점검은 cashRunway → cashRunwayChecks
      const guide = cashYears(run, st.outflow)!;
      expect(cashRunwayChecks(run, cashRunway(run, st, 60))[0].value).toBe(`${guide.usable.toFixed(1)}년치`);
    }
    expect(cashYears(withPensionCash(c, 1000), 1000)).toEqual({ usable: 1.5, all: 3.5 });
    expect(cashSourceLabel(c)).toBe('연금계좌 밖 현금성');
    expect(cashSourceLabel(withPensionCash(c, 1000))).toBe('연금계좌 밖 현금성 + 연금계좌 안 현금성');
  });

  it('이정표 목록 메모도 위쪽 할 일과 같게 현금성 바구니로 옮김', () => {
    const p = sampleData(Y).profile;
    const list = [asset('파킹통장', 'cash', 'short', 500), asset('정기예금', 'deposit', 'short', 2000, { maturityYear: 2027, maturityMonth: 9 })];
    const c = cashOnHand(list, Y, M);
    const move = cashMoveRows(c, cashRunway(c, { age: 60, retired: true, outflow: 1000 }, 60));
    const note = (m: typeof move) => milestones(p, list, [], [], Y, M, m).find((x) => x.kind === 'maturity' && x.label === '정기예금 만기(예금)')!.note;
    expect(note(move)).toBe(`2,000만원 · ${CASH_MOVE_TODO}`);
    expect(note([])).toBe('2,000만원 · 비상금은 바로 꺼낼 수 있는 통장이나 짧은 만기로');
    // 위쪽 할 일과 같은 문구
    expect(yearTodos(p, list, Y, 2027, [], M, move).find((x) => x.includes('정기예금'))).toContain(maturityTodo(c.lockedRows[0], move));
    // 이름이 같아도 만기 연월이 다르면 바꾸지 않음
    expect(maturityTodo(c.lockedRows[0], [{ name: '정기예금', year: 2028, month: 9 }])).toBe('비상금은 바로 꺼낼 수 있는 통장이나 짧은 만기로');
  });
});
