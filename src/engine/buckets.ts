import type { Alloc, Asset } from '../types';
import { accountName } from './portfolio';
import { classAmounts, hasAlloc, IRP_RISK_CAP, isCappedAsset, isRiskCappedName } from './allocation';
import { PENSION_OPEN_AGE, type TaxResult } from './tax';
import { won } from '../lib/format';
import { isLocked } from './goals';
import { EMERGENCY_LOCK_MONTHS, maturities, maturityLabel, type MaturityRow } from './maturity';

export { maturityLabel };

export { IRP_RISK_CAP };
/** 하락장 기준: 주식형 지수가 고점보다 이만큼(%) 넘게 떨어지면 주식 매도를 멈춤 */
export const BEAR_DROP = 15;

/** 이름으로 퇴직연금 계좌(IRP·DC·퇴직연금) 여부를 판단: 위험자산 70% 한도 적용(계좌 종류를 고르지 않았을 때) */
export const isRiskCapped = isRiskCappedName;

export interface AccountBucket {
  name: string;
  owner: 'self' | 'spouse';
  balance: number; // 첫해 연초 평가액(명목)
  cash: number; // ① 현금성: 앞 2년 동안 그 계좌에서 빠져나갈 금액
  bond: number; // ② 채권·배당: 3~5년차 인출분(+ 위험자산 한도를 넘는 몫)
  growth: number; // ③ 성장(지수 ETF 등)
  alt: number; // ④ 대체자산(금·리츠 ETF 등)
  capped: boolean; // 위험자산 70% 한도 계좌
  riskShare: number; // 위험자산 비중(③+④) %
  /** 지금 계좌 안 자산군 금액(자산 탭 비율, 첫해 평가액 기준으로 맞춤). 그 계좌 줄에 비율을 하나도 넣지 않았으면 없음 */
  now?: Alloc;
  /** 그 계좌에서 한 해에 빠져나가는 금액(앞 2년 평균, 명목): 하락장에 버틸 햇수 계산용 */
  yearDraw: number;
}

/** 바구니 목표와 지금 배분의 차이: + 면 더 채워야 함, − 면 넘침 */
export const bucketGap = (b: AccountBucket) =>
  b.now ? { cash: b.cash - b.now.cash, bond: b.bond - b.now.bond, growth: b.growth - b.now.equity, alt: b.alt - b.now.alt } : undefined;

/** 하락장에 주식을 팔지 않고 지금 현금성+채권형으로 버틸 수 있는 햇수(그 계좌 한 해 인출 기준). 비율이 없으면 undefined, 인출이 없으면 Infinity */
export function safeYears(b: AccountBucket) {
  if (!b.now) return undefined;
  return b.yearDraw > 0 ? (b.now.cash + b.now.bond) / b.yearDraw : Infinity;
}

/**
 * 엑셀 ‘투자배분’ 시트: 계좌마다 인출이 나가는 그 계좌 안에 현금성 바구니를 둠.
 * ① 현금성 = 앞 2년 인출분, ② 채권·배당 = 3~5년차 인출분, ④ 대체 = 평가액 × altShare(①·②를 채우고 남는 금액 안에서),
 * ③ 성장 = 나머지. 퇴직연금 계좌는 ③+④가 평가액의 70%를 넘지 않게 하고 넘는 몫은 ②로 돌림.
 * 금액은 그 해 금액(명목), 연금 세금 계산(tax)의 계좌별 세전 인출 계획을 씀.
 * partialFirst: 첫 행이 올해 남은 달만 계산한 해면 ‘앞 2년’에 그 다음 2년까지(엑셀처럼 3행), ‘3~5년차’는 그 뒤 3년.
 */
