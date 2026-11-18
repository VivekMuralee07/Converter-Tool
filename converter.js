// PDF -> EPUB conversion, entirely client-side (pdf.js + JSZip).
import * as pdfjsLib from './lib/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sleep0 = () => new Promise((r) => setTimeout(r, 0));

export async function openPdf(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  let meta = {};
  try { meta = (await pdf.getMetadata()).info || {}; } catch { /* ignore */ }
  return { pdf, meta };
}

async function renderPage(page, scale, quality) {
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
  const out = { blob, w: canvas.width, h: canvas.height };
  canvas.width = canvas.height = 0;
  return out;
}

/* ---------- "fit to screen": trim margins, then cut pages into screen-shaped slices ---------- */
const toBlob = (c, q) => new Promise((res) => c.toBlob(res, 'image/jpeg', q));

async function renderCanvas(page, width) {
  const vp = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return canvas;
}

// ---- page analysis: find the body, its bands and columns on a downscaled copy of the page ----
function analyze(big, smallW = 600) {
  const f = big.width / smallW, h = Math.round(big.height / f);
  const sm = document.createElement('canvas'); sm.width = smallW; sm.height = h;
  const c = sm.getContext('2d', { willReadFrequently: true });
  c.drawImage(big, 0, 0, smallW, h);
  const d = c.getImageData(0, 0, smallW, h).data;
  sm.width = sm.height = 0;
  const ink = new Uint8Array(smallW * h);
  for (let p = 0, i = 0; p < ink.length; p++, i += 4) ink[p] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 < 222 ? 1 : 0;
  const mn = new Int32Array(h).fill(-1), mx = new Int32Array(h).fill(-1);
  for (let y = 0; y < h; y++) for (let x = 0; x < smallW; x++) if (ink[y * smallW + x]) { if (mn[y] < 0) mn[y] = x; mx[y] = x; }
  return { ink, w: smallW, h, f, mn, mx };
}

function groupRows(a, y0, y1, gap) { // runs of ink rows separated by more than `gap` blank rows
  const segs = []; let cur = null;
  for (let y = y0; y <= y1; y++) if (a.mn[y] >= 0) { if (cur && y - cur.y1 <= gap) cur.y1 = y; else { cur = { y0: y, y1: y }; segs.push(cur); } }
  return segs;
}

// Page body = everything except a running header/footer (thin band at the edge, set apart by a gap).
function findBody(a) {
  const segs = groupRows(a, 0, a.h - 1, Math.round(a.h * 0.012));
  if (!segs.length) return null;
  if (segs.length > 1 && segs[0].y1 < a.h * 0.12) segs.shift();
  if (segs.length > 1 && segs[segs.length - 1].y0 > a.h * 0.9) segs.pop();
  const y0 = segs[0].y0, y1 = segs[segs.length - 1].y1;
  let x0 = a.w, x1 = 0;
  for (let y = y0; y <= y1; y++) if (a.mn[y] >= 0) { if (a.mn[y] < x0) x0 = a.mn[y]; if (a.mx[y] > x1) x1 = a.mx[y]; }
  return { x0, x1, y0, y1 };
}

// Split a band into side-by-side columns where a clear vertical gutter runs through its whole height.
function splitColumns(a, band, x0, x1) {
  const bh = band.y1 - band.y0 + 1;
  if (bh < a.h * 0.11) return [{ x0, x1 }];
  const col = new Int32Array(a.w);
  for (let y = band.y0; y <= band.y1; y++) { const o = y * a.w; for (let x = x0; x <= x1; x++) col[x] += a.ink[o + x]; }
  const gutMin = Math.max(8, Math.round(a.w * 0.025)), minCol = Math.round(a.w * 0.11), speck = bh * 0.01;
  const cols = []; let start = x0, run = 0, runStart = 0;
  for (let x = x0; x <= x1; x++) {
    if (col[x] <= speck) { if (!run) runStart = x; run++; }
    else { if (run >= gutMin && runStart > start) { cols.push({ x0: start, x1: runStart - 1 }); start = x; } run = 0; }
  }
  cols.push({ x0: start, x1 });
  return cols.length > 1 && cols.every((c) => c.x1 - c.x0 >= minCol) ? cols : [{ x0, x1 }];
}

