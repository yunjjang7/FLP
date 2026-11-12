import type { Asset, Profile } from '../types';
import { isLocked } from './goals';
import { contribSchedule, incomeTaxSchedule, type ContribYear } from './incomeTax';
import { isFinancial } from './portfolio';
import type { ScheduleRow } from './withdrawal';

/** 사적연금 분리과세 한도: 1인당 연 1,500만원(세전, 명목) */
export const PENSION_SLOT = 1500;
/** 한도 초과분 분리과세 세율(%) — 종합과세를 고르면 달라질 수 있음 */
export const OVER_RATE = 16.5;
/** 연금계좌 인출이 가능한 나이 */
export const PENSION_OPEN_AGE = 55;

/** 연금소득세율(지방세 포함, %): 70세 미만 5.5 · 70~79세 4.4 · 80세 이상 3.3 */
export const pensionTaxRate = (age: number) => (age >= 80 ? 3.3 : age >= 70 ? 4.4 : 5.5);

/** 퇴직금 재원 연금 수령 세율(%): 퇴직소득세 × 70%(실수령 1~10년차) · 60%(11년차~). 해마다 꺼낸다고 볼 때의 연도 기준 */
export const retireTaxRate = (base: number, year: number, year1: number) => retireRateAt(base, year - year1 + 1);

/** 퇴직금 재원 연금 수령 세율(%): 실수령연차 no(실제로 꺼낸 해만 셈) 기준 */
export const retireRateAt = (base: number, no: number) => base * (no > 10 ? 0.6 : 0.7);

/** 연금수령연차: 기산연도가 1년차. 1보다 작으면 아직 연금수령 불가 */
export const pensionYearNo = (year: number, year1: number) => year - year1 + 1;

/**
 * 연금수령한도 = 연초 평가액 ÷ (11 − 연금수령연차) × 120%. 11년차부터는 한도 없음(Infinity), 1년차 전에는 0.
 * 한도 안에서 꺼내야 ‘연금수령’(연금소득세·퇴직소득세 감면)이 되고, 넘는 금액은 연금외수령으로 과세.
 */
export function pensionLimit(balance: number, yearNo: number) {
  if (yearNo < 1) return 0;
  if (yearNo >= 11) return Infinity;
  return (Math.max(0, balance) / (11 - yearNo)) * 1.2;
}

type Owner = 'self' | 'spouse';
type Part = 'free' | 'taxed' | 'retire';

/**
 * 계좌별 재원(실질). 한 계좌 안에서는 법정 순서(소득세법 시행령 40조의3)대로만 빠짐:
 * 과세제외 → 퇴직금 재원(이연퇴직소득) → 과세재원(세액공제분 + 운용수익)
 */
interface AccountPot { name: string; owner: Owner; free: number; taxed: number; retire: number; year1: number; drawStart: number }

export interface TaxSetup {
  accounts: AccountPot[];
  other: number; // 연금계좌 밖 자산(ISA·일반·예금 등, 비과세로 봄)
  birthYear: number;
  spouseGap: number; // 배우자 나이 = 본인 나이 − spouseGap
  nowYear: number;
  inflation: number;
  realReturn: number; // 결정론적 실질 수익률(소수)
  retireBase: number; // 퇴직소득세 실효세율(감면 전, %)
  retireYear1: number;
  retireMinDraw: number; // 퇴직금 재원이 있는 계좌에서 해마다 꼭 꺼내는 최소 금액(세전, 명목 만원, 0 = 안 함)
  slotFillFrom: number; // 1,500만 한도 꽉 채우기 시작 연도(Infinity = 안 함)
  contrib: ContribYear[]; // 추가 납입(세액공제)
}

/**
 * 현재 자산을 계좌·세금 재원별로 나눔(인출 시작 자산 startBalance 에 비례해 맞춤).
 * 과세제외·퇴직금 재원은 명목 금액이 그대로라(운용수익은 모두 과세재원), 인출 시작(startYear)이 뒤면 그때까지 물가만큼 실질 금액이 줄어듦.
 */
