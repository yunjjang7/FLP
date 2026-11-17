import { won } from '../lib/format';
import type { Level, Profile } from '../types';
import { onceGoalPlans, type GoalPlan } from './goals';
import type { InsuranceGap } from './insurance';
import { debtAnnualAt, deterministicPath, expenseAt, nominalFactor, solveFor, weakestGuardrail, withdrawStart, type PlanInput } from './montecarlo';
import type { Retax } from './pensionTaxPlan';
import { RISK_PROFILES, type Summary } from './portfolio';
import { emergencyMonths, emergencyRunway, withdrawLevel } from './risk';
import { EMERGENCY_LOCK_MONTHS, goalTimingGaps, type MaturityRow } from './maturity';
import { ISA_SEP_TAX, type IsaTax } from './account';
import { BEAR_DROP, bearPlan, peakPlan, pensionEquityOutNote, CASH_YEARS_TARGET, cashMoveRows, cashRunway, marketDateNote, pensionBondOutNote, pensionFrom55, type BondsOnHand, pensionFrom55Note, pensionOutNote, type CashOnHand } from './buckets';

export interface Prescription {
  title: string;
  detail: string;
  level: Level;
  area: '저축' | '투자' | '노후' | '비상금' | '부채' | '보장' | '목표';
  /** 배지 문구를 바꿀 때(예: 참고 항목은 ‘참고’) */
  badge?: string;
}

/** 만원 → "3,500만" / "1.25억" (뒤에 '원'은 문장에서 붙임) */
const fmt = (v: number) => won(v, false);

/** ISA 만기 세금 문장(납입 원금을 넣었을 때만 계산, 아니면 넣으라는 안내) */
export function isaTaxText(t?: IsaTax): string {
  if (!t) return ' 납입 원금을 넣으면 만기 때 비과세 한도를 넘는 수익에 붙는 세금도 추정합니다.';
  const est = `만기 평가액 약 ${fmt(t.value)}원(기대수익률로 불린 추정) − 원금 ${fmt(t.paid)}원`;
  if (t.gain <= 0.5) return ` ${est}으로 수익이 없어 세금이 없습니다.`;
  if (t.taxable <= 0.5) return ` 만기 수익 약 ${fmt(t.gain)}원(${est})이 비과세 한도 ${fmt(t.limit)}원 안이라 세금이 없습니다.`;
  return ` 만기 수익 약 ${fmt(t.gain)}원(${est}) 중 비과세 한도 ${fmt(t.limit)}원을 넘는 ${fmt(t.taxable)}원에 ${ISA_SEP_TAX}% 분리과세 약 ${fmt(t.tax)}원이 붙습니다.`;
}

/**
 * ISA 만기 처방: 만기 연도를 넣은 ISA 마다, 만기 자금을 연금계좌로 옮기면 늘어나는 세액공제 대상(옮긴 금액의 10%, 최대 300만)과 예상 환급.
 * 만기가 올해·내년이면 주의, 더 뒤면 참고. 만기 연도가 지났으면 연장했는지 확인하라고 안내. fixedRate: 추가 납입 설정에 공제율을 직접 넣었는지
 */
export function isaPrescriptions(s: Pick<Summary, 'isa'>, nowYear: number, fixedRate = false): Prescription[] {
  return (s.isa ?? []).map((x) => {
    if (x.endYear < nowYear) {
      return {
        area: '투자' as const, level: 'caution' as const,
        title: `${x.name} 만기 연도(${x.endYear}년)가 지났음`,
        detail: '만기를 연장했으면 자산 탭에서 새 만기 연도로 고치세요. 해지했다면 받은 돈을 어디로 옮겼는지 자산 탭에 반영하세요.',
      };
    }
    const soon = x.endYear - nowYear <= 1;
    const credit = fixedRate || Math.abs(x.creditHigh - x.creditLow) < 0.05 ? `약 ${fmt(x.creditHigh)}원` : `약 ${fmt(x.creditLow)}~${fmt(x.creditHigh)}원(공제율 13.2~16.5%)`;
    return {
      area: '투자' as const, level: soon ? ('caution' as const) : ('good' as const), ...(soon ? {} : { badge: '참고' }),
      title: `${x.name} ${x.endYear}년 만기 — 연금계좌로 옮기면 세액공제 대상 ${fmt(x.base)}원 추가`,
      detail: `ISA 만기 후 60일 안에 연금저축·IRP로 옮기면 옮긴 금액의 10%(최대 300만원)를 그 해 연금계좌 세액공제 대상에 더합니다. 지금 평가액 ${fmt(x.amount)}원을 모두 옮기면 환급 ${credit}(그 해 낸 종합소득세까지만). 옮긴 돈은 55세 이후 연금으로 받고, 세액공제 받은 금액은 연금소득세 대상이 됩니다.${isaTaxText(x.tax)}`,
    };
  });
}

const matLabel = (r: Pick<MaturityRow, 'year' | 'month'>) => `${r.year}년${r.month ? ` ${r.month}월` : ''}`;

/**
 * 예금·적금 만기 처방: 만기가 지난 줄은 고치라는 안내, 비상금 가운데 만기가 3개월 넘게 남은 돈 때문에 바로 쓸 수 있는 돈이 목표에 못 미치면 주의,
 * 목적자금이 목표 해보다 늦게 만기가 오는 예금·적금에 묶여 있으면 주의(목적자금 시점 맞추기)
 */
