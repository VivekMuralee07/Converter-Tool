import { convert } from './converter.js';
import { Book } from './book.js';
import { parseEpub } from './reader.js';
import { initHub } from './hub.js';
import { bookId, saveBook, getBook, deleteBook, listBooks, setProgress, renameBook } from './library.js';

const $ = (id) => document.getElementById(id);
const TABS = ['stepLibrary', 'stepPick', 'stepTools'];
const steps = [...TABS, 'stepOptions', 'stepProgress', 'stepResult', 'stepReader', 'stepTool'];
const show = (id) => {
  steps.forEach((s) => ($(s).hidden = s !== id));
  document.body.classList.toggle('reading', id === 'stepReader');
  document.body.classList.toggle('has-tabs', TABS.includes(id));
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-current', t.dataset.tab === id ? 'page' : 'false'));
  if (id !== 'stepReader') delete document.body.dataset.theme;
  if (id === 'stepLibrary') renderLibrary();
  if (TABS.includes(id)) scrollTo(0, 0);
};

let file = null, book = null, downloadUrl = null, totalPages = 0, readerBook = null, lastResult = null, backTo = 'stepLibrary';

async function pick(f) {
  if (!f) return;
  if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) { alert('Please choose a PDF file.'); return; }
  file = f;
  $('fileName').textContent = f.name;
  const guess = f.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ');
  $('title').value = guess;
  $('author').value = ''; $('from').value = ''; $('to').value = ''; syncFit();
  show('stepOptions');
  try { // prefill from PDF metadata
    const { openPdf } = await import('./converter.js');
    const { meta, pdf } = await openPdf(f);
    // only fill from the PDF if the user hasn't typed something in the meantime, and this is still the same file
    if (file === f && meta.Title && meta.Title.trim() && $('title').value === guess) $('title').value = meta.Title.trim();
    if (file === f && meta.Author && !$('author').value) $('author').value = meta.Author.trim();
    totalPages = pdf.numPages; $('to').placeholder = totalPages; $('rangeHint').textContent = `This PDF has ${totalPages} pages. Tip: for big books convert one chapter at a time — it is faster and the files stay small.`;
    pdf.destroy();
  } catch { /* metadata is optional */ }
}

function reset() {
  if (book) { book.destroy(); book = null; }
  if (downloadUrl) { URL.revokeObjectURL(downloadUrl); downloadUrl = null; }
  file = null; $('file').value = ''; show('stepPick');
}

