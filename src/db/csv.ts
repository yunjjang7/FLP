import Papa from 'papaparse';
import { parseMonth } from '../engine/drawLog';
import { ASSET_TYPES } from '../engine/portfolio';
import type { Draw } from '../types';
import type { ListTable } from './db';
import { ORDER_FIELD, TABLES, type FieldDef } from './schema';

/** 1~12만 받는 노란우산 열(마지막 해 납입 개월·가입 월·수령 월) */
const MONTH_KEYS = ['yuLastMonths', 'yuJoinMonth', 'yuPayoutMonth'];

type Row = Record<string, unknown>;

/** 레코드 배열 → CSV 문자열(한글 헤더, 선택값은 한글 라벨) */
const extras = (table: ListTable) => [...(TABLES[table].csvExtra ?? []), ORDER_FIELD];
const allFields = (table: ListTable) => [...TABLES[table].fields, ...extras(table)];
/** 노란우산공제로 표시한 행(값이 true 또는 CSV 의 ‘예’) */
const yuRow = (r: Row) => r.yu === true || r.yu === 'true' || r.yu === '예';
/** 부동산·연금 계좌·노란우산 전용 열인데 그 유형이 아닌 행 */
const notFor = (f: FieldDef, r: Row) =>
  (f.reOnly && r.type !== 'realestate') || (f.penOnly && r.type !== 'pension') || (f.yuOnly && !yuRow(r)) || (f.penOrYu && r.type !== 'pension' && !yuRow(r));

/** 레코드 배열 → CSV 문자열(한글 헤더, 선택값은 한글 라벨). 선택 열은 값이 없거나 부동산 전용인데 부동산이 아니면 빈칸 */
export function toCSV(table: ListTable, rows: Row[]) {
  const fields = allFields(table);
  const cell = (r: Row, f: FieldDef) => {
    const v = r[f.key];
    if (notFor(f, r) || v === undefined || v === null) return '';
    return f.kind === 'select' ? f.options?.[String(v)] ?? v : v;
  };
  return Papa.unparse({ fields: fields.map((f) => f.label), data: rows.map((r) => fields.map((f) => cell(r, f))) });
}

export function templateCSV(table: ListTable) {
  return toCSV(table, TABLES[table].csvExamples ?? [TABLES[table].example]);
}