export function maturityPrescriptions(
  s: Pick<Summary, 'maturities' | 'emergencyLocked' | 'emergencyFund' | 'expense' | 'midFund'>,
  goalPlans: Pick<GoalPlan, 'goal' | 'years' | 'allocated'>[],
  nowYear: number,
  target: number,
): Prescription[] {
  const rows = s.maturities ?? [];
  const out: Prescription[] = [];
  for (const r of rows.filter((x) => x.monthsLeft < 0)) {
    out.push({
      area: r.purpose === 'short' ? '비상금' : r.purpose === 'mid' ? '목표' : '저축', level: 'caution',
      title: `${r.name} 만기(${matLabel(r)})가 지났음`,
      detail: '재예치했으면 자산 탭에서 새 만기로 고치세요. 찾았다면 받은 돈을 어디에 두었는지 자산 탭에 반영하세요. 지난 만기는 바로 쓸 수 있는 돈으로 봅니다.',
    });
  }
  const locked = s.emergencyLocked ?? 0;
  if (locked > 0.5) {
    const usable = emergencyMonths({ ...s, emergencyFund: s.emergencyFund - locked } as Summary);
    if (usable < target) {
      const list = rows.filter((r) => r.purpose === 'short' && r.monthsLeft > EMERGENCY_LOCK_MONTHS);
      out.push({
        area: '비상금', level: 'caution',
        title: `비상금 중 ${fmt(locked)}원은 만기 전 — 바로 쓸 수 있는 돈은 ${usable.toFixed(1)}개월분`,
        detail: `${list.map((r) => `${r.name}(${matLabel(r)} 만기)`).join(', ')}은(는) 만기가 ${EMERGENCY_LOCK_MONTHS}개월 넘게 남아, 급할 때 깨면 약정 이자 대신 중도해지 이율을 받습니다. 목표 ${target}개월 가운데 일부는 입출금·파킹통장·MMF처럼 바로 꺼낼 수 있는 곳에 두거나, 만기를 나눠 몇 달마다 하나씩 돌아오게 하세요.`,
      });
    }
  }
  for (const g of goalTimingGaps(goalPlans, s.midFund ?? 0, rows, nowYear)) {
    out.push({
      area: '목표', level: 'caution',
      title: `${g.name}(${g.goalYear}년) 목적자금 ${fmt(g.short)}원 — 예금·적금 만기가 목표보다 늦음`,
      detail: `${g.late.map((r) => `${r.name}(${matLabel(r)} 만기, ${fmt(r.amount)}원)`).join(', ')}이(가) ${g.goalYear}년보다 늦게 돌아와, 중기·목적자금을 가까운 목표부터 쓰면 이 목표에 쓸 돈 가운데 ${fmt(g.short)}원은 중도해지해야 합니다(약정 이자 대신 중도해지 이율). 새로 들 때 만기를 목표 전으로 맞추거나, 목표 전에 만기가 오는 상품·입출금 자산으로 나눠 두세요.`,
    });
  }
  return out;
}

/**
 * 만기 전 예금 대응: 바로 쓸 수 있는 돈이 첫해 인출 기준 2년치에 못 미치고 만기가 3개월 넘게 남은 예금·적금이 있으면,
 * 지금 깨지 말고 만기가 돌아오면 현금성 바구니(입출금·파킹통장·MMF)로 옮기라는 처방. 다 옮겨도 모자라면 남는 금액도 알려 줌
 */
export function cashBucketPrescription(c: CashOnHand, run?: { usable: number; all: number; yearDraw: number; retired: boolean }, births?: { birthYear: number; spouseBirthYear: number }): Prescription | null {
  if (!run || !cashMoveRows(c, run).length) return null;
  const goal = run.yearDraw * CASH_YEARS_TARGET;
  const names = c.lockedRows.map((r) => `${r.name}(${matLabel(r)} 만기, ${fmt(r.amount)}원)`).join(', ');
  const after = run.all >= CASH_YEARS_TARGET
    ? `모두 옮기면 약 ${run.all.toFixed(1)}년치가 됩니다.`
    : `모두 옮겨도 약 ${run.all.toFixed(1)}년치라, 나머지 ${fmt(goal - c.total)}원은 고점 부근에 주식형 일부를 팔아 채우세요.`;
  return {
    area: '노후', level: 'caution',
    title: `만기 전 예금·적금 ${fmt(c.locked)}원 — 만기 뒤 현금성 바구니로`,
    detail: `바로 쓸 수 있는 돈 ${fmt(c.usable)}원${c.pension ? `(연금계좌 안 현금성 ${fmt(c.pension)}원 포함)` : ''}은 ${run.retired ? '올해' : '은퇴 첫해'} 인출(연 ${fmt(run.yearDraw)}원) 기준 약 ${run.usable.toFixed(1)}년치로 ${CASH_YEARS_TARGET}년치(${fmt(goal)}원)에 못 미칩니다. ${names}은(는) 만기가 ${EMERGENCY_LOCK_MONTHS}개월 넘게 남아 지금 깨면 약정 이자 대신 중도해지 이율을 받으니 그대로 두고, 만기가 돌아오면 다시 맡기지 말고 입출금·파킹통장·MMF 같은 현금성 바구니로 옮기세요. ${after}${pensionOutNote(c)}${births ? pensionFrom55Note(pensionFrom55(c, births.birthYear, births.spouseBirthYear)) : ''}`,
  };
}

/**
 * 55세 전 현금성 부족: 점검기준 옵션으로 연금계좌 안 현금성을 세려 했지만 인출 시작 해에 계좌 주인이 55세 전이라 빼서(pensionOut)
 * 바로 쓸 돈이 첫해 인출 기준 2년치에 못 미치면, 만기 전 예금이 없어도 연금계좌 밖 현금성을 채우라는 처방.
 * 만기 전 예금 처방(cashBucketPrescription)이 나오는 경우는 그쪽에 같은 안내가 붙으므로 null
 */
export function pensionOutPrescription(c: CashOnHand, run?: { usable: number; all: number; yearDraw: number; retired: boolean }, births?: { birthYear: number; spouseBirthYear: number }): Prescription | null {
  if (!run || !(run.usable < CASH_YEARS_TARGET) || !((c.pensionOut ?? 0) > 0.5) || cashMoveRows(c, run).length) return null;
  const goal = run.yearDraw * CASH_YEARS_TARGET;
  const from = births ? pensionFrom55Note(pensionFrom55(c, births.birthYear, births.spouseBirthYear)) : '';
  return {
    area: '노후', level: 'caution',
    title: `55세 전 현금성 부족 — 연금계좌 밖 현금성 ${fmt(Math.max(0, goal - c.usable))}원 더 필요`,
    detail: `바로 쓸 수 있는 돈 ${fmt(c.usable)}원은 ${run.retired ? '올해' : '은퇴 첫해'} 인출(연 ${fmt(run.yearDraw)}원) 기준 약 ${run.usable.toFixed(1)}년치로 ${CASH_YEARS_TARGET}년치(${fmt(goal)}원)에 못 미칩니다.${pensionOutNote(c)}${from} 그때까지 하락장에 주식을 팔지 않고 버티려면 모자란 ${fmt(Math.max(0, goal - c.usable))}원을 저축이나 고점 부근에 연금계좌 밖 주식형 일부를 팔아 입출금·파킹통장·MMF 같은 현금성 바구니에 채우세요.`,
  };
}

