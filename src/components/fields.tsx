import { useEffect, useState } from 'react';

const base = 'w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-soft';

/** 숫자 입력: 입력 중에는 문자열을 유지하고, 유효한 숫자일 때만 반영 */
export function NumberField({ value, onChange, step = 1, unit, min }: { value: number; onChange: (v: number) => void; step?: number; unit?: string; min?: number }) {
  const [text, setText] = useState(String(value ?? 0));
  useEffect(() => {
    if (Number(text) !== value) setText(String(value ?? 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <div className="relative">
      <input
        className={`${base} ${unit ? 'pr-10' : ''} text-right`}
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(n)) onChange(n);
        }}
        // 커서가 있을 때 마우스 휠로 값이 바뀌지 않게: 휠을 굴리면 포커스를 빼서 페이지만 스크롤
        onWheel={(e) => {
          if (document.activeElement === e.currentTarget) e.currentTarget.blur();
        }}
        onBlur={() => {
          if (text === '' || !Number.isFinite(Number(text))) setText(String(value ?? 0));
        }}
      />
      {unit && <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-muted">{unit}</span>}
    </div>
  );
}

/** 텍스트 입력: 입력 중엔 로컬 상태만 바꾸고 포커스를 벗어날 때 저장 */
export function TextField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      className={base}
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onChange(text)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

export function SelectField({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: Record<string, string> }) {
  return (
    <select className={base} value={value} onChange={(e) => onChange(e.target.value)}>
      {Object.entries(options).map(([k, l]) => (
        <option key={k} value={k}>
          {l}
        </option>
      ))}
    </select>
  );
}

export function Labeled({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block truncate text-xs font-medium text-muted" title={label}>{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

export function Slider({ label, value, min, max, step, onChange, display }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; display: string }) {
  return (
    <label className="block">
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="text-muted">{label}</span>
        <span className="font-semibold">{display}</span>
      </div>
      <input type="range" className="w-full accent-[var(--c-brand)]" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}
