import { sourceToDoc, domToBlocks } from './pdfdoc.js';

// Reads an EPUB file into the structure the Book viewer understands.
// Fixed-layout (image) books -> pageImages; text books -> blocks (headings/paragraphs).
const dirOf = (p) => p.slice(0, p.lastIndexOf('/') + 1);
function resolve(base, href) {
  const parts = (dirOf(base) + decodeURIComponent(href.split('#')[0])).split('/'), out = [];
  for (const s of parts) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); }
  return out.join('/');
}
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
const mimeOf = (p) => MIME[p.split('.').pop().toLowerCase()] || 'application/octet-stream';
const xml = (s, type = 'application/xml') => new DOMParser().parseFromString(s, type);

export async function parseEpub(blob) {
  let zip;
  try { zip = await JSZip.loadAsync(blob); } catch { throw new Error('This file is not a valid EPUB (it could not be unzipped).'); }
  if (!zip.file('META-INF/container.xml')) throw new Error('This file is not a valid EPUB (container.xml is missing).');
  const read = async (p) => { const f = zip.file(p); if (!f) throw new Error('Missing file in EPUB: ' + p); return f.async('string'); };
  const container = xml(await read('META-INF/container.xml'));
  const opfPath = container.querySelector('rootfile').getAttribute('full-path');
  const opf = xml(await read(opfPath));
  const text = (sel) => (opf.querySelector(sel)?.textContent || '').trim();
  const title = text('metadata > title, dc\\:title') || 'Untitled', author = text('metadata > creator, dc\\:creator');

  const manifest = {};
  opf.querySelectorAll('manifest > item').forEach((i) => { manifest[i.getAttribute('id')] = { href: resolve(opfPath, i.getAttribute('href')), type: i.getAttribute('media-type'), props: i.getAttribute('properties') || '' }; });
  const spine = [...opf.querySelectorAll('spine > itemref')].map((r) => manifest[r.getAttribute('idref')]).filter((m) => m && /x?html/.test(m.type));

  let cover = Object.values(manifest).find((m) => m.props.includes('cover-image'));
  if (!cover) { const id = opf.querySelector('meta[name="cover"]')?.getAttribute('content'); cover = manifest[id]; }
  const fileBlob = async (p) => { const f = zip.file(p); return f ? new Blob([await f.async('arraybuffer')], { type: mimeOf(p) }) : null; };
  const coverBlob = cover ? await fileBlob(cover.href) : null;

  const docs = [];
  for (const item of spine) {
    const src = await read(item.href);
    let doc = xml(src, 'application/xhtml+xml');
    if (doc.querySelector('parsererror')) doc = xml(src, 'text/html');
    docs.push({ item, body: doc.body || doc.documentElement });
  }
  const imageOnly = docs.filter((d) => d.body.querySelector('img, image') && d.body.textContent.replace(/\s+/g, ' ').trim().length < 30);
  const result = { title, author, coverBlob, pageCount: spine.length, mode: 'reflow', blocks: null, pageImages: null, skipFirst: false };

  if (docs.length && imageOnly.length > docs.length / 2) { // fixed-layout book: images are loaded page by page
    const paths = [];
    for (const d of imageOnly) {
      const img = d.body.querySelector('img, image');
      const href = img.getAttribute('src') || img.getAttribute('href') || img.getAttribute('xlink:href');
      if (href && zip.file(resolve(d.item.href, href))) paths.push(resolve(d.item.href, href));
    }
    if (!paths.length) throw new Error('No page images found in this EPUB.');
    Object.assign(result, { mode: 'fixed', lazyImages: true, imageCount: paths.length, loadImage: (i) => fileBlob(paths[i]) });
    return result;
  }
  result.blocks = [];
  const SEL = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre';
  let imgBudget = 80 * 1048576, chapterNo = 0;
  for (const d of docs) {
    for (const el of d.body.querySelectorAll(SEL + ',img')) {
      if (el.tagName.toLowerCase() === 'img') {
        if (el.closest(SEL) || imgBudget <= 0) continue; // images inside text blocks are skipped
        const src = el.getAttribute('src'), path = src && !/^(data:|https?:)/i.test(src) ? resolve(d.item.href, src) : null, blob = path ? await fileBlob(path) : null;
        if (!blob || blob.size > 4 * 1048576) continue;
        let pw = 0, ph = 0; try { const bmp = await createImageBitmap(blob); pw = bmp.width; ph = bmp.height; bmp.close(); } catch { continue; }
        imgBudget -= blob.size;
        const m = /width:\s*([\d.]+)%/.exec(el.getAttribute('style') || ''), opener = !!el.closest('.chap');
        result.blocks.push({ t: 'img', blob, mime: blob.type, pw, ph, wf: m ? Math.min(1, +m[1] / 100) : Math.min(1, pw / 600), opener, title: opener ? (el.getAttribute('alt') || `Chapter ${++chapterNo}`) : '' });
        continue;
      }
      if (el.parentElement && el.parentElement.closest(SEL)) continue; // nested: parent already covers it
      const t = el.textContent.replace(/\s+/g, ' ').trim();
      if (!t) continue;
      const tag = el.tagName.toLowerCase();
      result.blocks.push({ t: tag === 'h1' ? 'h1' : /^h[2-6]$/.test(tag) ? 'h2' : 'p', text: t, align: el.classList.contains('center') ? 'center' : undefined });
    }
  }
  if (!result.blocks.some((b) => b.t !== 'img')) throw new Error('No readable text found in this EPUB.');
  return result;
}