/**
 * 하락장 처방: 인출용 자산 배치 가이드에 저장한 등락률(profile.marketDrawdown)이 −15% 이하이고 바로 쓸 돈(c.usable)이
 * 첫해 인출(yearDraw) 기준 2년치에 못 미치면, 주식형을 팔지 말고 모자란 금액을 채권형(bonds, 금융자산 안 채권형 금액)에서 먼저 꺼내라는 처방.
 * 채권형으로도 모자라면 남는 금액과 인출을 줄이는 방안을 덧붙임. 넣은 지 30일이 지났으면 다시 넣으라는 안내.
 * bonds 가 BondsOnHand 면 55세 전 연금계좌 안 채권형을 뺀 usable 을 쓰고, 뺀 금액이 있으면 제외 안내를 붙임
 */
/** 하락장 처방 제목 앞부분(요약 보고에서 잘리지 않게 찾을 때) */
export const BEAR_RX_TITLE = '하락장: 주식형 매도 멈춤';

export function marketPrescription(profile: Pick<Profile, 'marketDrawdown' | 'marketDrawdownDate'>, c: Pick<CashOnHand, 'usable'>, yearDraw: number, bonds: number | BondsOnHand, now: Date): Prescription | null {
  const dd = profile.marketDrawdown ?? 0;
  const b = bearPlan(dd, c.usable, yearDraw, bonds);
  if (!b) return null;
  const { goal, usable, short, bond, fromBond, left } = b;
  const date = marketDateNote(profile.marketDrawdownDate, now);
  const have = usable > 0.5
    ? `바로 쓸 돈 ${fmt(usable)}원은 첫해 인출(연 ${fmt(yearDraw)}원) 기준 약 ${(usable / yearDraw).toFixed(1)}년치로 ${CASH_YEARS_TARGET}년치(${fmt(goal)}원)에 ${fmt(short)}원 모자랍니다.`
    : `바로 쓸 현금성이 없어 첫해 인출(연 ${fmt(yearDraw)}원) 기준 ${CASH_YEARS_TARGET}년치(${fmt(goal)}원)가 모두 모자랍니다.`;
  const how = fromBond > 0.5
    ? ` 지금 주식형을 팔면 떨어진 값에 손실을 확정하니, 채권형(지금 ${fmt(bond)}원)에서 ${fmt(fromBond)}원을 먼저 꺼내 쓰세요.${left > 0.5 ? ` 채권형을 다 꺼내도 ${fmt(left)}원이 모자라니 회복할 때까지 인출을 줄이거나(가드레일), 올랐다면 금 ETF 같은 대체자산 일부로 채우세요.` : ''}`
    : ` 꺼낼 채권형도 없어, 회복할 때까지 인출을 줄이거나(가드레일) 올랐다면 금 ETF 같은 대체자산 일부로 채우세요.`;
  const outNote = pensionBondOutNote(b);
  return {
    area: '노후', level: 'caution',
    title: fromBond > 0.5 ? `${BEAR_RX_TITLE} — 채권형에서 ${fmt(fromBond)}원 먼저 꺼내기` : `${BEAR_RX_TITLE} — 인출 줄이기`,
    detail: `인출 계획 ‘인출용 자산 배치 가이드’에 넣은 등락률(고점 대비 ${dd}%${date ? `, ${date.text}` : ''})이 하락장 기준(−${BEAR_DROP}% 이하)입니다. ${have}${how}${outNote} 주식형이 회복하면 고점 부근에서 일부를 팔아 현금성 바구니를 다시 채웁니다.`,
  };
}

/** 고점 부근 처방 제목 앞부분 */
export const PEAK_RX_TITLE = '고점 부근: 주식형 일부 팔아 현금성';

/**
 * 고점 부근 처방: 저장한 등락률이 0% 이상(고점 부근)이고 바로 쓸 돈(c.usable)이 첫해 인출(yearDraw) 기준 2년치에 못 미치면,
 * 값이 오른 지금 주식형 일부를 팔아 모자란 금액을 현금성 바구니에 채우라는 처방(peakPlan, 이정표 할 일과 같은 금액).
 * equity 가 BondsOnHand 면 55세 전 연금계좌 안 주식형을 뺀 usable 을 쓰고, 뺀 금액이 있으면 제외 안내를 붙임
 */
export function peakPrescription(profile: Pick<Profile, 'marketDrawdown' | 'marketDrawdownDate'>, c: Pick<CashOnHand, 'usable'>, yearDraw: number, equity: number | BondsOnHand, now: Date): Prescription | null {
  const b = peakPlan(profile.marketDrawdown, c.usable, yearDraw, equity);
  if (!b) return null;
  const { goal, usable, short, equity: sell, fromEquity, left } = b;
  const date = marketDateNote(profile.marketDrawdownDate, now);
  const have = usable > 0.5
    ? `바로 쓸 돈 ${fmt(usable)}원은 첫해 인출(연 ${fmt(yearDraw)}원) 기준 약 ${(usable / yearDraw).toFixed(1)}년치로 ${CASH_YEARS_TARGET}년치(${fmt(goal)}원)에 ${fmt(short)}원 모자랍니다.`
    : `바로 쓸 현금성이 없어 첫해 인출(연 ${fmt(yearDraw)}원) 기준 ${CASH_YEARS_TARGET}년치(${fmt(goal)}원)가 모두 모자랍니다.`;
  const how = fromEquity > 0.5
    ? ` 값이 오른 지금 주식형(지금 ${fmt(sell)}원) 가운데 ${fmt(fromEquity)}원을 팔아 입출금·파킹통장·MMF 같은 현금성 바구니에 채워 두면, 다음 하락장에 주식을 팔지 않고 버틸 수 있습니다.${left > 0.5 ? ` 주식형을 다 팔아도 ${fmt(left)}원이 모자라니 나머지는 저축으로 채우세요.` : ''}`
    : ' 팔 주식형이 없어 모자란 금액은 저축으로 현금성 바구니에 채우세요.';
  return {
    area: '노후', level: 'caution',
    title: fromEquity > 0.5 ? `${PEAK_RX_TITLE} ${fmt(fromEquity)}원 채우기` : `고점 부근: 팔 주식형이 없어 저축으로 현금성 ${fmt(short)}원 채우기`,
    detail: `인출 계획 ‘인출용 자산 배치 가이드’에 넣은 등락률(고점 대비 ${profile.marketDrawdown}%${date ? `, ${date.text}` : ''})이 고점 부근(0% 이상)입니다. ${have}${how}${pensionEquityOutNote(b)}`,
  };
}

