import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REF = join(__dirname, '../..');
function run(variant: object, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'variant-'));
  mkdirSync(join(dir, 'modernization'), { recursive: true });
  copyFileSync(join(REF, 'modernization/supported-variants.json'), join(dir, 'modernization/supported-variants.json'));
  writeFileSync(join(dir, 'modernization/variant.json'), JSON.stringify(variant));
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), c); }
  const r = spawnSync('node', [join(REF, 'scripts/capstone/check-variant.mjs'), dir], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}
const baseline = { cloud: 'local', boundaryProfile: 'none', codeHostEdition: 'github-cloud', legacyStack: 'classic-asp-sqlserver', appType: 'intake' };

describe('capstone variant', () => {
  it('the baseline variant lists every baseline check and is incomplete until each passes', () => {
    const r = run(baseline);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/MISSING  local       mutation/);
    expect(r.out).toMatch(/Local exercise:      INCOMPLETE \(0\/12\)/);
  });
  it('an extension adds obligations and never removes a baseline one', () => {
    const r = run({ ...baseline, appType: 'batch' });
    expect(r.out).toMatch(/local       batch-rerun-idempotent/);
    expect(r.out).toMatch(/local       mutation/);
  });
  it('local checks complete does not make deployment complete; NOT RUN never counts', () => {
    const checks = Object.fromEntries(['typecheck', 'unit', 'contract', 'differential', 'property-replay', 'mutation', 'referee', 'rulings', 'traceability', 'evidence-hashes', 'db-contract-rules', 'pipeline-yaml:github'].map((id) => [`ci-out/checks/${id}.pass`, '']));
    const r = run(baseline, checks);
    expect(r.out).toMatch(/Local exercise:      COMPLETE/);
    expect(r.out).toMatch(/Deployment evidence: INCOMPLETE \(0\/8\)/);
  });
  it('deployment evidence counts only with result pass and a named person', () => {
    const r = run({ ...baseline, cloud: 'azure', boundaryProfile: 'fedramp-high' }, {
      'evidence/deployment/signin_azure.json': JSON.stringify({ result: 'pass', by: 'j.rivera' }),
      'evidence/deployment/deploy_azure.json': JSON.stringify({ result: 'pass' }),
    });
    expect(r.out).toMatch(/PASS     deployment  signin:azure/);
    expect(r.out).toMatch(/NOT RUN  deployment  deploy:azure/);
  });
  it('refuses an unsupported value, a missing field, an unknown field, and an incompatible pair', () => {
    expect(run({ ...baseline, appType: 'mainframe-ui' }).out).toMatch(/appType "mainframe-ui" is not supported/);
    const { appType, ...noApp } = baseline;
    expect(run(noApp).out).toMatch(/missing "appType"/);
    expect(run({ ...baseline, skipChecks: ['mutation'] }).out).toMatch(/unknown field "skipChecks"/);
    const r = run({ ...baseline, boundaryProfile: 'il4' });
    expect(r.code).toBe(1); expect(r.out).toMatch(/a laptop has no authorization boundary/);
  });
});
