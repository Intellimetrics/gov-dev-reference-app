import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addBusinessDays, addCalendarDays } from '../../src/modernization/workflow/calendar.ts';
import { CaseEngine, FakeClock } from '../../src/modernization/workflow/engine.ts';
import { TRANSITIONS, defaultRules, type EventType, type Rules } from '../../src/modernization/workflow/machine.ts';
import { replay, replayAll, type LegacyHistory } from '../../src/modernization/workflow/parity.ts';
import { PROPERTY_RUNS, PROPERTY_SEED, run } from '../../src/modernization/workflow/property.ts';

const here = (p: string) => new URL(`../../fixtures/workflow/${p}`, import.meta.url);
const calendar = { holidays: new Set<string>(JSON.parse(readFileSync(here('calendar.json'), 'utf8')).holidays) };
const histories: LegacyHistory[] = JSON.parse(readFileSync(here('legacy-histories.json'), 'utf8'));
const rules = defaultRules(calendar);
const calendarDayRules: Rules = { calendar, deadline: addCalendarDays };

function started(r = rules) {
  const clock = new FakeClock('2026-11-02T09:00:00.000Z');          // a Monday
  const engine = new CaseEngine(clock, r);
  engine.open('C-1');
  return { clock, engine };
}

describe('business days (R-61)', () => {
  it('skips weekends and listed holidays', () => {
    expect(addBusinessDays(new Date('2026-10-30T15:00:00Z'), 1, calendar).toISOString()).toBe('2026-11-02T15:00:00.000Z');
    expect(addBusinessDays(new Date('2026-11-10T09:00:00Z'), 5, calendar).toISOString()).toBe('2026-11-18T09:00:00.000Z');
  });
  it('counting calendar days lands somewhere else, which is the planted fault', () => {
    expect(addCalendarDays(new Date('2026-10-30T15:00:00Z'), 1, calendar).toISOString()).toBe('2026-10-31T15:00:00.000Z');
  });
});

describe('case machine', () => {
  it('Closed accepts no event (R-60)', () => {
    const { engine } = started();
    engine.send('C-1', { type: 'withdraw', by: 'applicant' });
    const all = Object.values(TRANSITIONS).flatMap((m) => Object.keys(m)) as EventType[];
    for (const type of new Set(all)) {
      const out = engine.send('C-1', { type, by: 'a.nguyen', assignee: 'b.ortiz', reason: 'x' });
      expect(out.refused, type).toContain('not allowed in Closed');
      expect(out.case.state).toBe('Closed');
    }
  });

  it('the triage agent can draft but never assign or decide (R-63)', () => {
    const { engine } = started();
    expect(engine.send('C-1', { type: 'triage', by: 'triage-agent' }).refused).toContain('needs a named person');
    engine.send('C-1', { type: 'triage', by: 'a.nguyen' });
    const out = engine.send('C-1', { type: 'assign', by: 'triage-agent', assignee: 'b.ortiz' });
    expect(out.refused).toContain('needs a named person');
    expect(out.case.state).toBe('Triaged');
    expect(out.case.assignee).toBeNull();
  });

  it('a reassignment needs a reason and keeps the deadline (R-62, R-63)', () => {
    const { engine } = started();
    engine.send('C-1', { type: 'triage', by: 'a.nguyen' });
    const assigned = engine.send('C-1', { type: 'assign', by: 'a.nguyen', assignee: 'b.ortiz' }).case;
    expect(engine.send('C-1', { type: 'reassign', by: 'a.nguyen', assignee: 'c.diaz' }).refused).toContain('needs a reason');
    const moved = engine.send('C-1', { type: 'reassign', by: 'a.nguyen', assignee: 'c.diaz', reason: 'leave' }).case;
    expect(moved.assignee).toBe('c.diaz');
    expect(moved.timers).toEqual(assigned.timers);
  });

  it('a fired SLA escalates and re-arms; the documents timer closes the case (R-62)', () => {
    const { clock, engine } = started();
    clock.set('2026-11-05T09:00:00.000Z');                         // triage_sla was due Wed 11-04 09:00
    const c = engine.settle('C-1');
    expect(c.escalations).toBe(1);
    expect(c.timers[0]).toMatchObject({ kind: 'triage_sla', dueAt: '2026-11-06T09:00:00.000Z' });
    engine.send('C-1', { type: 'triage', by: 'a.nguyen' });
    engine.send('C-1', { type: 'assign', by: 'a.nguyen', assignee: 'b.ortiz' });
    engine.send('C-1', { type: 'request_documents', by: 'b.ortiz' });
    clock.set('2026-11-24T09:00:00.000Z');                         // docs_due was 10 business days out: Fri 11-20
    expect(engine.settle('C-1')).toMatchObject({ state: 'Closed', timers: [] });
  });

  it('noticing a timer late changes nothing: it fires at its own due time', () => {
    const a = started(); const b = started();
    a.clock.set('2026-11-20T09:00:00.000Z');
    a.engine.settle('C-1');
    for (let d = 3; d <= 20; d++) { b.clock.set(`2026-11-${String(d).padStart(2, '0')}T09:00:00.000Z`); b.engine.settle('C-1'); }
    expect(b.engine.get('C-1')).toEqual(a.engine.get('C-1'));
  });
});

describe('parity with the recorded legacy histories', () => {
  it('replays every history with the same state and pending timers after each event', () => {
    const { compared, divergences } = replayAll(histories, rules);
    expect(compared).toBe(7);
    expect(divergences, JSON.stringify(divergences[0])).toEqual([]);
  });

  it('counting calendar days is caught, and the report names the first divergent event', () => {
    const d = replay(histories.find((h) => h.caseId === 'H-1001')!, calendarDayRules);
    expect(d).toEqual({ caseId: 'H-1001', at: '2026-11-02T10:00:00.000Z', event: 'triage', field: 'escalations', legacy: 0, next: 1 });
    expect(replayAll(histories, calendarDayRules).divergences.length).toBeGreaterThan(1);
  });
});

describe(`generated case lives: seed ${PROPERTY_SEED}, ${PROPERTY_RUNS} runs`, () => {
  it('no event leaves a Closed case, every Assigned case has exactly one open work timer, and every timer is due on a business day', () => {
    const failures: string[] = [];
    for (let i = 0; i < PROPERTY_RUNS; i++) {
      const seed = PROPERTY_SEED + i;
      const { bad } = run(seed, rules);
      if (bad.length) failures.push(`seed ${seed}: ${bad[0]}`);
    }
    expect(failures, failures.slice(0, 3).join('\n')).toEqual([]);
  });

  it('the generator reaches every state, so the invariants are not checked on an empty set', () => {
    const seen = new Set<string>();
    for (let i = 0; i < PROPERTY_RUNS; i++) run(PROPERTY_SEED + i, rules).visited.forEach((s) => seen.add(s));
    expect([...seen].sort()).toEqual(['Assigned', 'AwaitingDocuments', 'Closed', 'Decided', 'Submitted', 'Triaged']);
  });

  it('settling every day gives the same case as settling only at events', () => {
    for (let i = 0; i < PROPERTY_RUNS; i++) {
      const seed = PROPERTY_SEED + i;
      expect(run(seed, rules, true).final, `seed ${seed}`).toEqual(run(seed, rules, false).final);
    }
  });

  it('the calendar-day fault fails the same run, with its seed', () => {
    const failures = Array.from({ length: PROPERTY_RUNS }, (_, i) => run(PROPERTY_SEED + i, calendarDayRules).bad[0]).filter(Boolean);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]).toContain('non-business day');
  });
});
