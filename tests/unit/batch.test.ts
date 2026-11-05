import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeComp3, decodeEbcdic037, decodeRecords, DecodeError, encodeComp3, encodeEbcdic037, type FieldSpec } from '../../src/modernization/batch/decode.ts';
import { describe as describeFinding, diffFiles, type Contract } from '../../src/modernization/batch/keyed-diff.ts';
import { ConflictingRedelivery, directorySink, renderExport, runExport, type DeliverySink, type ExportRow } from '../../src/modernization/batch/run-ledger.ts';

const fx = (n: string) => readFileSync(join(import.meta.dirname, '../../fixtures/batch', n));
const text = (n: string) => fx(n).toString('utf8');
const contract: Contract = JSON.parse(text('export-contract.json'));
const hex = (s: string) => Uint8Array.from(Buffer.from(s.replace(/ /g, ''), 'hex'));

describe('EBCDIC code page 037', () => {
  it('decodes text, digits and the punctuation that differs from ASCII', () => {
    expect(decodeEbcdic037(hex('C8C5D3D3D6'))).toBe('HELLO');
    expect(decodeEbcdic037(hex('F1F0F2F3F1'))).toBe('10231');
    expect(decodeEbcdic037(hex('4A 4B 5A 7C'))).toBe('¢.!@');
  });
  it('round-trips and refuses a character it cannot encode', () => {
    expect(decodeEbcdic037(encodeEbcdic037('Case 10231 / OPEN'))).toBe('Case 10231 / OPEN');
    expect(() => encodeEbcdic037('日本')).toThrow(DecodeError);
  });
});

describe('COMP-3 packed decimal', () => {
  it('reads the sign nibble: C positive, D negative, F unsigned', () => {
    expect(decodeComp3(hex('12 3C'))).toBe('123');
    expect(decodeComp3(hex('12 3D'))).toBe('-123');
    expect(decodeComp3(hex('12 3F'))).toBe('123');
  });
  it('applies the scale and keeps leading and trailing zeros exact', () => {
    expect(decodeComp3(hex('01 25 00 0C'), 2)).toBe('1250.00');
    expect(decodeComp3(hex('00 07 55 0D'), 2)).toBe('-75.50');
    expect(decodeComp3(hex('00 00 09 9F'), 2)).toBe('0.99');
    expect(decodeComp3(hex('00 00 00 0D'), 2)).toBe('0.00');
  });
  it('refuses a malformed nibble instead of guessing', () => {
    expect(() => decodeComp3(hex('12 3A'))).toThrow(/sign nibble 0xA/);
    expect(() => decodeComp3(hex('12 35'))).toThrow(/sign nibble 0x5/);
    expect(() => decodeComp3(hex('1A 3C'))).toThrow(/low nibble 0xA/);
    expect(() => decodeComp3(hex('B2 3C'))).toThrow(/high nibble 0xB/);
    expect(() => decodeComp3(hex(''))).toThrow(/empty/);
  });
  it('round-trips through the encoder', () => {
    for (const v of ['0', '7', '-7', '1250.00', '-75.50', '99999.99']) {
      expect(decodeComp3(encodeComp3(v, 7, 2), 2)).toBe(Number(v).toFixed(2));
    }
    expect(() => encodeComp3('123456789', 7, 0)).toThrow(DecodeError);
  });
});

