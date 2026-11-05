// Java EE / Jakarta EE deployment, read from its files: ejb-jar.xml, persistence.xml and the .java sources.
// Static: it finds what the files declare. It does not run the application server, so a JNDI name's real target,
// a vendor descriptor it was not given, and any query built at run time are named as unknowns.
import { children, elements, lineAt, textOf } from './xml.ts';
import { balanced, enclosingMethod, evalLiterals, takeExpr } from './literals.ts';
import { analyzeSql, makeCanon } from './sqlcols.ts';
import { fromSqlUse } from './dependents.ts';
import type { Dependent, Extraction, Schema, SourceFile, Unknown } from './types.ts';

type Entity = { table: string; fields: Map<string, string> };   // JPA field name -> column name

export function extractJavaEe(files: SourceFile[], schema: Schema): Extraction {
  const dependents: Dependent[] = [];
  const unknowns: Unknown[] = [];
  const canon = makeCanon(schema);
  const at = (f: SourceFile, text: string, i: number) => `${f.path}:${lineAt(text, i)}`;
  const base = { columns: [] as string[], access: '-' as const };

  // 1. The descriptors: beans, timers, queues, data sources.
  const declared = new Set<string>();
  for (const f of files.filter((x) => /ejb-jar\.xml$/.test(x.path))) {
    for (const s of elements(f.text, 'session')) {
      const cls = textOf(s, 'ejb-class') ?? '?'; declared.add(cls.split('.').pop()!);
      const jndi = children(s, 'res-ref-name').map((r) => r.body.trim());
      dependents.push({ ...base, name: textOf(s, 'ejb-name') ?? cls, kind: 'EJB session bean', touches: `${textOf(s, 'session-type')}${jndi.length ? `; resource ${jndi.join(', ')}` : ''}`, shapeRisk: 'business logic lives in the class, not the descriptor', evidence: [`${f.path}:${s.line}`] });
      for (const t of children(s, 'timer')) {
        const sch = children(t, 'schedule')[0];
        const when = ['hour', 'minute'].map((k) => `${k} ${sch ? textOf(sch, k) ?? '*' : '?'}`).join(', ');
        dependents.push({ ...base, name: `${textOf(s, 'ejb-name')}.${textOf(t, 'method-name')}`, kind: 'EJB timer', touches: when, shapeRisk: 'fires with no request: only a clock or the log shows it ran', evidence: [`${f.path}:${t.line}`] });
      }
    }
    for (const m of elements(f.text, 'message-driven')) {
      const cls = textOf(m, 'ejb-class') ?? '?'; declared.add(cls.split('.').pop()!);
      const dest = children(m, 'activation-config-property').find((p) => /destination/i.test(textOf(p, 'activation-config-property-name') ?? ''));
      dependents.push({ ...base, name: textOf(m, 'ejb-name') ?? cls, kind: 'message-driven bean (JMS)', touches: `queue or topic ${dest ? textOf(dest, 'activation-config-property-value') : '(none named)'}`, shapeRisk: 'a message producer elsewhere sets the message shape', evidence: [`${f.path}:${m.line}`] });
      unknowns.push({ what: `${textOf(m, 'ejb-name')}: who puts messages on ${dest ? textOf(dest, 'activation-config-property-value') : 'its destination'} is not in this deployment`, evidence: `${f.path}:${m.line}`, settledBy: 'the broker\'s own listing of producers and consumers, or a message capture' });
    }
  }
  for (const f of files.filter((x) => /persistence\.xml$/.test(x.path))) {
    for (const u of elements(f.text, 'persistence-unit')) {
      const ds = textOf(u, 'jta-data-source') ?? textOf(u, 'non-jta-data-source');
      if (!ds) continue;
      dependents.push({ ...base, name: `persistence unit ${u.attrs.name}`, kind: 'JNDI data source', touches: ds, shapeRisk: 'the name is a pointer; the server\'s configuration holds the real database', evidence: [`${f.path}:${u.line}`] });
      unknowns.push({ what: `${u.attrs.name}: the JNDI name ${ds} is mapped to a real database in the application server's configuration, which is not in this deployment`, evidence: `${f.path}:${u.line}`, settledBy: 'read the data source definition on the server (or ask its administrator)' });
    }
  }

  // 2. The Java sources: entities first, so JPQL can be mapped to columns.
  const javas = files.filter((x) => x.path.endsWith('.java'));
  const entities = new Map<string, Entity>();
  for (const f of javas.filter((x) => /@Entity\b/.test(x.text))) {
    const cls = f.text.match(/\bclass\s+(\w+)/)?.[1]!;
    const tbl = f.text.match(/@Table\(([^)]*)\)/)?.[1] ?? '';
    const name = tbl.match(/\bname\s*=\s*"([^"]+)"/)?.[1] ?? cls;
    const sch = tbl.match(/\bschema\s*=\s*"([^"]+)"/)?.[1];
    const table = canon(sch ? `${sch}.${name}` : name);
    if (!table) { unknowns.push({ what: `entity ${cls} maps table ${name}, which is not in the schema snapshot`, evidence: `${f.path}:${lineAt(f.text, f.text.indexOf('@Entity'))}`, settledBy: 'refresh the schema snapshot' }); continue; }
    const fields = new Map<string, string>();
    for (const m of f.text.matchAll(/@Column\(\s*name\s*=\s*"(\w+)"[^)]*\)\s*(?:private|protected|public)?\s*[\w.<>\[\]]+\s+(\w+)\s*;/g)) fields.set(m[2], m[1]);
    entities.set(cls, { table, fields });
  }

  const jpql = (q: string, name: string, evidence: string): void => {
    const s = q.replace(/'(?:[^']|'')*'/g, ' ? ').replace(/\s+/g, ' ').trim();
    const m = s.match(/^select\s+(.*?)\s+from\s+(\w+)(?:\s+(?:as\s+)?(\w+))?/i);
    const ent = m && entities.get(m[2]);
    if (!m || !ent) { unknowns.push({ what: `${name}: JPQL not read (${m ? `entity ${m[2]} is not mapped in this deployment` : 'no SELECT ... FROM entity'})`, evidence, settledBy: 'read the query and its entity by hand' }); return; }
    const alias = m[3] ?? m[2];
    const whole = m[1].trim().toLowerCase() === alias.toLowerCase();
    const cols = new Set<string>();
    const bad: string[] = [];
    if (whole) ent.fields.forEach((c) => cols.add(c));
    for (const r of s.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`, 'g'))) { const c = ent.fields.get(r[1]); if (c) cols.add(c); else bad.push(r[1]); }
    dependents.push({ ...base, name, kind: 'JPA named query', table: ent.table, columns: schema[ent.table].filter((c) => cols.has(c)), touches: '', access: 'R', evidence: [evidence], shapeRisk: whole ? 'returns the whole entity (every mapped column)' : 'names its fields' });
    for (const b of bad) unknowns.push({ what: `${name}: field ${b} is not a mapped column of ${m[2]}`, evidence, settledBy: 'read the entity class' });
  };

  for (const f of javas) {
    const cls = f.text.match(/\bclass\s+(\w+)/)?.[1] ?? f.path;
    for (const m of f.text.matchAll(/@(NamedQuery|NamedNativeQuery)\s*\(/g)) {
      const args = balanced(f.text, m.index! + m[0].length - 1);
      const name = args.match(/\bname\s*=\s*"([^"]+)"/)?.[1] ?? '?';
      const qi = args.search(/\bquery\s*=/);
      const text = evalLiterals(takeExpr(args, qi + args.slice(qi).indexOf('=') + 1, 'java'), 'java').text;
      const ev = at(f, f.text, m.index!);
      if (m[1] === 'NamedQuery') jpql(text, name, ev);
      else { const r = fromSqlUse(name, 'JPA named native query', analyzeSql(text, schema, canon), schema, ev); dependents.push(...r.dependents); unknowns.push(...r.unknowns); }
    }
    for (const m of f.text.matchAll(/\b(createQuery|createNativeQuery)\s*\(/g)) {
      const expr = takeExpr(f.text, m.index! + m[0].length, 'java');
      const ev = at(f, f.text, m.index!);
      const name = `${cls}.${enclosingMethod(f.text, m.index!)}`;
      const lit = evalLiterals(expr, 'java');
      if (lit.dynamic) { unknowns.push({ what: `${name}: ${m[1]} builds its text at run time (${expr.replace(/\s+/g, ' ').trim().slice(0, 100)}); columns not read`, evidence: ev, settledBy: 'run the code path with query logging on, or ask the owner' }); continue; }
      if (m[1] === 'createQuery') jpql(lit.text, name, ev);
      else { const r = fromSqlUse(name, 'native query in code', analyzeSql(lit.text, schema, canon), schema, ev); dependents.push(...r.dependents); unknowns.push(...r.unknowns); }
    }
    for (const m of f.text.matchAll(/@Schedule\(([^)]*)\)[\s\S]*?\bvoid\s+(\w+)/g)) {
      const hour = m[1].match(/hour\s*=\s*"([^"]+)"/)?.[1] ?? '*', minute = m[1].match(/minute\s*=\s*"([^"]+)"/)?.[1] ?? '0';
      dependents.push({ ...base, name: `${cls}.${m[2]}`, kind: 'EJB timer (annotation)', touches: `hour ${hour}, minute ${minute}`, shapeRisk: 'fires with no request: only a clock or the log shows it ran', evidence: [at(f, f.text, m.index!)] });
    }
    const ann = f.text.match(/@(Stateless|Stateful|Singleton|MessageDriven)\b/);
    if (ann && !declared.has(cls)) dependents.push({ ...base, name: cls, kind: `EJB (@${ann[1]}, no descriptor entry)`, touches: '', shapeRisk: 'declared only by annotation; a vendor descriptor can still override it', evidence: [at(f, f.text, ann.index!)] });
  }
  return { dependents, unknowns };
}
