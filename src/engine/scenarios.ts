import { goalKind } from './montecarlo';
import type { CompareBase } from './orderCompare';
import { pensionTaxSchedule, taxSetup } from './tax';
import { compareStrategy, type WithdrawInput } from './withdrawal';

/** 엑셀 대시보드처럼 잔액을 점검하는 본인 나이 */
export const CHECK_AGES = [80, 90, 100];

export interface ScenarioRun {
  meanReturn: number; // 은퇴 후 수익률(명목 %)
  taxed: boolean; // 연금 세금을 반영했는지(연금계좌가 없으면 세금 없이 계산)
  rows: { age: number; left: number }[]; // 나이별 연말 잔액(오늘 물가)
  depletedAge: number | null; // 자산이 바닥나는 나이(유지되면 null)
  endBalance: number; // 계획 마지막 해 연말 잔액
  totalTax: number; // 계획 기간 연금 세금 합계
}

/**
 * 지금 계획에서 인출 입력 일부(수익률·생활비·목돈 지출 등)만 바꿔 평균수익 경로를 다시 계산.
 * 연금계좌가 있으면 연금 세금(세전 인출)을 반영한 잔액, 없으면 인출 스케줄 잔액.
 */
export function runScenario(base: CompareBase, patch: Partial<WithdrawInput> = {}): ScenarioRun {
  const input: WithdrawInput = { ...base.input, ...patch };
  const schedule = compareStrategy(base.strategy, input, 0).schedule;
  const nowYear = base.profile.birthYear + base.summary.age;
  const setup = taxSetup(base.profile, base.assets, nowYear, input.startBalance, input.meanReturn, base.profile.birthYear + input.startAge);
  if (setup) {
    const tax = pensionTaxSchedule(schedule, setup);
    const last = tax.rows[tax.rows.length - 1];
    return { meanReturn: input.meanReturn, taxed: true, rows: tax.rows.map((r) => ({ age: r.age, left: r.left })), depletedAge: tax.depletedAge, endBalance: last ? last.left : 0, totalTax: tax.totalTax };
  }
  const out = schedule.find((r) => r.endBalance <= 1e-6 && r.withdrawal > 0);
  const last = schedule[schedule.length - 1];
  return { meanReturn: input.meanReturn, taxed: false, rows: schedule.map((r) => ({ age: r.age, left: r.endBalance })), depletedAge: out ? out.age + 1 : null, endBalance: last ? last.endBalance : 0, totalTax: 0 };
}

/** 그 나이 연말 잔액. 계획 기간 밖이면 null */
export const balanceAt = (run: ScenarioRun, age: number) => run.rows.find((r) => r.age === age)?.left ?? null;

/** 점검 나이 가운데 계획 기간(인출 시작 ~ 기대수명 직전)에 드는 것 */
export const checkAges = (input: Pick<WithdrawInput, 'startAge' | 'endAge'>, ages = CHECK_AGES) => ages.filter((a) => a >= input.startAge && a < input.endAge);

export interface ReturnScenario extends ScenarioRun { key: 'low' | 'base' | 'high'; label: string }

/** 수익률 시나리오(비관·기본·낙관)별 평균수익 경로: 엑셀 ‘우물 건강도’ 표 */
export function returnScenarios(base: CompareBase, low: number, high: number): ReturnScenario[] {
  const list: [ReturnScenario['key'], string, number][] = [
    ['low', '비관', low],
    ['base', '기본', base.input.meanReturn],
    ['high', '낙관', high],
  ];
  return list.map(([key, label, meanReturn]) => ({ key, label, ...runScenario(base, { meanReturn }) }));
}

type Extra = NonNullable<WithdrawInput['extras']>[number];

/** 목표 탭 지출(목적자금·반복 지출)만 fromAge 부터 factor 배로. 대출 원금·보험료·세금은 그대로 */
export const scaleLumps = (extras: Extra[] | undefined, factor: number, fromAge: number): Extra[] =>
  (extras ?? []).map((e) => (goalKind(e) === 'goal' && e.age >= fromAge ? { ...e, amount: e.amount * factor } : e));

/** fromAge 부터의 목표 탭 지출 합계(오늘 물가) */
export const lumpTotal = (extras: Extra[] | undefined, fromAge: number) => (extras ?? []).filter((e) => goalKind(e) === 'goal' && e.age >= fromAge).reduce((a, e) => a + e.amount, 0);

/** 생활비(인출액 고정 방식이면 고정 인출액)를 ratio 배로 */
export const scaleLiving = (input: WithdrawInput, ratio: number): Partial<WithdrawInput> =>
  input.fixedDraw !== undefined ? { fixedDraw: input.fixedDraw * ratio } : { expenseAnnual: input.expenseAnnual * ratio };

/**
 * 엑셀 ‘민감도’ 시트의 고갈 나이 표: 세로 생활비 배율 × 가로 목돈 지출 배율, 수익률은 meanReturn.
 * 값은 자산이 바닥나는 나이(유지되면 null)
 */
export function lumpGrid(base: CompareBase, livingRatios: number[], lumpFactors: number[], fromAge: number, meanReturn: number): (number | null)[][] {
  return livingRatios.map((lr) =>
    lumpFactors.map((lf) => runScenario(base, { ...scaleLiving(base.input, lr), extras: scaleLumps(base.input.extras, lf, fromAge), meanReturn }).depletedAge),
  );
}
