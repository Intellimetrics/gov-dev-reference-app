// Reads the three committed application fixtures and prints lesson 24's dependents rows and the unknowns.
// Usage: node --experimental-strip-types src/modernization/field-guide/app-tier/extract.ts [fixture-root] [java|dotnet|access]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractJavaEe } from './java-ee.ts';
import { extractDotNet } from './dotnet.ts';
import { extractAccess, rollup } from './access.ts';
import { inTableOrder, renderDependents, renderUnknowns } from './render.ts';
import type { Extraction, Schema, SourceFile } from './types.ts';

export const DEFAULT_ROOT = new URL('../../../../fixtures/field-guide/app-tier', import.meta.url).pathname;

export function readTree(dir: string): SourceFile[] {
  return (readdirSync(dir, { recursive: true }) as string[]).map(String).sort()
    .filter((p) => /\.\w+$/.test(p)).map((p) => ({ path: p, text: readFileSync(join(dir, p), 'utf8') }));
}

export const loadSchema = (root: string): Schema => JSON.parse(readFileSync(join(root, 'intake-schema.json'), 'utf8'));

export function extractApp(root: string, app: 'java' | 'dotnet' | 'access'): Extraction {
  const schema = loadSchema(root), files = readTree(join(root, app));
  const withApp = (r: Extraction): Extraction => {
    const prefix = (e: string) => `${app}/${e}`;
    return { dependents: inTableOrder(r.dependents, schema).map((d) => ({ ...d, evidence: d.evidence.map(prefix) })), unknowns: r.unknowns.map((u) => ({ ...u, evidence: prefix(u.evidence) })) };
  };
  if (app === 'java') return withApp(extractJavaEe(files, schema));
  if (app === 'dotnet') return withApp(extractDotNet(files, schema));
  const r = withApp(extractAccess(files, schema));
  return { ...r, dependents: [...inTableOrder(rollup(r.dependents), schema), ...r.dependents] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2] ?? DEFAULT_ROOT;
  const apps = (process.argv[3] ? [process.argv[3]] : ['java', 'dotnet', 'access']) as ('java' | 'dotnet' | 'access')[];
  for (const app of apps) {
    const r = extractApp(root, app);
    console.log(`## ${app}: ${r.dependents.length} dependents, ${r.unknowns.length} unknowns (coverage: what these files declare; external schedulers, unseen objects and run-time SQL are gaps)\n`);
    console.log(renderDependents(r.dependents) + '\n');
    console.log(renderUnknowns(r.unknowns) + '\n');
  }
}
