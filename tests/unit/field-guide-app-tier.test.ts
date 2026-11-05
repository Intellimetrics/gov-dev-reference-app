// The app-tier field guide against committed fixtures: Java EE, .NET Framework, and an Access export.
// Static extraction only, so it runs on any OS with no application server, IIS or Office.
import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOT, extractApp, loadSchema } from '../../src/modernization/field-guide/app-tier/extract.ts';
import { analyzeSql, makeCanon } from '../../src/modernization/field-guide/app-tier/sqlcols.ts';
import { renderDependents, renderUnknowns } from '../../src/modernization/field-guide/app-tier/render.ts';

const java = extractApp(DEFAULT_ROOT, 'java');
const dotnet = extractApp(DEFAULT_ROOT, 'dotnet');
const access = extractApp(DEFAULT_ROOT, 'access');
const row = (r: typeof java, name: string, table?: string) => r.dependents.find((d) => d.name === name && (!table || d.table === table))!;

describe('Java EE deployment', () => {
  it('lists the beans, the timers and the queue from the descriptors', () => {
    expect(row(java, 'NightlyDigestBean.buildDigest').touches).toBe('hour 2, minute 30');
    expect(row(java, 'IntakeEventListener').touches).toContain('jms/IntakeEvents');
    expect(row(java, 'IntakeStatusBean.morningRefresh').kind).toBe('EJB timer (annotation)');
    expect(row(java, 'ReferralLookupBean').kind).toContain('no descriptor entry');
  });
  it('maps JPA named queries to the dbo.Intake columns they read', () => {
    expect(row(java, 'Intake.openByType').columns).toEqual(['CaseId', 'CaseType', 'Status']);
    expect(row(java, 'Intake.waitingLong').columns).toHaveLength(6);          // SELECT i: the whole entity
    expect(row(java, 'Intake.householdBands').columns).toEqual(['HouseholdSize']);
  });
  it('names a query built at run time as an unknown instead of guessing its columns', () => {
    const u = java.unknowns.find((x) => x.what.startsWith('IntakeStatusBean.byOrder'))!;
    expect(u.what).toContain('builds its text at run time');
    expect(u.evidence).toBe('java/src/IntakeStatusBean.java:12');
    expect(java.dependents.some((d) => d.name === 'IntakeStatusBean.byOrder')).toBe(false);
  });
  it('says the JNDI name is a pointer whose target is not in the deployment', () => {
    expect(java.unknowns.some((x) => x.what.includes('java:/jdbc/IntakeDS') && x.what.includes('application server'))).toBe(true);
  });
});

describe('.NET Framework app', () => {
  it('records both WCF endpoints with binding and security mode, and the outbound call', () => {
    const e = dotnet.dependents.find((d) => d.kind === 'WCF service endpoint' && d.name.includes('base address'))!;
    expect(e.touches).toBe('contract Agency.Intake.IIntakeStatus; wsHttpBinding; security Transport');
    expect(dotnet.dependents.some((d) => d.kind === 'WCF client endpoint (outbound)')).toBe(true);
    expect(row(dotnet, 'contract IIntakeStatus').touches).toBe('operations GetStatus, CountOpen');
  });
  it('never copies a connection-string password into any output', () => {
    const all = JSON.stringify(dotnet) + renderDependents(dotnet.dependents) + JSON.stringify(access);
    expect(all).not.toContain('EXAMPLE-NOT-A-REAL');
    expect(row(dotnet, 'connection string ReportsDb').shapeRisk).toContain('password stored in the file');
  });
  it('reads the code-behind queries, following a variable to its SQL', () => {
    expect(row(dotnet, 'Review.aspx.cs Page_Load').columns).toEqual(['CaseId', 'CaseType', 'Status', 'SubmittedAt', 'DaysWaiting']);
    expect(row(dotnet, 'Review.aspx.cs Page_Load').shapeRisk).toContain('by ordinal');
    const approve = row(dotnet, 'Review.aspx.cs Approve_Click');
    expect(approve.access).toBe('R/W');
    expect(approve.shapeRisk).not.toContain('ordinal');
  });
  it('lists the ViewState keys and the run-time SQL', () => {
    expect(row(dotnet, 'Review.aspx.cs ViewState').touches).toBe('keys Filter');
    expect(dotnet.unknowns.some((u) => u.what.startsWith('Review.aspx.cs Filter_Changed') && u.what.includes('built at run time'))).toBe(true);
  });
});

