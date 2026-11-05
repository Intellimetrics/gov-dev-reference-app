// scripts/capstone/check-variant.mjs — the capstone's variant (lesson 38).
// modernization/variant.json declares what this rebuild is; modernization/supported-variants.json
// (a referee file) says what each choice ADDS. The baseline always runs: a variant can add
// obligations and never remove one. Two outcomes, reported separately:
//   local       every local check passed (ci-out/checks/<id>.pass exists)
//   deployment  every deployment check has evidence (evidence/deployment/<id>.json, with
//               "result": "pass" and a named "by"); a NOT RUN line never counts here.
// Usage: node scripts/capstone/check-variant.mjs [repo-root]  -> exit 0 only if the variant is valid.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? '.';
const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const registry = read('modernization/supported-variants.json');
const variant = read('modernization/variant.json');
const problems = [];

const FIELDS = Object.keys(registry.fields);
for (const k of Object.keys(variant)) if (!FIELDS.includes(k)) problems.push(`variant.json: unknown field "${k}"`);
for (const k of FIELDS) {
  if (!(k in variant)) problems.push(`variant.json: missing "${k}" (one of: ${Object.keys(registry.fields[k]).join(', ')})`);
  else if (!(variant[k] in registry.fields[k])) problems.push(`variant.json: ${k} "${variant[k]}" is not supported (one of: ${Object.keys(registry.fields[k]).join(', ')})`);
}
for (const rule of registry.incompatible) {
  const applies = Object.entries(rule.when).every(([k, v]) => variant[k] === v);
  if (applies) for (const [k, bad] of Object.entries(rule.forbid)) if (bad.includes(variant[k])) problems.push(`variant.json: ${k} "${variant[k]}" with ${JSON.stringify(rule.when)}: ${rule.why}`);
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }

const add = (kind) => [...new Set([...registry.baseline[kind], ...FIELDS.flatMap((k) => registry.fields[k][variant[k]][kind])])];
const local = add('local');
const deployment = add('deployment');

const localDone = local.filter((id) => existsSync(join(root, `ci-out/checks/${id}.pass`)));
const deployDone = deployment.filter((id) => {
  const f = join(root, `evidence/deployment/${id.replace(/[:/]/g, '_')}.json`);
  if (!existsSync(f)) return false;
  try { const e = JSON.parse(readFileSync(f, 'utf8')); return e.result === 'pass' && typeof e.by === 'string' && e.by.length > 0; }
  catch { return false; }
});

for (const id of local) console.log(`${localDone.includes(id) ? 'PASS   ' : 'MISSING'}  local       ${id}`);
for (const id of deployment) console.log(`${deployDone.includes(id) ? 'PASS   ' : 'NOT RUN'}  deployment  ${id}`);
console.log(`Local exercise:      ${localDone.length === local.length ? 'COMPLETE' : 'INCOMPLETE'} (${localDone.length}/${local.length})`);
console.log(`Deployment evidence: ${deployDone.length === deployment.length ? 'COMPLETE' : 'INCOMPLETE'} (${deployDone.length}/${deployment.length})`);
