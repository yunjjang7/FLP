import { describe, expect, it } from 'vitest';
import type { Asset } from '../types';
import { creditCheck } from './creditCheck';

const pen = (name: string, paidIn: number | undefined, taxFree: number, owner: 'self' | 'spouse' = 'self', extra: Partial<Asset> = {}): Asset => ({
  name, type: 'pension', amount: 10000, expectedReturn: 4, volatility: 8, purpose: 'long', nature: 'invest', owner, paidIn, taxFree, ...extra,
});

describe('세액공제 확인 대조표', () => {
  // 엑셀 ‘세액공제확인’ 시트와 같은 값(만원)
  const assets = [
    pen('IRP(퇴직금,납입)', 3000, 300),
    pen('IRP(개인납입)', 3692.0049, 0),
    pen('연금저축 A', 6180, 900),
    pen('연금저축 B', 1701.9951, 499.9951),
    pen('배우자 IRP', 5000, 900, 'spouse'),
  ];
  const profile = { spouseBirthYear: 1970, creditCert: { self: 10340.6568, spouse: 4100 } };

  it('확인서 기준 과세제외와 계획을 비교해 덜 잡힌 비과세 재원과 아끼는 세금을 계산', () => {
    const { people } = creditCheck(profile, assets);
    const self = people.find((x) => x.owner === 'self')!;
    expect(self.paidIn).toBeCloseTo(14574, 4);
    expect(self.certExempt).toBeCloseTo(4233.3432, 4);
    expect(self.planExempt).toBeCloseTo(1699.9951, 4);
    expect(self.gap).toBeCloseTo(2533.3481, 4);
    expect(self.saving).toBeCloseTo(139.33, 2);
    expect(self.level).toBe('caution');
    const sp = people.find((x) => x.owner === 'spouse')!;
    expect(sp.gap).toBeCloseTo(0, 6);
    expect(sp.level).toBe('good');
  });
  it('계좌별 세액공제 = 입금 − 과세제외', () => {
    const { accounts } = creditCheck(profile, assets);
    expect(accounts[0].credited).toBe(2700);
  });
  it('확인서나 개인 입금액이 모두 비면 비교하지 않고 입력을 안내', () => {
    expect(creditCheck({ spouseBirthYear: 0 }, assets).people[0].note).toContain('확인서');
    expect(creditCheck({ spouseBirthYear: 0, creditCert: { self: 1000 } }, [pen('A', undefined, 0)]).people[0].gap).toBeUndefined();
    // 개인 입금액이 빈 계좌(DC 등)는 0으로 보고 비교, 안내에 이름을 남김
    const r = creditCheck({ spouseBirthYear: 0, creditCert: { self: 1000 } }, [pen('A', 2000, 0), pen('B', undefined, 0)]).people[0];
    expect(r.gap).toBe(1000);
    expect(r.note).toContain('빈 계좌(B)');
  });
  it('계획 과세제외가 확인서 기준보다 많으면 주의', () => {
    const r = creditCheck({ spouseBirthYear: 0, creditCert: { self: 1800 } }, [pen('A', 2000, 500)]).people[0];
    expect(r.gap).toBe(-300);
    expect(r.note).toContain('300만원 많습니다');
  });
  it('같은 계좌로 묶인 줄은 합쳐서 한 계좌로', () => {
    const { accounts, people } = creditCheck({ spouseBirthYear: 0, creditCert: { self: 1000 } }, [pen('A-1', 1500, 300, 'self', { group: 'A' }), pen('A-2', undefined, 200, 'self', { group: 'A' })]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ name: 'A', paidIn: 1500, taxFree: 500 });
    expect(people[0].gap).toBe(0);
  });
});
