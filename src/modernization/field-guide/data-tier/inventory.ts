// Dependents inventory from catalog snapshots (lesson 28). It proves coverage of the query output,
// not completeness: every row read is cited, skipped with a reason, or sent to unknowns.

export type Cited = { cite: string; row: Record<string, string> };

/** Minimal RFC 4180 reader: quoted fields may hold commas and newlines. The cite is file:line of the record's first line. */
export function parseCsv(file: string, text: string): Cited[] {
  const records: { fields: string[]; line: number }[] = [];
  let fields: string[] = [], field = '', quoted = false, line = 1, start = 1;
  const endField = () => { fields.push(field); field = ''; };
  const endRecord = () => { endField(); if (fields.some((f) => f !== '')) records.push({ fields, line: start }); fields = []; start = line; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\n') line++;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') endField();
    else if (c === '\n') endRecord();
    else if (c !== '\r') field += c;
  }
  if (field !== '' || fields.length) endRecord();
  const [header, ...body] = records;
  return body.map((r) => ({
    cite: `${file}:${r.line}`,
    row: Object.fromEntries(header.fields.map((h, i) => [h, r.fields[i] ?? ''])),
  }));
}

export type Dependent = { name: string; kind: string; touches: string[]; rw: 'R' | '?'; shapeRisk: string; evidence: string[] };
export type Unknown = { id: string; what: string; evidence: string[]; whoCanSay: string };
export type Inventory = {
  dependents: Dependent[];
  unknowns: Unknown[];
  skipped: { cite: string; why: string }[];
  rowsRead: number;
  gaps: string[];
};
export type Snapshots = {
  scope: { owner: string; objects: string[] };
  oracle?: { dependencies: Cited[]; viewText?: Cited[]; jobs?: Cited[] };
  db2?: { packageDeps: Cited[] };
};

// Packages that open a door the catalog cannot see through (UNVERIFIED as a list: our reading of what they do).
const DOORS: Record<string, string> = {
  DBMS_SQL: 'builds SQL at run time, so the tables it touches are not in the catalog',
  UTL_FILE: 'writes or reads files outside the database',
  UTL_HTTP: 'calls a web service',
  UTL_SMTP: 'sends mail',
};
const GAPS = [
  'dynamic SQL (EXECUTE IMMEDIATE, PREPARE) leaves no catalog row',
  'external schedulers and shell scripts are not in either catalog',
  'application code, reports and spreadsheets that connect directly are not in either catalog',
];

