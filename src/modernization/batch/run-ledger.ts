// src/modernization/batch/run-ledger.ts
// Idempotent re-delivery (lesson 30): one business date is delivered once, however many
// times the job runs, restarts or is re-triggered.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DeliverySink {
  // Same name and same bytes again returns 'unchanged'. Same name, different bytes throws.
  put(name: string, bytes: Buffer): 'created' | 'unchanged';
}

export interface ExportRow { caseId: number; caseType: string; status: string; submittedAt: string }

export class ConflictingRedelivery extends Error {}

// A destination folder that refuses to overwrite a delivered file with different bytes.
// The create is atomic and conditional: the bytes go to a temp file that is unique to this call,
// then linkSync(temp, dest) makes dest appear complete or fails with EEXIST. There is no
// separate "does it exist" check for another process to slip between. A production sink also
// fsyncs the temp file before the link and the directory after it, so a power cut cannot leave
// a delivered name with unwritten bytes; this demo omits both. (linkSync needs a local
// POSIX-style filesystem. On an object store the same step is a conditional put, If-None-Match.)
export function directorySink(dir: string, seam: { beforeLink?: (name: string) => void } = {}): DeliverySink {
  mkdirSync(dir, { recursive: true });
  return {
    put(name, bytes) {
      const dest = join(dir, name);
      const tmp = join(dir, `.${name}.${process.pid}.${randomUUID()}.part`);
      writeFileSync(tmp, bytes);
      try {
        seam.beforeLink?.(name);
        linkSync(tmp, dest);
        return 'created';
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        if (sha(readFileSync(dest)) === sha(bytes)) return 'unchanged';
        throw new ConflictingRedelivery(`${name} was already delivered with different content`);
      } finally {
        unlinkSync(tmp);
      }
    },
  };
}

type Entry = { state: 'built' | 'delivered'; sha256: string; file: string };
type Ledger = Record<string, Entry>;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// CSV quoting, decision D-50 (the legacy job's own behavior is unrecorded, U-53): a field is
// wrapped in double quotes only when it holds a comma, a double quote, CR or LF, and a quote
// inside it is doubled (RFC 4180). The reader in keyed-diff.ts parses exactly this.
const csvField = (v: string | number) => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Same rows in, same bytes out: sorted by key, fixed formatting, no wall-clock value.
export function renderExport(rows: ExportRow[]): Buffer {
  const lines = [...rows]
    .sort((a, b) => a.caseId - b.caseId)
    .map((r) => [r.caseId, r.caseType, r.status, r.submittedAt].map(csvField).join(','));
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

function saveAtomically(path: string, content: string | Buffer) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.part`; // unique, so two writers never share a temp file
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
