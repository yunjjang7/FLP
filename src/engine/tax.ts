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

/** 퇴직금 재원 연금 수령 세율(%): 퇴직소득세 × 70%(실수령 1~10년차) · 60%(11년차~) */
export const retireTaxRate = (base: number, year: number, year1: number) => base * (year - year1 + 1 > 10 ? 0.6 : 0.7);

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

/** 계좌별 재원(실질): 과세제외 → 과세재원(1,500만 한도) → 퇴직금 재원 */
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
  slotFillFrom: number; // 1,500만 한도 꽉 채우기 시작 연도(Infinity = 안 함)
  contrib: ContribYear[]; // 추가 납입(세액공제)
}

/** 현재 자산을 계좌·세금 재원별로 나눔(인출 시작 자산 startBalance 에 비례해 맞춤) */
export function taxSetup(profile: Profile, assets: Asset[], nowYear: number, startBalance: number, meanReturn: number): TaxSetup | null {
  const liquid = assets.filter((a) => isFinancial(a) && !isLocked(a, nowYear));
  const pension = liquid.filter((a) => a.type === 'pension');
  if (pension.length === 0) return null;
  const total = liquid.reduce((a, x) => a + x.amount, 0);
  const k = total > 0 ? startBalance / total : 1;
  const spouseBirth = profile.spouseBirthYear > 0 ? profile.spouseBirthYear : profile.birthYear;
  // 같은 사람 계좌는 ‘꺼내는 순서’대로(0이면 입력 순서)
  const sorted = pension.map((a, i) => ({ a, key: (a.drawOrder ?? 0) > 0 ? a.drawOrder! : 1000 + i })).sort((x, y) => x.key - y.key).map((x) => x.a);
  const accounts: AccountPot[] = sorted.map((a) => {
    const owner = a.owner === 'spouse' ? 'spouse' : 'self';
    const free = Math.min(a.amount, a.taxFree ?? 0);
    const retire = Math.min(Math.max(0, a.amount - free), a.retirePart ?? 0);
    const year1 = a.pensionYear1 || (owner === 'spouse' ? spouseBirth : profile.birthYear) + PENSION_OPEN_AGE;
    return { name: a.name, owner, free: free * k, retire: retire * k, taxed: Math.max(0, a.amount - free - retire) * k, year1, drawStart: a.drawStartYear || 0 };
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
  drawn: number; // 세전 인출액(명목)
  over: number; // 한도를 넘어 연금외수령으로 꺼낸 금액(명목)
}

export interface TaxRow {
  age: number;
  year: number;
  net: number; // 생활비로 쓰는 인출액(세후, 실질)
  gross: number; // 세전 인출액(실질)
  tax: number; // 세금(실질)
  slot: Record<Owner, number>; // 1,500만 한도 사용액(세전, 명목)
  over: Record<Owner, number>; // 1,500만 한도 초과 인출액(세전, 명목)
  accounts: AccountYear[];
  limitOver: number;
  reinvest: number; // 1,500만 한도를 채우려고 더 꺼내 ISA·일반계좌로 옮긴 세후 금액(실질)
  contrib: number; // 연금계좌 추가 납입액(실질)
  isa: number; // 연말 연금계좌 밖 자산(ISA·일반 등, 실질) // 연금수령한도를 넘는 인출액 합계(명목)
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

/**
 * 인출 스케줄(세후 필요액)에 연금 세금을 입혀 세전 인출액을 계산.
 * 꺼내는 순서(계좌별 연금수령한도 안): 과세제외 → 과세재원(1인 1,500만 한도 안, 연금소득세) → 퇴직금 재원(퇴직소득세 감면)
 * → 연금계좌 밖 자산 → (모자라면) 과세제외 → 과세재원 한도 초과분(16.5%) → 퇴직금 재원 한도 초과분(퇴직소득세 전액).
 * 재원별 잔액은 스케줄과 같은 결정론적 수익률로 불어남.
 */
export function pensionTaxSchedule(schedule: ScheduleRow[], setup: TaxSetup): TaxResult {
  const accts = setup.accounts.map((p) => ({ ...p }));
  let other = setup.other;
  const rows: TaxRow[] = [];
  let totalTax = 0;
  let depletedAge: number | null = null;
  const overYears: number[] = [];
  const warn = new Map<string, LimitWarning>();
  for (const r of schedule) {
    const year = setup.birthYear + r.age;
    const defl = Math.pow(1 + setup.inflation / 100, year - setup.nowYear); // 실질 → 명목
    const slotLeft = { self: PENSION_SLOT / defl, spouse: PENSION_SLOT / defl };
    const ownerAge = (o: Owner) => (o === 'self' ? r.age : r.age - setup.spouseGap);
    const state = accts.map((p) => {
      const yearNo = pensionYearNo(year, p.year1);
      const open = ownerAge(p.owner) >= PENSION_OPEN_AGE && yearNo >= 1 && year >= p.drawStart;
      return { p, yearNo, open, limit: open ? pensionLimit(p.free + p.taxed + p.retire, yearNo) : 0, used: 0, over: 0 };
    });
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
    const slot = { self: 0, spouse: 0 };
    const over = { self: 0, spouse: 0 };
    /** 세율 rate 로 need 를 채움(세전 cap 까지). 사용한 세전 금액 반환 */
    const take = (avail: number, rate: number, cap = Infinity) => {
      if (need <= 1e-9) return 0;
      const g = Math.max(0, Math.min(avail, cap, need / (1 - rate / 100)));
      need -= g * (1 - rate / 100);
      gross += g;
      tax += (g * rate) / 100;
      return g;
    };
    const room = (s: (typeof state)[number]) => Math.max(0, s.limit - s.used);
    const draw = (s: (typeof state)[number], g: number, inLimit: boolean) => {
      s.used += g;
      if (!inLimit) s.over += g;
      return g;
    };
    // 1) 연금수령한도 안
    for (const s of open) s.p.free -= draw(s, take(s.p.free, 0, room(s)), true);
    for (const s of open) {
      const g = draw(s, take(s.p.taxed, pensionTaxRate(ownerAge(s.p.owner)), Math.min(room(s), slotLeft[s.p.owner])), true);
      s.p.taxed -= g;
      slotLeft[s.p.owner] -= g;
      slot[s.p.owner] += g * defl;
    }
    for (const s of open) s.p.retire -= draw(s, take(s.p.retire, retireTaxRate(setup.retireBase, year, setup.retireYear1), room(s)), true);
    other -= take(other, 0);
    // 2) 과세재원 1,500만 초과(한도 안이면 분리과세 16.5%)
    for (const s of open) {
      const g = draw(s, take(s.p.taxed, OVER_RATE, room(s)), true);
      s.p.taxed -= g;
      over[s.p.owner] += g * defl;
    }
    // 3) 연금수령한도 초과 = 연금외수령
    for (const s of open) s.p.free -= draw(s, take(s.p.free, 0), false);
    for (const s of open) {
      const g = draw(s, take(s.p.taxed, OVER_RATE), false);
      s.p.taxed -= g;
      over[s.p.owner] += g * defl;
    }
    for (const s of open) s.p.retire -= draw(s, take(s.p.retire, setup.retireBase), false);
    const short = Math.max(0, need);
    // 1,500만 한도 꽉 채우기: 남은 한도만큼 과세재원을 더 꺼내 세후 금액을 ISA·일반계좌로 재투자
    let reinvest = 0;
    if (year >= setup.slotFillFrom) {
      for (const s of open) {
        const rate = pensionTaxRate(ownerAge(s.p.owner));
        const g = draw(s, Math.max(0, Math.min(s.p.taxed, room(s), slotLeft[s.p.owner])), true);
        if (g <= 1e-9) continue;
        s.p.taxed -= g;
        slotLeft[s.p.owner] -= g;
        slot[s.p.owner] += g * defl;
        gross += g;
        tax += (g * rate) / 100;
        reinvest += g * (1 - rate / 100);
      }
      other += reinvest;
    }
    if (over.self + over.spouse > 0.5) overYears.push(year);
    const accounts: AccountYear[] = state.map((s) => ({
      name: s.p.name,
      owner: s.p.owner,
      yearNo: s.yearNo,
      limit: s.limit * defl,
      drawn: s.used * defl,
      over: s.over * defl,
    }));
    for (const a of accounts) {
      if (a.over <= 0.5) continue;
      const w = warn.get(a.name) ?? { name: a.name, owner: a.owner, years: [], maxOver: 0 };
      w.years.push(year);
      w.maxOver = Math.max(w.maxOver, a.over);
      warn.set(a.name, w);
    }
    const grow = 1 + setup.realReturn;
    for (const p of accts) { p.free *= grow; p.taxed *= grow; p.retire *= grow; }
    other *= grow;
    const left = accts.reduce((s, p) => s + p.free + p.taxed + p.retire, 0) + other;
    if (short > 1e-6 && depletedAge === null && r.withdrawal > 0) depletedAge = r.age + 1;
    totalTax += tax;
    const limitOver = accounts.reduce((s, a) => s + a.over, 0);
    rows.push({ age: r.age, year, net: r.withdrawal - short, gross, tax, slot, over, accounts, limitOver, reinvest, contrib, isa: other, short, left });
  }
  return { rows, totalTax, overYears, limitWarnings: [...warn.values()], depletedAge };
}
