import type { Asset } from '../types';
import { IRP_RISK_CAP, isRiskCapped } from './buckets';
import { isLocked } from './goals';
import { isFinancial } from './portfolio';

/** 목표와 이만큼(%p) 안쪽이면 그대로 둠: 작은 차이로 사고팔지 않게 */
export const REBALANCE_BAND = 5;

/** 일반계좌에서 사고팔 자산 한 줄 */
export interface RebalanceMove {
  name: string;
  amount: number; // 지금 평가액
  change: number; // 사고팔 금액(+ 매수, − 매도)
  after: number;
}

/** 연금계좌 한 곳: 계좌 안에서 상품만 바꿈(돈이 계좌 밖으로 나가지 않아 세금 없음) */
export interface RebalanceSwitch {
  name: string;
  amount: number; // 지금 평가액
  move: number; // 계좌 안에서 바꿀 금액(팔아서 반대 성격 상품을 삼)
  keep: number; // 지금 성격으로 남는 금액
  limit: number; // 이 계좌에서 바꿀 수 있는 최대 금액
  capped: boolean; // 퇴직연금 위험자산 70% 한도 때문에 limit 이 평가액보다 작은 계좌
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
  /** 일반계좌(연금계좌가 아닌 금융자산)끼리 사고파는 몫 */
  general: { amount: number; sell: RebalanceMove[]; buy: RebalanceMove[] };
  /** 연금계좌별로 계좌 안에서 바꾸는 몫(바꿀 금액이 있는 계좌만) */
  pensions: RebalanceSwitch[];
  /** 계좌 안 교체만으로는 못 맞춰, 연금계좌에서 돈을 빼 계좌 밖에서 사야 맞춰지는 금액 */
  outside: number;
  /** 움직일 수 있는 자산이 모자라 어떻게 해도 맞추지 못하는 금액 */
  short: number;
}

/** 줄일 금액을 넘치는 쪽 자산에 나누는 방식: 'ratio' 바꿀 수 있는 금액 비례, 'pensionFirst' 세금 없는 연금계좌부터 */
export type RebalanceMode = 'ratio' | 'pensionFirst';

/**
 * 목표 투자형 비중에 맞추려면 무엇을 얼마나 사고팔지를 계좌별로 나눠 계산.
 * - 'ratio': 넘치는 쪽 자산을 바꿀 수 있는 금액에 비례해 줄임.
 * - 'pensionFirst': 연금계좌의 바꿀 수 있는 금액을 먼저 채우고(연금계좌끼리는 비례), 모자란 만큼만 일반계좌에서 비례로 팖.
 *   옮기는 합계·outside·short 는 두 방식이 같음.
 * - 일반계좌에서 판 돈은 일반계좌의 모자란 쪽 자산을 평가액에 비례해 삼(없으면 살 곳은 비워 둠).
 * - 연금계좌(자산 한 줄 = 계좌 하나)는 판 돈으로 같은 계좌 안에서 반대 성격 상품을 삼.
 *   퇴직연금 계좌(IRP·DC)는 투자형을 평가액의 70%까지만 담을 수 있어, 넘는 몫은 계좌 밖으로 빼야 맞춰짐(outside).
 * - 수령 연도 전이라 묶인 자산(노란우산 등)은 비중에는 넣되 사고팔지 않음.
 */
export function rebalance(assets: Asset[], target: number, nowYear: number, band = REBALANCE_BAND, mode: RebalanceMode = 'ratio'): Rebalance {
  const fin = assets.filter((a) => isFinancial(a) && a.amount > 0);
  const total = fin.reduce((s, a) => s + a.amount, 0);
  const invest = fin.filter((a) => a.nature === 'invest').reduce((s, a) => s + a.amount, 0);
  const t = Math.min(100, Math.max(0, target));
  const current = total > 0 ? (invest / total) * 100 : 0;
  const gap = current - t;
  const want = invest - (total * t) / 100;
  const needed = total > 0 && Math.abs(gap) > band;
  const toInvest = want < 0;
  const movable = fin.filter((a) => !isLocked(a, nowYear));
  const from = movable.filter((a) => (a.nature === 'invest') !== toInvest);
  // 계좌 안에서 바꿀 수 있는 금액: 퇴직연금 계좌의 안전형을 투자형으로 바꿀 때만 70% 한도
  const hits = (a: Asset) => toInvest && a.type === 'pension' && isRiskCapped(a.name);
  const limit = (a: Asset) => (hits(a) ? a.amount * IRP_RISK_CAP : a.amount);
  const room = from.reduce((s, a) => s + limit(a), 0);
  const size = needed ? Math.min(Math.abs(want), room) : 0;
  // 연금계좌부터: 연금계좌 몫(penSize)을 연금계좌끼리, 나머지(genSize)를 일반계좌끼리 각각 limit 비례로
  const penRoom = from.filter((a) => a.type === 'pension').reduce((s, a) => s + limit(a), 0);
  const genRoom = room - penRoom;
  const penSize = Math.min(size, penRoom);
  const genSize = size - penSize;
  const part = (a: Asset) => {
    if (mode === 'pensionFirst') {
      if (a.type === 'pension') return penRoom > 0 ? (penSize * limit(a)) / penRoom : 0;
      return genRoom > 0 ? (genSize * limit(a)) / genRoom : 0;
    }
    return room > 0 ? (size * limit(a)) / room : 0;
  };

  const genFrom = from.filter((a) => a.type !== 'pension');
  const genTo = movable.filter((a) => a.type !== 'pension' && (a.nature === 'invest') === toInvest);
  const genAmount = genFrom.reduce((s, a) => s + part(a), 0);
  const genToSum = genTo.reduce((s, a) => s + a.amount, 0);
  const row = (a: Asset, change: number): RebalanceMove => ({ name: a.name || '자산', amount: a.amount, change, after: a.amount + change });

  const rest = needed ? Math.max(0, Math.abs(want) - room) : 0;
  const blocked = from.reduce((s, a) => s + (a.amount - limit(a)), 0); // 한도에 걸려 계좌 안에서는 못 바꾸는 금액
  const outside = Math.min(rest, blocked);
  return {
    total,
    invest,
    current,
    target: t,
    gap,
    shift: size > 0 ? Math.sign(want) * size : 0,
    needed,
    general: {
      amount: genAmount,
      sell: genAmount > 0 ? genFrom.map((a) => row(a, -part(a))) : [],
      buy: genAmount > 0 && genToSum > 0 ? genTo.map((a) => row(a, (genAmount * a.amount) / genToSum)) : [],
    },
    pensions:
      size > 0
        ? from
            .filter((a) => a.type === 'pension')
            .map((a) => ({ name: a.name || '연금계좌', amount: a.amount, move: part(a), keep: a.amount - part(a), limit: limit(a), capped: hits(a) }))
        : [],
    outside,
    short: rest - outside,
  };
}