export function taxSetup(profile: Profile, assets: Asset[], nowYear: number, startBalance: number, meanReturn: number, startYear = nowYear): TaxSetup | null {
  const liquid = assets.filter((a) => isFinancial(a) && !isLocked(a, nowYear));
  const pension = liquid.filter((a) => a.type === 'pension');
  if (pension.length === 0) return null;
  const total = liquid.reduce((a, x) => a + x.amount, 0);
  const k = total > 0 ? startBalance / total : 1;
  const wait = Math.pow(1 + profile.inflation / 100, Math.max(0, startYear - nowYear));
  const spouseBirth = profile.spouseBirthYear > 0 ? profile.spouseBirthYear : profile.birthYear;
  // 같은 사람 계좌는 ‘꺼내는 순서’대로(0이면 입력 순서)
  const sorted = pension.map((a, i) => ({ a, key: (a.drawOrder ?? 0) > 0 ? a.drawOrder! : 1000 + i })).sort((x, y) => x.key - y.key).map((x) => x.a);
  const accounts: AccountPot[] = sorted.map((a) => {
    const owner = a.owner === 'spouse' ? 'spouse' : 'self';
    const amount = a.amount * k;
    const freeNow = Math.min(a.amount, Math.max(0, a.taxFree ?? 0));
    const retireNow = Math.min(Math.max(0, a.amount - freeNow), Math.max(0, a.retirePart ?? 0));
    // 지금 바로 시작하면 자산 비율(k)대로, 나중에 시작하면 명목 금액 그대로(물가만큼 실질 감소)
    const free = Math.min(amount, startYear > nowYear ? freeNow / wait : freeNow * k);
    const retire = Math.min(Math.max(0, amount - free), startYear > nowYear ? retireNow / wait : retireNow * k);
    const year1 = a.pensionYear1 || (owner === 'spouse' ? spouseBirth : profile.birthYear) + PENSION_OPEN_AGE;
    return { name: a.name, owner, free, retire, taxed: Math.max(0, amount - free - retire), year1, drawStart: a.drawStartYear || 0 };
  });
  const other = liquid.filter((a) => a.type !== 'pension').reduce((s, a) => s + a.amount, 0) * k;
  return {
    accounts,
    other,
    birthYear: profile.birthYear,
    spouseGap: profile.spouseBirthYear > 0 ? profile.spouseBirthYear - profile.birthYear : 0,
    nowYear,
    inflation: profile.inflation,
    realReturn: (1 + meanReturn / 100) / (1 + profile.inflation / 100) - 1,
    retireBase: profile.retireTaxRate ?? 0,
    retireYear1: profile.retireTaxYear1 || nowYear,
    retireMinDraw: Math.max(0, profile.retireMinDraw ?? 0),
    slotFillFrom: profile.slotFill ? Math.max(nowYear, profile.slotFillFrom || nowYear) : Infinity,
    contrib: contribSchedule(profile, incomeTaxSchedule(profile, nowYear, undefined, assets)),
  };
}

/** 계좌별 그해 연금수령한도와 인출액(명목) */
export interface AccountYear {
  name: string;
  owner: Owner;
  yearNo: number; // 연금수령연차(1 미만이면 아직 수령 불가)
  limit: number; // 연금수령한도(명목, Infinity = 한도 없음)
  start: number; // 연초 평가액(명목)
  drawn: number; // 세전 인출액(명목)
  tax: number; // 그 인출에 붙는 세금(명목)
  over: number; // 한도를 넘어 연금외수령으로 꺼낸 금액(명목)
  freeLeft: number; // 인출 뒤 남은 과세제외 금액(명목)
  retireLeft: number; // 인출 뒤 남은 퇴직금 재원(명목)
}

export interface TaxRow {
  age: number;
  year: number;
  net: number; // 생활비로 쓰는 인출액(세후, 실질)
  gross: number; // 세전 인출액(실질)
  tax: number; // 세금(실질)
  slot: Record<Owner, number>; // 1,500만 한도 사용액(세전, 명목)
  over: Record<Owner, number>; // 1,500만 한도 초과 인출액(세전, 명목)
  idle: Record<Owner, number>; // 한도가 남았는데 인출 시작 연도 전인 계좌에 과세재원이 묶여 못 쓴 금액(세전, 명목)
  accounts: AccountYear[];
  limitOver: number; // 연금수령한도를 넘는 인출액 합계(명목)
  reinvest: number; // 1,500만 한도 채우기·퇴직금 최소 인출로 생활비보다 더 꺼내 ISA·일반계좌로 옮긴 세후 금액(실질)
  contrib: number; // 연금계좌 추가 납입액(실질)
  otherDrawn: number; // 연금계좌 밖 자산(ISA·일반 등)에서 생활비로 꺼낸 금액(명목)
  isa: number; // 연말 연금계좌 밖 자산(ISA·일반 등, 실질)
  retireNo: number; // 퇴직금 연금 실수령연차(실제로 꺼낸 해만 셈): 11년차부터 감면 40%
  short: number; // 세금 때문에 모자란 금액(실질)
  left: number; // 세금을 반영한 연말 잔액(실질)
}

