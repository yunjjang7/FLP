import { describe, expect, it } from 'vitest';
import { fromCSV, templateCSV, toCSV } from './csv';
import { sampleData } from './sample';

describe('CSV 입출력', () => {
  it('내보내기 → 가져오기 왕복', () => {
    const { assets } = sampleData(2026);
    const csv = toCSV('assets', assets as never);
    expect(csv.split('\n')[0]).toContain('이름');
    const { rows, errors } = fromCSV('assets', csv);
    expect(errors).toEqual([]);
    // CSV는 기본 열만 주고받음(명의·매각·임대 조건 등 추가 설정은 JSON 백업으로)
    const keys = ['name', 'type', 'amount', 'purpose', 'nature', 'expectedReturn', 'volatility'] as const;
    expect(rows).toEqual(assets.map((a) => Object.fromEntries(keys.map((k) => [k, a[k]]))));
  });
  it('템플릿과 영문 키·쉼표 금액 허용', () => {
    expect(fromCSV('goals', templateCSV('goals')).rows).toHaveLength(1);
    const { rows } = fromCSV('liabilities', 'name,balance,rate,monthlyPayment\n대출,"1,500",4,30');
    expect(rows[0]).toEqual({ name: '대출', balance: 1500, rate: 4, monthlyPayment: 30, endAge: 0 }); // 상환 종료 나이 열이 없으면 0(자동 계산)
  });
  it('알 수 없는 선택값은 오류 보고', () => {
    const { errors } = fromCSV('assets', '이름,유형,금액\n뭔가,코인,100');
    expect(errors.length).toBe(1);
  });
  it('빈 선택값은 유형 기본값으로 채움', () => {
    const { rows, errors } = fromCSV('assets', '이름,유형,금액\n삼성전자,주식,500');
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ type: 'stock', purpose: 'long', nature: 'invest', expectedReturn: 8, volatility: 22 });
  });
});
