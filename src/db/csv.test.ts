import { describe, expect, it } from 'vitest';
import { drawsFromCSV, drawsTemplateCSV, drawsToCSV, fromCSV, templateCSV, toCSV } from './csv';
import { sampleData } from './sample';

describe('CSV 입출력', () => {
  it('내보내기 → 가져오기 왕복', () => {
    const { assets } = sampleData(2026);
    const csv = toCSV('assets', assets as never);
    expect(csv.split('\n')[0]).toContain('이름');
    const { rows, errors } = fromCSV('assets', csv);
    expect(errors).toEqual([]);
    // 샘플 자산은 CSV 열(기본 + 명의·부동산 선택 열)만 쓰므로 그대로 돌아옴
    expect(rows).toEqual(assets);
  });
  it('부동산 선택 열 왕복, 부동산이 아닌 행은 빈칸', () => {
    const assets = [
      { name: '오피스텔', type: 'realestate', amount: 30000, purpose: 'long', nature: 'invest', expectedReturn: 3, volatility: 8, reUse: 'rental', owner: 'joint', ownerShare: 70, rent: 100, deposit: 5000, renewCycle: 2, renewRate: 5, rentCost: 10, lockYear: 2045, lockTax: 5 },
      { name: '거주 주택', type: 'realestate', amount: 60000, purpose: 'long', nature: 'invest', expectedReturn: 3, volatility: 8, reUse: 'home', hpAge: 65, hpMonthly: 0, reBuy: 0 },
      { name: '노란우산', type: 'other', amount: 2000, purpose: 'long', nature: 'safe', expectedReturn: 3, volatility: 1, owner: 'spouse', lockYear: 2040, lockTax: 3, rent: 999 },
    ];
    const csv = toCSV('assets', assets);
    const [head, , , other] = csv.split(/\r?\n/);
    expect(head).toContain('부동산 용도');
    expect(head).toContain('주택연금 가입 나이');
    expect(other).toContain('배우자');
    expect(other).not.toContain('999'); // 부동산 전용 열은 빈칸
    const { rows, errors } = fromCSV('assets', csv);
    expect(errors).toEqual([]);
    expect(rows[0]).toEqual(assets[0]);
    expect(rows[1]).toEqual(assets[1]);
    const { rent: _, ...noRent } = assets[2];
    expect(rows[2]).toEqual(noRent);
  });
  it('부동산 선택 열: 비어 있으면 값 없음, 부동산 아닌 행의 부동산 열·공동명의는 무시', () => {
    const csv = '이름,유형,금액,명의,부동산 용도,월세\n집,부동산,50000,,,\n예금,예금,100,공동명의,임대용,50';
    const { rows, errors } = fromCSV('assets', csv);
    expect(rows[0]).toMatchObject({ reUse: 'home' });
    expect(rows[0]).not.toHaveProperty('owner');
    expect(rows[0]).not.toHaveProperty('rent');
    expect(rows[1]).toMatchObject({ owner: 'self' });
    expect(rows[1]).not.toHaveProperty('reUse');
    expect(rows[1]).not.toHaveProperty('rent');
    expect(errors).toHaveLength(1); // 공동명의 경고
  });
  it('주택연금 대출 조건·건보 대출 공제 열 왕복', () => {
    const assets = [{ name: '집', type: 'realestate', amount: 60000, purpose: 'long', nature: 'invest', expectedReturn: 3, volatility: 8, reUse: 'home', hpAge: 65, hpRate: 4.2, hpInitFee: 1, hpAnnualFee: 0.75 }];
    expect(fromCSV('assets', toCSV('assets', assets)).rows[0]).toEqual(assets[0]);
    const loans = [
      { name: '주담대', balance: 20000, rate: 4, monthlyPayment: 100, endAge: 0, homeLoan: 'buy' },
      { name: '신용대출', balance: 1000, rate: 6, monthlyPayment: 30, endAge: 0 },
      { name: '만기 대출', balance: 5000, rate: 4, monthlyPayment: 17, endAge: 55, repay: 'bullet' },
      { name: '원금균등 대출', balance: 12000, rate: 5, monthlyPayment: 150, endAge: 0, repay: 'equal' },
      { name: '지인 대출', balance: 30000, rate: 4, monthlyPayment: 100, endAge: 0, repay: 'bullet', maturity: 'open' },
    ];
    const csv = toCSV('liabilities', loans);
    expect(csv.split(/\r?\n/)[0]).toContain('건보 대출 공제');
    const { rows, errors } = fromCSV('liabilities', csv);
    expect(errors).toEqual([]);
    expect(rows).toEqual(loans);
  });
  it('재무목표 금액 방식 열 왕복, 비어 있으면 물가 반영', () => {
    const goals = [
      { name: '보유세', category: 'other', targetAge: 59, amountPV: 800, growthRate: 2.5, endAge: 100 },
      { name: '약정 기부', category: 'other', targetAge: 60, amountPV: 100, growthRate: 0, endAge: 70, priceMode: 'fixed' },
    ];
    const csv = toCSV('goals', goals);
    expect(csv.slice(0, csv.indexOf(String.fromCharCode(10)))).toContain('금액 방식');
    const { rows, errors } = fromCSV('goals', csv);
    expect(errors).toEqual([]);
    expect(rows).toEqual(goals);
  });
  it('보험 납입 종료 나이 왕복, 열이 없는 예전 파일은 0', () => {
    const ins = [{ name: '종신보험', death: 10000, critical: 0, care: 0, monthlyPremium: 20, payEndAge: 60 }];
    const csv = toCSV('insurance', ins);
    expect(csv.split(/\r?\n/)[0]).toContain('납입 종료 나이');
    expect(fromCSV('insurance', csv).rows).toEqual(ins);
    const old = fromCSV('insurance', '상품명,사망보장,진단비,간병보장,월 보험료\n암보험,0,3000,0,5');
    expect(old.errors).toEqual([]);
    expect(old.rows[0].payEndAge ?? 0).toBe(0);
  });
  it('보험 피보험자·자녀 출생연도 선택 열 왕복, 비어 있으면 본인', () => {
    const ins = [
      { name: '자녀 실손', death: 0, critical: 0, care: 0, monthlyPremium: 3, payEndAge: 20, insured: 'child', insuredBirthYear: 2015 },
      { name: '배우자 종신', death: 10000, critical: 0, care: 0, monthlyPremium: 15, payEndAge: 60, insured: 'spouse' },
      { name: '본인 암보험', death: 0, critical: 3000, care: 0, monthlyPremium: 5, payEndAge: 0 },
    ];
    const csv = toCSV('insurance', ins);
    expect(csv.split(/\r?\n/)[0]).toContain('피보험자');
    expect(csv).toContain('자녀');
    const { rows, errors } = fromCSV('insurance', csv);
    expect(errors).toEqual([]);
    expect(rows).toEqual(ins);
  });
  it('양식에 부동산·노란우산 예시 행 포함', () => {
    const { rows, errors } = fromCSV('assets', templateCSV('assets'));
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.type)).toEqual(['deposit', 'realestate', 'other']);
    expect(rows[2]).toMatchObject({ yu: true, yuPay: 600, yuPayTo: 2039, yuLastMonths: 3, yuJoin: 2016, yuJoinMonth: 9, yuPayoutMonth: 3 });
    expect(rows[1]).toMatchObject({ reUse: 'rental', rent: 100, deposit: 5000, owner: 'joint', ownerShare: 50 });
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

describe('월별 실제 인출 기록 CSV', () => {
  it('내보내기 → 가져오기 왕복(월·계좌 순 정렬)', () => {
    const rows = [
      { month: '2026-12', account: '교보', amount: 450 },
      { month: '2026-11', account: '퇴직 IRP', amount: 6, note: '최소 인출' },
      { month: '2026-11', account: '교보', amount: 450.5 },
    ];
    const csv = drawsToCSV(rows);
    const lines = csv.split(/\r?\n/);
    expect(lines[0]).toBe('월,계좌,세전 인출액,메모');
    expect(lines[1]).toBe('2026-11,교보,450.5,');
    const back = drawsFromCSV('﻿' + csv);
    expect(back.errors).toEqual([]);
    expect(back.rows).toEqual([rows[2], rows[1], rows[0]]);
  });
  it('달 형식 정리·같은 달 계좌 합산·잘못된 줄은 건너뜀', () => {
    const text = ['월,계좌,금액,메모', '2026/11,교보,"1,000",', '2026.11.25,교보,200,추가', '2026-11,ISA·일반,0,', '11월,교보,100,', '2026-12,,50,', '2026-12,교보,-5,'].join('\n');
    const { rows, errors } = drawsFromCSV(text);
    expect(rows).toEqual([{ month: '2026-11', account: '교보', amount: 1200, note: '추가' }]);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain('5행');
  });
  it('양식: 지금 계획의 계좌 이름으로 한 달', () => {
    const { rows } = drawsFromCSV(drawsTemplateCSV('2026-11', ['교보', '퇴직 IRP', 'ISA·일반']));
    expect(drawsTemplateCSV('2026-11', ['교보', '퇴직 IRP']).split(/\r?\n/)).toHaveLength(3);
    expect(rows).toEqual([{ month: '2026-11', account: '교보', amount: 100, note: '예시: 지우고 쓰세요' }]);
  });

  describe('연금 계좌 설정 CSV', () => {
    it('과세제외·퇴직금 재원·연차·인출 순서가 내보내기·가져오기에서 유지됨', () => {
      const pension = { name: 'IRP', type: 'pension', amount: 9000, purpose: 'long', nature: 'invest', expectedReturn: 4, volatility: 8, owner: 'spouse', taxFree: 300, retirePart: 5000, pensionYear1: 2028, drawStartYear: 2031, drawOrder: 2, compareOrder: 1 };
      const { rows, errors } = fromCSV('assets', toCSV('assets', [pension]));
      expect(errors).toHaveLength(0);
      expect(rows[0]).toMatchObject(pension);
    });
    it('연금 계좌가 아닌 행에서는 연금 전용 열을 쓰지 않음', () => {
      const deposit = { name: '예금', type: 'deposit', amount: 100, purpose: 'short', nature: 'safe', expectedReturn: 3, volatility: 0.5, taxFree: 50, drawOrder: 3 };
      const csv = toCSV('assets', [deposit]);
      const { rows } = fromCSV('assets', csv);
      expect(rows[0].taxFree).toBeUndefined();
      expect(rows[0].drawOrder).toBeUndefined();
      expect(templateCSV('assets')).toContain('과세제외 금액');
    });
  });
});
