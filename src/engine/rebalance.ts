import type { Asset, Nature } from '../types';
import { IRP_RISK_CAP, isRiskCapped } from './buckets';
import { isLocked } from './goals';
import { accountName, ASSET_TYPES, groupOf, isFinancial, mergeAccounts, NATURE_LABEL } from './portfolio';

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
  id?: number; // 자산 id: 이름이 같은 계좌가 여럿이어도 ‘자산 탭에 반영’이 그 줄을 찾게
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
  // 계좌 안에서 바꿀 수 있는 금액: 퇴직연금 계좌의 안전형을 투자형으로 바꿀 때만 70% 한도.
  // 한도는 계좌 단위: 같은 계좌로 묶인 줄(리밸런싱으로 나눈 줄)은 합계의 70%에서 이미 담은 투자형을 뺀 만큼을 안전형 줄에 금액 비례로 나눔
  const hits = (a: Asset) => toInvest && a.type === 'pension' && isRiskCapped(accountName(a));
  const sameAcct = (a: Asset) => (groupOf(a) ? fin.filter((x) => groupOf(x) === groupOf(a)) : [a]);
  const limit = (a: Asset) => {
    if (!hits(a)) return a.amount;
    const rows = sameAcct(a);
    const all = rows.reduce((s, x) => s + x.amount, 0);
    const inv = rows.filter((x) => x.nature === 'invest').reduce((s, x) => s + x.amount, 0);
    const safe = rows.filter((x) => x.nature !== 'invest').reduce((s, x) => s + x.amount, 0);
    return safe > 0 ? (Math.max(0, all * IRP_RISK_CAP - inv) * a.amount) / safe : 0;
  };
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
            .map((a) => ({ ...(a.id !== undefined ? { id: a.id } : {}), name: a.name || '연금계좌', amount: a.amount, move: part(a), keep: a.amount - part(a), limit: limit(a), capped: hits(a) }))
        : [],
    outside,
    short: rest - outside,
  };
}

/**
 * 성격별 기본 기대수익률·변동성(%): 같은 성격의 다른 금융자산이 없을 때만 씀.
 * 안전형은 연금계좌의 원리금보장 상품(정기예금형)으로 보고 자산 유형 ‘예금’ 기본값(3% · 0.5%),
 * 투자형은 자산 유형 ‘연금’ 기본값(5% · 10%, 연금계좌 안 펀드·ETF 혼합 가정)을 따름.
 */
export const NATURE_DEFAULTS: Record<Nature, { ret: number; vol: number }> = {
  safe: { ret: ASSET_TYPES.deposit.ret, vol: ASSET_TYPES.deposit.vol },
  invest: { ret: ASSET_TYPES.pension.ret, vol: ASSET_TYPES.pension.vol },
};

/** 금액(만원)은 만원 단위, 비율·세금 재원은 0.1만원 단위로 맞춤 */
const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * 성격 nature 의 기대수익률·변동성: 같은 성격의 금융자산(평가액 > 0)이 있으면 그 금액가중 평균,
 * 없으면 NATURE_DEFAULTS. 계좌 안에서 새로 산 상품도 그 사람이 이미 가진 같은 성격 자산과 비슷하게 운용한다고 봄.
 */
export function natureReturn(assets: Asset[], nature: Nature): { ret: number; vol: number } {
  const same = assets.filter((a) => isFinancial(a) && a.amount > 0 && a.nature === nature);
  const sum = same.reduce((s, a) => s + a.amount, 0);
  if (sum <= 0) return NATURE_DEFAULTS[nature];
  return {
    ret: round1(same.reduce((s, a) => s + a.amount * (a.expectedReturn || 0), 0) / sum),
    vol: round1(same.reduce((s, a) => s + a.amount * (a.volatility || 0), 0) / sum),
  };
}

/**
 * 연금계좌 안에서 상품을 바꾼 뒤 자산 탭 한 줄을 투자형·안전형 두 줄로 나눔(리밸런싱 카드 ‘자산 탭에 반영’).
 * - 반환 [남는 줄, 새 줄]: 남는 줄은 원래 자산 그대로 amount 만 move 를 뺀 금액, 새 줄은 반대 성격으로 move 만큼.
 * - 과세제외(taxFree)·퇴직금 재원(retirePart)은 금액 비례로 나누고(두 줄 합계 = 원래 값),
 *   명의·지분·연금수령 1년차·인출 시작 연도·꺼내는 순서·비교 순서·유형·용도·수령 연도 등 계좌 속성은 두 줄에 같게 둠.
 * - 새 줄은 id 없이(새로 추가), 이름은 ‘원래 이름 (안전형|투자형)’: 원래 이름을 그대로 품어 IRP·DC·퇴직 판단(isRiskCapped)이 유지됨.
 * - 새 줄의 기대수익률·변동성은 natureReturn(assets 가운데 같은 성격 자산의 금액가중 평균, 없으면 기본값).
 * - 경계: move 를 만원 단위로 맞춘 값이 0 이하면 [원래 줄] 하나(바꿀 것 없음), 평가액 이상이면 줄을 나누지 않고
 *   원래 줄(id·이름 유지)의 성격·기대수익률·변동성만 바꾼 [한 줄].
 */
