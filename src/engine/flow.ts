import { debtPaymentAt, GOAL_KIND_LABEL, GOAL_KINDS, goalBreakdownAt, incomeValue, pensionAt, retireOutflowAt, savingsAt, type PlanInput } from './montecarlo';

/** 연간 현금흐름 흐름도의 한 줄(연 금액, 오늘 물가) */
export interface FlowItem {
  key: string;
  label: string;
  amount: number;
  /** 색 구분: 소득·일시금·자산 인출 / 생활비·대출·세금·보험·목표·저축 */
  tone: 'income' | 'lump' | 'draw' | 'living' | 'debt' | 'tax' | 'premium' | 'goal' | 'save';
}

export interface YearFlow {
  age: number;
  retired: boolean;
  sources: FlowItem[]; // 들어오는 돈
  uses: FlowItem[]; // 나가는 돈(저축 포함)
  total: number; // 양쪽 합계(같음)
}

const EPS = 0.5;

/**
 * 그 나이 한 해의 돈 흐름(1년 전체 기준, 오늘 물가): 소득·일시금·금융자산 인출 → 생활비·대출·세금·보험료·목표 지출·저축.
 * 들어오는 돈이 모자라면 ‘금융자산에서 인출’이, 남으면 ‘금융자산에 더함’이 생겨 양쪽 합계가 같아짐.
 * 은퇴 전 생활 지출은 세후 소득 − 대출 상환 − 저축(보험료 포함), 은퇴 후는 노후 진단과 같은 생활비.
 * annualIncome: 은퇴 전 세후 연 소득
 */
export function yearFlow(input: PlanInput, age: number, annualIncome: number): YearFlow {
  const retired = age >= input.retireAge;
  const sources: FlowItem[] = [];
  const uses: FlowItem[] = [];
  const debt = debtPaymentAt(input, age);
  const by = goalBreakdownAt(input, age);

  if (retired) {
    input.pensions.forEach((p, i) => {
      const v = incomeValue(p, age, input.inflation);
      if (v > EPS) sources.push({ key: `inc-${i}`, label: p.name || '소득', amount: v, tone: 'income' });
    });
    const living = Math.max(0, retireOutflowAt(input, age) - debt + pensionAt(input, age));
    if (living > EPS) uses.push({ key: 'living', label: '생활비', amount: living, tone: 'living' });
  } else {
    if (annualIncome > EPS) sources.push({ key: 'income', label: '세후 소득', amount: annualIncome, tone: 'income' });
    const save = savingsAt(input, age);
    const living = Math.max(0, annualIncome - debt - save);
    if (living > EPS) uses.push({ key: 'living', label: '생활 지출(보험료 포함)', amount: living, tone: 'living' });
    if (save > EPS) uses.push({ key: 'save', label: '저축·투자', amount: save, tone: 'save' });
  }
  if (debt > EPS) uses.push({ key: 'debt', label: '대출 상환', amount: debt, tone: 'debt' });
  const tones = { goal: 'goal', premium: 'premium', loan: 'debt', npTax: 'tax' } as const;
  for (const k of GOAL_KINDS) if (by[k] > EPS) uses.push({ key: `goal-${k}`, label: GOAL_KIND_LABEL[k], amount: by[k], tone: tones[k] });
  for (const [i, x] of (input.inflows ?? []).entries()) {
    if (x.age !== age || !(x.amount > EPS)) continue;
    sources.push({ key: `in-${i}`, label: x.kind === 'credit' ? '세액공제 환급' : x.kind === 'sale' ? `${x.name ?? '부동산'} 매각` : `${x.name ?? '일시금'} 수령`, amount: x.amount, tone: 'lump' });
  }

  const sum = (list: FlowItem[]) => list.reduce((a, x) => a + x.amount, 0);
  const gap = sum(uses) - sum(sources);
  if (gap > EPS) sources.push({ key: 'draw', label: '금융자산에서 인출', amount: gap, tone: 'draw' });
  else if (gap < -EPS) uses.push({ key: 'keep', label: '금융자산에 더함', amount: -gap, tone: 'save' });
  return { age, retired, sources, uses, total: Math.max(sum(sources), sum(uses)) };
}
