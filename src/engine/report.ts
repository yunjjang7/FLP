import { won, pct } from '../lib/format';
import type { Goal, Level, Liability, Profile } from '../types';
import { bulletNoMaturity, bulletOpenEnded, isRecurring } from './goals';
import { deterministicPath, incomeValue, type PlanInput, type SimResult } from './montecarlo';
import type { Summary } from './portfolio';
import type { Retax } from './pensionTaxPlan';
import type { Prescription } from './prescribe';
import type { RiskCheck } from './risk';

/** 요약 보고서의 한 문장(level 이 있으면 앞에 상태 점) */
export interface ReportLine {
  text: string;
  level?: Level;
}
export interface ReportSection {
  title: string;
  lines: ReportLine[];
}

export interface ReportInput {
  profile: Profile;
  summary: Summary;
  planInput: PlanInput;
  sim: SimResult;
  start: { age: number; retired: boolean; balance: number; outflow: number; rate: number };
  need: { need: number; projected: number; ratio: number };
  liabilities: Liability[];
  goals: Goal[];
  checks: RiskCheck[];
  rx: Prescription[];
  nowYear: number;
  retax?: Retax; // 수익률 ±2%p 고갈 나이에서 연금 인출 세금을 바뀐 수익률로 다시 계산
}

/** 고갈 나이 문장: 끝까지 남으면 ‘N세까지 유지’ */
export const depletionText = (age: number | null, life: number) => (age === null ? `${life}세까지 유지` : `${age}세에 고갈`);

/** 수익률을 delta(%p)만큼 바꾼 평균 수익 경로의 고갈 나이(은퇴 후 수익률을 따로 두었으면 그것도 같이) */
export function depletionWithReturn(input: PlanInput, delta: number, retax: Retax = (x) => x) {
  return deterministicPath(retax({
    ...input,
    meanReturn: input.meanReturn + delta,
    ...(input.retireMeanReturn !== undefined ? { retireMeanReturn: input.retireMeanReturn + delta } : {}),
  })).depletedAt;
}

/** 은퇴 후 생활비 방식 한 문장 */
export function livingText(p: Profile) {
  if (p.expenseMode === 'draw') {
    const inc = [p.drawIncludes?.includes('debt') && '대출 상환', p.drawIncludes?.includes('premium') && '보험료'].filter(Boolean).join('·');
    return `연금계좌 인출과 국민연금으로 월 ${won(p.fixedDraw ?? 0)}을 금액 그대로 쓰고(물가가 올라도 고정), 임대료 등 다른 소득은 따로 모두 씁니다${inc ? `. ${inc}도 이 금액 안에서 냅니다` : ''}`;
  }
  const steps = (p.expenseSteps ?? []).filter((x) => x.fromAge > 0).sort((a, b) => a.fromAge - b.fromAge);
  const stepText = steps.length ? ` 나이가 들면 ${steps.map((x) => `${x.fromAge}세부터 월 ${won(x.monthly)}`).join(', ')}으로 줄입니다.` : '';
  const how = p.expenseMode === 'growth' ? `금액이 해마다 ${p.expenseGrowth ?? 0}%만 오릅니다(물가 ${p.inflation}%)` : '물가만큼 올라 생활 수준이 유지됩니다';
  return `은퇴 후 월 ${won(p.retireMonthlyExpense)}(오늘 물가)을 쓰고 ${how}.${stepText}`;
}

const sentence = (s: string) => (/[.)]$/.test(s) ? s : `${s}.`);

