// Just enough XML for descriptors and config files: list the elements with their attributes and line numbers.
// Limits: no namespaces or CDATA, no entity expansion, and an element nested inside another element of the
// SAME name is not supported (the lazy match stops at the first closing tag). Descriptors in this lesson do not nest.
export type El = { tag: string; attrs: Record<string, string>; body: string; line: number; bodyLine: number };

/** Comments become blanks of the same length, so every line number after them stays true. */
export const stripComments = (xml: string) => xml.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
export const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length;

export function attrsOf(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = m[2] ?? m[3];
  return out;
}

/** Every <tag> in the text. Pass firstLine when the text is the body of a parent, to keep absolute line numbers. */
export function elements(xml: string, tag: string, firstLine = 1): El[] {
  const text = stripComments(xml);
  const re = new RegExp(`<${tag}(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</${tag}\\s*>)`, 'g');
  return [...text.matchAll(re)].map((m) => {
    const bodyStart = m.index! + m[0].indexOf('>') + 1;
    return { tag, attrs: attrsOf(m[1] ?? ''), body: m[2] ?? '', line: firstLine + lineAt(text, m.index!) - 1, bodyLine: firstLine + lineAt(text, bodyStart) - 1 };
  });
}

export const children = (el: El, tag: string) => elements(el.body, tag, el.bodyLine);
export const textOf = (el: El, tag: string) => children(el, tag)[0]?.body.trim();
