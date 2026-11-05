import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { accounted, buildInventory, parseCsv, renderCoverage, renderDependents, renderUnknowns, type Snapshots } from '../../src/modernization/field-guide/data-tier/inventory.ts';
import { CopybookError, readCopybook, recordGolden, renderFieldMap } from '../../src/modernization/field-guide/data-tier/copybook.ts';

const dir = 'fixtures/field-guide/data-tier/';
const read = (f: string) => readFileSync(dir + f, 'utf8');
const snapshots = (dropOracleLine?: number): Snapshots => {
  const dep = parseCsv('oracle-all-dependencies.csv', read('oracle-all-dependencies.csv'));
  return {
    scope: { owner: 'INTAKE', objects: ['INTAKE', 'INTAKE_AUDIT', 'RPT_DAILY'] },
    oracle: {
      dependencies: dep.filter((r) => !r.cite.endsWith(`:${dropOracleLine}`)),
      viewText: parseCsv('oracle-view-text.csv', read('oracle-view-text.csv')),
      jobs: parseCsv('oracle-scheduler-jobs.csv', read('oracle-scheduler-jobs.csv')),
    },
    db2: { packageDeps: parseCsv('db2-syspackdep.csv', read('db2-syspackdep.csv')) },
  };
};

describe('inventory from catalog snapshots', () => {
  const inv = buildInventory(snapshots());

  it('reads quoted CSV fields and cites the line each row came from', () => {
    const [v] = parseCsv('v.csv', 'A,B\n"x, y","say ""hi""\nline two"\n');
    expect(v.row).toEqual({ A: 'x, y', B: 'say "hi"\nline two' });
    expect(v.cite).toBe('v.csv:2');
  });

  it('writes the dependents table in lesson 24 shape, every row cited', () => {
    expect(renderDependents(inv)).toBe(read('expected-dependents.md'));
  });

  it('sends what the catalog cannot see to unknowns, numbered from U-30', () => {
    expect(renderUnknowns(inv)).toBe(read('expected-unknowns.md'));
    expect(inv.unknowns.map((u) => u.id)[0]).toBe('U-30');
  });

  it('accounts for every row it read: cited, skipped with a reason, or an unknown', () => {
    expect(inv.rowsRead).toBe(15 + 1 + 4 + 8);
    expect(accounted(inv)).toBe(inv.rowsRead);
    expect(renderCoverage(inv)).toContain('28 rows read');
  });

  it('does not treat a row through a database link as a dependent on the local table', () => {
    expect(inv.dependents.find((d) => d.evidence.includes('oracle-all-dependencies.csv:14'))).toBeUndefined();
    expect(inv.unknowns.some((u) => u.evidence.includes('oracle-all-dependencies.csv:14') && u.what.includes('HQ_LINK'))).toBe(true);
  });

  it('follows a dependent of a dependent, and a scheduler job to the package it names', () => {
    const reports = inv.dependents.find((d) => d.name === 'INTAKE.PKG_REPORTS')!;
    expect(reports.touches).toEqual(['via INTAKE.RPT_DAILYINTAKE']);
    expect(inv.dependents.find((d) => d.name === 'INTAKE.INTAKE_NIGHTLY_EXPORT')!.touches).toEqual(['via INTAKE.PKG_EXPORT']);
  });

  it('flags the view that selects *', () => {
    expect(inv.dependents.find((d) => d.name === 'INTAKE.RPT_DAILYINTAKE')!.shapeRisk).toBe('`SELECT *`');
  });

  it('reads Db2 table and view rows as dependents and unresolvable ones as unknowns', () => {
    expect(inv.dependents.filter((d) => d.kind === 'Db2 package').map((d) => d.name)).toEqual(['INTBATCH.INTLOAD', 'INTBATCH.INTRPT', 'INTCICS.INTQ01']);
    expect(inv.unknowns.some((u) => u.what.includes('BTYPE A'))).toBe(true);
  });

  it('a row missing from the snapshot is invisible to the inventory, and shows only against the committed table', () => {
    const dropped = buildInventory(snapshots(7));           // line 7 is the trigger's row
    expect(dropped.dependents.some((d) => d.name === 'INTAKE.TRG_INTAKE_TOUCH')).toBe(false);
    expect(dropped.rowsRead).toBe(inv.rowsRead - 1);        // coverage is of the rows it was given
    expect(accounted(dropped)).toBe(dropped.rowsRead);      // so the accounting check stays green
    expect(renderDependents(dropped)).not.toBe(read('expected-dependents.md'));   // only the committed table notices
  });
});

describe('copybook reader', () => {
  const map = readCopybook(read('intake-master.cpy'));

  it('maps offsets and lengths, with packed fields sized from their digits', () => {
    expect(renderFieldMap(map)).toBe(read('expected-field-map.md'));
    expect(map.recordLength).toBe(44);
  });

  it('slices every golden record into raw fields, packed fields as hex', () => {
    const golden = recordGolden(map, read('intake-in.hex'));
    expect(golden).toEqual(JSON.parse(read('expected-golden.json')));
    expect(golden[1]['IR-SCORE']).toBe('0001250C');
  });

  it('refuses a record whose length is not the copybook length', () => {
    expect(() => recordGolden(map, 'AABB\n')).toThrow('record 1: 2 bytes, copybook says 44');
  });

  it('refuses layouts it cannot map instead of guessing', () => {
    expect(() => readCopybook('       01 R.\n           05 A PIC 9(4) OCCURS 3 TIMES.\n')).toThrow(CopybookError);
    expect(() => readCopybook('       01 R.\n           05 A PIC S9(4) COMP.\n')).toThrow('binary usage');
  });

  it('one digit more in a PIC clause moves every later offset and fails every record', () => {
    const wrong = readCopybook(read('intake-master.cpy').replace('PIC 9(8).', 'PIC 9(9).'));
    expect(wrong.recordLength).toBe(45);
    expect(() => recordGolden(wrong, read('intake-in.hex'))).toThrow('record 1: 44 bytes, copybook says 45');
  });
});
