// Registry of converters. Each tool: { id, icon, title, desc, accept, multiple, ordered, options[], run(files, opts, progress) }
// run() returns [{ name, blob, note? }]. Everything runs on the device.
import { LIBS } from './loader.js';
import { openPdf } from './converter.js';
import { PAGE_SIZES, sourceToDoc, domToBlocks, blocksToPdf, blocksText } from './pdfdoc.js';
import { buildEpub } from './epubbuild.js';
import { parseEpub } from './reader.js';

const baseName = (n) => n.replace(/\.[^.]+$/, '') || 'file';
const toBlob = (c, type, q) => new Promise((r) => c.toBlob(r, type, q));
const sleep0 = () => new Promise((r) => setTimeout(r, 0));
const pdfBlob = (bytes) => new Blob([bytes], { type: 'application/pdf' });

async function decodeImage(file) {
  try { return await createImageBitmap(file); } catch { /* e.g. SVG */ }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error(`"${file.name}" is not an image this phone can read (HEIC/RAW are not supported yet).`)); i.src = url; });
    return await createImageBitmap(img);
  } finally { URL.revokeObjectURL(url); }
}

// "1-3,5,7-"  ->  [1,2,3,5,7,8,...]   (order kept; blank = all pages)
export function parseRanges(str, n) {
  const s = (str || '').trim().toLowerCase();
  if (!s || s === 'all') return Array.from({ length: n }, (_, i) => i + 1);
  const out = [];
  for (const part of s.split(',')) {
    const t = part.trim(); if (!t) continue;
    const m = /^(\d*)\s*-\s*(\d*)$/.exec(t);
    let a, b;
    if (m) { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : n; } else if (/^\d+$/.test(t)) a = b = +t; else throw new Error(`"${t}" is not a valid page range. Use for example 1-3,5,8-`);
    if (a < 1 || b > n || a > b) throw new Error(`Pages "${t}" are outside this PDF (it has ${n} pages).`);
    for (let p = a; p <= b; p++) out.push(p);
  }
  if (!out.length) throw new Error('No pages selected.');
  return out;
}

async function loadPdfLib(file) {
  const { PDFDocument } = await LIBS.pdflib();
  try { return await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: false }); }
  catch (e) { throw new Error(/encrypt/i.test(e.message) ? `"${file.name}" is password protected.` : `Could not read "${file.name}" as a PDF.`); }
}

async function renderPageBlob(page, scale, type, q) {
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: x, viewport: vp }).promise;
  const blob = await toBlob(c, type, q); const w = c.width, h = c.height; c.width = c.height = 0;
  return { blob, w, h };
}

const IMG_ACCEPT = 'image/*,.jpg,.jpeg,.png,.webp,.gif,.bmp,.svg,.avif';
const DOC_ACCEPT = '.txt,.md,.markdown,.html,.htm,.docx,text/plain';

