// Document -> PDF: DOM/text -> blocks -> page layout -> PDF.
// Layout is shared by two backends: pdf-lib (real, selectable text; Latin scripts) and canvas (any script; page images).
import { LIBS } from './loader.js';

export const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792], a5: [419.53, 595.28] };

/* ---------- source file -> DOM ---------- */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function sourceToDoc(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  let html;
  if (ext === 'docx') {
    const mammoth = await LIBS.mammoth();
    html = (await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() })).value;
  } else if (ext === 'md' || ext === 'markdown') {
    const marked = await LIBS.marked();
    html = marked.parse(await file.text(), { gfm: true });
  } else if (ext === 'html' || ext === 'htm' || ext === 'xhtml') {
    html = await file.text();
  } else { // plain text: keep line breaks
    const t = (await file.text()).replace(/\r\n?/g, '\n');
    html = t.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const pageTitle = (doc.title || '').trim(); // read before <head> is removed
  doc.querySelectorAll('script,style,iframe,object,embed,noscript,head').forEach((n) => n.remove());
  const h = doc.querySelector('h1');
  return { body: doc.body, title: (pageTitle || (h && h.textContent) || '').trim() };
}

/* ---------- DOM -> blocks ---------- */
const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'PRE', 'BLOCKQUOTE', 'TABLE', 'HR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'FIGURE', 'FIGCAPTION', 'NAV', 'ASIDE', 'DL', 'DT', 'DD', 'BODY']);

export function domToBlocks(root) {
  const blocks = [];
  const inline = (node, style, runs) => {
    if (node.nodeType === 3) { const t = node.nodeValue.replace(/\s+/g, ' '); if (t) runs.push({ t, ...style }); return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (tag === 'BR') { runs.push({ t: '\n', ...style }); return; }
    if (tag === 'IMG') { runs.push({ img: node.getAttribute('src') || '', alt: node.getAttribute('alt') || '' }); return; }
    const s = { ...style };
    if (tag === 'B' || tag === 'STRONG' || /^H[1-6]$/.test(tag)) s.b = true;
    if (tag === 'I' || tag === 'EM' || tag === 'CITE') s.i = true;
    if (tag === 'CODE' || tag === 'KBD' || tag === 'TT') s.m = true;
    for (const c of node.childNodes) inline(c, s, runs);
  };
  const push = (type, runs, extra = {}) => { // splits out images, trims, drops empties
    let cur = [];
    const flushText = () => {
      if (cur.length) {
        cur[0] = { ...cur[0], t: cur[0].t.replace(/^\s+/, '') };
        const last = cur.length - 1; cur[last] = { ...cur[last], t: cur[last].t.replace(/\s+$/, '') };
        if (cur.some((r) => r.t.trim() !== '')) blocks.push({ type, runs: cur, ...extra });
      }
      cur = [];
    };
    for (const r of runs) { if (r.img !== undefined) { flushText(); blocks.push({ type: 'img', src: r.img, alt: r.alt }); } else cur.push(r); }
    flushText();
  };
  const walkChildren = (el, ctx) => {
    let runs = [];
    const flush = () => { push('p', runs, { q: ctx.q }); runs = []; };
    for (const c of el.childNodes) {
      if (c.nodeType === 1 && BLOCK_TAGS.has(c.tagName)) { flush(); block(c, ctx); } else inline(c, {}, runs);
    }
    flush();
  };
  const list = (el, ctx, depth) => {
    const ordered = el.tagName === 'OL'; let n = Number(el.getAttribute('start')) || 1;
    for (const li of el.children) {
      if (li.tagName !== 'LI') continue;
      const runs = [];
      for (const c of li.childNodes) { if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) continue; inline(c, {}, runs); }
      push('li', runs, { depth, marker: ordered ? `${n}.` : '•', q: ctx.q });
      n++;
      for (const c of li.children) if (c.tagName === 'UL' || c.tagName === 'OL') list(c, ctx, depth + 1);
    }
  };
  const block = (el, ctx) => {
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) { const runs = []; inline(el, {}, runs); push('h', runs, { level: +tag[1] }); }
    else if (tag === 'PRE') blocks.push({ type: 'code', text: el.textContent.replace(/\n+$/, ''), q: ctx.q });
    else if (tag === 'BLOCKQUOTE') walkChildren(el, { ...ctx, q: (ctx.q || 0) + 1 });
    else if (tag === 'UL' || tag === 'OL') list(el, ctx, 0);
    else if (tag === 'HR') blocks.push({ type: 'hr' });
    else if (tag === 'TABLE') {
      const rows = [...el.querySelectorAll('tr')].map((tr) => [...tr.children].map((td) => td.textContent.replace(/\s+/g, ' ').trim()));
      if (rows.length) blocks.push({ type: 'table', rows, header: !!el.querySelector('th') });
    } else walkChildren(el, ctx);
  };
  walkChildren(root, { q: 0 });
  return blocks;
}