/**
 * 만기일시 상환 대출 점검: 만기 나이가 없으면 입력 요청, 있으면 만기에 원금을 금융자산으로 갚을 수 있는지
 * (평균 수익 가정 경로에서 만기 해 초 잔액 대비 원금, 상환 뒤 잔액)를 알려 줌
 */
export function bulletPrescriptions(input: PlanInput): Prescription[] {
  const out: Prescription[] = [];
  for (const d of (input.debts ?? []).filter((x) => x.bullet && !Number.isFinite(x.endAge))) {
    if (d.openEnded) {
      // 일부러 만기를 정하지 않은 대출(지인 대출 등): 경고가 아니라 계산 방식을 알려 주는 참고
      out.push({
        area: '부채', level: 'good', badge: '참고',
        title: `${d.name ?? '대출'} 만기 미정(이자만 납입)`,
        detail: `만기를 정하지 않은 대출로 보고${d.annual > 0 ? ` 이자 월 ${fmt(d.annual / 12)}원을 기대수명까지 계속 내는 것으로` : ' 이자만 내는 것으로'} 계산했습니다. 원금${d.principal ? ` ${fmt(d.principal)}원` : ''}은 갚는 시점이 없어 노후 계산에 넣지 않았습니다(기대수명 때도 빚으로 남음). 갚을 시기가 정해지면 ‘기본 정보 → 부채’에서 상환 방식을 ‘만기일시 상환’으로 바꾸고 상환 종료 나이에 그 나이를 넣으세요.`,
      });
      continue;
    }
    out.push({
      area: '부채', level: 'danger',
      title: `${d.name ?? '대출'} 만기 나이 입력 필요`,
      detail: `만기일시 상환 대출인데 상환 종료 나이(만기)가 비어 있어 원금 상환이 계산에 빠져 있습니다${d.annual > 0 ? `(이자 월 ${fmt(d.annual / 12)}원은 평생 나가는 것으로 계산)` : ''}. ‘기본 정보 → 부채’에서 ‘상환 종료 나이’에 만기 나이를 넣으세요.`,
    });
  }
  const repays = input.goals.filter((g) => g.loan && g.age >= input.currentAge);
  if (repays.length === 0) return out;
  const { balances } = deterministicPath(input);
  for (const g of repays) {
    const i = g.age - input.currentAge;
    const before = balances[i] ?? 0;
    const after = balances[i + 1] ?? 0;
    const share = before > 0 ? (g.amount / before) * 100 : Infinity;
    const level = after <= 0 ? 'danger' : share > 50 ? 'caution' : 'good';
    const when = g.age < input.retireAge ? '은퇴 전' : '은퇴 후';
    out.push({
      area: '부채', level,
      title: `${g.loan} ${g.age}세 만기 원금 ${fmt(g.amount)}원 상환${level === 'danger' ? ' — 금융자산 부족' : ''}`,
      detail:
        `${when} ${g.age}세에 원금을 금융자산에서 한 번에 갚는 것으로 계산했습니다(오늘 물가 기준). ` +
        `평균 수익 가정으로 원금은 그 해 초 금융자산 ${fmt(before)}원${Number.isFinite(share) ? `의 ${share.toFixed(0)}%` : ''}이고, 상환 뒤 연말 잔액은 ${fmt(after)}원입니다. ` +
        (level === 'danger'
          ? '갚을 돈이 모자랍니다. 만기 연장·분할 상환 전환이나 미리 상환 자금 적립을 검토하세요.'
          : level === 'caution'
            ? '금융자산의 절반 넘게 빠집니다. 만기 전 중도상환이나 상환용 적립을 따로 두는 것을 검토하세요.'
            : '지금 계획대로면 만기에 갚을 수 있습니다.'),
    });
  }
  return out;
}

/** 부호 있는 금액: −476만 / 120만 */
const signed = (v: number) => (v < 0 ? `−${fmt(-v)}` : fmt(v));

/** 필요 월 저축 처방. 지금 저축 여력이 마이너스(매달 자산에서 꺼내 씀)여도 자연스럽게 읽히도록 */
export function savingsPrescription(s: Pick<Summary, 'income' | 'savings'>, need: number, target: number, freed = 0): Prescription {
  const note = freed > 0 ? ` (은퇴 전 대출 상환이 끝나며 늘어나는 저축 월 ${fmt(freed / 12)}원은 별도로 반영됨)` : '';
  const gap = need - s.savings;
  const rate = (v: number) => (s.income > 0 ? (v / s.income) * 100 : null);
  const from = rate(s.savings);
  const to = rate(need);
  const level: Level = s.savings < 0 || (from !== null && to !== null && to - from > 15) ? 'danger' : 'caution';
  if (s.savings < 0) {
    return {
      area: '저축', level,
      title: need >= 0
        ? `월 ${fmt(-s.savings)}원 부족 → 월 ${fmt(need)}원 저축으로 전환 필요`
        : `월 부족분 ${fmt(-s.savings)}원 → ${fmt(-need)}원 이하로 줄여야 함`,
      detail:
        `지금은 지출이 소득보다 많아 매달 ${fmt(-s.savings)}원을 금융자산에서 꺼내 쓰는 것으로 계산했습니다. ` +
        `노후 성공확률 ${target}%를 맞추려면 월 저축 여력을 ${signed(s.savings)}원 → ${signed(need)}원으로 월 ${fmt(gap)}원 개선해야 합니다(소득을 늘리거나 지출을 줄이기).` +
        // 저축률은 0~100% 안일 때만 의미가 있어 그때만 덧붙임
        (to !== null && to >= 0 && to <= 100 ? ` 목표 저축률은 ${to.toFixed(0)}%입니다.` : '') +
        note,
    };
  }
  return {
    area: '저축', level,
    title: from !== null && to !== null ? `저축률 ${from.toFixed(0)}% → ${to.toFixed(0)}%로 상향 필요` : `월 저축 ${fmt(s.savings)}원 → ${fmt(need)}원 상향 필요`,
    detail: `노후 성공확률 ${target}% 달성을 위해 월 저축을 ${fmt(s.savings)}원 → ${fmt(need)}원으로 늘려야 합니다.${note}`,
  };
}