export const TOOLS = [
  {
    id: 'image', icon: '🖼️', title: 'Image converter', desc: 'JPG, PNG and WebP — resize and compress',
    accept: IMG_ACCEPT, multiple: true,
    options: [
      { id: 'format', label: 'Convert to', type: 'select', value: 'jpeg', choices: [['jpeg', 'JPG'], ['png', 'PNG'], ['webp', 'WebP']] },
      { id: 'quality', label: 'Quality', type: 'select', value: '0.85', choices: [['0.95', 'Best'], ['0.85', 'High'], ['0.7', 'Medium'], ['0.5', 'Small file']], show: (o) => o.format !== 'png' },
      { id: 'max', label: 'Longest side (px)', type: 'number', placeholder: 'Original size' },
    ],
    async run(files, o, progress) {
      const mime = 'image/' + o.format, ext = o.format === 'jpeg' ? 'jpg' : o.format, out = [];
      for (const [i, f] of files.entries()) {
        progress(i / files.length, `Converting ${f.name}`);
        const bmp = await decodeImage(f);
        const s = o.max > 0 ? Math.min(1, o.max / Math.max(bmp.width, bmp.height)) : 1;
        const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
        const x = c.getContext('2d'); if (o.format === 'jpeg') { x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); }
        x.drawImage(bmp, 0, 0, c.width, c.height); bmp.close && bmp.close();
        const blob = await toBlob(c, mime, +o.quality); c.width = c.height = 0;
        if (!blob || blob.type !== mime) throw new Error(`This browser can't create ${o.format.toUpperCase()} files.`);
        out.push({ name: `${baseName(f.name)}.${ext}`, blob }); await sleep0();
      }
      return out;
    },
  },
  {
    id: 'img2pdf', icon: '📄', title: 'Images → PDF', desc: 'Combine photos or scans into one PDF',
    accept: IMG_ACCEPT, multiple: true, ordered: true,
    options: [
      { id: 'size', label: 'Page size', type: 'select', value: 'a4', choices: [['a4', 'A4'], ['letter', 'Letter'], ['fit', 'Same as the image']] },
      { id: 'margin', label: 'Margin', type: 'select', value: '0', choices: [['0', 'None'], ['24', 'Small'], ['48', 'Normal']], show: (o) => o.size !== 'fit' },
      { id: 'quality', label: 'Quality', type: 'select', value: '0.85', choices: [['0.92', 'Best'], ['0.85', 'High'], ['0.7', 'Medium'], ['0.5', 'Small file']] },
    ],
    async run(files, o, progress) {
      const { PDFDocument } = await LIBS.pdflib(), doc = await PDFDocument.create();
      for (const [i, f] of files.entries()) {
        progress(i / files.length, `Adding ${f.name}`);
        const bmp = await decodeImage(f), s = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
        const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
        const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0, c.width, c.height); bmp.close && bmp.close();
        const img = await doc.embedJpg(await (await toBlob(c, 'image/jpeg', +o.quality)).arrayBuffer());
        let pw, ph;
        if (o.size === 'fit') { const k = Math.min(1, 842 / Math.max(c.width, c.height)); pw = c.width * k; ph = c.height * k; }
        else { [pw, ph] = PAGE_SIZES[o.size]; if (c.width > c.height) [pw, ph] = [ph, pw]; }
        const m = o.size === 'fit' ? 0 : +o.margin, k = Math.min((pw - 2 * m) / c.width, (ph - 2 * m) / c.height), w = c.width * k, h = c.height * k;
        doc.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
        c.width = c.height = 0; await sleep0();
      }
      return [{ name: files.length === 1 ? `${baseName(files[0].name)}.pdf` : 'images.pdf', blob: pdfBlob(await doc.save()) }];
    },
  },
  {
    id: 'pdf2img', icon: '🏞️', title: 'PDF → Images', desc: 'Save PDF pages as PNG or JPG',
    accept: '.pdf,application/pdf', multiple: false,
    options: [
      { id: 'format', label: 'Format', type: 'select', value: 'png', choices: [['png', 'PNG (sharp)'], ['jpeg', 'JPG (smaller)']] },
      { id: 'dpi', label: 'Resolution', type: 'select', value: '150', choices: [['100', 'Low (100 dpi)'], ['150', 'Normal (150 dpi)'], ['220', 'High (220 dpi)']] },
      { id: 'pages', label: 'Pages', type: 'text', placeholder: 'All  (or e.g. 1-3,5)' },
    ],
    async run([f], o, progress) {
      const { pdf } = await openPdf(f), list = parseRanges(o.pages, pdf.numPages), out = [];
      for (const [i, p] of list.entries()) {
        progress(i / list.length, `Rendering page ${p} of ${pdf.numPages}`);
        const { blob } = await renderPageBlob(await pdf.getPage(p), +o.dpi / 72, 'image/' + o.format, 0.9);
        out.push({ name: `${baseName(f.name)}-page-${String(p).padStart(3, '0')}.${o.format === 'jpeg' ? 'jpg' : 'png'}`, blob }); await sleep0();
      }
      return out;
    },
  },
  {
    id: 'pdfmerge', icon: '🧩', title: 'Merge PDFs', desc: 'Join several PDFs into one, in the order you choose',
    accept: '.pdf,application/pdf', multiple: true, ordered: true, min: 2, options: [],
    async run(files, _o, progress) {
      const { PDFDocument } = await LIBS.pdflib(), out = await PDFDocument.create();
      for (const [i, f] of files.entries()) {
        progress(i / files.length, `Adding ${f.name}`);
        const src = await loadPdfLib(f);
        (await out.copyPages(src, src.getPageIndices())).forEach((p) => out.addPage(p)); await sleep0();
      }
      return [{ name: 'merged.pdf', blob: pdfBlob(await out.save()) }];
    },
  },
  {
    id: 'pdfsplit', icon: '✂️', title: 'Split PDF', desc: 'Extract pages or cut a PDF into parts',
    accept: '.pdf,application/pdf', multiple: false,
    options: [
      { id: 'mode', label: 'Split by', type: 'select', value: 'ranges', choices: [['ranges', 'Page ranges'], ['each', 'Every page separately'], ['every', 'Every N pages']] },
      { id: 'ranges', label: 'Ranges (one file per group)', type: 'text', placeholder: 'e.g. 1-3, 4-6, 9', show: (o) => o.mode === 'ranges' },
      { id: 'n', label: 'Pages per file', type: 'number', value: 10, show: (o) => o.mode === 'every' },
    ],
    async run([f], o, progress) {
      const { PDFDocument } = await LIBS.pdflib(), src = await loadPdfLib(f), n = src.getPageCount();
      let groups;
      if (o.mode === 'each') groups = Array.from({ length: n }, (_, i) => [i + 1]);
      else if (o.mode === 'every') { const k = Math.max(1, +o.n || 1); groups = []; for (let i = 1; i <= n; i += k) groups.push(Array.from({ length: Math.min(k, n - i + 1) }, (_, j) => i + j)); }
      else { if (!(o.ranges || '').trim()) throw new Error('Enter the pages you want, for example 1-3, 4-6.'); groups = o.ranges.split(',').map((g) => parseRanges(g, n)); }
      const out = [];
      for (const [i, g] of groups.entries()) {
        progress(i / groups.length, `Creating part ${i + 1} of ${groups.length}`);
        const d = await PDFDocument.create(); (await d.copyPages(src, g.map((p) => p - 1))).forEach((p) => d.addPage(p));
        out.push({ name: `${baseName(f.name)}-part${i + 1}.pdf`, blob: pdfBlob(await d.save()) }); await sleep0();
      }
      return out;
    },
  },
  {
    id: 'pdforganize', icon: '🔀', title: 'Organize pages', desc: 'Reorder, delete or rotate PDF pages',
    accept: '.pdf,application/pdf', multiple: false,
    options: [
      { id: 'pages', label: 'Pages to keep, in order', type: 'text', placeholder: 'All  (e.g. 3,1,2,5-8 — leave out pages to delete them)' },
      { id: 'rotate', label: 'Rotate pages', type: 'select', value: '0', choices: [['0', 'No rotation'], ['90', '90° clockwise'], ['180', '180°'], ['270', '90° counter-clockwise']] },
    ],
    async run([f], o, progress) {
      const { PDFDocument, degrees } = await LIBS.pdflib(), src = await loadPdfLib(f), list = parseRanges(o.pages, src.getPageCount());
      progress(0.3, 'Rearranging pages');
      const d = await PDFDocument.create(), pages = await d.copyPages(src, list.map((p) => p - 1));
      pages.forEach((p) => { if (+o.rotate) p.setRotation(degrees((p.getRotation().angle + +o.rotate) % 360)); d.addPage(p); });
      return [{ name: `${baseName(f.name)}-organized.pdf`, blob: pdfBlob(await d.save()) }];
    },
  },
  {
    id: 'pdfcompress', icon: '🗜️', title: 'Compress PDF', desc: 'Make a PDF smaller',
    accept: '.pdf,application/pdf', multiple: false,
    options: [
      { id: 'mode', label: 'Method', type: 'select', value: 'light', choices: [['light', 'Light — keeps text selectable'], ['strong', 'Strong — turns pages into images']] },
      { id: 'level', label: 'Strength', type: 'select', value: 'medium', choices: [['high', 'Better quality'], ['medium', 'Balanced'], ['low', 'Smallest file']], show: (o) => o.mode === 'strong' },
    ],
    async run([f], o, progress) {
      const { PDFDocument } = await LIBS.pdflib();
      if (o.mode === 'light') { progress(0.4, 'Optimizing'); const d = await loadPdfLib(f); return [{ name: `${baseName(f.name)}-compressed.pdf`, blob: pdfBlob(await d.save({ useObjectStreams: true })), note: 'Light mode only removes overhead, so some PDFs shrink very little.' }]; }
      const { pdf } = await openPdf(f), q = { high: [150, 0.8], medium: [110, 0.65], low: [80, 0.5] }[o.level], d = await PDFDocument.create();
      for (let p = 1; p <= pdf.numPages; p++) {
        progress((p - 1) / pdf.numPages, `Compressing page ${p} of ${pdf.numPages}`);
        const page = await pdf.getPage(p), base = page.getViewport({ scale: 1 });
        const { blob } = await renderPageBlob(page, q[0] / 72, 'image/jpeg', q[1]);
        d.addPage([base.width, base.height]).drawImage(await d.embedJpg(await blob.arrayBuffer()), { x: 0, y: 0, width: base.width, height: base.height }); await sleep0();
      }
      const blob = pdfBlob(await d.save());
      return [{ name: `${baseName(f.name)}-compressed.pdf`, blob, note: blob.size >= f.size ? 'The result is not smaller than the original — keep the original.' : 'Pages are now images, so text can no longer be selected.' }];
    },
  },
  {
    id: 'doc2pdf', icon: '📝', title: 'Document → PDF', desc: 'Word (.docx), Markdown, HTML and text to PDF',
    accept: DOC_ACCEPT, multiple: true,
    options: [
      { id: 'size', label: 'Page size', type: 'select', value: 'a4', choices: [['a4', 'A4'], ['letter', 'Letter'], ['a5', 'A5']] },
      { id: 'fontSize', label: 'Text size', type: 'select', value: '11', choices: [['10', 'Small'], ['11', 'Normal'], ['13', 'Large'], ['15', 'Extra large']] },
      { id: 'margin', label: 'Margins', type: 'select', value: '54', choices: [['36', 'Narrow'], ['54', 'Normal'], ['72', 'Wide']] },
    ],
    async run(files, o, progress) {
      const out = [];
      for (const [i, f] of files.entries()) {
        progress(i / files.length, `Converting ${f.name}`);
        const { body, title } = await sourceToDoc(f), blocks = domToBlocks(body);
        if (!blocks.length) throw new Error(`"${f.name}" has no readable text.`);
        const { blob, raster } = await blocksToPdf(blocks, { size: o.size, fontSize: +o.fontSize, margin: +o.margin, title: title || baseName(f.name) });
        out.push({ name: `${baseName(f.name)}.pdf`, blob, note: raster ? 'Contains characters outside the standard PDF fonts, so pages were drawn as images (text is not selectable).' : '' }); await sleep0();
      }
      return out;
    },
  },
  {
    id: 'doc2epub', icon: '📚', title: 'Document → EPUB', desc: 'Word (.docx), Markdown, HTML and text to an e-book',
    accept: DOC_ACCEPT, multiple: true,
    options: [
      { id: 'title', label: 'Title', type: 'text', placeholder: 'Same as the file name' },
      { id: 'author', label: 'Author', type: 'text', placeholder: 'Optional' },
    ],
    async run(files, o, progress) {
      const out = [];
      for (const [i, f] of files.entries()) {
        progress(i / files.length, `Converting ${f.name}`);
        const { body, title } = await sourceToDoc(f);
        if (!body.textContent.trim() && !body.querySelector('img')) throw new Error(`"${f.name}" has no readable content.`);
        const blob = await buildEpub(body, { title: (files.length === 1 && o.title) || title || baseName(f.name), author: o.author || '' });
        out.push({ name: `${baseName(f.name)}.epub`, blob, note: 'Open it in “My books” to read it.' }); await sleep0();
      }
      return out;
    },
  },
  {
    id: 'epub2x', icon: '📤', title: 'EPUB → PDF / text', desc: 'Turn an e-book into a PDF or a plain-text file',
    accept: '.epub,application/epub+zip', multiple: false,
    options: [{ id: 'format', label: 'Convert to', type: 'select', value: 'pdf', choices: [['pdf', 'PDF'], ['txt', 'Plain text']] }],
    async run([f], o, progress) {
      progress(0.1, 'Reading e-book');
      const book = await parseEpub(f), name = baseName(f.name);
      if (book.lazyImages) { // fixed-layout book made of page images
        if (o.format === 'txt') throw new Error('This e-book is made of page images, so it has no text to export. Choose PDF instead.');
        const { PDFDocument } = await LIBS.pdflib(), d = await PDFDocument.create();
        for (let i = 0; i < book.imageCount; i++) {
          progress(0.1 + 0.85 * i / book.imageCount, `Adding page ${i + 1} of ${book.imageCount}`);
          const bmp = await createImageBitmap(await book.loadImage(i)), c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
          const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0); bmp.close();
          const img = await d.embedJpg(await (await toBlob(c, 'image/jpeg', 0.85)).arrayBuffer()), k = Math.min(1, 842 / Math.max(c.width, c.height));
          d.addPage([c.width * k, c.height * k]).drawImage(img, { x: 0, y: 0, width: c.width * k, height: c.height * k }); c.width = c.height = 0; await sleep0();
        }
        return [{ name: `${name}.pdf`, blob: pdfBlob(await d.save()) }];
      }
      const blocks = book.blocks.map((b) => (b.t === 'p' ? { type: 'p', runs: [{ t: b.text }] } : { type: 'h', level: b.t === 'h1' ? 1 : 2, runs: [{ t: b.text, b: true }] }));
      if (o.format === 'txt') return [{ name: `${name}.txt`, blob: new Blob([blocksText(blocks).replace(/\n/g, '\n\n')], { type: 'text/plain' }) }];
      progress(0.5, 'Laying out pages');
      const { blob, raster } = await blocksToPdf(blocks, { title: book.title });
      return [{ name: `${name}.pdf`, blob, note: raster ? 'Pages were drawn as images because of non-Latin characters (text is not selectable).' : '' }];
    },
  },
  {
    id: 'data', icon: '📊', title: 'CSV · JSON · Excel', desc: 'Convert spreadsheets and data files',
    accept: '.csv,.json,.xlsx,.xlsm,text/csv,application/json', multiple: true,
    options: [{ id: 'target', label: 'Convert to', type: 'select', value: 'xlsx', choices: [['xlsx', 'Excel (.xlsx)'], ['csv', 'CSV'], ['json', 'JSON']] }],
    async run(files, o, progress) {
      const X = await LIBS.xlsx(), out = [];
      for (const [i, f] of files.entries()) {
        progress(i / files.length, `Converting ${f.name}`);
        const ext = (f.name.split('.').pop() || '').toLowerCase(); let wb;
        if (ext === 'json') {
          let data; try { data = JSON.parse(await f.text()); } catch { throw new Error(`"${f.name}" is not valid JSON.`); }
          wb = X.utils.book_new();
          if (Array.isArray(data)) X.utils.book_append_sheet(wb, X.utils.json_to_sheet(data.map((r) => (r && typeof r === 'object' ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v && typeof v === 'object' ? JSON.stringify(v) : v])) : { value: r }))), 'Sheet1');
          else if (data && typeof data === 'object' && Object.values(data).every(Array.isArray)) for (const [k, v] of Object.entries(data)) X.utils.book_append_sheet(wb, X.utils.json_to_sheet(v), k.slice(0, 31) || 'Sheet');
          else X.utils.book_append_sheet(wb, X.utils.json_to_sheet([data]), 'Sheet1');
        } else if (ext === 'csv') wb = X.read(await f.text(), { type: 'string' });
        else wb = X.read(await f.arrayBuffer(), { type: 'array', cellDates: true });
        const name = baseName(f.name);
        if (o.target === 'xlsx') out.push({ name: `${name}.xlsx`, blob: new Blob([X.write(wb, { type: 'array', bookType: 'xlsx' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }) });
        else for (const sn of wb.SheetNames) {
          const ws = wb.Sheets[sn], suffix = wb.SheetNames.length > 1 ? `-${sn.replace(/[\\/:*?"<>|]+/g, '_')}` : '';
          if (o.target === 'csv') out.push({ name: `${name}${suffix}.csv`, blob: new Blob(['﻿' + X.utils.sheet_to_csv(ws)], { type: 'text/csv' }) });
          else out.push({ name: `${name}${suffix}.json`, blob: new Blob([JSON.stringify(X.utils.sheet_to_json(ws, { defval: '' }), null, 2)], { type: 'application/json' }) });
        }
        await sleep0();
      }
      return out;
    },
  },
  {
    id: 'zip', icon: '🗃️', title: 'Create ZIP', desc: 'Put any files into one ZIP archive',
    accept: '*/*', multiple: true, ordered: false,
    options: [{ id: 'name', label: 'Archive name', type: 'text', value: 'files' }],
    async run(files, o, progress) {
      const zip = new JSZip(), seen = new Map();
      for (const f of files) { const n = seen.get(f.name) || 0; seen.set(f.name, n + 1); zip.file(n ? f.name.replace(/(\.[^.]*)?$/, `-${n}$1`) : f.name, f); }
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } }, (m) => progress(m.percent / 100, 'Compressing'));
      return [{ name: `${(o.name || 'files').replace(/[\\/:*?"<>|]+/g, '').trim() || 'files'}.zip`, blob }];
    },
  },
  {
    id: 'unzip', icon: '📂', title: 'Extract ZIP', desc: 'Unpack a ZIP archive',
    accept: '.zip,application/zip', multiple: false, options: [],
    async run([f], _o, progress) {
      let zip; try { zip = await JSZip.loadAsync(f); } catch { throw new Error(`"${f.name}" is not a valid ZIP file.`); }
      const entries = Object.values(zip.files).filter((e) => !e.dir), out = [];
      for (const [i, e] of entries.entries()) { progress(i / entries.length, `Extracting ${e.name}`); out.push({ name: e.name.split('/').pop() || e.name, blob: await e.async('blob') }); }
      if (!out.length) throw new Error('This ZIP file is empty.');
      return out;
    },
  },
];
