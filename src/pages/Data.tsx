import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { downloadText, fromCSV, templateCSV, toCSV } from '../db/csv';
import { db, exportBackup, importBackup, loadSample, resetAll, type ListTable } from '../db/db';
import { INSURED_WHO, TABLES, type FieldDef } from '../db/schema';
import { housePension, HP_LOAN, HP_MARKET_CAP, hpEstate, hpEstimate, hpLoanOf, netRentOf, RE_USE, RE_USE_HINT, RENT_DEFAULT, rentDuplicates, rentYield, reUseOf, saleInflow, usesHp, willSell } from '../engine/realestate';
import { JoinAccount, UndoBar } from '../components/JoinAccount';
import { alignAccount, setAccountKey, setGroupInDb } from '../db/accountOps';
import { ACCOUNT_KEY_LABEL, ACCOUNT_KEYS, accountMismatch, ASSET_TYPES, groupNames, groupNotes, groupOf, insuredBirthYear, type AccountKey, isInsuranceCashflow, isPaying, payEndSelfAge, pensionOverlap, RISK_PROFILES, volCheck, volMid, volRange } from '../engine/portfolio';
import { Labeled, NumberField, SelectField, TextField } from '../components/fields';
import { Button, Card, MoveButtons, PageHeader } from '../components/ui';
import { appendOrders, byOrder, moveItem, moveRow, nextOrder } from '../db/order';
import { CardLink, jumpToTarget, SetupLink } from '../components/SetupLink';
import { isRecurring, lockedInflow, spouseToSelf } from '../engine/goals';
import { pct, won } from '../lib/format';
import { useFlp } from '../store/FlpContext';
import { useSurvivor } from '../store/useSurvivor';
import { round1, survivorBenefitText } from '../engine/survivor';
import { bulletMissingMaturity, equalMonthlyDecline, equalPrincipal, loanEndAge } from '../engine/goals';
import { PENSION_OPEN_AGE, pensionLimit, pensionYearNo } from '../engine/tax';
import { creditCheck, CREDIT_CHECK_TAX } from '../engine/creditCheck';
import { CREDIT_CAP, DEFAULT_CONTRIB, DEFAULT_INCOME_TAX, HI_LOAN_CAP, HI_LOAN_RATE, hiLoanDeduct, INCOME_KIND, INCOME_KIND_HINT, incomeKindOf, incomeTaxSchedule, yuAssetDed } from '../engine/incomeTax';
import { isYu, YU_CEO_WAGE, yuPayTo } from '../engine/yellowUmbrella';
import type { Asset, AssetType, ReUse, ContribPlan, Criteria, DrawInclude, ExpenseBand, ExpenseMode, Goal, IncomeKind, IncomeOwner, IncomeTaxSettings, Insurance, Liability, Profile, RetireIncome } from '../types';
import type { CoverageLine } from '../engine/insurance';

const EXPENSE_MODES: Record<ExpenseMode, string> = { real: '물가 연동(기본)', growth: '명목 증가율 지정', draw: '연금 생활비 명목 고정(엑셀 방식)' };
const EXPENSE_HINT: Record<ExpenseMode, string> = {
  real: '물가만큼 올라 생활 수준 유지',
  growth: '생활비가 정한 비율로만 오름',
  draw: '연금계좌+국민연금은 같은 금액, 임대료 등은 모두 씀',
};

/** 연금 생활비 고정액에 이미 들어 있는 지출: 예이면 은퇴 후 따로 더 꺼내지 않음 */
const DRAW_INCLUDES: [DrawInclude, string, string][] = [
  ['debt', '월 금액에 대출 상환액 포함', '예: 은퇴 후 대출 월 상환액(이자)을 따로 꺼내지 않음 · 만기 원금은 따로'],
  ['premium', '월 금액에 보험료 포함', '예: 은퇴 뒤까지 내는 보험료를 따로 꺼내지 않음'],
];

type Tab = 'profile' | ListTable | 'criteria' | 'backup';
const TABS: { key: Tab; label: string }[] = [
  { key: 'profile', label: '프로필' },
  { key: 'assets', label: '자산' },
  { key: 'liabilities', label: '부채' },
  { key: 'cashflows', label: '지출' },
  { key: 'goals', label: '재무목표' },
  { key: 'insurance', label: '보험' },
  { key: 'criteria', label: '점검 기준' },
  { key: 'backup', label: '백업·복원' },
];