export function accountBuckets(tax: TaxResult, altShare = 0.1, partialFirst = false, assets: Asset[] = []): AccountBucket[] {
  const first = tax.rows[0];
  if (!first) return [];
  const k = partialFirst ? 1 : 0;
  const drawn = (i: number, from: number, to: number) => tax.rows.slice(from, to).reduce((a, r) => a + (r.accounts[i]?.drawn ?? 0), 0);
  return first.accounts.map((a, i) => {
    const balance = a.start;
    const two = drawn(i, 0, 2 + k);
    const cash = Math.min(balance, two);
    const later = Math.min(balance - cash, drawn(i, 2 + k, 5 + k));
    const free = Math.max(0, balance - cash - later);
    const alt = Math.min(Math.max(0, altShare) * balance, free);
    const rows = assets.filter((x) => x.type === 'pension' && accountName(x) === a.name);
    const capped = rows.length ? rows.some(isCappedAsset) : isRiskCapped(a.name);
    const now = nowAlloc(rows, balance);
    const growth = Math.max(0, capped ? Math.min(free - alt, IRP_RISK_CAP * balance - alt) : free - alt);
    const bond = Math.max(0, balance - cash - growth - alt);
    return { name: a.name, owner: a.owner, balance, cash, bond, growth, alt, capped, riskShare: balance > 0 ? ((growth + alt) / balance) * 100 : 0, yearDraw: drawn(i, k, 2 + k) / 2, ...(now ? { now } : {}) };
  });
}

/** 계좌 줄들의 지금 자산군 금액을 balance(첫해 평가액)에 맞춰 늘리거나 줄임. 비율을 넣은 줄이 없으면 undefined */
function nowAlloc(rows: Asset[], balance: number): Alloc | undefined {
  if (!rows.some(hasAlloc)) return undefined;
  const amt = classAmounts(rows);
  const total = amt.equity + amt.bond + amt.alt + amt.cash;
  if (!(total > 0)) return undefined;
  const k = balance / total;
  return { equity: amt.equity * k, bond: amt.bond * k, alt: amt.alt * k, cash: amt.cash * k };
}

export type MarketState = 'bear' | 'peak' | 'normal';

/** 주식형 지수의 고점 대비 등락률(%, 음수 = 하락)로 시장 상태 판단 */
export const marketState = (drawdown: number): MarketState => (drawdown <= -BEAR_DROP ? 'bear' : drawdown >= 0 ? 'peak' : 'normal');

/** 등락률 칸 설명: 어떤 값이 어느 규칙이 되고 무엇에 쓰이는지 */
export const MARKET_INPUT_HELP = `시세를 자동으로 가져오지 않아 직접 넣는 값입니다. 쓰는 주식형 지수(예: 코스피·S&P500)가 그동안의 최고점보다 몇 % 아래인지 넣으면 0% 이상은 고점 부근, 0%와 −${BEAR_DROP}% 사이는 보통, −${BEAR_DROP}% 이하는 하락장으로 보고 ‘지금 적용할 규칙’을 바꿉니다. 하락장이면 지금 가진 현금성으로 버틸 햇수도 함께 보여 줍니다. 바구니 목표 금액·노후 진단·인출 스케줄 계산에는 쓰지 않습니다.`;

/** 등락률을 넣고 이만큼(일) 지나면 다시 넣으라고 안내 */
export const MARKET_STALE_DAYS = 30;

/** 날짜를 YYYY-MM-DD(현지 날짜)로 */
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * 등락률 입력 날짜 안내: ‘11월 17일 기준’, 30일이 지났으면 다시 넣으라는 문장을 덧붙이고 stale=true.
 * 날짜가 없거나 잘못됐으면 undefined
 */
export function marketDateNote(date: string | undefined, now: Date): { text: string; label: string; stale: boolean; days: number } | undefined {
  const m = date ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  if (!m) return undefined;
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((today.getTime() - at.getTime()) / 86400000);
  const stale = days > MARKET_STALE_DAYS;
  const label = `${at.getFullYear() !== now.getFullYear() ? `${at.getFullYear()}년 ` : ''}${at.getMonth() + 1}월 ${at.getDate()}일 기준`;
  return { text: stale ? `${label} — ${days}일이 지났으니 지금 지수로 다시 넣어 주세요.` : label, label, stale, days };
}

/** 시장 상태 이름(요약 보고 문장용) */
export const MARKET_STATE_LABEL: Record<MarketState, string> = { bear: '하락장', peak: '고점 부근', normal: '보통' };

/** 시장 상태별 지금 적용할 규칙(엑셀 ‘투자배분’ 시트) */
export function marketRule(drawdown: number) {
  const state = marketState(drawdown);
  if (state === 'bear') return { state, text: `하락장(고점 대비 ${drawdown}%): 주식형 매도를 멈추고 현금성 바구니에서만 인출, 리밸런싱 보류. 금 ETF가 올랐다면 그 일부로 현금성을 채웁니다.` };
  if (state === 'peak') return { state, text: '고점 부근: 주식형 일부를 팔아 현금성 바구니를 목표(약 2년치)까지 채웁니다.' };
  return { state, text: `보통(고점 대비 ${drawdown}%): 계획대로 인출하고 1년에 한 번(1월) 리밸런싱합니다.` };
}

