// Inventory a report definition (RDL, which is XML) without rendering it: each dataset's command text and parameters.
// Regex parsing, node built-ins only. Limits: no namespace handling, no validation, no expression evaluation;
// CommandText built from an expression (=...) is reported as an expression, not as SQL.
export interface Dataset {
  name: string;
  dataSource: string;
  commandType: 'Text' | 'StoredProcedure' | 'TableDirect';
  commandText: string;
  isExpression: boolean;
  parameters: Array<{ name: string; value: string }>;
  selectStar: boolean;
}
export interface Inventory { datasets: Dataset[]; reportParameters: string[]; subreports: string[]; hasEmbeddedCode: boolean }

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(lt|gt|amp|quot|apos);|&#(\d+);/g, (_, n, d) => (n ? ENTITIES[n] : String.fromCharCode(Number(d))));
const unCdata = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))?.[1];

export function inventory(rdl: string): Inventory {
  const xml = rdl.replace(/<!--[\s\S]*?-->/g, '');                    // a commented-out dataset is not a dataset
  const datasets: Dataset[] = [];
  for (const m of xml.matchAll(/<DataSet\s+Name="([^"]+)"\s*>([\s\S]*?)<\/DataSet>/g)) {
    const query = tag(m[2], 'Query') ?? '';
    const raw = tag(query, 'CommandText');
    if (raw === undefined) continue;                                // a shared-dataset reference has no command text here
    const text = decode(unCdata(raw)).trim();
    datasets.push({
      name: m[1],
      dataSource: decode(tag(query, 'DataSourceName') ?? ''),
      commandType: (tag(query, 'CommandType') ?? 'Text') as Dataset['commandType'],
      commandText: text,
      isExpression: text.startsWith('='),
      parameters: [...query.matchAll(/<QueryParameter\s+Name="([^"]+)"\s*>([\s\S]*?)<\/QueryParameter>/g)]
        .map((p) => ({ name: decode(p[1]), value: decode(tag(p[2], 'Value') ?? '') })),
      selectStar: /\bselect\s+(?:top\s*\(?\s*\d+\s*\)?\s+)?(?:\w+\.)?\*/i.test(text),
    });
  }
  return {
    datasets,
    reportParameters: [...xml.matchAll(/<ReportParameter\s+Name="([^"]+)"/g)].map((p) => p[1]),
    subreports: [...xml.matchAll(/<Subreport\s+Name="([^"]+)"/g)].map((p) => p[1]),
    hasEmbeddedCode: /<Code>[\s\S]*?\S[\s\S]*?<\/Code>/.test(xml),
  };
}

// The views, tables and procedures a dataset names, so the dependency map has a row for the report.
export function objectsNamed(d: Dataset): string[] {
  if (d.commandType === 'StoredProcedure') return [d.commandText];
  if (d.commandType === 'TableDirect' || d.isExpression) return d.isExpression ? [] : [d.commandText];
  return [...new Set([...d.commandText.matchAll(/\b(?:from|join)\s+((?:\[?\w+\]?\.)?\[?\w+\]?)/gi)].map((m) => m[1].replace(/[\[\]]/g, '')))];
}
