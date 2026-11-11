import { won } from '../lib/format';
import type { Level, Profile } from '../types';
import type { GoalPlan } from './goals';
import type { InsuranceGap } from './insurance';
import { debtAnnualAt, deterministicPath, solveFor, withdrawStart, type PlanInput } from './montecarlo';
import { RISK_PROFILES, type Summary } from './portfolio';
import { emergencyMonths, emergencyRunway, withdrawLevel } from './risk';

export interface Prescription {
  title: string;
  detail: string;
  level: Level;
  area: '저축' | '투자' | '노후' | '비상금' | '부채' | '보장' | '목표';
}

/** 만원 → "3,500만" / "1.25억" (뒤에 '원'은 문장에서 붙임) */
const fmt = (v: number) => won(v, false);

/**
 * 만기일시 상환 대출 점검: 만기 나이가 없으면 입력 요청, 있으면 만기에 원금을 금융자산으로 갚을 수 있는지
 * (평균 수익 가정 경로에서 만기 해 초 잔액 대비 원금, 상환 뒤 잔액)를 알려 줌
 */
export function bulletPrescriptions(input: PlanInput): Prescription[] {
  const out: Prescription[] = [];
  for (const d of (input.debts ?? []).filter((x) => x.bullet && !Number.isFinite(x.endAge))) {
    out.push({
      area: '부채', level: 'danger',
      title: `${d.name ?? '대출'} 만기 나이 입력 필요`,
      detail: `만기일시 상환 대출인데 상환 종료 나이(만기)가 비어 있어 원금 상환이 계산에 빠져 있습니다${d.annual > 0 ? `(이자 월 ${fmt(d.annual / 12)}원은 평생 나가는 것으로 계산)` : ''}. 데이터·설정 → 부채에서 만기 나이를 넣으세요.`,
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
 * 비상금 처방: 월 지출 기준 부족분과, 저축 여력이 마이너스면 그 부족분으로 비상금이 몇 개월 뒤 바닥나는지.
 * 월 지출 기준으로는 충분해도 매달 줄고 있으면 주의로 알림
 */
export function emergencyPrescription(s: Summary, target: number): Prescription | null {
  const em = emergencyMonths(s);
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

export function prescriptions(profile: Profile, s: Summary, input: PlanInput, successRate: number, goalPlans: GoalPlan[], ins: InsuranceGap): Prescription[] {
  const c = profile.criteria;
  const out: Prescription[] = [];

  const debts = input.debts ?? [];
  const freed = debts.filter((x) => x.endAge < input.retireAge).reduce((a, x) => a + x.annual, 0);
  const st = withdrawStart(input);
  const retired = st.retired;

  if (successRate < c.successTarget) {
    // 이미 은퇴했으면 저축·은퇴 나이 처방은 의미가 없어 건너뜀
    // 저축 여력이 마이너스(매달 자산에서 꺼내 씀)면 하한도 그만큼 내려, '부족분을 얼마로 줄이면 되는지'까지 찾음
    const needSavings = retired ? null : solveFor(input, (i, v) => ({ ...i, annualSavings: v * 12 }), Math.min(0, s.savings), Math.max(500, s.income * 2, -s.savings * 2), c.successTarget);
    if (needSavings !== null && needSavings > s.savings + 1) {
      out.push(savingsPrescription(s, needSavings, c.successTarget, freed));
    }
    // 이미 은퇴했으면 은퇴 후 수익률을, 아니면 은퇴 전 수익률을 역산
    const curReturn = retired ? (input.retireMeanReturn ?? input.meanReturn) : input.meanReturn;
    const needReturn = retired
      ? solveFor(input, (i, v) => ({ ...i, retireMeanReturn: v, retireVolatility: Math.max(i.retireVolatility ?? i.volatility, v * 2) }), curReturn, 12, c.successTarget)
      : solveFor(input, (i, v) => ({ ...i, meanReturn: v, volatility: Math.max(i.volatility, v * 2) }), input.meanReturn, 12, c.successTarget);
    if (needReturn !== null && needReturn > curReturn + 0.1) {
      out.push({
        area: '투자', level: 'caution',
        title: `기대수익률 ${curReturn.toFixed(1)}% → ${needReturn.toFixed(1)}% 조정 검토`,
        detail: retired
          ? `다른 조건을 유지할 경우 운용 수익률을 ${needReturn.toFixed(1)}%까지 올려야 합니다(변동성도 함께 커집니다). 인출 중에는 위험을 키우기보다 인출액·지출을 먼저 조정하는 편이 안전합니다.`
          : `저축을 그대로 둘 경우 ${input.retireMeanReturn !== undefined ? "은퇴 전 " : ""}포트폴리오 기대수익률을 ${needReturn.toFixed(1)}%까지 올려야 합니다(변동성도 함께 커집니다). 투자형 비중 확대를 검토하세요.`,
      });
    }
    const needAge = retired ? null : solveFor(input, (i, v) => ({ ...i, retireAge: Math.round(v) }), input.retireAge, Math.min(75, profile.lifeExpectancy - 1), c.successTarget);
    if (needAge !== null && Math.round(needAge) > input.retireAge) {
      out.push({
        area: '노후', level: 'caution',
        title: `은퇴 시점 ${input.retireAge}세 → ${Math.round(needAge)}세 조정 시 목표 달성`,
        detail: '다른 조건을 유지할 때 은퇴를 늦추면 적립 기간이 늘고 인출 기간이 줄어듭니다.',
      });
    }
    const fixedExpense = solveFor(input, (i, v) => ({ ...i, retireExpenseAnnual: v * 12 }), 50, profile.retireMonthlyExpense, c.successTarget, false);
    if (fixedExpense !== null && fixedExpense < profile.retireMonthlyExpense - 1) {
      out.push({
        area: '노후', level: 'caution',
        title: `은퇴 후 월 생활비 ${fmt(profile.retireMonthlyExpense)}원 → ${fmt(fixedExpense)}원`,
        detail: '현재 계획만으로 목표 확률을 맞추려면 은퇴 생활비 눈높이를 조정해야 합니다.',
      });
    }
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

  const emRx = emergencyPrescription(s, c.emergencyMonths);
  if (emRx) out.push(emRx);

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
        : `은퇴 후에도 월 ${fmt(debtAnnualAt(x, input.retireAge) / 12)}원${x.decline ? '(원금균등이라 해마다 줄어듦)' : ''}을 자산에서 꺼내 갚아야 합니다. 은퇴 전 중도상환이나 상환 기간 단축을 검토하세요.`,
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

  const goalMonthly = goalPlans.reduce((a, g) => a + g.monthlyNeeded, 0);
  if (goalMonthly > 0) out.push(goalPrescription(s.savings, goalMonthly));

  for (const l of ins.lines) {
    if (l.level !== 'good') out.push({ area: '보장', level: l.level, title: `${ins.people.length > 1 ? `${l.person} ` : ''}${l.label} ${fmt(l.gap)}원 부족`, detail: `필요 ${fmt(l.need)}원 대비 현재 ${fmt(l.current)}원(${l.ratio.toFixed(0)}%).` });
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
  const midTarget = goalPlans.filter((g) => g.years <= 10).reduce((a, g) => a + g.futureValue / Math.pow(1.03, g.years), 0);
  const total = s.financialAssets; // 부동산은 바구니에 넣지 않음
  return [
    { key: 'short', label: '비상금 바구니', current: cur('short'), target: Math.min(total, shortTarget) },
    { key: 'mid', label: '목적자금 바구니', current: cur('mid'), target: Math.max(0, Math.min(total - shortTarget, midTarget)) },
    { key: 'long', label: '노후자금 바구니', current: cur('long'), target: Math.max(0, total - shortTarget - midTarget) },
  ];
}