/** 연금계좌 밖 현금성으로 보는 유형: 현금·입출금, 예금, 적금 */
export const CASH_TYPES: Asset['type'][] = ['cash', 'deposit', 'savings'];

export interface CashOnHand {
  total: number; // 연금계좌 밖 현금성 합계(수령 전 묶인 자산 제외)
  usable: number; // 바로 쓸 수 있는 돈: 현금·만기 없는 예금·적금·만기가 3개월 안에 오거나 지난 예금·적금
  locked: number; // 만기가 3개월 넘게 남은 예금·적금(깨면 중도해지 이율)
  lockedRows: MaturityRow[];
  /** 함께 센 연금계좌 안 현금성(withPensionCash): usable·total 에 이미 들어 있음 */
  pension?: number;
  /** 옵션은 예지만 인출 시작 나이가 55세 전이라 빼 둔 연금계좌 안 현금성(usable·total 에 없음) */
  pensionOut?: number;
  /** pensionOut 을 계좌 주인별로: 55세 이정표 메모에 씀 */
  pensionOutParts?: PensionCashParts;
}

/** 연금계좌 안 현금성을 계좌 주인(명의)별로 */
export interface PensionCashParts { self: number; spouse: number }

/**
 * 인출 바구니 ① 현금성 가운데 연금계좌 밖 현금·예금·적금을 ‘바로 쓸 수 있는 돈’과 ‘만기 전 예금·적금’으로 나눔.
 * 만기 연월을 넣은 예금·적금 중 만기가 EMERGENCY_LOCK_MONTHS(3개월)보다 더 남은 것만 묶인 돈으로 봄(비상금 점검과 같은 기준)
 */
export function cashOnHand(assets: Asset[], nowYear: number, nowMonth = 1): CashOnHand {
  const rows = assets.filter((a) => CASH_TYPES.includes(a.type) && a.amount > 0 && !isLocked(a, nowYear));
  const total = rows.reduce((s, a) => s + a.amount, 0);
  const lockedRows = maturities(rows, nowYear, nowMonth).filter((r) => r.monthsLeft > EMERGENCY_LOCK_MONTHS);
  const locked = lockedRows.reduce((s, r) => s + r.amount, 0);
  return { total, usable: total - locked, locked, lockedRows };
}

/**
 * 연금계좌 안 현금성: 인출 바구니(accountBuckets)의 now.cash 와 같은 기준(계좌 안 자산배분 비율을 하나라도 넣은 연금계좌만, 같은 계좌로 묶인 줄은 함께).
 * 인출 바구니는 첫해 평가액에 맞춰 늘리지만 여기서는 연금계좌 밖 현금성과 같게 지금 평가액 기준
 */
export function pensionCash(assets: Asset[]): number {
  const p = pensionCashParts(assets, true);
  return p.self + p.spouse;
}

/** pensionCash 를 계좌 주인별로 나눔: 명의가 배우자이고 배우자가 있으면 배우자, 아니면 본인(같은 계좌로 묶인 줄은 명의가 같음) */
export function pensionCashParts(assets: Asset[], hasSpouse: boolean): PensionCashParts {
  const rows = assets.filter((a) => a.type === 'pension' && a.amount > 0);
  const names = [...new Set(rows.map(accountName))];
  const out: PensionCashParts = { self: 0, spouse: 0 };
  for (const n of names) {
    const acct = rows.filter((a) => accountName(a) === n);
    if (!acct.some(hasAlloc)) continue;
    out[acct[0].owner === 'spouse' && hasSpouse ? 'spouse' : 'self'] += classAmounts(acct).cash;
  }
  return out;
}

/**
 * 연금계좌 안 현금성을 바로 쓸 수 있는 돈에 더함(만기가 없어 바로 꺼낼 수 있는 돈으로 봄).
 * 계좌 주인별로 인출 시작 해의 그 사람 나이(ages)가 55세(PENSION_OPEN_AGE) 전이면 연금계좌에서 꺼내기 어려워 더하지 않고 pensionOut 에만 적어 둠.
 * pension 이 숫자면 본인 몫, ages 가 숫자면 두 사람 모두 그 나이로 봄. 나이가 없으면 제외하지 않음
 */
