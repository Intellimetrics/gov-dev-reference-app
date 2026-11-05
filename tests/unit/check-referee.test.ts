// The referee checker against a fixture repository per code host, plus the bypasses each host allows.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(__dirname, '../../scripts/parity/check-referee.mjs');
const COMMON = ['tests/differential/', 'tests/parity/', 'modernization/rules.md', 'modernization/unknowns.md', 'modernization/golden/',
  'modernization/scripts/', 'modernization/parity/rulings/', 'modernization/parity/equivalent-mutants.txt', 'modernization/referee-paths.txt',
  'modernization/owner-teams.txt', 'modernization/variant.json', 'modernization/supported-variants.json', 'scripts/capstone/', 'scripts/parity/', 'scripts/verify-cold.sh', 'stryker.config.json', 'vitest.config.ts', 'package.json',
  'evidence/parity-report.json', 'evidence/evidence-manifest.json', '.claude/'];
const HOST_PATHS: Record<string, string[]> = {
  github: ['.github/CODEOWNERS', '.github/workflows/'], gitlab: ['CODEOWNERS', '.gitlab-ci.yml'],
  bitbucket: ['.bitbucket/CODEOWNERS', 'bitbucket-pipelines.yml'], 'azure-devops': ['azure-pipelines.yml'],
};

