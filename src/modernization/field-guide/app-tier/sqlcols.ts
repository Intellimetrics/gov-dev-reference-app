// Which columns of which tables does one SQL statement read or write? Static reading of the statement text,
// for Access SQL and T-SQL alike. It covers the statement's own output, NOT every dependency: a statement it
// cannot read whole comes back with `unparsed` set, and the caller must list it as an unknown.
import type { Schema } from './types.ts';

export type TableUse = { read: Set<string>; write: Set<string>; star: boolean; positionalInsert: boolean };
export type SqlUse = { verb: string; tables: Record<string, TableUse>; others: string[]; unresolved: string[]; ambiguous: string[]; calls: string[]; unparsed?: string };

const KEYWORDS = new Set('select from where and or not null is in between like as on join inner left right full outer cross group by order having asc desc distinct distinctrow top percent all case when then else end set values insert into update delete exists true false escape with'.split(' '));
const BUILTIN = new Set('count sum avg min max iif nz format date now time year month day weekday datediff dateadd datepart mid len trim ltrim rtrim ucase lcase cint clng cdbl cdate cstr round int fix abs isnull coalesce cast convert getdate sysdatetime upper lower substring replace'.split(' '));

/** Maps a name written in a statement to a canonical table in the schema. `extra` holds aliases such as Access link names. */
export function makeCanon(schema: Schema, extra: Record<string, string> = {}) {
  const lc = Object.fromEntries(Object.keys(schema).map((k) => [k.toLowerCase(), k]));
  return (name: string): string | undefined => {
    const n = name.replace(/[\[\]"`]/g, '').toLowerCase();
    return extra[n] ?? lc[n] ?? lc[`dbo.${n}`];
  };
}

/** Strings, comments, dates, [parameters] and @parameters become `?`; [bracketed names] lose their brackets. */
function clean(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, ' ? ').replace(/"(?:[^"]|"")*"/g, ' ? ')
    .replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/#[^#\n]*#/g, ' ? ')
    .replace(/\[([^\]]*)\]/g, (_, inner: string) => (/[\s!]/.test(inner) ? ' ? ' : inner))
    .replace(/\b[A-Za-z_]\w*(?:![A-Za-z_]\w*)+/g, ' ? ')       // Forms!frmReview!txtStart
    .replace(/[@:][A-Za-z_]\w*/g, ' ? ')
    .replace(/\s+/g, ' ').replace(/;\s*$/, '').trim();
}

