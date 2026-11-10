// 모든 금액 단위: 만원 / 모든 비율 단위: % (연)

export type AssetType =
  | 'cash' | 'deposit' | 'savings' | 'bond' | 'fund' | 'etf' | 'stock' | 'pension' | 'realestate' | 'other';
export type Purpose = 'short' | 'mid' | 'long'; // 단기·비상금 / 중기·목적자금 / 장기·노후
export type Nature = 'safe' | 'invest';
export type RiskProfile = 'conservative' | 'moderate' | 'balanced' | 'growth' | 'aggressive';
/** 부동산 용도: 거주용 · 임대용 · 투자·기타(토지 등) */
export type ReUse = 'home' | 'rental' | 'land';
/** 자산 명의: 공동명의는 부동산만 */
export type AssetOwner = IncomeOwner | 'joint';

export interface Asset {
  id?: number;
  name: string;
  type: AssetType;
  amount: number; // 부동산은 현재 시세
  expectedReturn: number; // 부동산은 연 시세 상승률(명목)
  volatility: number; // 부동산은 쓰지 않음(노후 시뮬레이션 제외)
  purpose: Purpose; // 금융자산만 사용
  nature: Nature; // 금융자산만 사용
  owner?: AssetOwner; // 명의(기본 본인): 연금 세금·1,500만 한도, 임대소득 종소세를 사람별로 계산
  ownerShare?: number; // 공동명의일 때 본인 지분(%)
  lockYear?: number; // 수령 연도(노란우산 등): 그 전에는 인출할 수 없고 기대수익률로 불어난 뒤 일시금으로 들어옴. 부동산은 매각 연도
  lockTax?: number; // 수령 시 실효세율(%). 부동산은 매각 비용률(양도세·중개보수 등 %)
  reUse?: ReUse; // 부동산 용도(기본 거주용)
  rent?: number; // 임대용: 월세(만원, 오늘 기준)
  deposit?: number; // 임대용: 임대보증금(만원) — 돌려줄 돈이라 부채로 계산
  renewCycle?: number; // 임대용: 계약 갱신 주기(년)
  renewRate?: number; // 임대용: 갱신 때 월세 인상률(%)
  rentCost?: number; // 임대용: 공실·관리 경비율(월세 대비 %)
  reBuy?: number; // 거주용: 매각 후 새로 살 집 가격(오늘 시세, 만원 · 다운사이징)
  hpAge?: number; // 거주용: 주택연금 가입 나이(본인 기준, 0이면 안 함). 쓰면 매각 계획은 무시
  hpMonthly?: number; // 거주용: 주택연금 월 수령액(오늘 기준 만원, 0이면 시세·나이로 자동 추정)
  hpRate?: number; // 주택연금 대출 금리(%, 비우면 3.8 = COFIX + 0.85%p 가정)
  hpInitFee?: number; // 주택연금 초기보증료(주택가격 대비 %, 비우면 1.0)
  hpAnnualFee?: number; // 주택연금 연보증료(대출 잔액 대비 %, 비우면 0.95)
  taxFree?: number; // 연금계좌 중 과세제외 금액(비과세 원금, 만원)
  retirePart?: number; // 연금계좌 중 퇴직금 재원(이연퇴직소득, 만원)
  pensionYear1?: number; // 연금수령 1년차 연도(기산연도). 비우면 명의자가 55세가 되는 해
  drawStartYear?: number; // 이 해부터 인출(그 전에는 꺼내지 않고 추가 납입을 받는 계좌). 0이면 바로
  drawOrder?: number; // 같은 사람 계좌 중 꺼내는 순서(작을수록 먼저, 0이면 입력 순서)
  compareOrder?: number; // 인출순서 비교표 ① 조합에서 쓸 기준 순서(작을수록 먼저, 0이면 입력 순서)
}

