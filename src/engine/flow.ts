import { debtPaymentAt, GOAL_KIND_LABEL, GOAL_KINDS, goalBreakdownAt, incomeValue, pensionAt, retireOutflowAt, savingsAt, type PlanInput } from './montecarlo';

/** 연간 현금흐름 흐름도의 한 줄(연 금액, 오늘 물가) */
export interface FlowItem {
  key: string;
  label: string;
  amount: number;
  /** 색 구분: 소득·일시금·자산 인출·소득 초과 저축 / 생활비·대출·세금·보험·목표·저축 */
  tone: 'income' | 'lump' | 'draw' | 'short' | 'living' | 'debt' | 'tax' | 'premium' | 'goal' | 'save';
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
 * 들어오는 돈이 모자라면 ‘금융자산에서 인출’이, 남으면 ‘저축·투자’·‘금융자산에 더함’이 생겨 양쪽 합계가 같아짐.
 * 인출과 저축은 상계해 금융자산 순증감(시뮬레이션의 수익 전 잔액 변화)만 한쪽에 표시: 같은 해에 둘이 함께 나오지 않음.
 * 은퇴 전 생활 지출은 세후 소득 − 대출 상환 − 저축(보험료 포함), 은퇴 후는 노후 진단과 같은 생활비.
 * 은퇴 전 소득이 대출 상환 + 저축보다 적으면 시뮬레이션은 그래도 저축액이 쌓인다고 보므로 그 차이를 ‘소득 초과 저축’으로 표시.
 * annualIncome: 지금 가구 세후 연 소득(배우자 몫 포함)
 * spouse: 그 가운데 배우자 근로소득(연)과 끊기는 본인 나이(goals.ts spouseWork). 엔진은 이 나이부터 저축을 배우자 소득만큼
 *   줄이므로(savingsChanges ‘배우자 은퇴’) 소득도 같은 나이부터 같은 만큼 빼야 생활 지출이 배우자 은퇴 전후로 이어짐.
 *   주면 소득을 본인·배우자 줄로 나눠 표시
 */
export function yearFlow(input: PlanInput, age: number, annualIncome: number, spouse?: { annual: number; fromAge: number }): YearFlow {
  const retired = age >= input.retireAge;
  const sources: FlowItem[] = [];
  const uses: FlowItem[] = [];
  const debt = debtPaymentAt(input, age);
  const by = goalBreakdownAt(input, age);
  let save = 0; // 은퇴 전 연 저축(엔진의 savingsAt)

  if (retired) {
    input.pensions.forEach((p, i) => {
      const v = incomeValue(p, age, input.inflation);
      if (v > EPS) sources.push({ key: `inc-${i}`, label: p.name || '소득', amount: v, tone: 'income' });
    });
    const living = Math.max(0, retireOutflowAt(input, age) - debt + pensionAt(input, age));
    if (living > EPS) uses.push({ key: 'living', label: '생활비', amount: living, tone: 'living' });
  } else {
    let income = annualIncome;
    if (spouse && spouse.annual > EPS) {
      // 배우자 몫이 가구 소득보다 크게 잘못 들어와도 본인 줄은 0 아래로 내리지 않음
      const sp = Math.min(spouse.annual, Math.max(0, annualIncome));
      const self = Math.max(0, annualIncome) - sp;
      const spNow = age >= spouse.fromAge ? 0 : sp;
      income = self + spNow;
      if (self > EPS) sources.push({ key: 'income', label: '본인 세후 소득', amount: self, tone: 'income' });
      if (spNow > EPS) sources.push({ key: 'income-spouse', label: '배우자 세후 소득', amount: spNow, tone: 'income' });
    } else if (annualIncome > EPS) sources.push({ key: 'income', label: '세후 소득', amount: annualIncome, tone: 'income' });
    // 저축은 엔진(runPath)과 같이 savingsAt 그대로: 음수(저축 여력 마이너스)면 그만큼 생활 지출이 소득보다 많은 것
    save = savingsAt(input, age);
    const living = income - debt - save;
    if (living > EPS) uses.push({ key: 'living', label: '생활 지출(보험료 포함)', amount: living, tone: 'living' });
    // 소득이 대출 상환 + 저축보다 적어도 시뮬레이션은 저축액이 그대로 쌓인다고 계산하므로, 소득으로 못 대는 몫을 따로 표시
    else if (living < -EPS) sources.push({ key: 'short', label: '소득 초과 저축', amount: -living, tone: 'short' });
  }
  if (debt > EPS) uses.push({ key: 'debt', label: '대출 상환', amount: debt, tone: 'debt' });
  const tones = { goal: 'goal', premium: 'premium', loan: 'debt', npTax: 'tax' } as const;
  for (const k of GOAL_KINDS) if (by[k] > EPS) uses.push({ key: `goal-${k}`, label: GOAL_KIND_LABEL[k], amount: by[k], tone: tones[k] });
  for (const [i, x] of (input.inflows ?? []).entries()) {
    if (x.age !== age || !(x.amount > EPS)) continue;
    sources.push({ key: `in-${i}`, label: x.kind === 'credit' ? '세액공제 환급' : x.kind === 'sale' ? `${x.name ?? '부동산'} 매각` : `${x.name ?? '일시금'} 수령`, amount: x.amount, tone: 'lump' });
  }

  const sum = (list: FlowItem[]) => list.reduce((a, x) => a + x.amount, 0);
  // 금융자산 순증감(은퇴 전 = 저축 + 일시금 − 목표 지출, 엔진의 수익 전 잔액 변화와 같음). 인출과 저축을 상계해 한쪽만 표시
  // 저축 줄은 순증감 안에서만(모자라면 줄어든 순저축, 순인출이면 저축 줄 없음), 생활 지출 바로 뒤에 둠
  const net = sum(sources) - sum(uses);
  if (net < -EPS) sources.push({ key: 'draw', label: '금융자산에서 인출', amount: -net, tone: 'draw' });
  else if (net > EPS) {
    const s = Math.min(Math.max(0, save), net);
    if (s > EPS) uses.splice(uses[0]?.key === 'living' ? 1 : 0, 0, { key: 'save', label: '저축·투자', amount: s, tone: 'save' });
    if (net - s > EPS) uses.push({ key: 'keep', label: '금융자산에 더함', amount: net - s, tone: 'save' });
  }
  return { age, retired, sources, uses, total: Math.max(sum(sources), sum(uses)) };
}