/** 연금수령한도를 넘는 계좌 경고 */
export interface LimitWarning { name: string; owner: Owner; years: number[]; maxOver: number }

export interface TaxResult {
  rows: TaxRow[];
  totalTax: number; // 세금 합계(실질, 현재 물가 기준)
  overYears: number[]; // 1,500만 한도를 넘는 해(연도)
  limitWarnings: LimitWarning[]; // 계좌별 연금수령한도 초과
  depletedAge: number | null; // 세금을 반영하면 자산이 바닥나는 나이
}

const EPS = 1e-9;

/**
 * 인출 스케줄(세후 필요액)에 연금 세금을 입혀 세전 인출액을 계산(엑셀 ‘연간계획’ 엔진과 같은 순서).
 * 한 계좌 안에서는 법정 순서(과세제외 → 퇴직금 재원 → 과세재원)로만 빠지고, 계좌 사이에서는 싼 것부터 꺼냄:
 * ① 과세제외 → ② 과세재원(1인 1,500만 한도 안, 연금소득세) → ③ 퇴직금 재원(퇴직소득세 감면) — 여기까지 계좌별 연금수령한도 안
 * → ④ 연금계좌 밖 자산 → ⑤ 퇴직금 재원 연금수령한도 초과분(퇴직소득세 전액) → ⑥ 과세재원 1,500만 초과분(16.5%).
 * 퇴직소득세율이 16.5%보다 높으면 ⑤·⑥ 순서를 바꿈.
 * 과세제외·퇴직금 재원은 명목 금액이 그대로이고 운용수익은 모두 과세재원으로 쌓임.
 * 퇴직소득세 감면(30% → 11년차부터 40%)은 퇴직금 재원이 있는 계좌에서 실제로 꺼낸 해만 연차로 셈.
 */