export function withPensionCash(c: CashOnHand, pension: number | PensionCashParts, ages?: number | { self: number; spouse?: number }): CashOnHand {
  const p = typeof pension === 'number' ? { self: pension, spouse: 0 } : pension;
  const a = typeof ages === 'number' ? { self: ages, spouse: ages } : ages;
  const young = (age?: number) => age !== undefined && age < PENSION_OPEN_AGE;
  const outParts = { self: young(a?.self) ? p.self : 0, spouse: young(a?.spouse) ? p.spouse : 0 };
  const add = p.self + p.spouse - outParts.self - outParts.spouse;
  const out = outParts.self + outParts.spouse;
  let r = c;
  if (add > 0.5) r = { ...r, total: r.total + add, usable: r.usable + add, pension: add };
  if (out > 0.5) r = { ...r, pensionOut: out, pensionOutParts: outParts };
  return r;
}

/** 55세 전이라 뺀 연금계좌 안 현금성 안내(앞에 띄어쓰기 포함). 뺀 금액이 없으면 빈 문자열 */
export function pensionOutNote(c: Pick<CashOnHand, 'pensionOut' | 'pensionOutParts'>): string {
  return outNote('현금성', c.pensionOut, c.pensionOutParts);
}

/** 55세 전이라 뺀 연금계좌 안 자산(현금성·채권형) 안내: 배우자 몫만이면 ‘배우자 연금계좌’, 두 사람 몫이면 본인·배우자 금액을 함께 */
function outNote(kind: string, out?: number, p?: PensionCashParts): string {
  if (!out || !(out > 0.5)) return '';
  const who = p && p.spouse > 0.5
    ? p.self > 0.5 ? `연금계좌 안 ${kind} ${won(out)}(본인 ${won(p.self)}, 배우자 ${won(p.spouse)})` : `배우자 연금계좌 안 ${kind} ${won(out)}`
    : `연금계좌 안 ${kind} ${won(out)}`;
  return ` ${who}은 ${PENSION_OPEN_AGE}세 전에는 연금계좌에서 꺼내기 어려워 제외했습니다.`;
}

/** 계좌 주인별 연금계좌 안 자산군(채권형·주식형) 금액: 투자 점검 자산군 구성과 같은 기준(자산 탭 비율, 비율이 없으면 유형·성격 기본 분류) */
export function pensionClassParts(assets: Asset[], hasSpouse: boolean, key: 'bond' | 'equity'): PensionCashParts {
  const out: PensionCashParts = { self: 0, spouse: 0 };
  for (const a of assets.filter((x) => x.type === 'pension' && x.amount > 0)) out[a.owner === 'spouse' && hasSpouse ? 'spouse' : 'self'] += classAmounts([a])[key];
  return out;
}

/** 계좌 주인별 연금계좌 안 채권형 금액 */
export const pensionBondParts = (assets: Asset[], hasSpouse: boolean) => pensionClassParts(assets, hasSpouse, 'bond');

/** 하락장에 꺼낼 수 있는 채권형: total(금융자산 안 채권형 합계)에서 인출 시작 해에 55세 전인 계좌 주인의 연금계좌 안 채권형을 뺀 금액 */
export interface BondsOnHand {
  total: number;
  usable: number;
  out: number;
  outParts: PensionCashParts;
}

/** 채권형 합계에서 55세 전 연금계좌 안 채권형을 뺌(ages 는 startAges, 나이가 없으면 빼지 않음) */
export function bondsOnHand(total: number, pension: PensionCashParts, ages?: { self: number; spouse?: number }): BondsOnHand {
  const young = (age?: number) => age !== undefined && age < PENSION_OPEN_AGE;
  const outParts = { self: young(ages?.self) ? pension.self : 0, spouse: young(ages?.spouse) ? pension.spouse : 0 };
  const out = Math.min(Math.max(0, total), outParts.self + outParts.spouse);
  return { total, usable: Math.max(0, total - out), out, outParts };
}