/** 주소의 ?tab=&card=&field= 로 들어오면 그 탭을 열고 카드·칸으로 스크롤해 잠깐 강조(다른 화면 안내 문구의 바로가기) */
function useSetupTarget(setTab: (t: Tab) => void) {
  const [sp] = useSearchParams();
  const { key } = useLocation();
  useEffect(() => {
    const t = sp.get('tab') as Tab | null;
    if (!t || !TABS.some((x) => x.key === t)) return;
    setTab(t);
    const card = sp.get('card');
    const field = sp.get('field');
    if (!card && !field) {
      window.scrollTo({ top: 0 }); // 탭만 여는 바로가기: 앞 화면의 스크롤 위치가 남지 않게 맨 위로
      return;
    }
    return jumpToTarget(card, field);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

export default function Data() {
  const [tab, setTab] = useState<Tab>('profile');
  useSetupTarget(setTab);
  return (
    <>
      <PageHeader title="기본 정보" desc="모든 데이터는 이 기기의 브라우저 안에만 저장되며 외부로 전송되지 않습니다. 금액 단위는 만원입니다." />
      {/* 탭 버튼은 모두 같은 크기: 좁은 화면은 4칸 두 줄(가로 스크롤 없이 다 보이게), 넓으면 8칸 한 줄, 아주 넓으면 고정 너비 + 구분선 */}
      <div className="mb-4">
        <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-8 md:grid-cols-4 lg:grid-cols-8 xl:flex xl:w-max">
          {TABS.map((t) => (
            <Fragment key={t.key}>
              {/* 백업·복원은 입력 탭과 성격이 달라 구분선으로 띄움 */}
              {t.key === 'backup' && <span aria-hidden className="mx-1.5 hidden self-center text-muted xl:inline">|</span>}
              <button onClick={() => setTab(t.key)} className={`min-w-0 whitespace-nowrap rounded-full border px-1 py-1.5 xl:w-24 xl:shrink-0 text-center text-sm font-medium ${tab === t.key ? 'border-ink bg-ink text-surface' : 'border-line bg-surface text-muted'}`}>
                {t.label}
              </button>
            </Fragment>
          ))}
        </div>
      </div>
      {tab === 'profile' && <ProfileForm />}
      {tab === 'criteria' && <CriteriaForm />}
      {tab === 'backup' && <BackupPanel />}
      {tab !== 'profile' && tab !== 'criteria' && tab !== 'backup' && <ListEditor table={tab} />}
    </>
  );
}

/** ‘개인·퇴직연금 월액’과 자산 탭 연금 계좌가 겹칠 수 있을 때 그 칸 아래 경고 */
function PensionOverlapNote({ accounts }: { accounts: Asset[] }) {
  if (accounts.length === 0) return null;
  return (
    <p role="alert" className="col-span-2 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
      <b>두 번 계산될 수 있어요.</b> 자산 탭 연금 계좌({accounts.map((a) => `${a.name || '연금'} ${won(a.amount)}`).join(', ')}) 잔액은 인출 계획에서 이미 꺼내 씁니다. 그 계좌에서 받을 월 수령액이라면 월액을 0으로 두고, 계좌와 별개로 정해진 금액이 나오는 연금(종신형 연금보험 등)만 넣으세요.
    </p>
  );
}

function useSaveProfile() {
  const { profile } = useFlp();
  return (patch: Partial<Profile>) => db.profile.put({ ...profile, ...patch });
}

function ProfileForm() {
  const { profile: p, summary, start, assets } = useFlp();
  const save = useSaveProfile();
  const rentals = assets.filter((a) => a.type === 'realestate' && reUseOf(a) === 'rental' && (a.rent ?? 0) > 0);
  const incomeHint = start.retired ? '은퇴 나이가 지나 노후 계산에는 쓰지 않습니다(지금 소득은 연금·월세 등 은퇴 후 소득으로 계산)' : [
    p.spouseBirthYear > 0 ? '배우자 소득 포함, 부부 합계' : '',
    rentals.length > 0 ? `은퇴 전 월세(${rentals[0].name || '임대 부동산'}${rentals.length > 1 ? ' 등' : ''})도 합쳐 넣으세요` : '',
  ].filter(Boolean).join(' · ');
  const n = (key: keyof Profile, label: string, unit?: string, hint?: string, step = 1) => (
    <Labeled label={label} hint={hint}>
      <NumberField value={(p[key] as number) ?? 0} unit={unit} step={step} onChange={(v) => save({ [key]: v })} />
    </Labeled>
  );
  const hasSpouse = p.spouseBirthYear > 0;
  const spouseNow = hasSpouse ? summary.age + p.birthYear - p.spouseBirthYear : 0;
  /** 본인 나이 → "2032년" */
  const selfYear = (age: number) => `${p.birthYear + age}년`;
  /** 배우자 나이 → "2038년 · 본인 70세" */
  const spouseYear = (age: number) => (hasSpouse ? `${p.spouseBirthYear + age}년 · 본인 ${spouseToSelf(p, age)}세` : '배우자 나이 기준');
  return (
    <div className="space-y-4">
      <Card title="기본 정보">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Labeled label="이름(선택)">
            <TextField value={p.name} onChange={(v) => save({ name: v })} />
          </Labeled>
          {n('birthYear', '출생연도', '년', `현재 ${summary.age}세`)}
          {n('monthlyIncome', '세후 월소득(가구)', '만원', incomeHint || undefined)}
          <Labeled label="투자 위험성향">
            <SelectField value={p.riskProfile} onChange={(v) => save({ riskProfile: v as Profile['riskProfile'] })} options={Object.fromEntries(Object.entries(RISK_PROFILES).map(([k, v]) => [k, v.label]))} />
          </Labeled>
        </div>
      </Card>
      {start.retired && (
        <p className="rounded-xl border border-brand/30 bg-brand-soft px-4 py-3 text-sm">
          은퇴 희망 나이({p.retireAge}세)가 지났습니다. 지금({summary.age}세) 금융자산에서 바로 인출을 시작하는 것으로 계산합니다. 아직 일하고 있다면 은퇴 나이를 늦춰 주세요.
        </p>
      )}
      <Card title="노후 계획">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {n('retireAge', '은퇴 희망 나이', '세', selfYear(p.retireAge))}
          {n('lifeExpectancy', '계획 기간(기대수명)', '세', `${selfYear(p.lifeExpectancy)}${hasSpouse ? ` · 배우자 ${p.lifeExpectancy + p.birthYear - p.spouseBirthYear}세` : ''}`)}
          {n('retireMonthlyExpense', '은퇴 후 월 생활비', '만원', hasSpouse ? '부부 합계, 현재 물가 기준' : '현재 물가 기준')}
          {n('inflation', '물가상승률', '%', undefined, 0.1)}
          <Labeled label="은퇴 후 생활비 변화" hint={EXPENSE_HINT[p.expenseMode ?? 'real']}>
            <SelectField value={p.expenseMode ?? 'real'} onChange={(v) => save({ expenseMode: v as ExpenseMode })} options={EXPENSE_MODES} />
          </Labeled>
          {p.expenseMode === 'growth' && n('expenseGrowth', '생활비 명목 증가율', '%', `0이면 금액 고정 · 물가 ${p.inflation}%`, 0.1)}
          {p.expenseMode === 'draw' && n('fixedDraw', '연금으로 쓰는 월 금액(세후)', '만원', '국민연금이 나오면 그만큼 계좌 인출 감소')}
          {p.expenseMode === 'draw' &&
            DRAW_INCLUDES.map(([k, label, hint]) => (
              <Labeled key={k} label={label} hint={hint}>
                <SelectField
                  value={p.drawIncludes?.includes(k) ? 'in' : 'out'}
                  onChange={(v) => save({ drawIncludes: [...(p.drawIncludes ?? []).filter((x) => x !== k), ...(v === 'in' ? [k] : [])] })}
                  options={{ out: '아니오(따로 더 인출)', in: '예(월 금액에 포함)' }}
                />
              </Labeled>
            ))}
        </div>
        <ExpenseBands />
      </Card>
      <Card title="부부 소득·연금" action={<span className="text-xs text-muted">금액은 세후·현재가치, 나이는 각자 나이</span>}>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-line p-3">
            <div className="mb-2 text-sm font-semibold">본인 <span className="font-normal text-muted">· {p.birthYear}년생 · 현재 {summary.age}세</span></div>
            <div className="grid grid-cols-2 gap-3">
              {n('nationalPension', '국민연금 월액', '만원', '국민연금공단 예상액')}
              {n('nationalPensionAge', '국민연금 개시 나이', '세', selfYear(p.nationalPensionAge))}
              {n('privatePension', '개인·퇴직연금 월액', '만원', '정기 수령액. 계좌 잔액은 자산에 입력')}
              {n('privatePensionAge', '개인연금 개시 나이', '세', selfYear(p.privatePensionAge))}
              <PensionOverlapNote accounts={pensionOverlap(p.privatePension, assets, 'self')} />
              {n('wageGross', '은퇴 전 세전 총급여(연)', '만원', p.retireAge > summary.age ? `종소세 계산용 · ${selfYear(p.retireAge - 1)}까지` : '이미 은퇴 · 계산에 안 씀')}
              {n('birthMonth', '출생 월', '월', monthHint(p.birthMonth))}
              <Labeled label="국민연금 연 인상률" hint={p.npGrowth === undefined ? `지금은 물가(${p.inflation}%)와 같게 계산` : `명목 · 물가 ${p.inflation}%`}>
                <NumberField value={p.npGrowth ?? p.inflation} unit="%" step={0.1} onChange={(v) => save({ npGrowth: v })} />
              </Labeled>
            </div>
          </div>
          <div className="rounded-xl border border-line p-3">
            <div className="mb-2 text-sm font-semibold">배우자 <span className="font-normal text-muted">{hasSpouse ? `· ${p.spouseBirthYear}년생 · 현재 ${spouseNow}세` : '· 출생연도를 넣으면 나이를 맞춰 계산'}</span></div>
            <div className="grid grid-cols-2 gap-3">
              {n('spouseBirthYear', '출생연도', '년', hasSpouse ? `본인보다 ${Math.abs(p.spouseBirthYear - p.birthYear)}살 ${p.spouseBirthYear > p.birthYear ? '적음' : p.spouseBirthYear < p.birthYear ? '많음' : '같음'}` : '0이면 배우자 없음(본인 나이로 계산)')}
              {n('spouseIncome', '세후 월소득', '만원', '가구 월소득 중 배우자 몫')}
              {n('spouseRetireAge', '은퇴 나이', '세', (p.spouseRetireAge ?? 0) > 0 ? spouseYear(p.spouseRetireAge ?? 0) : '0이면 이미 은퇴(근로소득 없음)')}
              {n('spouseWageGross', '은퇴 전 세전 총급여(연)', '만원', hasSpouse && (p.spouseRetireAge ?? 0) > spouseNow ? `종소세 계산용 · ${p.spouseBirthYear + (p.spouseRetireAge ?? 0) - 1}년까지` : '이미 은퇴 · 계산에 안 씀')}
              {n('spouseBirthMonth', '출생 월', '월', monthHint(p.spouseBirthMonth))}
              {n('spousePension', '국민연금 월액', '만원', '국민연금공단 예상액')}
              {n('spousePensionAge', '국민연금 개시 나이', '세', spouseYear(p.spousePensionAge))}
              {n('spousePrivatePension', '개인·퇴직연금 월액', '만원', '정기 수령액')}
              {n('spousePrivatePensionAge', '개인연금 개시 나이', '세', spouseYear(p.spousePrivatePensionAge ?? 0))}
              <PensionOverlapNote accounts={pensionOverlap(p.spousePrivatePension ?? 0, assets, 'spouse')} />
            </div>
          </div>
        </div>
        <p className="mt-3 text-xs text-muted">
          은퇴 전 세전 총급여는 원천징수영수증의 총급여(비과세 제외)를 오늘 기준으로 넣으세요. 저축·노후 계산에는 쓰지 않고, 종합소득세·건강보험료 추정에서 월세 등 다른 소득과 합쳐 세율 구간·근로소득세액공제·연말정산 기납부를 계산할 때만 씁니다(건보료는 직장에서 낸다고 봄). 배우자 소득은 가구 월소득에 포함된 것으로 봅니다. 배우자가 본인보다 먼저 은퇴하면 그때부터 저축이 줄고, 본인이 먼저 은퇴하면 배우자 은퇴 전까지 배우자 소득이 생활비를 보탭니다.
        </p>
      </Card>
      <IncomeList />
      <Card title="은퇴 후 자산 운용" action={<span className="text-xs text-muted">현재 포트폴리오 {summary.portfolioReturn.toFixed(1)}% / 변동성 {summary.portfolioVol.toFixed(1)}%</span>}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Labeled label="운용 방식" hint="노후 진단·인출 계획에 반영">
            <SelectField value={p.retireSeparate ? 'on' : 'off'} onChange={(v) => save({ retireSeparate: v === 'on' })} options={{ off: '은퇴 전과 동일', on: '따로 입력' }} />
          </Labeled>
          {p.retireSeparate && (
            <>
              {n('retireReturn', '은퇴 후 기대수익률', '%', '예: 채권 위주 3.5~4.5', 0.1)}
              {n('retireVolatility', '은퇴 후 변동성', '%', `수익률 ${p.retireReturn}%면 ${volRange(p.retireReturn).min}~${volRange(p.retireReturn).max}% 권장`, 0.1)}
            </>
          )}
        </div>
        {p.retireSeparate && volCheck(p.retireReturn, p.retireVolatility) === 'low' && (
          <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
            <p className="min-w-0 flex-1 basis-64">
              <b>결과가 낙관적일 수 있어요.</b> 기대수익률 {p.retireReturn}%를 내려면 보통 변동성이 {volRange(p.retireReturn).min}% 이상입니다. 지금 {p.retireVolatility}%로는 하락장이 거의 없다고 보고 성공확률을 실제보다 높게 계산합니다. 변동성을 올리거나 기대수익률을 낮춰 주세요.
            </p>
            <Button variant="ghost" className="shrink-0 bg-surface !px-3 !py-1.5 !text-xs" onClick={() => save({ retireVolatility: volMid(p.retireReturn) })}>
              권장값 {volMid(p.retireReturn)}%로 맞추기
            </Button>
          </div>
        )}
        {p.retireSeparate && volCheck(p.retireReturn, p.retireVolatility) === 'high' && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
            <p className="min-w-0 flex-1 basis-64">변동성이 수익률 {p.retireReturn}%에 비해 큰 편({volRange(p.retireReturn).max}% 초과)이라 결과가 보수적으로 나옵니다.</p>
            <Button variant="ghost" className="shrink-0 !px-3 !py-1.5 !text-xs" onClick={() => save({ retireVolatility: volMid(p.retireReturn) })}>
              권장값 {volMid(p.retireReturn)}%로 맞추기
            </Button>
          </div>
        )}
        <p className="mt-3 text-xs text-muted">권장 범위는 예금 금리(약 3%)를 넘는 초과수익 1%마다 변동성 2.5~5%로 잡은 대략적인 기준입니다(채권 위주 4% → 2.5~5%, 주식·채권 반반 6% → 7.5~15%, 주식 위주 8% → 12.5~25%).</p>
      </Card>
      <Card title="연금 세금" action={<span className="text-xs text-muted">인출 계획 · 노후 진단 세금 계산에 사용</span>}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {n('retireTaxRate', '퇴직소득세 실효세율', '%', '감면 전 세율(퇴직소득 원천징수영수증)', 0.01)}
          {n('retireTaxYear1', '퇴직금 연금 실수령 1년차', '년', '11년차부터 감면 30%→40% · 실제로 꺼낸 해만 연차로 셈')}
          {n('retireMinDraw', '퇴직금 계좌 매년 최소 인출', '만원', '연 금액(예: 12) · 쓸 일이 없는 해에도 꺼내 실수령연차 유지 · 0이면 안 함')}
          <Labeled label="1,500만 한도 매년 꽉 채우기" hint="남는 돈은 ISA·일반계좌로 재투자">
            <SelectField value={p.slotFill ? 'on' : 'off'} onChange={(v) => save({ slotFill: v === 'on' })} options={{ off: '아니오(필요한 만큼만)', on: '예' }} />
          </Labeled>
          {p.slotFill && n('slotFillFrom', '꽉 채우기 시작 연도', '년', '0이면 올해부터')}
          <Labeled label="노후 진단에 연금 인출 세금 반영" hint="아니오: 엑셀처럼 세금 없이 비교">
            <SelectField value={p.planPensionTax === false ? 'off' : 'on'} onChange={(v) => save({ planPensionTax: v === 'on' })} options={{ on: '예(기본)', off: '아니오' }} />
          </Labeled>
        </div>
        <p className="mt-3 text-xs text-muted">
          연금계좌별 과세제외 금액·퇴직금 재원·명의·인출 시작 연도·꺼내는 순서는 ‘자산’ 탭의 각 연금 자산에서 입력합니다. 과세재원 인출은 1인 연 1,500만원까지 연금소득세(70세 미만 5.5%·70대 4.4%·80세 이상 3.3%)를 내고, 넘으면 16.5% 분리과세로 계산합니다.
          ‘꽉 채우기’를 고르면 생활비보다 많아도 해마다 1인 1,500만원까지 과세재원을 꺼내(낮은 세율로 미리 꺼냄) 세후 금액을 ISA·일반계좌에 다시 넣습니다.
          한 계좌 안에서는 법정 순서(과세제외 → 퇴직금 재원 → 과세재원)로만 빠지고, 운용수익은 모두 과세재원으로 쌓입니다. 퇴직소득세 감면이 40%로 커지는 11년차는 퇴직금 계좌에서 실제로 꺼낸 해만 세므로, ‘매년 최소 인출’에 작은 금액(예: 연 12만원)을 넣어 두면 쓸 일이 없는 해에도 연차가 이어집니다(꺼낸 돈은 ISA·일반계좌로).
          ‘노후 진단에 연금 인출 세금 반영’을 아니오로 하면 노후 진단·요약 보고·맞춤 처방의 성공확률과 고갈 나이를 세금 없이 계산합니다(엑셀 결과와 맞춰 볼 때). 인출 계획 화면의 세금 계산은 그대로입니다.
        </p>
      </Card>
      <CreditCheckCard />
      <ContribForm />
      <IncomeTaxForm />
      <Card title="가족 보장">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{n('dependentYears', '부양 필요 기간', '년', '막내 자녀 독립까지 등')}</div>
      </Card>
    </div>
  );
}

const WHO: Record<IncomeOwner, string> = { self: '본인', spouse: '배우자' };
const LEVEL_TEXT = { good: 'text-good', caution: 'text-warn', danger: 'text-bad' } as const;
const manOrDash = (v?: number) => (v === undefined ? '—' : won(v));

/** 세액공제 확인 대조표: 홈택스 확인서의 세액공제 대상 금액 vs 계좌별 개인 입금액·과세제외 */
function CreditCheckCard() {
  const { profile: p, assets } = useFlp();
  const save = useSaveProfile();
  const { accounts, people } = creditCheck(p, assets);
  if (accounts.length === 0) return null;
  const hasSpouse = p.spouseBirthYear > 0;
  const setCert = (o: IncomeOwner) => (v: number) => save({ creditCert: { ...(p.creditCert ?? {}), [o]: v > 0 ? v : undefined } });
  return (
    <Card title="세액공제 확인 대조표" action={<span className="text-xs text-muted">숨은 비과세 재원 찾기 · 만원</span>}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Labeled label="본인 확인서 세액공제 대상 금액" hint="홈택스 연금보험료 등 소득·세액 공제확인서 · 연금계좌 누계">
          <NumberField value={p.creditCert?.self ?? 0} unit="만원" onChange={setCert('self')} />
        </Labeled>
        {hasSpouse && (
          <Labeled label="배우자 확인서 세액공제 대상 금액" hint="배우자 확인서 · 연금계좌 누계">
            <NumberField value={p.creditCert?.spouse ?? 0} unit="만원" onChange={setCert('spouse')} />
          </Labeled>
        )}
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-max text-sm">
          <thead>
            <tr className="border-b border-line text-right text-xs text-muted">
              <th className="py-2 text-left font-medium">계좌</th>
              {hasSpouse && <th className="px-2 py-2 text-left font-medium">명의</th>}
              <th className="px-2 py-2 font-medium">개인 입금액</th>
              <th className="px-2 py-2 font-medium">세액공제(입금−과세제외)</th>
              <th className="py-2 pl-2 font-medium">과세제외(계획)</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((r, i) => (
              <tr key={i} className="border-b border-line/60 text-right">
                <td className="py-1.5 text-left">{r.name}</td>
                {hasSpouse && <td className="px-2 py-1.5 text-left">{WHO[r.owner]}</td>}
                <td className={`px-2 py-1.5 ${r.paidIn === undefined ? 'text-muted' : ''}`}>{r.paidIn === undefined ? '빈칸(0)' : won(r.paidIn)}</td>
                <td className="px-2 py-1.5">{manOrDash(r.credited)}</td>
                <td className="py-1.5 pl-2">{won(r.taxFree)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-max text-sm">
          <thead>
            <tr className="border-b border-line text-right text-xs text-muted">
              <th className="py-2 text-left font-medium">사람별 합계</th>
              {people.map((x) => <th key={x.owner} className="py-2 pl-3 font-medium">{WHO[x.owner]}</th>)}
            </tr>
          </thead>
          <tbody>
            {([
              ['확인서 세액공제 대상 금액', (x) => manOrDash(x.certified)],
              ['개인 입금액 합계', (x) => won(x.paidIn)],
              ['확인서 기준 과세제외(입금 − 확인서)', (x) => manOrDash(x.certExempt)],
              ['지금 계획의 과세제외', (x) => won(x.planExempt)],
              ['덜 잡힌 비과세 재원(확인서 기준 − 계획)', (x) => (x.gap === undefined ? '—' : x.gap > 1 ? won(x.gap) : x.gap < -1 ? `${won(-x.gap)} 많음` : '0')],
              [`인정되면 아끼는 연금소득세(${CREDIT_CHECK_TAX}%)`, (x) => manOrDash(x.saving)],
            ] as [string, (x: (typeof people)[number]) => string][]).map(([label, f]) => (
              <tr key={label} className="border-b border-line/60 text-right">
                <td className="py-1.5 text-left text-muted">{label}</td>
                {people.map((x) => <td key={x.owner} className="py-1.5 pl-3 font-medium">{f(x)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="mt-3 space-y-1 text-xs">
        {people.map((x) => (
          <li key={x.owner} className={x.level ? LEVEL_TEXT[x.level] : 'text-muted'}>{hasSpouse ? `${WHO[x.owner]}: ` : ''}{x.note}</li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted">
        세액공제를 받지 않은 납입액은 과세제외(비과세 재원)라 꺼낼 때 세금이 없고 1,500만 한도도 쓰지 않습니다. 확인서 기준 과세제외가 계획보다 크면 증권사에 계좌별 ‘과세제외금액(세액공제 받지 않은 납입액)’을 조회하고, 확인서를 내면 고칠 수 있는지 물어보세요.
        개인 입금액(퇴직금 제외)은 ‘자산’ 탭의 각 연금 자산에서 넣습니다. 확인서는 받은 시점 누계라, 그 뒤 추가 납입은 빼고 비교하세요.
      </p>
    </Card>
  );
}

/** 연금계좌 추가 납입(세액공제) */
function ContribForm() {
  const { profile: p } = useFlp();
  const save = useSaveProfile();
  const c = { ...DEFAULT_CONTRIB, ...(p.contrib ?? {}) };
  const set = (k: keyof ContribPlan) => (v: number) => save({ contrib: { ...c, [k]: v } });
  const hasSpouse = p.spouseBirthYear > 0;
  return (
    <Card title="연금계좌 추가 납입(세액공제)" action={<span className="text-xs text-muted">연 금액 · 만원</span>}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Labeled label="본인 연 납입액" hint="인출 시작 전 본인 계좌로"><NumberField value={c.self} unit="만원" onChange={set('self')} /></Labeled>
        {hasSpouse && <Labeled label="배우자 연 납입액" hint="배우자 연금계좌로"><NumberField value={c.spouse} unit="만원" onChange={set('spouse')} /></Labeled>}
        <Labeled label="시작 연도"><NumberField value={c.from} unit="년" onChange={set('from')} /></Labeled>
        <Labeled label="마지막 연도"><NumberField value={c.to} unit="년" onChange={set('to')} /></Labeled>
        <Labeled label="본인 세액공제율" hint="0이면 자동(16.5 / 13.2)"><NumberField value={c.selfRate} unit="%" step={0.1} onChange={set('selfRate')} /></Labeled>
        {hasSpouse && <Labeled label="배우자 세액공제율" hint="0이면 자동(16.5 / 13.2)"><NumberField value={c.spouseRate} unit="%" step={0.1} onChange={set('spouseRate')} /></Labeled>}
      </div>
      <p className="mt-3 text-xs text-muted">
        납입금은 ISA·일반계좌에서 먼저 내고, 모자라면 연금계좌에서 더 꺼내 냅니다. 본인 납입은 ‘인출 시작 연도’가 아직 안 된 본인 연금계좌로 들어갑니다.
        세액공제는 1인 연 {CREDIT_CAP}만원까지 납입액 × 공제율(종합소득금액 4,500만원 이하 16.5%, 초과 13.2%)이고, ‘종합소득세·건강보험료’ 추정을 켜면 그해 종합소득세까지만 공제합니다. 환급금은 다음 해 ISA·일반계좌로 들어오고, 공제받지 못한 납입액은 과세제외 금액이 됩니다.
      </p>
    </Card>
  );
}

/** 종합소득세·지역 건강보험료 추정 설정 */
function IncomeTaxForm() {
  const { profile: p } = useFlp();
  const save = useSaveProfile();
  const t = { ...DEFAULT_INCOME_TAX, ...(p.incomeTax ?? {}) };
  const set = (patch: Partial<IncomeTaxSettings>) => save({ incomeTax: { ...t, ...patch } });
  const num = (k: keyof IncomeTaxSettings, label: string, unit: string, hint?: string, step = 1) => (
    <Labeled label={label} hint={hint}>
      <NumberField value={t[k] as number} unit={unit} step={step} onChange={(v) => set({ [k]: v })} />
    </Labeled>
  );
  const yn = (k: 'hiPrivate' | 'addToDraw' | 'hiLoanDeduct' | 'hiDepNoReg', label: string, hint: string) => (
    <Labeled label={label} hint={hint}>
      <SelectField value={t[k] ? 'on' : 'off'} onChange={(v) => set({ [k]: v === 'on' })} options={{ off: '아니오', on: '예' }} />
    </Labeled>
  );
  const hasSpouse = p.spouseBirthYear > 0;
  const { assets, liabilities, summary } = useFlp();
  const homeLoans = liabilities.filter((l) => l.homeLoan === 'buy');
  // 올해 공제액: 표시한 대출 잔액 합계 × 60%, 한도 5,000만(주택이 2채 이상이면 0)
  const nowYear = p.birthYear + summary.age;
  const loanDed = hiLoanDeduct(assets, homeLoans, nowYear, nowYear, summary.age);
  const loanBal = homeLoans.reduce((a, l) => a + l.balance, 0);
  const loanWhy = loanBal > 0 && loanDed === 0 ? '주택 2채 이상이라 제외' : (loanBal * HI_LOAN_RATE) / 100 > HI_LOAN_CAP ? '잔액 × 60%가 한도 5,000만 넘음' : '잔액 × 60%';
  const loanHint =
    homeLoans.length === 0
      ? '부채 탭에서 대출을 ‘실거주 주택 구입 대출’로 표시'
      : `${homeLoans.map((l) => `${l.name} ${won(l.balance)}`).join(' · ')} → 올해 공제 ${won(loanDed)}(${loanWhy})${t.hiLoanDeduct ? '' : ' · ‘예’로 해야 반영'}`;
  const rentCount = (p.incomes ?? []).filter((i) => incomeKindOf(i) === 'rent').length + assets.filter((a) => a.type === 'realestate' && reUseOf(a) === 'rental' && (a.rent ?? 0) > 0).length;
  return (
    <Card
      title="종합소득세·건강보험료"
      action={
        <SelectField value={t.on ? 'on' : 'off'} onChange={(v) => set({ on: v === 'on' })} options={{ off: '계산 안 함', on: '추정하기' }} />
      }
    >
      {!t.on ? (
        <p className="text-sm text-muted">임대·근로·사업소득과 국민연금 등 공적연금에 붙는 종합소득세와 지역 건강보험료를 해마다 추정해 인출 계획 화면에 보여 줍니다. 오른쪽 위에서 ‘추정하기’를 고르세요.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {hasSpouse && num('rentSpouseShare', '임대소득 중 배우자 몫', '%', '‘그 밖의 소득’ 임대료만. 부동산 자산은 명의·지분대로')}
            {num('rentExpense', '임대 필요경비율', '%', '실제 종소세와 맞도록 조정')}
            {num('npTaxable', '국민연금 과세대상 비율', '%', '2002년 이후 납입분 비율')}
            {num('npNet', '입력한 국민연금이 세전의', '%', '세후 금액을 넣었으면 97 등')}
            {num('dedSelf', '본인 종합소득공제', '만원', '기본공제 150 등')}
            {hasSpouse && num('dedSpouse', '배우자 종합소득공제', '만원', '기본공제 150 등')}
            <Labeled label="건보료 재산분" hint={t.hiPropAuto ? '부동산 시세 × 공시가격 비율 × 공정시장가액비율' : '지금 고지서에서 역산해 고정'}>
              <SelectField value={t.hiPropAuto ? 'auto' : 'bill'} onChange={(v) => set({ hiPropAuto: v === 'auto' })} options={{ bill: '고지서 역산', auto: '부동산 자산으로 추정' }} />
            </Labeled>
            {t.hiPropAuto ? (
              <>
                {num('hiPubRatio', '시세 대비 공시가격', '%', '공동주택 평균 69 안팎', 1)}
                {num('hiFairRatio', '공정시장가액비율', '%', '주택 60 · 토지·건물 70', 1)}
                {yn('hiLoanDeduct', '주택 구입 대출 공제', loanHint)}
              </>
            ) : (
              num('hiNow', '현재 월 건강보험료', '만원', (p.wageGross ?? 0) > 0 || (p.spouseWageGross ?? 0) > 0 ? '지역 고지서(장기요양 포함). 부부 모두 직장·피부양자면 은퇴 후 예상 지역 보험료' : '고지서(장기요양 포함). 재산분 역산', 0.1)
            )}
            {num('hiRate', '건강보험료율', '%', '2026년 7.19', 0.01)}
            {num('hiLtc', '장기요양보험료', '%', '건보료 대비, 2026년 13.14', 0.01)}
            {num('hiPublic', '연금·근로소득 건보료 반영률', '%', '지역가입자 50')}
            {!t.hiPropAuto && num('hiPropGrowth', '재산분 연 증가율', '%', '재산 과세표준이 오르면', 0.1)}
            {hasSpouse && ((p.wageGross ?? 0) > 0 || (p.spouseWageGross ?? 0) > 0) && yn('hiDepNoReg', '피부양자 판정: 사업자등록 없음', '예: 임대 외 사업소득 연 500만원 이하면 피부양자 인정')}
            {yn('hiPrivate', '사적연금도 건보료에 반영', '제도가 바뀌면 예 · 급여 있는 해의 직장가입자·피부양자 판정에도')}
            {yn('addToDraw', '늘어난 세금 인출에 더하기', '국민연금 몫만큼 연금계좌 인출 증가')}
          </div>
          <p className="mt-3 text-xs text-muted">
            {rentCount === 0 ? '임대소득은 ‘자산’ 탭의 임대용 부동산 월세나, ‘그 밖의 은퇴 후 소득’에서 종류를 ‘임대소득’으로 고른 항목만 계산에 들어갑니다. ' : ''}
            ‘부부 소득·연금’의 은퇴 전 세전 총급여는 각자 은퇴 전 해까지 근로소득으로 합쳐 세율 구간·근로소득세액공제·연말정산 기납부를 계산합니다. 급여가 있는 사람은 그 해 직장가입자로 보아 재산분 없이 급여 외 소득 2,000만원 초과분에만 건보료(소득월액 보험료)를 매기고, 부부 중 한 명만 일하면 다른 한 명은 피부양자 요건을 채우면 0, 못 채우면 그 사람만 지역가입자로 계산합니다. 피부양자는 사업소득이 조금이라도 있으면 빠지는 것으로 보되, ‘피부양자 판정: 사업자등록 없음’을 ‘예’로 하면 임대 외 사업소득이 연 500만원 이하일 때는 인정합니다(임대소득은 있으면 항상 빠짐). ‘그 밖의 은퇴 후 소득’은 고른 종류대로 계산합니다(근로소득은 근로소득공제·근로소득세액공제·표준세액공제 13만을 하고 연말정산으로 낸 세금은 기납부로 빼서 5월에는 다른 소득과 합쳐 늘어난 만큼만, 사업소득은 항목별 필요경비율, 공무원·사학·군인연금은 국민연금과 합쳐 연금소득공제, 지역가입자 건보료는 근로·공적연금 × 반영률, 사업·임대 100%). 사적연금(1,500만원 이하 분리과세)·퇴직소득·노란우산은 종합소득과 건보료에 넣지 않습니다(2026년 기준). 건보료 소득분은 전년도 소득으로, 재산분은 {t.hiPropAuto ? '부동산 자산의 해마다 오르는 시세로 재산 과세표준을 구해 기본공제 1억을 빼고 2026년 재산등급 점수 × 211.5원으로 추정합니다(매각 연도부터 제외, 임대보증금은 빼지 않음, 자동차·전월세로 사는 집은 넣지 않음, 부부 한 세대)' + (t.hiLoanDeduct ? '. 주택 구입 대출 공제는 표시한 대출의 해마다 줄어드는 잔액(원리금 균등 상환) × 60%를 5,000만 한도로 빼고, 그 해 주택이 2채 이상이면 넣지 않습니다. 실제로는 공시가격 5억 이하 주택을 취득 전후 3개월 안에 빌린 대출이어야 하고 공단에 신청해야 합니다' : '') : '지금 고지서에서 역산해 고정합니다(부부 한 세대)'}. 첫해 부담은 이미 생활비(또는 재무목표)에 들어 있다고 보고,
            ‘늘어난 세금 인출에 더하기’를 ‘예’로 하면 국민연금 때문에 늘어나는 금액만 해마다 연금계좌에서 더 꺼냅니다.
          </p>
        </>
      )}
    </Card>
  );
}

function CriteriaForm() {
  const { profile } = useFlp();
  const save = useSaveProfile();
  const c = profile.criteria;
  const set = (k: keyof Criteria) => (v: number) => save({ criteria: { ...c, [k]: v } });
  return (
    <Card title="점검 기준" action={<span className="text-xs text-muted">홈·투자 점검·노후 진단·처방에서 이 기준으로 판정합니다</span>}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Labeled label="비상금 목표"><NumberField value={c.emergencyMonths} unit="개월" onChange={set('emergencyMonths')} /></Labeled>
        <Labeled label="목표 저축률"><NumberField value={c.savingsRate} unit="%" onChange={set('savingsRate')} /></Labeled>
        <Labeled label="부채비율 상한"><NumberField value={c.debtRatioMax} unit="%" onChange={set('debtRatioMax')} /></Labeled>
        <Labeled label="노후 성공확률 목표"><NumberField value={c.successTarget} unit="%" onChange={set('successTarget')} /></Labeled>
        <Labeled label="인출률 상한" hint="은퇴 첫해 인출액 / 금융자산"><NumberField value={c.withdrawRateMax} unit="%" step={0.5} onChange={set('withdrawRateMax')} /></Labeled>
        <Labeled label="진단비 기준" hint="연소득의 몇 배 · 소득이 없거나 이미 은퇴했으면 치료비 기준액 3,000만원"><NumberField value={c.criticalMultiple} unit="배" step={0.5} onChange={set('criticalMultiple')} /></Labeled>
        <Labeled label="간병 필요 보장액" hint="본인·배우자 같은 금액 · 배우자 사망보장 = 배우자 연소득 × 부양기간(배우자가 은퇴했으면 0)"><NumberField value={c.careNeed} unit="만원" onChange={set('careNeed')} /></Labeled>
        <Labeled label="유족 생활비 비율" hint="현재 지출 대비 · 이미 은퇴했으면 유족 생활비는 빼고 계산"><NumberField value={c.survivorRatio} unit="%" onChange={set('survivorRatio')} /></Labeled>
        <Labeled label="하락장 기준" hint="시장이 최고점보다 이만큼 떨어진 해"><NumberField value={c.guardrailDrop} unit="%" onChange={set('guardrailDrop')} /></Labeled>
        <Labeled label="하락장 생활비 감축" hint="그해 은퇴 후 생활비를 줄이는 비율 · 0이면 비교 안 함"><NumberField value={c.guardrailCut} unit="%" onChange={set('guardrailCut')} /></Labeled>
      </div>
    </Card>
  );
}

/** 나이 구간별 은퇴 후 생활비: 활동기에는 많이, 나이 들수록 적게 */
function ExpenseBands() {
  const { profile: p } = useFlp();
  const save = useSaveProfile();
  const list = p.expenseSteps ?? [];
  const draw = p.expenseMode === 'draw';
  const setAt = (i: number, patch: Partial<ExpenseBand>) => save({ expenseSteps: list.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const add = () => {
    const last = list.reduce((a, x) => Math.max(a, x.fromAge), p.retireAge);
    const prev = list.length ? list[list.length - 1].monthly : p.retireMonthlyExpense;
    save({ expenseSteps: [...list, { fromAge: Math.min(p.lifeExpectancy, last + 10), monthly: Math.round(prev * 0.8) }] });
  };
  // 은퇴 ~ 첫 구간 전은 기본 생활비, 그 뒤는 구간마다 바뀜(나이순)
  const sorted = [...list].filter((x) => x.fromAge > 0).sort((a, b) => a.fromAge - b.fromAge);
  // 은퇴 나이 이전에 시작하는 구간은 은퇴부터 기본 생활비를 대신함
  const atRetire = sorted.filter((x) => x.fromAge <= p.retireAge).pop()?.monthly ?? p.retireMonthlyExpense;
  const bands = [{ from: p.retireAge, monthly: atRetire }, ...sorted.filter((x) => x.fromAge > p.retireAge).map((x) => ({ from: x.fromAge, monthly: x.monthly }))];
  const summaryText = bands
    .map((b, i) => {
      const to = i + 1 < bands.length ? bands[i + 1].from - 1 : p.lifeExpectancy;
      return to >= b.from ? `${b.from}~${to}세 월 ${won(b.monthly)}` : '';
    })
    .filter(Boolean)
    .join(' → ');
  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-semibold">
          나이 구간별 생활비 <span className="font-normal text-muted">· 선택</span>
        </div>
        {!draw && <Button variant="ghost" onClick={add}>+ 구간 추가</Button>}
      </div>
      {draw ? (
        <p className="text-xs text-muted">‘연금으로 쓰는 금액 고정’ 방식에서는 나이 구간별 생활비를 쓰지 않습니다.</p>
      ) : list.length === 0 ? (
        <p className="text-xs text-muted">
          건강하고 활동이 많은 은퇴 초기에는 더 쓰고, 나이가 들면 덜 쓰도록 나이마다 월 생활비를 바꿀 수 있습니다. 예: 은퇴~69세 월 400만원, 70세부터 330만원, 80세부터 270만원. 구간을 추가하지 않으면 은퇴 후 월 생활비를 평생 씁니다.
        </p>
      ) : (
        <div className="space-y-2">
          {list.map((x, i) => (
            <div key={i} className="flex flex-wrap items-end gap-3">
              <div className="w-32"><Labeled label="시작 나이(세)" hint={`${p.birthYear + x.fromAge}년`}><NumberField value={x.fromAge} onChange={(v) => setAt(i, { fromAge: v })} /></Labeled></div>
              <div className="w-40"><Labeled label="월 생활비(만원)" hint={p.retireMonthlyExpense > 0 ? `기본의 ${Math.round((x.monthly / p.retireMonthlyExpense) * 100)}% · 오늘 물가 기준` : '오늘 물가 기준'}><NumberField value={x.monthly} onChange={(v) => setAt(i, { monthly: v })} /></Labeled></div>
              <span className="mb-0.5 flex items-center gap-3">
                <MoveButtons name={`${x.fromAge}세 구간`} index={i} count={list.length} onMove={(dir) => save({ expenseSteps: moveItem(list, i, dir) })} />
                <button className="text-xs font-medium text-bad hover:underline" onClick={() => save({ expenseSteps: list.filter((_, j) => j !== i) })}>삭제</button>
              </span>
            </div>
          ))}
          <p className="rounded-lg bg-sunken px-3 py-2 text-xs text-muted">
            {summaryText}
            {p.expenseMode === 'growth' && ' · 여기에 생활비 명목 증가율을 함께 적용'}
          </p>
        </div>
      )}
    </div>
  );
}

/** 은퇴 후 소득(임대료 등) 목록 편집 */
function IncomeList() {
  const { profile: p, assets } = useFlp();
  const rentals = assets.filter((a) => a.type === 'realestate' && reUseOf(a) === 'rental' && (a.rent ?? 0) > 0);
  const save = useSaveProfile();
  const list = p.incomes ?? [];
  const setAt = (i: number, patch: Partial<RetireIncome>) => save({ incomes: list.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const add = () => save({ incomes: [...list, { name: '기타 소득', monthly: 100, startAge: p.retireAge, endAge: 0, growth: p.inflation, step: 1, owner: 'self', kind: 'other', rent: false }] });
  const hasSpouse = p.spouseBirthYear > 0;
  /** 입력 나이 → "2032년" (배우자 기준이면 본인 나이도 함께) */
  const when = (age: number, owner?: string) => {
    if (age <= 0) return '';
    if (owner === 'spouse' && hasSpouse) return `${p.spouseBirthYear + age}년 · 본인 ${spouseToSelf(p, age)}세`;
    return `${p.birthYear + age}년`;
  };
  return (
    <Card title="그 밖의 은퇴 후 소득" action={<Button variant="ghost" onClick={add}>+ 소득 추가</Button>}>
      {list.length === 0 && (
        <div className="space-y-1 text-sm text-muted">
          <p>근로소득·사업소득·임대료처럼 <b>은퇴 후</b> 들어오는 돈이 있으면 추가하세요. 노후 진단과 인출 계획에 반영되고, 종류를 고르면 종합소득세·건강보험료에도 종류대로 들어갑니다.</p>
          <p className="text-xs">은퇴 전 소득(지금 받는 월세 포함)은 위 ‘세후 월소득(가구)’에 합쳐 넣고, 국민연금·개인·퇴직연금은 프로필의 전용 칸에 넣으세요. 여기에 또 넣으면 두 번 계산됩니다.</p>
        </div>
      )}
      {rentals.length > 0 && (
        <p className="mb-3 rounded-lg bg-sunken px-3 py-2 text-xs text-muted">
          임대용 부동산 자산({rentals.map((a) => a.name).join(', ')})의 월세는 <b>은퇴 후({p.birthYear + p.retireAge}년~)</b>부터 ‘자산’ 탭에서 넣은 금액으로 자동 반영됩니다. <b>은퇴 전 월세</b>는 위 ‘세후 월소득(가구)’에 합쳐 넣으세요. 같은 임대료를 여기에 또 넣으면 두 번 계산됩니다.
        </p>
      )}
      <div className="space-y-3">
        {list.map((x, i) => (
          <div key={i} className="rounded-xl border border-line p-3">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
              <div className="col-span-2 md:col-span-1"><Labeled label="이름"><TextField value={x.name} onChange={(v) => setAt(i, { name: v })} /></Labeled></div>
              <Labeled label="나이 기준" hint={x.owner === 'spouse' && !hasSpouse ? '배우자 출생연도를 넣어 주세요' : !['rent', 'other'].includes(incomeKindOf(x)) ? '세금도 이 사람 소득으로' : undefined}>
                <SelectField value={x.owner ?? 'self'} onChange={(v) => setAt(i, { owner: v as IncomeOwner })} options={{ self: '본인', spouse: '배우자' }} />
              </Labeled>
              <Labeled label="월액(만원)" hint="오늘 기준 금액"><NumberField value={x.monthly} onChange={(v) => setAt(i, { monthly: v })} /></Labeled>
              <Labeled label="시작 나이(세)" hint={when(x.startAge, x.owner)}><NumberField value={x.startAge} onChange={(v) => setAt(i, { startAge: v })} /></Labeled>
              <Labeled label="마지막 나이(세)" hint={x.endAge > 0 ? when(x.endAge, x.owner) : '0이면 평생'}><NumberField value={x.endAge} onChange={(v) => setAt(i, { endAge: v })} /></Labeled>
              <Labeled label="1회 인상률(%)" hint={x.step > 1 ? `${x.step}년마다 이만큼 인상` : `매년 인상. 물가(${p.inflation}%)와 같으면 실질 유지`}><NumberField value={x.growth} step={0.1} onChange={(v) => setAt(i, { growth: v })} /></Labeled>
              <Labeled label="인상 주기(년)" hint="예: 2년마다 5%"><NumberField value={x.step} min={1} onChange={(v) => setAt(i, { step: Math.max(1, Math.round(v)) })} /></Labeled>
            </div>
            <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="w-56">
                  <Labeled label="소득 종류" hint={INCOME_KIND_HINT[incomeKindOf(x)]}>
                    <SelectField value={incomeKindOf(x)} onChange={(v) => setAt(i, { kind: v as IncomeKind, rent: v === 'rent' })} options={INCOME_KIND} />
                  </Labeled>
                </div>
                {incomeKindOf(x) === 'business' && (
                  <div className="w-40">
                    <Labeled label="필요경비율(%)" hint="단순경비율 등">
                      <NumberField value={x.expense ?? 0} step={0.1} onChange={(v) => setAt(i, { expense: Math.min(100, Math.max(0, v)) })} />
                    </Labeled>
                  </div>
                )}
              </div>
              <span className="flex items-center gap-3">
                <MoveButtons name={x.name} index={i} count={list.length} onMove={(dir) => save({ incomes: moveItem(list, i, dir) })} />
                <button className="text-xs font-medium text-bad hover:underline" onClick={() => confirm(`'${x.name}'을(를) 삭제할까요?`) && save({ incomes: list.filter((_, j) => j !== i) })}>삭제</button>
              </span>
            </div>
            {incomeKindOf(x) === 'rent' && (() => {
              const dup = rentDuplicates(x, assets);
              if (dup.length === 0) return null;
              const why = dup.map((d) => `${d.asset.name || '임대 부동산'}(${d.by === 'name' ? '이름이 비슷함' : `월세 ${won(d.asset.rent ?? 0)}과 같음`})`).join(', ');
              return (
                <p role="alert" className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
                  <b>두 번 계산될 수 있어요.</b> 자산 탭 임대용 부동산 {why}의 월세는 은퇴 후 소득에 이미 자동으로 들어갑니다. 같은 월세라면 이 항목을 삭제하고, 다른 임대료라면 이름을 구분되게 바꿔 주세요.
                </p>
              );
            })()}
          </div>
        ))}
      </div>
    </Card>
  );
}

/** 재무목표 카드 아래 안내: 반복 지출 */
function goalNote(g: Goal) {
  const fixed = g.priceMode === 'fixed' ? ', 금액 고정' : '';
  if (!isRecurring(g)) return `${g.targetAge}세에 한 번 지출${fixed}`;
  return `${g.targetAge}~${g.endAge}세 매년 ${won(g.amountPV)} 지출(${g.endAge! - g.targetAge + 1}회${fixed}) — 노후 진단·인출에 반영, 목적자금 적립 계산에서는 제외`;
}

/** 대출 카드 아래 안내: 상환 종료 나이와 그 이후 효과 */
function loanNote(l: Liability, age: number, retireAge: number) {
  if (l.repay === 'bullet') {
    const interest = (l.balance * l.rate) / 1200;
    const pay = l.monthlyPayment > 0 ? `월 ${won(l.monthlyPayment)}(이자)` : `월 상환액 0 → 이자 월 ${won(interest)} 정도를 넣으세요`;
    if (l.maturity === 'open' && !((l.endAge ?? 0) > age)) return `만기 미정(이자만 납입): ${pay}을 기대수명까지 내는 것으로 계산 · 원금 ${won(l.balance)}은 계산에 없음(갚을 시기가 정해지면 만기일시 상환으로 바꾸고 만기 나이 입력)`;
    if (!((l.endAge ?? 0) > age)) return `만기일시 상환: 상환 종료 나이에 만기 나이를 넣어야 원금 ${won(l.balance)} 일시 상환이 반영됩니다. ${pay}`;
    const when = l.endAge! <= retireAge ? '은퇴 전' : '은퇴 후';
    return `만기일시 상환: ${l.endAge! - 1}세까지 ${pay} → ${l.endAge}세(${when})에 원금 ${won(l.balance)}을 자산에서 한 번에 상환`;
  }
  const { age: end, auto } = loanEndAge(l, age);
  const src = auto ? '자동 계산' : '직접 입력';
  if (!Number.isFinite(end)) return '월 상환액이 이자보다 적어 상환이 끝나지 않습니다. 상환 종료 나이를 직접 입력하세요.';
  if (l.repay === 'equal') {
    // 원금균등: 월 원금은 그대로, 이자가 줄어 상환액이 해마다 줄어듦
    const pr = equalPrincipal(l, age);
    const first = pr + (l.balance * l.rate) / 1200;
    const after = end <= retireAge ? '줄어든 만큼 저축 증가로 계산' : `은퇴 후 ${end - 1}세까지 남은 상환액은 자산에서 인출`;
    return `원금균등: 월 원금 ${won(pr)} + 이자 → 지금 월 약 ${won(first)}에서 해마다 약 ${won(equalMonthlyDecline(l, age))}씩 줄어 ${end}세에 상환 종료(${src}) · ${after}`;
  }
  if (end < retireAge) return `${end}세에 상환 종료(${src}) → 이후 월 ${won(l.monthlyPayment)} 저축 증가로 계산`;
  if (end === retireAge) return `${end}세에 상환 종료(${src}) → 은퇴와 함께 끝나 은퇴 후 부담 없음`;
  return `${end}세에 상환 종료(${src}) → 은퇴 후에도 ${end - 1}세까지 상환액을 자산에서 인출`;
}

/** 보험 카드 아래 안내: 납입 종료 나이와 그 이후 효과(계산은 본인 나이로 바꿔서) */
function insuranceNote(p: Insurance, profile: Profile, age: number, retireAge: number) {
  if (!((p.payEndAge ?? 0) > 0) || !(p.monthlyPremium > 0)) return '';
  if (p.insured === 'child' && !((p.insuredBirthYear ?? 0) > 0)) return '자녀 출생연도를 넣어야 자녀 나이로 납입 종료를 계산합니다(비우면 본인 나이로 계산).';
  if (p.insured === 'spouse' && !(profile.spouseBirthYear > 0)) return '프로필 탭 ‘부부 소득·연금’에 배우자 출생연도가 없어 본인 나이로 계산합니다.';
  const end = payEndSelfAge(p, profile);
  if (!(end > 0) || !(p.monthlyPremium > 0)) return '';
  // 피보험자가 본인이 아니면 피보험자 나이와 본인 나이를 함께 보여 줌
  const who = (p.insured ?? 'self') !== 'self' && insuredBirthYear(p, profile) !== profile.birthYear ? `${INSURED_WHO[p.insured!]} ${p.payEndAge}세 = 본인 ${end}세 · ` : '';
  return who + insuranceEffect(p, end, age, retireAge);
}

function insuranceEffect(p: Insurance, end: number, age: number, retireAge: number) {
  if (end <= age) return `${end}세에 납입 완료 → 지출에 더하지 않음`;
  if (end < retireAge) return `${end - 1}세까지 납입 → ${end}세부터 월 ${won(p.monthlyPremium)} 저축 증가로 계산`;
  if (end === retireAge) return `${end - 1}세까지 납입 → 은퇴와 함께 납입 완료`;
  return `${end - 1}세까지 납입 → 은퇴 후 ${Math.max(retireAge, age)}~${end - 1}세 보험료 월 ${won(p.monthlyPremium)}(명목)은 자산에서 인출`;
}

/** 보험 탭 위 요약: 피보험자별 건수·월 보험료(지금 납입 중)·보장 합계 */
function InsuranceSummary() {
  const { insurance, profile, summary, ins } = useFlp();
  // 보장 진단(insuranceGap)의 필요액·근거: 자녀가 출생연도별로 여럿이면 한 칸에 합칠 수 없어 보여 주지 않음
  const needOf = (who: keyof typeof INSURED_WHO, key: CoverageLine['key']) => {
    const people = ins.people.filter((p) => p.who === who);
    return people.length === 1 ? people[0].lines.find((l) => l.key === key) : undefined;
  };
  const cell = (who: keyof typeof INSURED_WHO, key: CoverageLine['key'], amount: number) => {
    const l = needOf(who, key);
    return (
      <td className="py-1.5 text-right tabular-nums">
        {won(amount)}
        {l && (
          <div className="text-xs text-muted" title={l.basis}>
            필요 {won(l.need)}
            {l.basis && <div className="ml-auto max-w-[14rem] whitespace-normal" style={{ wordBreak: 'keep-all' }}>{l.basis}</div>}
          </div>
        )}
      </td>
    );
  };
  const groups = (Object.keys(INSURED_WHO) as (keyof typeof INSURED_WHO)[])
    .map((k) => {
      const list = insurance.filter((p) => (p.insured ?? 'self') === k);
      const sumOf = (f: (p: Insurance) => number) => list.reduce((a, p) => a + (f(p) || 0), 0);
      return {
        key: k,
        label: INSURED_WHO[k],
        count: list.length,
        premium: sumOf((p) => (isPaying(p, summary.age, profile) ? p.monthlyPremium : 0)),
        death: sumOf((p) => p.death),
        critical: sumOf((p) => p.critical),
        care: sumOf((p) => p.care),
      };
    })
    .filter((g) => g.count > 0);
  if (!groups.length) return null;
  const total = groups.reduce((a, g) => a + g.premium, 0);
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-sm num-table">
          <thead>
            <tr className="border-b border-line text-xs text-muted">
              <th className="py-1.5 text-left font-medium">피보험자</th>
              <th className="py-1.5 text-right font-medium">건수</th>
              <th className="py-1.5 text-right font-medium">월 보험료(납입 중)</th>
              <th className="py-1.5 text-right font-medium">사망보장</th>
              <th className="py-1.5 text-right font-medium">진단비</th>
              <th className="py-1.5 text-right font-medium">간병보장</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.key} className="border-b border-line/60 last:border-0">
                <td className="py-1.5 font-medium">{g.label}</td>
                <td className="py-1.5 text-right tabular-nums">{g.count}건</td>
                <td className="py-1.5 text-right tabular-nums">{won(g.premium)}</td>
                {cell(g.key, 'death', g.death)}
                {cell(g.key, 'critical', g.critical)}
                {cell(g.key, 'care', g.care)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">
        월 보험료는 지금 납입 중인 보험만 더한 금액입니다(합계 월 {won(total)}).
        {summary.insuranceDup.length > 0 && total > 0 && ' 지출에 보험료 항목이 따로 있어 이 금액은 지출에 더하지 않았습니다.'}
      </p>
      {/* 은퇴 후 본인 사망보장은 유족 생활비 대신 배우자 사별 분석으로 보므로, 그 결과를 함께 보여 줌 */}
      {needOf('self', 'death')?.basis?.includes('배우자 사별 분석') && profile.spouseBirthYear > 0 && <SurvivorBenefitNote />}
    </Card>
  );
}

/** 보험 탭: 노후 진단 배우자 사별 분석의 가장 어려운 경우와 사망보장 효과 요약 + 그 카드로 가는 링크 */
function SurvivorBenefitNote() {
  const { worst, living, rate } = useSurvivor();
  return (
    <div className='mt-3 rounded-xl bg-sunken px-3 py-2.5 text-sm' style={{ wordBreak: 'keep-all' }}>
      <div className='font-medium'>본인 사망보장이 노후에 미치는 효과</div>
      <p className='mt-1 text-muted'>
        {worst ? (
          <>가장 어려운 경우는 <b className='text-ink'>{worst.label}</b> 떠날 때로 성공확률 <b className='text-ink'>{pct(round1(worst.successRate), 1)}</b>입니다. {survivorBenefitText(worst, won)}</>
        ) : (
          '배우자 사별 분석을 계산하는 중입니다…'
        )}{' '}
        자세한 경우별 결과는 <CardLink to='/retire' card='배우자 사별 분석'>노후 진단의 배우자 사별 분석</CardLink>에서 봅니다(그 카드에서 정한 혼자일 때 생활비 {living}%, 유족연금 지급률 {rate}% 기준).
      </p>
    </div>
  );
}

/** 지출 입력 안내: 보험료·대출 원리금·재무목표는 자동 반영되므로 지출에 다시 넣지 않음 */
function CashflowGuide() {
  const { summary: s, cashflows, profile: p, start } = useFlp();
  const retired = start.retired;
  const dup = s.insuranceDup.length > 0 && s.insuranceTotal > 0;
  // 보험료로 보이는 지출 항목을 지우면 보험 탭 보험료가 자동으로 더해짐
  const removeDup = async () => {
    const items = cashflows.filter(isInsuranceCashflow);
    const list = items.map((c) => `‘${c.name}’(월 ${won(c.monthly)})`).join(', ');
    if (!confirm(`지출에서 ${list} 항목을 지울까요? 대신 보험 탭 보험료 월 ${won(s.insuranceTotal)}이 지출에 자동으로 더해집니다. 되돌리려면 다시 추가해야 합니다.`)) return;
    await db.cashflows.bulkDelete(items.map((c) => c.id!).filter((id) => id !== undefined));
  };
  return (
    <div className="space-y-2">
      {/* 입력하면서 바로 보이는 저축 여력. 지출이 소득보다 많으면 부족분 안내 */}
      <div className={`rounded-xl px-4 py-3 text-sm ${s.savings < 0 && !retired ? 'bg-warn-soft text-warn' : 'bg-sunken'}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className={s.savings < 0 && !retired ? '' : 'text-muted'}>
            세후 소득 {won(s.income)} − 지출 {won(s.fixed + s.variable)}{s.debtPayment > 0 ? ` − 대출 ${won(s.debtPayment)}` : ''}{s.insurance > 0 ? ` − 보험료 ${won(s.insurance)}` : ''}
          </span>
          <b>{s.savings < 0 ? `매달 ${won(-s.savings)} 부족` : `저축 여력 ${won(s.savings)}`}</b>
        </div>
        {s.savings < 0 && !retired && (
          <p className="mt-1 text-xs">
            은퇴 전({p.retireAge}세)까지도 이 부족분을 매달 금융자산에서 꺼내 쓰는 것으로 계산합니다. 연금 계좌(연금저축·IRP·퇴직연금)나 투자 자산에서 꺼내는 돈은 ‘세후 월소득’에 넣지 마세요. 넣으면 자산이 줄어드는 게 계산에서 빠집니다.
          </p>
        )}
        {retired && <p className="mt-1 text-xs text-muted">은퇴 나이({p.retireAge}세)가 지나 이 지출 목록은 은퇴 후 계산에 쓰지 않습니다. 은퇴 후에는 프로필의 ‘은퇴 후 월 생활비’로 계산합니다.</p>}
      </div>
      {dup && (
        <div className="rounded-xl bg-warn-soft px-4 py-3 text-sm text-warn">
          <b>보험료 중복 의심</b> · 지출의 {s.insuranceDup.map((n) => `‘${n}’`).join(', ')} 항목이 보험료로 보입니다. 그래서 보험 탭의 보험료 {s.insuranceCount}건(월 {won(s.insuranceTotal)})은 지출에 더하지 않았습니다.
          같은 보험이라면 지출에서 이 항목을 지우세요. 보험 탭 금액이 자동으로 더해집니다.
          <div className="mt-2">
            <button className="rounded-lg border border-warn px-3 py-1 text-xs font-semibold hover:bg-warn hover:text-white" onClick={removeDup}>
              지출에서 이 항목 지우기
            </button>
          </div>
        </div>
      )}
      <Guide
        items={[
          <>지금 매달 나가는 생활비만 넣으세요. 저축 여력 = 세후 소득 − 지출 − 대출 원리금 − 보험료입니다.</>,
          <><b>연금 계좌·투자 자산에서 꺼내 쓰는 돈</b>은 소득이 아닙니다. 세후 월소득에 넣지 말고, 지출이 소득보다 많으면 그 부족분이 금융자산에서 빠지는 것으로 두세요.</>,
          <><b>보험료</b>는 보험 탭의 월 보험료 합계를 자동으로 더합니다{s.insurance > 0 ? `(지금 월 ${won(s.insurance)})` : ''}. 지출에 따로 넣지 마세요.</>,
          <><b>대출 원리금</b>(이자 포함)은 부채의 월 상환액으로 계산합니다. 상환이 끝나면 그만큼 저축이 늘어납니다.</>,
          <><b>앞으로 나갈 목표 지출</b>(등록금·차 구입 등)은 재무목표에만 넣으세요. 목표용 적금 납입액은 지출이 아닙니다.</>,
        ]}
      />
    </div>
  );
}

/** 목록 탭 위의 짧은 입력 안내 */
function Guide({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1 rounded-xl bg-sunken px-4 py-3 pl-8 text-xs text-muted">
      {items.map((x, i) => <li key={i}>{x}</li>)}
    </ul>
  );
}

function ListEditor({ table }: { table: ListTable }) {
  const data = useFlp();
  // 화면은 카드 순서(order, 없으면 추가한 순서)로 보여 줌. 계산은 이 순서를 쓰지 않음
  const rows = byOrder(data[table] as unknown as (Record<string, unknown> & { id?: number; order?: number })[]);
  const { label, fields, example } = TABLES[table];
  const tbl = db[table] as unknown as { add: (r: unknown) => Promise<unknown>; update: (id: number, p: unknown) => Promise<unknown>; delete: (id: number) => Promise<void> };
  // 보험은 보장 종류가 여럿이라 합계 한 줄 대신 아래 피보험자별 요약을 씀
  const amountKey = table === 'insurance' ? undefined : fields.find((f) => f.unit === '만원')?.key;
  const total = amountKey ? rows.reduce((a, r) => a + Number(r[amountKey] ?? 0), 0) : 0;
  // 실거주 주택 구입 대출 표시가 계산에 쓰이려면 프로필의 세 설정이 모두 켜져 있어야 함: 꺼진 것을 안내
  const it = { ...DEFAULT_INCOME_TAX, ...(data.profile.incomeTax ?? {}) };
  const loanDeductOff = [
    !it.on && '‘추정하기’로 바꾸기',
    !it.hiPropAuto && '건보료 재산분을 ‘부동산 자산으로 추정’으로 바꾸기',
    !it.hiLoanDeduct && '‘주택 구입 대출 공제’를 ‘예’로 바꾸기',
  ].filter(Boolean).join(' · ');

  const update = (row: { id?: number }, key: string, v: unknown) => {
    let patch: Record<string, unknown> = { [key]: v };
    if (table === 'assets' && key === 'type') {
      const d = ASSET_TYPES[v as AssetType];
      patch = { ...patch, expectedReturn: d.ret, volatility: d.vol, purpose: d.purpose, nature: d.nature } satisfies Partial<Asset>;
      if (v === 'realestate') patch.reUse = (row as Asset).reUse ?? 'home';
      // 공동명의는 부동산만: 다른 유형으로 바꾸면 본인 명의로
      else if ((row as Asset).owner === 'joint') patch.owner = 'self';
    }
    // 연금계좌 ‘같은 계좌’와 계좌 속성(명의·연금수령 1년차 등)은 묶인 줄과 함께 맞춤
    const pen = table === 'assets' && (row as Asset).type === 'pension';
    if (pen && key === 'group') return void setGroupInDb(row.id!, v as string | undefined);
    if (pen && groupOf(row as Asset) && (ACCOUNT_KEYS as readonly string[]).includes(key)) return void setAccountKey(row.id!, key as AccountKey, v);
    tbl.update(row.id!, patch);
  };
  /** 부동산은 용도·성격·변동성 대신 부동산 용도와 시세 상승률 */
  const fieldsOf = (r: Record<string, unknown>): FieldDef[] =>
    table === 'assets' && r.type === 'realestate'
      ? fields
          .filter((f) => f.key !== 'purpose' && f.key !== 'nature' && f.key !== 'volatility')
          .map((f) =>
            f.key === 'amount' ? { ...f, label: '현재 시세' }
            : f.key === 'expectedReturn' ? { ...f, label: '연 시세 상승률', hint: '명목. 장기 물가+0~1%p 정도' }
            : f,
          )
          .concat({ key: 'reUse', label: '부동산 용도', kind: 'select', options: RE_USE, hint: RE_USE_HINT[(r.reUse as ReUse) ?? 'home'] })
      : table === 'insurance'
        ? // 상품명 다음에 피보험자, 자녀면 출생연도까지(납입 종료 나이를 그 사람 나이로 입력)
          [fields[0], { key: 'insured', label: '피보험자', kind: 'select', options: INSURED_WHO } as FieldDef]
            .concat(r.insured === 'child' ? [{ key: 'insuredBirthYear', label: '자녀 출생연도', short: '자녀 출생', kind: 'number', hint: '예: 2015' }] : [])
            .concat(fields.slice(1))
      : fields;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-muted">
          {label} {rows.length}건{amountKey && <> · 합계 <b className="text-ink">{won(total)}</b></>}
        </div>
        <Button onClick={() => tbl.add({ ...example, name: `새 ${label}`, order: nextOrder(rows) })}>+ {label} 추가</Button>
      </div>
      {table === 'assets' && <UndoBar />}
      {table === 'assets' && (
        // ‘같은 계좌’ 입력칸에서 이미 쓰는 계좌 이름을 고르는 목록
        <datalist id="flp-account-groups">
          {groupNames(rows as unknown as Asset[]).map((n) => <option key={n} value={n} />)}
        </datalist>
      )}
      {table === 'cashflows' && <CashflowGuide />}
      {table === 'liabilities' && (
        <Guide
          items={[
            <><b>월 상환액</b>에는 매달 내는 원금 + 이자를 모두 넣으세요. 지출(저축 여력)에서 자동으로 빠지므로 지출 탭에 대출 이자를 따로 넣지 않습니다.</>,
            <>상환 종료 나이를 0으로 두면 잔액·금리·월 상환액으로 자동 계산합니다. 끝나면 그만큼 저축이 늘고, 은퇴 뒤까지 남으면 자산에서 꺼내 갚습니다.</>,
            <><b>원금균등 상환</b>은 상환 방식을 바꾸고 월 상환액에 이번 달 낸 금액(원금 + 이자)을 넣으세요. 이자가 줄면서 상환액도 해마다 줄고, 줄어든 만큼 저축이 늘어납니다.</>,
            <><b>만기일시 상환</b>(이자만 내는 대출)은 상환 방식을 바꾸고 상환 종료 나이에 만기 나이를 넣으세요. 만기에 원금을 자산에서 한 번에 갚는 것으로 계산하므로 재무목표에 따로 넣지 않습니다.</>,
          ]}
        />
      )}
      {table === 'insurance' && <InsuranceSummary />}
      {table === 'insurance' && (
        <Guide
          items={[
            <><b>월 보험료</b>는 지출(저축 여력)에 자동으로 더합니다. 지출 탭에 보험료를 또 넣지 마세요.</>,
            <><b>피보험자</b>(본인·배우자·자녀)를 고르고 <b>납입 종료 나이</b>를 그 사람 나이로 넣으세요. 배우자는 프로필 탭의 배우자 출생연도, 자녀는 자녀 출생연도로 본인 나이로 바꿔 계산합니다.</>,
            <>납입 종료 나이를 넣으면 그 나이부터 보험료가 지출에서 빠지고, 은퇴 전이면 그만큼 저축이 늘어나는 것으로 계산합니다. 은퇴 나이보다 늦으면 은퇴 후 그 전 해까지 보험료를 자산에서 꺼내 내는 것으로 계산합니다. 0이면 계속 납입하는 것으로 보고, 은퇴 후에도 기대수명까지 보험료를 자산에서 꺼내 내는 것으로 계산합니다(이미 은퇴 후 생활비에 넣었다면 생활비에서 빼 주세요).</>,
          ]}
        />
      )}
      {table === 'goals' && (
        <Guide
          items={[
            <>앞으로 특정 나이에 나갈 돈(등록금·차 구입·결혼 자금 등)만 넣으세요. 목표 나이에 자산에서 빠지므로 지출 탭에는 넣지 않습니다.</>,
            <><b>지금 이미 매달 내는 비용</b>(올해 학원비 등)은 지출에만 넣고, 같은 비용을 반복 목표로 또 넣지 마세요.</>,
            <>목표를 위해 붓는 적금 납입액은 지출도 목표도 아닙니다. 쌓인 잔액만 자산(중기·목적자금)으로 넣으세요. 대출 원금 상환과 은퇴 후 생활비에 이미 든 비용도 넣지 않습니다.</>,
            <>필요 금액은 오늘 물가 기준 금액입니다. 비용 상승률이 물가보다 높으면 그 차이만큼 커집니다.</>,
            <><b>금액 방식</b>을 ‘금액 고정’으로 바꾸면 해마다 같은 금액(명목)이 나가고, 오늘 가치로는 물가만큼 줄어듭니다. 계약으로 금액이 정해진 지출에만 쓰고, 세금처럼 오를 수 있는 지출은 ‘물가 반영’으로 두세요.</>,
          ]}
        />
      )}
      {rows.length === 0 && <Card><p className="py-6 text-sm text-muted">등록된 {label}이(가) 없습니다. ‘추가’를 누르거나 ‘백업·복원’ 탭에서 CSV로 한 번에 불러오세요.</p></Card>}
      {rows.map((r, idx) => (
        <Card key={r.id} className={table === 'liabilities' && bulletMissingMaturity(r as unknown as Liability, data.summary.age) ? 'border-warn! ring-1 ring-warn' : ''}>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
            {fieldsOf(r).map((f) => (
              <div key={f.key} id={`field-${table}-${r.id}-${f.key}`} className={f.key === 'name' ? 'col-span-2 md:col-span-1' : ''}>
                <Labeled label={f.unit ? `${f.short ?? f.label}(${f.unit})` : f.short ?? f.label} hint={f.hint}>
                  {f.kind === 'number' ? (
                    <NumberField plain={/Year$/.test(f.key)} value={Number(r[f.key] ?? 0)} step={f.step} onChange={(v) => update(r, f.key, v)} />
                  ) : f.kind === 'select' ? (
                    <SelectField value={String(r[f.key] ?? Object.keys(f.options!)[0])} options={f.options!} onChange={(v) => update(r, f.key, v)} />
                  ) : (
                    <TextField value={String(r[f.key] ?? '')} onChange={(v) => update(r, f.key, v)} />
                  )}
                </Labeled>
              </div>
            ))}
          </div>
          {table === 'assets' && (r.type === 'realestate'
            ? <RealEstateExtra a={r as unknown as Asset} onChange={(k, v) => update(r, k, v)} />
            : <AssetExtra a={r as unknown as Asset} onChange={(k, v) => update(r, k, v)} />)}
          {table === 'liabilities' && (
            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted">
              <label className="flex items-center gap-2">
                상환 방식
                <select
                  className="rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink"
                  value={r.repay === 'bullet' && r.maturity === 'open' ? 'open' : r.repay === 'bullet' || r.repay === 'equal' ? r.repay : 'amort'}
                  onChange={(e) => {
                    const v = e.target.value;
                    // 만기 미정: 만기일시(이자만)로 두고 만기 나이는 비움
                    if (v === 'open') tbl.update(r.id!, { repay: 'bullet', maturity: 'open', endAge: 0 });
                    else tbl.update(r.id!, { repay: v === 'bullet' || v === 'equal' ? v : undefined, maturity: undefined });
                  }}
                >
                  <option value="amort">원리금균등 상환(매달 같은 금액)</option>
                  <option value="equal">원금균등 상환(상환액이 점점 줄어듦)</option>
                  <option value="bullet">만기일시 상환(이자만 내다 만기에 원금)</option>
                  <option value="open">만기 미정(이자만 납입 · 지인 대출 등)</option>
                </select>
              </label>
              <div>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={r.homeLoan === 'buy'} onChange={(e) => tbl.update(r.id!, { homeLoan: e.target.checked ? 'buy' : undefined })} />
                  실거주 주택 구입 대출(건보료 재산분을 부동산 자산으로 추정할 때 대출 공제 대상)
                </label>
                <p className="mt-1 pl-6 text-xs text-muted">1세대 1주택으로 지금 사는 집을 사려고 받은 대출(주택담보대출·보금자리론 등)일 때만 체크하세요. 전세자금대출·신용대출·투자용 주택 대출은 해당하지 않습니다.</p>
                {r.homeLoan === 'buy' && loanDeductOff && (
                  <p role="alert" className="mt-1 ml-6 rounded-lg bg-warn-soft px-2 py-1 text-xs text-warn">
                    지금은 계산에 반영되지 않습니다. 프로필 → 종합소득세·건강보험료에서 할 일: {loanDeductOff}
                  </p>
                )}
              </div>
            </div>
          )}
          {table === 'goals' && (
            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted">
              <label className="flex items-center gap-2">
                금액 방식
                <select
                  className="rounded-lg border border-line bg-surface px-2 py-1 text-xs text-ink"
                  value={r.priceMode === 'fixed' ? 'fixed' : 'price'}
                  onChange={(e) => tbl.update(r.id!, { priceMode: e.target.value === 'fixed' ? 'fixed' : undefined })}
                >
                  <option value="price">물가 반영(비용 상승률만큼 오름)</option>
                  <option value="fixed">금액 고정(해마다 같은 금액)</option>
                </select>
              </label>
              <span>
                {r.priceMode === 'fixed'
                  ? '실제로 내는 금액이 필요 금액 그대로라 오늘 가치로는 해마다 물가만큼 줄어듭니다. 비용 상승률은 쓰지 않습니다.'
                  : '세금·학비처럼 물가와 함께 오르는 지출은 물가 반영으로 두세요.'}
              </span>
            </div>
          )}
          <div className="mt-3 flex items-center justify-between gap-3">
            {table === 'liabilities' && bulletMissingMaturity(r as unknown as Liability, data.summary.age) ? (
              // 만기 나이가 빈 만기일시 대출: 경고색 안내, 누르면 상환 종료 나이 입력칸으로 이동
              <button
                type="button"
                className="text-left text-xs font-medium text-warn underline decoration-dotted underline-offset-2"
                onClick={() => {
                  const box = document.getElementById(`field-liabilities-${r.id}-endAge`);
                  box?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  box?.querySelector('input')?.focus({ preventScroll: true });
                  box?.querySelector('input')?.select();
                }}
              >
                {loanNote(r as unknown as Liability, data.summary.age, data.profile.retireAge)} → 상환 종료 나이 입력
              </button>
            ) : (
            <span className="text-xs text-muted">{table === 'liabilities' && loanNote(r as unknown as Liability, data.summary.age, data.profile.retireAge)}{table === 'goals' && goalNote(r as unknown as Goal)}{table === 'insurance' && insuranceNote(r as unknown as Insurance, data.profile, data.summary.age, data.profile.retireAge)}</span>
            )}
            <span className="flex shrink-0 items-center gap-3">
              <MoveButtons name={String(r.name ?? '')} index={idx} count={rows.length} onMove={(dir) => void moveRow(table, r.id!, dir)} />
              <button className="text-xs font-medium text-bad hover:underline" onClick={() => confirm(`'${r.name}'을(를) 삭제할까요?`) && tbl.delete(r.id!)}>
                삭제
              </button>
            </span>
          </div>
        </Card>
      ))}
    </div>
  );
}

/**
 * ‘같은 계좌’ 점검 안내: 이 이름을 쓰는 줄이 하나뿐, 띄어쓰기·대소문자만 다른 계좌 이름, 묶인 줄끼리 계좌 속성이 다름.
 * 이미 쓰는 계좌 이름은 입력칸 목록(datalist)으로 고를 수 있음.
 */
function GroupNotes({ a, assets, onChange }: { a: Asset; assets: Asset[]; onChange: (key: keyof Asset, v: unknown) => void }) {
  const g = groupOf(a);
  const { lone, near } = groupNotes(a, assets);
  const diff = accountMismatch(a, assets);
  const link = 'font-semibold text-brand hover:underline';
  return (
    <>
      {near && (
        <p role="alert" className="mt-2 rounded-lg bg-warn-soft px-2 py-1 text-xs text-warn">
          띄어쓰기·대소문자만 다른 ‘{near}’ 계좌가 있어 지금은 다른 계좌로 계산합니다.{' '}
          <button type="button" className={link} onClick={() => onChange('group', near)}>‘{near}’로 맞추기</button>
        </p>
      )}
      {!near && lone && (
        <p className="mt-2 text-xs text-muted">
          ‘{g}’ 이름을 쓰는 줄이 이 줄 하나뿐이라 혼자 한 계좌로 계산합니다. 같은 계좌의 다른 줄에도 이 이름을 넣거나{' '}
          <button type="button" className={link} onClick={() => onChange('group', undefined)}>비우세요</button>.
        </p>
      )}
      {diff.length > 0 && (
        <p role="alert" className="mt-2 rounded-lg bg-warn-soft px-2 py-1 text-xs text-warn">
          ‘{g}’ 계좌의 줄끼리 값이 다른 항목이 있습니다({diff.map((k) => ACCOUNT_KEY_LABEL[k]).join('·')}). 계산은 먼저 추가한 줄의 값을 씁니다(카드 순서와 무관).{' '}
          <button type="button" className={link} onClick={() => void alignAccount(a)}>먼저 추가한 줄 값으로 맞추기</button>
        </p>
      )}
    </>
  );
}

/** 자산 추가 설정: 명의, 수령 전 묶인 자산(노란우산 등), 연금계좌 재원 구성 */
/** 노란우산 개월 수·월 선택지(0 = 비움). 목록에서만 골라 1~12 밖의 값은 들어가지 않음 */
const MONTH_COUNT_OPTIONS: Record<string, string> = { 0: '비움(12개월)', ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, `${i + 1}개월`])) };
const MONTH_OPTIONS: Record<string, string> = { 0: '비움', ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, `${i + 1}월`])) };

function AssetExtra({ a, onChange }: { a: Asset; onChange: (key: keyof Asset, v: unknown) => void }) {
  const { profile: p, summary, assets, liabilities } = useFlp();
  const saveProfile = useSaveProfile();
  const nowYear = p.birthYear + summary.age;
  const hasSpouse = p.spouseBirthYear > 0;
  const pension = a.type === 'pension';
  const locked = (a.lockYear ?? 0) > nowYear;
  const yu = isYu(a) && !pension;
  // 노란우산: 소득공제 비율·절세액은 종합소득세 추정 행에서(사업소득은 프로필 ‘그 밖의 소득’, 법인 대표는 세전 총급여)
  const taxRows = useMemo(() => (yu ? incomeTaxSchedule(p, nowYear, undefined, assets, liabilities, summary.yearShare ?? 1) : undefined), [yu, p, nowYear, assets, liabilities, summary.yearShare]);
  const [open, setOpen] = useState(pension || locked || yu || (a.owner ?? 'self') !== 'self');
  if (!open) {
    return (
      <button className="mt-2 text-xs font-medium text-brand hover:underline" onClick={() => setOpen(true)}>
        + 명의·수령 시점{pension ? '·연금 재원' : ''} 설정
      </button>
    );
  }
  const inflow = locked ? lockedInflow(a, p, nowYear, taxRows, summary.yearShare ?? 1) : null;
  // 이 계좌의 그 해 납입액(올해는 남은 달만큼)과 그중 소득공제 받는 금액(공제 기준 납입액 × 명의자 공제 비율)
  // 프로필 ‘올해 소득공제 1~12월 기준’이면 올해 공제는 1~12월 전체 납입액 기준 — 종합소득세 카드·이정표와 같은 행에서
  const yuShare = summary.yearShare ?? 1;
  const yuInfo = taxRows ? yuAssetDed(a, p, nowYear, yuShare, taxRows) : undefined;
  const yuRow = yuInfo?.row;
  const yuPayRow = yuInfo?.pay ?? 0;
  const yuDedBase = yuInfo?.dedBase ?? 0;
  const yuDed = yuInfo?.ded ?? 0;
  const yuFullNote = p.yuDedFullYear && yuRow?.year === nowYear && yuShare < 1;
  const yuMonths = Math.round(yuShare * 12);
  const yuPaying = yu && (a.yuPay ?? 0) > 0;
  return (
    <div className="mt-3 rounded-xl bg-sunken p-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
        {hasSpouse && (
          <Labeled label="명의">
            <SelectField value={a.owner ?? 'self'} onChange={(v) => onChange('owner', v)} options={{ self: '본인', spouse: '배우자' }} />
          </Labeled>
        )}
        <Labeled label="수령 연도" hint={locked ? `${nowYear}~${a.lockYear! - 1}년 인출 불가` : '0이면 지금 인출 가능'}>
          <NumberField plain value={a.lockYear ?? 0} onChange={(v) => onChange('lockYear', v)} />
        </Labeled>
        {yu && (
          <Labeled label="수령 월" hint="퇴직소득세 근속연수를 개월로 셈 · 가입 월과 둘 다 비우면 연도 차이">
            <SelectField value={String(a.yuPayoutMonth ?? 0)} onChange={(v) => onChange('yuPayoutMonth', Number(v) || undefined)} options={MONTH_OPTIONS} />
          </Labeled>
        )}
        <Labeled label="수령 시 세율(%)" hint={yu ? (inflow?.yu?.auto ? `0이면 퇴직소득세 자동(지금 약 ${inflow.yu.rate.toFixed(1)}%)` : '넣으면 적립금 × 세율 · 0이면 퇴직소득세 자동') : '일시금 실효세율'}>
          <NumberField value={a.lockTax ?? 0} step={0.1} onChange={(v) => onChange('lockTax', v)} />
        </Labeled>
        {!pension && (
          <Labeled label="노란우산공제" hint="납입액 소득공제 · 수령 때 퇴직소득세">
            <SelectField value={a.yu ? 'yes' : 'no'} onChange={(v) => onChange('yu', v === 'yes' ? true : undefined)} options={{ no: '아니오', yes: '예' }} />
          </Labeled>
        )}
        {yu && (
          <>
            <Labeled label="연 납입액(만원)" hint="월 부금 × 12 · 명목 고정">
              <NumberField value={a.yuPay ?? 0} min={0} onChange={(v) => onChange('yuPay', v > 0 ? v : undefined)} />
            </Labeled>
            <Labeled label="마지막 납입 연도" hint={`0이면 명의자 은퇴 전 해(지금 ${yuPayTo(a, p)}년)`}>
              <NumberField plain value={a.yuPayTo ?? 0} onChange={(v) => onChange('yuPayTo', v > 0 ? v : undefined)} />
            </Labeled>
            <Labeled label="마지막 해 납입 개월" hint="마지막 납입 연도에 낸 개월 수 · 비우면 12개월(그 해 1년치)">
              <SelectField value={String(a.yuLastMonths ?? 0)} onChange={(v) => onChange('yuLastMonths', Number(v) || undefined)} options={MONTH_COUNT_OPTIONS} />
            </Labeled>
            <Labeled label="가입 연도" hint="퇴직소득세 근속연수(가입 기간)">
              <NumberField plain value={a.yuJoin ?? 0} onChange={(v) => onChange('yuJoin', v > 0 ? v : undefined)} />
            </Labeled>
            <Labeled label="가입 월" hint="가입한 달부터 수령한 달까지로 근속연수(1년 미만은 1년으로 올림)">
              <SelectField value={String(a.yuJoinMonth ?? 0)} onChange={(v) => onChange('yuJoinMonth', Number(v) || undefined)} options={MONTH_OPTIONS} />
            </Labeled>
            <Labeled label="올해 소득공제 기준" hint={`프로필 설정 · 모든 노란우산에 적용 · 적립금·지출은 늘 남은 ${yuMonths}개월분`}>
              <SelectField value={p.yuDedFullYear ? 'full' : 'rest'} onChange={(v) => saveProfile({ yuDedFullYear: v === 'full' ? true : undefined })} options={{ rest: '남은 달 납입액(기본)', full: '1~12월 전체 납입액(세법)' }} />
            </Labeled>
            <Labeled label="공제 안 받은 부금(만원)" hint="지금까지 소득공제 못 받은 부금 누계 · 비과세">
              <NumberField value={a.taxFree ?? 0} onChange={(v) => onChange('taxFree', v > 0 ? v : undefined)} />
            </Labeled>
          </>
        )}
        {pension && (
          <>
            <Labeled label="과세제외(만원)" hint="세액공제 안 받은 원금">
              <NumberField value={a.taxFree ?? 0} onChange={(v) => onChange('taxFree', v)} />
            </Labeled>
            <Labeled label="개인 입금액(만원)" hint="퇴직금 빼고 넣은 원금 누계 · 세액공제 대조용">
              <NumberField value={a.paidIn ?? 0} onChange={(v) => onChange('paidIn', v > 0 ? v : undefined)} />
            </Labeled>
            <Labeled label="퇴직금 재원(만원)" hint="IRP 이연퇴직소득">
              <NumberField value={a.retirePart ?? 0} onChange={(v) => onChange('retirePart', v)} />
            </Labeled>
            <Labeled label="과세재원(만원)" hint="1,500만 한도 대상">
              <div className="py-2 text-sm font-semibold">{won(Math.max(0, a.amount - (a.taxFree ?? 0) - (a.retirePart ?? 0)))}</div>
            </Labeled>
            <Labeled label="연금수령 1년차 연도" hint={yearNoHint(a, p, nowYear)}>
              <NumberField plain value={a.pensionYear1 ?? 0} onChange={(v) => onChange('pensionYear1', v)} />
            </Labeled>
            <Labeled label="인출 시작 연도" hint={(a.drawStartYear ?? 0) > nowYear ? `${a.drawStartYear! - 1}년까지 꺼내지 않음 · 추가 납입 계좌` : '0이면 바로(55세부터)'}>
              <NumberField plain value={a.drawStartYear ?? 0} onChange={(v) => onChange('drawStartYear', v)} />
            </Labeled>
            <Labeled label="꺼내는 순서" hint="같은 명의 안에서 작을수록 먼저 · 0이면 추가한 순서(카드 순서와 무관)">
              <NumberField value={a.drawOrder ?? 0} min={0} onChange={(v) => onChange('drawOrder', v)} />
            </Labeled>
            <Labeled label="비교 기준 순서" hint="인출 순서 비교표 ①에서만 씀 · 0이면 추가한 순서">
              <NumberField value={a.compareOrder ?? 0} min={0} onChange={(v) => onChange('compareOrder', v)} />
            </Labeled>
            <Labeled label="같은 계좌" hint="이름이 같은 줄은 한 계좌로 계산 · 비우면 이 줄이 한 계좌">
              <TextField value={a.group ?? ''} placeholder="예: 퇴직 IRP" list="flp-account-groups" onChange={(v) => onChange('group', v.trim() ? v : undefined)} />
            </Labeled>
          </>
        )}
      </div>
      {pension && <GroupNotes a={a} assets={assets} onChange={onChange} />}
      {pension && <JoinAccount a={a} assets={assets} className="mt-2" />}
      {pension && (
        <p className="mt-2 text-xs text-muted">
          연금수령 1년차는 55세가 되고 가입 5년이 지난 해입니다(2013년 3월 전 가입 계좌는 55세에 6년차). 10년차까지는 해마다 ‘연초 평가액 ÷ (11 − 연차) × 120%’까지만 연금으로 받을 수 있고, 넘는 금액은 연금외수령으로 세금이 무거워집니다.
        </p>
      )}
      {yu && !locked && (
        <p role="alert" className="mt-2 rounded-lg bg-warn-soft px-2 py-1 text-xs text-warn">수령 연도를 넣어야 노란우산 납입·소득공제·퇴직소득세를 계산합니다(폐업·노령 등으로 받을 해).</p>
      )}
      {yuPaying && locked && yuRow && (
        <p className="mt-2 text-xs text-muted">
          {yuRow.year}년 납입 {won(yuPayRow)}{yuRow.year === nowYear && yuShare < 1 ? `(연 ${won(a.yuPay!)} 중 올해 남은 ${yuMonths}개월분)` : ''}{yuFullNote ? `, 소득공제는 1~12월 전체 납입액 ${won(yuDedBase)} 기준 ${won(yuDed)}` : ` 중 소득공제 ${won(yuDed)}`}
          {yuRow.yuSave > 0.5 ? ` → 종합소득세 약 ${won(yuRow.yuSave)} 감소(부부 합계, 다음 해 5월에 들어오는 돈으로 계산)` : ''}.
          {yuDed <= 0 && <> 사업소득이 없어 공제하지 않았습니다. 은퇴 전 사업소득은 <SetupLink tab="profile" card="그 밖의 은퇴 후 소득">프로필 → 그 밖의 소득</SetupLink>에 ‘사업소득’으로 지금 나이부터 넣거나, 법인 대표자면 세전 총급여(연 {won(YU_CEO_WAGE)} 이하)를 넣으세요.{inflow?.yu && <> 공제받지 못한 부금은 ‘공제 안 받은 부금’으로 보아 수령 때 과세하지 않습니다(앞으로 낼 부금 중 {won(inflow.yu.futureNonDed)}{inflow.yu.nonDed - inflow.yu.futureNonDed > 0 ? ` + 지금까지 입력한 ${won(inflow.yu.nonDed - inflow.yu.futureNonDed)}` : ''} = 비과세 {won(inflow.yu.nonDed)}).</>}</>}
          {' '}해마다 연 납입액을 꺼내 쓸 수 있는 금융자산에서 이 계좌로 옮기는 것으로 계산합니다(지출 탭에 부금을 또 넣지 마세요).
        </p>
      )}
      {inflow?.yu && (
        <p className="mt-2 text-xs text-muted">
          수령 때 적립금 약 {won(inflow.yu.fv)} 중 소득공제 받은 부금과 운용수익 {won(inflow.yu.taxable)}은 퇴직소득(근속연수 {inflow.yu.years}년({Math.floor(inflow.yu.months / 12)}년 {inflow.yu.months % 12}개월)){inflow.yu.auto ? `, 퇴직소득세 약 ${won(inflow.yu.tax)}` : `, 직접 넣은 세율로 세금 ${won(inflow.yu.tax)}`}입니다. 공제 못 받은 부금 {won(inflow.yu.nonDed)}은 과세하지 않습니다. 중도 해지는 기타소득(16.5%)이라 이 계산과 다릅니다.
        </p>
      )}
      {inflow && (
        <p className="mt-2 text-xs text-muted">
          {inflow.year}년(본인 {inflow.age}세)까지 연 {a.expectedReturn}%로 불어나 세후 약 {won(inflow.nominal)}(현재가치 {won(inflow.amount)})을 받아, 그때부터 다른 금융자산과 함께 은퇴 후 수익률로 운용합니다. 그 전에는 인출률·인출 계산에서 뺍니다.
        </p>
      )}
    </div>
  );
}

/** 부동산 추가 설정: 명의·지분, 임대 조건(월세·보증금·갱신), 매각 계획 */
function RealEstateExtra({ a, onChange }: { a: Asset; onChange: (key: keyof Asset, v: unknown) => void }) {
  const { profile: p, summary } = useFlp();
  const nowYear = p.birthYear + summary.age;
  const hasSpouse = p.spouseBirthYear > 0;
  const use = reUseOf(a);
  const rental = use === 'rental';
  const owner = a.owner ?? 'self';
  const hp = usesHp(a) ? housePension(a, p, summary.age) : null;
  const est = hp?.eligible ? hpEstate(a, p, summary.age) : null;
  const loan = hpLoanOf(a);
  const sale = willSell(a, nowYear) ? saleInflow(a, p, nowYear) : null;
  const pastSale = (a.lockYear ?? 0) > 0 && !sale;
  const retireYear = p.birthYear + Math.max(p.retireAge, summary.age);
  return (
    <div className="mt-3 rounded-xl bg-sunken p-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
        {hasSpouse && (
          <Labeled label="명의" hint={rental ? '임대소득 종소세를 지분대로 나눔' : undefined}>
            <SelectField value={owner} onChange={(v) => onChange('owner', v)} options={{ self: '본인', spouse: '배우자', joint: '공동명의' }} />
          </Labeled>
        )}
        {hasSpouse && owner === 'joint' && (
          <Labeled label="본인 지분(%)" hint={`배우자 ${100 - (a.ownerShare ?? 50)}%`}>
            <NumberField value={a.ownerShare ?? 50} min={0} onChange={(v) => onChange('ownerShare', Math.min(100, Math.max(0, v)))} />
          </Labeled>
        )}
        {rental && (
          <>
            <Labeled label="월세(만원)" hint="오늘 기준 · 전세면 0">
              <NumberField value={a.rent ?? 0} onChange={(v) => onChange('rent', v)} />
            </Labeled>
            <Labeled label="임대보증금(만원)" hint="돌려줄 돈 → 부채로 계산">
              <NumberField value={a.deposit ?? 0} onChange={(v) => onChange('deposit', v)} />
            </Labeled>
            <Labeled label="계약 갱신 주기(년)" hint="주택 2년 · 상가 1년 등">
              <NumberField value={a.renewCycle ?? RENT_DEFAULT.renewCycle} min={1} onChange={(v) => onChange('renewCycle', Math.max(1, Math.round(v)))} />
            </Labeled>
            <Labeled label="갱신 때 인상률(%)" hint="주택 갱신 상한 5%">
              <NumberField value={a.renewRate ?? RENT_DEFAULT.renewRate} step={0.1} onChange={(v) => onChange('renewRate', v)} />
            </Labeled>
            <Labeled label="공실·관리 경비율(%)" hint="월세 대비. 보유세·수선비 포함">
              <NumberField value={a.rentCost ?? 0} step={1} min={0} onChange={(v) => onChange('rentCost', v)} />
            </Labeled>
          </>
        )}
        {use === 'home' && (
          <Labeled label="주택연금 가입 나이" hint={hp ? (hp.startAge < p.retireAge ? `은퇴(${p.retireAge}세) 전 수령분은 시뮬레이션에서 빠짐` : `${hp.joinYear}년 가입 · 매각 계획 대신 사용`) : '본인 기준 · 0이면 안 함'}>
            <NumberField value={a.hpAge ?? 0} onChange={(v) => { onChange('hpAge', Math.max(0, Math.round(v))); if (v > 0 && (a.lockYear ?? 0) > 0) onChange('lockYear', 0); }} />
          </Labeled>
        )}
        {hp && (
          <Labeled label="월 수령액(만원)" hint={`오늘 기준 · 0이면 자동 추정(월 ${won(hp.auto ? hp.real : hpEstimate(hp.price, hp.calcAge) / (hp.nominal / hp.real))})`}>
            <NumberField value={a.hpMonthly ?? 0} onChange={(v) => onChange('hpMonthly', Math.max(0, v))} />
          </Labeled>
        )}
        {hp && (
          <>
            <Labeled label="대출 금리(%)" hint={`COFIX + 0.85%p · 기본 ${HP_LOAN.rate}`}>
              <NumberField value={loan.rate} step={0.1} min={0} onChange={(v) => onChange('hpRate', Math.max(0, v))} />
            </Labeled>
            <Labeled label="초기보증료(%)" hint={`주택가격 대비 · 기본 ${HP_LOAN.initFee}`}>
              <NumberField value={loan.initFee} step={0.1} min={0} onChange={(v) => onChange('hpInitFee', Math.max(0, v))} />
            </Labeled>
            <Labeled label="연보증료(%)" hint={`대출 잔액 대비 · 기본 ${HP_LOAN.annualFee}`}>
              <NumberField value={loan.annualFee} step={0.05} min={0} onChange={(v) => onChange('hpAnnualFee', Math.max(0, v))} />
            </Labeled>
          </>
        )}
        {!hp && (
          <>
            <Labeled label="매각 연도" hint={sale ? `${nowYear}~${sale.year - 1}년 보유 · 본인 ${sale.age}세에 매각` : pastSale ? '지난 연도는 무시(계속 보유)' : '0이면 팔지 않음'}>
              <NumberField plain value={a.lockYear ?? 0} onChange={(v) => onChange('lockYear', v)} />
            </Labeled>
            <Labeled label="매각 비용률(%)" hint={use === 'home' ? '1주택 비과세면 중개보수 등 0.5 안팎' : '양도세+중개보수 실효율'}>
              <NumberField value={a.lockTax ?? 0} step={0.1} onChange={(v) => onChange('lockTax', v)} />
            </Labeled>
          </>
        )}
        {use === 'home' && !hp && (
          <Labeled label="새 집 구입액(만원)" hint="다운사이징 · 오늘 시세. 0이면 매각 전액 노후 자금">
            <NumberField value={a.reBuy ?? 0} onChange={(v) => onChange('reBuy', v)} />
          </Labeled>
        )}
      </div>
      <div className="mt-2 space-y-1 text-xs text-muted">
        {rental && (a.rent ?? 0) > 0 && (
          <p>
            임대수익률 {rentYield(a).toFixed(1)}%(연 월세 ÷ 시세에서 보증금을 뺀 자기 돈) · 경비 뺀 순수입 월 {won(netRentOf(a))}.
            {' '}은퇴 후({retireYear}년~){sale ? ` ${sale.year - 1}년까지` : ''} 노후 소득으로 들어가고, {a.renewCycle ?? RENT_DEFAULT.renewCycle}년마다 {a.renewRate ?? RENT_DEFAULT.renewRate}%씩 오릅니다(지금부터 셈). 은퇴 전 월세는 세후 월소득에 넣어 주세요.
            {' '}‘그 밖의 은퇴 후 소득’에 같은 월세를 또 넣지 마세요.
          </p>
        )}
        {rental && (a.rent ?? 0) === 0 && <p>월세를 넣으면 은퇴 후 소득·종합소득세·건강보험료에 반영됩니다. 전세는 보증금만 부채로 계산합니다.</p>}
        {hp && a.amount > HP_MARKET_CAP && (
          <p className="rounded-lg bg-warn-soft px-3 py-2 text-warn">
            <b>가입이 어려울 수 있어요.</b> 주택연금은 공시가격 12억원 이하 주택만 가입할 수 있는데, 지금 시세 {won(a.amount)}은 그 기준(시세로 약 {won(HP_MARKET_CAP)})을 크게 넘습니다. 공시가격을 확인하고, 넘는다면 가입 나이를 0으로 두거나 더 작은 집으로 옮긴 뒤 가입하는 계획(매각 연도·새 집 구입액)으로 바꾸세요. 아래 금액은 가입된다고 가정한 값입니다.
          </p>
        )}
        {hp ? (
          <p>
            {hp.eligible ? (
              <>
                {hp.joinYear}년(본인 {hp.startAge}세, 부부 중 연소자 {hp.calcAge}세 기준) 예상 시세 {won(hp.price)}으로 가입하면 월 <b className="text-ink">{won(hp.nominal)}</b>(현재가치 {won(hp.real)})을 평생 같은 금액으로 받습니다(정액형 · 실질로는 물가만큼 줄어듦).
                {' '}노후 진단·인출의 연금 소득에 들어가고, 대출이라 종합소득세·건강보험료 대상은 아닙니다. 집은 계속 소유하므로 순자산에는 그대로 남습니다.
                {est && <> 기대수명({est.age}세, {est.year}년)까지 받으면 대출 잔액은 받은 돈 {won(est.paid)} + 이자·보증료 = {won(est.balance)}이고, 예상 시세 {won(est.price)}에서 빼면 <b className="text-ink">상속 시 남는 주택 가치 {won(est.left)}</b>(현재가치 {won(est.leftReal)}){est.left === 0 ? ' — 잔액이 집값을 넘어도 모자라는 돈은 상속인이 갚지 않습니다' : ''}. 대출 금리 {loan.rate}%, 보증료 초기 {loan.initFee}%·연 {loan.annualFee}%로 계산했습니다(위 입력칸에서 바꿀 수 있음).</>}
                {hp.auto && ' 자동 추정은 한국주택금융공사 2026.3 월지급금 예시(일반주택·종신 정액형)를 나이로 보간한 값입니다.'}
              </>
            ) : (
              '주택연금은 부부 중 한 명이 55세 이상이어야 가입할 수 있어 반영하지 않았습니다.'
            )}
          </p>
        ) : sale ? (
          <p>
            {sale.year}년 예상 시세 {won(sale.price)} − 매각 비용 {won(sale.cost)}{sale.deposit > 0 ? ` − 보증금 반환 ${won(sale.deposit)}` : ''}{sale.rebuy > 0 ? ` − 새 집 ${won(sale.rebuy)}` : ''} = <b className="text-ink">{won(sale.nominal)}</b>(현재가치 {won(sale.amount)})이
            {sale.nominal >= 0 ? ' 금융자산으로 들어와 노후 진단·인출에 함께 운용됩니다.' : ' 부족해 그만큼 금융자산에서 더 나갑니다.'}
          </p>
        ) : (
          <p>
            {use === 'rental' ? '팔지 않으면 시세는 순자산에만 들어가고, 월세만 노후 현금흐름에 반영됩니다.' : '팔지 않는 동안 시세는 순자산·부동산 편중 점검에만 쓰고 노후 자금에는 넣지 않습니다.'}
            {' '}부동산은 매일 사고팔 수 없어 노후 시뮬레이션의 운용자산(수익률·변동성)에서 빼므로 변동성은 입력하지 않습니다. 시세 상승률은 매각 연도를 넣으면 매각대금 계산에 씁니다.
          </p>
        )}
      </div>
    </div>
  );
}

/** 올해 연금수령연차·한도 안내 */
function yearNoHint(a: Asset, p: Profile, nowYear: number) {
  const birth = (a.owner ?? 'self') === 'spouse' && p.spouseBirthYear > 0 ? p.spouseBirthYear : p.birthYear;
  const year1 = a.pensionYear1 || birth + PENSION_OPEN_AGE;
  const n = pensionYearNo(nowYear, year1);
  if (n < 1) return `${a.pensionYear1 ? '' : '비우면 55세 · '}${year1}년부터 수령`;
  const limit = pensionLimit(a.amount, n);
  return `올해 ${n}년차 · 한도 ${limit === Infinity ? '없음' : won(limit)}`;
}

/** 출생 월 안내: 국민연금 첫해 수령 개월 수 */
function monthHint(m?: number) {
  const k = Math.round(m ?? 0);
  return k >= 1 && k <= 12 ? `국민연금 첫해 ${12 - k}개월(생일 다음 달부터)` : '0이면 국민연금 첫해도 12개월';
}

function BackupPanel() {
  const [table, setTable] = useState<ListTable>('assets');
  const [msg, setMsg] = useState<string>('');
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const csvRef = useRef<HTMLInputElement>(null);
  const jsonRef = useRef<HTMLInputElement>(null);
  const data = useFlp();
  const stamp = new Date().toLocaleDateString('sv-SE');

  const onCSV = async (file: File) => {
    const { rows, errors } = fromCSV(table, await file.text());
    const tbl = db[table] as unknown as { clear: () => Promise<void>; bulkAdd: (r: unknown[]) => Promise<unknown> };
    // 읽을 수 있는 행이 없으면(다른 표의 파일·빈 파일) ‘교체’여도 기존 데이터를 지우지 않음
    if (rows.length === 0) {
      setMsg(`가져올 ${TABLES[table].label} 행이 없어 아무것도 바꾸지 않았습니다. ‘대상’과 파일이 맞는지 확인해 주세요.${errors.length ? `\n확인 필요:\n- ${errors.join('\n- ')}` : ''}`);
      return;
    }
    if (mode === 'replace') await tbl.clear();
    // ‘기존 데이터에 추가’면 가져온 줄을 지금 카드들 아래에 붙임(화면 순서 열이 있으면 그 순서대로)
    await tbl.bulkAdd(mode === 'append' ? appendOrders(data[table] as { id?: number; order?: number }[], rows) : rows);
    setMsg(`${TABLES[table].label} ${rows.length}건을 가져왔습니다.${errors.length ? `\n확인 필요:\n- ${errors.join('\n- ')}` : ''}`);
  };

  return (
    <div className="space-y-4">
      <Card title="CSV 가져오기·내보내기" action={<span className="text-xs text-muted">엑셀에서 ‘CSV UTF-8’로 저장</span>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Labeled label="대상">
            <SelectField value={table} onChange={(v) => setTable(v as ListTable)} options={Object.fromEntries(Object.entries(TABLES).map(([k, v]) => [k, v.label]))} />
          </Labeled>
          <Labeled label="가져오기 방식">
            <SelectField value={mode} onChange={(v) => setMode(v as 'append' | 'replace')} options={{ append: '기존 데이터에 추가', replace: '기존 데이터를 지우고 교체' }} />
          </Labeled>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => downloadText(`FLP_${TABLES[table].label}_양식.csv`, templateCSV(table))}>양식 내려받기</Button>
          <Button onClick={() => csvRef.current?.click()}>CSV 가져오기</Button>
          <Button variant="ghost" onClick={() => downloadText(`FLP_${TABLES[table].label}_${stamp}.csv`, toCSV(table, data[table] as never))}>CSV 내보내기</Button>
        </div>
        <input ref={csvRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onCSV(f).catch((err) => setMsg(String(err))); e.target.value = ''; }} />
        {msg && <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-sunken p-3 text-xs">{msg}</pre>}
      </Card>

      <Card title="전체 백업·복원">
        <p className="mb-3 text-sm text-muted">기기를 바꾸거나 브라우저 데이터를 지우기 전에 전체 백업(JSON)을 받아 두세요. 프로필·자산·부채·지출·목표·보험과 순자산 추이, 연말결산, 월별 실제 인출 기록이 모두 들어갑니다.</p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={async () => downloadText(`FLP_백업_${stamp}.json`, JSON.stringify(await exportBackup(), null, 2), 'application/json')}>백업 파일 받기</Button>
          <Button variant="ghost" onClick={() => jsonRef.current?.click()}>백업에서 복원</Button>
        </div>
        <input ref={jsonRef} type="file" accept=".json,application/json" hidden onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f || !confirm('현재 데이터를 모두 지우고 백업 내용으로 바꿉니다. 계속할까요?')) return;
          try { await importBackup(JSON.parse(await f.text())); setMsg('백업을 복원했습니다.'); } catch (err) { setMsg(`복원 실패: ${(err as Error).message}`); }
        }} />
      </Card>

      <Card title="샘플·초기화">
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => confirm('현재 데이터를 지우고 샘플 데이터(45세 4인 가구 예시)를 불러올까요?') && loadSample().then(() => setMsg('샘플 데이터를 불러왔습니다.'))}>샘플 데이터 불러오기</Button>
          <Button variant="danger" onClick={() => confirm('모든 데이터를 영구 삭제합니다. 되돌릴 수 없습니다. 계속할까요?') && resetAll().then(() => setMsg('모든 데이터를 삭제했습니다.'))}>모든 데이터 삭제</Button>
        </div>
      </Card>
    </div>
  );
}
