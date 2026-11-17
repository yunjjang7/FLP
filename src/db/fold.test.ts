import { describe, expect, it } from 'vitest';
import { parseFolded, pruneFolded, rowSummary, toggleFolded } from './fold';

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
});
