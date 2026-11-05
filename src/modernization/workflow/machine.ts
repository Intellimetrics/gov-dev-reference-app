// The case machine for what happens after intake: data plus one pure reducer. It never reads a clock;
// every event carries its own `at`, and a timer fires at its own due time, whenever it is noticed.
import { addBusinessDays, type Calendar } from './calendar.ts';

export type State = 'Submitted' | 'Triaged' | 'Assigned' | 'AwaitingDocuments' | 'Decided' | 'Closed';
export type EventType = 'triage' | 'assign' | 'reassign' | 'request_documents' | 'documents_received' | 'decide' | 'withdraw' | 'close';
export type Guard = 'person' | 'reason' | 'assignee';
export type TimerKind = 'triage_sla' | 'assign_sla' | 'work_sla' | 'docs_due' | 'auto_close';

export type CaseEvent = { type: EventType; at: string; by: string; assignee?: string; reason?: string };
export type Timer = { kind: TimerKind; openedAt: string; dueAt: string };
export type Case = { id: string; state: State; assignee: string | null; escalations: number; timers: Timer[] };
export type Rules = { calendar: Calendar; deadline: (from: Date, days: number, cal: Calendar) => Date };

// R-60: the only moves. Anything not listed is refused and leaves the case unchanged; Closed lists nothing.
export const TRANSITIONS: Record<State, Partial<Record<EventType, { to: State; guards: Guard[] }>>> = {
  Submitted:         { triage: { to: 'Triaged', guards: ['person'] }, withdraw: { to: 'Closed', guards: [] } },
  Triaged:           { assign: { to: 'Assigned', guards: ['person', 'assignee'] }, withdraw: { to: 'Closed', guards: [] } },
  Assigned:          { reassign: { to: 'Assigned', guards: ['person', 'assignee', 'reason'] },
                       request_documents: { to: 'AwaitingDocuments', guards: ['person'] },
                       decide: { to: 'Decided', guards: ['person'] }, withdraw: { to: 'Closed', guards: [] } },
  AwaitingDocuments: { documents_received: { to: 'Assigned', guards: [] }, withdraw: { to: 'Closed', guards: [] } },
  Decided:           { close: { to: 'Closed', guards: ['person'] } },
  Closed:            {},
};

// R-61 and R-62: each open state arms one timer in business days. A fired SLA escalates and re-arms;
// docs_due and auto_close close the case. Closed arms nothing.
export const TIMERS: Record<State, { kind: TimerKind; businessDays: number; onFire: 'escalate' | 'close' } | null> = {
  Submitted:         { kind: 'triage_sla', businessDays: 2, onFire: 'escalate' },
  Triaged:           { kind: 'assign_sla', businessDays: 1, onFire: 'escalate' },
  Assigned:          { kind: 'work_sla', businessDays: 5, onFire: 'escalate' },
  AwaitingDocuments: { kind: 'docs_due', businessDays: 10, onFire: 'close' },
  Decided:           { kind: 'auto_close', businessDays: 3, onFire: 'close' },
  Closed:            null,
};
export const REARM_BUSINESS_DAYS = 2;

// R-63: a named person acts; the triage agent only drafts. A reassignment also carries its reason.
const PERSON = /^[a-z]+\.[a-z]+$/;
export const GUARDS: Record<Guard, (e: CaseEvent) => string | null> = {
  person: (e) => (PERSON.test(e.by) ? null : `${e.type} needs a named person, not "${e.by}"`),
  assignee: (e) => (e.assignee && PERSON.test(e.assignee) ? null : `${e.type} needs an assignee`),
  reason: (e) => (e.reason?.trim() ? null : `${e.type} needs a reason`),
};

export type Outcome = { case: Case; refused: string | null };

const arm = (spec: { kind: TimerKind; businessDays: number }, from: string, rules: Rules, days = spec.businessDays): Timer =>
  ({ kind: spec.kind, openedAt: from, dueAt: rules.deadline(new Date(from), days, rules.calendar).toISOString() });

export function openCase(id: string, at: string, rules: Rules): Case {
  return { id, state: 'Submitted', assignee: null, escalations: 0, timers: [arm(TIMERS.Submitted!, at, rules)] };
}

export function reduce(c: Case, e: CaseEvent, rules: Rules): Outcome {
  const move = TRANSITIONS[c.state][e.type];
  if (!move) return { case: c, refused: `${e.type} is not allowed in ${c.state}` };
  for (const g of move.guards) {
    const why = GUARDS[g](e);
    if (why) return { case: c, refused: why };
  }
  const assigns = e.type === 'assign' || e.type === 'reassign';  // only these two events may change the assignee
  const next: Case = { ...c, state: move.to, assignee: assigns ? (e.assignee ?? c.assignee) : c.assignee };
  if (move.to !== c.state) {                                    // a reassignment keeps its deadline (R-62, a legacy quirk)
    const spec = TIMERS[move.to];
    next.timers = spec ? [arm(spec, e.at, rules)] : [];
  }
  return { case: next, refused: null };
}

/** A timer reaching its due time is an event of its own, stamped with the due time, not the time it was noticed. */
export function fireDue(c: Case, now: Date, rules: Rules): Case {
  let cur = c;
  while (cur.timers.length && new Date(cur.timers[0].dueAt) <= now) {
    const spec = TIMERS[cur.state]!;
    const at = cur.timers[0].dueAt;
    cur = spec.onFire === 'close'
      ? { ...cur, state: 'Closed', timers: [] }
      : { ...cur, escalations: cur.escalations + 1, timers: [arm(spec, at, rules, REARM_BUSINESS_DAYS)] };
  }
  return cur;
}

export const defaultRules = (calendar: Calendar): Rules => ({ calendar, deadline: addBusinessDays });
