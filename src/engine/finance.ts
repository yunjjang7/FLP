// 표준 재무함수 (금리는 기간당 소수, 예: 0.05)

export const fvLump = (pv: number, r: number, n: number) => pv * Math.pow(1 + r, n);

export const fvAnnuity = (pmt: number, r: number, n: number) =>
  r === 0 ? pmt * n : (pmt * (Math.pow(1 + r, n) - 1)) / r;

export const pvAnnuity = (pmt: number, r: number, n: number) =>
  r === 0 ? pmt * n : (pmt * (1 - Math.pow(1 + r, -n))) / r;

export const pvLump = (fv: number, r: number, n: number) => fv / Math.pow(1 + r, n);

/** 현재 보유액 pv 에서 n기간 뒤 target 을 만들기 위한 기간당 적립액(음수면 0) */
export function pmtForTarget(target: number, pv: number, r: number, n: number) {
  if (n <= 0) return Math.max(0, target - pv);
  const gap = target - fvLump(pv, r, n);
  if (gap <= 0) return 0;
  const factor = r === 0 ? n : (Math.pow(1 + r, n) - 1) / r;
  return gap / factor;
}

/** 명목수익률·물가(%) → 실질수익률(소수) */
export const realRate = (nominalPct: number, inflationPct: number) =>
  (1 + nominalPct / 100) / (1 + inflationPct / 100) - 1;

/** 연이율(%) → 월이율(소수) — 복리 동등 */
export const monthlyRate = (annualPct: number) => Math.pow(1 + annualPct / 100, 1 / 12) - 1;

/** 원리금 균등 상환 시 남은 개월 수. 월상환액이 이자보다 작아 끝나지 않으면 null */
export function payoffMonths(balance: number, ratePct: number, payment: number): number | null {
  if (balance <= 0) return 0;
  if (payment <= 0) return null;
  const r = ratePct / 1200;
  if (r <= 0) return Math.ceil(balance / payment);
  const x = 1 - (balance * r) / payment;
  if (x <= 0) return null;
  return Math.ceil(-Math.log(x) / Math.log(1 + r));
}

export const clamp =(v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** value 가 bad → good 으로 갈수록 0 → 1 (방향 무관) */
export function scale(value: number, bad: number, good: number) {
  if (good === bad) return value >= good ? 1 : 0;
  return clamp((value - bad) / (good - bad), 0, 1);
}

/** 국민연금 조기 수령 감액(1년당)·연기 수령 증액(1년당), 최대 5년 */
export const NPS_EARLY = 0.06;
export const NPS_DEFER = 0.072;

export function npsFactor(age: number, normalAge: number) {
  const d = Math.max(-5, Math.min(5, age - normalAge));
  return d < 0 ? 1 + NPS_EARLY * d : 1 + NPS_DEFER * d;
}
