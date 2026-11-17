import type { Alloc, AssetClass, Asset, AssetType, Nature, PensionKind } from '../types';

/**
 * 계좌 안 자산배분(주식형·채권형·대체자산·현금성 비율, %).
 * 비율을 넣은 자산은 한 줄 안에서 위험자산(주식형+대체) 몫만 투자형으로 셈. 넣지 않은 자산은 지금처럼 성격(nature) 하나로 셈.
 */

export const ASSET_CLASSES: AssetClass[] = ['equity', 'bond', 'alt', 'cash'];

export const CLASS_LABEL: Record<AssetClass, string> = {
  equity: '주식형',
  bond: '채권형',
  alt: '대체자산',
  cash: '현금성',
};

export const CLASS_HINT: Record<AssetClass, string> = {
  equity: '주식·주식형 ETF·TDF 주식 몫',
  bond: '채권·채권형 ETF·배당',
  alt: '금·리츠·원자재',
  cash: '예금·MMF·원리금보장',
};

/** 위험자산(투자형으로 보는 자산군) */
export const RISK_CLASSES: AssetClass[] = ['equity', 'alt'];

/** 자산군별 기본 기대수익률·변동성(%, 명목 장기 가정): ‘배분으로 계산’ 버튼에 씀 */
export const CLASS_DEFAULTS: Record<AssetClass, { ret: number; vol: number }> = {
  equity: { ret: 7, vol: 16 },
  bond: { ret: 3.5, vol: 5 },
  alt: { ret: 5, vol: 15 },
  cash: { ret: 2.5, vol: 0.5 },
};

/** 자산배분 비율을 넣을 수 있는 자산 유형 */
export const ALLOC_TYPES: AssetType[] = ['stock', 'fund', 'etf', 'pension', 'other'];
export const canAlloc = (a: Pick<Asset, 'type'>) => ALLOC_TYPES.includes(a.type);

/** 퇴직연금(IRP·DC) 위험자산 한도(평가액 대비) */
export const IRP_RISK_CAP = 0.7;

export const PENSION_KIND_LABEL: Record<PensionKind, string> = {
  savings: '연금저축',
  irp: 'IRP',
  dc: 'DC형 퇴직연금',
};

/** 이름으로 퇴직연금 계좌(IRP·DC·퇴직연금) 여부를 판단: 계좌 종류를 고르지 않았을 때만 씀 */
export const isRiskCappedName = (name: string) => /IRP|DC|퇴직/i.test(name);

/** 위험자산 70% 한도 계좌인지: 계좌 종류(IRP·DC)를 골랐으면 그대로, 비웠으면 이름(계좌 이름)으로 판단 */
export function isCappedAsset(a: Pick<Asset, 'type' | 'pensionKind' | 'name' | 'group'>) {
  if (a.type !== 'pension') return false;
  if (a.pensionKind) return a.pensionKind === 'irp' || a.pensionKind === 'dc';
  return isRiskCappedName(a.group?.trim() || a.name);
}

const sumOf = (x: Partial<Alloc>) => ASSET_CLASSES.reduce((s, k) => s + Math.max(0, Number(x[k]) || 0), 0);
export const allocSum = (x?: Partial<Alloc>) => (x ? sumOf(x) : 0);

/** 비율을 넣은 자산인지(넣을 수 있는 유형이고 합계 > 0) */
export const hasAlloc = (a: Pick<Asset, 'type' | 'alloc'>) => canAlloc(a) && allocSum(a.alloc) > 0;

/** 합계를 100으로 맞춘 비율(소수 첫째 자리). 합계가 0이면 undefined */
export function normalizeAlloc(x?: Partial<Alloc>): Alloc | undefined {
  const s = allocSum(x);
  if (!x || s <= 0) return undefined;
  const r = (v: number) => Math.round(v * 10) / 10;
  const out = Object.fromEntries(ASSET_CLASSES.map((k) => [k, r((Math.max(0, Number(x[k]) || 0) / s) * 100)])) as Alloc;
  // 반올림 오차는 가장 큰 칸에서 맞춤
  const diff = r(100 - sumOf(out));
  if (diff !== 0) {
    const big = ASSET_CLASSES.reduce((b, k) => (out[k] > out[b] ? k : b), 'equity' as AssetClass);
    out[big] = r(out[big] + diff);
  }
  return out;
}

/** 비율을 넣지 않은 자산이 어느 자산군인지(유형·성격으로 판단). 성격과 위험자산 여부가 늘 같도록 */
export function defaultClass(a: Pick<Asset, 'type' | 'nature'>): AssetClass {
  if (a.nature === 'invest') return a.type === 'other' || a.type === 'realestate' ? 'alt' : 'equity';
  return a.type === 'bond' ? 'bond' : 'cash';
}

/** 자산 한 줄의 자산군 비율(%, 합계 100). 비율이 없으면 defaultClass 100% */
export function allocOf(a: Pick<Asset, 'type' | 'nature' | 'alloc'>): Alloc {
  if (hasAlloc(a)) return normalizeAlloc(a.alloc)!;
  const out: Alloc = { equity: 0, bond: 0, alt: 0, cash: 0 };
  out[defaultClass(a)] = 100;
  return out;
}

/** 위험자산(주식형+대체) 비율 % */
export const riskPct = (x: Alloc) => RISK_CLASSES.reduce((s, k) => s + x[k], 0);

