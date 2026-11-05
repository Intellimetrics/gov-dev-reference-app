// Reading a string expression the way a person reads it: literals joined by + or & are text; anything else is run-time.
export type Lang = 'java' | 'cs' | 'vba';

/** Joins adjacent string literals. dynamic=true when any part of the expression is not a literal. */
export function evalLiterals(expr: string, lang: Lang): { text: string; dynamic: boolean } {
  const lit = lang === 'java' ? /^"((?:[^"\\]|\\.)*)"/ : lang === 'cs' ? /^(?:@"((?:[^"]|"")*)"|"((?:[^"\\]|\\.)*)")/ : /^"((?:[^"]|"")*)"/;
  let rest = expr.trim();
  let text = '';
  let dynamic = false;
  while (rest) {
    const m = rest.match(lit);
    if (m) {
      const v = m[1] ?? m[2];
      text += lang === 'vba' || m[1] !== undefined && lang === 'cs' ? v.replace(/""/g, '"') : v.replace(/\\(.)/g, '$1');
      rest = rest.slice(m[0].length).trimStart();
    } else if (/^[+&]/.test(rest) || /^_(\s|$)/.test(rest)) rest = rest.slice(1).trimStart();   // operator, or a VBA line continuation
    else { dynamic = true; rest = rest.slice(rest.match(/^[^\s+&]+/)![0].length).trimStart(); }
  }
  return { text, dynamic };
}

/** The argument text that starts at `start`: up to a top-level comma or semicolon, or the closing parenthesis. */
export function takeExpr(text: string, start: number, lang: Lang): string {
  let depth = 0, inStr = false, verbatim = false, i = start;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '"') { if (verbatim && text[i + 1] === '"') i++; else inStr = false; }
      else if (!verbatim && c === '\\') i++;
      continue;
    }
    if (c === '"') { inStr = true; verbatim = lang === 'vba' || (lang === 'cs' && text[i - 1] === '@'); }
    else if (c === '(') depth++;
    else if (c === ')') { if (depth === 0) break; depth--; }
    else if ((c === ',' || c === ';') && depth === 0) break;
    else if (c === '\n' && lang === 'vba' && !/_\s*$/.test(text.slice(start, i))) break;
  }
  return text.slice(start, i);
}

/** The text between the parenthesis at `open` and its partner, skipping string literals. */
export function balanced(text: string, open: number): string {
  let depth = 0, inStr = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** The name of the method that contains `index`: the last method header before it. */
export function enclosingMethod(text: string, index: number): string {
  const heads = [...text.slice(0, index).matchAll(/\b(?:public|protected|private|internal|Sub|Function)\s+(?:static\s+)?(?:[\w<>\[\],.? ]+?\s+)?(\w+)\s*\(/gi)];
  return heads.at(-1)?.[1] ?? '(outside a method)';
}
