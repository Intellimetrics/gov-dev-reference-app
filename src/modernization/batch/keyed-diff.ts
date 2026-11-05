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
  // How a field holding a comma, a quote or a line break is written. The reader accepts RFC 4180
  // quoting only; this records what the renderer does and whether the legacy job is known to match.
  quoting?: { rule: 'rfc4180-minimal'; status: string };
  tolerances: Tolerance[];
}

export type Finding =
  | { kind: 'malformed'; side: 'legacy' | 'new'; line: number; detail: string }
  | { kind: 'shape'; side: 'legacy' | 'new'; line: number; detail: string }
  | { kind: 'duplicate-key'; side: 'legacy' | 'new'; key: string }
  | { kind: 'missing'; key: string }
  | { kind: 'extra'; key: string }
  | { kind: 'field'; key: string; column: string; legacy: string; new: string }
  | { kind: 'order'; position: number; legacy: string; new: string };

export interface CsvRecord { line: number; fields: string[] }

// RFC 4180-style records: fields separated by commas, records by CRLF or LF. A field that
// starts with a double quote may hold commas, line breaks and "" (one literal quote). Anything
// else the RFC does not allow is reported as malformed, never repaired: an unclosed quote, a
// quote inside an unquoted field, text after a closing quote. `line` is where a record starts.
export function parseCsv(text: string): { records: CsvRecord[]; malformed?: { line: number; detail: string } } {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let cur = '';
  let line = 1;
  let start = 1;
  let state: 'start' | 'plain' | 'quoted' | 'after' = 'start';
  let sawQuote = false;
  const endRecord = () => {
    fields.push(cur);
    if (!(fields.length === 1 && fields[0] === '' && !sawQuote)) records.push({ line: start, fields });
    fields = []; cur = ''; sawQuote = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (state === 'quoted') {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') state = 'after';
      else { if (c === '\n') line++; cur += c; }
      continue;
    }
    if (c === '\r' && text[i + 1] === '\n') continue;
    if (c === '\n') { endRecord(); line++; start = line; state = 'start'; continue; }
    if (c === ',') { fields.push(cur); cur = ''; state = 'start'; continue; }
    if (state === 'after') return { records, malformed: { line, detail: `text after the closing quote of a field (record starting at line ${start})` } };
    if (c === '"') {
      if (state !== 'start') return { records, malformed: { line, detail: `quote inside an unquoted field (record starting at line ${start})` } };
      state = 'quoted'; sawQuote = true; continue;
    }
    cur += c; state = 'plain';
  }
  if (state === 'quoted') return { records, malformed: { line: start, detail: 'unclosed quote: the file ends inside a quoted field' } };
  if (state !== 'start' || fields.length > 0 || cur !== '') endRecord();
  return { records };
}

// A record with the wrong field count is one `shape` finding; its key (when it has one) is
// remembered so the comparison does not also report that key as missing or extra.
export function parseRows(text: string, contract: Contract, side: 'legacy' | 'new', findings: Finding[]): { rows: string[][]; badKeys: Set<string>; malformed: boolean } {
  const keyAt = contract.columns.indexOf(contract.key);
  const rows: string[][] = [];
  const badKeys = new Set<string>();
  const { records, malformed } = parseCsv(text);
  for (const r of records) {
    if (r.fields.length !== contract.columns.length) {
      findings.push({ kind: 'shape', side, line: r.line, detail: `${r.fields.length} fields, contract has ${contract.columns.length}` });
      if (keyAt < r.fields.length) badKeys.add(r.fields[keyAt]);
    } else {
      rows.push(r.fields);
    }
  }
  if (malformed) findings.push({ kind: 'malformed', side, line: malformed.line, detail: malformed.detail });
  return { rows, badKeys, malformed: !!malformed };
}

export function validateContract(contract: Contract): void {
  if (!contract.columns.includes(contract.key)) throw new Error(`contract key ${contract.key} is not one of its columns`);
  for (const t of contract.tolerances) {
    if (!contract.columns.includes(t.column)) throw new Error(`tolerance names column ${t.column}, which is not in the contract`);
  }
}

// A real instant or nothing: month 13 or February 30 must not roll over into a valid date.
const instant = (s: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z?$/.exec(s.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, se] = [+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]];
  const ms = Number((m[7] ?? '0').padEnd(3, '0').slice(0, 3));
  const t = Date.UTC(y, mo - 1, d, h, mi, se, ms);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59 || se > 59) return null;
  return t;
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
  validateContract(contract);
  const findings: Finding[] = [];
  const legacy = parseRows(legacyText, contract, 'legacy', findings);
  const next = parseRows(newText, contract, 'new', findings);
  // A file that stops being readable has no complete record set to compare: report that alone.
  if (legacy.malformed || next.malformed) return findings;
  const keyAt = contract.columns.indexOf(contract.key);
  const tolerance = new Map(contract.tolerances.map((t) => [t.column, t]));
  const badKeys = new Set([...legacy.badKeys, ...next.badKeys]);

  const index = (rows: string[][], side: 'legacy' | 'new') => {
    const byKey = new Map<string, string[]>();
    for (const r of rows) {
      if (byKey.has(r[keyAt])) findings.push({ kind: 'duplicate-key', side, key: r[keyAt] });
      else byKey.set(r[keyAt], r);
    }
    return byKey;
  };
  const legacyByKey = index(legacy.rows, 'legacy');
  const newByKey = index(next.rows, 'new');

  for (const [key, l] of legacyByKey) {
    const n = newByKey.get(key);
    if (!n) { if (!badKeys.has(key)) findings.push({ kind: 'missing', key }); continue; }
    contract.columns.forEach((column, c) => {
      if (!equalUnder(tolerance.get(column), l[c], n[c])) findings.push({ kind: 'field', key, column, legacy: l[c], new: n[c] });
    });
  }
  for (const key of newByKey.keys()) if (!legacyByKey.has(key) && !badKeys.has(key)) findings.push({ kind: 'extra', key });

  if (contract.ordered) {
    // Order of the keys both files hold; a missing or extra key is already its own finding.
    const a = [...legacyByKey.keys()].filter((k) => newByKey.has(k));
    const b = [...newByKey.keys()].filter((k) => legacyByKey.has(k));
    const at = a.findIndex((k, i) => k !== b[i]);
    if (at >= 0) findings.push({ kind: 'order', position: at + 1, legacy: a[at], new: b[at] });
  }
  return findings;
}

export function describe(f: Finding): string {
  switch (f.kind) {
    case 'malformed': return `${f.side} line ${f.line}: malformed file, ${f.detail}`;
    case 'shape': return `${f.side} line ${f.line}: ${f.detail}`;
    case 'duplicate-key': return `${f.side}: key ${f.key} appears twice`;
    case 'missing': return `missing from new: ${f.key}`;
    case 'extra': return `extra in new: ${f.key}`;
    case 'field': return `${f.key} ${f.column}: legacy=${f.legacy} new=${f.new}`;
    case 'order': return `row ${f.position}: legacy has ${f.legacy}, new has ${f.new}`;
  }
}
