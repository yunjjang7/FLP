import type { Asset, IncomeOwner, Level, Profile } from '../types';

/**
 * 세액공제 확인 대조표(엑셀 ‘세액공제확인’ 시트).
 * 홈택스 ‘연금보험료 등 소득·세액 공제확인서’의 연금계좌 세액공제 대상 금액과
 * 계좌별 개인 입금액·과세제외 금액을 사람별로 비교해, 계획에 덜 잡힌 비과세 재원(과세제외)이 있는지 알려 줌.
 * 금액 단위: 만원
 */

/** 인정되면 아끼는 세금 추정에 쓰는 연금소득세율(70세 미만, %) */
export const CREDIT_CHECK_TAX = 5.5;

export interface CreditAccountRow {
  name: string;
  owner: IncomeOwner;
  paidIn?: number; // 개인 입금액(비우면 undefined)
  taxFree: number; // 계획에 넣은 과세제외
  credited?: number; // 계좌별로 세액공제받은 것으로 보이는 금액 = 입금 − 과세제외
}

export interface CreditPersonRow {
  owner: IncomeOwner;
  certified?: number; // 확인서 세액공제 대상 금액(비우면 undefined)
  paidIn: number; // 개인 입금액 합계
  missingPaidIn: number; // 개인 입금액을 넣지 않은 연금계좌 수
  certExempt?: number; // 확인서 기준 과세제외 = 입금 합계 − 확인서
  planExempt: number; // 지금 계획에 넣은 과세제외 합계
  gap?: number; // 확인서 기준 − 계획(+면 덜 잡힌 비과세 재원, −면 많이 잡힘)
  saving?: number; // 덜 잡힌 비과세 재원이 인정되면 아끼는 연금소득세(5.5% 추정)
  level?: Level;
  note: string;
}

const ownerOf = (a: Asset): IncomeOwner => (a.owner === 'spouse' ? 'spouse' : 'self');

/** 차이가 이 금액(만원) 이하면 같은 것으로 봄(원 단위 반올림 차이) */
const TOL = 1;

export function creditCheck(profile: Pick<Profile, 'spouseBirthYear' | 'creditCert'>, assets: Asset[]) {
  const pens = assets.filter((a) => a.type === 'pension');
  // ‘같은 계좌’ 이름이 같은 줄은 한 계좌로 합침(개인 입금액·과세제외는 어느 줄에 넣어도 됨)
  const byAcct = new Map<string, Asset[]>();
  pens.forEach((a, i) => {
    const key = a.group?.trim() ? `g:${ownerOf(a)}:${a.group.trim()}` : `i:${a.id ?? i}`;
    byAcct.set(key, [...(byAcct.get(key) ?? []), a]);
  });
  const accounts: CreditAccountRow[] = [...byAcct.values()].map((rows) => {
    const taxFree = rows.reduce((s, a) => s + (a.taxFree ?? 0), 0);
    const paid = rows.reduce((s, a) => s + (a.paidIn ?? 0), 0);
    const paidIn = paid > 0 ? paid : undefined;
    const name = rows[0].group?.trim() || rows[0].name;
    return { name, owner: ownerOf(rows[0]), paidIn, taxFree, credited: paidIn !== undefined ? paidIn - taxFree : undefined };
  });
  const owners: IncomeOwner[] = profile.spouseBirthYear > 0 ? ['self', 'spouse'] : ['self'];
  const people: CreditPersonRow[] = owners
    .map((owner) => {
      const mine = accounts.filter((r) => r.owner === owner);
      const cert = profile.creditCert?.[owner];
      const certified = cert && cert > 0 ? cert : undefined;
      const paidIn = mine.reduce((s, r) => s + (r.paidIn ?? 0), 0);
      const missingPaidIn = mine.filter((r) => r.paidIn === undefined).length;
      const planExempt = mine.reduce((s, r) => s + r.taxFree, 0);
      const row: CreditPersonRow = { owner, certified, paidIn, missingPaidIn, planExempt, note: '' };
      if (mine.length === 0) return null;
      if (certified === undefined) return { ...row, note: '확인서의 연금계좌 세액공제 대상 금액을 넣으면 비교합니다.' };
      if (paidIn <= 0) return { ...row, note: '계좌별 개인 입금액을 넣으면 비교합니다(자산 탭 각 연금 자산).' };
      // 개인 입금액이 빈 계좌는 0으로 봄(DC·퇴직금만 든 IRP처럼 본인 납입이 없는 계좌)
      const names = mine.filter((r) => r.paidIn === undefined).map((r) => r.name).join(', ');
      const tail = names ? ` 개인 입금액이 빈 계좌(${names})는 본인 납입이 없는 것(0)으로 계산했습니다. 납입한 적이 있으면 넣으세요.` : '';
      const certExempt = paidIn - certified;
      const gap = certExempt - planExempt;
      if (certExempt < -TOL) {
        return { ...row, certExempt, gap, level: 'caution' as Level, note: `입금 합계가 확인서 세액공제 대상 금액보다 적습니다. 입금액이 빠진 계좌가 없는지 확인하세요.${tail}` };
      }
      if (gap > TOL) {
        const saving = (gap * CREDIT_CHECK_TAX) / 100;
        return { ...row, certExempt, gap, saving, level: 'caution' as Level, note: `확인서 기준으로 비과세 재원이 계획보다 ${gap.toLocaleString('ko-KR', { maximumFractionDigits: 0 })}만원 더 있을 수 있습니다. 증권사에서 계좌별 과세제외 금액을 확인해 인정되면 자산 탭 과세제외에 나눠 넣으세요.${tail}` };
      }
      if (gap < -TOL) {
        return { ...row, certExempt, gap, level: 'caution' as Level, note: `계획의 과세제외가 확인서 기준보다 ${(-gap).toLocaleString('ko-KR', { maximumFractionDigits: 0 })}만원 많습니다. 실제보다 많으면 세금이 적게 계산되니 증권사 금액과 맞춰 보세요.${tail}` };
      }
      return { ...row, certExempt, gap, level: 'good' as Level, note: `확인서 기준과 계획의 과세제외가 같습니다.${tail}` };
    })
    .filter((r): r is CreditPersonRow => r !== null);
  return { accounts, people };
}