export function pensionTaxSchedule(schedule: ScheduleRow[], setup: TaxSetup): TaxResult {
  const accts = setup.accounts.map((p) => ({ ...p }));
  let other = setup.other;
  const rows: TaxRow[] = [];
  let totalTax = 0;
  let depletedAge: number | null = null;
  const overYears: number[] = [];
  const warn = new Map<string, LimitWarning>();
  // 지난해까지 퇴직금을 연금으로 실제 받은 햇수(실수령 1년차 연도부터 해마다 받았다고 봄)
  let retireYears = Math.max(0, setup.nowYear - setup.retireYear1);
  for (const r of schedule) {
    const year = setup.birthYear + r.age;
    const defl = Math.pow(1 + setup.inflation / 100, year - setup.nowYear); // 실질 → 명목
    const slotLeft = { self: PENSION_SLOT / defl, spouse: PENSION_SLOT / defl };
    const ownerAge = (o: Owner) => (o === 'self' ? r.age : r.age - setup.spouseGap);
    const retireNo = retireYears + 1;
    const retireRate = retireRateAt(setup.retireBase, retireNo);
    const state = accts.map((p) => {
      const yearNo = pensionYearNo(year, p.year1);
      const eligible = ownerAge(p.owner) >= PENSION_OPEN_AGE && yearNo >= 1;
      const open = eligible && year >= p.drawStart;
      const start = p.free + p.taxed + p.retire; // 연초 평가액(그 해 납입 전)
      return { p, yearNo, eligible, open, start, limit: open ? pensionLimit(start, yearNo) : 0, used: 0, over: 0, tax: 0, hadRetire: p.retire > EPS };
    });
    type St = (typeof state)[number];
    const open = state.filter((s) => s.open);
    other += r.inflow;
    let need = r.withdrawal;
    // 추가 납입: ISA·일반에서 먼저, 모자라면 그만큼 더 꺼냄. 공제받은 몫은 과세재원, 나머지는 과세제외
    let contrib = 0;
    const cy = setup.contrib.find((c) => c.year === year);
    if (cy) {
      for (const owner of ['self', 'spouse'] as const) {
        const amount = (owner === 'self' ? cy.self : cy.spouse) / defl;
        if (amount <= 0) continue;
        const mine = accts.filter((p) => p.owner === owner);
        const target = mine.find((p) => p.drawStart > year) ?? mine[0];
        if (!target) continue;
        const taxed = Math.min(amount, (owner === 'self' ? cy.taxedSelf : cy.taxedSpouse) / defl);
        target.taxed += taxed;
        target.free += amount - taxed;
        const paid = Math.min(Math.max(0, other), amount);
        other -= paid;
        need += amount - paid;
        contrib += amount;
      }
    }
    let gross = 0;
    let tax = 0;
    let otherDrawn = 0;
    const slot = { self: 0, spouse: 0 };
    const over = { self: 0, spouse: 0 };
    const room = (s: St) => Math.max(0, s.limit - s.used);
    /** need 와 상관없이 계좌 s 의 재원 part 에서 세전 g 를 꺼냄 */
    const move = (s: St, part: Part, g: number, rate: number, inLimit: boolean) => {
      s.p[part] -= g;
      s.used += g;
      if (!inLimit) s.over += g;
      gross += g;
      tax += (g * rate) / 100;
      s.tax += (g * rate) / 100;
    };
    /** 계좌 s 의 재원 part 를 세율 rate 로 꺼내 need 를 채움(세전 cap 까지). 꺼낸 세전 금액 반환 */
    const pull = (s: St, part: Part, rate: number, cap: number, inLimit: boolean) => {
      if (need <= EPS) return 0;
      const g = Math.max(0, Math.min(s.p[part], cap, need / (1 - rate / 100)));
      if (g <= 0) return 0;
      need -= g * (1 - rate / 100);
      move(s, part, g, rate, inLimit);
      return g;
    };
    /** 과세재원을 꺼낼 차례인 계좌(과세제외·퇴직금 재원을 다 씀) */
    const taxedNext = (s: St) => s.p.free <= EPS && s.p.retire <= EPS;
    /** 1,500만 한도 안 과세재원(연금소득세) */
    const slotPass = () => {
      for (const s of open) {
        if (!taxedNext(s)) continue;
        const g = pull(s, 'taxed', pensionTaxRate(ownerAge(s.p.owner)), Math.min(room(s), slotLeft[s.p.owner]), true);
        slotLeft[s.p.owner] -= g;
        slot[s.p.owner] += g * defl;
      }
    };
    /** 과세재원 1,500만 초과분(16.5%): 연금수령한도 안 → 한도 초과(연금외수령) */
    const taxedOver = () => {
      for (const s of open) if (taxedNext(s)) over[s.p.owner] += pull(s, 'taxed', OVER_RATE, room(s), true) * defl;
      for (const s of open) if (taxedNext(s)) over[s.p.owner] += pull(s, 'taxed', OVER_RATE, Infinity, false) * defl;
    };
    /** 퇴직금 재원 연금수령한도 초과분(연금외수령: 퇴직소득세 감면 없음) */
    const retireOver = () => {
      for (const s of open) if (s.p.free <= EPS) pull(s, 'retire', setup.retireBase, Infinity, false);
    };
    // 1) 연금수령한도 안: 과세제외 → 과세재원(1,500만 한도) → 퇴직금 재원 → (퇴직금을 다 쓴 계좌의) 과세재원
    for (const s of open) pull(s, 'free', 0, room(s), true);
    slotPass();
    for (const s of open) if (s.p.free <= EPS) pull(s, 'retire', retireRate, room(s), true);
    slotPass();
    // 2) 연금계좌 밖 자산(ISA·일반 등)
    if (need > EPS) {
      const g = Math.max(0, Math.min(other, need));
      need -= g;
      other -= g;
      gross += g;
      otherDrawn += g;
    }
    // 3) 그래도 모자라면: 한도를 넘는 과세제외 → 세율이 낮은 쪽부터(퇴직금 한도초과 · 과세재원 16.5%)
    for (const s of open) pull(s, 'free', 0, Infinity, false);
    if (setup.retireBase <= OVER_RATE) {
      retireOver();
      slotPass();
      taxedOver();
    } else {
      taxedOver();
      retireOver();
      slotPass();
      taxedOver();
    }
    const short = Math.max(0, need);
    let reinvest = 0;
    // 퇴직금 재원이 있는 계좌는 쓸 일이 없는 해에도 최소 금액을 꺼내 실수령연차를 이어감(세후 금액은 ISA·일반계좌로)
    if (setup.retireMinDraw > 0) {
      for (const s of open) {
        if (!s.hadRetire) continue;
        let want = setup.retireMinDraw / defl - s.used;
        for (const part of ['free', 'retire'] as const) {
          if (part === 'retire' && s.p.free > EPS) break;
          const rate = part === 'free' ? 0 : retireRate;
          const g = Math.max(0, Math.min(s.p[part], want, room(s)));
          if (g <= EPS) continue;
          move(s, part, g, rate, true);
          reinvest += g * (1 - rate / 100);
          want -= g;
        }
      }
    }
    // 1,500만 한도 꽉 채우기: 남은 한도만큼 과세재원을 더 꺼내 세후 금액을 ISA·일반계좌로 재투자(과세제외가 남은 계좌는 그것부터 꺼내야 함)
    if (year >= setup.slotFillFrom) {
      for (const s of open) {
        const o = s.p.owner;
        if (s.p.retire > EPS || s.p.taxed <= EPS || slotLeft[o] <= EPS) continue;
        const f = Math.max(0, Math.min(s.p.free, room(s)));
        if (f > EPS) {
          move(s, 'free', f, 0, true);
          reinvest += f;
        }
        if (s.p.free > EPS) continue;
        const rate = pensionTaxRate(ownerAge(o));
        const g = Math.max(0, Math.min(s.p.taxed, room(s), slotLeft[o]));
        if (g <= EPS) continue;
        move(s, 'taxed', g, rate, true);
        slotLeft[o] -= g;
        slot[o] += g * defl;
        reinvest += g * (1 - rate / 100);
      }
    }
    other += reinvest;
    if (state.some((s) => s.hadRetire && s.used > EPS)) retireYears++;
    if (over.self + over.spouse > 0.5) overYears.push(year);
    // 한도가 남았는데 인출 시작 연도 전이라 못 꺼낸 과세재원(55세·연금수령 1년차는 지난 계좌)
    const idle = { self: 0, spouse: 0 };
    for (const o of ['self', 'spouse'] as const) {
      const waiting = state.filter((s) => s.p.owner === o && s.eligible && !s.open).reduce((a, s) => a + s.p.taxed, 0);
      // 인출 중인 계좌에 (남은 과세제외를 꺼낸 뒤) 한도 안에서 꺼낼 수 있는 과세재원이 남았으면 그만큼은 ‘묶여서’ 못 쓴 것이 아님
      const usable = open.filter((s) => s.p.owner === o && s.p.retire <= EPS).reduce((a, s) => a + Math.min(s.p.taxed, Math.max(0, room(s) - s.p.free)), 0);
      idle[o] = Math.max(0, Math.min(slotLeft[o] - usable, waiting)) * defl;
    }
    const accounts: AccountYear[] = state.map((s) => ({
      name: s.p.name,
      owner: s.p.owner,
      yearNo: s.yearNo,
      limit: s.limit * defl,
      start: s.start * defl,
      drawn: s.used * defl,
      tax: s.tax * defl,
      over: s.over * defl,
      freeLeft: s.p.free * defl,
      retireLeft: s.p.retire * defl,
    }));
    for (const a of accounts) {
      if (a.over <= 0.5) continue;
      const w = warn.get(a.name) ?? { name: a.name, owner: a.owner, years: [], maxOver: 0 };
      w.years.push(year);
      w.maxOver = Math.max(w.maxOver, a.over);
      warn.set(a.name, w);
    }
    // 운용수익은 모두 과세재원으로: 과세제외·퇴직금 재원은 명목 금액 그대로(실질로는 물가만큼 줄어듦).
    // 손실로 평가액이 남은 원금보다 작아지면 비례해 줄임
    // 첫해가 1년이 안 되면(스케줄의 share) 수익도 그 기간만큼
    const sh = r.share ?? 1;
    const grow = Math.pow(1 + setup.realReturn, sh);
    // 명목 환산(defl)은 달력 연도 단위라, 과세제외·퇴직금 재원의 명목 금액이 그대로 유지되도록 첫해가 짧아도 한 해치 물가로 나눔
    const inf = 1 + setup.inflation / 100;
    for (const p of accts) {
      const total = Math.max(0, (p.free + p.taxed + p.retire) * grow);
      let free = p.free / inf;
      let retire = p.retire / inf;
      if (free + retire > total) {
        const fit = free + retire > 0 ? total / (free + retire) : 0;
        free *= fit;
        retire *= fit;
      }
      p.free = free;
      p.retire = retire;
      p.taxed = Math.max(0, total - free - retire);
    }
    other *= grow;
    const left = accts.reduce((s, p) => s + p.free + p.taxed + p.retire, 0) + other;
    if (short > 1e-6 && depletedAge === null && r.withdrawal > 0) depletedAge = r.age + 1;
    totalTax += tax;
    const limitOver = accounts.reduce((s, a) => s + a.over, 0);
    rows.push({ age: r.age, year, net: r.withdrawal - short, gross, tax, slot, over, idle, accounts, limitOver, reinvest, contrib, otherDrawn: otherDrawn * defl, isa: other, retireNo, short, left });
  }
  return { rows, totalTax, overYears, limitWarnings: [...warn.values()], depletedAge };
}
