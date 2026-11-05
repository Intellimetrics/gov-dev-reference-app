#!/usr/bin/env python3
"""Stand-in for exporting the legacy case history and its audit trail. It does NOT import or mirror the TypeScript
machine: it is written the way a legacy poller would be (a list of rows, weekday() arithmetic, a loop that fires timers).
Real legacy: export the event table and the timer table instead, one row per event with the state read straight after it.
Usage: python3 record-standin.py > legacy-histories.json
       python3 record-standin.py --local > legacy-histories-local.json   (same recorder, business days counted in New York local time)"""
import json, sys
from datetime import datetime, timedelta, timezone

HOLIDAYS = set(json.load(open(__file__.replace("record-standin.py", "calendar.json")))["holidays"])
F = "%Y-%m-%dT%H:%M:%S.000Z"
def parse(s): return datetime.strptime(s, F).replace(tzinfo=timezone.utc)
def fmt(d): return d.strftime(F)

LOCAL = "--local" in sys.argv   # --local: count business days in America/New_York wall time, as a server-local legacy would (U-61)
if LOCAL:
    from zoneinfo import ZoneInfo
    NY = ZoneInfo("America/New_York")

def plus_bdays(start, n):
    if LOCAL:
        d, left = start.astimezone(NY), n
        while left:
            d = (d.replace(tzinfo=None) + timedelta(days=1)).replace(tzinfo=NY)   # same wall-clock time next day
            if d.weekday() < 5 and d.strftime("%Y-%m-%d") not in HOLIDAYS: left -= 1
        return d.astimezone(timezone.utc)
    d, left = start, n
    while left:
        d += timedelta(days=1)
        if d.weekday() < 5 and d.strftime("%Y-%m-%d") not in HOLIDAYS: left -= 1
    return d

SLA = {"Submitted": ("triage_sla", 2, "esc"), "Triaged": ("assign_sla", 1, "esc"), "Assigned": ("work_sla", 5, "esc"),
       "AwaitingDocuments": ("docs_due", 10, "close"), "Decided": ("auto_close", 3, "close")}
MOVES = {("Submitted", "triage"): "Triaged", ("Submitted", "withdraw"): "Closed", ("Triaged", "assign"): "Assigned",
         ("Triaged", "withdraw"): "Closed", ("Assigned", "reassign"): "Assigned", ("Assigned", "request_documents"): "AwaitingDocuments",
         ("Assigned", "decide"): "Decided", ("Assigned", "withdraw"): "Closed", ("AwaitingDocuments", "documents_received"): "Assigned",
         ("AwaitingDocuments", "withdraw"): "Closed", ("Decided", "close"): "Closed"}
PERSON_ONLY = {"triage", "assign", "reassign", "request_documents", "decide", "close"}
def person(s): return bool(s) and "." in s and s.replace(".", "").isalpha() and s.islower() and s.count(".") == 1

class Case:
    def __init__(self, opened):
        self.state, self.who, self.esc, self.timer = "Submitted", None, 0, None
        self.arm("Submitted", opened)
    def arm(self, state, frm, n=None):
        spec = SLA.get(state)
        self.timer = None if not spec else (spec[0], plus_bdays(frm, n or spec[1]))
    def fire_until(self, now):
        while self.timer and self.timer[1] <= now:
            kind, due = self.timer
            if SLA[self.state][2] == "close": self.state, self.timer = "Closed", None
            else: self.esc += 1; self.arm(self.state, due, 2)
    def apply(self, ev):
        move = MOVES.get((self.state, ev["type"]))
        if not move: return
        if ev["type"] in PERSON_ONLY and not person(ev["by"]): return
        if ev["type"] in ("assign", "reassign") and not person(ev.get("assignee", "")): return
        if ev["type"] == "reassign" and not (ev.get("reason") or "").strip(): return
        if ev["type"] in ("assign", "reassign") and ev.get("assignee"): self.who = ev["assignee"]
        if move != self.state: self.state = move; self.arm(move, parse(ev["at"]))
    def snap(self):
        return {"state": self.state, "assignee": self.who, "escalations": self.esc,
                "timers": [] if not self.timer else [{"kind": self.timer[0], "dueAt": fmt(self.timer[1])}]}

