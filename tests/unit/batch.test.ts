import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeComp3, decodeEbcdic037, decodeRecords, DecodeError, encodeComp3, encodeEbcdic037, type FieldSpec } from '../../src/modernization/batch/decode.ts';
import { describe as describeFinding, diffFiles, parseCsv, type Contract } from '../../src/modernization/batch/keyed-diff.ts';
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
  it('holds the field to its declared digit count', () => {
    expect(() => decodeComp3(hex('12 3C'), 0, 2)).toThrow(/padding nibble is 0x1/); // 123 does not fit two digits
    expect(decodeComp3(hex('01 2C'), 0, 2)).toBe('12'); // an even count carries a zero padding nibble
    expect(decodeComp3(hex('12 3C'), 0, 3)).toBe('123');
    expect(() => decodeComp3(hex('12 3C'), 0, 5)).toThrow(/5 digits need 3 bytes, field has 2/);
    expect(() => decodeComp3(hex('00 12 3C'), 0, 3)).toThrow(/3 digits need 2 bytes, field has 3/);
  });
  it('negative zero: encoded as zero with a C sign, and a D on zero decodes as plain zero', () => {
    expect(Buffer.from(encodeComp3('-0.00', 7, 2)).toString('hex')).toBe('0000000c');
    expect(decodeComp3(hex('00 00 00 0D'), 2, 7)).toBe('0.00');
    expect(decodeComp3(encodeComp3('-0', 3), 0, 3)).toBe('0');
  });
  it('round-trips through the encoder', () => {
    for (const v of ['0', '7', '-7', '1250.00', '-75.50', '99999.99']) {
      expect(decodeComp3(encodeComp3(v, 7, 2), 2)).toBe(Number(v).toFixed(2));
    }
    expect(() => encodeComp3('123456789', 7, 0)).toThrow(DecodeError);
  });
});