describe('Access export (U-09)', () => {
  const roll = access.dependents.find((d) => d.kind === 'Access database (roll-up)' && d.table === 'dbo.Intake')!;
  it('answers which dbo.Intake columns the supervisor database reads, and finds a write', () => {
    expect(roll.columns).toEqual(['CaseId', 'CaseType', 'Status', 'SubmittedAt', 'HouseholdSize', 'DaysWaiting']);
    expect(roll.access).toBe('R/W');                                              // VBA CloseStale updates Status through the link
    expect(row(access, 'VBA modSupervisor.CloseStale').access).toBe('R/W');
  });
  it('reads HouseholdSize only through SELECT *: no query names it', () => {
    const naming = access.dependents.filter((d) => d.kind === 'Access saved query' && d.table === 'dbo.Intake' && d.columns.includes('HouseholdSize'));
    expect(naming.map((d) => d.name)).toEqual(['qryEverything']);
    expect(naming[0].shapeRisk).toContain('SELECT *');
  });
  it('a query that reads another saved query inherits the columns that query reads', () => {
    expect(row(access, 'qryOverThirty', 'dbo.Intake').columns).toEqual(['CaseId', 'CaseType', 'Status', 'DaysWaiting']);
    expect(row(access, 'qryOverThirty').shapeRisk).toContain('reads through qryOpenCases');
  });
  it('resolves joins and aliases across both linked tables', () => {
    expect(row(access, 'qryMonthlyAudit', 'dbo.IntakeAudit').columns).toEqual(['CaseId', 'Actor', 'At']);
    expect(row(access, 'qryMonthlyAudit', 'dbo.Intake').columns).toEqual(['CaseId', 'SubmittedAt']);
  });
  it('sends everything it cannot parse to unknowns, by name', () => {
    const names = access.unknowns.map((u) => u.what.split(':')[0]);
    for (const n of ['qryHouseholdSplit', 'qryAboveAverage', 'qryServerSummary', 'macro AutoExec', 'VBA modSupervisor.ExportFor', 'qryBands']) expect(names).toContain(n);
    expect(access.dependents.some((d) => ['qryHouseholdSplit', 'qryAboveAverage', 'qryServerSummary'].includes(d.name))).toBe(false);
  });
});

describe('R-40: every dependent and every unknown carries a path:line citation', () => {
  it('holds for all three applications', () => {
    for (const r of [java, dotnet, access]) {
      for (const d of r.dependents) for (const e of d.evidence) expect(e, d.name).toMatch(/^[\w./-]+:\d+$/);
      for (const u of r.unknowns) expect(u.evidence, u.what).toMatch(/^[\w./-]+:\d+$/);
    }
  });
  it('numbers unknowns from U-40', () => {
    expect(renderUnknowns(access.unknowns).split('\n')[0]).toMatch(/^U-40: /);
  });
});

describe('a column that is not in the schema snapshot', () => {
  const schema = loadSchema(DEFAULT_ROOT);
  it('is reported, not dropped', () => {
    const u = analyzeSql('SELECT CaseId, HouseholdSz FROM dbo.Intake', schema, makeCanon(schema));
    expect([...u.tables['dbo.Intake'].read]).toEqual(['CaseId']);
    expect(u.unresolved).toEqual(['dbo.Intake.HouseholdSz']);
  });
});

describe('a linked table whose target is not in the schema snapshot', () => {
  const schema = loadSchema(DEFAULT_ROOT);
  it('comes back unparsed instead of throwing, so discovery can list it as an unknown', () => {
    const u = analyzeSql('SELECT CaseId FROM dbo_Unseen', schema, makeCanon(schema, { dbo_unseen: 'dbo.Unseen' }));
    expect(u.unparsed).toContain('dbo.Unseen');
    expect(u.tables).toEqual({});
  });
  it('an INSERT into that link is also unparsed, not a crash', () => {
    for (const q of ['INSERT INTO dbo_Unseen VALUES (1)', 'INSERT INTO dbo_Unseen (CaseId) VALUES (1)']) {
      const u = analyzeSql(q, schema, makeCanon(schema, { dbo_unseen: 'dbo.Unseen' }));
      expect(u.unparsed).toContain('dbo.Unseen');
    }
  });
});
