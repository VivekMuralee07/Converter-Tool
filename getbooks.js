// "Get books": search free, legally shareable books and add them to the Library.
// Sources: Project Gutenberg (via the Gutendex search service) and the Internet Archive
// (public-domain / Creative Commons texts). Everything is fetched straight from the sources by the browser.
import { bookId, saveBook, getBook, listBooks } from './library.js';
import { parseAny } from './reader.js';

const $ = (id) => document.getElementById(id);
const LANGS = [['', 'Any language'], ['en', 'English'], ['fr', 'French'], ['de', 'German'], ['es', 'Spanish'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['la', 'Latin']];
const safe = (s) => (s || 'book').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 100) || 'book';
const authorName = (n) => (n || '').replace(/^([^,]+),\s*(.+)$/, '$2 $1');

/* ---------- searching ---------- */
async function searchGutenberg(q, lang, nextUrl) {
  const params = new URLSearchParams(); if (q) params.set('search', q); if (lang) params.set('languages', lang);
  const r = await fetch(nextUrl || `https://gutendex.com/books/?${params}`);
  if (!r.ok) throw new Error('Project Gutenberg search is not available right now.');
  const j = await r.json();
  return {
    next: j.next || null,
    items: (j.results || []).map((b) => {
      const f = b.formats || {};
      return { src: 'pg', id: String(b.id), title: b.title, author: (b.authors || []).map((a) => authorName(a.name)).join(', '), cover: f['image/jpeg'] || null,
        epub: f['application/epub+zip'] || null, pdf: f['application/pdf'] || null, downloads: b.download_count || 0, page: `https://www.gutenberg.org/ebooks/${b.id}`, note: 'Public domain' };
    }).filter((x) => x.epub || x.pdf),
  };
}

async function searchArchive(q, page) {
  const clean = q.replace(/[()":\\]/g, ' ').trim();
  const query = `${clean ? `(${clean}) AND ` : ''}mediatype:texts AND -access-restricted-item:true AND (licenseurl:*creativecommons* OR licenseurl:*publicdomain*) AND (format:EPUB OR format:PDF)`;
  const p = new URLSearchParams({ q: query, rows: '20', page: String(page), output: 'json' });
  ['identifier', 'title', 'creator', 'year', 'downloads', 'licenseurl'].forEach((f) => p.append('fl[]', f)); p.append('sort[]', 'downloads desc');
  const r = await fetch(`https://archive.org/advancedsearch.php?${p}`);
  if (!r.ok) throw new Error('Internet Archive search is not available right now.');
  const j = await r.json(), docs = (j.response && j.response.docs) || [], total = (j.response && j.response.numFound) || 0;
  return {
    more: page * 20 < total,
    items: docs.map((d) => ({ src: 'ia', id: d.identifier, title: (Array.isArray(d.title) ? d.title[0] : d.title) || d.identifier, author: Array.isArray(d.creator) ? d.creator.join(', ') : (d.creator || ''),
      cover: `https://archive.org/services/img/${d.identifier}`, downloads: d.downloads || 0, page: `https://archive.org/details/${d.identifier}`,
      note: /publicdomain/i.test(d.licenseurl || '') ? 'Public domain' : 'Open licence' })),
  };
}

/* ---------- downloading ---------- */
async function fetchBlob(url, onProgress) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`The site answered with an error (${r.status}).`);
  const total = +r.headers.get('content-length') || 0;
  if (!r.body || !total) return r.blob();
  const rd = r.body.getReader(), chunks = []; let got = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; chunks.push(value); got += value.length; onProgress(Math.min(1, got / total)); }
  return new Blob(chunks, { type: r.headers.get('content-type') || '' });
}

