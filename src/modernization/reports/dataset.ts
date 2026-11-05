// Dataset equivalence for a rebuilt report: run both queries, turn every column into text by its exact type,
// and compare the two result sets as multisets.
import sql from 'mssql';

export interface Column { name: string; type: string }
export type Row = Array<string | null>;
export type Params = Record<string, { type: sql.ISqlType | (() => sql.ISqlType); value: unknown }>;

// Same conversion styles as lesson 24's verify-intact: money style 2, date and time style 121, float style 3.
const AS_TEXT: Record<string, number> = {
  binary: 1, varbinary: 1, timestamp: 1, rowversion: 1,
  date: 121, time: 121, datetime: 121, datetime2: 121, smalldatetime: 121, datetimeoffset: 121,
  float: 3, real: 3,
  money: 2, smallmoney: 2,
};
const AS_IS = new Set(['bigint', 'int', 'smallint', 'tinyint', 'bit', 'decimal', 'numeric', 'char', 'varchar',
  'nchar', 'nvarchar', 'uniqueidentifier', 'xml']);

export function asText(c: Column): string {
  const col = `[${c.name}]`;
  const style = AS_TEXT[c.type];
  if (style === 1) return `CONVERT(varchar(max), CAST(${col} AS varbinary(max)), 1)`;
  if (style !== undefined) return `CONVERT(varchar(60), ${col}, ${style})`;
  if (AS_IS.has(c.type)) return `CAST(${col} AS nvarchar(max))`;
  throw new Error(`${c.name}: type ${c.type} has no lossless text form here; add one and a test before trusting a match`);
}

// The dataset's own query becomes a derived table, so the report's SQL runs unchanged and every column leaves as text.
export function normalizedQuery(query: string, cols: Column[]): string {
  return `SELECT ${cols.map((c) => `${asText(c)} AS [${c.name}]`).join(', ')} FROM (\n${query}\n) AS dataset`;
}

// What the dataset returns, asked of the server instead of guessed: names and base type names, in order.
export async function describe(pool: sql.ConnectionPool, query: string, paramDecl: string): Promise<Column[]> {
  const r = await pool.request()
    .input('t', sql.NVarChar(sql.MAX), query).input('p', sql.NVarChar(sql.MAX), paramDecl)
    .query('SELECT name, system_type_name FROM sys.dm_exec_describe_first_result_set(@t, @p, 0) ORDER BY column_ordinal');
  return r.recordset.map((x: { name: string; system_type_name: string }) => ({ name: x.name, type: x.system_type_name.replace(/\(.*\)/, '') }));
}

export async function rowsOf(pool: sql.ConnectionPool, query: string, paramDecl: string, params: Params, order: string[]): Promise<{ cols: Column[]; rows: Row[] }> {
  const cols = await describe(pool, query, paramDecl);
  const req = pool.request();
  for (const [k, p] of Object.entries(params)) req.input(k, p.type, p.value);
  const r = await req.query(normalizedQuery(query, cols));
  const names = order.length ? order : cols.map((c) => c.name);
  return { cols, rows: r.recordset.map((x: Record<string, string | null>) => names.map((n) => x[n] ?? null)) };
}

export interface Side { row: Row; count: number }
export interface Diff { onlyInLegacy: Side[]; onlyInNew: Side[]; matched: number }

// A multiset, not a set: two identical intake rows on one side and one on the other is a difference.
export function diffMultiset(legacy: Row[], next: Row[]): Diff {
  const tally = (rows: Row[]) => { const m = new Map<string, number>(); for (const r of rows) { const k = JSON.stringify(r); m.set(k, (m.get(k) ?? 0) + 1); } return m; };
  const a = tally(legacy), b = tally(next);
  const diff: Diff = { onlyInLegacy: [], onlyInNew: [], matched: 0 };
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k) ?? 0, y = b.get(k) ?? 0;
    diff.matched += Math.min(x, y);
    if (x > y) diff.onlyInLegacy.push({ row: JSON.parse(k), count: x - y });
    if (y > x) diff.onlyInNew.push({ row: JSON.parse(k), count: y - x });
  }
  return diff;
}

export interface Report { shape: string[]; diff: Diff | null }

export async function compareDatasets(pool: sql.ConnectionPool, legacy: string, next: string, paramDecl: string, params: Params): Promise<Report> {
  const a = await rowsOf(pool, legacy, paramDecl, params, []);
  const names = a.cols.map((c) => c.name);
  const b = await rowsOf(pool, next, paramDecl, params, names);
  const shape: string[] = [];
  const bn = new Map(b.cols.map((c) => [c.name, c]));
  for (const c of a.cols) {
    const o = bn.get(c.name);
    if (!o) shape.push(`${c.name}: missing from the new dataset`);
    else if (o.type !== c.type) shape.push(`${c.name}: type ${c.type} -> ${o.type}`);
  }
  for (const c of b.cols) if (!names.includes(c.name)) shape.push(`${c.name}: extra column in the new dataset`);
  if (b.cols.some((c) => !names.includes(c.name)) || names.some((n) => !bn.has(n))) return { shape, diff: null };
  if (b.cols.map((c) => c.name).join() !== names.join()) shape.push(`column order: ${names.join(',')} -> ${b.cols.map((c) => c.name).join(',')}`);
  return { shape, diff: diffMultiset(a.rows, b.rows) };
}