describe('a fixed-length mainframe feed', () => {
  const layout: FieldSpec[] = JSON.parse(text('referral-feed.layout.json'));
  it('decodes the recorded feed, one row per 24-byte record', () => {
    expect(decodeRecords(fx('referral-feed.ebc'), layout)).toEqual([
      { CaseId: '10231', CaseType: 'ROUTINE', HouseholdSize: '3', BenefitAmount: '1250.00' },
      { CaseId: '10232', CaseType: 'EMERGENCY', HouseholdSize: '5', BenefitAmount: '-75.50' },
      { CaseId: '10233', CaseType: 'ROUTINE', HouseholdSize: '1', BenefitAmount: '0.99' },
    ]);
  });
  it('names the record and field when a nibble is bad, and refuses a truncated file', () => {
    const bad = Uint8Array.from(fx('referral-feed.ebc'));
    bad[24 + 8 + 10 + 1] = 0x3a; // record 2, HouseholdSize sign nibble
    expect(() => decodeRecords(bad, layout)).toThrow('record 2, field HouseholdSize: sign nibble 0xA is not C, D or F');
    expect(() => decodeRecords(fx('referral-feed.ebc').subarray(0, 70), layout)).toThrow(/not a multiple of the 24-byte record/);
  });
});

describe('keyed record diff: legacy file vs new file', () => {
  const legacy = text('legacy-export-20261104.csv');
  it('the recorded legacy file and the new file match, with the declared timestamp tolerance', () => {
    expect(diffFiles(legacy, text('new-export-20261104.csv'), contract)).toEqual([]);
  });
  it('a reordered file matches: order is not part of the contract', () => {
    expect(diffFiles(legacy, text('new-export-reordered-20261104.csv'), contract)).toEqual([]);
  });
  it('a reordered file fails when a consumer depends on order', () => {
    const f = diffFiles(legacy, text('new-export-reordered-20261104.csv'), { ...contract, ordered: true });
    expect(f.map(describeFinding)).toEqual(['row 1: legacy has 10231, new has 10235']);
  });
  it('reports missing, extra and field differences by key', () => {
    const next = text('new-export-20261104.csv').split('\n').filter((l) => l && !l.startsWith('10233'));
    next.push('10299,ROUTINE,OPEN,2026-11-04T12:00:00.000Z');
    next[0] = next[0].replace('OPEN', 'PENDING');
    expect(diffFiles(legacy, next.join('\n') + '\n', contract).map(describeFinding)).toEqual([
      '10231 Status: legacy=OPEN new=PENDING',
      'missing from new: 10233',
      'extra in new: 10299',
    ]);
  });
  it('a timestamp outside the tolerance is a difference', () => {
    const next = text('new-export-20261104.csv').replace('08:15:02.123Z', '08:15:03.123Z');
    expect(diffFiles(legacy, next, contract).map(describeFinding)).toEqual([
      '10231 SubmittedAt: legacy=2026-11-04 08:15:02.1234567 new=2026-11-04T08:15:03.123Z',
    ]);
  });
  it('positional contract: an added column or two swapped columns fail by position', () => {
    const added = text('new-export-20261104.csv').replace(/\n/g, ',extra\n');
    const shape = diffFiles(legacy, added, contract);
    expect(shape.filter((f) => f.kind === 'shape')).toHaveLength(5);
    expect(describeFinding(shape[0])).toBe('new line 1: 5 fields, contract has 4');
    const swapped = text('new-export-20261104.csv').replace(/^(\d+),(\w+),(\w+),/gm, '$1,$3,$2,');
    const swap = diffFiles(legacy, swapped, contract).filter((f) => f.kind === 'field');
    expect(swap.length).toBeGreaterThan(0);
    expect(swap.every((f) => f.kind === 'field' && (f.column === 'CaseType' || f.column === 'Status'))).toBe(true);
  });
  it('a duplicated key is reported, not silently collapsed', () => {
    const next = text('new-export-20261104.csv') + '10231,ROUTINE,OPEN,2026-11-04T08:15:02.123Z\n';
    expect(diffFiles(legacy, next, contract).map(describeFinding)).toEqual(['new: key 10231 appears twice']);
  });
  it('numeric and text tolerances compare under their own rules', () => {
    const c: Contract = { key: 'id', columns: ['id', 'amt', 'name'], ordered: false, tolerances: [
      { column: 'amt', kind: 'numeric', abs: 0.005, reason: 'cents rounding' },
      { column: 'name', kind: 'text', fold: ['trim', 'case'], reason: 'normalized' },
    ] };
    expect(diffFiles('1,10.00,ADA\n', '1,10.004, ada\n', c)).toEqual([]);
    expect(diffFiles('1,10.00,ADA\n', '1,10.01,ada\n', c)).toHaveLength(1);
  });
});

