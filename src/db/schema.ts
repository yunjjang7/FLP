import { ASSET_TYPES, NATURE_LABEL, PURPOSE_LABEL } from '../engine/portfolio';
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
}

export const GOAL_CATEGORY: Record<string, string> = {
  education: '교육', housing: '주거', car: '차량', travel: '여행', other: '기타',
};

const assetTypeOptions = Object.fromEntries(Object.entries(ASSET_TYPES).map(([k, v]) => [k, v.label]));

export const TABLES: Record<ListTable, { label: string; fields: FieldDef[]; example: Record<string, unknown> }> = {
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
  },
  liabilities: {
    label: '부채',
    fields: [
      { key: 'name', label: '이름', kind: 'text' },
      { key: 'balance', label: '잔액', kind: 'number', unit: '만원' },
      { key: 'rate', label: '금리', kind: 'number', unit: '%', step: 0.1 },
      { key: 'monthlyPayment', label: '월 상환액', kind: 'number', unit: '만원' },
      { key: 'endAge', label: '상환 종료 나이', kind: 'number', unit: '세', hint: '0이면 자동 계산' },
    ],
    example: { name: '주택담보대출', balance: 20000, rate: 4, monthlyPayment: 100, endAge: 0 },
  },
  cashflows: {
    label: '지출',
    fields: [
      { key: 'name', label: '이름', kind: 'text' },
      { key: 'kind', label: '구분', kind: 'select', options: { fixed: '고정비', variable: '변동비' } },
      { key: 'category', label: '분류', kind: 'text' },
      { key: 'monthly', label: '월 금액', kind: 'number', unit: '만원' },
    ],
    example: { name: '보험료', kind: 'fixed', category: '보험료', monthly: 30 },
  },
  goals: {
    label: '재무목표',
    fields: [
      { key: 'name', label: '이름', kind: 'text' },
      { key: 'category', label: '분류', kind: 'select', options: GOAL_CATEGORY },
      { key: 'targetAge', label: '목표 나이', kind: 'number', unit: '세' },
      { key: 'amountPV', label: '필요 금액(현재가치)', kind: 'number', unit: '만원' },
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
      { key: 'monthlyPremium', label: '월 보험료', kind: 'number', unit: '만원' },
    ],
    example: { name: '암보험', death: 0, critical: 3000, care: 0, monthlyPremium: 5 },
  },
};