export function splitAccount(asset: Asset, move: number, assets: Asset[] = []): Asset[] {
  const to: Nature = asset.nature === 'invest' ? 'safe' : 'invest';
  const m = Math.round(move);
  if (!(m > 0) || !(asset.amount > 0)) return [asset];
  const { ret, vol } = natureReturn(assets, to);
  if (m >= asset.amount) return [{ ...asset, nature: to, expectedReturn: ret, volatility: vol }];
  const share = m / asset.amount;
  const group = accountName(asset) || '연금계좌';
  const keep: Asset = { ...asset, amount: asset.amount - m, group };
  const { id: _id, ...rest } = asset;
  void _id;
  const add: Asset = { ...rest, name: `${asset.name || '연금계좌'} (${NATURE_LABEL[to]})`, amount: m, nature: to, expectedReturn: ret, volatility: vol, group };
  for (const key of ['taxFree', 'retirePart'] as const) {
    const v = asset[key];
    if (v === undefined) continue;
    const part = round1(v * share);
    add[key] = part;
    keep[key] = round1(v - part);
  }
  return [keep, add];
}

/** ‘자산 탭에 반영’으로 저장할 내용: put 은 고칠 줄(id 있음), add 는 새 줄, remove 는 지울 줄 id */
export interface SwitchPlan {
  put: Asset[];
  add: Asset[];
  remove: number[];
}

/**
 * 연금계좌 줄 asset 에서 move 만큼을 반대 성격으로 바꿀 때 자산 탭에 저장할 내용.
 * 같은 계좌(group)에 반대 성격 줄이 이미 있으면 새 줄을 만들지 않고 그 줄로 옮김(금액·과세제외·퇴직금 재원을 금액 비례로),
 * 다 옮기면 원래 줄은 지움. 반대 성격 줄이 없으면 splitAccount 로 두 줄로 나눔.
 */
export function switchPlan(asset: Asset, move: number, assets: Asset[] = []): SwitchPlan {
  const to: Nature = asset.nature === 'invest' ? 'safe' : 'invest';
  const m = Math.round(move);
  const g = groupOf(asset);
  const sib = g && m > 0 && asset.amount > 0 ? assets.find((x) => x !== asset && x.id !== undefined && x.id !== asset.id && groupOf(x) === g && x.nature === to) : undefined;
  if (!sib) {
    const rows = splitAccount(asset, move, assets);
    return { put: rows.filter((r) => r.id !== undefined), add: rows.filter((r) => r.id === undefined), remove: [] };
  }
  const moved = Math.min(m, asset.amount);
  const share = moved / asset.amount;
  const next: Asset = { ...sib, amount: sib.amount + moved };
  const keep: Asset = { ...asset, amount: asset.amount - moved };
  for (const key of ['taxFree', 'retirePart'] as const) {
    const v = asset[key];
    if (v === undefined) continue;
    const part = moved >= asset.amount ? v : round1(v * share);
    next[key] = round1((sib[key] ?? 0) + part);
    keep[key] = round1(v - part);
  }
  if (moved >= asset.amount) return { put: [next], add: [], remove: asset.id !== undefined ? [asset.id] : [] };
  return { put: [keep, next], add: [], remove: [] };
}

/**
 * 같은 계좌(group)로 묶인 연금계좌 줄(투자형·안전형 등)을 한 줄로 다시 합칠 때 자산 탭에 저장할 내용(자산 탭 ‘한 줄로 합치기’).
 * - 합친 줄은 묶인 줄 가운데 처음 줄(id 유지) 자리에: 이름 = 계좌 이름, 금액·과세제외·퇴직금 재원 = 합계,
 *   기대수익률·변동성 = 금액가중 평균(소수 첫째 자리), 성격 = 금액이 많은 쪽, 꺼내는 순서·비교 순서 = 0보다 큰 가장 작은 값,
 *   명의·연금수령 1년차 등 나머지 계좌 속성은 처음 줄 값. 묶음(group)은 지움(한 줄이 곧 한 계좌).
 * - 나머지 줄은 remove. 저장된(id 있는) 줄이 둘 이상 묶여 있지 않으면 null.
 */
export function joinPlan(asset: Asset, assets: Asset[]): SwitchPlan | null {
  const g = groupOf(asset);
  if (!g) return null;
  const rows = assets.filter((x) => x.id !== undefined && groupOf(x) === g);
  if (rows.length < 2) return null;
  const [m] = mergeAccounts(rows);
  const { group: _g, ...rest } = m;
  void _g;
  const put: Asset = { ...rest, id: rows[0].id, expectedReturn: round1(m.expectedReturn), volatility: round1(m.volatility) };
  for (const key of ['taxFree', 'retirePart'] as const) if (put[key] !== undefined) put[key] = round1(put[key]!);
  return { put: [put], add: [], remove: rows.slice(1).map((r) => r.id!) };
}
