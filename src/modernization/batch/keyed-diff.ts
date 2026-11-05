// src/modernization/batch/keyed-diff.ts
// File-in, file-out parity (lesson 30): compare the legacy job's output file with the new
// job's, record by record, matched on the business key and not on line position.

export type Tolerance =
  | { column: string; kind: 'timestamp'; withinMs: number; reason: string }
  | { column: string; kind: 'numeric'; abs: number; reason: string }
  | { column: string; kind: 'text'; fold: Array<'trim' | 'case'>; reason: string };

export interface Contract {
  key: string;
  // The file has no header. Consumers read by position, so this list IS the contract.
  columns: string[];
  // True only when row order is part of what a consumer relies on.
  ordered: boolean;
  tolerances: Tolerance[];
}

export type Finding =
  | { kind: 'shape'; side: 'legacy' | 'new'; line: number; detail: string }
  | { kind: 'duplicate-key'; side: 'legacy' | 'new'; key: string }
  | { kind: 'missing'; key: string }
  | { kind: 'extra'; key: string }
  | { kind: 'field'; key: string; column: string; legacy: string; new: string }
  | { kind: 'order'; position: number; legacy: string; new: string };

export function parseRows(text: string, contract: Contract, side: 'legacy' | 'new', findings: Finding[]): string[][] {
  const rows: string[][] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line === '') return;
    const fields = splitCsvLine(line);
    if (fields.length !== contract.columns.length) {
      findings.push({ kind: 'shape', side, line: i + 1, detail: `${fields.length} fields, contract has ${contract.columns.length}` });
    } else {
      rows.push(fields);
    }
  });
  return rows;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const instant = (s: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z?$/.exec(s.trim());
  if (!m) return null;
  const ms = Number((m[7] ?? '0').padEnd(3, '0').slice(0, 3));
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
};

export function equalUnder(t: Tolerance | undefined, a: string, b: string): boolean {
  if (a === b) return true;
  if (!t) return false;
  if (t.kind === 'timestamp') {
    const x = instant(a), y = instant(b);
    return x !== null && y !== null && Math.abs(x - y) <= t.withinMs;
  }
  if (t.kind === 'numeric') {
    const x = Number(a), y = Number(b);
    return a.trim() !== '' && b.trim() !== '' && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= t.abs;
  }
  const fold = (s: string) => {
    let r = s;
    if (t.fold.includes('trim')) r = r.trim();
    if (t.fold.includes('case')) r = r.toLowerCase();
    return r;
  };
  return fold(a) === fold(b);
}

export function diffFiles(legacyText: string, newText: string, contract: Contract): Finding[] {
  const findings: Finding[] = [];
  const legacyRows = parseRows(legacyText, contract, 'legacy', findings);
  const newRows = parseRows(newText, contract, 'new', findings);
  const keyAt = contract.columns.indexOf(contract.key);
  const tolerance = new Map(contract.tolerances.map((t) => [t.column, t]));

  const index = (rows: string[][], side: 'legacy' | 'new') => {
    const byKey = new Map<string, string[]>();
    for (const r of rows) {
      if (byKey.has(r[keyAt])) findings.push({ kind: 'duplicate-key', side, key: r[keyAt] });
      else byKey.set(r[keyAt], r);
    }
    return byKey;
  };
  const legacyByKey = index(legacyRows, 'legacy');
  const newByKey = index(newRows, 'new');

  for (const [key, l] of legacyByKey) {
    const n = newByKey.get(key);
    if (!n) { findings.push({ kind: 'missing', key }); continue; }
    contract.columns.forEach((column, c) => {
      if (!equalUnder(tolerance.get(column), l[c], n[c])) findings.push({ kind: 'field', key, column, legacy: l[c], new: n[c] });
    });
  }
  for (const key of newByKey.keys()) if (!legacyByKey.has(key)) findings.push({ kind: 'extra', key });

  if (contract.ordered) {
    const a = [...legacyByKey.keys()], b = [...newByKey.keys()];
    const at = a.findIndex((k, i) => k !== b[i]);
    if (at >= 0 && a.length === b.length) findings.push({ kind: 'order', position: at + 1, legacy: a[at], new: b[at] });
  }
  return findings;
}

export function describe(f: Finding): string {
  switch (f.kind) {
    case 'shape': return `${f.side} line ${f.line}: ${f.detail}`;
    case 'duplicate-key': return `${f.side}: key ${f.key} appears twice`;
    case 'missing': return `missing from new: ${f.key}`;
    case 'extra': return `extra in new: ${f.key}`;
    case 'field': return `${f.key} ${f.column}: legacy=${f.legacy} new=${f.new}`;
    case 'order': return `row ${f.position}: legacy has ${f.legacy}, new has ${f.new}`;
  }
}