/** 계획 전체를 문장으로 정리한 한 장짜리 보고서 */
export function buildReport(x: ReportInput): ReportSection[] {
  const { profile: p, summary: s, planInput: inp, sim, start, need } = x;
  const life = p.lifeExpectancy;
  const target = p.criteria.successTarget;
  const base = deterministicPath(inp).depletedAt;
  const low = depletionWithReturn(inp, -2, x.retax);
  const high = depletionWithReturn(inp, 2, x.retax);
  const mean = inp.retireMeanReturn ?? inp.meanReturn;
  const rateLevel: Level = sim.successRate >= target ? 'good' : sim.successRate >= 60 ? 'caution' : 'danger';
  const wLevel: Level = start.rate <= p.criteria.withdrawRateMax ? 'good' : start.rate <= p.criteria.withdrawRateMax * 1.25 ? 'caution' : 'danger';

  const summaryLines: ReportLine[] = [
    { text: `지금 ${s.age}세(${x.nowYear}년)이고 ${start.retired ? `${p.retireAge}세에 은퇴해 자산에서 꺼내 쓰는 중` : `${p.retireAge}세에 은퇴할 계획`}입니다. ${life}세까지 계산했습니다.` },
    { text: sentence(`생활비: ${livingText(p)}`) },
    {
      text: `성공확률은 ${pct(sim.successRate)}입니다(수익률이 해마다 오르내리는 경우 1,000개 중 ${life}세까지 자산이 남는 비율). 목표 ${target}%${sim.successRate >= target ? '를 넘습니다' : '에 못 미칩니다'}.`,
      level: rateLevel,
    },
    {
      text: `평균 수익(은퇴 후 연 ${mean.toFixed(1)}%)이 해마다 고르게 나면 ${depletionText(base, life)}입니다. 수익률이 2%p 낮으면 ${depletionText(low, life)}, 2%p 높으면 ${depletionText(high, life)}입니다.`,
      level: base === null ? 'good' : base >= 90 ? 'caution' : 'danger',
    },
    ...(sim.medianDepletionAge !== null ? [{ text: `자산이 바닥나는 시나리오만 보면 절반이 ${sim.medianDepletionAge}세 전에 바닥납니다.` }] : []),
    {
      text: `${start.retired ? '올해' : `은퇴 첫해(${start.age}세)`} 자산 인출은 월 ${won(start.outflow / 12)}이고, 금융자산 ${won(start.balance)} 대비 인출률 ${pct(start.rate, 1)}(상한 ${p.criteria.withdrawRateMax}%)입니다.`,
      level: wLevel,
    },
    {
      text: `노후 필요자금 ${won(need.need)}(오늘 가치) 대비 ${start.retired ? '지금' : '은퇴 시점 예상'} 금융자산 ${won(need.projected)}으로 준비율 ${pct(need.ratio)}입니다.`,
      level: need.ratio >= 100 ? 'good' : need.ratio >= 80 ? 'caution' : 'danger',
    },
  ];

  // 자산·부채
  const lockedIn = (inp.inflows ?? []).filter((f) => !f.kind);
  const sales = (inp.inflows ?? []).filter((f) => f.kind === 'sale');
  const debtLines: ReportLine[] = x.liabilities
    .filter((l) => l.balance > 0)
    .map((l) => {
      const noEnd = bulletNoMaturity(l, s.age);
      const open = bulletOpenEnded(l, s.age);
      const how = l.repay === 'bullet'
        ? open ? '만기 미정(이자만 납입), 이자만 기대수명까지 내는 것으로 계산(원금은 갚는 시점이 없어 계산에 없음)'
          : noEnd ? '만기 나이가 비어 이자만 계속 내는 것으로 계산(원금 상환이 계산에 빠짐)' : `${l.endAge}세 만기에 원금 상환`
        : (l.endAge ?? 0) > 0 ? `${l.endAge}세에 상환 종료` : '상환 종료 나이 자동 계산';
      return { text: `${l.name}: 잔액 ${won(l.balance)}, 금리 ${l.rate}%, 월 ${won(l.monthlyPayment)} · ${how}.`, level: noEnd && !open ? ('caution' as Level) : undefined };
    });
  const assetLines: ReportLine[] = [
    { text: `총자산 ${won(s.totalAssets)}, 부채 ${won(s.totalDebt)}, 순자산 ${won(s.netWorth)}입니다. 금융자산 ${won(s.financialAssets)}, 부동산 ${won(s.realEstate)}입니다.` },
    {
      text: `노후 계산은 지금 꺼내 쓸 수 있는 금융자산 ${won(inp.startBalance)}에서 시작합니다(기대수익률 ${inp.meanReturn.toFixed(1)}%, 변동성 ${inp.volatility.toFixed(1)}%${inp.retireMeanReturn !== undefined ? `, 은퇴 후 ${inp.retireMeanReturn.toFixed(1)}%` : ''}).`,
    },
    ...lockedIn.map((f) => ({ text: `${f.name ?? '묶인 자산'}: ${f.age}세에 세후 ${won(f.amount)}(오늘 가치)을 받아 함께 운용합니다.` })),
    ...sales.map((f) => ({ text: `${f.name ?? '부동산'}: ${f.age}세에 매각해 ${won(f.amount)}(비용·보증금 뺀 금액, 오늘 가치)이 들어옵니다.` })),
    ...debtLines,
  ];

  // 노후 소득과 지출
  const incomes: ReportLine[] = inp.pensions
    .filter((q) => q.annual > 0)
    .map((q) => {
      // 시작하는 해는 생일 다음 달부터라 일부만 받으므로, 월액은 1년 내내 받는 다음 해 기준
      const from = Math.max(q.startAge, start.age);
      const first = incomeValue(q, from + (from === q.startAge && q.firstShare !== undefined ? 1 : 0), inp.inflation);
      const end = q.endAge && q.endAge > 0 ? `~${q.endAge}세` : '';
      return { text: `${q.name || '소득'}: 월 ${won(first / 12)}(${from}세${end ? end : '부터'}, 오늘 가치).` };
    });
  const premiumNames = [...new Set(inp.goals.filter((g) => g.premium).map((g) => g.premium!))];
  const premiumLines: ReportLine[] = premiumNames.map((name) => {
    const rows = inp.goals.filter((g) => g.premium === name);
    return { text: `보험료 ${name}: 은퇴 뒤 ${rows[0].age}~${rows[rows.length - 1].age}세에 자산에서 따로 냅니다(첫해 월 ${won(rows[0].amount / 12)}).` };
  });
  const goalLines: ReportLine[] = x.goals
    .filter((g) => g.category !== 'retirement' && g.targetAge > 0)
    .map((g) => ({
      text: `${g.name}: ${isRecurring(g) ? `${g.targetAge}~${g.endAge}세에 해마다` : `${g.targetAge}세에`} ${won(g.amountPV)}(오늘 가치${g.priceMode === 'fixed' ? ', 금액 고정' : g.growthRate ? `, 해마다 ${g.growthRate}% 상승` : ''}).`,
    }));
  const skipped = x.goals.filter((g) => g.category !== 'retirement' && !(g.targetAge > 0));
  const npTax = inp.goals.filter((g) => g.npTax);
  const penTax = inp.goals.filter((g) => g.pensionTax);
  const penTaxSum = penTax.reduce((a, g) => a + g.amount, 0);
  const flowLines: ReportLine[] = [
    ...incomes,
    ...goalLines,
    ...premiumLines,
    ...(npTax.length ? [{ text: `국민연금 때문에 늘어나는 종합소득세·건강보험료를 ${npTax[0].age}세부터 자산에서 더 꺼냅니다(첫해 월 ${won(npTax[0].amount / 12)} → ${npTax[npTax.length - 1].age}세 월 ${won(npTax[npTax.length - 1].amount / 12)}).` }] : []),
    ...(penTax.length ? [{ text: `연금계좌 인출 세금(연금소득세 5.5·4.4·3.3%, 1,500만 초과분 16.5%, 퇴직소득세)으로 ${penTax[0].age}~${penTax[penTax.length - 1].age}세에 모두 ${won(penTaxSum)}을 더 꺼냅니다(해마다 평균 ${won(penTaxSum / penTax.length)}, 오늘 가치).` }] : []),
    ...(skipped.length ? [{ text: `목표 나이가 비어 있는 ${skipped.map((g) => g.name).join(', ')}은(는) 계산에 넣지 않았습니다.`, level: 'caution' as Level }] : []),
  ];

  const risks: ReportLine[] = x.checks.filter((c) => c.level !== 'good').map((c) => ({ text: `${c.label}(${c.value}): ${c.detail}`, level: c.level }));
  // 점검 항목과 같은 제목(만기 나이 입력 등)은 한 번만
  const shown = new Set(x.checks.map((c) => c.label));
  const actions: ReportLine[] = x.rx
    .filter((r) => r.level !== 'good' && !r.badge && !shown.has(r.title))
    .sort((a, b) => (a.level === 'danger' ? 0 : 1) - (b.level === 'danger' ? 0 : 1))
    .slice(0, 6)
    .map((r) => ({ text: `${r.title}: ${r.detail}`, level: r.level }));

  const limits: ReportLine[] = [
    { text: `금액은 모두 오늘 물가 기준이며 물가상승률은 연 ${p.inflation}%로 봤습니다. 대출 상환액·보험료처럼 계약 금액이 정해진 지출은 물가만큼 실제 부담이 줄어듭니다.` },
    { text: '고갈 나이는 평균 수익이 해마다 고르게 나는 한 가지 경로입니다. 은퇴 초기에 큰 하락이 오면 같은 평균 수익률이라도 결과가 더 나쁠 수 있어 성공확률을 함께 봅니다.' },
    p.planPensionTax === false
      ? { text: '연금계좌 인출 세금은 프로필 설정(‘노후 진단에 연금 인출 세금 반영’: 아니오)에 따라 성공확률·고갈 나이에 넣지 않았습니다(엑셀과 같은 기준). 실제로는 세금만큼 더 꺼내야 하므로 결과가 그만큼 낙관적입니다.', level: 'caution' as Level }
      : { text: '연금계좌 인출 세금은 인출 계획 화면과 같은 방식(가드레일 인출, 평균 수익 경로)으로 나이별 금액을 한 번 구해 모든 몬테카를로 경로에 같게 더했습니다. 수익이 나빠 덜 꺼내는 해에 세금이 줄어드는 효과는 빠집니다. 수익률·생활비를 바꿔 본 결과(민감도·스트레스 테스트·처방)는 바꾼 계획으로 세금을 다시 계산했습니다.' },
    { text: '세법·국민연금 제도는 지금 기준이며 실제 수령액·세금은 국민연금공단·증권사·세무 전문가에게 확인하세요. 이 보고서는 투자 자문이 아닙니다.' },
  ];

  return [
    { title: '1. 한눈에 보는 결론', lines: summaryLines },
    { title: '2. 자산과 부채', lines: assetLines },
    { title: '3. 노후 소득과 따로 나가는 돈', lines: flowLines.length ? flowLines : [{ text: '은퇴 후 소득이나 따로 나가는 돈이 없습니다.' }] },
    { title: '4. 점검이 필요한 항목', lines: risks.length ? risks : [{ text: '주의나 위험으로 나온 점검 항목이 없습니다.', level: 'good' }] },
    { title: '5. 권장 대응', lines: actions.length ? actions : [{ text: '지금 바로 바꿀 처방이 없습니다. 해마다 연말결산으로 계획을 다시 확인하세요.', level: 'good' }] },
    { title: '6. 가정과 한계', lines: limits },
  ];
}
