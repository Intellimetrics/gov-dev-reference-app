import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { diffMultiset, normalizedQuery, asText, singleStatement } from '../../src/modernization/reports/dataset.ts';
import { inventory, objectsNamed } from '../../src/modernization/reports/rdl.ts';
import { shapeChange } from '../../src/modernization/reports/shape.ts';

const rdl = readFileSync('fixtures/reports/DailyIntake.rdl', 'utf8');

describe('multiset comparison', () => {
  it('matches equal sets in any order', () => {
    expect(diffMultiset([['1', 'a'], ['2', 'b']], [['2', 'b'], ['1', 'a']])).toEqual({ onlyInLegacy: [], onlyInNew: [], matched: 2 });
  });
  it('counts duplicates: two copies against one is a difference a set would hide', () => {
    const d = diffMultiset([['x'], ['x'], ['y']], [['x'], ['y']]);
    expect(d.onlyInLegacy).toEqual([{ row: ['x'], count: 1 }]);
    expect(d.onlyInNew).toEqual([]);
  });
  it('keeps NULL distinct from the empty string', () => {
    expect(diffMultiset([[null]], [['']]).onlyInLegacy).toHaveLength(1);
  });
});

describe('exact-type normalization', () => {
  it('uses the verify-intact styles', () => {
    expect(asText({ name: 'M', type: 'money' })).toBe('CONVERT(varchar(60), [M], 2)');
    expect(asText({ name: 'T', type: 'datetime2' })).toBe('CONVERT(varchar(60), [T], 121)');
    expect(asText({ name: 'F', type: 'float' })).toBe('CONVERT(varchar(60), [F], 3)');
  });
  it('refuses a type it cannot convert losslessly', () => {
    expect(() => asText({ name: 'V', type: 'sql_variant' })).toThrow(/no lossless text form/);
  });
  it('wraps the report query unchanged as a derived table', () => {
    const q = normalizedQuery('SELECT CaseId FROM dbo.Intake', [{ name: 'CaseId', type: 'int' }]);
    expect(q).toContain('FROM (\nSELECT CaseId FROM dbo.Intake\n) AS dataset');
  });
});

describe('one statement per dataset', () => {
  const cols = [{ name: 'CaseId', type: 'int' }];
  it('drops one trailing semicolon, with trailing whitespace and comments', () => {
    expect(singleStatement('SELECT CaseId FROM dbo.Intake;')).toBe('SELECT CaseId FROM dbo.Intake');
    expect(singleStatement('SELECT CaseId FROM dbo.Intake ; -- done\n/* x */\n')).toBe('SELECT CaseId FROM dbo.Intake');
    expect(normalizedQuery('SELECT CaseId FROM dbo.Intake;', cols)).toContain('FROM (\nSELECT CaseId FROM dbo.Intake\n) AS dataset');
  });
  it('keeps a semicolon inside a string or comment', () => {
    expect(singleStatement("SELECT ';' AS S -- a;b")).toBe("SELECT ';' AS S");
  });
  it('refuses multi-statement text', () => {
    expect(() => singleStatement('SELECT 1; SELECT 2;')).toThrow(/more than one statement/);
    expect(() => normalizedQuery('SET NOCOUNT ON; SELECT 1', cols)).toThrow(/more than one statement/);
  });
});

describe('RDL inventory', () => {
  it('leaves CDATA content literal and decodes entities only outside it', () => {
    const xml = `<DataSet Name="A"><Query><DataSourceName>D</DataSourceName><CommandText><![CDATA[SELECT '&amp;' AS X, a <> b]]></CommandText></Query></DataSet>`
      + `<DataSet Name="B"><Query><DataSourceName>D</DataSourceName><CommandText>SELECT '&amp;' AS X WHERE a &lt;&gt; b</CommandText></Query></DataSet>`;
    const [a, b] = inventory(xml).datasets;
    expect(a.commandText).toBe("SELECT '&amp;' AS X, a <> b");
    expect(b.commandText).toBe("SELECT '&' AS X WHERE a <> b");
  });
  const inv = inventory(rdl);
  it('finds every live dataset and ignores the commented-out one', () => {
    expect(inv.datasets.map((d) => d.name)).toEqual(['DailyIntake', 'CaseTypeTotals', 'WaitingOver30']);
  });
  it('pulls command text, type, data source and parameters', () => {
    const d = inv.datasets[0];
    expect(d.commandText).toBe('SELECT * FROM dbo.rpt_DailyIntake\nWHERE CAST(SubmittedAt AS date) = @ReportDate');
    expect(d.dataSource).toBe('IntakeDb');
    expect(d.parameters).toEqual([{ name: '@ReportDate', value: '=Parameters!ReportDate.Value' }]);
    expect(inv.datasets[1].commandType).toBe('StoredProcedure');
  });
  it('flags SELECT * and reads CDATA text with its < > intact', () => {
    expect(inv.datasets.map((d) => d.selectStar)).toEqual([true, false, false]);
    expect(inv.datasets[2].commandText).toContain("a.Action <> 'Closed'");
  });
  it('names the objects each dataset depends on', () => {
    expect(objectsNamed(inv.datasets[0])).toEqual(['dbo.rpt_DailyIntake']);
    expect(objectsNamed(inv.datasets[1])).toEqual(['dbo.usp_CaseTypeTotals']);
    expect(objectsNamed(inv.datasets[2])).toEqual(['dbo.Intake', 'dbo.IntakeAudit']);
  });
  it('reports what a regex cannot inventory: subreports and embedded code', () => {
    expect(inv.subreports).toEqual(['SupervisorSummary']);
    expect(inv.hasEmbeddedCode).toBe(true);
    expect(inv.reportParameters).toEqual(['ReportDate']);
  });
});

describe('shape change', () => {
  it('names added and removed columns', () => {
    expect(shapeChange(['A', 'B'], ['A', 'B', 'C'])).toEqual(['+ C']);
    expect(shapeChange(['A', 'B'], ['A'])).toEqual(['- B']);
  });
});