export interface Liability {
  id?: number;
  name: string;
  balance: number;
  rate: number;
  monthlyPayment: number;
  endAge?: number; // 상환 종료 나이(비우거나 0이면 잔액·금리·월상환액으로 자동 계산)
  homeLoan?: 'buy'; // 실거주 주택 구입 대출(건보료 재산 과세표준에서 공제)
  // 상환 방식(비우면 원리금균등). bullet: 만기일시 — 월 상환액은 이자만, 상환 종료 나이(만기)에 남은 원금을 자산에서 한 번에 갚음.
  // equal: 원금균등 — 월 상환액은 이번 달 원금 + 이자, 잔액이 줄면서 이자만큼 상환액이 해마다 줄어듦
  repay?: 'bullet' | 'equal';
}

export interface Cashflow {
  id?: number;
  name: string;
  kind: 'fixed' | 'variable';
  category: string; // 주거/구독료/교육/생활비 등(보험료는 보험 탭, 대출 원리금은 부채에서 자동 반영)
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
  payEndAge?: number; // 납입 종료 나이(피보험자 나이, 0이면 계속 납입): 이 나이부터 보험료가 지출에서 빠짐
  insured?: InsuredWho; // 피보험자(기본 본인): 납입 종료 나이를 누구 나이로 입력했는지
  insuredBirthYear?: number; // 피보험자가 자녀일 때 자녀 출생연도
}

export type InsuredWho = 'self' | 'spouse' | 'child';

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
  kind?: IncomeKind; // 소득 종류(종합소득세·건강보험료 계산 방식). 없으면 rent 로 판단
  rent?: boolean; // 예전 데이터: 임대소득(kind 가 없을 때만 씀)
  expense?: number; // 사업소득 필요경비율(%)
}

export type IncomeOwner = 'self' | 'spouse';

/** 은퇴 후 소득 종류: 임대 · 근로 · 사업 · 공적연금(공무원·사학·군인) · 사적연금 · 그 밖(비과세·분리과세) */
export type IncomeKind = 'rent' | 'wage' | 'business' | 'publicPension' | 'privatePension' | 'other';

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
  expenseSteps?: ExpenseBand[]; // 나이 구간별 은퇴 후 생활비(인출액 고정 방식에서는 쓰지 않음)
  fixedDraw?: number; // expenseMode='draw': 자산에서 꺼내는 월 금액(세후, 명목 고정, 만원)
  retireTaxRate?: number; // 퇴직소득세 실효세율(감면 전, %): 연금계좌 퇴직금 재원 인출 세금
  retireTaxYear1?: number; // 퇴직금 연금 실수령 1년차 연도(11년차부터 감면 30%→40%)
  slotFill?: boolean; // 1,500만 한도 매년 꽉 채우기: 과세재원을 1인 1,500만까지 꺼내고 남는 돈은 ISA·일반계좌로 재투자
  slotFillFrom?: number; // 꽉 채우기 시작 연도(0이면 올해)
  incomeTax?: IncomeTaxSettings; // 종합소득세·건강보험료 추정
  contrib?: ContribPlan; // 연금계좌 추가 납입(세액공제)
}

/** 나이 구간별 은퇴 후 생활비: fromAge(본인 나이)부터 월 monthly(오늘 물가 기준, 만원) */
export interface ExpenseBand {
  fromAge: number;
  monthly: number;
}

/** 종합소득세·지역 건강보험료 추정(임대·근로·사업소득, 국민연금 등 공적연금). 비율은 %, 금액은 만원 */
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
  hiPropAuto?: boolean; // 재산분을 부동산 자산 시세로 연도별 추정(아니면 고지서 역산 고정)
  hiPubRatio?: number; // 시세 대비 공시가격 비율(%)
  hiFairRatio?: number; // 공정시장가액비율(%, 주택 60)
  hiLoanDeduct?: boolean; // 실거주 주택 구입 대출 잔액 × 60%를 재산 과세표준에서 공제(1세대 1주택, 한도 5,000만)
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
