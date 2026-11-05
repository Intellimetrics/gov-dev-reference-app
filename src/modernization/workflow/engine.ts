// The machine reads time only through a Clock, so a test owns it.
import { fireDue, openCase, reduce, type Case, type CaseEvent, type Outcome, type Rules } from './machine.ts';

export interface Clock { now(): Date }

export class FakeClock implements Clock {
  private t: number;
  constructor(start: string) { this.t = Date.parse(start); }
  now() { return new Date(this.t); }
  set(iso: string) {
    if (Date.parse(iso) < this.t) throw new Error(`clock cannot go back to ${iso}`);
    this.t = Date.parse(iso);
  }
  advanceHours(h: number) { this.t += h * 3_600_000; }
}

export class CaseEngine {
  private cases = new Map<string, Case>();
  private clock: Clock;
  private rules: Rules;
  constructor(clock: Clock, rules: Rules) { this.clock = clock; this.rules = rules; }

  open(id: string): Case {
    const c = openCase(id, this.clock.now().toISOString(), this.rules);
    this.cases.set(id, c);
    return c;
  }
  /** Fire every timer that came due by now. Calling it often or rarely gives the same case. */
  settle(id: string): Case {
    const c = fireDue(this.get(id), this.clock.now(), this.rules);
    this.cases.set(id, c);
    return c;
  }
  send(id: string, e: Omit<CaseEvent, 'at'>): Outcome {
    this.settle(id);                                             // timers due by now fire before the event (U-62)
    const out = reduce(this.get(id), { ...e, at: this.clock.now().toISOString() }, this.rules);
    this.cases.set(id, out.case);
    return out;
  }
  get(id: string): Case {
    const c = this.cases.get(id);
    if (!c) throw new Error(`no case ${id}`);
    return c;
  }
}
