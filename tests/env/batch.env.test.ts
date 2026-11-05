// Needs the local SQL Server container. Creates its own database, `batch`, with a few dbo.Intake rows.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sql from 'mssql';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffFiles, type Contract } from '../../src/modernization/batch/keyed-diff.ts';
import { renderExport, type ExportRow } from '../../src/modernization/batch/run-ledger.ts';

const run = process.env.M14_ENV === '1' ? describe : describe.skip;
const secretDir = process.env.M14_SECRET_DIR ?? join(process.env.HOME ?? '', '.config/m14-reference');
const base = { server: '127.0.0.1', port: 14330, user: 'sa', password: readFileSync(join(secretDir, 'sa.txt'), 'utf8').trim(), options: { trustServerCertificate: true, encrypt: true } };
const contract: Contract = JSON.parse(readFileSync(join(import.meta.dirname, '../../fixtures/batch/export-contract.json'), 'utf8'));

// What the SQL Agent CmdExec step's query does: one line per row, the date column as the
// database formats it (style 121, seven fractional digits for datetime2(7)).
const LEGACY_QUERY = `SELECT CONCAT(CaseId, ',', CaseType, ',', Status, ',', CONVERT(varchar(27), SubmittedAt, 121))
  FROM dbo.Intake WHERE CAST(SubmittedAt AS date) = @d`;
// What the new job reads: typed columns, formatted in code.
const NEW_QUERY = `SELECT CaseId, CaseType, Status, SubmittedAt FROM dbo.Intake WHERE CAST(SubmittedAt AS date) = @d`;

run('Intake_Nightly_Export: old query vs new job against a real SQL Server', () => {
  let pool: sql.ConnectionPool;
  beforeAll(async () => {
    const master = await new sql.ConnectionPool({ ...base, database: 'master' }).connect();
    await master.query("IF DB_ID('batch') IS NULL CREATE DATABASE batch");
    await master.close();
    pool = await new sql.ConnectionPool({ ...base, database: 'batch' }).connect();
    await pool.query(`IF OBJECT_ID('dbo.Intake') IS NOT NULL DROP TABLE dbo.Intake;
      CREATE TABLE dbo.Intake (CaseId int PRIMARY KEY, CaseType varchar(20), Status varchar(20), SubmittedAt datetime2(7));
      INSERT dbo.Intake VALUES
        (10231,'ROUTINE','OPEN','2026-11-04T08:15:02.1234567'), (10232,'EMERGENCY','OPEN','2026-11-04T08:41:55.0070000'),
        (10233,'ROUTINE','CLOSED','2026-11-04T09:02:10.9999999'), (10234,'EMERGENCY','OPEN','2026-11-04T23:59:59.9990000'),
        (10240,'ROUTINE','OPEN','2026-11-05T00:00:00.0000000')`);
  });
  afterAll(async () => { await pool?.close(); });

  const legacyFile = async (d: string) =>
    (await pool.request().input('d', sql.Date, d).query(LEGACY_QUERY)).recordset.map((r) => Object.values(r)[0]).join('\n') + '\n';
  const newFile = async (d: string) => {
    const rows: ExportRow[] = (await pool.request().input('d', sql.Date, d).query(NEW_QUERY)).recordset
      .map((r) => ({ caseId: r.CaseId, caseType: r.CaseType, status: r.Status, submittedAt: (r.SubmittedAt as Date).toISOString() }));
    return renderExport(rows).toString('utf8');
  };

  it('the old query and the new job agree for 2026-11-04, row for row', async () => {
    const [legacy, next] = [await legacyFile('2026-11-04'), await newFile('2026-11-04')];
    expect(legacy.trim().split('\n')).toHaveLength(4);
    expect(diffFiles(legacy, next, contract)).toEqual([]);
  });
  it('the day boundary is part of parity: 2026-11-05 holds only the midnight row', async () => {
    expect((await newFile('2026-11-05')).trim().split('\n')).toEqual(['10240,ROUTINE,OPEN,2026-11-05T00:00:00.000Z']);
  });
});