/** 목적자금 월 적립 처방. 저축 여력이 마이너스면 부족분까지 메워야 적립이 시작된다는 점을 함께 보여 줌 */
export function goalPrescription(savings: number, goalMonthly: number): Prescription {
  const title = `목적자금 월 적립 ${fmt(goalMonthly)}원 필요`;
  if (savings < 0) {
    return {
      area: '목표', level: 'danger',
      title: `${title} — 지금은 매달 ${fmt(-savings)}원 부족`,
      detail: `지금은 지출이 소득보다 많아 적립할 돈이 없고, 오히려 매달 ${fmt(-savings)}원을 금융자산에서 꺼내 씁니다. 목표대로 적립하려면 소득을 늘리거나 지출을 줄여 부족분까지 합친 월 ${fmt(goalMonthly - savings)}원(부족분 ${fmt(-savings)}원 + 적립 ${fmt(goalMonthly)}원)을 마련해야 합니다. 어렵다면 목표 시기·금액 조정을 검토하세요.`,
    };
  }
  return goalMonthly > savings
    ? { area: '목표', level: 'danger', title, detail: `현재 저축여력(${fmt(savings)}원)보다 월 ${fmt(goalMonthly - savings)}원 많습니다. 목표 시기·금액 조정 또는 지출 절감이 필요합니다.` }
    : { area: '목표', level: 'good', title, detail: `현재 저축여력 ${fmt(savings)}원 안에서 감당 가능합니다.` };
}

/**
 * 매년 반복 지출(예: 보유세 59~100세) 준비 참고: 시작 나이까지 모을 금액과 월 적립액.
 * 반복 지출은 노후 진단에서 해마다 지출로 이미 빠지므로 목적자금 적립 합계·성공확률 처방에는 더하지 않는 참고값.
 */
export function recurringGoalPrescription(goalPlans: GoalPlan[]): Prescription | null {
  const rec = goalPlans.filter((g) => g.recurring);
  if (!rec.length) return null;
  const monthly = rec.reduce((a, g) => a + g.monthlyNeeded, 0);
  const items = rec.map((g) => `${g.goal.name}(${g.recurring!.fromAge}~${g.recurring!.toAge}세): ${g.recurring!.fromAge}세까지 ${fmt(g.futureValue)}원${g.monthlyNeeded > 0 ? `, 월 ${fmt(g.monthlyNeeded)}원` : ' 준비됨'}`);
  return {
    area: '목표', level: 'good', badge: '참고',
    title: monthly > 0 ? `매년 반복 지출 따로 모으면 월 ${fmt(monthly)}원` : '매년 반복 지출 준비됨',
    detail: `${items.join(' · ')}. 반복 지출은 노후 진단에서 해마다 지출로 이미 계산되므로, 이 금액은 목적자금 적립 합계와 성공확률 처방에 더하지 않았습니다(이중으로 세지 않음). 따로 떼어 모으면 노후자금 일부를 이 용도로 미리 나눠 두는 셈입니다.`,
  };
}

/**
 * 이미 은퇴해 인출 중일 때의 목표 안내(참고): 따로 적립할 기간이 없으므로 월 적립액 대신
 * 앞으로 쓸 목적자금·반복 지출이 인출 계획에 들어 있음을 알려 줌
 */
export function retiredGoalPrescription(goalPlans: GoalPlan[]): Prescription | null {
  if (!goalPlans.length) return null;
  const items = goalPlans.map((g) =>
    g.recurring
      ? `${g.goal.name}(${g.recurring.fromAge}~${g.recurring.toAge}세, 첫해 ${fmt(g.recurring.firstPayment)}원)`
      : `${g.goal.name}(${g.goal.targetAge}세 ${fmt(g.futureValue)}원)`,
  );
  const short = goalPlans.filter((g) => g.fundedRatio < 99.5).length;
  return {
    area: '목표', level: 'good', badge: '참고',
    title: `앞으로 쓸 목적자금·반복 지출 ${goalPlans.length}건 — 인출 계획에 포함됨`,
    detail:
      `${items.join(' · ')}. 이미 인출 중이라 따로 적립하는 대신 그 해에 금융자산에서 꺼내 쓰는 것으로 노후 진단·인출 계획에 반영했습니다(그 해 금액). ` +
      (short > 0 ? `이 가운데 ${short}건은 ‘중기·목적자금’ 용도 자산으로 다 떼어 두지 못했습니다. 가까운 지출부터 현금성·채권으로 옮겨 두면 하락장에 주식을 팔지 않아도 됩니다. ` : '') +
      '줄였을 때의 효과는 ‘인출 계획 → 목돈 지출 민감도’에서 볼 수 있습니다.',
  };
}

/**
 * 비상금 처방: 월 지출 기준 부족분과, 저축 여력이 마이너스면 그 부족분으로 비상금이 몇 개월 뒤 바닥나는지.
 * 월 지출 기준으로는 충분해도 매달 줄고 있으면 주의로 알림
 */
