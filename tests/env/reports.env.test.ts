// Needs the local database: npm run local:up. Creates and drops its own database, `reports`.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sql from 'mssql';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_SECRET_DIR } from '../../src/platform/local/index.ts';
import { compareDatasets } from '../../src/modernization/reports/dataset.ts';
import { viewColumns, refreshView, shapeChange } from '../../src/modernization/reports/shape.ts';

const run = process.env.M14_ENV === '1' ? describe : describe.skip;
const cfg = (database: string): sql.config => ({ server: '127.0.0.1', port: 14330, user: 'sa', database,
  password: readFileSync(join(LOCAL_SECRET_DIR, 'sa.txt'), 'utf8').trim(), options: { encrypt: true, trustServerCertificate: true } });

const DECL = '@ReportDate date';
const params = { ReportDate: { type: sql.Date, value: '2026-11-03' } };
const LEGACY = readFileSync('fixtures/reports/DailyIntake.rdl', 'utf8').match(/<CommandText>([\s\S]*?)<\/CommandText>/)![1];
// The rebuilt dataset: named columns, and the view's filter written out where the report can see it.
const COLS = 'CaseId, CaseType, Status, SubmittedAt, HouseholdSize, DaysWaiting, Score';
const REBUILT = `SELECT ${COLS} FROM dbo.Intake
WHERE (Status <> 'Withdrawn' OR Status IS NULL) AND CAST(SubmittedAt AS date) = @ReportDate`;

run('report dataset equivalence (local SQL Server)', () => {
  let pool: sql.ConnectionPool;
  beforeAll(async () => {
    const master = await new sql.ConnectionPool(cfg('master')).connect();
    await master.query('IF DB_ID(\'reports\') IS NOT NULL BEGIN ALTER DATABASE reports SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE reports; END; CREATE DATABASE reports');
    await master.close();
    pool = await new sql.ConnectionPool(cfg('reports')).connect();
    for (const batch of readFileSync('fixtures/reports/seed.sql', 'utf8').split(/^GO\s*$/m).filter((b) => b.trim())) await pool.query(batch);
  }, 60_000);
  afterAll(async () => {
    await pool?.close();
    const master = await new sql.ConnectionPool(cfg('master')).connect();
    await master.query('ALTER DATABASE reports SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE reports');
    await master.close();
  });

  it('the rebuilt dataset returns the legacy rows', async () => {
    const r = await compareDatasets(pool, LEGACY, REBUILT, DECL, params);
    console.log('equivalent:', JSON.stringify(r));
    expect(r.shape).toEqual([]);
    expect(r.diff).toEqual({ onlyInLegacy: [], onlyInNew: [], matched: 4 });
  });

  it('plant: a boundary written as <= next midnight puts a row only in the new dataset', async () => {
    const bad = REBUILT.replace('CAST(SubmittedAt AS date) = @ReportDate',
      'SubmittedAt >= @ReportDate AND SubmittedAt <= DATEADD(day, 1, CAST(@ReportDate AS datetime2))');
    const r = await compareDatasets(pool, LEGACY, bad, DECL, params);
    console.log('boundary fault:', JSON.stringify(r.diff));
    expect(r.diff!.onlyInLegacy).toEqual([]);
    expect(r.diff!.onlyInNew.map((s) => s.row[0])).toEqual(['6']);
  });

  it('plant: a datetime where the legacy column is datetime2 is caught by type and by value', async () => {
    const bad = REBUILT.replace('SubmittedAt, HouseholdSize', 'CAST(SubmittedAt AS datetime) AS SubmittedAt, HouseholdSize');
    const r = await compareDatasets(pool, LEGACY, bad, DECL, params);
    console.log('type fault:', JSON.stringify(r.shape), 'rows only in legacy:', r.diff!.onlyInLegacy.length, 'only in new:', r.diff!.onlyInNew.length);
    expect(r.shape).toEqual(['SubmittedAt: type datetime2 -> datetime']);
    expect(r.diff!.onlyInLegacy.length).toBeGreaterThan(0);
  });

  it('the SELECT * trap: a new column on dbo.Intake does not reach the view until sp_refreshview', async () => {
    const before = await viewColumns(pool, 'dbo.rpt_DailyIntake');
    await pool.query('ALTER TABLE dbo.Intake ADD Channel varchar(10) NULL');
    const afterAlter = await viewColumns(pool, 'dbo.rpt_DailyIntake');
    await refreshView(pool, 'dbo.rpt_DailyIntake');
    const afterRefresh = await viewColumns(pool, 'dbo.rpt_DailyIntake');
    console.log('view columns before ALTER   :', before.join(','));
    console.log('view columns after ALTER    :', afterAlter.join(','), '  change:', JSON.stringify(shapeChange(before, afterAlter)));
    console.log('view columns after refresh  :', afterRefresh.join(','), '  change:', JSON.stringify(shapeChange(before, afterRefresh)));
    expect(afterAlter).toEqual(before);
    expect(shapeChange(before, afterRefresh)).toEqual(['+ Channel']);
    const r = await compareDatasets(pool, LEGACY, REBUILT, DECL, params);   // the legacy SELECT * now has one more column than the rebuilt one
    console.log('dataset compare after refresh:', JSON.stringify(r.shape));
    expect(r.shape).toEqual(['Channel: missing from the new dataset']);
  });
});
