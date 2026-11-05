// src/modernization/batch/decode.ts
// Decoders for a mainframe-origin input file (lesson 30): EBCDIC code page 037 text and COMP-3
// packed decimal. Strict by design: a byte or nibble that means nothing throws, because a
// decoder that guesses turns a corrupt file into plausible-looking data.

// Code page 037 (US/Canada EBCDIC), byte value -> character. Generated from a reference codec
// and checked against it in tests/unit/batch.test.ts.
const CP037 = "\u0000\u0001\u0002\u0003\u009c\t\u0086\u007f\u0097\u008d\u008e\u000b\f\r\u000e\u000f\u0010\u0011\u0012\u0013\u009d\u0085\b\u0087\u0018\u0019\u0092\u008f\u001c\u001d\u001e\u001f\u0080\u0081\u0082\u0083\u0084\n\u0017\u001b\u0088\u0089\u008a\u008b\u008c\u0005\u0006\u0007\u0090\u0091\u0016\u0093\u0094\u0095\u0096\u0004\u0098\u0099\u009a\u009b\u0014\u0015\u009e\u001a \u00a0\u00e2\u00e4\u00e0\u00e1\u00e3\u00e5\u00e7\u00f1\u00a2.<(+|&\u00e9\u00ea\u00eb\u00e8\u00ed\u00ee\u00ef\u00ec\u00df!$*);\u00ac-/\u00c2\u00c4\u00c0\u00c1\u00c3\u00c5\u00c7\u00d1\u00a6,%_>?\u00f8\u00c9\u00ca\u00cb\u00c8\u00cd\u00ce\u00cf\u00cc`:#@'=\"\u00d8abcdefghi\u00ab\u00bb\u00f0\u00fd\u00fe\u00b1\u00b0jklmnopqr\u00aa\u00ba\u00e6\u00b8\u00c6\u00a4\u00b5~stuvwxyz\u00a1\u00bf\u00d0\u00dd\u00de\u00ae^\u00a3\u00a5\u00b7\u00a9\u00a7\u00b6\u00bc\u00bd\u00be[]\u00af\u00a8\u00b4\u00d7{ABCDEFGHI\u00ad\u00f4\u00f6\u00f2\u00f3\u00f5}JKLMNOPQR\u00b9\u00fb\u00fc\u00f9\u00fa\u00ff\\\u00f7STUVWXYZ\u00b2\u00d4\u00d6\u00d2\u00d3\u00d50123456789\u00b3\u00db\u00dc\u00d9\u00da\u009f";

export class DecodeError extends Error {}

export function decodeEbcdic037(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += CP037[b];
  return out;
}

export function encodeEbcdic037(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const at = CP037.indexOf(text[i]);
    if (at < 0) throw new DecodeError(`character ${JSON.stringify(text[i])} has no code page 037 byte`);
    out[i] = at;
  }
  return out;
}

// COMP-3: two decimal digits per byte, the last nibble is the sign. C and F are positive
// (F means unsigned), D is negative. Other sign nibbles are refused, not guessed.
export function decodeComp3(bytes: Uint8Array, scale = 0): string {
  if (bytes.length === 0) throw new DecodeError('empty COMP-3 field');
  let digits = '';
  for (let i = 0; i < bytes.length; i++) {
    const hi = bytes[i] >> 4;
    const lo = bytes[i] & 0x0f;
    if (hi > 9) throw new DecodeError(`byte ${i}: high nibble 0x${hi.toString(16).toUpperCase()} is not a digit`);
    digits += hi;
    if (i < bytes.length - 1) {
      if (lo > 9) throw new DecodeError(`byte ${i}: low nibble 0x${lo.toString(16).toUpperCase()} is not a digit`);
      digits += lo;
    }
  }
  const sign = bytes[bytes.length - 1] & 0x0f;
  if (sign !== 0xc && sign !== 0xd && sign !== 0xf) {
    throw new DecodeError(`sign nibble 0x${sign.toString(16).toUpperCase()} is not C, D or F`);
  }
  digits = digits.padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale).replace(/^0+(?=\d)/, '');
  const text = scale > 0 ? `${whole}.${digits.slice(digits.length - scale)}` : whole;
  return sign === 0xd && /[1-9]/.test(text) ? `-${text}` : text;
}

export function encodeComp3(value: string, digitCount: number, scale = 0): Uint8Array {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) throw new DecodeError(`not a decimal: ${value}`);
  const frac = (m[3] ?? '').padEnd(scale, '0');
  if (frac.length > scale) throw new DecodeError(`${value} has more than ${scale} decimal places`);
  const all = (m[2] + frac).replace(/^0+(?=\d)/, '').padStart(digitCount, '0');
  if (all.length > digitCount) throw new DecodeError(`${value} needs more than ${digitCount} digits`);
  const nibbles = [...all].map(Number);
  nibbles.push(m[1] === '-' ? 0xd : 0xc);
  if (nibbles.length % 2 === 1) nibbles.unshift(0);
  const out = new Uint8Array(nibbles.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = (nibbles[2 * i] << 4) | nibbles[2 * i + 1];
  return out;
}

export type FieldSpec =
  | { name: string; type: 'text'; length: number }
  | { name: string; type: 'comp3'; digits: number; scale?: number };

const width = (f: FieldSpec) => (f.type === 'text' ? f.length : Math.floor(f.digits / 2) + 1);

// A fixed-length record file, no delimiters, as the mainframe wrote it.
export function decodeRecords(file: Uint8Array, layout: FieldSpec[]): Record<string, string>[] {
  const size = layout.reduce((n, f) => n + width(f), 0);
  if (file.length % size !== 0) throw new DecodeError(`file is ${file.length} bytes, not a multiple of the ${size}-byte record`);
  const rows: Record<string, string>[] = [];
  for (let at = 0; at < file.length; at += size) {
    const row: Record<string, string> = {};
    let o = at;
    for (const f of layout) {
      const raw = file.subarray(o, o + width(f));
      try {
        row[f.name] = f.type === 'text' ? decodeEbcdic037(raw).trimEnd() : decodeComp3(raw, f.scale ?? 0);
      } catch (e) {
        throw new DecodeError(`record ${at / size + 1}, field ${f.name}: ${(e as Error).message}`);
      }
      o += width(f);
    }
    rows.push(row);
  }
  return rows;
}
