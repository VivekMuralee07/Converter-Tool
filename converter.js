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

function chunkChapters(blocks, pageCount, title) {
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
      if (bl.length) chapters.push({ title: pageCount <= per ? title : `Pages ${s + 1}–${Math.min(pageCount, s + per)}`, blocks: bl });
    }
  }
  return chapters.length ? chapters : [{ title, blocks: [{ t: 'p', text: '(No extractable text found.)' }] }];
}

/* ---------- EPUB packaging ---------- */
const XHTML = (title, body, extra = '') => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
<head><meta charset="utf-8"/><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/>${extra}</head>
<body>${body}</body></html>`;

const CSS = `body{font-family:serif;line-height:1.5;margin:0 .6em}h1{font-size:1.6em;margin:1.2em 0 .6em}h2{font-size:1.25em;margin:1em 0 .4em}
p{margin:0 0 .8em;text-align:justify}.page{margin:0;padding:0;text-align:center}.page img{max-width:100%;max-height:100%}`;

function uuid() { return 'urn:uuid:' + (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())); }

export async function convert(file, { title, author, mode }, onProgress = () => {}) {
  const { pdf } = await openPdf(file);
  const n = pdf.numPages;
  const cover = await renderPage(await pdf.getPage(1), 1.2, 0.8);
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
    for (let i = 1; i <= n; i++) {
      onProgress(i / n * 0.9, `Rendering page ${i} of ${n}`);
      const img = i === 1 ? cover : await renderPage(await pdf.getPage(i), 1.6, 0.8);
      const name = `p${String(i).padStart(4, '0')}`;
      zip.file(`OEBPS/${name}.jpg`, img.blob);
      zip.file(`OEBPS/${name}.xhtml`, XHTML(`Page ${i}`, `<div class="page"><img src="${name}.jpg" alt="Page ${i}" style="width:100%;height:100%"/></div>`, `<meta name="viewport" content="width=${img.w}, height=${img.h}"/>`));
      manifest += `<item id="${name}" href="${name}.xhtml" media-type="application/xhtml+xml"/><item id="${name}i" href="${name}.jpg" media-type="image/jpeg"/>`;
      spine += `<itemref idref="${name}"/>`;
      toc.push({ href: `${name}.xhtml`, title: `Page ${i}` });
      result.pageImages.push(img.blob);
      await sleep0();
    }
  } else {
    const raw = [];
    for (let i = 1; i <= n; i++) {
      onProgress(i / n * 0.8, `Reading page ${i} of ${n}`);
      raw.push(await extractLines(await pdf.getPage(i)));
      await sleep0();
    }
    onProgress(0.85, 'Building chapters…');
    const blocks = buildBlocks(stripHeadersFooters(raw));
    result.blocks = blocks;
    result.hasText = blocks.length > 0;
    const flat = raw.flat();
    result.messy = flat.length > 0 && flat.filter((l) => l.text.length <= 3).length / flat.length > 0.2;
    const chapters = chunkChapters(blocks, n, title);
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
<meta name="cover" content="cover-img"/>${fixed ? '<meta property="rendition:layout">pre-paginated</meta><meta property="rendition:spread">auto</meta>' : ''}
</metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="style.css" media-type="text/css"/><item id="cover-img" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>${manifest}</manifest>
<spine toc="ncx">${spine}</spine></package>`);

  onProgress(0.95, 'Packing EPUB…');
  result.epub = await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE' }, (m) => onProgress(0.95 + m.percent / 2000, 'Packing EPUB…'));
  onProgress(1, 'Done');
  return result;
}
