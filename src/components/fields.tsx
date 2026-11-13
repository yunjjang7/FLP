import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const base = 'w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-soft';

/** 입력 문자열에 천 단위 콤마: "-1234567.5" → "-1,234,567.5" (입력 중인 "12." 같은 꼴은 그대로 둠) */
export function groupDigits(raw: string): string {
  const m = /^(-?)(\d*)(\.\d*)?$/.exec(raw);
  if (!m) return raw;
  return m[1] + m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (m[3] ?? '');
}

/**
 * 숫자 입력: 입력 중에는 문자열을 유지하고, 유효한 숫자일 때만 반영.
 * 천 단위 콤마를 붙여 보여 준다(연도처럼 콤마가 어색한 칸은 plain, 단위가 ‘년’이면 자동).
 */
export function NumberField({ value, onChange, step = 1, unit, min, plain }: { value: number; onChange: (v: number) => void; step?: number; unit?: string; min?: number; plain?: boolean }) {
  const noGroup = plain ?? unit === '년';
  const fmt = (raw: string) => (noGroup ? raw : groupDigits(raw));
  const [text, setText] = useState(fmt(String(value ?? 0)));
  const ref = useRef<HTMLInputElement>(null);
  /** 콤마를 다시 붙인 뒤 커서를 ‘앞쪽 숫자 개수’가 같은 자리로 되돌림 */
  const caret = useRef<number | null>(null);
  // 글자가 그대로여도(콤마 지우기·허용 안 되는 글자) 커서를 되돌리도록 다시 그리게 함
  const [tick, setTick] = useState(0);
  const num = (t: string) => Number(t.replace(/,/g, ''));
  useEffect(() => {
    if (num(text) !== value) setText(fmt(String(value ?? 0)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (caret.current == null || !el || document.activeElement !== el) return;
    let seen = 0;
    let pos = 0;
    while (pos < text.length && seen < caret.current) {
      if (text[pos] !== ',') seen++;
      pos++;
    }
    el.setSelectionRange(pos, pos);
    caret.current = null;
  }, [text, tick]);
  return (
    <div className="relative">
      <input
        ref={ref}
        className={`${base} ${unit ? 'pr-10' : ''} text-right`}
        type="text"
        inputMode="decimal"
        data-step={step}
        data-min={min}
        value={text}
        onChange={(e) => {
          const el = e.target;
          const strip = (t: string) => t.replace(/[,\s]/g, '');
          let raw = strip(el.value);
          let before = strip(el.value.slice(0, el.selectionStart ?? el.value.length)).length;
          // 숫자·소수점·앞의 마이너스만 받음(다른 글자는 무시하고 커서만 제자리)
          if (!/^-?\d*\.?\d*$/.test(raw)) {
            caret.current = Math.max(0, before - 1);
            setTick((t) => t + 1);
            return;
          }
          // 콤마만 지운 경우: 백스페이스면 콤마 앞 숫자, Delete 면 콤마 뒤 숫자를 지움
          if (raw === strip(text) && el.value.length < text.length) {
            const fwd = (e.nativeEvent as InputEvent).inputType === 'deleteContentForward';
            const at = fwd ? before : before - 1;
            if (at >= 0 && at < raw.length) {
              raw = raw.slice(0, at) + raw.slice(at + 1);
              if (!fwd) before = at;
            }
          }
          caret.current = before;
          setText(fmt(raw));
          setTick((t) => t + 1);
          const n = Number(raw);
          if (raw !== '' && raw !== '-' && raw !== '.' && Number.isFinite(n)) onChange(n);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') return e.currentTarget.blur();
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          // ↑/↓: 칸의 step 만큼 증감(type="number" 시절 동작 복원), 커서는 ‘뒤쪽 숫자 개수’ 기준으로 유지
          e.preventDefault();
          const el = e.currentTarget;
          const cur = num(text);
          const n0 = text === '' || !Number.isFinite(cur) ? (value ?? 0) : cur;
          const dec = (x: number) => (String(x).split('.')[1] ?? '').length;
          let n = Number((n0 + (e.key === 'ArrowUp' ? step : -step)).toFixed(Math.max(dec(step), dec(n0))));
          if (min != null && n < min) n = min;
          const raw = String(n);
          const after = el.value.slice(el.selectionEnd ?? el.value.length).replace(/,/g, '').length;
          caret.current = Math.max(0, raw.length - after);
          setText(fmt(raw));
          setTick((t) => t + 1);
          if (n !== value) onChange(n);
        }}
        onBlur={() => {
          const n = num(text);
          if (text === '' || text === '-' || text === '.' || !Number.isFinite(n)) setText(fmt(String(value ?? 0)));
          else setText(fmt(String(n)));
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
    <label data-field={label} className="block min-w-0">
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
