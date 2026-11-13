import type { Asset, Goal, Liability, Profile } from '../types';
import { isLocked, isRecurring, lockedInflow, needsYuTax } from './goals';
import { DEFAULT_CONTRIB, incomeTaxSchedule, type IncomeTaxRow } from './incomeTax';
import { isFinancial, mergeAccounts, yearShareOf } from './portfolio';
import { HP_OVER_NOTE, hpOverCap, isRealEstate, usesHp, willSell } from './realestate';
import { PENSION_OPEN_AGE } from './tax';
import { isYu, validMonths } from './yellowUmbrella';

export type MilestoneKind = 'review' | 'open' | 'limit' | 'lump' | 'pension' | 'tax' | 'contrib' | 'estate' | 'loan' | 'goal';

/** 다가오는 이정표. month 가 0이면 그 해 중(달이 정해지지 않음) */
export interface Milestone {
  year: number;
  month: number;
  kind: MilestoneKind;
  label: string;
  note?: string;
}

export const MILESTONE_KIND: Record<MilestoneKind, string> = {
  review: '점검',
  open: '연금 개시',
  limit: '수령한도',
  lump: '일시금',
  pension: '국민연금',
  tax: '세금',
  contrib: '추가 납입',
  estate: '부동산',
  loan: '대출',
  goal: '목표',
};

/** 지금부터 이정표까지 남은 개월(달이 없으면 그 해 1월 기준, 지났으면 0) */
export function monthsUntil(m: Pick<Milestone, 'year' | 'month'>, nowYear: number, nowMonth: number) {
  return Math.max(0, (m.year - nowYear) * 12 + (m.month || 1) - nowMonth);
}

/** "3년 2개월" · "5개월" · "올해" */
export function untilLabel(m: Pick<Milestone, 'year' | 'month'>, nowYear: number, nowMonth: number) {
  if (m.year === nowYear && !m.month) return '올해';
  const n = monthsUntil(m, nowYear, nowMonth);
  if (n <= 0) return '이번 달';
  const y = Math.floor(n / 12);
  return y > 0 ? `${y}년${n % 12 ? ` ${n % 12}개월` : ''}` : `${n}개월`;
}

const validMonth = (m?: number) => (m !== undefined && m >= 1 && m <= 12 ? Math.round(m) : 0);

/** 생일이 지난 다음 달(국민연금 지급 시작): 12월생이면 다음 해 1월 */
function monthAfterBirthday(year: number, birthMonth: number) {
  if (!birthMonth) return { year, month: 0 };
  return birthMonth === 12 ? { year: year + 1, month: 1 } : { year, month: birthMonth + 1 };
}

/** 그 해 연금계좌를 꺼낼 수 있는 첫 달: 만 55세가 되는 해면 생일이 든 달, 그 뒤 해는 1월(출생 월을 모르면 1월) */
export function pensionOpenMonth(year: number, birthYear: number, birthMonth?: number) {
  return year === birthYear + PENSION_OPEN_AGE ? validMonth(birthMonth) || 1 : 1;
}

const man = (v: number) => `${Math.round(v).toLocaleString('ko-KR')}만원`;

/**
 * 노란우산 소득공제 종소세 추정 행(올해 부금은 남은 달 비율, 노후 진단과 같은 기준). 앞으로 낼 부금이 없으면 없음.
 * 행의 yuSave(그 해 납입분 소득공제로 줄어든 종합소득세, 명목)는 다음 해 5월 종합소득세 신고 때 돌려받는 돈
 */
function yuTaxRows(profile: Profile, assets: Asset[], liabilities: Liability[], nowYear: number, nowMonth?: number) {
  return needsYuTax(profile, assets, nowYear) ? incomeTaxSchedule(profile, nowYear, undefined, assets, liabilities, yearShareOf(nowMonth) ?? 1) : undefined;
}

/** 노란우산 절세 환급 행 묶음: 절세액이 있는 해 중 이어지는 해이고 만원 반올림 금액이 같으면 한 묶음(올해분처럼 금액이 다른 해는 따로) */
export function yuRefundRuns(rows: IncomeTaxRow[]): IncomeTaxRow[][] {
  const runs: IncomeTaxRow[][] = [];
  for (const r of rows) {
    if (!(r.yuSave > 0.5)) continue;
    const last = runs[runs.length - 1]?.at(-1);
    if (last && last.year + 1 === r.year && Math.round(last.yuSave) === Math.round(r.yuSave)) runs[runs.length - 1].push(r);
    else runs.push([r]);
  }
  return runs;
}

