import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { spouseGap } from '../engine/goals';
import { runStress, type StressResult } from '../engine/stress';
import { parseSurvivorSettings, survivorCases, survivorWorst, type SurvivorCase, type SurvivorSettings } from '../engine/survivor';
import type { PlanInput } from '../engine/montecarlo';
import { useFlp } from './FlpContext';

export type SurvivorResult = StressResult & { plain?: number };

// 사별 분석 설정: 노후 진단 카드에서 바꾼 값을 이 브라우저에 저장하고, 요약보고·보험 탭도 같은 값을 씀
const KEY = 'flp.survivorSettings';
let settings: SurvivorSettings = (() => {
  try {
    return parseSurvivorSettings(localStorage.getItem(KEY));
  } catch {
    return parseSurvivorSettings(null);
  }
})();
const subs = new Set<() => void>();

export function setSurvivorSettings(next: Partial<SurvivorSettings>) {
  settings = parseSurvivorSettings(JSON.stringify({ ...settings, ...next }));
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* 저장이 막힌 브라우저에서는 이번 방문 동안만 유지 */
  }
  subs.forEach((f) => f());
}

export function useSurvivorSettings(): SurvivorSettings {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => settings,
  );
}

// 같은 계획(planInput 객체)·같은 설정이면 화면을 옮겨도 다시 돌리지 않음
const cache = new WeakMap<PlanInput, Map<string, SurvivorResult[]>>();

/**
 * 배우자 사별 분석 계산(노후 진단 카드·요약보고·보험 탭 공통).
 * 경우마다 1,000회 시뮬레이션이라 하나씩 나눠 계산하고, 사망보장이 있으면 보험금 없이 한 번 더 돌림
 */
export function useSurvivor() {
  const { living, rate } = useSurvivorSettings();
  const { planInput: inp, retax, profile: p, insurance } = useFlp();
  const hasSpouse = p.spouseBirthYear > 0;
  const benefits = useMemo(
    () => ({
      self: insurance.filter((x) => (x.insured ?? 'self') === 'self').reduce((a, x) => a + (x.death ?? 0), 0),
      spouse: insurance.filter((x) => x.insured === 'spouse').reduce((a, x) => a + (x.death ?? 0), 0),
    }),
    [insurance],
  );
  const gap = spouseGap(p);
  const cases: SurvivorCase[] = useMemo(
    () => (hasSpouse ? survivorCases(inp, { livingRatio: living, rate, spouseGap: gap }, benefits).map((c) => ({ ...c, input: retax(c.input), ...(c.noBenefit ? { noBenefit: retax(c.noBenefit) } : {}) })) : []),
    [inp, retax, gap, living, rate, benefits, hasSpouse],
  );
  const key = `${living}|${rate}|${benefits.self}|${benefits.spouse}|${gap}|${hasSpouse}`;
  // 결과에 어떤 계획·설정으로 계산했는지 함께 둬, 입력이 바뀐 직후 지난 결과가 섞이지 않게 함
  const [state, setState] = useState<{ inp: PlanInput; key: string; rows: SurvivorResult[] }>(() => ({ inp, key, rows: cache.get(inp)?.get(key) ?? [] }));

  useEffect(() => {
    const hit = cache.get(inp)?.get(key);
    if (hit) {
      setState({ inp, key, rows: hit });
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const done: SurvivorResult[] = [];
    setState({ inp, key, rows: [] });
    const step = (i: number) => {
      if (cancelled) return;
      if (i >= cases.length) {
        if (!cache.has(inp)) cache.set(inp, new Map());
        cache.get(inp)!.set(key, done);
        return;
      }
      const c = cases[i];
      const r = runStress(c);
      done.push(c.noBenefit ? { ...r, plain: runStress({ ...c, input: c.noBenefit }).successRate } : r);
      setState({ inp, key, rows: [...done] });
      timer = setTimeout(() => step(i + 1), 0);
    };
    timer = setTimeout(() => step(0), 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cases]);

  const rows = useMemo(() => (state.inp === inp && state.key === key ? state.rows : cache.get(inp)?.get(key) ?? []), [state, inp, key]);
  const ready = rows.length === cases.length;
  const worst = useMemo(() => survivorWorst(cases, rows), [cases, rows]);
  return { hasSpouse, cases, rows, ready, worst, benefits, living, rate };
}