/** 하락장에 2년치 현금성까지 모자란 금액과 채권형에서 먼저 꺼낼 금액(맞춤 처방·이정표 할 일 공통) */
export interface BearPlan {
  goal: number; // 첫해 인출 기준 2년치
  usable: number; // 바로 쓸 돈
  short: number; // 2년치까지 모자란 금액
  bond: number; // 꺼낼 수 있는 채권형(55세 전 연금계좌 안 채권형 뺌)
  fromBond: number; // 채권형에서 먼저 꺼낼 금액
  left: number; // 채권형을 다 꺼내도 모자란 금액
  out: number; // 55세 전이라 뺀 연금계좌 안 채권형
  outParts: PensionCashParts;
  fill?: SaveFill; // 보통 구간: 채권형을 다 옮겨도 모자라 저축으로 채울 금액과 지금 월 저축여력으로 걸리는 개월
  cut?: BearCut; // 채권형을 다 꺼내도 모자랄 때 점검기준 하락장 생활비 감축률로 한 해에 줄일 인출
}

/** 하락장 인출 줄이기: 점검기준 ‘하락장 생활비 감축’ 비율(pct, %)과 그 비율로 첫해 한 해에 줄일 인출(amount, montecarlo.ts guardCut) */
export interface BearCut { pct: number; amount: number; real?: number /* 은퇴 전이면 amount 의 현재가치 */ }

/**
 * 하락장 인출 계획: 등락률이 −15% 이하이고 바로 쓸 돈이 첫해 인출(yearDraw) 기준 2년치에 못 미치면 모자란 금액을 채권형에서 먼저 꺼냄.
 * bonds 가 숫자면 모두 꺼낼 수 있다고 봄. 하락장이 아니거나 인출이 없거나 2년치가 있으면 null.
 * cut 을 넘기면 채권형을 다 꺼내도 모자랄 때(또는 꺼낼 채권형이 없을 때) 한 해에 줄일 인출을 함께 담음(감축률·금액이 0이면 담지 않음)
 */
export function bearPlan(drawdown: number | undefined, usable: number, yearDraw: number, bonds: number | BondsOnHand, cut?: BearCut | null): BearPlan | null {
  if (marketState(drawdown ?? 0) !== 'bear' || !(yearDraw > 0)) return null;
  const goal = yearDraw * CASH_YEARS_TARGET;
  const have = Math.max(0, usable);
  if (have >= goal) return null;
  const b = typeof bonds === 'number' ? { usable: bonds, out: 0, outParts: { self: 0, spouse: 0 } } : bonds;
  const short = goal - have;
  const bond = Math.max(0, b.usable);
  const fromBond = Math.min(short, bond);
  const left = short - fromBond;
  const plan: BearPlan = { goal, usable: have, short, bond, fromBond, left, out: b.out, outParts: b.outParts };
  if (cut && cut.pct > 0 && cut.amount > 0.5 && (left > 0.5 || fromBond <= 0.5)) plan.cut = cut;
  return plan;
}

/**
 * 하락장 인출 줄이기 금액 안내(이정표·홈 점검·맞춤 처방·인출 바구니·요약 보고 공통): ‘생활비 ○% 감축 시 한 해 ○원’(은퇴 전이면 뒤에 ‘(현재가치 ○원)’).
 * 줄일 금액이 없으면 빈 문자열. f 로 금액 표기를 바꿈(이정표는 만원 단위)
 */
export const bearCutText = (b: Pick<BearPlan, 'cut'>, f: (v: number) => string = won) =>
  b.cut ? `생활비 ${b.cut.pct}% 감축 시 한 해 ${f(b.cut.amount)}${b.cut.real !== undefined ? `(현재가치 ${f(b.cut.real)})` : ''}` : '';

/**
 * 보통 구간 현금성 채우기: 등락률이 0%와 −15% 사이(보통)이고 바로 쓸 돈이 첫해 인출(yearDraw) 기준 2년치에 못 미치면,
 * 1월 리밸런싱 때 모자란 금액을 채권형에서 현금성 바구니로 옮김(bearPlan 과 같은 계산, 55세 전 연금계좌 안 채권형 뺌).
 * 오늘(now)이 1월이면 올해 1월 리밸런싱, 2월부터는 내년 1월 리밸런싱으로 봄(when·nextYear).
 * monthly(지금 월 저축여력, 만원)를 넘기면 채권형으로도 모자라 저축으로 채울 금액(left)에 걸리는 개월(fill)을 담음.
 * 등락률을 넣지 않았거나 보통이 아니거나 인출이 없거나 2년치가 있으면 null
 */
