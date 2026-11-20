// Inline formatting helpers shared by the converter (PDF -> EPUB) and the reader (EPUB -> pages).
// A paragraph is plain `text` plus `fmt`: ranges [start, end, flags] where flags bit 1 = bold, bit 2 = italic.

// raw text + one flag per character -> whitespace collapsed and trimmed, flags kept in step, ranges merged
export function normalize(raw, flags) {
  let text = '', fl = [], space = false;
  for (let i = 0; i < raw.length; i++) {
    if (/\s/.test(raw[i])) { space = text.length > 0; continue; }
    if (space) { text += ' '; fl.push(0); space = false; }
    text += raw[i]; fl.push(flags[i] || 0);
  }
  return { text, fmt: toRanges(fl) };
}

export function toRanges(fl) {
  const out = []; let s = -1, f = 0;
  for (let i = 0; i <= fl.length; i++) {
    const v = i < fl.length ? fl[i] : 0;
    if (v !== f) { if (f) out.push([s, i, f]); s = i; f = v; }
    else if (s < 0) s = i;
  }
  // a lone space between two ranges of the same style belongs to both (keeps "bold words" in one piece)
  return out.map((r) => [...r]).reduce((acc, r) => { const p = acc[acc.length - 1]; if (p && p[2] === r[2] && r[0] - p[1] <= 1) p[1] = r[1]; else acc.push(r); return acc; }, []);
}

// ranges of a text slice [a, b) -> ranges relative to the slice
export const sliceFmt = (fmt, a, b) => (fmt || []).filter((r) => r[1] > a && r[0] < b).map((r) => [Math.max(r[0], a) - a, Math.min(r[1], b) - a, r[2]]);

// shift ranges by `by` characters (used when text is appended or its start is cut off)
export const shiftFmt = (fmt, by) => (fmt || []).map((r) => [r[0] + by, r[1] + by, r[2]]).filter((r) => r[1] > 0).map((r) => [Math.max(0, r[0]), r[1], r[2]]);

const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// text + ranges -> XHTML with <strong>/<em>
export function toHtml(text, fmt) {
  if (!fmt || !fmt.length) return escHtml(text);
  let out = '', pos = 0;
  for (const [s, e, f] of fmt.slice().sort((a, b) => a[0] - b[0])) {
    if (s < pos) continue;
    out += escHtml(text.slice(pos, s));
    let seg = escHtml(text.slice(s, e));
    if (f & 2) seg = `<em>${seg}</em>`;
    if (f & 1) seg = `<strong>${seg}</strong>`;
    out += seg; pos = e;
  }
  return out + escHtml(text.slice(pos));
}

// DOM element -> { text, fmt }, understanding <b>/<strong>/<i>/<em>/<cite> and font-weight / font-style inline styles
export function fromElement(el) {
  let raw = '', flags = [];
  const walk = (n, f) => {
    if (n.nodeType === 3) { for (const ch of n.nodeValue) { raw += ch; for (let k = 0; k < ch.length; k++) flags.push(f); } return; }
    if (n.nodeType !== 1) return;
    const tag = n.tagName.toLowerCase();
    if (tag === 'br') { raw += ' '; flags.push(0); return; }
    if (tag === 'script' || tag === 'style') return;
    let g = f; const st = n.getAttribute && n.getAttribute('style') || '';
    if (/^(b|strong)$/.test(tag) || /font-weight:\s*(bold|[6-9]00)/i.test(st)) g |= 1;
    if (/^(i|em|cite|dfn)$/.test(tag) || /font-style:\s*(italic|oblique)/i.test(st)) g |= 2;
    for (const c of n.childNodes) walk(c, g);
  };
  walk(el, 0);
  return normalize(raw, flags);
}
