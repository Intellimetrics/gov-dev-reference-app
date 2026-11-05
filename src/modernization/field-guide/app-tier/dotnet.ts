// A .NET Framework web app, read from its files: web.config (connection strings, WCF), contracts, and Web Forms
// code-behind. Static: nothing here needs Windows or IIS. A connection string's PASSWORD is never copied out.
import { children, elements, lineAt } from './xml.ts';
import { enclosingMethod, evalLiterals, takeExpr } from './literals.ts';
import { analyzeSql, makeCanon } from './sqlcols.ts';
import { fromSqlUse } from './dependents.ts';
import type { Dependent, Extraction, Schema, SourceFile, Unknown } from './types.ts';

const parts = (cs: string) => Object.fromEntries(cs.split(';').map((p) => p.split(/=(.*)/s)).filter((p) => p[0].trim()).map((p) => [p[0].trim().toLowerCase(), (p[1] ?? '').trim()]));

export function extractDotNet(files: SourceFile[], schema: Schema): Extraction {
  const dependents: Dependent[] = [];
  const unknowns: Unknown[] = [];
  const canon = makeCanon(schema);
  const base = { columns: [] as string[], access: '-' as const };

  for (const f of files.filter((x) => /web\.config$/i.test(x.path))) {
    for (const block of elements(f.text, 'connectionStrings')) for (const c of children(block, 'add')) {
      const p = parts(c.attrs.connectionString ?? '');
      const login = 'integrated security' in p || 'trusted_connection' in p ? 'Windows login' : `SQL login ${p['user id'] ?? p.uid ?? '?'}`;
      const plain = 'password' in p || 'pwd' in p;
      dependents.push({ ...base, name: `connection string ${c.attrs.name}`, kind: 'connection string', touches: `${p['data source'] ?? p.server} / ${p['initial catalog'] ?? p.database}, ${login}`, shapeRisk: plain ? 'password stored in the file (value not copied here)' : 'no secret in the file', evidence: [`${f.path}:${c.line}`] });
    }
    const bindings = elements(f.text, 'binding');
    const modeOf = (name?: string) => { const b = bindings.find((x) => x.attrs.name === name); return b ? b.body.match(/<security\s[^>]*mode\s*=\s*"(\w+)"/)?.[1] ?? 'default' : undefined; };
    for (const s of elements(f.text, 'service')) for (const e of children(s, 'endpoint')) {
      const mode = modeOf(e.attrs.bindingConfiguration);
      dependents.push({ ...base, name: `${s.attrs.name} at "${e.attrs.address || '(base address)'}"`, kind: 'WCF service endpoint', touches: `contract ${e.attrs.contract}; ${e.attrs.binding}; security ${mode ?? 'not set in the file (binding defaults)'}`, shapeRisk: 'callers are generated from the contract: its operations and message types are the shape', evidence: [`${f.path}:${e.line}`] });
    }
    for (const c of elements(f.text, 'client')) for (const e of children(c, 'endpoint')) {
      dependents.push({ ...base, name: `calls ${e.attrs.address}`, kind: 'WCF client endpoint (outbound)', touches: `contract ${e.attrs.contract}; ${e.attrs.binding}`, shapeRisk: 'the other side can change its contract without telling this app', evidence: [`${f.path}:${e.line}`] });
      unknowns.push({ what: `outbound call to ${e.attrs.address}: the service behind it is not in this deployment`, evidence: `${f.path}:${e.line}`, settledBy: 'the owner of that host' });
    }
  }

  for (const f of files.filter((x) => x.path.endsWith('.cs'))) {
    const iface = f.text.match(/\[ServiceContract[^\]]*\][\s\S]*?\binterface\s+(\w+)/);
    if (iface) {
      const ops = [...f.text.matchAll(/\[OperationContract[^\]]*\]\s*[\w<>\[\]]+\s+(\w+)\s*\(/g)].map((m) => m[1]);
      dependents.push({ ...base, name: `contract ${iface[1]}`, kind: 'WCF service contract', touches: `operations ${ops.join(', ')}`, shapeRisk: 'the operations and their message types are what callers are generated from', evidence: [`${f.path}:${lineAt(f.text, iface.index!)}`] });
    }
    if (!f.path.endsWith('.aspx.cs')) continue;
    const ordinal = /\.Get\w+\(\s*\d+\s*\)|\b(?:rd|reader|dr)\[\s*\d+\s*\]/.test(f.text);
    for (const m of f.text.matchAll(/new\s+SqlCommand\s*\(/g)) {
      let expr = takeExpr(f.text, m.index! + m[0].length, 'cs').trim();
      const ev = `${f.path}:${lineAt(f.text, m.index!)}`;
      const name = `${f.path.split('/').pop()} ${enclosingMethod(f.text, m.index!)}`;
      if (/^\w+$/.test(expr)) {                                                          // a variable: use its last assignment above
        const asg = [...f.text.slice(0, m.index!).matchAll(new RegExp(`\\b${expr}\\s*=\\s*`, 'g'))].at(-1);
        if (asg) expr = takeExpr(f.text, asg.index! + asg[0].length, 'cs');
      }
      const lit = evalLiterals(expr, 'cs');
      if (lit.dynamic) { unknowns.push({ what: `${name}: SQL text is built at run time (${expr.replace(/\s+/g, ' ').trim().slice(0, 100)}); columns not read`, evidence: ev, settledBy: 'run the page with the database engine\'s query record on, or ask the owner' }); continue; }
      const r = fromSqlUse(name, 'Web Forms code-behind query', analyzeSql(lit.text, schema, canon), schema, ev, ordinal && /^\s*select/i.test(lit.text) ? 'result read by ordinal position (reordering the select list breaks it)' : '');
      dependents.push(...r.dependents); unknowns.push(...r.unknowns);
    }
    const keys = [...new Set([...f.text.matchAll(/ViewState\[\s*"(\w+)"\s*\]/g)].map((m) => m[1]))];
    if (keys.length) dependents.push({ ...base, name: `${f.path.split('/').pop()} ViewState`, kind: 'Web Forms page state', touches: `keys ${keys.join(', ')}`, shapeRisk: 'state rides in the __VIEWSTATE form field: a recording must replay it, so capture in a browser', evidence: [`${f.path}:${lineAt(f.text, f.text.indexOf('ViewState['))}`] });
  }
  return { dependents, unknowns };
}