/* ---------- other book types ---------- */
export const KINDS = { epub: 'epub', cbz: 'cbz', txt: 'txt', md: 'md', markdown: 'md', docx: 'docx', html: 'html', htm: 'html' };
export const kindOf = (name) => KINDS[(name.split('.').pop() || '').toLowerCase()] || null;
export const BOOK_ACCEPT = '.epub,.cbz,.txt,.md,.markdown,.docx,.html,.htm,application/epub+zip,application/octet-stream,application/zip';

// Comic archives: a ZIP of page images, shown like a fixed-page book (images load one page at a time).
export async function parseCbz(blob, title = 'Comic') {
  let zip; try { zip = await JSZip.loadAsync(blob); } catch { throw new Error('This file is not a valid CBZ (it could not be unzipped).'); }
  const names = Object.values(zip.files).filter((f) => !f.dir && /\.(jpe?g|png|gif|webp|bmp|avif)$/i.test(f.name) && !/(^|\/)(__MACOSX|\.)/.test(f.name))
    .map((f) => f.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  if (!names.length) throw new Error('No page images found in this CBZ.');
  const loadImage = async (i) => { const f = zip.file(names[i]); return f ? new Blob([await f.async('arraybuffer')], { type: mimeOf(names[i]) }) : null; };
  return { title, author: '', mode: 'fixed', lazyImages: true, imageCount: names.length, loadImage, coverBlob: null, libCover: await loadImage(0), pageCount: names.length };
}

// Plain text, Markdown, Word and HTML documents become reflowable text (headings, paragraphs, lists, pictures).
export async function parseDocument(file, title) {
  const { body, title: docTitle } = await sourceToDoc(file);
  const blocks = [], sentinel = (t, text, extra = {}) => { if (text && text.trim()) blocks.push({ t, text: text.replace(/\s+/g, ' ').trim(), ...extra }); };
  for (const b of domToBlocks(body)) {
    const txt = b.runs ? b.runs.map((r) => r.t || '').join('') : '';
    if (b.type === 'h') sentinel(b.level === 1 ? 'h1' : 'h2', txt);
    else if (b.type === 'p') sentinel('p', txt);
    else if (b.type === 'li') sentinel('p', `${b.marker} ${txt}`);
    else if (b.type === 'code') sentinel('p', b.text);
    else if (b.type === 'table') b.rows.forEach((row) => sentinel('p', row.join('  ·  ')));
    else if (b.type === 'img') {
      try {
        const blob = await (await fetch(b.src)).blob(), bmp = await createImageBitmap(blob), pw = bmp.width, ph = bmp.height; bmp.close();
        blocks.push({ t: 'img', blob, mime: blob.type, pw, ph, wf: Math.min(1, pw / 600) });
      } catch { /* remote or broken picture: skip */ }
    }
  }
  if (!blocks.some((b) => b.t !== 'img')) throw new Error('No readable text found in this file.');
  const firstImg = blocks.find((b) => b.t === 'img');
  return { title: (docTitle || title || 'Untitled').slice(0, 120), author: '', mode: 'reflow', blocks, coverBlob: null, libCover: firstImg ? firstImg.blob : null, pageCount: 1 };
}

// Opens any supported file by kind (see KINDS)
export async function parseAny(blob, kind, name = '') {
  const base = (name || '').replace(/\.[^.]+$/, '');
  if (kind === 'cbz') return parseCbz(blob, base || 'Comic');
  if (kind === 'epub') return parseEpub(blob);
  return parseDocument(blob.name ? blob : new File([blob], `${base || 'document'}.${kind}`), base);
}
