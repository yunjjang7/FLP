// 모든 금액 단위: 만원 / 모든 비율 단위: % (연)

export type AssetType =
  | 'cash' | 'deposit' | 'savings' | 'bond' | 'fund' | 'etf' | 'stock' | 'pension' | 'realestate' | 'other';
export type Purpose = 'short' | 'mid' | 'long'; // 단기·비상금 / 중기·목적자금 / 장기·노후
export type Nature = 'safe' | 'invest';
export type RiskProfile = 'conservative' | 'moderate' | 'balanced' | 'growth' | 'aggressive';

export interface Asset {
  id?: number;
  name: string;
  type: AssetType;
  amount: number;
  expectedReturn: number;
  volatility: number;
  purpose: Purpose;
  nature: Nature;
  owner?: IncomeOwner; // 명의(기본 본인): 연금 세금·1,500만 한도를 사람별로 계산
  lockYear?: number; // 수령 연도(노란우산 등): 그 전에는 인출할 수 없고 기대수익률로 불어난 뒤 일시금으로 들어옴
  lockTax?: number; // 수령 시 실효세율(%)
  taxFree?: number; // 연금계좌 중 과세제외 금액(비과세 원금, 만원)
  retirePart?: number; // 연금계좌 중 퇴직금 재원(이연퇴직소득, 만원)
  pensionYear1?: number; // 연금수령 1년차 연도(기산연도). 비우면 명의자가 55세가 되는 해
  drawStartYear?: number; // 이 해부터 인출(그 전에는 꺼내지 않고 추가 납입을 받는 계좌). 0이면 바로
  drawOrder?: number; // 같은 사람 계좌 중 꺼내는 순서(작을수록 먼저, 0이면 입력 순서)
}

export interface Liability {
  id?: number;
  name: string;
  balance: number;
  rate: number;
  monthlyPayment: number;
  endAge?: number; // 상환 종료 나이(비우거나 0이면 잔액·금리·월상환액으로 자동 계산)
}

export interface Cashflow {
  id?: number;
  name: string;
  kind: 'fixed' | 'variable';
  category: string; // 보험료/대출이자/구독료/주거/생활비 등
  monthly: number;
}

export type GoalCategory = 'education' | 'housing' | 'retirement' | 'car' | 'travel' | 'other';

export interface Goal {
  id?: number;
  name: string;
  category: GoalCategory;
  targetAge: number;
  amountPV: number; // 현재가치 기준 필요 금액
  growthRate: number; // 비용 상승률(%), 예: 교육비 4
  endAge?: number; // 반복 종료 나이: targetAge~endAge 매년 지출(0이거나 targetAge 이하면 1회)
}

export interface Insurance {
  id?: number;
  name: string;
  death: number; // 사망보장
  critical: number; // 암·중대질병 진단비
  care: number; // 간병·장기요양 보장
  monthlyPremium: number;
}

export interface Snapshot {
  id?: number;
  date: string; // YYYY-MM-DD
  netWorth: number;
  totalAssets: number;
  totalDebt: number;
}

export interface Criteria {
  emergencyMonths: number; // 비상금 목표(개월)
  savingsRate: number; // 목표 저축률(%)
  debtRatioMax: number; // 부채비율 상한(%)
  successTarget: number; // 은퇴 성공확률 목표(%)
  withdrawRateMax: number; // 인출률 상한(%): 은퇴 첫해 자산 인출액 / 금융자산
  criticalMultiple: number; // 진단비 = 연소득 × N
  careNeed: number; // 간병 필요 보장액(만원)
  survivorRatio: number; // 유족 생활비 비율(%)
}

/** 은퇴 후 소득(임대료 등). 금액은 오늘 기준, 인상률은 지금부터 주기마다 적용 */
export interface RetireIncome {
  name: string;
  monthly: number; // 월액(오늘 기준, 만원)
  startAge: number; // 받기 시작하는 본인 나이
  endAge: number; // 마지막으로 받는 본인 나이(0이면 평생)
  growth: number; // 1회 명목 인상률(%). 매년 인상하며 물가상승률과 같으면 실질 가치 유지
  step: number; // 인상 주기(년): step 년마다 growth% 인상
  owner?: IncomeOwner; // 나이를 누구 기준으로 입력했는지(기본 본인)
  rent?: boolean; // 임대소득(종합소득세·건강보험료 계산 대상)
}

export type IncomeOwner = 'self' | 'spouse';

/** 연말결산: 그 해 12월 말 실제 금융자산과 그 해 실제 인출액(명목, 만원) */
export interface YearEnd {
  id?: number;
  year: number;
  balance: number; // 12월 말 금융자산 합계
  withdrawn: number; // 그 해 자산에서 실제로 꺼낸 금액
  note?: string;
}

/** 가드레일 기준선: 고정한 시점의 계획 경로(실질, 고정 연도 물가 기준) */
export interface PlanBase {
  savedAt: string; // YYYY-MM-DD
  year: number; // 고정한 해
  month: number; // 고정한 달(1~12)
  inflation: number; // 명목 환산용 물가상승률
  balances: number[]; // 연초 잔액: [0] = 고정 시점 자산, [i] = i년 뒤
  withdrawals: number[]; // [i] = i번째 해 계획 인출액
}