def ev(at, type, by="a.nguyen", **kw): return dict(at=at, type=type, by=by, **kw)
SCENARIOS = {
 "H-1001": ("2026-10-30T15:00:00.000Z", "2026-11-12T09:00:00.000Z", [
    ev("2026-11-02T10:00:00.000Z", "triage"), ev("2026-11-02T14:00:00.000Z", "assign", assignee="b.ortiz"),
    ev("2026-11-06T16:00:00.000Z", "decide", by="b.ortiz"), ev("2026-11-09T09:00:00.000Z", "close", by="a.nguyen")]),
 "H-1002": ("2026-11-04T09:00:00.000Z", "2026-11-12T09:00:00.000Z", [
    ev("2026-11-09T08:00:00.000Z", "triage")]),
 "H-1003": ("2026-11-09T12:00:00.000Z", "2026-11-17T12:00:00.000Z", [
    ev("2026-11-09T13:00:00.000Z", "triage"), ev("2026-11-10T09:00:00.000Z", "assign", assignee="b.ortiz")]),
 "H-1004": ("2026-11-02T09:00:00.000Z", "2026-12-01T09:00:00.000Z", [
    ev("2026-11-02T10:00:00.000Z", "triage"), ev("2026-11-02T11:00:00.000Z", "assign", assignee="b.ortiz"),
    ev("2026-11-12T09:00:00.000Z", "request_documents", by="b.ortiz")]),
 "H-1005": ("2026-11-02T09:00:00.000Z", "2026-11-13T09:00:00.000Z", [
    ev("2026-11-02T10:00:00.000Z", "triage"), ev("2026-11-02T11:00:00.000Z", "assign", by="triage-agent", assignee="b.ortiz"),
    ev("2026-11-02T12:00:00.000Z", "assign", assignee="b.ortiz"), ev("2026-11-04T09:00:00.000Z", "reassign", assignee="c.diaz"),
    ev("2026-11-05T09:00:00.000Z", "reassign", assignee="c.diaz", reason="b.ortiz is on leave")]),
 "H-1006": ("2026-11-02T09:00:00.000Z", "2026-11-09T09:00:00.000Z", [
    ev("2026-11-03T09:00:00.000Z", "withdraw", by="applicant"), ev("2026-11-03T10:00:00.000Z", "triage"),
    ev("2026-11-03T11:00:00.000Z", "assign", assignee="b.ortiz")]),
 "H-1007": ("2026-11-02T09:00:00.000Z", "2026-11-30T09:00:00.000Z", [
    ev("2026-11-02T10:00:00.000Z", "triage"), ev("2026-11-02T11:00:00.000Z", "assign", assignee="b.ortiz"),
    ev("2026-11-24T09:00:00.000Z", "decide", by="b.ortiz")]),
}
SCENARIOS["H-1008"] = ("2026-11-02T09:00:00.000Z", "2026-11-13T09:00:00.000Z", [
    ev("2026-11-02T10:00:00.000Z", "triage"), ev("2026-11-02T11:00:00.000Z", "assign", assignee="b.ortiz"),
    ev("2026-11-03T09:00:00.000Z", "request_documents", by="b.ortiz"),
    ev("2026-11-04T09:00:00.000Z", "documents_received", by="applicant", assignee="triage-agent")])
if LOCAL:   # Friday 2026-11-06 21:00 in New York (EST, UTC-5) is Saturday 02:00 UTC
    SCENARIOS = {"H-1009": ("2026-11-07T02:00:00.000Z", "2026-11-10T20:00:00.000Z", [])}
out = []
for cid, (opened, as_of, events) in SCENARIOS.items():
    c = Case(parse(opened)); rows = []
    for e in events:
        c.fire_until(parse(e["at"])); c.apply(e); rows.append({**e, "after": c.snap()})
    c.fire_until(parse(as_of))
    out.append({"caseId": cid, "openedAt": opened, "events": rows, "asOf": as_of, "final": c.snap()})
json.dump(out, sys.stdout, indent=1)
print()
