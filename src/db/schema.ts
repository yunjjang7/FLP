import { ASSET_TYPES, NATURE_LABEL, PURPOSE_LABEL } from '../engine/portfolio';
import { RE_USE } from '../engine/realestate';
import type { ListTable } from './db';

export interface FieldDef {
  key: string;
  label: string;
  kind: 'text' | 'number' | 'select';
  options?: Record<string, string>; // code → label
  unit?: string;
  step?: number;
  width?: string;
  hint?: string;
  /** 입력 화면용 짧은 레이블(CSV 헤더는 label 그대로) */
  short?: string;
  /** CSV 선택 열: 부동산 행에만 쓰는 값(다른 유형은 빈칸) */
  reOnly?: boolean;
  /** CSV 선택 열: 연금 계좌 행에만 쓰는 값 */
  penOnly?: boolean;
}

export const GOAL_CATEGORY: Record<string, string> = {
  education: '교육', housing: '주거', car: '차량', travel: '여행', other: '기타',
};

const assetTypeOptions = Object.fromEntries(Object.entries(ASSET_TYPES).map(([k, v]) => [k, v.label]));

/** 자산 CSV 선택 열(목록 화면 열에는 없음). 비어 있으면 값 없음으로 둠 */
const assetCsvExtra: FieldDef[] = [
  { key: 'owner', label: '명의', kind: 'select', options: { self: '본인', spouse: '배우자', joint: '공동명의' } },
  { key: 'lockYear', label: '수령·매각 연도', kind: 'number' },
  { key: 'lockTax', label: '수령 세율·매각 비용률', kind: 'number', unit: '%' },
  { key: 'reUse', label: '부동산 용도', kind: 'select', options: RE_USE, reOnly: true },
  { key: 'ownerShare', label: '본인 지분', kind: 'number', unit: '%', reOnly: true },
  { key: 'rent', label: '월세', kind: 'number', unit: '만원', reOnly: true },
  { key: 'deposit', label: '임대보증금', kind: 'number', unit: '만원', reOnly: true },
  { key: 'renewCycle', label: '계약 갱신 주기', kind: 'number', unit: '년', reOnly: true },
  { key: 'renewRate', label: '갱신 인상률', kind: 'number', unit: '%', reOnly: true },
  { key: 'rentCost', label: '공실·관리 경비율', kind: 'number', unit: '%', reOnly: true },
  { key: 'reBuy', label: '새 집 구입액', kind: 'number', unit: '만원', reOnly: true },
  { key: 'hpAge', label: '주택연금 가입 나이', kind: 'number', unit: '세', reOnly: true },
  { key: 'hpMonthly', label: '주택연금 월 수령액', kind: 'number', unit: '만원', reOnly: true },
  { key: 'hpRate', label: '주택연금 대출 금리', kind: 'number', unit: '%', reOnly: true },
  { key: 'hpInitFee', label: '주택연금 초기보증료', kind: 'number', unit: '%', reOnly: true },
  { key: 'hpAnnualFee', label: '주택연금 연보증료', kind: 'number', unit: '%', reOnly: true },
  { key: 'taxFree', label: '과세제외 금액', kind: 'number', unit: '만원', penOnly: true },
  { key: 'retirePart', label: '퇴직금 재원', kind: 'number', unit: '만원', penOnly: true },
  { key: 'pensionYear1', label: '연금수령 1년차 연도', kind: 'number', penOnly: true },
  { key: 'drawStartYear', label: '인출 시작 연도', kind: 'number', penOnly: true },
  { key: 'drawOrder', label: '꺼내는 순서', kind: 'number', penOnly: true },
  { key: 'compareOrder', label: '비교 기준 순서', kind: 'number', penOnly: true },
  { key: 'group', label: '같은 계좌', kind: 'text', penOnly: true },
];

/** 보험 피보험자: 납입 종료 나이를 누구 나이로 입력했는지 */
export const INSURED_WHO: Record<string, string> = { self: '본인', spouse: '배우자', child: '자녀' };
const insuranceCsvExtra: FieldDef[] = [
  { key: 'insured', label: '피보험자', kind: 'select', options: INSURED_WHO },
  { key: 'insuredBirthYear', label: '자녀 출생연도', kind: 'number' },
];

