// Usage: node src/modernization/field-guide/data-tier/cli.ts <snapshot-dir> <out-dir>
// Reads the committed catalog snapshots and the copybook, writes the dependents table, the unknowns
// and the field map. Needs no database: the snapshots are the input.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildInventory, parseCsv, renderCoverage, renderDependents, renderUnknowns } from './inventory.ts';
import { readCopybook, renderFieldMap } from './copybook.ts';

const [snap, out] = process.argv.slice(2);
if (!snap || !out) { console.error('usage: cli.ts <snapshot-dir> <out-dir>'); process.exit(2); }
const csv = (f: string) => parseCsv(f, readFileSync(join(snap, f), 'utf8'));
const inv = buildInventory({
  scope: { owner: 'INTAKE', objects: ['INTAKE', 'INTAKE_AUDIT', 'RPT_DAILY'] },
  oracle: { dependencies: csv('oracle-all-dependencies.csv'), viewText: csv('oracle-view-text.csv'), jobs: csv('oracle-scheduler-jobs.csv') },
  db2: { packageDeps: csv('db2-syspackdep.csv') },
});
const map = readCopybook(readFileSync(join(snap, 'intake-master.cpy'), 'utf8'));
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'db-dependents.md'), renderDependents(inv));
writeFileSync(join(out, 'unknowns-additions.md'), renderUnknowns(inv));
writeFileSync(join(out, 'field-map.md'), renderFieldMap(map));
console.log(renderCoverage(inv) + `Field map: ${map.fields.length} fields, ${map.recordLength} bytes per record.`);
