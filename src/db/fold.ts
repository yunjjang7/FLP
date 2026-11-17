import { won } from '../lib/format';
import type { ListTable } from './db';
import { INSURED_WHO, TABLES } from './schema';

/**
 * 기본 정보 목록 카드 접기: 접은 카드 id 를 목록마다 브라우저에 저장(이 브라우저에서만, 계산에는 쓰지 않음).
 * 저장소를 못 쓰면(사생활 보호 창 등) 접기는 되고 새로고침하면 펼친 상태로 돌아감.
 */
const KEY = (table: ListTable) => `flp-folded-${table}`;

/** 저장된 문자열 → 접은 id 목록(숫자만, 잘못된 값은 빈 목록) */
export function parseFolded(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : [];
  } catch {
    return [];
  }
}

export function loadFolded(table: ListTable): number[] {
  try {
    return parseFolded(globalThis.localStorage?.getItem(KEY(table)));
  } catch {
    return [];
  }
}

export function saveFolded(table: ListTable, ids: number[]) {
  try {
    if (ids.length) globalThis.localStorage?.setItem(KEY(table), JSON.stringify(ids));
    else globalThis.localStorage?.removeItem(KEY(table));
  } catch {
    // 저장 못 해도 화면 접기는 그대로
  }
}

/** id 하나 접기·펼치기 */
export const toggleFolded = (ids: number[], id: number) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);

/** 지금 목록에 없는 id(삭제한 카드)는 버림 */
export const pruneFolded = (ids: number[], rows: { id?: number }[]) => ids.filter((id) => rows.some((r) => r.id === id));

/**
 * 접은 카드 머리에 보일 한 줄 요약: 첫 선택 칸(유형·분류 등)의 값과 첫 금액 칸.
 * 이름 칸은 따로 보여 주므로 빼고, 값이 없는 칸은 건너뜀
 */
export function rowSummary(table: ListTable, r: Record<string, unknown>): string {
  const { fields } = TABLES[table];
  const parts: string[] = [];
  const sel = fields.find((f) => f.kind === 'select');
  if (sel) {
    const v = r[sel.key];
    const label = v === undefined || v === null || v === '' ? undefined : sel.options?.[String(v)];
    if (label) parts.push(label);
  }
  const amt = fields.find((f) => f.unit === '만원');
  if (amt) parts.push(won(Number(r[amt.key] ?? 0)));
  return parts.join(' · ');
}

const REPAY_LABEL = { '': '원리금균등', bullet: '만기일시', equal: '원금균등' } as const;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

/**
 * 접은 카드 요약(부채·목표·보험은 그 표에서 중요한 값을 덧붙임):
 * - 부채: 잔액 · 금리 · 상환 방식(만기 미정) · 상환 종료 나이
 * - 목표: 분류 · 필요 금액 · 목표 나이(반복이면 시작~종료 나이 매년)
 * - 보험: 피보험자 · 0이 아닌 보장 · 월 보험료 · 납입 종료 나이(0이면 계속 납입)
 * 그 밖의 표는 rowSummary 그대로
 */
export function cardSummary(table: ListTable, r: Record<string, unknown>): string {
  if (table === 'liabilities') {
    const repay = r.repay === 'bullet' || r.repay === 'equal' ? r.repay : '';
    const end = num(r.endAge);
    return [
      won(num(r.balance)),
      `금리 ${+num(r.rate).toFixed(2)}%`,
      repay === 'bullet' && r.maturity === 'open' ? '만기 미정(이자만)' : REPAY_LABEL[repay],
      end > 0 && r.maturity !== 'open' ? `${end}세 ${repay === 'bullet' ? '만기' : '상환 종료'}` : '',
    ].filter(Boolean).join(' · ');
  }
  if (table === 'goals') {
    const from = num(r.targetAge);
    const to = num(r.endAge);
    const age = from > 0 ? (to > from ? `본인 ${from}~${to}세 매년` : `본인 ${from}세`) : '';
    return [rowSummary(table, r), age].filter(Boolean).join(' · ');
  }
  if (table === 'insurance') {
    const cover = ([['death', '사망'], ['critical', '진단비'], ['care', '간병']] as const)
      .filter(([k]) => num(r[k]) > 0)
      .map(([k, l]) => `${l} ${won(num(r[k]))}`);
    const end = num(r.payEndAge);
    return [
      INSURED_WHO[String(r.insured ?? '')] ?? '본인',
      ...cover,
      num(r.monthlyPremium) > 0 ? `월 ${won(num(r.monthlyPremium))}` : '',
      end > 0 ? `${end}세까지 납입` : '계속 납입',
    ].filter(Boolean).join(' · ');
  }
  return rowSummary(table, r);
}