// Segments to show, in reading order (small-image coordinates). `split` = detect bands/columns.
function planSegments(a, split) {
  const body = findBody(a);
  if (!body) return null;
  if (!split) return { body, segs: [body] };
  const segs = [];
  for (const band of groupRows(a, body.y0, body.y1, Math.max(4, Math.round(a.h * 0.007)))) {
    let x0 = a.w, x1 = 0;
    for (let y = band.y0; y <= band.y1; y++) if (a.mn[y] >= 0) { if (a.mn[y] < x0) x0 = a.mn[y]; if (a.mx[y] > x1) x1 = a.mx[y]; }
    for (const c of splitColumns(a, band, x0, x1)) segs.push({ x0: c.x0, x1: c.x1, y0: band.y0, y1: band.y1 });
  }
  return { body, segs };
}

// Joins segments into one tall strip and cuts it into slices shaped like the screen, preferring
// uniform (blank) rows so text lines aren't sliced.
function makeStripper(aspect, Wc, emit) {
  const sliceH = Math.round(Wc / aspect), GAP = Math.round(Wc * 0.012);
  let strip = document.createElement('canvas'); strip.width = Wc; strip.height = sliceH * 3;
  let sctx = strip.getContext('2d', { willReadFrequently: true });
  sctx.fillStyle = '#fff'; sctx.fillRect(0, 0, Wc, strip.height);
  let pendH = 0;

  const flatRow = (data, y, top) => {
    const o = (y - top) * Wc * 4; let mn = 255, mx = 0;
    for (let x = 0; x < Wc; x++) { const g = data[o + x * 4 + 1]; if (g < mn) mn = g; if (g > mx) mx = g; if (mx - mn > 40) return false; }
    return true;
  };
  async function cut(final) {
    while (pendH >= sliceH || (final && pendH > 0)) {
      let end = Math.min(pendH, sliceH);
      if (pendH > sliceH) {
        const top = Math.floor(sliceH * 0.72), data = sctx.getImageData(0, top, Wc, sliceH - top).data;
        for (let t = sliceH; t > top; t--) if (t < pendH && flatRow(data, t - 1, top)) { end = t; break; }
      }
      const full = sctx.getImageData(0, 0, Wc, end).data;
      let ink = false;
      for (let i = 1; i < full.length; i += 16) if (full[i] < 200) { ink = true; break; }
      if (ink) {
        const c = document.createElement('canvas'); c.width = Wc; c.height = end;
        c.getContext('2d').drawImage(strip, 0, 0, Wc, end, 0, 0, Wc, end);
        await emit({ blob: await toBlob(c, 0.8), w: Wc, h: end });
        c.width = c.height = 0;
      }
      sctx.drawImage(strip, 0, end, Wc, pendH - end, 0, 0, Wc, pendH - end);
      sctx.fillStyle = '#fff'; sctx.fillRect(0, pendH - end, Wc, strip.height - (pendH - end));
      pendH -= end;
      if (final && pendH <= 0) break;
    }
  }
  return {
    async addSeg(src, sx, sy, sw, sh, dw, dh) {
      if (pendH + dh + GAP > strip.height) { // grow the strip
        const n = document.createElement('canvas'); n.width = Wc; n.height = pendH + dh + GAP + sliceH;
        const nc = n.getContext('2d', { willReadFrequently: true }); nc.fillStyle = '#fff'; nc.fillRect(0, 0, n.width, n.height);
        nc.drawImage(strip, 0, 0); strip.width = strip.height = 0; strip = n; sctx = nc;
      }
      sctx.drawImage(src, sx, sy, sw, sh, Math.round(Wc * 0.015), pendH, dw, dh);
      pendH += dh + Math.round(GAP / 2);
    },
    async endPage() { pendH += GAP; await cut(false); },
    finish: () => cut(true),
    get pending() { return pendH; },
  };
}

/* ---------- text extraction ---------- */
async function extractLines(page) {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const items = tc.items
    .filter((i) => i.str && i.str.trim() !== '')
    .map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], size: Math.hypot(i.transform[0], i.transform[1]) || i.height, w: i.width }));
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of items) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) < Math.max(it.size, last.size) * 0.7) last.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  return lines.map((l) => {
    l.items.sort((a, b) => a.x - b.x);
    let text = '', prev = null, chars = {};
    for (const it of l.items) {
      if (prev && !text.endsWith(' ') && !it.str.startsWith(' ') && it.x - (prev.x + prev.w) > it.size * 0.15) text += ' ';
      text += it.str; prev = it;
      const k = Math.round(it.size * 2) / 2; chars[k] = (chars[k] || 0) + it.str.length;
    }
    const size = +Object.entries(chars).sort((a, b) => b[1] - a[1])[0][0];
    const first = l.items[0], lastIt = l.items[l.items.length - 1];
    return { text: text.replace(/\s+/g, ' ').trim(), y: l.y, x: first.x, right: lastIt.x + lastIt.w, size, pageH: vp.height, pageW: vp.width };
  }).filter((l) => l.text);
}