/** 자산 한 줄의 위험자산 비율 %: 비율이 있으면 주식형+대체, 없으면 성격으로 0 또는 100 */
export const riskShareOf = (a: Pick<Asset, 'type' | 'nature' | 'alloc'>) => riskPct(allocOf(a));

/** 자산 한 줄의 투자형 금액(평가액 × 위험자산 비율) */
export const investAmountOf = (a: Pick<Asset, 'type' | 'nature' | 'alloc' | 'amount'>) => (a.amount * riskShareOf(a)) / 100;

/** 비율에 맞는 성격: 위험자산이 50% 이상이면 투자형(화면 표시·예전 계산 호환용) */
export const natureOfAlloc = (x: Alloc): Nature => (riskPct(x) >= 50 ? 'invest' : 'safe');

/** 비율로 계산한 기대수익률·변동성(자산군 가정값의 가중평균, 소수 첫째 자리) */
export function allocReturn(x: Alloc, assume = CLASS_DEFAULTS) {
  const r = (v: number) => Math.round(v * 10) / 10;
  return {
    ret: r(ASSET_CLASSES.reduce((s, k) => s + (x[k] / 100) * assume[k].ret, 0)),
    vol: r(ASSET_CLASSES.reduce((s, k) => s + (x[k] / 100) * assume[k].vol, 0)),
  };
}

/** 여러 줄의 자산군별 금액(만원) */
export function classAmounts(rows: Pick<Asset, 'type' | 'nature' | 'alloc' | 'amount'>[]): Alloc {
  const out: Alloc = { equity: 0, bond: 0, alt: 0, cash: 0 };
  for (const a of rows) {
    if (!(a.amount > 0)) continue;
    const x = allocOf(a);
    for (const k of ASSET_CLASSES) out[k] += (a.amount * x[k]) / 100;
  }
  return out;
}

/** 여러 줄을 합친 비율(금액가중, 합계 100). 금액이 없으면 undefined */
export function mixAlloc(rows: Pick<Asset, 'type' | 'nature' | 'alloc' | 'amount'>[]): Alloc | undefined {
  return normalizeAlloc(classAmounts(rows));
}

/**
 * 비율을 넣은 줄에서 위험자산 비율을 delta(%p, + 면 늘림)만큼 바꾼 새 비율(계좌 안 리밸런싱 ‘자산 탭에 반영’).
 * 줄이는 쪽은 지금 비율대로 줄이고, 늘리는 쪽은 prefer(목표 비율) → 지금 비율 → 기본(주식형·채권형) 순으로 나눔.
 */
export function shiftAlloc(x: Alloc, delta: number, prefer?: Alloc): Alloc {
  const risk = riskPct(x);
  const d = Math.max(-risk, Math.min(100 - risk, delta));
  if (Math.abs(d) < 1e-9) return { ...x };
  const toRisk = d > 0;
  const fromKeys = toRisk ? (['bond', 'cash'] as AssetClass[]) : RISK_CLASSES;
  const toKeys = toRisk ? RISK_CLASSES : (['bond', 'cash'] as AssetClass[]);
  const amt = Math.abs(d);
  const out = { ...x };
  const fromSum = fromKeys.reduce((s, k) => s + x[k], 0);
  for (const k of fromKeys) out[k] = x[k] - (fromSum > 0 ? (amt * x[k]) / fromSum : 0);
  const weights = (src?: Alloc) => (src ? toKeys.map((k) => src[k]) : toKeys.map(() => 0));
  let w = weights(prefer);
  if (w.reduce((a, b) => a + b, 0) <= 0) w = weights(x);
  if (w.reduce((a, b) => a + b, 0) <= 0) w = toKeys.map((_, i) => (i === 0 ? 1 : 0));
  const ws = w.reduce((a, b) => a + b, 0);
  toKeys.forEach((k, i) => (out[k] += (amt * w[i]) / ws));
  return normalizeAlloc(out)!;
}

/** 비율을 짧게: ‘주식형 60 · 채권형 30 · 현금성 10’ (0인 칸은 뺌) */
export const allocText = (x: Alloc) =>
  ASSET_CLASSES.filter((k) => x[k] > 0.05)
    .map((k) => `${CLASS_LABEL[k]} ${Math.round(x[k] * 10) / 10}`)
    .join(' · ');

/** 자산군 목표와 지금의 차이(금융자산 전체, 만원): diff + 면 더 담을 금액, − 면 줄일 금액 */
export interface ClassGap {
  key: AssetClass;
  now: number;
  target: number;
  diff: number;
  nowPct: number;
  targetPct: number;
}

/** 금융자산 rows 의 자산군별 지금 금액과 목표 비율(target)에 맞춘 금액 */
export function classGaps(rows: Pick<Asset, 'type' | 'nature' | 'alloc' | 'amount'>[], target: Alloc): ClassGap[] {
  const now = classAmounts(rows);
  const total = ASSET_CLASSES.reduce((s, k) => s + now[k], 0);
  const t = normalizeAlloc(target) ?? target;
  return ASSET_CLASSES.map((k) => {
    const goal = (total * t[k]) / 100;
    return { key: k, now: now[k], target: goal, diff: goal - now[k], nowPct: total > 0 ? (now[k] / total) * 100 : 0, targetPct: t[k] };
  });
}