export function normalPlan(drawdown: number | undefined, usable: number, yearDraw: number, bonds: number | BondsOnHand, now: Date, monthly?: number): NormalPlan | null {
  const b = normalBase(drawdown, usable, yearDraw, bonds);
  if (!b) return null;
  const fill = saveFill(b.left, monthly);
  return { ...b, ...rebalanceTiming(now), ...(fill ? { fill } : {}) };
}

/** 저축으로 채울 금액(amount)을 지금 월 저축여력(monthly, 만원)으로 채우는 데 걸리는 개월(저축여력이 없으면 months 가 null) */
export interface SaveFill { amount: number; monthly: number; months: number | null }

/** 고점 부근·보통 구간 저축으로 채울 기간. monthly 를 넘기지 않았거나 저축으로 채울 금액이 없으면 undefined */
export function saveFill(amount: number, monthly?: number): SaveFill | undefined {
  if (monthly === undefined || !Number.isFinite(monthly) || !(amount > 0.5)) return undefined;
  const m = Math.max(0, monthly);
  return { amount, monthly: m, months: m > 0.5 ? Math.ceil(amount / m) : null };
}

/**
 * 저축으로 채울 기간 안내(이정표·홈 점검·맞춤 처방·인출 바구니·요약 보고 공통): ‘월 저축여력 ○원 기준 약 ○개월’,
 * 저축여력이 없으면 ‘지금 월 저축여력이 없어 지출부터 줄여야 함’. 기간이 없으면 빈 문자열. f 로 금액 표기를 바꿈(이정표는 만원 단위)
 */
export const saveFillText = (b: { fill?: SaveFill }, f: (v: number) => string = won) =>
  !b.fill ? '' : b.fill.months !== null ? `월 저축여력 ${f(b.fill.monthly)} 기준 약 ${b.fill.months}개월` : '지금 월 저축여력이 없어 지출부터 줄여야 함';

/** saveFillText 를 괄호로 감싼 것(기간이 없으면 빈 문자열) */
export const saveFillNote = (b: { fill?: SaveFill }, f: (v: number) => string = won) => b.fill ? `(${saveFillText(b, f)})` : '';

/** 보통 구간 현금성 채우기 계획: bearPlan 과 같은 금액 + 다음 1월 리밸런싱 시점 */
export interface NormalPlan extends BearPlan {
  nextYear: boolean; // 2월 이후라 다음 1월 리밸런싱이 내년(이정표는 내년 할 일에)
  when: string; // ‘1월 리밸런싱’ 또는 ‘내년 1월 리밸런싱(○○○○년 1월)’
}

/** 다음 1월 리밸런싱 시점: 1월이면 올해 1월, 2월부터는 내년 1월 */
export function rebalanceTiming(now: Date): Pick<NormalPlan, 'nextYear' | 'when'> {
  const nextYear = now.getMonth() > 0;
  return { nextYear, when: nextYear ? `내년 1월 리밸런싱(${now.getFullYear() + 1}년 1월)` : '1월 리밸런싱' };
}

function normalBase(drawdown: number | undefined, usable: number, yearDraw: number, bonds: number | BondsOnHand): BearPlan | null {
  if (drawdown === undefined || marketState(drawdown) !== 'normal' || !(yearDraw > 0)) return null;
  const goal = yearDraw * CASH_YEARS_TARGET;
  const have = Math.max(0, usable);
  if (have >= goal) return null;
  const b = typeof bonds === 'number' ? { usable: bonds, out: 0, outParts: { self: 0, spouse: 0 } } : bonds;
  const short = goal - have;
  const bond = Math.max(0, b.usable);
  const fromBond = Math.min(short, bond);
  return { goal, usable: have, short, bond, fromBond, left: short - fromBond, out: b.out, outParts: b.outParts };
}