const num = (v: unknown) => {
  const n = Number(String(v ?? '').replace(/[,\s원만%]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** CSV 문자열 → 레코드 배열. 헤더는 한글 라벨 또는 영문 키 모두 허용 */
export function fromCSV(table: ListTable, text: string): { rows: Row[]; errors: string[] } {
  const { fields } = TABLES[table];
  const parsed = Papa.parse<Row>(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: true });
  const errors = parsed.errors.map((e) => `${(e.row ?? 0) + 2}행: ${e.message}`);
  const rows: Row[] = [];
  parsed.data.forEach((raw, i) => {
    const rec: Row = {};
    for (const f of fields) {
      const v = raw[f.label] ?? raw[f.key];
      if (f.kind === 'number') rec[f.key] = num(v);
      else if (f.kind === 'select') {
        const s = String(v ?? '').trim();
        const code = Object.entries(f.options ?? {}).find(([k, lbl]) => k === s || lbl === s)?.[0];
        if (!s) rec[f.key] = undefined; // 비어 있으면 아래에서 기본값
        else if (!code) {
          errors.push(`${i + 2}행: '${f.label}' 값 '${s}'을(를) 알 수 없습니다.`);
          rec[f.key] = Object.keys(f.options ?? {})[0];
        } else rec[f.key] = code;
      } else rec[f.key] = String(v ?? '').trim();
    }
    // 선택 열: 빈칸이면 값 없음, 부동산·연금·노란우산 전용 열은 그 행에서만 읽음
    const yuCell = String(raw['노란우산공제'] ?? raw.yu ?? '').trim();
    const kind = { type: rec.type, yu: yuCell === '예' || yuCell === 'true' };
    for (const f of extras(table)) {
      const s = String(raw[f.label] ?? raw[f.key] ?? '').trim();
      if (!s || notFor(f, kind)) continue;
      if (f.kind === 'number') rec[f.key] = num(s);
      else if (f.kind === 'text') rec[f.key] = s;
      else {
        const code = Object.entries(f.options ?? {}).find(([k, lbl]) => k === s || lbl === s)?.[0];
        if (code) rec[f.key] = code;
        else errors.push(`${i + 2}행: '${f.label}' 값 '${s}'을(를) 알 수 없습니다.`);
      }
    }
    if (table === 'assets') {
      if (rec.owner === 'joint' && rec.type !== 'realestate') {
        errors.push(`${i + 2}행: 공동명의는 부동산만 쓸 수 있어 본인 명의로 넣었습니다.`);
        rec.owner = 'self';
      }
      if (rec.type === 'realestate') rec.reUse ??= 'home';
      if (rec.yu === 'true') rec.yu = true;
      if (rec.yu && (rec.type === 'pension' || rec.type === 'realestate')) delete rec.yu;
      // 노란우산 월·개월 수 열은 1~12 정수만(그 밖은 빈칸으로 읽음)
      for (const f of extras(table).filter((x) => MONTH_KEYS.includes(x.key))) {
        const v = rec[f.key];
        if (v === undefined || (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 12)) continue;
        errors.push(`${i + 2}행: '${f.label}'은(는) 1~12만 넣을 수 있어 비워 두었습니다.`);
        delete rec[f.key];
      }
    }
    if (!rec.name) {
      errors.push(`${i + 2}행: 이름이 비어 있어 건너뜁니다.`);
      return;
    }
    // 자산의 용도·성격·수익률·변동성이 비어 있으면 유형 기본값
    if (table === 'assets') {
      rec.type ??= 'other';
      const def = ASSET_TYPES[rec.type as keyof typeof ASSET_TYPES];
      rec.purpose ??= def.purpose;
      rec.nature ??= def.nature;
      if (raw['기대수익률'] === undefined && raw.expectedReturn === undefined) rec.expectedReturn = def.ret;
      if (raw['변동성'] === undefined && raw.volatility === undefined) rec.volatility = def.vol;
    }
    for (const f of fields) if (f.kind === 'select') rec[f.key] ??= Object.keys(f.options ?? {})[0];
    rows.push(rec);
  });
  return { rows, errors };
}

export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8') {
  // 엑셀 한글 깨짐 방지용 BOM
  const blob = new Blob([mime.startsWith('text/csv') ? '﻿' + text : text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const DRAW_HEAD = { month: '월', account: '계좌', amount: '세전 인출액', note: '메모' } as const;

/** 월별 실제 인출 기록 → CSV(월·계좌 순) */
export function drawsToCSV(rows: Draw[]) {
  const sorted = rows.slice().sort((a, b) => a.month.localeCompare(b.month) || a.account.localeCompare(b.account, 'ko'));
  return Papa.unparse({ fields: Object.values(DRAW_HEAD), data: sorted.map((r) => [r.month, r.account, r.amount, r.note ?? '']) });
}

/** 인출 기록 CSV 양식: 지금 계획의 계좌 이름으로 예시 한 달 */
export function drawsTemplateCSV(month: string, accounts: string[]) {
  return drawsToCSV(accounts.map((account, i) => ({ month, account, amount: i === 0 ? 100 : 0, note: i === 0 ? '예시: 지우고 쓰세요' : '' })));
}

/** CSV → 월별 실제 인출 기록. 같은 달·계좌가 여러 줄이면 더함. 금액이 0인 줄은 건너뜀 */
export function drawsFromCSV(text: string): { rows: Draw[]; errors: string[] } {
  const parsed = Papa.parse<Row>(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: true });
  const errors = parsed.errors.map((e) => `${(e.row ?? 0) + 2}행: ${e.message}`);
  const map = new Map<string, Draw>();
  parsed.data.forEach((raw, i) => {
    const get = (k: keyof typeof DRAW_HEAD) => raw[DRAW_HEAD[k]] ?? raw[k] ?? (k === 'amount' ? raw['금액'] : undefined);
    const account = String(get('account') ?? '').trim();
    const month = parseMonth(get('month'));
    const amount = num(get('amount'));
    if (!account && !String(get('month') ?? '').trim()) return;
    if (!month) return void errors.push(`${i + 2}행: '월' 값 '${String(get('month') ?? '')}'을(를) 알 수 없습니다(예: 2026-11).`);
    if (!account) return void errors.push(`${i + 2}행: 계좌가 비어 있어 건너뜁니다.`);
    if (amount < 0) return void errors.push(`${i + 2}행: 금액이 음수라 건너뜁니다.`);
    if (amount === 0) return;
    const note = String(get('note') ?? '').trim();
    const key = `${month}|${account}`;
    const prev = map.get(key);
    map.set(key, { month, account, amount: (prev?.amount ?? 0) + amount, ...(note || prev?.note ? { note: [prev?.note, note].filter(Boolean).join(' / ') } : {}) });
  });
  return { rows: [...map.values()], errors };
}