async function run() {
  show('stepProgress');
  const opts = { title: $('title').value.trim() || 'Untitled', author: $('author').value.trim(), mode: document.querySelector('input[name=mode]:checked').value };
  opts.fit = opts.mode === 'fixed' && $('fit').checked;
  opts.zoom = parseFloat($('zoom').value) || 1.5;
  opts.from = parseInt($('from').value, 10) || 1; opts.to = parseInt($('to').value, 10) || 0;
  const sw = Math.min(screen.width, screen.height), sh = Math.max(screen.width, screen.height);
  // readers add side margins and top/bottom bars, so the usable area is narrower and shorter than the screen
  opts.aspect = Math.max(0.3, Math.min(0.75, (sw / sh) * parseFloat($('margins').value)));
  try {
    const res = await convert(file, opts, (p, msg) => { $('barFill').style.width = Math.round(p * 100) + '%'; $('status').textContent = msg; });
    const fname = opts.title.replace(/[\\/:*?"<>|]+/g, '').trim() || 'book';
    downloadUrl = URL.createObjectURL(res.epub);
    const a = $('downloadBtn'); a.href = downloadUrl; a.download = fname + '.epub';
    $('fname').value = fname;
    const mb = (res.epub.size / 1048576).toFixed(1);
    $('resultTitle').textContent = `“${opts.title}” is ready`;
    $('resultInfo').textContent = `${res.pageCount} PDF pages · ${mb} MB` + (res.mode === 'reflow' && !res.hasText ? ' · no text found — try “Fixed pages”' : res.messy ? ' · lots of formulas/symbols detected — “Fixed pages” will look better' : '');
    const mkShare = () => new File([res.epub], safeName($('fname').value) + '.epub', { type: 'application/epub+zip' });
    $('shareBtn').hidden = !(navigator.canShare && navigator.canShare({ files: [mkShare()] }));
    $('shareBtn').onclick = () => navigator.share({ files: [mkShare()], title: $('fname').value }).catch(() => {});
    $('fname').oninput = () => { $('downloadBtn').download = safeName($('fname').value) + '.epub'; };
    $('fname').onchange = async () => { const n = $('fname').value.trim(); if (n) { await renameBook(res.id, n).catch(() => {}); $('resultTitle').textContent = `“${n}” is ready`; } };
    lastResult = res; res.id = bookId(opts.title, res.epub);
    saveBook({ id: res.id, title: opts.title, author: opts.author, size: res.epub.size, added: Date.now(), opened: Date.now(), progress: 0, blob: res.epub, cover: res.coverBlob }).catch(() => {});
    show('stepResult');
    book = new Book($('stage'), $('book'), (s) => {
      $('pageInfo').textContent = s.label; $('prevBtn').disabled = !s.canPrev; $('nextBtn').disabled = !s.canNext;
    });
    book.load(res);
  } catch (err) {
    console.error(err);
    alert('Conversion failed: ' + (err && err.message || err));
    show('stepOptions');
  }
}

$('file').addEventListener('change', (e) => pick(e.target.files[0]));
const drop = $('drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => pick(e.dataTransfer.files[0]));
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
function syncFit() { $('fitRow').hidden = document.querySelector('input[name=mode]:checked').value !== 'fixed'; $('zoom').disabled = $('margins').disabled = !$('fit').checked; }
$('fit').addEventListener('change', syncFit);
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', syncFit));
$('fit').checked = innerWidth < 820;
$('convertBtn').onclick = run;
$('resetBtn1').onclick = $('resetBtn2').onclick = reset;
$('prevBtn').onclick = () => book && book.prev();
$('nextBtn').onclick = () => book && book.next();

// PWA: install prompt, service worker, and "Open with" PDF file handler
let deferred;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('installBtn').hidden = false; });
$('installBtn').onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('installBtn').hidden = true; };
addEventListener('appinstalled', () => ($('installBtn').hidden = true));
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.warn);
if ('launchQueue' in window) {
  launchQueue.setConsumer(async (params) => {
    if (!params.files || !params.files.length) return;
    const f = await params.files[0].getFile();
    if (/\.epub$/i.test(f.name)) openEpubFile(f); else pick(f);
  });
}

/* ---------- reader & library ---------- */
const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

let coverUrls = [], libSort = 'recent';
try { libSort = localStorage.getItem('libSort') || 'recent'; } catch { /* ignore */ }
const hue = (s) => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
function coverEl(b) {
  const box = document.createElement('div'); box.className = 'cover';
  if (b.cover) { const img = new Image(); img.alt = ''; img.src = URL.createObjectURL(b.cover); coverUrls.push(img.src); box.appendChild(img); }
  else { const h = hue(b.title); box.innerHTML = '<div class="gen"><b></b><small></small></div>'; box.firstChild.style.background = `linear-gradient(160deg, hsl(${h} 42% 30%), hsl(${(h + 40) % 360} 48% 14%))`; box.querySelector('b').textContent = b.title; box.querySelector('small').textContent = b.author || ''; }
  return box;
}
function progressRow(p) {
  const pct = Math.round(p * 100), row = document.createElement('div'); row.className = 'pbarrow';
  row.innerHTML = '<div class="pbar"><i></i></div><span class="pct"></span>';
  row.querySelector('i').style.width = pct + '%'; row.querySelector('.pct').textContent = pct + '%'; row.title = pct + '% read';
  return row;
}

