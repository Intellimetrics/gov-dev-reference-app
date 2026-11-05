// A seeded event generator and the invariants, written by hand: no property-testing dependency.
import { isBusinessDay } from './calendar.ts';
import { CaseEngine, FakeClock } from './engine.ts';
import { TRANSITIONS, type Case, type EventType, type Rules } from './machine.ts';

export const PROPERTY_SEED = 20261105;
export const PROPERTY_RUNS = 500;
export const STEPS = 30;

/** mulberry32: a small seeded generator, so a failing run replays from its seed alone. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPES = Object.values(TRANSITIONS).flatMap((m) => Object.keys(m)).filter((t, i, a) => a.indexOf(t) === i) as EventType[];
const ACTORS = ['a.nguyen', 'b.ortiz', 'triage-agent'];            // the agent drafts; it is never a person

export const START = '2026-10-30T15:00:00.000Z';                       // a Friday

function violations(before: Case, after: Case, rules: Rules): string[] {
  const bad: string[] = [];
  if (before.state === 'Closed' && JSON.stringify(before) !== JSON.stringify(after)) bad.push('an event changed a Closed case');
  if (after.state === 'Assigned' && !(after.timers.length === 1 && after.timers[0].kind === 'work_sla')) bad.push(`Assigned case has ${after.timers.length} open timers`);
  if (after.timers.length !== (after.state === 'Closed' ? 0 : 1)) bad.push(`${after.state} case has ${after.timers.length} open timers`);
  for (const t of after.timers) {
    if (!isBusinessDay(new Date(t.dueAt), rules.calendar)) bad.push(`${t.kind} is due on a non-business day: ${t.dueAt}`);
    if (t.dueAt <= t.openedAt) bad.push(`${t.kind} is due before it opened`);
  }
  return bad;
}

/** One generated life of a case. `daily` also settles the case every 24 hours between events. */
export function run(seed: number, rules: Rules, daily = false): { final: Case; bad: string[]; visited: Set<string> } {
  const next = rng(seed);
  const clock = new FakeClock(START);
  const engine = new CaseEngine(clock, rules);
  let c = engine.open('P-1');
  const bad: string[] = [];
  const visited = new Set<string>(['Submitted']);
  for (let i = 0; i < STEPS; i++) {
    const gap = next() < 0.15 ? 24 * (5 + Math.floor(next() * 12)) : Math.floor(next() * 72);
    for (let h = 0; daily && h + 24 <= gap; h += 24) { clock.advanceHours(24); engine.settle('P-1'); }
    clock.advanceHours(daily ? gap % 24 : gap);
    const before = engine.settle('P-1');
    const type = TYPES[Math.floor(next() * TYPES.length)];
    const by = ACTORS[Math.floor(next() * ACTORS.length)];
    const assignee = next() < 0.8 ? ACTORS[Math.floor(next() * 2)] : undefined;
    const reason = next() < 0.5 ? 'workload' : undefined;
    c = engine.send('P-1', { type, by, assignee, reason }).case;
    visited.add(c.state);
    bad.push(...violations(before, c, rules).map((m) => `step ${i} ${type}: ${m}`));
  }
  return { final: c, bad, visited };
}