/**
 * 엑셀 대시보드 ‘다가오는 이정표’: 연금수령 11년차(수령한도 없음), 55세 연금 개시, 인출 시작 연도, 노란우산 등 일시금 수령,
 * 국민연금 개시, 퇴직금 실수령 11년차(감면 40%), 70·80세 연금소득세율, 추가 납입·환급, 노란우산 절세 환급(납입 다음 해 5월), 부동산 매각·주택연금, 만기일시 대출, 일시 목표.
 * 지금(nowYear·nowMonth) 이후의 것만 시기순으로 돌려줌.
 */
export function milestones(profile: Profile, assets: Asset[], liabilities: Liability[], goals: Goal[], nowYear: number, nowMonth: number): Milestone[] {
  const out: Milestone[] = [];
  const hasSpouse = profile.spouseBirthYear > 0;
  const people = [
    { who: '본인', key: 'self' as const, birth: profile.birthYear, month: validMonth(profile.birthMonth) },
    ...(hasSpouse ? [{ who: '배우자', key: 'spouse' as const, birth: profile.spouseBirthYear, month: validMonth(profile.spouseBirthMonth) }] : []),
  ];
  const pensions = mergeAccounts(assets).filter((a) => a.type === 'pension' && a.amount > 0); // 같은 계좌로 묶인 줄은 한 계좌
  const ownerOf = (a: Asset) => (a.owner === 'spouse' && hasSpouse ? 'spouse' : 'self');
  const nowAge = nowYear - profile.birthYear;
  const retired = nowAge >= profile.retireAge;

  if (retired && pensions.length + assets.filter(isFinancial).length > 0) {
    out.push({ year: nowYear + 1, month: 1, kind: 'review', label: '연말결산: 12월 말 평가액·그 해 인출액 기록', note: '가드레일 판정을 보고 정기지급액 조정 · 자산 금액도 12월 말 값으로 고침' });
  }

  for (const p of people) {
    const mine = pensions.filter((a) => ownerOf(a) === p.key);
    if (mine.length === 0) continue;
    // 55세: 연금계좌 인출 가능
    out.push({ year: p.birth + PENSION_OPEN_AGE, month: p.month, kind: 'open', label: `${p.who} 만 55세 → 연금계좌 인출 가능`, note: mine.map((a) => a.name).join(', ') });
    // 연금소득세율이 내려가는 나이
    out.push({ year: p.birth + 70, month: p.month, kind: 'tax', label: `${p.who} 만 70세 → 연금소득세 5.5% → 4.4%` });
    out.push({ year: p.birth + 80, month: p.month, kind: 'tax', label: `${p.who} 만 80세 → 연금소득세 4.4% → 3.3%` });
  }

  // 계좌별: 연금수령 11년차(한도 없음), 인출 시작 연도 — 같은 해는 한 줄로 묶음
  const group = (kind: MilestoneKind, yearOf: (a: Asset) => number, text: (names: string) => string, note?: string, monthOf: (a: Asset, year: number) => number = () => 1) => {
    const by = new Map<string, { year: number; month: number; names: string[] }>();
    for (const a of pensions) {
      const year = yearOf(a);
      if (!(year > 0)) continue;
      const month = monthOf(a, year);
      const k = `${year}-${month}`;
      by.set(k, { year, month, names: [...(by.get(k)?.names ?? []), a.name || '연금'] });
    }
    for (const g of by.values()) out.push({ year: g.year, month: g.month, kind, label: text(g.names.join('·')), note });
  };
  const personOf = (a: Asset) => people.find((p) => p.key === ownerOf(a))!;
  const year1Of = (a: Asset) => a.pensionYear1 || personOf(a).birth + PENSION_OPEN_AGE;
  group('limit', (a) => year1Of(a) + 10, (n) => `${n} 연금수령 11년차 → 수령한도 없음`);
  // 만 55세가 되는 해에 시작하면 1월이 아니라 생일이 든 달부터
  group('open', (a) => a.drawStartYear ?? 0, (n) => `${n} 인출 시작 — 연금 개시 신청`, '그 전 해까지는 추가 납입을 받는 계좌', (a, year) => pensionOpenMonth(year, personOf(a).birth, personOf(a).month));

  // 퇴직금 연금 실수령 11년차: 감면 30% → 40%
  if ((profile.retireTaxYear1 ?? 0) > 0 && pensions.some((a) => (a.retirePart ?? 0) > 0)) {
    out.push({ year: profile.retireTaxYear1! + 10, month: 1, kind: 'tax', label: '퇴직금 연금 실수령 11년차 → 퇴직소득세 감면 30% → 40%', note: (profile.retireMinDraw ?? 0) > 0 ? '해마다 최소 인출을 이어갈 때' : '한 해라도 안 꺼내면 그만큼 늦어짐(기본 정보 → 프로필 → 연금 세금의 ‘퇴직금 계좌 매년 최소 인출’)' });
  }

  // 노란우산 등 수령 시점이 정해진 자산
  // 올해 노란우산 부금은 남은 달만큼(노후 진단과 같은 비율)
  const yuShare = yearShareOf(nowMonth) ?? 1;
  const yuRows = yuTaxRows(profile, assets, liabilities, nowYear, nowMonth);
  for (const a of assets.filter((x) => isLocked(x, nowYear))) {
    const f = lockedInflow(a, profile, nowYear, yuRows, yuShare);
    out.push({ year: f.year, month: isYu(a) ? (validMonths(a.yuPayoutMonth) ?? 0) : 0, kind: 'lump', label: `${a.name || '묶인 자산'} 수령 → ISA·일반계좌에서 운용`, note: `세후 약 ${man(f.nominal)}(그 해 금액)` });
  }

  // 국민연금 개시(생일 다음 달부터)
  const np = [
    { who: '본인', amount: profile.nationalPension, age: profile.nationalPensionAge, birth: profile.birthYear, month: validMonth(profile.birthMonth) },
    ...(hasSpouse ? [{ who: '배우자', amount: profile.spousePension, age: profile.spousePensionAge, birth: profile.spouseBirthYear, month: validMonth(profile.spouseBirthMonth) }] : []),
  ];
  for (const x of np) {
    if (!(x.amount > 0) || !(x.age > 0)) continue;
    out.push({ ...monthAfterBirthday(x.birth + x.age, x.month), kind: 'pension', label: `${x.who} 국민연금 개시(${x.age}세)`, note: `월 ${man(x.amount)}(오늘 기준)${profile.expenseMode === 'draw' ? ' → 그만큼 연금계좌 인출 감소' : ''}` });
  }

  // 추가 납입(세액공제)과 환급
  const c = { ...DEFAULT_CONTRIB, ...(profile.contrib ?? {}) };
  if (c.from > 0 && c.self + (hasSpouse ? c.spouse : 0) > 0) {
    const to = c.to || c.from;
    const who = [c.self > 0 ? `본인 ${man(c.self)}` : '', hasSpouse && c.spouse > 0 ? `배우자 ${man(c.spouse)}` : ''].filter(Boolean).join(' · ');
    const first = Math.max(c.from, nowYear);
    if (first <= to) out.push({ year: first, month: 12, kind: 'contrib', label: `연금계좌 추가 납입(${first === to ? `${to}년` : `${first}~${to}년 해마다`})`, note: `${who} · 12월 말 전 납입` });
    out.push({ year: to + 1, month: 5, kind: 'contrib', label: '마지막 추가 납입분 세액공제 환급 확인', note: '5월 종합소득세 신고' });
  }
  // 노란우산 소득공제로 줄어든 종합소득세: 납입한 다음 해 5월 신고 때 돌려받음 — 이어지는 해의 금액(만원 반올림)이 같으면 한 줄로
  for (const g of yuRefundRuns(yuRows ?? [])) {
    const from = g[0].year + 1;
    const to = g[g.length - 1].year + 1;
    const note = `${g[0].year === g[g.length - 1].year ? g[0].year : `${g[0].year}~${g[g.length - 1].year}`}년 납입분 소득공제로 줄어든 종합소득세 · 5월 종합소득세 신고`;
    if (g.length === 1) out.push({ year: from, month: 5, kind: 'tax', label: '노란우산 절세 환급', note: `약 ${man(g[0].yuSave)}(${note})` });
    else out.push({ year: from, month: 5, kind: 'tax', label: `${from}~${to}년 해마다 5월 노란우산 절세 환급(연 약 ${man(g[0].yuSave)})`, note });
  }
  if (profile.slotFill && (profile.slotFillFrom ?? 0) > nowYear) out.push({ year: profile.slotFillFrom!, month: 1, kind: 'tax', label: '1,500만 한도 꽉 채우기 시작', note: '남는 돈은 ISA·일반계좌로 재투자' });

  // 부동산 매각·주택연금
  for (const a of assets.filter(isRealEstate)) {
    if (usesHp(a)) out.push({ year: profile.birthYear + a.hpAge!, month: 0, kind: 'estate', label: `${a.name || '주택'} 주택연금 가입(본인 ${a.hpAge}세)`, ...(hpOverCap(a) ? { note: HP_OVER_NOTE } : {}) });
    else if (willSell(a, nowYear)) out.push({ year: a.lockYear!, month: 0, kind: 'estate', label: `${a.name || '부동산'} 매각 예정`, note: '매각대금은 금융자산으로 들어와 함께 운용' });
  }

  // 만기일시 대출 원금 상환
  for (const l of liabilities) {
    if (l.repay === 'bullet' && l.balance > 0 && (l.endAge ?? 0) > nowAge) out.push({ year: profile.birthYear + l.endAge!, month: 0, kind: 'loan', label: `${l.name || '대출'} 만기 — 원금 일시 상환`, note: man(l.balance) });
  }

  // 한 번 쓰는 목표(반복 지출·은퇴 분류 제외)
  for (const g of goals) {
    if (g.category === 'retirement' || isRecurring(g) || !(g.targetAge > nowAge)) continue;
    out.push({ year: profile.birthYear + g.targetAge, month: 0, kind: 'goal', label: `${g.name || '목표'} 지출(본인 ${g.targetAge}세)`, note: `오늘 기준 ${man(g.amountPV)}` });
  }

  const lastYear = profile.birthYear + profile.lifeExpectancy;
  const future = (m: Milestone) => m.year <= lastYear && (m.year > nowYear || (m.year === nowYear && (m.month === 0 || m.month > nowMonth)));
  return out.filter(future).sort((a, b) => a.year - b.year || (a.month || 13) - (b.month || 13));
}