export const TABLES: Record<ListTable, { label: string; fields: FieldDef[]; example: Record<string, unknown>; csvExtra?: FieldDef[]; csvExamples?: Record<string, unknown>[] }> = {
  assets: {
    label: '자산',
    fields: [
      { key: 'name', label: '이름', kind: 'text' },
      { key: 'type', label: '유형', kind: 'select', options: assetTypeOptions },
      { key: 'amount', label: '금액', kind: 'number', unit: '만원' },
      { key: 'purpose', label: '용도', kind: 'select', options: PURPOSE_LABEL },
      { key: 'nature', label: '성격', kind: 'select', options: NATURE_LABEL },
      { key: 'expectedReturn', label: '기대수익률', kind: 'number', unit: '%', step: 0.1 },
      { key: 'volatility', label: '변동성', kind: 'number', unit: '%', step: 0.1 },
    ],
    example: { name: '정기예금', type: 'deposit', amount: 1000, purpose: 'short', nature: 'safe', expectedReturn: 3, volatility: 0.5 },
    csvExtra: assetCsvExtra,
    csvExamples: [
      { name: '정기예금', type: 'deposit', amount: 1000, purpose: 'short', nature: 'safe', expectedReturn: 3, volatility: 0.5 },
      { name: '임대 오피스텔', type: 'realestate', amount: 30000, purpose: 'long', nature: 'invest', expectedReturn: 3, volatility: 8, owner: 'joint', ownerShare: 50, reUse: 'rental', rent: 100, deposit: 5000, renewCycle: 2, renewRate: 5, rentCost: 10, lockYear: 2045, lockTax: 5 },
    ],
  },
  liabilities: {
    label: '부채',
    fields: [
      { key: 'name', label: '이름', kind: 'text' },
      { key: 'balance', label: '잔액', kind: 'number', unit: '만원' },
      { key: 'rate', label: '금리', kind: 'number', unit: '%', step: 0.1 },
      { key: 'monthlyPayment', label: '월 상환액', kind: 'number', unit: '만원' },
      { key: 'endAge', label: '상환 종료 나이', kind: 'number', unit: '세', hint: '0이면 자동 계산 · 만기일시는 만기 나이' },
    ],
    example: { name: '주택담보대출', balance: 20000, rate: 4, monthlyPayment: 100, endAge: 0 },
    csvExtra: [
      { key: 'repay', label: '상환 방식', kind: 'select', options: { bullet: '만기일시', equal: '원금균등' } },
      { key: 'homeLoan', label: '건보 대출 공제', kind: 'select', options: { buy: '주택 구입' } },
    ],
  },
  cashflows: {
    label: '지출',
    fields: [
      { key: 'name', label: '이름', kind: 'text' },
      { key: 'kind', label: '구분', kind: 'select', options: { fixed: '고정비', variable: '변동비' } },
      { key: 'category', label: '분류', kind: 'text' },
      { key: 'monthly', label: '월 금액', kind: 'number', unit: '만원' },
    ],
    example: { name: '통신비', kind: 'fixed', category: '통신비', monthly: 10 },
  },
  goals: {
    label: '재무목표',
    fields: [
      { key: 'name', label: '이름', kind: 'text' },
      { key: 'category', label: '분류', kind: 'select', options: GOAL_CATEGORY },
      { key: 'targetAge', label: '목표 나이', kind: 'number', unit: '세' },
      { key: 'amountPV', label: '필요 금액(현재가치)', short: '필요 금액', kind: 'number', unit: '만원', hint: '현재가치(오늘 물가 기준)' },
      { key: 'growthRate', label: '비용 상승률', kind: 'number', unit: '%', step: 0.1 },
      { key: 'endAge', label: '반복 종료 나이', kind: 'number', unit: '세', hint: '0이면 1회, 입력하면 매년 지출' },
    ],
    example: { name: '자녀 대학 등록금', category: 'education', targetAge: 55, amountPV: 4000, growthRate: 4, endAge: 0 },
  },
  insurance: {
    label: '보험',
    fields: [
      { key: 'name', label: '상품명', kind: 'text' },
      { key: 'death', label: '사망보장', kind: 'number', unit: '만원' },
      { key: 'critical', label: '진단비', kind: 'number', unit: '만원' },
      { key: 'care', label: '간병보장', kind: 'number', unit: '만원' },
      { key: 'monthlyPremium', label: '월 보험료', kind: 'number', unit: '만원', hint: '지출(저축 여력)에 자동 반영' },
      { key: 'payEndAge', label: '납입 종료 나이', short: '납입 종료', kind: 'number', unit: '세', hint: '0이면 계속 납입 · 피보험자 나이' },
    ],
    example: { name: '암보험', death: 0, critical: 3000, care: 0, monthlyPremium: 5, payEndAge: 0 },
    csvExtra: insuranceCsvExtra,
  },
};
