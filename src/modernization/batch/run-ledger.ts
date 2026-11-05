// src/modernization/batch/run-ledger.ts
// Idempotent re-delivery (lesson 30): one business date is delivered once, however many
// times the job runs, restarts or is re-triggered.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DeliverySink {
  // Same name and same bytes again returns 'unchanged'. Same name, different bytes throws.
  put(name: string, bytes: Buffer): 'created' | 'unchanged';
}

export interface ExportRow { caseId: number; caseType: string; status: string; submittedAt: string }

export class ConflictingRedelivery extends Error {}

// A destination folder that refuses to overwrite a delivered file with different bytes.
export function directorySink(dir: string): DeliverySink {
  mkdirSync(dir, { recursive: true });
  return {
    put(name, bytes) {
      const dest = join(dir, name);
      if (existsSync(dest)) {
        if (sha(readFileSync(dest)) === sha(bytes)) return 'unchanged';
        throw new ConflictingRedelivery(`${name} was already delivered with different content`);
      }
      saveAtomically(dest, bytes);
      return 'created';
    },
  };
}

type Entry = { state: 'built' | 'delivered'; sha256: string; file: string };
type Ledger = Record<string, Entry>;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// Same rows in, same bytes out: sorted by key, fixed formatting, no wall-clock value.
export function renderExport(rows: ExportRow[]): Buffer {
  const lines = [...rows]
    .sort((a, b) => a.caseId - b.caseId)
    .map((r) => [r.caseId, r.caseType, r.status, r.submittedAt].join(','));
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

function saveAtomically(path: string, content: string | Buffer) {
  const tmp = `${path}.part`;
  writeFileSync(tmp, content);
  renameSync(tmp, path); // readers see the old file or the new one, never half of it
}

export interface RunOptions {
  businessDate: string; // 'YYYY-MM-DD': the delivery key
  workDir: string;
  rowsFor: (businessDate: string) => ExportRow[];
  sink: DeliverySink;
  // Test seam: throw at a named step to simulate a crash.
  crashAt?: 'after-build' | 'after-put';
}

export function runExport(o: RunOptions): { status: 'delivered' | 'already-delivered'; sha256: string } {
  mkdirSync(o.workDir, { recursive: true });
  const ledgerPath = join(o.workDir, 'run-ledger.json');
  const ledger: Ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : {};
  const save = () => saveAtomically(ledgerPath, JSON.stringify(ledger, null, 2));
  const name = `intake-export-${o.businessDate}.csv`;
  const path = join(o.workDir, name);

  const done = ledger[o.businessDate];
  if (done?.state === 'delivered') return { status: 'already-delivered', sha256: done.sha256 };

  // Reuse the file a crashed run built, if it is intact; otherwise build it again.
  let bytes: Buffer;
  if (done?.state === 'built' && existsSync(path) && sha(readFileSync(path)) === done.sha256) {
    bytes = readFileSync(path);
  } else {
    bytes = renderExport(o.rowsFor(o.businessDate));
    saveAtomically(path, bytes);
    ledger[o.businessDate] = { state: 'built', sha256: sha(bytes), file: name };
    save();
  }
  if (o.crashAt === 'after-build') throw new Error('simulated crash after build');

  o.sink.put(name, bytes); // 'unchanged' means a crashed run already delivered it
  if (o.crashAt === 'after-put') throw new Error('simulated crash after put');
  ledger[o.businessDate] = { state: 'delivered', sha256: sha(bytes), file: name };
  save();
  return { status: 'delivered', sha256: sha(bytes) };
}