/**
 * 엑셀 대시보드 ‘올해·내년 할 일’: 그 해에 챙길 연금 개시 신청·추가 납입·환급(노란우산 절세 포함)·일시금 수령·최소 인출·연말결산.
 * liabilities·nowMonth: 노란우산 절세 환급 금액을 이정표와 같은 기준(올해 남은 달)으로 계산할 때
 */
export function yearTodos(profile: Profile, assets: Asset[], nowYear: number, year: number, liabilities: Liability[] = [], nowMonth?: number): string[] {
  const out: string[] = [];
  const hasSpouse = profile.spouseBirthYear > 0;
  const pensions = mergeAccounts(assets).filter((a) => a.type === 'pension' && a.amount > 0); // 같은 계좌로 묶인 줄은 한 계좌
  const age = year - profile.birthYear;
  if (year > nowYear && age > profile.retireAge) out.push('1월: 지난해 연말결산 기록 → 가드레일 판정 · 계좌별 정기지급액 변경');
  const starting = pensions.filter((a) => a.drawStartYear === year);
  if (starting.length) out.push(`${starting.map((a) => a.name || '연금').join('·')} 연금 개시 신청`);
  for (const p of [{ who: '본인', key: 'self', birth: profile.birthYear }, ...(hasSpouse ? [{ who: '배우자', key: 'spouse', birth: profile.spouseBirthYear }] : [])]) {
    const mine = pensions.filter((a) => (a.owner === 'spouse' && hasSpouse ? 'spouse' : 'self') === p.key && !(a.drawStartYear === year));
    if (mine.length && p.birth + PENSION_OPEN_AGE === year) out.push(`${p.who} 만 55세: 연금계좌 개시 가능(${mine.map((a) => a.name || '연금').join('·')})`);
  }
  const c = { ...DEFAULT_CONTRIB, ...(profile.contrib ?? {}) };
  const to = c.to || c.from;
  const paying = (y: number) => c.from > 0 && y >= c.from && y <= to;
  if (paying(year)) {
    const who = [c.self > 0 ? `본인 ${man(c.self)}` : '', hasSpouse && c.spouse > 0 ? `배우자 ${man(c.spouse)}` : ''].filter(Boolean).join(' · ');
    if (who) out.push(`12월 말 전 연금계좌 추가 납입: ${who}(인출을 시작하지 않은 계좌에)`);
  }
  if (paying(year - 1) && c.self + (hasSpouse ? c.spouse : 0) > 0) out.push('5월 종합소득세 신고 때 지난해 납입분 세액공제 환급 확인');
  const yuSave = yuTaxRows(profile, assets, liabilities, nowYear, nowMonth)?.find((r) => r.year === year - 1)?.yuSave ?? 0;
  if (yuSave > 0.5) out.push(`5월 종합소득세 신고 때 노란우산 절세 환급 확인(지난해 납입분 소득공제, 약 ${man(yuSave)})`);
  for (const a of assets.filter((x) => isFinancial(x) && x.lockYear === year && year >= nowYear)) out.push(`${a.name || '묶인 자산'} 수령 신청 → ISA·일반계좌로 옮겨 운용`);
  if ((profile.retireMinDraw ?? 0) > 0 && pensions.some((a) => (a.retirePart ?? 0) > 0) && age >= profile.retireAge) out.push(`퇴직금 계좌에서 최소 ${man(profile.retireMinDraw!)} 인출(실수령연차 유지)`);
  const np = [
    { who: '본인', amount: profile.nationalPension, year: profile.birthYear + profile.nationalPensionAge },
    ...(hasSpouse ? [{ who: '배우자', amount: profile.spousePension, year: profile.spouseBirthYear + profile.spousePensionAge }] : []),
  ];
  for (const x of np) if (x.amount > 0 && x.year === year) out.push(`${x.who} 국민연금 수령 신청(생일 다음 달부터 지급)`);
  return out;
}
