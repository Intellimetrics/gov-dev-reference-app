// Replay a recorded legacy case history through the new machine and compare, after every event,
// the state and the pending timers. The first difference is the report.
import { CaseEngine, FakeClock } from './engine.ts';
import type { Case, EventType, Rules } from './machine.ts';

export type Observation = { state: string; assignee: string | null; escalations: number; timers: { kind: string; dueAt: string }[] };
export type LegacyEvent = { at: string; type: EventType; by: string; assignee?: string; reason?: string; after: Observation };
export type LegacyHistory = { caseId: string; openedAt: string; events: LegacyEvent[]; asOf: string; final: Observation };
export type Divergence = { caseId: string; at: string; event: string; field: string; legacy: unknown; next: unknown };

export const observe = (c: Case): Observation =>
  ({ state: c.state, assignee: c.assignee, escalations: c.escalations, timers: c.timers.map((t) => ({ kind: t.kind, dueAt: t.dueAt })) });

/** The first field that differs, in a fixed order: state, assignee, escalations, then each timer. */
function firstDifference(legacy: Observation, next: Observation): { field: string; legacy: unknown; next: unknown } | null {
  for (const f of ['state', 'assignee', 'escalations'] as const) {
    if (legacy[f] !== next[f]) return { field: f, legacy: legacy[f], next: next[f] };
  }
  if (legacy.timers.length !== next.timers.length) {
    return { field: 'timers.length', legacy: legacy.timers.map((t) => t.kind), next: next.timers.map((t) => t.kind) };
  }
  for (let i = 0; i < legacy.timers.length; i++) {
    for (const f of ['kind', 'dueAt'] as const) {
      if (legacy.timers[i][f] !== next.timers[i][f]) return { field: `timers[${i}].${f}`, legacy: legacy.timers[i][f], next: next.timers[i][f] };
    }
  }
  return null;
}

export function replay(h: LegacyHistory, rules: Rules): Divergence | null {
  const clock = new FakeClock(h.openedAt);
  const engine = new CaseEngine(clock, rules);
  engine.open(h.caseId);
  for (const ev of h.events) {
    clock.set(ev.at);
    const { type, by, assignee, reason } = ev;
    const { case: c } = engine.send(h.caseId, { type, by, assignee, reason });
    const d = firstDifference(ev.after, observe(c));
    if (d) return { caseId: h.caseId, at: ev.at, event: ev.type, ...d };
  }
  clock.set(h.asOf);
  const d = firstDifference(h.final, observe(engine.settle(h.caseId)));
  return d && { caseId: h.caseId, at: h.asOf, event: '(as of)', ...d };
}

export function replayAll(histories: LegacyHistory[], rules: Rules) {
  const divergences = histories.map((h) => replay(h, rules)).filter((d): d is Divergence => d !== null);
  return { compared: histories.length, divergences };
}
