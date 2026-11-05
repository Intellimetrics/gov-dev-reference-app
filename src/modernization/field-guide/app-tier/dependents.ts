// Turns one analysed statement into rows for lesson 24's dependents table, plus the unknowns it leaves behind.
import type { Dependent, Schema, Unknown } from './types.ts';
import type { SqlUse } from './sqlcols.ts';

export function fromSqlUse(name: string, kind: string, use: SqlUse, schema: Schema, evidence: string, extraRisk = ''): { dependents: Dependent[]; unknowns: Unknown[] } {
  const dependents: Dependent[] = [];
  const unknowns: Unknown[] = [];
  for (const [table, u] of Object.entries(use.tables)) {
    const cols = schema[table].filter((c) => u.read.has(c) || u.write.has(c));
    const risks = [u.star ? 'SELECT * (a new column changes its shape)' : '', u.positionalInsert ? 'INSERT with no column list (position decides the column)' : '', extraRisk].filter(Boolean);
    dependents.push({
      name, kind, table, columns: cols, touches: '', evidence: [evidence],
      access: u.read.size && u.write.size ? 'R/W' : u.write.size ? 'W' : 'R',
      shapeRisk: risks.join('; ') || 'names its columns',
    });
  }
  const why = (what: string, settledBy: string) => unknowns.push({ what: `${name}: ${what}`, evidence, settledBy });
  if (use.unparsed) why(`not read by this extractor (${use.unparsed}); which columns it uses is open`, 'a person reading the statement, or the database engine\'s own record of what it ran');
  for (const t of use.unresolved) {
    const at = t.lastIndexOf('.');
    why(`names ${t.slice(at + 1)} on ${t.slice(0, at)}, which is not in the schema snapshot (renamed, dropped or mistyped)`, 'compare with the schema snapshot from lesson 24; ask the owner');
  }
  for (const c of use.calls) why(`calls ${c}(), defined outside this statement; the logic inside it is unread`, 'read the function where it lives');
  for (const c of use.ambiguous) why(`uses ${c} with no table in front of it, and more than one table has it`, 'qualify the column and re-run');
  return { dependents, unknowns };
}
