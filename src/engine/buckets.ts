import type { TaxResult } from './tax';

/** IRP·DC 등 퇴직연금 계좌의 위험자산 한도(평가액 대비) */
export const IRP_RISK_CAP = 0.7;
/** 하락장 기준: 주식형 지수가 고점보다 이만큼(%) 넘게 떨어지면 주식 매도를 멈춤 */
export const BEAR_DROP = 15;

/** 이름으로 퇴직연금 계좌(IRP·DC·퇴직연금) 여부를 판단: 위험자산 70% 한도 적용 */
export const isRiskCapped = (name: string) => /IRP|DC|퇴직/i.test(name);

export interface AccountBucket {
  name: string;
  owner: 'self' | 'spouse';
  balance: number; // 첫해 연초 평가액(명목)
  cash: number; // ① 현금성: 앞 2년 동안 그 계좌에서 빠져나갈 금액
  bond: number; // ② 채권·배당: 3~5년차 인출분(+ 위험자산 한도를 넘는 몫)
  growth: number; // ③ 성장(지수 ETF 등)
  alt: number; // ④ 대체자산(금·리츠 ETF 등)
  capped: boolean; // 위험자산 70% 한도 계좌
  riskShare: number; // 위험자산 비중(③+④) %
}

/**
 * 엑셀 ‘투자배분’ 시트: 계좌마다 인출이 나가는 그 계좌 안에 현금성 바구니를 둠.
 * ① 현금성 = 앞 2년 인출분, ② 채권·배당 = 3~5년차 인출분, ④ 대체 = 평가액 × altShare(①·②를 채우고 남는 금액 안에서),
 * ③ 성장 = 나머지. 퇴직연금 계좌는 ③+④가 평가액의 70%를 넘지 않게 하고 넘는 몫은 ②로 돌림.
 * 금액은 그 해 금액(명목), 연금 세금 계산(tax)의 계좌별 세전 인출 계획을 씀.
 * partialFirst: 첫 행이 올해 남은 달만 계산한 해면 ‘앞 2년’에 그 다음 2년까지(엑셀처럼 3행), ‘3~5년차’는 그 뒤 3년.
 */
export function accountBuckets(tax: TaxResult, altShare = 0.1, partialFirst = false): AccountBucket[] {
  const first = tax.rows[0];
  if (!first) return [];
  const k = partialFirst ? 1 : 0;
  const drawn = (i: number, from: number, to: number) => tax.rows.slice(from, to).reduce((a, r) => a + (r.accounts[i]?.drawn ?? 0), 0);
  return first.accounts.map((a, i) => {
    const balance = a.start;
    const cash = Math.min(balance, drawn(i, 0, 2 + k));
    const later = Math.min(balance - cash, drawn(i, 2 + k, 5 + k));
    const free = Math.max(0, balance - cash - later);
    const alt = Math.min(Math.max(0, altShare) * balance, free);
    const capped = isRiskCapped(a.name);
    const growth = Math.max(0, capped ? Math.min(free - alt, IRP_RISK_CAP * balance - alt) : free - alt);
    const bond = Math.max(0, balance - cash - growth - alt);
    return { name: a.name, owner: a.owner, balance, cash, bond, growth, alt, capped, riskShare: balance > 0 ? ((growth + alt) / balance) * 100 : 0 };
  });
}

export type MarketState = 'bear' | 'peak' | 'normal';

/** 주식형 지수의 고점 대비 등락률(%, 음수 = 하락)로 시장 상태 판단 */
export const marketState = (drawdown: number): MarketState => (drawdown <= -BEAR_DROP ? 'bear' : drawdown >= 0 ? 'peak' : 'normal');

/** 시장 상태별 지금 적용할 규칙(엑셀 ‘투자배분’ 시트) */
export function marketRule(drawdown: number) {
  const state = marketState(drawdown);
  if (state === 'bear') return { state, text: `하락장(고점 대비 ${drawdown}%): 주식형 매도를 멈추고 현금성 바구니에서만 인출, 리밸런싱 보류. 금 ETF가 올랐다면 그 일부로 현금성을 채웁니다.` };
  if (state === 'peak') return { state, text: '고점 부근: 주식형 일부를 팔아 현금성 바구니를 목표(약 2년치)까지 채웁니다.' };
  return { state, text: `보통(고점 대비 ${drawdown}%): 계획대로 인출하고 1년에 한 번(1월) 리밸런싱합니다.` };
}