export function emergencyPrescription(s: Summary, target: number, retired = false): Prescription | null {
  const em = emergencyMonths(s);
  // 이미 은퇴해 인출 중이면 소득보다 많은 지출은 계획된 자산 인출이라 ‘부족분으로 몇 개월 뒤 바닥’ 경고는 하지 않음
  if (retired) {
    if (em >= target) return null;
    return {
      area: '비상금', level: em < target / 2 ? 'danger' : 'caution',
      title: `현금성 자산 ${(target - em).toFixed(1)}개월분(${fmt((target - em) * s.expense)}원) 부족`,
      detail: `단기·비상금 용도의 예금·현금성 자산이 월 지출의 ${em.toFixed(1)}개월분입니다(목표 ${target}개월). 인출 중에는 앞으로 1~2년치 인출분을 현금성(MMF·예금)으로 두어야 하락장에 주식을 팔지 않아도 됩니다. 연금계좌 안의 현금성 상품으로 두고 있다면 ‘인출 계획 → 인출용 자산 배치 가이드’의 계좌별 바구니 목표와 비교해 보세요.`,
    };
  }
  const run = emergencyRunway(s);
  const drain = Number.isFinite(run)
    ? ` 지금은 매달 ${fmt(-s.savings)}원이 모자라 이를 비상금에서 메우면 약 ${run.toFixed(1)}개월 뒤 바닥납니다. 채워 넣기 전에 지출을 줄여 부족분부터 없애야 합니다.`
    : '';
  if (em < target) {
    const short = (target - em) * s.expense;
    return {
      area: '비상금', level: em < target / 2 || run < target ? 'danger' : 'caution',
      title: `비상금 ${(target - em).toFixed(1)}개월분(${fmt(short)}원) 부족${Number.isFinite(run) ? ` · 부족분으로 ${run.toFixed(1)}개월 뒤 소진` : ''}`,
      detail: `단기·비상금 용도의 예금·현금성 자산을 먼저 채우세요. 투자자산을 급하게 팔지 않도록 하는 안전판입니다.${drain}`,
    };
  }
  if (Number.isFinite(run)) {
    return {
      area: '비상금', level: run < target ? 'danger' : 'caution',
      title: `비상금 ${em.toFixed(1)}개월분 — 매달 부족분으로 ${run.toFixed(1)}개월 뒤 소진`,
      detail: `월 지출 기준으로는 목표 ${target}개월을 채웠습니다.${drain}`,
    };
  }
  return null;
}

/**
 * 하락장 가드레일 처방: 강도별 조합(하락장 기준 × 생활비 감축) 가운데 목표 확률을 넘는 가장 약한 설정.
 * 평생 줄이는 생활비 부담(평균 감축 연수 × 감축 비율)이 가장 작은 조합을 고르고, 없으면 가장 강한 조합으로도 모자란다고 알림
 */
export function guardrailPrescription(input: PlanInput, successRate: number, target: number, startAge: number, lifeExpectancy: number): Prescription | null {
  const { pick, best } = weakestGuardrail(input, target);
  const living = input.fixedDraw !== undefined ? input.fixedDraw * nominalFactor(0, input.inflation, startAge - Math.max(input.currentAge, input.retireAge)) : expenseAt(input, startAge);
  if (pick) {
    const s = pick.sim;
    return {
      area: '노후', level: 'caution',
      title: `하락장 가드레일(최고점 −${pick.drop}% 이하인 해 생활비 −${pick.cut}%) 적용 시 목표 달성`,
      detail:
        `시장이 최고점보다 ${pick.drop}% 이상 떨어진 해에만 은퇴 후 생활비를 ${pick.cut}%(${startAge}세 기준 월 약 ${fmt((living * pick.cut) / 100 / 12)}원) 줄이면 성공확률이 ${successRate.toFixed(0)}% → ${s.successRate.toFixed(0)}%가 됩니다. ` +
        `${lifeExpectancy}세까지 줄이는 해는 평균 ${s.cutYearsAvg.toFixed(1)}년이고, 목표를 넘는 조합 가운데 줄이는 부담이 가장 작은 설정입니다. ‘기본 정보 → 점검기준’의 ‘하락장 기준’·‘하락장 생활비 감축’을 이 값으로 바꾸면 노후 진단에서 비교해 볼 수 있습니다.`,
    };
  }
  if (best.sim.successRate <= successRate + 0.5) return null;
  return {
    area: '노후', level: 'caution',
    title: `하락장 가드레일만으로는 목표 ${target}% 미달(가장 효과 큰 설정 ${best.sim.successRate.toFixed(0)}%)`,
    detail: `최고점 −${best.drop}% 이하인 해에 생활비를 ${best.cut}% 줄여도 성공확률은 ${successRate.toFixed(0)}% → ${best.sim.successRate.toFixed(0)}%입니다. 하락장 대응만으로는 부족하니 위의 다른 조정안(생활비 등)과 함께 써야 합니다.`,
  };
}

