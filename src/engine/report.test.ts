import { describe, expect, it } from 'vitest';
import { sampleData } from '../db/sample';
import { buildPlanInput, planGoals } from './goals';
import { insuranceGap } from './insurance';
import { deterministicPath, retirementNeed, simulate, withdrawStart } from './montecarlo';
import { summarize } from './portfolio';
import { prescriptions } from './prescribe';
import { cashOnHand, withPensionCash } from './buckets';
import { buildReport, cashLine, depletionText, depletionWithReturn, livingText, marketLine } from './report';
import { bulletChecks, retiredBasis, riskChecks } from './risk';

describe('요약 보고 시장 상태 문장', () => {
  const now = new Date(2026, 10, 17);
  it('저장한 등락률·입력 날짜로 시장 상태와 적용할 규칙, 30일이 지나면 다시 넣으라는 안내', () => {
    expect(marketLine({}, now)).toBeUndefined();
    const bear = marketLine({ marketDrawdown: -18, marketDrawdownDate: '2026-11-10' }, now)!;
    expect(bear.level).toBe('caution');
    expect(bear.text).toBe('인출용 자산 배치 가이드에 넣은 주식형 등락률은 고점 대비 -18%(11월 10일 기준)로 지금 시장 상태는 하락장입니다. 지금 적용할 규칙: 하락장(고점 대비 -18%): 주식형 매도를 멈추고 현금성 바구니에서만 인출, 리밸런싱 보류. 금 ETF가 올랐다면 그 일부로 현금성을 채웁니다.');
    const normal = marketLine({ marketDrawdown: -5, marketDrawdownDate: '2026-11-10' }, now)!;
    expect(normal.level).toBeUndefined();
    expect(normal.text).toContain('지금 시장 상태는 보통입니다. 지금 적용할 규칙: 보통(고점 대비 -5%)');
    expect(marketLine({ marketDrawdown: 0 }, now)!.text).toContain('고점 대비 0%로 지금 시장 상태는 고점 부근입니다.');
    const old = marketLine({ marketDrawdown: -5, marketDrawdownDate: '2026-09-01' }, now)!;
    expect(old.level).toBe('caution');
    expect(old.text).toContain('(9월 1일 기준)로');
    expect(old.text).toContain('넣은 지 77일이 지났으니 인출 계획 ‘인출용 자산 배치 가이드’에 지금 지수로 다시 넣어 주세요.');
  });

  it('자산과 부채 섹션에 들어감', () => {
    const d = sampleData(2026);
    const p = { ...d.profile, marketDrawdown: -20, marketDrawdownDate: '2026-11-10' };
    const s = summarize(p, d.assets, d.liabilities, d.cashflows, 2026, d.insurance);
    const inp = buildPlanInput(p, d.assets, d.liabilities, d.goals, s);
    const rep = buildReport({ profile: p, summary: s, planInput: inp, sim: simulate(inp, 50), start: withdrawStart(inp), need: retirementNeed(inp), liabilities: d.liabilities, goals: d.goals, checks: [], rx: [], nowYear: 2026, now });
    const sec = rep.find((x) => x.title === '2. 자산과 부채')!;
    expect(sec.lines.some((l) => l.level === 'caution' && l.text.includes('지금 시장 상태는 하락장입니다.'))).toBe(true);
  });
});