async function renderLibrary() {
  coverUrls.forEach(URL.revokeObjectURL); coverUrls = [];
  const all = await listBooks();
  const books = libSort === 'title' ? [...all].sort((x, y) => x.title.localeCompare(y.title)) : all; // listBooks() is already most-recent first
  $('libEmpty').hidden = all.length > 0; $('shelfHead').hidden = !all.length;
  $('libCount').textContent = all.length ? `${all.length} book${all.length > 1 ? 's' : ''} on this device` : 'Pick up where you left off.';
  document.querySelectorAll('[data-sort]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.sort === libSort)));

  // "Continue reading": the book opened most recently
  const cc = $('continueCard'); cc.innerHTML = ''; cc.hidden = !all.length;
  if (all.length) {
    const b = all[0], info = document.createElement('div'); info.className = 'cinfo';
    info.innerHTML = '<span class="eyebrow">Continue reading</span><b class="t"></b><small></small>';
    info.querySelector('.t').textContent = b.title; info.querySelector('small').textContent = b.author || 'Tap to open';
    info.appendChild(progressRow(b.progress || 0));
    const go = document.createElement('button'); go.className = 'btn primary'; go.type = 'button'; go.innerHTML = '<svg class="ico"><use href="#i-book"/></svg>' + ((b.progress || 0) > 0.01 ? 'Continue' : 'Start reading');
    info.appendChild(go);
    cc.append(coverEl(b), info); cc.onclick = () => openSaved(b.id);
  }

  const ul = $('bookList'); ul.innerHTML = '';
  for (const b of books) {
    const li = document.createElement('li'); li.className = 'book'; li.tabIndex = 0; li.setAttribute('role', 'button'); li.setAttribute('aria-label', `Open ${b.title}`);
    const cover = coverEl(b), p = b.progress || 0;
    const more = document.createElement('button'); more.type = 'button'; more.className = 'more'; more.setAttribute('aria-label', 'Book options'); more.innerHTML = '<svg class="ico"><use href="#i-dots"/></svg>';
    more.onclick = (e) => { e.stopPropagation(); openBookSheet(b); };
    cover.appendChild(more);
    if (p >= 0.97) cover.insertAdjacentHTML('beforeend', '<span class="badge done">Finished</span>'); else if (p === 0) cover.insertAdjacentHTML('beforeend', '<span class="badge">New</span>');
    const meta = document.createElement('div'); meta.className = 'bmeta';
    meta.innerHTML = '<b></b><small></small>'; meta.querySelector('b').textContent = b.title; meta.querySelector('small').textContent = b.author || fmtSize(b.size);
    meta.appendChild(progressRow(p));
    li.append(cover, meta);
    li.onclick = () => openSaved(b.id);
    li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSaved(b.id); } };
    ul.appendChild(li);
  }
}

// bottom sheet with the less common book actions
let sheetBook = null;
function openBookSheet(b) {
  sheetBook = b;
  $('bsTitle').textContent = b.title; $('bsMeta').textContent = `${b.author ? b.author + ' · ' : ''}${fmtSize(b.size)} · ${Math.round((b.progress || 0) * 100)}% read`;
  const c = $('bsCover'); c.innerHTML = ''; if (b.cover) { const img = new Image(); img.alt = ''; img.src = URL.createObjectURL(b.cover); coverUrls.push(img.src); c.appendChild(img); }
  $('bookSheet').hidden = false;
}
const closeBookSheet = () => { $('bookSheet').hidden = true; sheetBook = null; };
$('bookSheetBg').onclick = closeBookSheet;
$('bsOpen').onclick = () => { const b = sheetBook; closeBookSheet(); b && openSaved(b.id); };
$('bsRename').onclick = async () => { const b = sheetBook; closeBookSheet(); if (!b) return; const n = (prompt('New name for this book:', b.title) || '').trim(); if (n && n !== b.title) { await renameBook(b.id, n); renderLibrary(); } };
$('bsDownload').onclick = () => { const b = sheetBook; closeBookSheet(); b && downloadBlob(b.blob, b.title); };
$('bsRemove').onclick = async () => { const b = sheetBook; closeBookSheet(); if (b && confirm(`Remove “${b.title}” from this device?`)) { await deleteBook(b.id); renderLibrary(); } };
document.querySelectorAll('[data-sort]').forEach((x) => (x.onclick = () => { libSort = x.dataset.sort; try { localStorage.setItem('libSort', libSort); } catch { /* ignore */ } renderLibrary(); }));