/** retax: 저축·수익률·은퇴 나이·생활비를 바꿔 역산할 때 연금 인출 세금도 바뀐 계획으로 다시 계산(없으면 지금 세금 그대로) */
export function prescriptions(profile: Profile, s: Summary, input: PlanInput, successRate: number, goalPlans: GoalPlan[], ins: InsuranceGap, retax?: Retax, cash?: CashOnHand, bonds?: BondsOnHand, equity?: BondsOnHand, now: Date = new Date()): Prescription[] {
  const c = profile.criteria;
  const rt: Retax = retax ?? ((x) => x);
  const out: Prescription[] = [];

  const debts = input.debts ?? [];
  const freed = debts.filter((x) => x.endAge < input.retireAge).reduce((a, x) => a + x.annual, 0);
  const st = withdrawStart(input);
  const retired = st.retired;

  if (successRate < c.successTarget) {
    // 이미 은퇴했으면 저축·은퇴 나이 처방은 의미가 없어 건너뜀
    // 저축 여력이 마이너스(매달 자산에서 꺼내 씀)면 하한도 그만큼 내려, '부족분을 얼마로 줄이면 되는지'까지 찾음
    const needSavings = retired ? null : solveFor(input, (i, v) => rt({ ...i, annualSavings: v * 12 }), Math.min(0, s.savings), Math.max(500, s.income * 2, -s.savings * 2), c.successTarget);
    if (needSavings !== null && needSavings > s.savings + 1) {
      out.push(savingsPrescription(s, needSavings, c.successTarget, freed));
    }
    // 이미 은퇴했으면 은퇴 후 수익률을, 아니면 은퇴 전 수익률을 역산
    const curReturn = retired ? (input.retireMeanReturn ?? input.meanReturn) : input.meanReturn;
    const needReturn = retired
      ? solveFor(input, (i, v) => rt({ ...i, retireMeanReturn: v, retireVolatility: Math.max(i.retireVolatility ?? i.volatility, v * 2) }), curReturn, 12, c.successTarget)
      : solveFor(input, (i, v) => rt({ ...i, meanReturn: v, volatility: Math.max(i.volatility, v * 2) }), input.meanReturn, 12, c.successTarget);
    if (needReturn !== null && needReturn > curReturn + 0.1) {
      out.push({
        area: '투자', level: 'caution',
        title: `기대수익률 ${curReturn.toFixed(1)}% → ${needReturn.toFixed(1)}% 조정 검토`,
        detail: retired
          ? `다른 조건을 유지할 경우 운용 수익률을 ${needReturn.toFixed(1)}%까지 올려야 합니다(변동성도 함께 커집니다). 인출 중에는 위험을 키우기보다 인출액·지출을 먼저 조정하는 편이 안전합니다.`
          : `저축을 그대로 둘 경우 ${input.retireMeanReturn !== undefined ? "은퇴 전 " : ""}포트폴리오 기대수익률을 ${needReturn.toFixed(1)}%까지 올려야 합니다(변동성도 함께 커집니다). 투자형 비중 확대를 검토하세요.`,
      });
    }
    const needAge = retired ? null : solveFor(input, (i, v) => rt({ ...i, retireAge: Math.round(v) }), input.retireAge, Math.min(75, profile.lifeExpectancy - 1), c.successTarget);
    if (needAge !== null && Math.round(needAge) > input.retireAge) {
      out.push({
        area: '노후', level: 'caution',
        title: `은퇴 시점 ${input.retireAge}세 → ${Math.round(needAge)}세 조정 시 목표 달성`,
        detail: s.savings < 0
          ? `다른 조건을 유지할 때 은퇴를 늦추면 인출 기간이 줄어듭니다. 다만 지금은 매달 ${fmt(-s.savings)}원이 모자라 은퇴 전에도 자산이 줄고 있으므로, 은퇴를 늦추는 것만으로는 부족하고 지출을 줄이는 것이 먼저입니다.`
          : '다른 조건을 유지할 때 은퇴를 늦추면 적립 기간이 늘고 인출 기간이 줄어듭니다.',
      });
    }
    if (input.fixedDraw !== undefined) {
      // 인출액 고정 방식은 생활비를 바꿔도 결과가 같으므로 월 고정 인출액을 역산
      const drawNow = input.fixedDraw / 12;
      const needDraw = solveFor(input, (i, v) => rt({ ...i, fixedDraw: v * 12 }), Math.min(50, drawNow), drawNow, c.successTarget, false);
      if (needDraw !== null && needDraw < drawNow - 1) {
        out.push({
          area: '노후', level: 'caution',
          title: `월 고정 인출액 ${fmt(drawNow)}원 → ${fmt(needDraw)}원`,
          detail: '현재 계획만으로 목표 확률을 맞추려면 연금으로 쓰는 월 고정 금액(국민·개인연금 + 자산 인출)을 이만큼 낮춰야 합니다. ‘기본 정보 → 프로필 → 노후 계획’의 ‘연금으로 쓰는 월 금액(세후)’에서 바꿉니다.',
        });
      }
    } else {
      const fixedExpense = solveFor(input, (i, v) => rt({ ...i, retireExpenseAnnual: v * 12 }), 50, profile.retireMonthlyExpense, c.successTarget, false);
      if (fixedExpense !== null && fixedExpense < profile.retireMonthlyExpense - 1) {
        out.push({
          area: '노후', level: 'caution',
          title: `은퇴 후 월 생활비 ${fmt(profile.retireMonthlyExpense)}원 → ${fmt(fixedExpense)}원`,
          detail: '현재 계획만으로 목표 확률을 맞추려면 은퇴 생활비 눈높이를 조정해야 합니다.',
        });
      }
    }
    const gRx = guardrailPrescription(input, successRate, c.successTarget, st.age, profile.lifeExpectancy);
    if (gRx) out.push(gRx);
  } else {
    out.push({ area: '노후', level: 'good', title: `노후 성공확률 ${successRate.toFixed(0)}% — 목표 달성`, detail: '현재 계획을 유지하면서 정기적으로 점검하세요.' });
  }

  // 인출률: 첫해 자산에서 꺼내는 금액 / 금융자산
  if (Number.isFinite(st.rate) && st.outflow > 0) {
    const wl = withdrawLevel(st.rate, c.withdrawRateMax);
    const safe = (st.balance * ((c.withdrawRateMax * 2) / 3)) / 100 / 12;
    out.push({
      area: '노후', level: wl,
      title: `${retired ? '현재' : `은퇴 첫해(${st.age}세)`} 인출률 ${st.rate.toFixed(1)}%${wl === 'danger' ? ` — 상한 ${c.withdrawRateMax}% 초과` : wl === 'caution' ? ' — 상한에 근접' : ''}`,
      detail: wl === 'good'
        ? `금융자산 ${fmt(st.balance)}원에서 연 ${fmt(st.outflow)}원을 꺼내는 수준으로 무리가 없습니다.`
        : `금융자산 ${fmt(st.balance)}원에서 연 ${fmt(st.outflow)}원(월 ${fmt(st.outflow / 12)}원)을 꺼냅니다. 월 인출을 ${fmt(safe)}원 안팎으로 낮추거나, 연금·임대료 같은 소득을 늘리거나, 가드레일 방식으로 하락장에 인출을 줄이는 방안을 검토하세요.`,
    });
  }

  const emRx = emergencyPrescription(s, c.emergencyMonths, retired);
  if (emRx) out.push(emRx);
  out.push(...maturityPrescriptions(s, goalPlans, profile.birthYear + s.age, c.emergencyMonths));
  const cashRx = cash ? cashBucketPrescription(cash, cashRunway(cash, st, input.currentAge), profile) : null;
  if (cashRx) out.push(cashRx);
  else {
    const outRx = cash ? pensionOutPrescription(cash, cashRunway(cash, st, input.currentAge), profile) : null;
    if (outRx) out.push(outRx);
  }
  // 하락장: 바로 쓸 돈이 2년치에 못 미치면 채권형부터 꺼낼 금액
  const bearRx = cash ? marketPrescription(profile, cash, st.outflow, bonds ?? s.byClass.find((x) => x.key === 'bond')?.value ?? 0, now) : null;
  if (bearRx) out.push(bearRx);
  // 고점 부근: 바로 쓸 돈이 2년치에 못 미치면 주식형 일부를 팔아 채울 금액
  const peakRx = cash ? peakPrescription(profile, cash, st.outflow, equity ?? s.byClass.find((x) => x.key === 'equity')?.value ?? 0, now) : null;
  if (peakRx) out.push(peakRx);

  const debtRatio = s.totalAssets > 0 ? (s.totalDebt / s.totalAssets) * 100 : 0;
  if (debtRatio > c.debtRatioMax) {
    out.push({ area: '부채', level: 'danger', title: `부채비율 ${debtRatio.toFixed(0)}% — 상한 ${c.debtRatioMax}% 초과`, detail: '금리가 높은 대출부터 상환 계획을 세우세요.' });
  }

  out.push(...bulletPrescriptions(input));

  // 은퇴 후까지 이어지는 대출: 은퇴 전 상환 완료를 권고(만기 나이 없는 만기일시 대출은 위에서 따로 안내)
  for (const x of debts.filter((d) => d.endAge > input.retireAge && !(d.bullet && !Number.isFinite(d.endAge)))) {
    const endless = !Number.isFinite(x.endAge);
    out.push({
      area: '부채', level: endless ? 'danger' : 'caution',
      title: endless ? `${x.name ?? '대출'} 상환이 끝나지 않음` : `${x.name ?? '대출'} 은퇴 후 ${x.endAge - 1}세까지 상환`,
      detail: endless
        ? `월 상환액이 이자보다 적습니다. 은퇴 후에도 월 ${fmt(x.annual / 12)}원이 계속 나가는 것으로 계산했습니다. 상환액을 늘리거나 상환 종료 나이를 입력하세요.`
        : `은퇴 후에도 월 ${fmt(debtAnnualAt(x, input.retireAge) / 12)}원${x.decline ? '(원금균등이라 해마다 줄어듦)' : ''}을 ${x.inDraw ? '연금 생활비 월 금액에서' : '자산에서 꺼내'} 갚아야 합니다. 은퇴 전 중도상환이나 상환 기간 단축을 검토하세요.`,
    });
  }
  // 은퇴 전 상환이 끝나는 대출: 늘어나는 저축을 노후자금으로 돌리도록 안내
  const early = debts.filter((d) => d.annual > 0 && d.endAge > s.age && d.endAge < input.retireAge);
  if (early.length > 0) {
    out.push({
      area: '저축', level: 'good',
      title: `대출 상환 완료 후 월 ${fmt(early.reduce((a, d) => a + d.annual, 0) / 12)}원 저축 증가`,
      detail: `${early.map((d) => `${d.name ?? '대출'} ${d.endAge}세`).join(', ')} 상환 종료 후 상환액을 그대로 저축·투자한다고 가정했습니다. 생활비로 새지 않도록 자동이체를 걸어 두세요.`,
    });
  }

  // 은퇴 전 보험 납입이 끝나는 경우: 늘어나는 저축을 노후자금으로 돌리도록 안내
  const paidUp = (input.savingsChanges ?? []).filter((c) => c.annual > 0 && c.fromAge > s.age && c.fromAge < input.retireAge && c.name?.endsWith('납입 완료'));
  if (paidUp.length > 0) {
    out.push({
      area: '저축', level: 'good',
      title: `보험 납입 완료 후 월 ${fmt(paidUp.reduce((x, c) => x + c.annual, 0) / 12)}원 저축 증가`,
      detail: `${paidUp.map((c) => `${c.name!.replace(/ 납입 완료$/, '')} ${c.fromAge}세`).join(', ')}부터 보험료를 내지 않아 그만큼 저축·투자한다고 가정했습니다. 납입이 끝나면 같은 금액을 자동이체로 연금저축·IRP 등에 돌리세요.`,
    });
  }

  const target = RISK_PROFILES[profile.riskProfile].investShare;
  if (Math.abs(s.investShare - target) > 15) {
    out.push({
      area: '투자', level: 'caution',
      title: `투자형 비중 ${s.investShare.toFixed(0)}% → ${target}% 리밸런싱`,
      detail: `${RISK_PROFILES[profile.riskProfile].label} 성향 기준 권장 비중과 차이가 큽니다.`,
    });
  }
  out.push(...isaPrescriptions(s, profile.birthYear + s.age, (profile.contrib?.selfRate ?? 0) > 0));

  if (retired) {
    // 인출 중에는 월 적립 처방 대신 인출 계획에 들어 있다는 안내만
    const goalRx = retiredGoalPrescription(goalPlans);
    if (goalRx) out.push(goalRx);
  } else {
    const goalMonthly = onceGoalPlans(goalPlans).reduce((a, g) => a + g.monthlyNeeded, 0);
    if (goalMonthly > 0) out.push(goalPrescription(s.savings, goalMonthly));
    const recRx = recurringGoalPrescription(goalPlans);
    if (recRx) out.push(recRx);
  }

  for (const l of ins.lines) {
    if (l.level !== 'good') out.push({ area: '보장', level: l.level, title: `${ins.people.length > 1 ? `${l.person} ` : ''}${l.label} ${fmt(l.gap)}원 부족`, detail: `필요 ${fmt(l.need)}원${l.basis ? `(${l.basis})` : ''} 대비 현재 ${fmt(l.current)}원(${l.ratio.toFixed(0)}%).` });
  }
  for (const n of ins.notes) out.push({ area: '보장', level: 'caution', title: '보험 구조 점검', detail: n });

  const order: Record<Level, number> = { danger: 0, caution: 1, good: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

export interface BucketRow { key: 'short' | 'mid' | 'long'; label: string; current: number; target: number }

/** 목적별 자산 바구니: 현재 배치 vs 권장 배치 */
export function bucketMap(profile: Profile, s: Summary, goalPlans: GoalPlan[]): BucketRow[] {
  const cur = (k: string) => s.byPurpose.find((p) => p.key === k)?.value ?? 0;
  const shortTarget = s.expense * profile.criteria.emergencyMonths;
  const midTarget = onceGoalPlans(goalPlans).filter((g) => g.years <= 10).reduce((a, g) => a + g.futureValue / Math.pow(1.03, g.years), 0);
  const total = s.financialAssets; // 부동산은 바구니에 넣지 않음
  return [
    { key: 'short', label: '비상금 바구니', current: cur('short'), target: Math.min(total, shortTarget) },
    { key: 'mid', label: '목적자금 바구니', current: cur('mid'), target: Math.max(0, Math.min(total - shortTarget, midTarget)) },
    { key: 'long', label: '노후자금 바구니', current: cur('long'), target: Math.max(0, total - shortTarget - midTarget) },
  ];
}