function repo(host: string, files: Record<string, string>, referee = [...COMMON, ...HOST_PATHS[host]]) {
  const dir = mkdtempSync(join(tmpdir(), `referee-${host}-`));
  const all = { 'modernization/referee-paths.txt': referee.join('\n'), 'modernization/parity/equivalent-mutants.txt': '', 'src/a.ts': 'export {};', ...files };
  for (const [p, c] of Object.entries(all)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); }
  const r = spawnSync('node', [SCRIPT, dir], { env: { ...process.env, REPO_HOST: host }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}
const owners = (host: string, team: string, extra = '') =>
  [...COMMON, ...HOST_PATHS[host]].map((p) => `/${p} ${team}`).join('\n') + (extra ? `\n${extra}` : '');

describe('github', () => {
  it('passes when every referee path is owned by a team', () => expect(repo('github', { '.github/CODEOWNERS': owners('github', '@agency/intake-owners') }).code).toBe(0));
  it('fails when a later, narrower line hands a file to the agent', () => {
    const r = repo('github', { '.github/CODEOWNERS': owners('github', '@agency/intake-owners', '/tests/parity/replay.test.ts @intake-parity-agent') });
    expect(r.code).toBe(1); expect(r.out).toMatch(/inside referee path tests\/parity\//);
  });
  it('accepts a leading * default line and directory rules without a trailing slash', () => {
    const body = '* @agency/app-reviewers\n' + [...COMMON, ...HOST_PATHS.github].map((p) => `/${p.replace(/\/$/, '')} @agency/intake-owners`).join('\n');
    expect(repo('github', { '.github/CODEOWNERS': body }).code).toBe(0);
  });
  it('a * default owned by a person does not count for paths a team line covers, but fails where it is the last match', () => {
    const body = '* @jdoe\n' + [...COMMON, ...HOST_PATHS.github].filter((p) => p !== 'package.json').map((p) => `/${p} @agency/intake-owners`).join('\n');
    expect(repo('github', { '.github/CODEOWNERS': body }).out).toMatch(/package.json: effective owners \(\*\) are not all teams/);
  });
  it('fails when the referee list shrinks', () => {
    const r = repo('github', { '.github/CODEOWNERS': owners('github', '@agency/intake-owners') }, COMMON.slice(1).concat(HOST_PATHS.github));
    expect(r.out).toMatch(/missing tests\/differential\//);
  });
});

describe('gitlab', () => {
  const teams = { 'modernization/owner-teams.txt': '@agency/intake-owners' };
  it('passes with a required section whose default owners are a listed team', () => {
    const body = '[Referee] @agency/intake-owners\n' + [...COMMON, ...HOST_PATHS.gitlab].map((p) => `/${p}`).join('\n');
    expect(repo('gitlab', { ...teams, CODEOWNERS: body }).code).toBe(0);
  });
  it('fails when the only covering section is optional (^), which requires no approval', () => {
    const body = '^[Referee] @agency/intake-owners\n' + [...COMMON, ...HOST_PATHS.gitlab].map((p) => `/${p}`).join('\n');
    const r = repo('gitlab', { ...teams, CODEOWNERS: body });
    expect(r.code).toBe(1); expect(r.out).toMatch(/no required CODEOWNERS section covers/);
  });
  it('treats two sections with the same name as one section', () => {
    const half = [...COMMON, ...HOST_PATHS.gitlab];
    const body = '[Referee] @agency/intake-owners\n' + half.slice(0, 5).map((p) => `/${p}`).join('\n') + '\n[Referee] @agency/intake-owners\n' + half.slice(5).map((p) => `/${p}`).join('\n');
    expect(repo('gitlab', { ...teams, CODEOWNERS: body }).code).toBe(0);
  });
  it('fails when another section gives a path to an owner that is not a listed team', () => {
    const body = owners('gitlab', '@agency/intake-owners') + '\n[Fast lane]\n/tests/parity/ @jdoe';
    expect(repo('gitlab', { ...teams, CODEOWNERS: body }).out).toMatch(/in \[Fast lane\]\) are not all teams/);
  });
  it('fails when the owners file is not where the referee list protects it', () => {
    expect(repo('gitlab', { ...teams, '.gitlab/CODEOWNERS': owners('gitlab', '@agency/intake-owners') }).out).toMatch(/keep it at CODEOWNERS/);
  });
});

describe('bitbucket', () => {
  it('passes on declared team owners and says approval is enforced elsewhere', () => {
    const r = repo('bitbucket', { 'modernization/owner-teams.txt': '@intake-owners', '.bitbucket/CODEOWNERS': owners('bitbucket', '@intake-owners') });
    expect(r.code).toBe(0); expect(r.out).toMatch(/compensating check in lesson 37/);
  });
});

describe('azure-devops', () => {
  const T = 'fd2167ab-b0be-447a-8ec8-39368250530e';
  const GROUP = '3c4b7f1e-0000-4000-8000-00000000abcd';
  const policy = (paths: string[], over: object = {}) => ({ id: 7, isEnabled: true, isBlocking: true, isDeleted: false, type: { id: T },
    settings: { requiredReviewerIds: [GROUP], filenamePatterns: paths.map((p) => (p.endsWith('/') ? `/${p}*` : `/${p}`)), scope: [{ refName: 'refs/heads/main', matchKind: 'exact', repositoryId: null }] }, ...over });
  const files = (pol: object[]) => ({ 'modernization/owner-teams.txt': GROUP, 'ci-out/branch-policies.json': JSON.stringify(pol) });
  const all = [...COMMON, ...HOST_PATHS['azure-devops']];
  it('passes when blocking required-reviewer policies cover every path with a listed group', () => expect(repo('azure-devops', files([policy(all)])).code).toBe(0));
  it('fails when the policy is optional (not blocking)', () => {
    expect(repo('azure-devops', files([policy(all, { isBlocking: false })])).out).toMatch(/no enabled, blocking required-reviewer policy covers/);
  });
  it('fails when a policy names a reviewer that is not a listed group', () => {
    expect(repo('azure-devops', files([policy(all), { ...policy(['tests/parity/']), id: 8, settings: { requiredReviewerIds: ['someone'], filenamePatterns: ['/tests/parity/*'], scope: [{ refName: 'refs/heads/main', matchKind: 'exact', repositoryId: null }] } }])).out)
      .toMatch(/policy 8 names reviewers/);
  });
  it('fails when the policy applies to another branch than the protected one', () => {
    const other = policy(all, { settings: { requiredReviewerIds: [GROUP], filenamePatterns: all.map((p) => (p.endsWith('/') ? `/${p}*` : `/${p}`)), scope: [{ refName: 'refs/heads/feature/x', matchKind: 'exact', repositoryId: null }] } });
    expect(repo('azure-devops', files([other])).out).toMatch(/no enabled, blocking required-reviewer policy covers/);
  });
  it('fails without the exported policies', () => expect(repo('azure-devops', { 'modernization/owner-teams.txt': GROUP }).out).toMatch(/export the branch policies/));
});