const safeName = (s) => (s || '').replace(/[\\/:*?"<>|]+/g, '').trim() || 'book';
function downloadBlob(blob, name) {
  const u = URL.createObjectURL(blob), el = Object.assign(document.createElement('a'), { href: u, download: safeName(name) + '.epub' });
  document.body.appendChild(el); el.click(); el.remove(); setTimeout(() => URL.revokeObjectURL(u), 10000);
}
const busy = (on, text = 'Opening…') => { $('busy').hidden = !on; $('busyText').textContent = text; };

let readerId = null, seeking = false;
const savePos = () => { if (readerBook && readerId) setProgress(readerId, readerBook.progress()).catch(() => {}); };
addEventListener('pagehide', savePos);
document.addEventListener('visibilitychange', () => { if (document.hidden) savePos(); });

const THEMES = ['light', 'dark', 'warm'];
function setTheme(t) {
  if (!THEMES.includes(t)) t = 'light';
  try { localStorage.setItem('readerTheme', t); } catch { /* private mode */ }
  document.body.dataset.theme = t;
  document.querySelectorAll('.tbtn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.theme === t)));
}
document.querySelectorAll('.tbtn').forEach((b) => (b.onclick = () => setTheme(b.dataset.theme)));

const FONTS = { serif: 'Iowan Old Style, "New York", "Noto Serif", Georgia, "Times New Roman", serif', sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif' };
const prefs = {
  get: (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
let fontSize = 19, fontKey = 'serif';
function syncFontUi() {
  $('rFontVal').textContent = fontSize;
  document.querySelectorAll('.segb').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.font === fontKey)));
}
function applyFont() { prefs.set('readerFontSize', fontSize); prefs.set('readerFont', fontKey); syncFontUi(); readerBook && readerBook.setFont({ size: fontSize, family: FONTS[fontKey] }); }
const sheet = (on) => { $('rSheet').hidden = !on; if (!on) $('rTocList').hidden = true; };

function openReader(data, id, startFrac = 0, from = 'stepLibrary') {
  backTo = from; readerId = id;
  if (readerBook) { readerBook.destroy(); readerBook = null; }
  $('rTitle').textContent = data.title;
  show('stepReader');
  setTheme(prefs.get('readerTheme', 'light'));
  fontSize = Math.max(13, Math.min(32, parseInt(prefs.get('readerFontSize', '19'), 10) || 19)); fontKey = FONTS[prefs.get('readerFont', 'serif')] ? prefs.get('readerFont', 'serif') : 'serif';
  syncFontUi(); sheet(false);
  const reader = $('stepReader');
  reader.classList.remove('chrome-hidden');
  $('rProg').hidden = true;
  const isText = !data.pageImages && !data.lazyImages;
  $('rTextRows').hidden = $('rFontRow').hidden = !isText; // text size / font only apply to reflowable books
  readerBook = new Book($('rStage'), $('rBook'), (s) => {
    const p = readerBook ? readerBook.progress() : 0;
    $('rInfo').textContent = s.label;
    $('rPct').textContent = Math.round(p * 100) + '%';
    if (!seeking) $('rSeek').value = Math.round(p * 1000);
    $('rToc').hidden = !(readerBook && readerBook.toc && readerBook.toc.length);
    savePos(); // saved on every page change, so the next open resumes here
  }, { fullBleed: true, fontSize, fontFamily: FONTS[fontKey], onCenterTap: () => reader.classList.toggle('chrome-hidden') });
  if (startFrac > 0) { const hint = Object.assign(document.createElement('div'), { className: 'read-hint', textContent: `Resumed where you left off (${Math.round(startFrac * 100)}%)` }); document.body.appendChild(hint); setTimeout(() => (hint.style.opacity = 0), 2200); setTimeout(() => hint.remove(), 2900); }
  readerBook.load(data, startFrac);
}

async function openSaved(id) {
  const rec = await getBook(id);
  if (!rec) return;
  busy(true, 'Opening book…');
  try { openReader(await parseEpub(rec.blob), id, rec.progress || 0); }
  catch (err) { console.error(err); alert('Could not open this book: ' + (err.message || err)); show('stepLibrary'); }
  finally { busy(false); }
}

async function openEpubFile(f) {
  busy(true, 'Opening book…');
  try {
    const data = await parseEpub(f);
    const id = bookId(data.title, f), old = await getBook(id);
    await saveBook({ id, title: old?.title || data.title, author: data.author, size: f.size, added: old?.added || Date.now(), opened: Date.now(), progress: old?.progress || 0, blob: f, cover: data.coverBlob });
    openReader({ ...data, title: old?.title || data.title }, id, old?.progress || 0);
  } catch (err) { console.error(err); alert('Could not open this EPUB: ' + (err.message || err)); }
  finally { busy(false); }
}

$('epubFile').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) await openEpubFile(f); e.target.value = ''; });
$('readBtn').onclick = () => lastResult && openReader({ ...lastResult, title: $('fname').value.trim() || lastResult.title }, lastResult.id, 0, 'stepResult');
$('rBack').onclick = () => {
  savePos(); sheet(false);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (readerBook) { readerBook.destroy(); readerBook = null; }
  show(backTo);
};
$('rMenu').onclick = () => sheet(true);
$('rSheetBg').onclick = () => sheet(false);
$('rFontDown').onclick = () => { fontSize = Math.max(13, fontSize - 1); applyFont(); };
$('rFontUp').onclick = () => { fontSize = Math.min(32, fontSize + 1); applyFont(); };
document.querySelectorAll('.segb').forEach((b) => (b.onclick = () => { fontKey = b.dataset.font; applyFont(); }));
$('rSeek').addEventListener('input', () => { seeking = true; $('rPct').textContent = Math.round($('rSeek').value / 10) + '%'; });
$('rSeek').addEventListener('change', () => { seeking = false; readerBook && readerBook.goTo($('rSeek').value / 1000); });
$('rToc').onclick = () => {
  const ul = $('rTocList'); if (!ul.hidden) { ul.hidden = true; return; }
  ul.innerHTML = '';
  for (const t of (readerBook && readerBook.toc) || []) {
    const li = document.createElement('li'); li.className = t.level === 2 ? 'h2' : ''; li.innerHTML = '<span></span><small></small>';
    li.firstChild.textContent = t.title; li.lastChild.textContent = Math.max(1, t.page + 1 - (readerBook.hasCover ? 1 : 0));
    li.onclick = () => { readerBook.goToPage(t.page); sheet(false); };
    ul.appendChild(li);
  }
  ul.hidden = false; ul.scrollIntoView({ block: 'nearest' });
};
$('rFull').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.().catch(() => {}));
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => show(t.dataset.tab)));
document.querySelectorAll('[data-go]').forEach((x) => (x.onclick = () => show(x.dataset.go)));
$('libBtn').onclick = () => show('stepLibrary');
initHub({ show });
// start on the Library when there are books, otherwise on Convert
listBooks().then((b) => show(b.length ? 'stepLibrary' : 'stepPick')).catch(() => show('stepPick'));
