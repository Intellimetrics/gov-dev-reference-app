// scripts/parity/check-referee.mjs — every referee path, and every file under it, is owned only by
// teams, never by the agent, so no change to it merges without a code owner's review.
// It reads files, so it proves ownership is DECLARED. Whether the host enforces it is a setting
// checked by a person (lesson 38's checklist). One adapter per code host (REPO_HOST):
//   github (default) and bitbucket: CODEOWNERS, last matching line wins;
//   gitlab: CODEOWNERS with [Sections]; ^[optional] sections require no approval;
//   azure-devops: no owners file; the exported required-reviewer policies are checked instead.
// Usage: REPO_HOST=<host> node scripts/parity/check-referee.mjs [repo-root]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? '.';
const at = (p) => join(root, p);
const HOST = process.env.REPO_HOST ?? 'github';
const AGENT_ACCOUNTS = ['@intake-parity-agent'];          // the accounts the agent commits and opens PRs as
const HOSTS = {
  github: { owners: ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'], pipeline: ['.github/workflows/'] },
  gitlab: { owners: ['CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS'], pipeline: ['.gitlab-ci.yml'] },
  bitbucket: { owners: ['.bitbucket/CODEOWNERS'], pipeline: ['bitbucket-pipelines.yml'] },
  'azure-devops': { owners: [], pipeline: ['azure-pipelines.yml'] },
};
const host = HOSTS[HOST];
if (!host) { console.error(`REPO_HOST must be one of: ${Object.keys(HOSTS).join(', ')}`); process.exit(1); }

const MUST_PROTECT = ['tests/differential/', 'tests/parity/', 'modernization/rules.md', 'modernization/unknowns.md',
  'modernization/golden/', 'modernization/scripts/', 'modernization/parity/rulings/',
  'modernization/parity/equivalent-mutants.txt', 'modernization/referee-paths.txt', 'modernization/owner-teams.txt',
  'scripts/parity/', 'scripts/verify-cold.sh', 'stryker.config.json', 'vitest.config.ts', 'package.json',
  'evidence/parity-report.json', 'evidence/evidence-manifest.json', '.claude/', ...host.owners.slice(0, 1), ...host.pipeline];
                                                         // a shrunken referee-paths.txt fails here

const lines = (f) => readFileSync(at(f), 'utf8').split('\n').map((s) => s.split('#')[0].trim()).filter(Boolean);
const problems = [];
const referee = lines('modernization/referee-paths.txt');
for (const p of MUST_PROTECT) if (!referee.includes(p)) problems.push(`referee-paths.txt is missing ${p}`);

// Which owners count as a team. GitHub writes teams as @org/team; the other hosts cannot be told
// apart from people by syntax, so they name their teams (or, on Azure DevOps, group ids) in a file.
const teams = existsSync(at('modernization/owner-teams.txt')) ? new Set(lines('modernization/owner-teams.txt')) : new Set();
const isTeam = (o) => (HOST === 'github' ? /^@[\w.-]+\/[\w.-]+$/.test(o) : teams.has(o));
const badOwners = (owners) => owners.length === 0 || owners.some((o) => !isTeam(o) || AGENT_ACCOUNTS.includes(o));
const covers = (pattern, path) => pattern === `/${path}` || (pattern.endsWith('/') && `/${path}`.startsWith(pattern));
const inside = (pattern, dir) => dir.endsWith('/') && pattern.startsWith(`/${dir}`);

if (HOST === 'azure-devops') {
  // Export first: az repos policy list --branch main --output json > ci-out/branch-policies.json
  const REQUIRED_REVIEWERS = 'fd2167ab-b0be-447a-8ec8-39368250530e';   // the policy type id
  const f = 'ci-out/branch-policies.json';
  if (!existsSync(at(f))) { console.error(`no ${f}: export the branch policies first`); process.exit(1); }
  const policies = JSON.parse(readFileSync(at(f), 'utf8'))
    .filter((p) => p.type?.id === REQUIRED_REVIEWERS && p.isEnabled && p.isBlocking && !p.isDeleted);
  // Only exact paths and "dir/*" filters are read here; anything else needs a person.
  const filterCovers = (pat, path) => {
    const p = pat.startsWith('/') ? pat : `/${pat}`;
    return p === `/${path}` || (p.endsWith('/*') && `/${path}`.startsWith(p.slice(0, -1)));
  };
  for (const p of policies) for (const pat of p.settings?.filenamePatterns ?? []) {
    if (!/^\/?[\w./-]+(\/\*)?$/.test(pat)) problems.push(`policy ${p.id}: filter ${pat} is not an exact path or dir/*; check it by hand`);
  }
  for (const path of referee) {
    const hits = policies.filter((p) => (p.settings?.filenamePatterns ?? []).some((pat) => filterCovers(pat, path)));
    if (!hits.length) problems.push(`${path}: no enabled, blocking required-reviewer policy covers it`);
    for (const p of hits) if (badOwners(p.settings?.requiredReviewerIds ?? [])) problems.push(`${path}: policy ${p.id} names reviewers that are not listed teams`);
  }
} else {
  const ownersFile = host.owners.find((f) => existsSync(at(f)));      // the host reads the first one it finds
  if (!ownersFile) { console.error(`no CODEOWNERS in ${host.owners.join(', ')}`); process.exit(1); }
  if (ownersFile !== host.owners[0]) problems.push(`CODEOWNERS is at ${ownersFile}; keep it at ${host.owners[0]}, the path the referee list protects`);
  // Rules grouped by section. GitHub and Bitbucket have one implicit, required section.
  const rules = [];
  let section = { name: '(none)', optional: false, defaults: [] };
  for (const l of lines(ownersFile)) {
    const head = HOST === 'gitlab' && l.match(/^(\^)?\[([^\]]+)\](?:\[\d+\])?\s*(.*)$/);
    if (head) { section = { name: head[2], optional: !!head[1], defaults: head[3].split(/\s+/).filter(Boolean) }; continue; }
    const [pattern, ...owners] = l.split(/\s+/);
    rules.push({ pattern, owners: owners.length ? owners : section.defaults, section });
  }
  for (const r of rules) if (/[*?[\]!]/.test(r.pattern) || !r.pattern.startsWith('/')) problems.push(`CODEOWNERS ${r.pattern}: only root-anchored paths are supported here`);
  for (const path of referee) {
    // Last matching line wins, within each section (GitLab evaluates every section).
    const effective = [...new Set(rules.map((r) => r.section))]
      .map((s) => rules.filter((r) => r.section === s && covers(r.pattern, path)).at(-1)).filter(Boolean);
    if (!effective.some((r) => !r.section.optional)) problems.push(`${path}: no required CODEOWNERS section covers it`);
    for (const r of effective) if (badOwners(r.owners)) problems.push(`${path}: effective owners (${r.pattern}${r.section.name === '(none)' ? '' : ` in [${r.section.name}]`}) are not all teams, or include the agent`);
    for (const r of rules.filter((x) => inside(x.pattern, path))) {   // a narrower line can hand one file away
      if (badOwners(r.owners)) problems.push(`${r.pattern}: inside referee path ${path}, owners are not all teams, or include the agent`);
    }
  }
  if (HOST === 'bitbucket') console.log('NOTE  Bitbucket has no required code-owner approval: the compensating check in lesson 37 enforces it');
}

// A "Stryker disable" comment removes a mutant from the score, the cheapest way to turn the mutation step
// green. Each one must be listed as "file:line M-nnnn", and that ruling must exist.
const allowed = new Set();
for (const entry of lines('modernization/parity/equivalent-mutants.txt')) {
  const [where, id] = entry.split(/\s+/);
  if (!/^M-\d{4}$/.test(id ?? '') || !existsSync(at(`modernization/parity/rulings/${id}.json`))) problems.push(`equivalent-mutants.txt ${where}: no ruling ${id ?? '(none given)'}`);
  else allowed.add(where);
}
for (const f of readdirSync(at('src'), { recursive: true }).map(String).filter((f) => /\.(c|m)?(t|j)sx?$/.test(f))) {
  readFileSync(at(`src/${f}`), 'utf8').split('\n').forEach((line, i) => {
    if (/stryker\s+disable/i.test(line) && !allowed.has(`src/${f}:${i + 1}`)) problems.push(`src/${f}:${i + 1}: Stryker disable with no ruling in equivalent-mutants.txt`);
  });
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`referee (${HOST}): ${referee.length} paths, each owned only by teams`);
