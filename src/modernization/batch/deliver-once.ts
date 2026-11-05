// src/modernization/batch/deliver-once.ts
// A child-process entry point for the concurrency tests: one OS process delivers a run of
// business dates into a shared destination, after waiting for a shared start time so that
// two such processes really do collide. Prints one JSON line per date.
import { directorySink, runExport, ConflictingRedelivery, type ExportRow } from './run-ledger.ts';

const [outDir, workDir, startAt, variant, count] = process.argv.slice(2);
const rows = (): ExportRow[] => [
  { caseId: 10231, caseType: 'ROUTINE', status: variant === 'b' ? 'CLOSED' : 'OPEN', submittedAt: '2026-11-04T08:15:02.123Z' },
];

const inner = directorySink(outDir);
const log: string[] = [];
const sink = { put: (n: string, b: Buffer) => { const r = inner.put(n, b); log.push(r); return r; } };

while (Date.now() < Number(startAt)) { /* spin: both processes leave this loop in the same millisecond */ }
const results: Record<string, string> = {};
for (let i = 0; i < Number(count); i++) {
  const businessDate = `2026-12-${String(i + 1).padStart(2, '0')}`;
  log.length = 0;
  try {
    runExport({ businessDate, workDir, rowsFor: rows, sink });
    results[businessDate] = log[0] ?? 'skipped';
  } catch (e) {
    if (!(e instanceof ConflictingRedelivery)) throw e;
    results[businessDate] = 'conflict';
  }
}
console.log(JSON.stringify(results));
