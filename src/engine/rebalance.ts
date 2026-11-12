import type { Asset } from '../types';
import { isLocked } from './goals';
import { isFinancial } from './portfolio';

/** 목표와 이만큼(%p) 안쪽이면 그대로 둠: 작은 차이로 사고팔지 않게 */
export const REBALANCE_BAND = 5;

export interface RebalanceMove {
  name: string;
  amount: number; // 지금 평가액
  change: number; // 사고팔 금액(+ 매수, − 매도)
  after: number;
  pension: boolean; // 연금계좌(안에서 바꾸면 세금 없음)
}

export interface Rebalance {
  total: number; // 금융자산 합계(수령 전 묶인 자산 포함)
  invest: number; // 투자형 금액
  current: number; // 지금 투자형 비중(%)
  target: number; // 목표 투자형 비중(%)
  gap: number; // 지금 − 목표(%p)
  /** 옮길 금액: + 면 투자형을 팔아 안전형으로, − 면 안전형을 팔아 투자형으로 */
  shift: number;
  needed: boolean; // 허용 범위를 벗어나 조정이 필요한지
  sell: RebalanceMove[];
  buy: RebalanceMove[];
  /** 팔 쪽에서 움직일 수 있는 자산이 모자라 다 맞추지 못한 금액 */
  short: number;
}

/**
 * 목표 투자형 비중에 맞추려면 무엇을 얼마나 사고팔지.
 * 넘치는 쪽 자산을 평가액에 비례해 팔고, 모자란 쪽 자산을 평가액에 비례해 삼(모자란 쪽에 자산이 없으면 살 곳은 비워 둠).
 * 수령 연도 전이라 묶인 자산(노란우산 등)은 비중에는 넣되 사고팔지 않음.
 */
export function rebalance(assets: Asset[], target: number, nowYear: number, band = REBALANCE_BAND): Rebalance {
  const fin = assets.filter((a) => isFinancial(a) && a.amount > 0);
  const total = fin.reduce((s, a) => s + a.amount, 0);
  const invest = fin.filter((a) => a.nature === 'invest').reduce((s, a) => s + a.amount, 0);
  const t = Math.min(100, Math.max(0, target));
  const current = total > 0 ? (invest / total) * 100 : 0;
  const gap = current - t;
  const want = invest - (total * t) / 100;
  const needed = total > 0 && Math.abs(gap) > band;
  const movable = fin.filter((a) => !isLocked(a, nowYear));
  const from = movable.filter((a) => (a.nature === 'invest') === want > 0);
  const to = movable.filter((a) => (a.nature === 'invest') !== want > 0);
  const fromSum = from.reduce((s, a) => s + a.amount, 0);
  const toSum = to.reduce((s, a) => s + a.amount, 0);
  const shift = needed ? Math.sign(want) * Math.min(Math.abs(want), fromSum) : 0;
  const move = (a: Asset, change: number): RebalanceMove => ({ name: a.name || '자산', amount: a.amount, change, after: a.amount + change, pension: a.type === 'pension' });
  const size = Math.abs(shift);
  return {
    total,
    invest,
    current,
    target: t,
    gap,
    shift,
    needed,
    sell: size > 0 ? from.map((a) => move(a, -(size * a.amount) / fromSum)) : [],
    buy: size > 0 && toSum > 0 ? to.map((a) => move(a, (size * a.amount) / toSum)) : [],
    short: needed ? Math.max(0, Math.abs(want) - fromSum) : 0,
  };
}
