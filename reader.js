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
  const zip = await JSZip.loadAsync(blob);
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

  if (docs.length && imageOnly.length > docs.length / 2) { // fixed-layout book
    result.mode = 'fixed'; result.pageImages = [];
    for (const d of imageOnly) {
      const img = d.body.querySelector('img, image');
      const href = img.getAttribute('src') || img.getAttribute('href') || img.getAttribute('xlink:href');
      const b = href && await fileBlob(resolve(d.item.href, href));
      if (b) result.pageImages.push(b);
    }
    return result;
  }
  result.blocks = [];
  const SEL = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre';
  for (const d of docs) {
    d.body.querySelectorAll(SEL).forEach((el) => {
      if (el.parentElement && el.parentElement.closest(SEL)) return; // nested: parent already covers it
      const t = el.textContent.replace(/\s+/g, ' ').trim();
      if (!t) return;
      const tag = el.tagName.toLowerCase();
      result.blocks.push({ t: tag === 'h1' ? 'h1' : /^h[2-6]$/.test(tag) ? 'h2' : 'p', text: t });
    });
  }
  if (!result.blocks.length) throw new Error('No readable text found in this EPUB.');
  return result;
}