// the best file for an Internet Archive item: EPUB, otherwise PDF
async function archiveFile(id) {
  const r = await fetch(`https://archive.org/metadata/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error('Could not read this book\'s file list.');
  const files = ((await r.json()).files || []).filter((f) => !f.private && f.name);
  const epub = files.find((f) => /^epub$/i.test(f.format) || /\.epub$/i.test(f.name));
  const pdf = files.filter((f) => /pdf/i.test(f.format) || /\.pdf$/i.test(f.name)).sort((a, b) => (+b.size || 0) - (+a.size || 0))[0];
  const f = epub || pdf;
  if (!f) throw new Error('This item has no EPUB or PDF file.');
  return { url: `https://archive.org/download/${encodeURIComponent(id)}/${f.name.split('/').map(encodeURIComponent).join('/')}`, kind: epub ? 'epub' : 'pdf' };
}

/* ---------- screen ---------- */
export function initGet({ toast, openBook, openPdf, onAdded }) {
  const st = { q: '', source: 'all', lang: 'en', items: [], pgNext: null, iaPage: 0, iaMore: false, loading: false, have: new Map(), started: false, token: 0 };
  $('gLang').innerHTML = LANGS.map(([v, l]) => `<option value="${v}">${l}</option>`).join(''); $('gLang').value = 'en';

  async function refreshHave() { st.have = new Map((await listBooks()).filter((b) => b.sourceId).map((b) => [`${b.source}:${b.sourceId}`, b.id])); }

  function render() {
    const ul = $('gList'); ul.innerHTML = '';
    for (const it of st.items) {
      const li = document.createElement('li'); li.className = 'gcard';
      const cover = document.createElement('div'); cover.className = 'gcover';
      if (it.cover) { const img = new Image(); img.alt = ''; img.loading = 'lazy'; img.src = it.cover; img.onerror = () => { img.remove(); cover.textContent = '📖'; }; cover.appendChild(img); } else cover.textContent = '📖';
      const meta = document.createElement('div'); meta.className = 'gmeta';
      meta.innerHTML = '<b></b><small class="ga"></small><small class="gs"></small>'; meta.querySelector('b').textContent = it.title; meta.querySelector('.ga').textContent = it.author || 'Unknown author';
      meta.querySelector('.gs').textContent = `${it.src === 'pg' ? 'Project Gutenberg' : 'Internet Archive'} · ${it.note}${it.downloads ? ` · ${it.downloads.toLocaleString()} download${it.downloads === 1 ? '' : 's'}` : ''}${it.src === 'pg' && !it.epub ? ' · PDF' : ''}`;
      const act = document.createElement('div'); act.className = 'gact';
      const have = st.have.get(`${it.src}:${it.id}`);
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn ' + (have ? 'secondary' : 'primary'); btn.textContent = have ? 'Open' : 'Add to library';
      btn.onclick = () => (have ? openBook(have) : add(it, btn));
      const link = document.createElement('a'); link.className = 'glink'; link.href = it.page; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Details ↗';
      act.append(btn, link); li.append(cover, meta, act); ul.appendChild(li);
    }
    $('gMore').hidden = !(st.pgNext || st.iaMore) || st.loading;
    $('gEmpty').hidden = st.items.length > 0 || st.loading || !st.started || !$('gErr').hidden;
    $('gSpin').hidden = !st.loading;
  }

  async function load(more = false) {
    if (st.loading) return;
    const token = ++st.token; st.loading = true; $('gErr').hidden = true;
    if (!more) { st.items = []; st.pgNext = null; st.iaPage = 0; st.iaMore = false; }
    render();
    const wantPg = st.source !== 'ia' && (!more || st.pgNext);
    const wantIa = st.source !== 'pg' && (st.q.trim().length > 0 || st.source === 'ia') && (!more || st.iaMore); // with no search words, "All" shows Gutenberg's most popular books
    const jobs = [], errors = [];
    if (wantPg) jobs.push(searchGutenberg(st.q.trim(), st.lang, more ? st.pgNext : null).then((r) => { st.pgNext = r.next; return r.items; }).catch((e) => { errors.push(e.message); st.pgNext = null; return []; }));
    if (wantIa) jobs.push(searchArchive(st.q.trim(), st.iaPage + 1).then((r) => { st.iaPage++; st.iaMore = r.more; return r.items; }).catch((e) => { errors.push(e.message); st.iaMore = false; return []; }));
    const got = (await Promise.all(jobs)).flat();
    if (token !== st.token) return;
    await refreshHave();
    // interleave the two sources so neither floods the list
    const pg = got.filter((x) => x.src === 'pg'), ia = got.filter((x) => x.src === 'ia'), mix = [];
    for (let i = 0; i < Math.max(pg.length, ia.length); i++) { if (pg[i]) mix.push(pg[i]); if (ia[i]) mix.push(ia[i]); }
    st.items = st.items.concat(mix); st.loading = false;
    if (errors.length && !st.items.length) { $('gErr').textContent = `${errors[0]} Check your internet connection and try again.`; $('gErr').hidden = false; }
    else if (errors.length) toast(errors[0]);
    render();
  }

  async function add(it, btn) {
    btn.disabled = true; const label = btn.textContent; btn.textContent = 'Starting…';
    let url, kind;
    try {
      if (it.src === 'pg') { url = it.epub || it.pdf; kind = it.epub ? 'epub' : 'pdf'; }
      else ({ url, kind } = await archiveFile(it.id));
      const blob = await fetchBlob(url, (p) => (btn.textContent = `${Math.round(p * 100)}%`));
      if (kind === 'pdf') { // a PDF: send it to the converter
        btn.disabled = false; btn.textContent = label; openPdf(new File([blob], `${safe(it.title)}.pdf`, { type: 'application/pdf' })); toast('This book is a PDF — choose a layout and convert it.', 4500); return;
      }
      btn.textContent = 'Saving…';
      const file = new File([blob], `${safe(it.title)}.epub`, { type: 'application/epub+zip' });
      const data = await parseAny(file, 'epub', file.name);           // checks it is a real EPUB
      let cover = data.coverBlob || null;
      if (it.cover) { try { const cr = await fetch(it.cover); if (cr.ok) { const cb = await cr.blob(); if (cb.type.startsWith('image/')) cover = cb; } } catch { /* the book's own cover is fine */ } }
      const id = bookId(it.title, file);
      await saveBook({ id, title: it.title, author: it.author || data.author, kind: 'epub', size: file.size, added: Date.now(), opened: 0, progress: 0, collection: '', bookmarks: [], highlights: [], cover, source: it.src, sourceId: it.id, blob: file });
      st.have.set(`${it.src}:${it.id}`, id); onAdded && onAdded(); toast(`Added “${it.title}” to your library`, 3500); render();
    } catch (err) {
      console.error(err); btn.disabled = false; btn.textContent = label;
      // the source may not allow direct downloads into the app: fall back to the normal browser download
      if (url) { window.open(url, '_blank', 'noopener'); toast('Direct download was blocked, so it opens in your browser. Save the file, then use Library → Add books.', 6500); }
      else toast(`Could not get this book: ${err.message}`, 5000);
    }
  }

  function search() { st.q = $('gQuery').value; st.source = document.querySelector('#gSources [aria-pressed=true]').dataset.src; st.lang = $('gLang').value; st.started = true; load(false); }
  $('gForm').addEventListener('submit', (e) => { e.preventDefault(); search(); });
  document.querySelectorAll('#gSources [data-src]').forEach((b) => (b.onclick = () => { document.querySelectorAll('#gSources [data-src]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); if (st.started) search(); }));
  $('gLang').addEventListener('change', () => st.started && search());
  $('gMore').onclick = () => load(true);

  return { enter() { if (!st.started) { st.started = true; load(false); } else refreshHave().then(render); } };
}
