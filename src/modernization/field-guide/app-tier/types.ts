// The shapes the three extractors share. One Dependent is one row for lesson 24's dependents table.
export type Schema = Record<string, string[]>;          // canonical table -> its columns, in table order
export type SourceFile = { path: string; text: string }; // path is relative to the fixture root
export type Dependent = {
  name: string;
  kind: string;
  table?: string;            // set when the dependent touches a table in the schema snapshot
  columns: string[];         // the columns of that table it reads or writes, in table order
  touches: string;           // what it touches when it is not a table: a queue, a binding, a server
  access: 'R' | 'W' | 'R/W' | '-';
  shapeRisk: string;
  evidence: string[];        // path:line, one or more
};
export type Unknown = { what: string; evidence: string; settledBy: string };
export type Extraction = { dependents: Dependent[]; unknowns: Unknown[] };