describe('요약 보고', () => {
  const d = sampleData(2026);
  const loans = [...d.liabilities, { name: '지인 대출', balance: 30000, rate: 4, monthlyPayment: 100, endAge: 0, repay: 'bullet' as const }];
  const s = summarize(d.profile, d.assets, loans, d.cashflows, 2026, d.insurance);
  const inp = buildPlanInput(d.profile, d.assets, loans, d.goals, s);
  const sim = simulate(inp, 200);
  const start = withdrawStart(inp);
  const basis = retiredBasis(s, inp);
  const ins = insuranceGap(d.profile, basis, d.insurance, d.goals);
  const goalPlans = planGoals(d.goals, d.assets, s.age);
  const checks = [...bulletChecks(loans, s.age), ...riskChecks(d.profile, d.assets, basis, start)];
  const rx = prescriptions(d.profile, basis, inp, sim.successRate, goalPlans, ins);
  const report = buildReport({ profile: d.profile, summary: s, planInput: inp, sim, start, need: retirementNeed(inp), liabilities: loans, goals: d.goals, checks, rx, nowYear: 2026 });
  const all = report.flatMap((x) => x.lines.map((l) => l.text)).join('\n');

  it('여섯 부분을 문장으로 채움', () => {
    expect(report.map((x) => x.title)).toEqual(['1. 한눈에 보는 결론', '2. 자산과 부채', '3. 노후 소득과 따로 나가는 돈', '4. 점검이 필요한 항목', '5. 권장 대응', '6. 가정과 한계']);
    for (const sec of report) expect(sec.lines.length).toBeGreaterThan(0);
    expect(all).toContain(`성공확률은 ${Math.round(sim.successRate)}%`);
  });
  it('고갈 나이는 노후 진단과 같은 평균 수익 경로', () => {
    expect(all).toContain(depletionText(deterministicPath(inp).depletedAt, d.profile.lifeExpectancy));
    expect(depletionText(null, 100)).toBe('100세까지 유지');
    expect(depletionText(84, 100)).toBe('84세에 고갈');
  });
  it('수익률이 낮으면 고갈이 늦어지지 않음', () => {
    const lo = depletionWithReturn(inp, -2) ?? Infinity;
    const hi = depletionWithReturn(inp, 2) ?? Infinity;
    expect(lo).toBeLessThanOrEqual(hi);
  });
  it('만기 나이가 빈 대출은 이자만 계속 내는 것으로 설명하고, 점검과 처방에 같은 문장을 두 번 쓰지 않음', () => {
    expect(all).toContain('지인 대출: 잔액 3억원, 금리 4%, 월 100만원 · 만기 나이가 비어 이자만 계속 내는 것으로 계산');
    expect(all.split('지인 대출 만기 나이 입력 필요').length - 1).toBe(1);
  });
  it('만기 미정(이자만 납입)으로 표시한 대출은 위험 경고 대신 참고로 안내', () => {
    const open = [...d.liabilities, { name: '지인 대출', balance: 30000, rate: 4, monthlyPayment: 100, endAge: 0, repay: 'bullet' as const, maturity: 'open' as const }];
    const inp2 = buildPlanInput(d.profile, d.assets, open, d.goals, s);
    expect(bulletChecks(open, s.age)).toEqual([]);
    const rx2 = prescriptions(d.profile, basis, inp2, sim.successRate, goalPlans, ins);
    const p = rx2.find((r) => r.title === '지인 대출 만기 미정(이자만 납입)');
    expect(p).toMatchObject({ level: 'good', badge: '참고' });
    expect(p!.detail).toContain('원금 3억원');
    expect(rx2.some((r) => r.title.includes('만기 나이 입력 필요'))).toBe(false);
    // 계산은 만기 나이가 빈 대출과 같음(이자만 평생)
    expect(deterministicPath(inp2).depletedAt).toBe(deterministicPath(inp).depletedAt);
    const rep = buildReport({ profile: d.profile, summary: s, planInput: inp2, sim, start, need: retirementNeed(inp2), liabilities: open, goals: d.goals, checks: bulletChecks(open, s.age), rx: rx2, nowYear: 2026 });
    const txt = rep.flatMap((x) => x.lines.map((l) => l.text)).join('\n');
    expect(txt).toContain('지인 대출: 잔액 3억원, 금리 4%, 월 100만원 · 만기 미정(이자만 납입)');
    expect(txt).not.toContain('만기 나이 입력 필요');
    expect(rep[1].lines.find((l) => l.text.startsWith('지인 대출'))!.level).toBeUndefined();
  });
  it('현금성 문장: 바로 쓸 돈·만기 전 예금·적금·하락장에 버틸 햇수', () => {
    const cash = [
      { name: '파킹통장', type: 'cash' as const, purpose: 'short' as const, amount: 1000 },
      { name: '정기예금', type: 'deposit' as const, purpose: 'short' as const, amount: 2000, maturityYear: 2027, maturityMonth: 9 },
    ];
    const c = cashOnHand(cash as never, 2026, 11);
    expect(cashLine(c, 1000)).toEqual({
      text: '연금계좌 밖 현금성(현금·예금·적금) 3,000만원 가운데 바로 쓸 수 있는 돈은 1,000만원이고, 만기가 3개월 넘게 남은 예금·적금 2,000만원(정기예금 2027년 9월 만기)은 깨면 중도해지 이율을 받습니다. 하락장에 주식을 팔지 않고 인출(연 1,000만원) 기준 바로 쓸 돈만으로 약 1.0년, 만기 전 예금·적금까지 깨면 약 3.0년 버틸 수 있습니다(2년치에 못 미침).',
      level: 'caution',
    });
    // 만기 전 예금이 없고 2년치 넘으면 양호, 인출이 없으면 햇수 없이
    const free = cashOnHand([cash[0]] as never, 2026, 11);
    expect(cashLine(free, 400)).toEqual({ text: '연금계좌 밖 현금성(현금·예금·적금) 1,000만원은 모두 바로 쓸 수 있는 돈입니다. 하락장에 주식을 팔지 않고 인출(연 400만원) 기준 바로 쓸 돈만으로 약 2.5년 버틸 수 있습니다.', level: 'good' });
    expect(cashLine(free, 0)).toEqual({ text: '연금계좌 밖 현금성(현금·예금·적금) 1,000만원은 모두 바로 쓸 수 있는 돈입니다.' });
    expect(cashLine(cashOnHand([], 2026, 11), 1000)).toBeUndefined();
    // 요약 보고 ‘자산과 부채’에 첫해 인출 기준으로 들어감
    const rep = buildReport({ profile: d.profile, summary: s, planInput: inp, sim, start, need: retirementNeed(inp), liabilities: loans, goals: d.goals, checks, rx, nowYear: 2026, cash: c });
    expect(rep[1].lines.map((l) => l.text)).toContain(cashLine(c, start.outflow)!.text);
    expect(all).not.toContain('연금계좌 밖 현금성');
  });
  it('현금성 문장: 점검기준 옵션이 예면 연금계좌 안 현금성을 따로 적고 햇수에 더함, 55세 전이면 제외 안내', () => {
    const cash = [
      { name: '파킹통장', type: 'cash' as const, purpose: 'short' as const, amount: 1000 },
      { name: '정기예금', type: 'deposit' as const, purpose: 'short' as const, amount: 2000, maturityYear: 2027, maturityMonth: 9 },
    ];
    const c = cashOnHand(cash as never, 2026, 11);
    const head = '연금계좌 밖 현금성(현금·예금·적금) 3,000만원 가운데 바로 쓸 수 있는 돈은 1,000만원이고, 만기가 3개월 넘게 남은 예금·적금 2,000만원(정기예금 2027년 9월 만기)은 깨면 중도해지 이율을 받습니다.';
    expect(cashLine(withPensionCash(c, 1000, 60), 1000)).toEqual({
      text: `${head} 점검기준 설정에 따라 연금계좌 안 현금성 1,000만원도 바로 쓸 돈에 더합니다(모두 2,000만원). 하락장에 주식을 팔지 않고 인출(연 1,000만원) 기준 바로 쓸 돈만으로 약 2.0년, 만기 전 예금·적금까지 깨면 약 4.0년 버틸 수 있습니다.`,
      level: 'good',
    });
    // 인출 시작이 55세 전이면 더하지 않고 제외 안내만
    const young = cashLine(withPensionCash(c, 1000, 50), 1000)!;
    expect(young.level).toBe('caution');
    expect(young.text).toBe(`${cashLine(c, 1000)!.text} 연금계좌 안 현금성 1,000만원은 55세 전에는 연금계좌에서 꺼내기 어려워 제외했습니다.`);
    // 출생연도를 넘기면 만 55세가 되는 해부터 셈을 덧붙임(요약 보고는 프로필을 넘김)
    expect(cashLine(withPensionCash(c, 1000, 50), 1000, { birthYear: 1976, spouseBirthYear: 0 })!.text)
      .toBe(`${young.text} 본인 만 55세가 되는 2031년부터 1,000만원도 버틸 햇수에 셉니다.`);
    const both = cashLine(withPensionCash(c, { self: 1000, spouse: 1500 }, { self: 50, spouse: 48 }), 1000, { birthYear: 1976, spouseBirthYear: 1978 })!.text;
    expect(both.endsWith(' 연금계좌 안 현금성 2,500만원(본인 1,000만원, 배우자 1,500만원)은 55세 전에는 연금계좌에서 꺼내기 어려워 제외했습니다. 본인 만 55세가 되는 2031년부터 1,000만원, 배우자 만 55세가 되는 2033년부터 1,500만원도 버틸 햇수에 셉니다.')).toBe(true);
    // 뺀 몫이 없으면 덧붙이지 않음
    expect(cashLine(withPensionCash(c, 1000, 60), 1000, { birthYear: 1966, spouseBirthYear: 0 })!.text).not.toContain('만 55세가 되는');
    // 연금계좌 밖 현금성이 없으면 그렇다고 적음
    expect(cashLine(withPensionCash(cashOnHand([], 2026, 11), 800, 60), 400)!.text).toBe('연금계좌 밖 현금성(현금·예금·적금)은 없습니다. 점검기준 설정에 따라 연금계좌 안 현금성 800만원도 바로 쓸 돈에 더합니다(모두 800만원). 하락장에 주식을 팔지 않고 인출(연 400만원) 기준 바로 쓸 돈만으로 약 2.0년 버틸 수 있습니다.');
  });
  it('생활비 문장: 방식별', () => {
    expect(livingText({ ...d.profile, expenseMode: 'draw', fixedDraw: 450, drawIncludes: ['premium'] })).toContain('월 450만원을 금액 그대로');
    expect(livingText({ ...d.profile, expenseMode: 'draw', fixedDraw: 450, drawIncludes: ['premium'] })).toContain('보험료도 이 금액 안에서 냅니다');
    expect(livingText({ ...d.profile, expenseMode: 'real' })).toContain('물가만큼 올라');
  });
});
