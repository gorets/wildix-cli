// A small XML reader for the bodies of the SIP event packages of the PBX (dialog-info, reginfo, active-device):
// elements, attributes, text. No DTD, no external entities (a DOCTYPE is refused). Element names are matched
// without their namespace prefix, as ltx does.

const TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<\/\s*([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/y;
const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const NAMED = {lt: '<', gt: '>', amp: '&', quot: '"', apos: "'"};

function decode(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED[e] ?? m;
  });
}

const local = (name) => name.slice(name.indexOf(':') + 1);

// Parses a document and returns its root element: {name, attrs, children, text}. Throws on what is not XML.
export function parseXml(text) {
  const s = String(text ?? '').trim();
  if (/<!DOCTYPE/i.test(s)) throw new Error('XML with a DOCTYPE is not accepted');
  const root = {name: '#document', attrs: {}, children: [], text: ''};
  const stack = [root];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < s.length) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(s);
    if (!m || m.index !== at) throw new Error(`not XML at character ${at}`);
    const top = stack[stack.length - 1];
    const [whole, cdata, closing, opening, attrText, selfClosing, chars] = m;
    if (whole.startsWith('<!--') || whole.startsWith('<?')) continue;
    if (cdata !== undefined) top.text += cdata;
    else if (chars !== undefined) top.text += decode(chars);
    else if (closing !== undefined) {
      if (stack.length < 2 || top.name !== local(closing)) throw new Error(`unexpected </${closing}>`);
      stack.pop();
    } else if (opening !== undefined) {
      const attrs = {};
      for (const a of (attrText ?? '').matchAll(ATTR)) attrs[a[1]] = decode(a[2] ?? a[3] ?? '');
      const el = {name: local(opening), attrs, children: [], text: ''};
      top.children.push(el);
      if (!selfClosing) stack.push(el);
    }
  }
  if (stack.length !== 1) throw new Error(`<${stack[stack.length - 1].name}> is not closed`);
  const [el] = root.children;
  if (!el || root.children.length > 1) throw new Error('an XML document has one root element');
  return el;
}

export const child = (el, name) => el?.children.find((c) => c.name === name);
export const children = (el, name) => el?.children.filter((c) => c.name === name) ?? [];
export const text = (el) => (el ? el.text.trim() : undefined);
