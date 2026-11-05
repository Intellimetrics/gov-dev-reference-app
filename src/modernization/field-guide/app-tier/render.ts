// Lesson 24's dependents table, and the unknowns list, as markdown. Unknown ids for this lesson start at U-40.
import type { Dependent, Schema, Unknown } from './types.ts';

export const FIRST_UNKNOWN = 40;

export function renderDependents(deps: Dependent[]): string {
  const touches = (d: Dependent) => (d.table ? `${d.table.replace(/^dbo\./, '')}${d.columns.length ? `.${d.columns.join(', ')}` : ''}` : d.touches);
  return ['| Dependent | Kind | Touches | R/W | Shape risk | Evidence |', '|---|---|---|---|---|---|',
    ...deps.map((d) => `| ${d.name} | ${d.kind} | ${touches(d)} | ${d.access} | ${d.shapeRisk} | ${d.evidence.join('; ')} |`)].join('\n');
}

export const renderUnknowns = (us: Unknown[], first = FIRST_UNKNOWN): string =>
  us.map((u, i) => `U-${first + i}: ${u.what} [${u.evidence}] settled by: ${u.settledBy}`).join('\n');

/** Keep a roll-up's columns in table order. */
export const inTableOrder = (deps: Dependent[], schema: Schema): Dependent[] =>
  deps.map((d) => (d.table ? { ...d, columns: schema[d.table].filter((c) => d.columns.includes(c)) } : d));
