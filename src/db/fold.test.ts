import { describe, expect, it } from 'vitest';
import { cardSummary, parseFolded, pruneFolded, rowSummary, toggleFolded } from './fold';

describe('기본 정보 카드 접기', () => {
  it('저장된 접힘 목록 읽기: 숫자 배열만, 잘못된 값은 빈 목록', () => {
    expect(parseFolded('[1,3]')).toEqual([1, 3]);
    expect(parseFolded('[1,"x",null,2]')).toEqual([1, 2]);
    expect(parseFolded('{"a":1}')).toEqual([]);
    expect(parseFolded('깨진 값')).toEqual([]);
    expect(parseFolded(null)).toEqual([]);
  });

  it('하나씩 접고 펴기, 삭제한 카드는 버림', () => {
    expect(toggleFolded([1, 2], 3)).toEqual([1, 2, 3]);
    expect(toggleFolded([1, 2, 3], 2)).toEqual([1, 3]);
    expect(pruneFolded([1, 2, 9], [{ id: 1 }, { id: 2 }, { id: 3 }])).toEqual([1, 2]);
  });

  it('접은 카드 요약: 첫 선택 칸 값 · 첫 금액 칸', () => {
    expect(rowSummary('assets', { name: 'ISA', type: 'etf', amount: 2000 })).toBe('ETF · 2,000만원');
    expect(rowSummary('liabilities', { name: '주담대', balance: 20000 })).toBe('2억원');
    expect(rowSummary('cashflows', { name: '관리비', kind: 'fixed', monthly: 30 })).toBe('고정비 · 30만원');
  });

  it('부채 요약: 금리·상환 방식·상환 종료 나이', () => {
    expect(cardSummary('liabilities', { name: '주담대', balance: 20000, rate: 4, monthlyPayment: 100, endAge: 0 })).toBe('2억원 · 금리 4% · 원리금균등');
    expect(cardSummary('liabilities', { name: '신용', balance: 1000, rate: 5.25, repay: 'equal', endAge: 60 })).toBe('1,000만원 · 금리 5.25% · 원금균등 · 60세 상환 종료');
    expect(cardSummary('liabilities', { name: '전세', balance: 5000, rate: 3.8, repay: 'bullet', endAge: 62 })).toBe('5,000만원 · 금리 3.8% · 만기일시 · 62세 만기');
    expect(cardSummary('liabilities', { name: '지인', balance: 3000, rate: 2, repay: 'bullet', maturity: 'open', endAge: 70 })).toBe('3,000만원 · 금리 2% · 만기 미정(이자만)');
  });

  it('목표 요약: 목표 나이(반복이면 시작~종료 매년)', () => {
    expect(cardSummary('goals', { name: '차', category: 'car', targetAge: 61, amountPV: 3000, endAge: 0 })).toBe('차량 · 3,000만원 · 본인 61세');
    expect(cardSummary('goals', { name: '등록금', category: 'education', targetAge: 55, amountPV: 800, endAge: 58 })).toBe('교육 · 800만원 · 본인 55~58세 매년');
  });

  it('보험 요약: 피보험자·0이 아닌 보장·월 보험료·납입 종료 나이', () => {
    expect(cardSummary('insurance', { name: '암보험', death: 0, critical: 3000, care: 0, monthlyPremium: 5, payEndAge: 0 })).toBe('본인 · 진단비 3,000만원 · 월 5만원 · 계속 납입');
    expect(cardSummary('insurance', { name: '종신', death: 10000, critical: 0, care: 2000, monthlyPremium: 20, payEndAge: 65, insured: 'spouse' })).toBe('배우자 · 사망 1억원 · 간병 2,000만원 · 월 20만원 · 65세까지 납입');
    expect(cardSummary('cashflows', { name: '관리비', kind: 'fixed', monthly: 30 })).toBe('고정비 · 30만원');
  });
});