/* ---------- backends ---------- */
const CTL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (s) => s.replace(CTL, '').replace(/ /g, ' ').replace(/\t/g, '    ');

async function bitmapToJpeg(bmp, maxSide = 2200, quality = 0.85) {
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
  c.width = c.height = 0;
  return blob.arrayBuffer();
}

async function makePdfLibBackend(w, h, title) {
  const { PDFDocument, StandardFonts, rgb } = await LIBS.pdflib();
  const doc = await PDFDocument.create();
  if (title) doc.setTitle(title);
  const F = StandardFonts;
  const fonts = {
    r: await doc.embedFont(F.Helvetica), b: await doc.embedFont(F.HelveticaBold), i: await doc.embedFont(F.HelveticaOblique), bi: await doc.embedFont(F.HelveticaBoldOblique),
    m: await doc.embedFont(F.Courier), mb: await doc.embedFont(F.CourierBold),
  };
  let page = null;
  const pick = (st) => (st.m ? (st.b ? fonts.mb : fonts.m) : st.b && st.i ? fonts.bi : st.b ? fonts.b : st.i ? fonts.i : fonts.r);
  const col = (c) => (c ? rgb(c[0], c[1], c[2]) : rgb(0, 0, 0));
  return {
    w, h, kind: 'text',
    measure: (s, st, size) => pick(st).widthOfTextAtSize(s, size),
    text: (s, x, base, st, size, color) => { if (s.trim()) page.drawText(s, { x, y: h - base, size, font: pick(st), color: col(color) }); },
    rect: (x, y, ww, hh, color) => page.drawRectangle({ x, y: h - y - hh, width: ww, height: hh, color: col(color) }),
    async image(bmp, x, y, ww, hh) { const img = await doc.embedJpg(await bitmapToJpeg(bmp)); page.drawImage(img, { x, y: h - y - hh, width: ww, height: hh }); },
    newPage: () => { page = doc.addPage([w, h]); },
    finish: async () => new Blob([await doc.save()], { type: 'application/pdf' }),
    supported: (() => { const set = new Set(fonts.r.getCharacterSet()); return (cp) => cp < 128 || set.has(cp); })(),
  };
}

async function makeCanvasBackend(w, h, title) {
  const { PDFDocument } = await LIBS.pdflib();
  const S = 2, pages = [];
  let cv = null, ctx = null;
  const probe = document.createElement('canvas').getContext('2d');
  const fontOf = (st, size) => `${st.i ? 'italic ' : ''}${st.b ? 'bold ' : ''}${size}px ${st.m ? '"Courier New", ui-monospace, monospace' : 'system-ui, "Noto Sans", "Segoe UI", Roboto, sans-serif'}`;
  const flushPage = async () => { if (cv) { pages.push(await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.82))); cv.width = cv.height = 0; cv = null; } };
  return {
    w, h, kind: 'raster',
    measure: (s, st, size) => { probe.font = fontOf(st, size); return probe.measureText(s).width; },
    text: (s, x, base, st, size, color) => { ctx.font = fontOf(st, size); ctx.fillStyle = color ? `rgb(${color.map((v) => Math.round(v * 255)).join(',')})` : '#000'; ctx.fillText(s, x, base); },
    rect: (x, y, ww, hh, color) => { ctx.fillStyle = `rgb(${color.map((v) => Math.round(v * 255)).join(',')})`; ctx.fillRect(x, y, ww, hh); },
    async image(bmp, x, y, ww, hh) { ctx.drawImage(bmp, x, y, ww, hh); },
    newPage: async () => { await flushPage(); cv = document.createElement('canvas'); cv.width = w * S; cv.height = h * S; ctx = cv.getContext('2d'); ctx.scale(S, S); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.textBaseline = 'alphabetic'; },
    async finish() {
      await flushPage();
      const doc = await PDFDocument.create(); if (title) doc.setTitle(title);
      for (const p of pages) { const img = await doc.embedJpg(await p.arrayBuffer()); doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h }); }
      return new Blob([await doc.save()], { type: 'application/pdf' });
    },
    supported: () => true,
  };
}