describe('idempotent re-delivery', () => {
  const rows = (): ExportRow[] => [
    { caseId: 10232, caseType: 'EMERGENCY', status: 'OPEN', submittedAt: '2026-11-04T08:41:55.007Z' },
    { caseId: 10231, caseType: 'ROUTINE', status: 'OPEN', submittedAt: '2026-11-04T08:15:02.123Z' },
  ];
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'batch-'));
    const inner = directorySink(join(root, 'out'));
    const created: string[] = [];
    const sink: DeliverySink = { put: (n, b) => { const r = inner.put(n, b); if (r === 'created') created.push(n); return r; } };
    return { root, work: join(root, 'work'), out: join(root, 'out'), sink, created };
  }

  it('run twice for one business date: one delivery', () => {
    const s = setup();
    const o = { businessDate: '2026-11-04', workDir: s.work, rowsFor: rows, sink: s.sink };
    expect(runExport(o).status).toBe('delivered');
    expect(runExport(o).status).toBe('already-delivered');
    expect(s.created).toEqual(['intake-export-2026-11-04.csv']);
  });
  it('crash after the build, restart: the same bytes, delivered once', () => {
    const s = setup();
    const o = { businessDate: '2026-11-04', workDir: s.work, rowsFor: rows, sink: s.sink };
    expect(() => runExport({ ...o, crashAt: 'after-build' })).toThrow('simulated crash');
    expect(s.created).toEqual([]);
    runExport(o);
    expect(readFileSync(join(s.out, 'intake-export-2026-11-04.csv'), 'utf8')).toBe(renderExport(rows()).toString('utf8'));
    expect(s.created).toHaveLength(1);
  });
  it('crash after the put but before the ledger: the restart does not deliver a second time', () => {
    const s = setup();
    const o = { businessDate: '2026-11-04', workDir: s.work, rowsFor: rows, sink: s.sink };
    expect(() => runExport({ ...o, crashAt: 'after-put' })).toThrow('simulated crash');
    expect(s.created).toHaveLength(1);
    expect(runExport(o).status).toBe('delivered');
    expect(s.created).toHaveLength(1);
    expect(readdirSync(s.out)).toEqual(['intake-export-2026-11-04.csv']);
  });
  it('the file does not depend on the order the database returned rows', () => {
    expect(renderExport(rows()).equals(renderExport([...rows()].reverse()))).toBe(true);
  });
  it('a re-run that would deliver different content for a delivered date is refused', () => {
    const s = setup();
    runExport({ businessDate: '2026-11-04', workDir: s.work, rowsFor: rows, sink: s.sink });
    const other = setup(); // a fresh ledger, same destination: the ledger was lost
    const sink = directorySink(s.out);
    const changed = () => rows().slice(0, 1);
    expect(() => runExport({ businessDate: '2026-11-04', workDir: other.work, rowsFor: changed, sink })).toThrow(ConflictingRedelivery);
  });
  it('a corrupted half-built file is rebuilt, not delivered', () => {
    const s = setup();
    const o = { businessDate: '2026-11-04', workDir: s.work, rowsFor: rows, sink: s.sink };
    expect(() => runExport({ ...o, crashAt: 'after-build' })).toThrow();
    writeFileSync(join(s.work, 'intake-export-2026-11-04.csv'), '10231,ROU');
    runExport(o);
    expect(readFileSync(join(s.out, 'intake-export-2026-11-04.csv'), 'utf8')).toBe(renderExport(rows()).toString('utf8'));
  });
});
