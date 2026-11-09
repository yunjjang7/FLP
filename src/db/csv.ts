import Papa from 'papaparse';
import { ASSET_TYPES } from '../engine/portfolio';
import type { ListTable } from './db';
import { TABLES } from './schema';

type Row = Record<string, unknown>;

/** 레코드 배열 → CSV 문자열(한글 헤더, 선택값은 한글 라벨) */
export function toCSV(table: ListTable, rows: Row[]) {
  const { fields } = TABLES[table];
  const data = rows.map((r) =>
    Object.fromEntries(fields.map((f) => [f.label, f.kind === 'select' ? f.options?.[String(r[f.key])] ?? r[f.key] : r[f.key]])),
  );
  return Papa.unparse({ fields: fields.map((f) => f.label), data: data.map((d) => fields.map((f) => d[f.label])) });
}

export function templateCSV(table: ListTable) {
  return toCSV(table, [TABLES[table].example]);
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