/* ---------- layout ---------- */
const HEAD = [0, 2.0, 1.6, 1.35, 1.15, 1.05, 1];
const GREY = [0.93, 0.93, 0.93], BAR = [0.7, 0.7, 0.7], LINE = [0.6, 0.6, 0.6];

async function layout(be, blocks, { fs, margin }) {
  const W = be.w, H = be.h, cw = W - 2 * margin, bottom = H - margin;
  let y = margin, started = false;
  const newPage = async () => { await be.newPage(); y = margin; started = true; };
  await newPage();
  const ensure = async (need) => { if (y + need > bottom && y > margin) await newPage(); };

  // words with style, honouring hard line breaks
  const tokens = (runs) => {
    const out = [];
    for (const r of runs) {
      const st = { b: r.b, i: r.i, m: r.m };
      for (const [k, part] of r.t.split('\n').entries()) {
        if (k > 0) out.push({ br: true });
        for (const w of part.split(/( )/)) { if (w === '') continue; out.push(w === ' ' ? { sp: true, st } : { w: clean(w), st }); }
      }
    }
    return out;
  };

  async function paragraph(runs, { size = fs, x0 = margin, width = cw, base = {}, color, gap = 0.6, extra, noBreakBefore }) {
    const lh = size * 1.35, toks = tokens(runs).map((t) => (t.st ? { ...t, st: { ...t.st, ...Object.fromEntries(Object.entries(base).filter(([, v]) => v)) } } : t));
    const lines = []; let line = [], lw = 0;
    const endLine = () => { while (line.length && line[line.length - 1].sp) line.pop(); lines.push(line); line = []; lw = 0; };
    for (const t of toks) {
      if (t.br) { endLine(); continue; }
      if (t.sp) { if (line.length) { const w = be.measure(' ', t.st, size); line.push({ ...t, wd: w }); lw += w; } continue; }
      let word = t.w, wd = be.measure(word, t.st, size);
      while (wd > width) { // very long word: split by characters
        let n = word.length; while (n > 1 && be.measure(word.slice(0, n), t.st, size) > width - lw) n--;
        if (lw > 0 && n <= 1) { endLine(); continue; }
        const head = word.slice(0, n); line.push({ w: head, st: t.st, wd: be.measure(head, t.st, size) }); endLine(); word = word.slice(n); wd = be.measure(word, t.st, size);
      }
      if (lw + wd > width && line.length) endLine();
      if (word) { line.push({ w: word, st: t.st, wd }); lw += wd; }
    }
    if (line.length || !lines.length) endLine();
    for (const [k, ln] of lines.entries()) {
      await ensure(lh * (k === 0 && noBreakBefore ? 2 : 1));
      if (extra) extra(y, lh, k);
      // draw each line as few text objects as possible (same style runs merged, spaces included) so text copies/searches cleanly
      let x = x0, i = 0;
      while (i < ln.length) {
        const key = (t) => `${t.st.b ? 1 : 0}${t.st.i ? 1 : 0}${t.st.m ? 1 : 0}`; let str = '', wd = 0, j = i;
        while (j < ln.length && key(ln[j]) === key(ln[i])) { str += ln[j].sp ? ' ' : ln[j].w; wd += ln[j].wd; j++; }
        if (str.trim()) be.text(str, x, y + size, ln[i].st, size, color);
        x += wd; i = j;
      }
      y += lh;
    }
    y += size * gap;
  }

  for (const b of blocks) {
    const qx = (b.q || 0) * 16, qextra = b.q ? (yy, lh) => be.rect(margin + qx - 10, yy, 2, lh, BAR) : undefined;
    if (b.type === 'h') {
      const size = fs * (HEAD[Math.min(6, b.level)] || 1);
      if (y > margin) y += size * 0.5;
      await paragraph(b.runs, { size, base: { b: true }, gap: 0.35, noBreakBefore: true });
    } else if (b.type === 'p') {
      await paragraph(b.runs, { x0: margin + qx, width: cw - qx, extra: qextra });
    } else if (b.type === 'li') {
      const ind = qx + 16 + b.depth * 16;
      await ensure(fs * 1.35);
      const mw = be.measure(b.marker, {}, fs); be.text(b.marker, margin + ind - 6 - mw, y + fs, {}, fs);
      await paragraph(b.runs, { x0: margin + ind, width: cw - ind, gap: 0.25 });
    } else if (b.type === 'code') {
      const size = fs * 0.85, lh = size * 1.3, st = { m: true };
      for (const raw of clean(b.text).split('\n')) {
        let rest = raw; const parts = [];
        do { let n = rest.length; while (n > 1 && be.measure(rest.slice(0, n), st, size) > cw - 12) n--; parts.push(rest.slice(0, n)); rest = rest.slice(n); } while (rest.length);
        for (const p of parts) { await ensure(lh); be.rect(margin, y, cw, lh, GREY); be.text(p, margin + 6, y + size, st, size); y += lh; }
      }
      y += fs * 0.6;
    } else if (b.type === 'hr') {
      await ensure(fs); y += fs * 0.4; be.rect(margin, y, cw, 0.8, LINE); y += fs * 0.8;
    } else if (b.type === 'table') {
      const cols = Math.max(...b.rows.map((r) => r.length)), colW = cw / cols, size = fs * 0.9, lh = size * 1.3;
      for (const [ri, row] of b.rows.entries()) {
        const head = b.header && ri === 0, st = { b: head };
        const cells = row.map((txt) => { // wrap each cell
          const lines = []; let cur = '';
          for (const w of clean(txt).split(' ')) { const t = cur ? cur + ' ' + w : w; if (cur && be.measure(t, st, size) > colW - 8) { lines.push(cur); cur = w; } else cur = t; }
          lines.push(cur); return lines;
        });
        const rh = Math.max(...cells.map((c) => c.length), 1) * lh + 6;
        await ensure(rh);
        if (head) be.rect(margin, y, cw, rh, GREY);
        be.rect(margin, y, cw, 0.6, LINE); be.rect(margin, y + rh, cw, 0.6, LINE);
        for (let c = 0; c <= cols; c++) be.rect(margin + c * colW, y, 0.6, rh, LINE);
        cells.forEach((lines, c) => lines.forEach((ln, k) => be.text(ln, margin + c * colW + 4, y + 3 + size + k * lh, st, size)));
        y += rh;
      }
      y += fs * 0.7;
    } else if (b.type === 'img') {
      try {
        const bmp = await createImageBitmap(await (await fetch(b.src)).blob());
        const maxH = bottom - margin, s = Math.min(1, cw / bmp.width, maxH / bmp.height), ww = bmp.width * s, hh = bmp.height * s;
        await ensure(hh); await be.image(bmp, margin, y, ww, hh); y += hh + fs * 0.6; bmp.close && bmp.close();
      } catch { if (b.alt) await paragraph([{ t: `[${b.alt}]`, i: true }], {}); }
    }
  }
}

/* ---------- public ---------- */
export function blocksText(blocks) {
  return blocks.map((b) => (b.runs ? b.runs.map((r) => r.t || '').join('') : b.text || (b.rows ? b.rows.flat().join(' ') : ''))).join('\n');
}

export async function blocksToPdf(blocks, { size = 'a4', fontSize = 11, margin = 54, title = '' } = {}) {
  const [w, h] = PAGE_SIZES[size] || PAGE_SIZES.a4;
  const text = blocksText(blocks);
  let be = await makePdfLibBackend(w, h, title), raster = false;
  for (const ch of text) { const cp = ch.codePointAt(0); if (cp > 32 && !be.supported(cp) && cp !== 0xa0) { raster = true; break; } }
  if (raster) be = await makeCanvasBackend(w, h, title);
  await layout(be, blocks, { fs: fontSize, margin });
  return { blob: await be.finish(), raster };
}
