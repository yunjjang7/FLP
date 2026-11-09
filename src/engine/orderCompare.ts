import type { Asset, ContribPlan, Goal, Liability, Profile } from '../types';
import type { Summary } from './portfolio';
import { buildPlanInput } from './goals';
import { DEFAULT_CONTRIB } from './incomeTax';
import { pensionTaxSchedule, taxSetup, type TaxResult, type TaxSetup } from './tax';
import { compareStrategy, type StrategyKey, type WithdrawInput } from './withdrawal';

/** 비교용 추가 납입 설정(연 만원, 연도) */
export interface CompareContrib {
  self: number;
  spouse: number;
  from: number;
  to: number;
}

export interface OrderCombo {
  key: string;
  label: string;
  note: string;
  keepOrder: boolean; // 꺼내는 순서를 그대로 쓸지(아니면 입력 순서)
  keepStart: boolean; // 인출 시작 연도를 그대로 쓸지(아니면 모든 계좌 바로 인출)
  self: boolean; // 본인 추가 납입
  spouse: boolean; // 배우자 추가 납입
}

/** 엑셀 ‘인출순서비교’ 시트의 조합 5가지(① 기준 → ② 순서·시작 연도 → ③~⑤ 추가 납입) */
export function orderCombos(hasSpouse: boolean): OrderCombo[] {
  const list: OrderCombo[] = [
    { key: '1', label: '① 입력 순서 · 모든 계좌 바로 인출 · 납입 없음', note: '꺼내는 순서·인출 시작 연도를 쓰지 않을 때', keepOrder: false, keepStart: false, self: false, spouse: false },
    { key: '2', label: '② 지금 순서 · 인출 시작 연도 · 납입 없음', note: '계좌별 꺼내는 순서와 인출 시작 연도 적용', keepOrder: true, keepStart: true, self: false, spouse: false },
    { key: '3', label: '③ ② + 본인 추가 납입', note: '인출 시작 전 본인 계좌로 납입', keepOrder: true, keepStart: true, self: true, spouse: false },
    { key: '4', label: hasSpouse ? '④ ② + 본인·배우자 추가 납입' : '', note: '', keepOrder: true, keepStart: true, self: true, spouse: true },
    { key: '5', label: hasSpouse ? '⑤ ② + 배우자 추가 납입만' : '', note: '', keepOrder: true, keepStart: true, self: false, spouse: true },
  ];
  return list.filter((c) => c.label);
}

export interface ComboResult {
  combo: OrderCombo | null; // null = 지금 계획
  tax: TaxResult;
  totalTax: number; // 세금 합계(실질)
  credit: number; // 세액공제 환급 합계(실질)
  netTax: number; // 세금 − 환급
  overYears: number[]; // 1,500만 한도를 넘는 해
  overAmount: number; // 한도를 넘어 16.5%로 꺼낸 금액(실질)
  limitAccounts: number; // 연금수령한도를 넘는 계좌 수
  contrib: number; // 추가 납입 합계(실질)
  depletedAge: number | null; // 세금 반영 고갈 나이
  endBalance: number; // 계획 마지막 해 연말 잔액(세금 반영, 실질)
}

export interface CompareBase {
  profile: Profile;
  assets: Asset[];
  liabilities: Liability[];
  goals: Goal[];
  summary: Summary;
  input: WithdrawInput; // 지금 계획의 인출 입력(인출 시작 자산·전략 설정 포함)
  strategy: StrategyKey;
  meanReturn: number; // 은퇴 후 기대수익률(명목 %)
}

/** 세금 결과를 비교용 숫자로 요약 */
export function summarizeTax(tax: TaxResult, setup: TaxSetup, combo: OrderCombo | null): ComboResult {
  const { nowYear } = setup;
  const defl = (year: number) => Math.pow(1 + setup.inflation / 100, year - nowYear);
  const totalTax = tax.totalTax;
  // 환급은 다음 해 들어옴
  const credit = setup.contrib.reduce((a, c) => a + (c.creditSelf + c.creditSpouse) / defl(c.year + 1), 0);
  const overAmount = tax.rows.reduce((a, r) => a + (r.over.self + r.over.spouse) / defl(r.year), 0);
  const last = tax.rows[tax.rows.length - 1];
  return {
    combo,
    tax,
    totalTax,
    credit,
    netTax: totalTax - credit,
    overYears: tax.overYears,
    overAmount,
    limitAccounts: tax.limitWarnings.length,
    contrib: tax.rows.reduce((a, r) => a + r.contrib, 0),
    depletedAge: tax.depletedAge,
    endBalance: last ? last.left : 0,
  };
}

/** 조합 하나를 계산: 프로필·자산을 조합대로 바꿔 계획 입력(세액공제 환급)부터 다시 만들고 세금을 입힘 */
export function runCombo(base: CompareBase, combo: OrderCombo, c: CompareContrib): ComboResult | null {
  const { profile, assets } = base;
  const nowYear = profile.birthYear + base.summary.age;
  const cur = { ...DEFAULT_CONTRIB, ...(profile.contrib ?? {}) };
  const contrib: ContribPlan = {
    self: combo.self ? c.self : 0,
    spouse: combo.spouse ? c.spouse : 0,
    from: c.from,
    to: c.to,
    selfRate: cur.selfRate,
    spouseRate: cur.spouseRate,
  };
  const vp: Profile = { ...profile, contrib };
  const va: Asset[] = assets.map((a) =>
    a.type !== 'pension' ? a : { ...a, drawOrder: combo.keepOrder ? a.drawOrder : 0, drawStartYear: combo.keepStart ? a.drawStartYear : 0 },
  );
  const plan = buildPlanInput(vp, va, base.liabilities, base.goals, base.summary);
  const start = base.input.startAge;
  const input: WithdrawInput = {
    ...base.input,
    inflows: plan.inflows?.filter((x) => x.age >= start),
    extras: plan.goals.filter((g) => g.age >= start),
  };
  const schedule = compareStrategy(base.strategy, input, 0).schedule;
  const setup = taxSetup(vp, va, nowYear, base.input.startBalance, base.meanReturn);
  if (!setup) return null;
  return summarizeTax(pensionTaxSchedule(schedule, setup), setup, combo);
}
