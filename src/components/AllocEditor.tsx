import { useState } from 'react';
import { db } from '../db/db';
import {
  ASSET_CLASSES,
  allocOf,
  allocReturn,
  allocSum,
  CLASS_DEFAULTS,
  CLASS_HINT,
  CLASS_LABEL,
  defaultClass,
  hasAlloc,
  IRP_RISK_CAP,
  isCappedAsset,
  natureOfAlloc,
  normalizeAlloc,
  riskPct,
} from '../engine/allocation';
import { NATURE_LABEL } from '../engine/portfolio';
import { pct } from '../lib/format';
import type { Alloc, AssetClass, Asset } from '../types';
import { Labeled, NumberField } from './fields';

const link = 'font-semibold text-brand hover:underline';

/**
 * 자산 탭: 계좌 안 자산배분(주식형·채권형·대체자산·현금성 %) 입력.
 * 비율을 넣으면 성격은 비율로 자동(위험자산 50% 이상이면 투자형)이고, 투자형 비중·리밸런싱은 위험자산 몫만 투자형으로 셈.
 * ‘배분으로 계산’은 자산군 가정값으로 기대수익률·변동성을 다시 넣음(누를 때만).
 */
export function AllocEditor({ a, assets }: { a: Asset; assets: Asset[] }) {
  const on = hasAlloc(a);
  const [open, setOpen] = useState(on);
  if (a.id === undefined) return null;
  const id = a.id;
  const save = (patch: Partial<Asset>) => void db.assets.update(id, patch);

  if (!open && !on) {
    return (
      <button type="button" className="mt-2 mr-4 text-xs font-medium text-brand hover:underline" onClick={() => setOpen(true)}>
        + 자산배분 비율(주식형·채권형·대체·현금성)
      </button>
    );
  }

  // 처음 열 때는 지금 성격대로 한 자산군 100%로 채워 둠
  const raw: Alloc = on ? { equity: 0, bond: 0, alt: 0, cash: 0, ...a.alloc } as Alloc : allocOf(a);
  const total = allocSum(raw);
  const norm = normalizeAlloc(raw);
  const setClass = (k: AssetClass, v: number) => {
    const next = { ...raw, [k]: Math.max(0, Math.min(100, v)) } as Alloc;
    const n = normalizeAlloc(next);
    // 성격은 비율로 자동(합계가 100이 아니어도 비례로 판단)
    save({ alloc: next, ...(n ? { nature: natureOfAlloc(n) } : {}) });
  };
  const risk = norm ? riskPct(norm) : 0;
  const capped = isCappedAsset(a);
  const calc = norm ? allocReturn(norm) : undefined;
  const differs = calc && (Math.abs(calc.ret - a.expectedReturn) > 0.05 || Math.abs(calc.vol - a.volatility) > 0.05);
  const others = assets.filter((x) => x.id !== a.id && hasAlloc(x)).length;

  return (
    <div className="mt-3 rounded-xl bg-sunken p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-xs font-semibold">자산배분 비율 <span className="font-normal text-muted">· 이 계좌 안에서 담은 비중(%)</span></div>
        <button
          type="button"
          className="text-xs font-medium text-muted hover:text-bad hover:underline"
          onClick={() => {
            setOpen(false);
            save({ alloc: undefined, nature: on && norm ? natureOfAlloc(norm) : a.nature });
          }}
        >
          비율 지우기
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {ASSET_CLASSES.map((k) => (
          <Labeled key={k} label={`${CLASS_LABEL[k]}(%)`} hint={CLASS_HINT[k]}>
            <NumberField value={Number(raw[k] ?? 0)} min={0} step={1} onChange={(v) => setClass(k, v)} />
          </Labeled>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span>
          합계 <b className={Math.abs(total - 100) > 0.05 ? 'text-warn' : 'text-ink'}>{pct(total)}</b>
          {Math.abs(total - 100) > 0.05 && total > 0 && (
            <>
              {' '}· 계산은 합계를 100으로 보고 비례로 나눔{' '}
              <button type="button" className={link} onClick={() => norm && save({ alloc: norm })}>100으로 맞추기</button>
            </>
          )}
        </span>
        {norm && (
          <span>
            위험자산(주식형+대체) <b className="text-ink">{pct(risk)}</b> → 성격 <b className="text-ink">{NATURE_LABEL[natureOfAlloc(norm)]}</b>(자동) · 투자형 비중에는 금액의 {pct(risk)}만 셈
          </span>
        )}
      </div>
      {capped && risk > IRP_RISK_CAP * 100 + 0.05 && (
        <p role="alert" className="mt-2 rounded-lg bg-warn-soft px-2 py-1 text-xs text-warn">
          퇴직연금(IRP·DC)은 위험자산을 평가액의 {IRP_RISK_CAP * 100}%까지만 담을 수 있습니다. 지금 {pct(risk)}라 {pct(risk - IRP_RISK_CAP * 100)}p 넘습니다(TDF·채권혼합형 등 안전자산으로 인정되는 상품은 채권형으로 넣으세요).
        </p>
      )}
      {calc && (
        <p className="mt-2 text-xs text-muted">
          자산군 가정(주식형 {CLASS_DEFAULTS.equity.ret}%·{CLASS_DEFAULTS.equity.vol} · 채권형 {CLASS_DEFAULTS.bond.ret}%·{CLASS_DEFAULTS.bond.vol} · 대체 {CLASS_DEFAULTS.alt.ret}%·{CLASS_DEFAULTS.alt.vol} · 현금성 {CLASS_DEFAULTS.cash.ret}%·{CLASS_DEFAULTS.cash.vol})으로 계산하면 기대수익률 <b className="text-ink">{calc.ret}%</b> · 변동성 <b className="text-ink">{calc.vol}%</b>
          {differs ? (
            <>
              {' '}(지금 {a.expectedReturn}% · {a.volatility}%).{' '}
              <button type="button" className={link} onClick={() => save({ expectedReturn: calc.ret, volatility: calc.vol })}>배분으로 계산한 값 넣기</button>
            </>
          ) : (
            <> — 지금 값과 같습니다.</>
          )}
          {' '}변동성은 자산군끼리 섞일 때 줄어드는 효과를 빼고 단순 가중평균해 실제보다 약간 큽니다.
        </p>
      )}
      {!on && <p className="mt-2 text-xs text-muted">지금 성격({NATURE_LABEL[a.nature]})대로 {CLASS_LABEL[defaultClass(a)]} 100%로 채워 두었습니다. 칸을 고치면 저장됩니다.{others > 0 ? '' : ' 비율을 넣으면 투자 점검·리밸런싱·인출 바구니가 이 계좌의 실제 배분을 씁니다.'}</p>}
    </div>
  );
}