describe('the layout file', () => {
  const layout: FieldSpec[] = JSON.parse(text('referral-feed.layout.json'));
  it('trims a text field only when the layout says so', () => {
    const one: FieldSpec[] = [{ name: 'T', type: 'text', length: 6, trim: false }];
    const padded = encodeEbcdic037('AB    ');
    expect(decodeRecords(padded, one)).toEqual([{ T: 'AB    ' }]);
    expect(decodeRecords(padded, [{ ...one[0], trim: true } as FieldSpec])).toEqual([{ T: 'AB' }]);
    expect(decodeRecords(encodeEbcdic037(' A    '), [{ ...one[0], trim: true } as FieldSpec])).toEqual([{ T: ' A' }]);
  });
  it('refuses a layout that does not state trim, repeats a name or has scale beyond digits', () => {
    expect(() => decodeRecords(new Uint8Array(2), [{ name: 'T', type: 'text', length: 2 } as FieldSpec])).toThrow(/trim must be stated/);
    expect(() => decodeRecords(new Uint8Array(4), [layout[0], layout[0]])).toThrow(/names field CaseId twice/);
    expect(() => decodeRecords(new Uint8Array(2), [{ name: 'A', type: 'comp3', digits: 2, scale: 3 }])).toThrow(/scale 3 exceeds 2 digits/);
  });
  it('a packed value too wide for its declared digits names the record and field', () => {
    const wide = Uint8Array.from(fx('referral-feed.ebc'));
    wide[18] = 0x12; wide[19] = 0x3c; // record 1, HouseholdSize = 123
    expect(decodeRecords(wide, layout)[0].HouseholdSize).toBe('123'); // fits the declared 3 digits
    const two = layout.map((f) => (f.name === 'HouseholdSize' ? { ...f, digits: 2 } : f)) as FieldSpec[];
    expect(() => decodeRecords(wide, two)).toThrow('record 1, field HouseholdSize: 2 digits declared, but the padding nibble is 0x1 and the value does not fit');
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
  it('a quoted field with a comma, a doubled quote and a line break is one field of one record', () => {
    const quoted = '1,"ON HOLD, REVIEW",x\n2,"say ""hi""",y\n3,"two\nlines",z\r\n';
    expect(parseCsv(quoted).records).toEqual([
      { line: 1, fields: ['1', 'ON HOLD, REVIEW', 'x'] },
      { line: 2, fields: ['2', 'say "hi"', 'y'] },
      { line: 3, fields: ['3', 'two\nlines', 'z'] },
    ]);
    expect(parseCsv('a,"",c\n"",\n,\n').records.map((r) => r.fields)).toEqual([['a', '', 'c'], ['', ''], ['', '']]);
    const c: Contract = { key: 'id', columns: ['id', 'status'], ordered: false, tolerances: [] };
    expect(diffFiles('1,"ON HOLD, REVIEW"\n2,"a\nb"\n', '2,"a\nb"\n1,"ON HOLD, REVIEW"\n', c)).toEqual([]);
    expect(diffFiles('1,"a\nb"\n', '1,"a\nc"\n', c).map(describeFinding)).toEqual(['1 status: legacy=a\nb new=a\nc']);
  });
  it('an unclosed quote is a malformed-file finding, not a record', () => {
    const c: Contract = { key: 'id', columns: ['id', 'v'], ordered: false, tolerances: [] };
    expect(diffFiles('1,abc\n', '1,"abc\n', c).map(describeFinding)).toEqual(['new line 1: malformed file, unclosed quote: the file ends inside a quoted field']);
    expect(diffFiles('1,abc\n2,"def\n', '1,abc\n2,def\n', c).map((f) => f.kind)).toEqual(['malformed']);
    expect(parseCsv('1,a"b\n').malformed?.detail).toMatch(/quote inside an unquoted field/);
    expect(parseCsv('1,"a"b\n').malformed?.detail).toMatch(/text after the closing quote/);
  });
  it('a row with the wrong field count is one finding, not also missing or extra', () => {
    const c: Contract = { key: 'id', columns: ['id', 'v'], ordered: false, tolerances: [] };
    expect(diffFiles('1,a\n2,b\n', '1,a\n2,b,extra\n', c).map(describeFinding)).toEqual(['new line 2: 3 fields, contract has 2']);
    expect(diffFiles('1,a\n2,b,extra\n', '1,a\n2,b\n', c).map(describeFinding)).toEqual(['legacy line 2: 3 fields, contract has 2']);
    expect(diffFiles('1,a\n2\n', '1,a\n3,c\n', c).map(describeFinding)).toEqual(['legacy line 2: 1 fields, contract has 2', 'extra in new: 3']);
  });
  it('a contract whose key or tolerance column is not a column is refused', () => {
    expect(() => diffFiles('1,a\n', '1,a\n', { key: 'nope', columns: ['id', 'v'], ordered: false, tolerances: [] })).toThrow(/key nope is not one of its columns/);
    const t = { column: 'zz', kind: 'numeric' as const, abs: 1, reason: 'x' };
    expect(() => diffFiles('1,a\n', '1,a\n', { key: 'id', columns: ['id', 'v'], ordered: false, tolerances: [t] })).toThrow(/column zz/);
  });
  it('order is checked on the keys both files hold, even when the row counts differ', () => {
    const c: Contract = { key: 'id', columns: ['id', 'v'], ordered: true, tolerances: [] };
    const f = diffFiles('1,a\n2,b\n3,c\n', '3,c\n2,b\n', c);
    expect(f.map(describeFinding)).toEqual(['missing from new: 1', 'row 1: legacy has 2, new has 3']);
  });
  it('an impossible date is not an instant: February 30 does not equal March 2', () => {
    const c: Contract = { key: 'id', columns: ['id', 'at'], ordered: false, tolerances: [{ column: 'at', kind: 'timestamp', withinMs: 1, reason: 'format' }] };
    expect(diffFiles('1,2026-02-30 08:00:00.0000000\n', '1,2026-03-02T08:00:00.000Z\n', c)).toHaveLength(1);
    expect(diffFiles('1,2026-11-04 25:00:00.0000000\n', '1,2026-11-05T01:00:00.000Z\n', c)).toHaveLength(1);
    expect(diffFiles('1,2026-11-04 08:00:00.0000000\n', '1,2026-11-04T08:00:00.000Z\n', c)).toEqual([]);
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
  it('rendering quotes a field that holds a comma, a quote or a line break, and the diff reads it back', () => {
    const odd: ExportRow[] = [
      { caseId: 1, caseType: 'ROUTINE', status: 'ON HOLD, REVIEW', submittedAt: '2026-11-04T08:00:00.000Z' },
      { caseId: 2, caseType: 'ROUTINE', status: 'said "no"', submittedAt: '2026-11-04T09:00:00.000Z' },
      { caseId: 3, caseType: 'ROUTINE', status: 'a\nb', submittedAt: '2026-11-04T10:00:00.000Z' },
    ];
    const file = renderExport(odd).toString('utf8');
    expect(file).toBe('1,ROUTINE,"ON HOLD, REVIEW",2026-11-04T08:00:00.000Z\n2,ROUTINE,"said ""no""",2026-11-04T09:00:00.000Z\n3,ROUTINE,"a\nb",2026-11-04T10:00:00.000Z\n');
    expect(diffFiles(file, file, contract)).toEqual([]);
    expect(parseCsv(file).records.map((r) => r.fields[2])).toEqual(['ON HOLD, REVIEW', 'said "no"', 'a\nb']);
    expect(contract.quoting?.status).toMatch(/U-53/);
  });
  it('the conditional create: a delivery that loses the race at the link step sees unchanged or a conflict', () => {
    const root = mkdtempSync(join(tmpdir(), 'batch-'));
    const a = Buffer.from('same\n');
    // The rival delivers between this call's temp write and its link.
    const rival = directorySink(join(root, 'out'));
    const racing = directorySink(join(root, 'out'), { beforeLink: () => { expect(rival.put('f.csv', a)).toBe('created'); } });
    expect(racing.put('f.csv', a)).toBe('unchanged');
    expect(readdirSync(join(root, 'out'))).toEqual(['f.csv']); // no temp file left behind
    const other = directorySink(join(root, 'out2'), { beforeLink: () => { directorySink(join(root, 'out2')).put('f.csv', a); } });
    expect(() => other.put('f.csv', Buffer.from('different\n'))).toThrow(ConflictingRedelivery);
    expect(readFileSync(join(root, 'out2', 'f.csv'))).toEqual(a);
  });

  // Two real OS processes, released together, delivering 25 business dates into one folder.
  const child = (out: string, work: string, startAt: number, variant: string) =>
    new Promise<Record<string, string>>((resolve, reject) => {
      const p = spawn(process.execPath, [join(import.meta.dirname, '../../src/modernization/batch/deliver-once.ts'), out, work, String(startAt), variant, '25'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let o = '', e = '';
      p.stdout.on('data', (d) => (o += d));
      p.stderr.on('data', (d) => (e += d));
      p.on('close', (code) => (code === 0 ? resolve(JSON.parse(o)) : reject(new Error(e))));
    });
  const dates = Array.from({ length: 25 }, (_, i) => `2026-12-${String(i + 1).padStart(2, '0')}`);

  it('two processes delivering the same dates at once: one created per date, identical bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'batch-'));
    const startAt = Date.now() + 1500;
    const [x, y] = await Promise.all([child(join(root, 'out'), join(root, 'work'), startAt, 'a'), child(join(root, 'out'), join(root, 'work'), startAt, 'a')]);
    for (const d of dates) {
      expect([x[d], y[d]].filter((r) => r === 'created'), d).toHaveLength(1);
      expect(['created', 'unchanged', 'skipped']).toContain(x[d]);
      expect(['created', 'unchanged', 'skipped']).toContain(y[d]);
    }
    const want = renderExport([{ caseId: 10231, caseType: 'ROUTINE', status: 'OPEN', submittedAt: '2026-11-04T08:15:02.123Z' }]);
    expect(readdirSync(join(root, 'out')).sort()).toEqual(dates.map((d) => `intake-export-${d}.csv`));
    for (const d of dates) expect(readFileSync(join(root, 'out', `intake-export-${d}.csv`)).equals(want)).toBe(true);
  }, 30000);

  it('two processes delivering different content for the same dates: one wins, the other is refused, the winner is untouched', async () => {
    const root = mkdtempSync(join(tmpdir(), 'batch-'));
    const startAt = Date.now() + 1500;
    const [x, y] = await Promise.all([child(join(root, 'out'), join(root, 'wa'), startAt, 'a'), child(join(root, 'out'), join(root, 'wb'), startAt, 'b')]);
    for (const d of dates) {
      expect([x[d], y[d]].sort(), d).toEqual(['conflict', 'created']);
      expect(readFileSync(join(root, 'out', `intake-export-${d}.csv`), 'utf8')).toBe(`10231,ROUTINE,${x[d] === 'created' ? 'OPEN' : 'CLOSED'},2026-11-04T08:15:02.123Z\n`);
    }
  }, 30000);
  it('a corrupted half-built file is rebuilt, not delivered', () => {
    const s = setup();
    const o = { businessDate: '2026-11-04', workDir: s.work, rowsFor: rows, sink: s.sink };
    expect(() => runExport({ ...o, crashAt: 'after-build' })).toThrow();
    writeFileSync(join(s.work, 'intake-export-2026-11-04.csv'), '10231,ROU');
    runExport(o);
    expect(readFileSync(join(s.out, 'intake-export-2026-11-04.csv'), 'utf8')).toBe(renderExport(rows()).toString('utf8'));
  });
});