function stripHeadersFooters(pagesLines) {
  const norm = (t) => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
  const edge = (l) => l.y > l.pageH * 0.92 || l.y < l.pageH * 0.07;
  const counts = new Map();
  for (const lines of pagesLines) {
    const seen = new Set();
    for (const l of lines) if (edge(l)) { const k = norm(l.text); if (!seen.has(k)) { seen.add(k); counts.set(k, (counts.get(k) || 0) + 1); } }
  }
  const min = Math.max(3, pagesLines.length * 0.4);
  return pagesLines.map((lines) => lines.filter((l) => !(edge(l) && (/^\W*\d+\W*$/.test(l.text) || counts.get(norm(l.text)) >= min))));
}

function buildBlocks(pagesLines) {
  const all = pagesLines.flat();
  const sizeW = {};
  for (const l of all) sizeW[l.size] = (sizeW[l.size] || 0) + l.text.length;
  const body = +(Object.entries(sizeW).sort((a, b) => b[1] - a[1])[0] || [12])[0];
  const xs = {};
  for (const l of all) { const k = Math.round(l.x / 2) * 2; xs[k] = (xs[k] || 0) + 1; }
  const left = +(Object.entries(xs).sort((a, b) => b[1] - a[1])[0] || [0])[0];

  const blocks = [];
  const endsSentence = /[.!?:"”’)\]]$/;
  pagesLines.forEach((lines, pi) => {
    const maxW = Math.max(1, ...lines.map((l) => l.right - l.x));
    let prev = null;
    for (const l of lines) {
      const level = l.size >= body * 1.5 ? 1 : l.size >= body * 1.15 ? 2 : 0;
      const isHead = level && l.text.length < 140;
      const last = blocks[blocks.length - 1];
      if (isHead) {
        if (last && last.t === 'h' + level && prev && last.page === pi) last.text += ' ' + l.text;
        else blocks.push({ t: 'h' + level, text: l.text, page: pi });
        prev = null; continue;
      }
      let startNew = !last || last.t[0] === 'h';
      if (!startNew && prev) {
        const gap = prev.y - l.y;
        const frag = l.text.length <= 4 || prev.text.length <= 4; // math symbols, bullets, stray glyphs
        const indent = !frag && l.x - left > l.size * 0.8;
        const shortPrev = prev.text.length > 20 && prev.right - prev.x < maxW * 0.7 && endsSentence.test(prev.text);
        startNew = gap > l.size * (frag ? 3 : 1.9) || indent || shortPrev;
      } else if (!startNew && !prev) {
        // first line on a new page: continue the paragraph unless it clearly starts a new one
        startNew = endsSentence.test(last.text) && (l.x - left > l.size * 0.8 || /^[A-Z“"‘']/.test(l.text) && /[.!?”"]$/.test(last.text));
        if (!/^[a-z0-9,;]/.test(l.text) && endsSentence.test(last.text)) startNew = true;
      }
      if (startNew) blocks.push({ t: 'p', text: l.text, page: pi });
      else if (/[-‐]$/.test(last.text) && /^[a-z]/.test(l.text)) last.text = last.text.slice(0, -1) + l.text;
      else last.text += ' ' + l.text;
      prev = l;
    }
    if (blocks.length && blocks[blocks.length - 1].page === pi) {/* keep order */}
  });
  return blocks;
}

function chunkChapters(blocks, pageCount, title, offset = 0) {
  const h1s = blocks.filter((b) => b.t === 'h1').length;
  const chapters = [];
  if (h1s >= 2) {
    let cur = null;
    for (const b of blocks) {
      if (b.t === 'h1') { cur = { title: b.text, blocks: [b] }; chapters.push(cur); }
      else { if (!cur) { cur = { title, blocks: [] }; chapters.push(cur); } cur.blocks.push(b); }
    }
  } else {
    const per = 10;
    for (let s = 0; s < pageCount; s += per) {
      const bl = blocks.filter((b) => b.page >= s && b.page < s + per);
      if (bl.length) chapters.push({ title: pageCount <= per ? title : `Pages ${offset + s + 1}–${offset + Math.min(pageCount, s + per)}`, blocks: bl });
    }
  }
  return chapters.length ? chapters : [{ title, blocks: [{ t: 'p', text: '(No extractable text found.)' }] }];
}

/* ---------- EPUB packaging ---------- */
const XHTML = (title, body, extra = '') => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
<head><meta charset="utf-8"/><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/>${extra}</head>
<body${body.startsWith('<div class="fx"') ? ' class="fxb"' : ''}>${body}</body></html>`;

const CSS = `body{font-family:serif;line-height:1.5;margin:0 .6em}h1{font-size:1.6em;margin:1.2em 0 .6em}h2{font-size:1.25em;margin:1em 0 .4em}
p{margin:0 0 .8em;text-align:justify}.page{margin:0;padding:0;text-align:center}.page img{max-width:100%;max-height:100%}
html,body.fxb{margin:0;padding:0;height:100%}.fx{margin:0;padding:0;width:100%;height:100vh;display:flex;align-items:center;justify-content:center;background:#fff}
.fx img{display:block;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain}`;

function uuid() { return 'urn:uuid:' + (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())); }

export async function convert(file, { title, author, mode, fit = false, aspect = 0.5, zoom = 1.5, from = 1, to = 0 }, onProgress = () => {}) {
  const { pdf } = await openPdf(file);
  const total = pdf.numPages;
  const first = Math.min(total, Math.max(1, from | 0 || 1)), last = Math.min(total, Math.max(first, to | 0 || total));
  const n = last - first + 1; // pages converted
  const cover = await renderPage(await pdf.getPage(first), 1.2, 0.8);
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file('OEBPS/style.css', CSS);
  zip.file('OEBPS/cover.jpg', cover.blob);

  const id = uuid();
  const result = { mode, title, author, pageCount: n, blocks: null, pageImages: null, coverBlob: cover.blob };
  let manifest = '', spine = '', toc = [];
  const fixed = mode === 'fixed';

  if (fixed) {
    result.pageImages = [];
    const add = (img, label, tocTitle) => {
      const name = `p${String(result.pageImages.length + 1).padStart(4, '0')}`;
      zip.file(`OEBPS/${name}.jpg`, img.blob);
      zip.file(`OEBPS/${name}.xhtml`, XHTML(label, `<div class="fx"><img src="${name}.jpg" alt="${esc(label)}" style="width:100%;height:auto"/></div>`, `<meta name="viewport" content="width=${img.w}, height=${img.h}"/>`));
      manifest += `<item id="${name}" href="${name}.xhtml" media-type="application/xhtml+xml"/><item id="${name}i" href="${name}.jpg" media-type="image/jpeg"/>`;
      spine += `<itemref idref="${name}"/>`;
      if (tocTitle) toc.push({ href: `${name}.xhtml`, title: tocTitle });
      result.pageImages.push(img.blob);
    };
    if (fit) {
      result.skipFirst = false;
      const Wc = 1100, split = zoom > 1;
      let emitted = 0;
      const starts = [];
      const strip = makeStripper(aspect, Wc, (img) => { emitted++; add(img, `Part ${emitted}`, null); });
      for (let k = 0; k < n; k++) {
        const pageNo = first + k;
        onProgress((k + 1) / n * 0.95, `Fitting page ${pageNo} (${k + 1} of ${n}) to screen`);
        const big = await renderCanvas(await pdf.getPage(pageNo), Math.round(Wc * (split ? 2.1 : 1) * 1.3));
        const a = analyze(big), plan = planSegments(a, split);
        if (plan) {
          starts.push({ slice: emitted + 1, title: `Page ${pageNo}` });
          const f = a.f, pad = Math.round(5 * f), fillW = Wc * 0.97;
          const rects = plan.segs.map((sg) => {
            const sx = Math.max(0, Math.floor(sg.x0 * f) - pad), sy = Math.max(0, Math.floor(sg.y0 * f) - pad);
            return { sx, sy, sw: Math.min(big.width - sx, Math.ceil((sg.x1 + 1) * f) + pad - sx), sh: Math.min(big.height - sy, Math.ceil((sg.y1 + 1) * f) + pad - sy) };
          });
          // One text size per page: the main column (height-weighted median width, ignoring slivers) fills the
          // width; wider items (figures) shrink to fit, narrower ones (sidebars) are not blown up.
          let pageScale = fillW / ((plan.body.x1 - plan.body.x0 + 1) * f + 2 * pad);
          if (split) {
            const main = rects.filter((r) => r.sw >= big.width * 0.22).sort((p, q) => p.sw - q.sw);
            const tot = main.reduce((t, r) => t + r.sh, 0);
            let acc = 0;
            for (const r of main) { acc += r.sh; if (acc >= tot / 2) { pageScale = fillW / r.sw; break; } }
          }
          for (const r of rects) {
            const sc = Math.min(fillW / r.sw, pageScale);
            await strip.addSeg(big, r.sx, r.sy, r.sw, r.sh, Math.round(r.sw * sc), Math.round(r.sh * sc));
          }
          await strip.endPage();
        }
        big.width = big.height = 0;
        await sleep0();
      }
      await strip.finish();
      const pad4 = (k) => `p${String(Math.min(k, emitted)).padStart(4, '0')}.xhtml`;
      starts.forEach((t) => emitted && toc.push({ href: pad4(t.slice), title: t.title }));
    } else {
      result.skipFirst = true;
      for (let i = first; i <= last; i++) {
        onProgress((i - first + 1) / n * 0.9, `Rendering page ${i} of ${last}`);
        add(i === first ? cover : await renderPage(await pdf.getPage(i), 1.6, 0.8), `Page ${i}`, `Page ${i}`);
        await sleep0();
      }
    }
    if (!result.pageImages.length) { add(cover, 'Page 1', 'Page 1'); }
  } else {
    const raw = [];
    for (let i = first; i <= last; i++) {
      onProgress((i - first + 1) / n * 0.8, `Reading page ${i} of ${last}`);
      raw.push(await extractLines(await pdf.getPage(i)));
      await sleep0();
    }
    onProgress(0.85, 'Building chapters…');
    const blocks = buildBlocks(stripHeadersFooters(raw));
    result.blocks = blocks;
    result.hasText = blocks.length > 0;
    const flat = raw.flat();
    result.messy = flat.length > 0 && flat.filter((l) => l.text.length <= 3).length / flat.length > 0.2;
    const chapters = chunkChapters(blocks, n, title, first - 1);
    chapters.forEach((c, i) => {
      const name = `c${String(i + 1).padStart(3, '0')}`;
      const body = c.blocks.map((b) => (b.t === 'p' ? `<p>${esc(b.text)}</p>` : `<${b.t}>${esc(b.text)}</${b.t}>`)).join('\n');
      zip.file(`OEBPS/${name}.xhtml`, XHTML(c.title, body));
      manifest += `<item id="${name}" href="${name}.xhtml" media-type="application/xhtml+xml"/>`;
      spine += `<itemref idref="${name}"/>`;
      toc.push({ href: `${name}.xhtml`, title: c.title });
    });
  }

  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><meta charset="utf-8"/><title>Contents</title></head>
<body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${toc.map((t) => `<li><a href="${t.href}">${esc(t.title)}</a></li>`).join('')}</ol></nav></body></html>`);
  zip.file('OEBPS/toc.ncx', `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${id}"/></head><docTitle><text>${esc(title)}</text></docTitle>
<navMap>${toc.map((t, i) => `<navPoint id="n${i}" playOrder="${i + 1}"><navLabel><text>${esc(t.title)}</text></navLabel><content src="${t.href}"/></navPoint>`).join('')}</navMap></ncx>`);
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">${id}</dc:identifier><dc:title>${esc(title)}</dc:title><dc:creator>${esc(author || 'Unknown')}</dc:creator><dc:language>en</dc:language>
<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
<meta name="cover" content="cover-img"/>${fixed ? '<meta property="rendition:layout">pre-paginated</meta><meta property="rendition:spread">none</meta><meta property="rendition:orientation">auto</meta>' : ''}
</metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="style.css" media-type="text/css"/><item id="cover-img" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>${manifest}</manifest>
<spine toc="ncx">${spine}</spine></package>`);

  onProgress(0.95, 'Packing EPUB…');
  result.epub = await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE' }, (m) => onProgress(0.95 + m.percent / 2000, 'Packing EPUB…'));
  onProgress(1, 'Done');
  return result;
}
