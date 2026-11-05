// COBOL copybook reader (lesson 28): fixed-width layout -> field map -> raw fields for golden cases.
// It maps the layout only. Decoding packed decimals and EBCDIC text is lesson 30.

export type Field = {
  name: string; line: number; pic: string;
  kind: 'alnum' | 'display' | 'packed';
  digits: number; scale: number; signed: boolean;
  offset: number; length: number;
};

export class CopybookError extends Error {}

const USAGE = /\b(?:USAGE\s+(?:IS\s+)?)?(COMP-3|PACKED-DECIMAL)\b/;

/** Expand 9(5)V99 or XXX into digit counts, so the length never depends on how the picture was typed. */
function parsePic(pic: string, line: number) {
  let digits = 0, scale = 0, alnum = 0, afterV = false, signed = false;
  const re = /^(S)|^(V)|^([9X])(?:\((\d+)\))?/;
  for (let rest = pic.toUpperCase(); rest;) {
    const m = rest.match(re);
    if (!m) throw new CopybookError(`line ${line}: unsupported PICTURE ${pic}`);
    if (m[1]) signed = true;
    else if (m[2]) afterV = true;
    else {
      const n = m[4] ? Number(m[4]) : 1;
      if (m[3] === 'X') alnum += n; else { digits += n; if (afterV) scale += n; }
    }
    rest = rest.slice(m[0].length);
  }
  if (alnum && digits) throw new CopybookError(`line ${line}: PICTURE ${pic} mixes X and 9`);
  return { digits, scale, alnum, signed };
}

export function readCopybook(text: string): { fields: Field[]; recordLength: number } {
  const fields: Field[] = [];
  let offset = 0;
  text.split('\n').forEach((raw, i) => {
    const line = i + 1;
    if (raw[6] === '*' || !raw.trim()) return;                       // comment lines have * in column 7
    const stmt = raw.trim().replace(/\.$/, '');
    const m = stmt.match(/^(\d\d)\s+([A-Z0-9-]+)\s*(.*)$/i);
    if (!m) throw new CopybookError(`line ${line}: cannot read "${stmt}"`);
    const [, level, name, rest] = m;
    if (level === '88') return;                                       // condition names occupy no bytes
    if (/\b(OCCURS|REDEFINES|RENAMES|DEPENDING)\b/i.test(rest)) throw new CopybookError(`line ${line}: ${name} uses OCCURS or REDEFINES, which this reader does not map; list it as an unknown`);
    const pic = rest.match(/\bPIC(?:TURE)?\s+(?:IS\s+)?(\S+)/i);
    if (!pic) return;                                                 // a group item occupies the bytes of its children
    const p = parsePic(pic[1], line);
    const usage = rest.replace(pic[0], '');
    if (/\b(COMP(?:-[1245])?|COMPUTATIONAL\S*|BINARY|POINTER)\b/i.test(usage) && !USAGE.test(usage)) throw new CopybookError(`line ${line}: ${name} uses a binary usage this reader does not map`);
    const packed = USAGE.test(usage);
    const length = packed ? Math.floor(p.digits / 2) + 1 : p.alnum || p.digits;
    fields.push({ name, line, pic: pic[1], kind: packed ? 'packed' : p.alnum ? 'alnum' : 'display',
      digits: p.digits, scale: p.scale, signed: p.signed, offset, length });
    offset += length;
  });
  return { fields, recordLength: offset };
}

export type RawRecord = Record<string, string>;

/** Raw field values: text as read, packed fields as hex. Nothing is decoded or trimmed. */
export function sliceRecord(fields: Field[], recordLength: number, record: Buffer, index: number): RawRecord {
  if (record.length !== recordLength) throw new CopybookError(`record ${index}: ${record.length} bytes, copybook says ${recordLength}`);
  return Object.fromEntries(fields.map((f) => {
    const bytes = record.subarray(f.offset, f.offset + f.length);
    return [f.name, f.kind === 'packed' ? bytes.toString('hex').toUpperCase() : bytes.toString('latin1')];
  }));
}

/** One record per line, as hex: readable in a diff, and safe for packed bytes that look like newlines. */
export function recordGolden(map: { fields: Field[]; recordLength: number }, hexLines: string): RawRecord[] {
  return hexLines.split('\n').filter((l) => l.trim()).map((l, i) =>
    sliceRecord(map.fields, map.recordLength, Buffer.from(l.trim(), 'hex'), i + 1));
}

export function renderFieldMap(map: { fields: Field[]; recordLength: number }): string {
  const rows = map.fields.map((f) => `| ${f.name} | ${f.pic} | ${f.kind} | ${f.offset} | ${f.length} | ${f.scale} |`);
  return ['| Field | PIC | Kind | Offset | Bytes | Decimals |', '|---|---|---|---|---|---|', ...rows,
    `| record | | | | ${map.recordLength} | |`].join('\n') + '\n';
}