export function buildInventory(s: Snapshots): Inventory {
  const deps = new Map<string, Dependent>();
  const unknowns: Unknown[] = [];
  const skipped: { cite: string; why: string }[] = [];
  let rowsRead = 0;
  const add = (key: string, d: Omit<Dependent, 'evidence' | 'touches'>, touch: string, cite: string) => {
    const cur = deps.get(key) ?? { ...d, touches: [], evidence: [] };
    if (!cur.touches.includes(touch)) cur.touches.push(touch);
    cur.evidence.push(cite);
    deps.set(key, cur);
  };
  const unknown = (what: string, evidence: string[], whoCanSay: string) =>
    unknowns.push({ id: `U-${30 + unknowns.length}`, what, evidence, whoCanSay });
  const skip = (cite: string, why: string) => skipped.push({ cite, why });
  const name = (r: Record<string, string>) => `${r.OWNER}.${r.NAME}`;
  const ref = (r: Record<string, string>) => `${r.REFERENCED_OWNER}.${r.REFERENCED_NAME}`;

  const o = s.oracle;
  if (o) {
    const watched = new Set(s.scope.objects.map((t) => `${s.scope.owner}.${t}`));
    const live = (r: Record<string, string>) => !r.REFERENCED_LINK_NAME && name(r) !== ref(r);
    const sourced = new Set<string>();           // objects whose reference to a watched object was found
    for (let grew = true; grew;) {                // a dependent of a dependent is a dependent
      grew = false;
      for (const { row } of o.dependencies) {
        if (live(row) && watched.has(ref(row)) && !watched.has(name(row))) { watched.add(name(row)); sourced.add(name(row)); grew = true; }
      }
    }
    const viewText = new Map((o.viewText ?? []).map((v) => [`${v.row.OWNER}.${v.row.VIEW_NAME}`, v]));
    for (const { cite, row } of o.dependencies) {
      rowsRead++;
      if (row.REFERENCED_LINK_NAME) {
        unknown(`${name(row)} reaches ${ref(row)} across database link ${row.REFERENCED_LINK_NAME}; the remote object is not in this catalog`, [cite], 'the DBA who owns the link');
      } else if (name(row) === ref(row)) skip(cite, 'a body referring to its own specification');
      else if (!watched.has(name(row))) skip(cite, 'outside scope');
      else if (row.REFERENCED_OWNER === 'SYS' && DOORS[row.REFERENCED_NAME]) {
        unknown(`${name(row)} calls ${row.REFERENCED_NAME}, which ${DOORS[row.REFERENCED_NAME]}`, [cite], 'the package owner');
      } else if (row.REFERENCED_OWNER === 'SYS') skip(cite, 'system package');
      else if (watched.has(ref(row))) {
        const direct = s.scope.objects.includes(row.REFERENCED_NAME) && row.REFERENCED_OWNER === s.scope.owner;
        add(`${row.TYPE}|${name(row)}`, { name: name(row), kind: `Oracle ${row.TYPE.toLowerCase()}`, rw: row.TYPE === 'VIEW' ? 'R' : '?',
          shapeRisk: row.TYPE === 'TRIGGER' ? 'fires for every writer' : row.TYPE === 'VIEW' ? '' : 'body not read here' },
          direct ? row.REFERENCED_NAME : `via ${ref(row)}`, cite);
      } else skip(cite, 'dependent touches an object outside scope');
    }
    for (const d of deps.values()) {
      if (d.kind !== 'Oracle view') continue;
      const v = viewText.get(d.name);
      d.shapeRisk = !v ? 'view text not supplied' : /select\s+\*/i.test(v.row.TEXT) ? '`SELECT *`' : 'column list explicit';
      if (v) d.evidence.push(v.cite);
    }
    for (const v of o.viewText ?? []) { rowsRead++; if (!deps.has(`VIEW|${v.row.OWNER}.${v.row.VIEW_NAME}`)) skip(v.cite, 'view is not a dependent'); }
    for (const { cite, row } of o.jobs ?? []) {
      rowsRead++;
      const named = row.JOB_TYPE === 'EXECUTABLE' ? undefined : row.JOB_ACTION.toUpperCase().match(/\b([A-Z][A-Z0-9_$#]*\.[A-Z][A-Z0-9_$#]*)\.[A-Z]/)?.[1];
      if (!named) unknown(`scheduler job ${row.OWNER}.${row.JOB_NAME} runs ${row.JOB_ACTION}, which the database cannot describe`, [cite], 'whoever owns the schedule');
      else if (!sourced.has(named)) skip(cite, `names ${named}, which is not a dependent`);
      else add(`JOB|${row.OWNER}.${row.JOB_NAME}`, { name: `${row.OWNER}.${row.JOB_NAME}`, kind: 'Oracle scheduler job', rw: '?', shapeRisk: `runs ${row.JOB_ACTION}` }, `via ${named}`, cite);
    }
  }

  const d2 = s.db2;
  if (d2) {
    const watched = new Set(s.scope.objects);
    for (const { cite, row } of d2.packageDeps) {
      rowsRead++;
      if (!['T', 'V', 'I', 'R'].includes(row.BTYPE)) {
        unknown(`package ${row.DCOLLID}.${row.DNAME} depends on ${row.BQUALIFIER}.${row.BNAME}, a BTYPE ${row.BTYPE} object the snapshot cannot resolve to a table`, [cite], 'the DBA who owns the alias');
      } else if (row.BTYPE === 'I' || row.BTYPE === 'R') skip(cite, 'index or table space, not a dependent in itself');
      else if (row.BQUALIFIER === s.scope.owner && watched.has(row.BNAME)) {
        add(`PKG|${row.DCOLLID}.${row.DNAME}`, { name: `${row.DCOLLID}.${row.DNAME}`, kind: 'Db2 package', rw: '?', shapeRisk: 'bound SQL not read here' }, row.BNAME, cite);
      } else skip(cite, 'outside scope');
    }
  }

  return {
    dependents: [...deps.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)),
    unknowns, skipped, rowsRead, gaps: GAPS,
  };
}

/** Every row read is cited by a dependent, skipped with a reason, or named in an unknown. */
export function accounted(inv: Inventory): number {
  const cited = new Set(inv.dependents.flatMap((d) => d.evidence));
  const unk = new Set(inv.unknowns.flatMap((u) => u.evidence));
  return cited.size + unk.size + inv.skipped.length;
}

export function renderDependents(inv: Inventory): string {
  const rows = inv.dependents.map((d) =>
    `| \`${d.name}\` | ${d.kind} | ${d.touches.join(', ')} | ${d.rw} | ${d.shapeRisk || 'n/a'} | ${d.evidence.map((e) => `\`${e}\``).join(', ')} |`);
  return ['| Dependent | Kind | Touches | R/W | Shape risk | Evidence |', '|---|---|---|---|---|---|', ...rows].join('\n') + '\n';
}

export function renderUnknowns(inv: Inventory): string {
  return inv.unknowns.map((u) => `- ${u.id}: ${u.what}. Evidence: ${u.evidence.join(', ')}. Who can say: ${u.whoCanSay}.`).join('\n') + '\n';
}

export function renderCoverage(inv: Inventory): string {
  return `Coverage of the query output: ${inv.rowsRead} rows read, ${inv.dependents.length} dependents, ${inv.unknowns.length} unknowns, ${inv.skipped.length} rows skipped with a reason.\n`
    + `Not covered, by construction:\n${inv.gaps.map((g) => `- ${g}`).join('\n')}\n`;
}