/**
 * 바로 쓸 돈이 첫해 인출 기준 2년치에 못 미치는 금액 문장(홈 점검·맞춤 처방·요약 보고 공통, 하락장·고점 부근·보통 구간).
 * yearDraw 를 넘기면 ‘바로 쓸 돈 ○원은 첫해 인출(연 ○원) 기준 약 ○년치로 2년치(○원)에 ○원 모자랍니다.’
 * (바로 쓸 돈이 없으면 ‘바로 쓸 현금성이 없어 … 2년치(○원)가 모두 모자랍니다.’),
 * 넘기지 않으면 요약 보고 문장 앞부분 ‘바로 쓸 돈 ○원이 첫해 인출 기준 2년치(○원)에 ○원 모자라니’
 */
export function cashShortText(b: Pick<BearPlan, 'usable' | 'goal' | 'short'>, yearDraw?: number): string {
  if (yearDraw === undefined) return `바로 쓸 돈 ${won(b.usable)}이 첫해 인출 기준 ${CASH_YEARS_TARGET}년치(${won(b.goal)})에 ${won(b.short)} 모자라니`;
  return b.usable > 0.5
    ? `바로 쓸 돈 ${won(b.usable)}은 첫해 인출(연 ${won(yearDraw)}) 기준 약 ${(b.usable / yearDraw).toFixed(1)}년치로 ${CASH_YEARS_TARGET}년치(${won(b.goal)})에 ${won(b.short)} 모자랍니다.`
    : `바로 쓸 현금성이 없어 첫해 인출(연 ${won(yearDraw)}) 기준 ${CASH_YEARS_TARGET}년치(${won(b.goal)})가 모두 모자랍니다.`;
}

/** 55세 전이라 뺀 연금계좌 안 채권형 안내(뺀 금액이 없으면 빈 문자열) */
export const pensionBondOutNote = (b: Pick<BondsOnHand, 'out' | 'outParts'>) => outNote('채권형', b.out, b.outParts);

/** 고점 부근에 주식형을 팔아 2년치 현금성까지 채울 금액(맞춤 처방·이정표 할 일·인출 바구니 공통) */
export interface PeakPlan {
  goal: number; // 첫해 인출 기준 2년치
  usable: number; // 바로 쓸 돈
  short: number; // 2년치까지 모자란 금액
  equity: number; // 팔 수 있는 주식형(55세 전 연금계좌 안 주식형 뺌)
  fromEquity: number; // 주식형을 팔아 채울 금액
  left: number; // 주식형을 다 팔아도 모자란 금액(저축으로)
  fill?: SaveFill; // 저축으로 채울 금액(left)과 지금 월 저축여력으로 걸리는 개월
  out: number; // 55세 전이라 뺀 연금계좌 안 주식형
  outParts: PensionCashParts;
}

/**
 * 고점 부근 현금성 채우기: 등락률이 0% 이상(고점 부근)이고 바로 쓸 돈이 첫해 인출(yearDraw) 기준 2년치에 못 미치면 모자란 금액을 주식형 일부를 팔아 채움.
 * equity 는 bondsOnHand 와 같은 방식(주식형 합계에서 55세 전 연금계좌 안 주식형을 뺌), 숫자면 모두 팔 수 있다고 봄.
 * 고점 부근이 아니거나 인출이 없거나 2년치가 있으면 null
 */
export function peakPlan(drawdown: number | undefined, usable: number, yearDraw: number, equity: number | BondsOnHand, monthly?: number): PeakPlan | null {
  if (drawdown === undefined || marketState(drawdown) !== 'peak' || !(yearDraw > 0)) return null;
  const goal = yearDraw * CASH_YEARS_TARGET;
  const have = Math.max(0, usable);
  if (have >= goal) return null;
  const e = typeof equity === 'number' ? { usable: equity, out: 0, outParts: { self: 0, spouse: 0 } } : equity;
  const short = goal - have;
  const sell = Math.max(0, e.usable);
  const fromEquity = Math.min(short, sell);
  const left = short - fromEquity;
  const fill = saveFill(left, monthly);
  return { goal, usable: have, short, equity: sell, fromEquity, left, out: e.out, outParts: e.outParts, ...(fill ? { fill } : {}) };
}

/** 55세 전이라 뺀 연금계좌 안 주식형 안내(뺀 금액이 없으면 빈 문자열) */
export const pensionEquityOutNote = (b: Pick<PeakPlan, 'out' | 'outParts'>) => outNote('주식형', b.out, b.outParts);

