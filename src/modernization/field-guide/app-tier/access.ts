// A Microsoft Access database, read from an EXPORT of its objects (no Access, no Windows): saved-query text,
// linked-table definitions and VBA modules. The export format is this lesson's own: one header line per object,
// `-- query: <name> | type=<kind>` or `-- macro: <name>`, then the object's text. How you produce such an export
// (a loop over the saved queries, or a scripted read of the system tables) is not sourced here: UNVERIFIED.
import { analyzeSql, makeCanon, type SqlUse } from './sqlcols.ts';
import { fromSqlUse } from './dependents.ts';
import { evalLiterals, enclosingMethod, takeExpr } from './literals.ts';
import { lineAt } from './xml.ts';
import type { Dependent, Extraction, Schema, SourceFile, Unknown } from './types.ts';

export const DATABASE = 'MSACCESS from SUP-WS-014 (SupervisorTracking.accdb)';

export function parseLinks(file: SourceFile | undefined): { map: Record<string, string>; deps: Dependent[]; unknowns: Unknown[] } {
  const out = { map: {} as Record<string, string>, deps: [] as Dependent[], unknowns: [] as Unknown[] };
  file?.text.split('\n').forEach((line, i) => {
    const m = line.match(/^(\w+)\s*->\s*(.*)$/);
    if (!m) return;
    const target = m[2].match(/TABLE=([\w.]+)/i)?.[1] ?? '?';
    out.map[m[1].toLowerCase()] = target;
    const secret = /\b(PWD|PASSWORD)=/i.test(m[2]);
    out.deps.push({ name: `linked table ${m[1]}`, kind: 'Access linked table', columns: [], touches: `${target} on ${m[2].match(/SERVER=([^;]+)/i)?.[1] ?? '?'}`, access: '-', shapeRisk: secret ? 'password stored in the link (value not copied here)' : 'Access holds its own copy of the field list: check after a schema change', evidence: [`${file.path}:${i + 1}`] });
  });
  return out;
}

type Q = { name: string; type: string; line: number; sql: string };

export function parseQueries(file: SourceFile): { queries: Q[]; macros: { name: string; line: number }[] } {
  const queries: Q[] = [], macros: { name: string; line: number }[] = [];
  let cur: Q | undefined;
  file.text.split('\n').forEach((line, i) => {
    const q = line.match(/^--\s*query:\s*(\w+)\s*\|\s*type=(\w+)/), mac = line.match(/^--\s*macro:\s*(\w+)/);
    if (q) { cur = { name: q[1], type: q[2], line: i + 1, sql: '' }; queries.push(cur); }
    else if (mac) { cur = undefined; macros.push({ name: mac[1], line: i + 1 }); }
    else if (cur) cur.sql += `${line}\n`;
  });
  return { queries, macros };
}

export function extractAccess(files: SourceFile[], schema: Schema): Extraction {
  const dependents: Dependent[] = [];
  const unknowns: Unknown[] = [];
  const links = parseLinks(files.find((f) => /linked-tables\.txt$/.test(f.path)));
  dependents.push(...links.deps);
  for (const d of links.deps) {
    const target = links.map[d.name.replace('linked table ', '').toLowerCase()];
    if (!makeCanon(schema)(target)) unknowns.push({ what: `${d.name} links ${target}, a table outside the schema snapshot`, evidence: d.evidence[0], settledBy: 'extend the snapshot if the table matters to this app' });
  }
  const canon = makeCanon(schema, links.map);

  const uses = new Map<string, { use: SqlUse; ev: string; name: string }>();
  for (const f of files.filter((x) => /queries\.txt$/.test(x.path))) {
    const { queries, macros } = parseQueries(f);
    for (const q of queries) uses.set(q.name.toLowerCase(), { name: q.name, use: analyzeSql(q.sql, schema, canon), ev: `${f.path}:${q.line}` });
    for (const m of macros) unknowns.push({ what: `macro ${m.name}: actions are not read by this extractor`, evidence: `${f.path}:${m.line}`, settledBy: 'open the macro in the Access editor' });
  }
  // A query that reads another saved query inherits what that one reads (an over-approximation: all of it).
  const effective = (name: string, seen: string[] = []): SqlUse['tables'] => {
    const e = uses.get(name.toLowerCase());
    if (!e || seen.includes(name.toLowerCase())) return {};
    const out: SqlUse['tables'] = {};
    for (const [t, u] of Object.entries(e.use.tables)) out[t] = { ...u, read: new Set(u.read), write: new Set(u.write) };
    for (const o of e.use.others) for (const [t, u] of Object.entries(effective(o, [...seen, name.toLowerCase()]))) {
      const x = (out[t] ??= { read: new Set(), write: new Set(), star: false, positionalInsert: false });
      u.read.forEach((c) => x.read.add(c)); u.write.forEach((c) => x.write.add(c)); x.star ||= u.star;
    }
    return out;
  };
  for (const [key, { use, ev, name }] of uses) {
    const via = use.others.filter((o) => uses.has(o.toLowerCase()));
    const r = fromSqlUse(name, 'Access saved query', { ...use, tables: effective(key) }, schema, ev, via.length ? `reads through ${via.join(', ')} (all the columns that query reads)` : '');
    dependents.push(...r.dependents); unknowns.push(...r.unknowns);
  }

  for (const f of files.filter((x) => /\.(bas|cls)$/.test(x.path))) {
    for (const m of f.text.matchAll(/\b(RunSQL|Execute|OpenRecordset)\s*\(?\s*/g)) {
      const expr = takeExpr(f.text, m.index! + m[0].length, 'vba');
      const ev = `${f.path}:${lineAt(f.text, m.index!)}`;
      const name = `VBA ${f.path.split('/').pop()!.replace(/\.\w+$/, '')}.${enclosingMethod(f.text, m.index!)}`;
      const lit = evalLiterals(expr, 'vba');
      if (lit.dynamic) { unknowns.push({ what: `${name}: ${m[1]} builds its SQL at run time (${expr.replace(/\s+/g, ' ').trim().slice(0, 100)}); columns not read`, evidence: ev, settledBy: 'read the procedure, or log the SQL it runs' }); continue; }
      const r = fromSqlUse(name, 'VBA statement', analyzeSql(lit.text, schema, canon), schema, ev);
      dependents.push(...r.dependents); unknowns.push(...r.unknowns);
    }
  }
  return { dependents, unknowns };
}

/** One row per table for the whole database: the answer to "what does this Access file use?" */
export function rollup(dependents: Dependent[], name = DATABASE): Dependent[] {
  const byTable = new Map<string, Dependent[]>();
  for (const d of dependents) if (d.table) byTable.set(d.table, [...(byTable.get(d.table) ?? []), d]);
  return [...byTable].map(([table, ds]) => {
    const cols = new Set(ds.flatMap((d) => d.columns));
    const r = ds.some((d) => d.access !== 'W'), w = ds.some((d) => d.access !== 'R');
    return { name, kind: 'Access database (roll-up)', table, columns: [...cols], touches: '', access: (r && w ? 'R/W' : w ? 'W' : 'R') as Dependent['access'],
      shapeRisk: ds.some((d) => /SELECT \*/.test(d.shapeRisk)) ? 'a saved query selects *' : 'names its columns', evidence: ds.flatMap((d) => d.evidence) };
  });
}