export interface Profile {
  id: 'me';
  name: string;
  birthYear: number;
  retireAge: number;
  lifeExpectancy: number;
  monthlyIncome: number; // 세후 월소득
  inflation: number;
  riskProfile: RiskProfile;
  retireMonthlyExpense: number; // 은퇴 후 월 생활비(현재가치)
  dependentYears: number; // 부양 필요 기간(년)
  nationalPension: number; // 국민연금 월 수령액(현재가치)
  nationalPensionAge: number;
  birthMonth?: number; // 본인 출생 월(1~12): 국민연금 첫해를 생일 다음 달부터 계산. 0·없음이면 첫해도 12개월
  spouseBirthMonth?: number; // 배우자 출생 월
  npGrowth?: number; // 국민연금 연 인상률(명목 %). 없으면 물가상승률
  privatePension: number; // 개인·퇴직연금 월 수령액(현재가치)
  privatePensionAge: number;
  spouseBirthYear: number; // 배우자 출생연도(0이면 배우자 연금 없음)
  spousePension: number; // 배우자 국민연금 월액(현재가치)
  spousePensionAge: number; // 배우자 국민연금 개시 나이(배우자 나이 기준)
  spouseIncome: number; // 배우자 세후 월소득(가구 소득 중 배우자 몫)
  spouseRetireAge: number; // 배우자 은퇴 나이(배우자 나이 기준)
  spousePrivatePension: number; // 배우자 개인·퇴직연금 월액(현재가치)
  spousePrivatePensionAge: number; // 배우자 개인연금 개시 나이(배우자 나이 기준)
  incomes: RetireIncome[]; // 은퇴 후 소득(임대료 등)
  retireSeparate: boolean; // 은퇴 후 자산 운용을 따로 설정할지
  retireReturn: number; // 은퇴 후 기대수익률(%)
  retireVolatility: number; // 은퇴 후 변동성(%)
  criteria: Criteria;
  planBase?: PlanBase; // 가드레일 기준선(연말결산 비교용)
  expenseMode?: ExpenseMode; // 은퇴 후 생활비가 해마다 어떻게 변하는지(기본 물가 연동)
  expenseGrowth?: number; // expenseMode='growth': 생활비 명목 증가율(%)
  fixedDraw?: number; // expenseMode='draw': 자산에서 꺼내는 월 금액(세후, 명목 고정, 만원)
  retireTaxRate?: number; // 퇴직소득세 실효세율(감면 전, %): 연금계좌 퇴직금 재원 인출 세금
  retireTaxYear1?: number; // 퇴직금 연금 실수령 1년차 연도(11년차부터 감면 30%→40%)
  slotFill?: boolean; // 1,500만 한도 매년 꽉 채우기: 과세재원을 1인 1,500만까지 꺼내고 남는 돈은 ISA·일반계좌로 재투자
  slotFillFrom?: number; // 꽉 채우기 시작 연도(0이면 올해)
  incomeTax?: IncomeTaxSettings; // 종합소득세·건강보험료 추정
  contrib?: ContribPlan; // 연금계좌 추가 납입(세액공제)
}

/** 종합소득세·지역 건강보험료 추정(임대소득·국민연금). 비율은 %, 금액은 만원 */
export interface IncomeTaxSettings {
  on: boolean;
  rentSpouseShare: number; // 임대소득 중 배우자 몫(%)
  rentExpense: number; // 임대 필요경비율(%)
  npTaxable: number; // 국민연금 중 과세대상 비율(%, 2002년 이후 납입분)
  npNet: number; // 입력한 국민연금 월액이 세전의 몇 %인지(세후로 입력했으면 97 등, 세전이면 100)
  dedSelf: number; // 본인 종합소득공제 합계(만원)
  dedSpouse: number; // 배우자 종합소득공제 합계(만원)
  hiNow: number; // 현재 월 건강보험료(장기요양 포함, 만원): 재산분 역산용
  hiRate: number; // 건강보험료율(%)
  hiLtc: number; // 장기요양보험료(건보료 대비 %)
  hiPublic: number; // 공적연금 건보료 반영률(%)
  hiPropGrowth: number; // 재산분 연 증가율(%)
  hiPrivate: boolean; // 사적연금(과세재원 인출)도 건보료에 반영
  addToDraw: boolean; // 국민연금 때문에 늘어나는 종소세·건보료를 인출에 더함
}

/** 연금계좌 추가 납입(세액공제). 금액은 연 만원 */
export interface ContribPlan {
  self: number; // 본인 연 납입액(인출 시작 전 본인 계좌로)
  spouse: number; // 배우자 연 납입액
  from: number; // 시작 연도
  to: number; // 마지막 연도
  selfRate: number; // 본인 세액공제율(%) 직접 입력, 0이면 종합소득금액으로 자동(4,500만 이하 16.5 · 초과 13.2)
  spouseRate: number; // 배우자 세액공제율(%) 직접 입력, 0이면 자동
}

/** real: 물가만큼 오름(실질 유지) · growth: 명목 증가율 지정(0이면 금액 고정) · draw: 자산 인출액을 명목 금액으로 고정하고 연금·임대료 등 소득은 모두 생활비로 씀 */
export type ExpenseMode = 'real' | 'growth' | 'draw';

export type Level = 'good' | 'caution' | 'danger';