/** 인출 시작 해 그 사람 나이(본인은 start.age, 배우자는 나이 차를 빼서) */
export const startAges = (startAge: number, birthYear: number, spouseBirthYear: number) =>
  ({ self: startAge, ...(spouseBirthYear > 0 ? { spouse: startAge + birthYear - spouseBirthYear } : {}) });

export interface PensionFrom55 { who: '본인' | '배우자'; year: number; amount: number }

/** 55세 전이라 뺀 연금계좌 안 현금성(pensionOutParts)을 사람별로, 그 사람이 만 55세가 되는 해(출생연도 + PENSION_OPEN_AGE)와 함께 */
export function pensionFrom55(c: Pick<CashOnHand, 'pensionOutParts'>, birthYear: number, spouseBirthYear: number): PensionFrom55[] {
  const p = c.pensionOutParts;
  if (!p) return [];
  return [
    ...(p.self > 0.5 ? [{ who: '본인' as const, year: birthYear + PENSION_OPEN_AGE, amount: p.self }] : []),
    ...(p.spouse > 0.5 && spouseBirthYear > 0 ? [{ who: '배우자' as const, year: spouseBirthYear + PENSION_OPEN_AGE, amount: p.spouse }] : []),
  ];
}

/** 55세 이후 다시 세는 안내(앞에 띄어쓰기 포함): ‘본인 만 55세가 되는 ○년부터 ○원도 버틸 햇수에 셉니다.’ 없으면 빈 문자열 */
export function pensionFrom55Note(rows: PensionFrom55[]): string {
  if (!rows.length) return '';
  return ` ${rows.map((r) => `${r.who} 만 ${PENSION_OPEN_AGE}세가 되는 ${r.year}년부터 ${won(r.amount)}`).join(', ')}도 버틸 햇수에 셉니다.`;
}

/** 하락장에 주식을 팔지 않고 버티려면 바로 쓸 돈으로 이만큼(년치) 이상 권장: 인출 바구니 ① 현금성(앞 2년 인출분)과 같은 기준 */
export const CASH_YEARS_TARGET = 2;
/** 은퇴 전이면 은퇴가 이 햇수 안으로 다가왔을 때만 버틸 햇수를 점검·처방(그 전에는 모아 가는 중이라 생략) */
export const CASH_CHECK_LEAD = 5;

/**
 * 홈 점검·맞춤 처방용 버틸 햇수: 첫해 인출(st.outflow, 은퇴 전이면 은퇴 첫해) 기준.
 * 연금계좌 밖 현금성이 없거나, 인출이 없거나, 은퇴가 CASH_CHECK_LEAD 년보다 더 남았으면 undefined
 */
export function cashRunway(c: CashOnHand, st: { age: number; retired: boolean; outflow: number }, currentAge: number) {
  if (!(c.total > 0.5)) return undefined;
  if (!st.retired && st.age - currentAge > CASH_CHECK_LEAD) return undefined;
  const y = cashYears(c, st.outflow);
  return y ? { ...y, yearDraw: st.outflow, retired: st.retired } : undefined;
}

/** 버틸 햇수에 센 현금성 이름: 점검기준 ‘버틸 햇수에 연금계좌 안 현금성’이 예라 연금계좌 안 현금성을 더했으면 함께 적음 */
export const cashSourceLabel = (c: Pick<CashOnHand, 'pension'>) => (c.pension ? '연금계좌 밖 현금성 + 연금계좌 안 현금성' : '연금계좌 밖 현금성');

/** 버틸 햇수가 2년치에 못 미칠 때 만기 뒤 현금성 바구니로 옮길 예금·적금(만기가 3개월 넘게 남은 것): 처방·이정표 할 일에 씀 */
export function cashMoveRows(c: CashOnHand, run?: { usable: number }): MaturityRow[] {
  return run && run.usable < CASH_YEARS_TARGET && c.locked > 0.5 ? c.lockedRows : [];
}

/** 하락장에 연금계좌 밖 현금성으로 버틸 햇수(한 해 인출 yearDraw 기준): 바로 쓸 돈만, 만기 전 예금·적금까지 깰 때. 인출이 없으면 undefined */
export function cashYears(c: CashOnHand, yearDraw: number) {
  if (!(yearDraw > 0)) return undefined;
  return { usable: c.usable / yearDraw, all: c.total / yearDraw };
}