const topLevelSplit = (s: string): string[] => {
  const out: string[] = []; let depth = 0, cur = '';
  for (const c of s) {
    if (c === '(') depth++; else if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  return [...out, cur].map((x) => x.trim()).filter(Boolean);
};

const emptyUse = (): TableUse => ({ read: new Set(), write: new Set(), star: false, positionalInsert: false });

export function analyzeSql(sql: string, schema: Schema, canon: (name: string) => string | undefined): SqlUse {
  const s = clean(sql);
  const use: SqlUse = { verb: (s.match(/^\w+/)?.[0] ?? '').toLowerCase(), tables: {}, others: [], unresolved: [], ambiguous: [], calls: [] };
  const reject = /\(\s*select\b/i.test(s) ? 'a subquery' : /\bunion\b/i.test(s) ? 'UNION' : /\bpivot\b/i.test(s) ? 'a crosstab (TRANSFORM ... PIVOT)'
    : /^(exec|execute)\b/.test(use.verb) ? 'EXEC: it runs a procedure whose body is not in this input'
    : !['select', 'update', 'insert', 'delete'].includes(use.verb) ? `a ${use.verb.toUpperCase() || 'blank'} statement` : '';
  if (reject) { use.unparsed = reject; return use; }

  const amap = new Map<string, string | null>();                 // alias or table name -> canonical table, null if outside the schema
  const conds: string[] = [];
  const tableOf = (name: string): TableUse | undefined => { const c = canon(name); return c ? (use.tables[c] ??= emptyUse()) : undefined; };
  const sources = (segment: string) => {
    for (const piece of segment.replace(/[()]/g, ' ').split(/\b(?:(?:inner|left|right|full|cross)\s+)?(?:outer\s+)?join\b|,/i)) {
      const [head, cond] = piece.split(/\bon\b/i);
      if (cond) conds.push(cond);
      const t = head.trim().split(/\s+/);
      if (!t[0]) continue;
      const alias = t[1]?.toLowerCase() === 'as' ? t[2] : t[1];
      let c = canon(t[0]) ?? null;
      if (c && !(c in schema)) { use.unparsed ??= `${t[0]} resolves to ${c}, a table outside the schema snapshot`; c = null; }   // a link to a table the snapshot lacks
      if (c) tableOf(t[0]); else use.others.push(t[0]);
      amap.set((alias ?? t[0].split('.').pop()!).toLowerCase(), c);
      amap.set(t[0].split('.').pop()!.toLowerCase(), c);
    }
  };
  const addCol = (table: string, col: string, into: 'read' | 'write') => {
    const real = schema[table].find((c) => c.toLowerCase() === col.toLowerCase());
    if (real) use.tables[table][into].add(real); else if (!use.unresolved.includes(`${table}.${col}`)) use.unresolved.push(`${table}.${col}`);
  };
  const scan = (text: string) => {
    const aliasNames = new Set([...text.matchAll(/\bas\s+([A-Za-z_]\w*)/gi)].map((m) => m[1].toLowerCase()));
    for (const m of text.matchAll(/([A-Za-z_][\w$]*)(?:\s*\.\s*([A-Za-z_][\w$]*|\*))?(\s*\()?/g)) {
      const [, a, b, paren] = m; const al = a.toLowerCase();
      if (b !== undefined) { const t = amap.get(al); if (b !== '*' && t) addCol(t, b, 'read'); continue; }   // qualifier.column
      if (paren) { if (!BUILTIN.has(al) && !KEYWORDS.has(al) && !use.calls.includes(a)) use.calls.push(a); continue; }
      if (KEYWORDS.has(al) || BUILTIN.has(al) || amap.has(al) || aliasNames.has(al)) continue;
      const owners = [...new Set([...amap.values()].filter((t): t is string => !!t && schema[t].some((c) => c.toLowerCase() === al)))];
      if (owners.length === 1) addCol(owners[0], a, 'read');
      else if (owners.length > 1) use.ambiguous.push(a);
      else { const only = [...amap.values()]; if (only.length === 1 && only[0] && !use.unresolved.includes(`${only[0]}.${a}`)) use.unresolved.push(`${only[0]}.${a}`); }
    }
  };
  const starOn = (qualifier?: string) => { for (const [k, t] of amap) if (t && (!qualifier || k === qualifier.toLowerCase())) use.tables[t].star = true; };

  if (use.verb === 'select') {
    const m = s.match(/^select\s+(.*?)\s+from\s+(.*?)(?:\s+(where|group by|order by|having)\b(.*))?$/i);
    if (!m) { use.unparsed = 'a SELECT with no FROM'; return use; }
    const list = m[1].replace(/^(?:distinct|distinctrow)\s+/i, '').replace(/^top\s+\d+(?:\s+percent)?\s+/i, '');
    sources(m[2]);
    for (const item of topLevelSplit(list)) { if (item === '*') starOn(); const q = item.match(/^(\w+)\.\*$/); if (q) starOn(q[1]); }
    scan(`${list} ${conds.join(' ')} ${m[3] ?? ''} ${m[4] ?? ''}`);
  } else if (use.verb === 'update') {
    const m = s.match(/^update\s+(.*?)\s+set\s+(.*?)(?:\s+where\s+(.*))?$/i);
    if (!m) { use.unparsed = 'an UPDATE it cannot split'; return use; }
    sources(m[1]);
    const rhs: string[] = [];
    for (const a of topLevelSplit(m[2])) {
      const [lhs, ...r] = a.split('='); rhs.push(r.join('='));
      const [q, col] = lhs.trim().includes('.') ? lhs.trim().split('.') : [undefined, lhs.trim()];
      const t = q ? amap.get(q.toLowerCase()) : [...new Set([...amap.values()].filter(Boolean))].length === 1 ? [...amap.values()].find(Boolean) : undefined;
      if (t) addCol(t, col, 'write');
    }
    scan(`${rhs.join(' ')} ${conds.join(' ')} ${m[3] ?? ''}`);
  } else if (use.verb === 'insert') {
    const m = s.match(/^insert\s+into\s+(\S+)\s*(?:\(([^)]*)\))?\s*(.*)$/i);
    if (!m) { use.unparsed = 'an INSERT it cannot split'; return use; }
    const t = canon(m[1]);
    if (t) {
      tableOf(m[1]);
      if (m[2]) for (const c of m[2].split(',')) addCol(t, c.trim(), 'write');
      else { use.tables[t].positionalInsert = true; schema[t].forEach((c) => use.tables[t].write.add(c)); }
    } else use.others.push(m[1]);
    if (/^select\b/i.test(m[3])) {
      const inner = analyzeSql(m[3], schema, canon);
      for (const [k, v] of Object.entries(inner.tables)) { const u = (use.tables[k] ??= emptyUse()); v.read.forEach((c) => u.read.add(c)); u.star ||= v.star; }
      use.others.push(...inner.others); use.unresolved.push(...inner.unresolved); use.calls.push(...inner.calls);
      if (inner.unparsed) use.unparsed = inner.unparsed;
    }
  } else {
    const m = s.match(/^delete\s+(?:\*\s+|\w+\s+)?from\s+(.*?)(?:\s+where\s+(.*))?$/i);
    if (!m) { use.unparsed = 'a DELETE it cannot split'; return use; }
    sources(m[1]);
    for (const t of Object.keys(use.tables)) use.tables[t].write = new Set(schema[t]);   // a delete removes the whole row
    scan(`${conds.join(' ')} ${m[2] ?? ''}`);
  }
  // `SELECT *` reads every column.
  for (const [t, u] of Object.entries(use.tables)) if (u.star) schema[t].forEach((c) => u.read.add(c));
  return use;
}
