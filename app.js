import { convert } from './converter.js';
import { Book } from './book.js';
import { parseEpub, parseAny, kindOf } from './reader.js';
import { initHub } from './hub.js';
import { bookId, saveBook, getBook, getBlob, deleteBook, listBooks, setProgress, renameBook, updateBook, exportBackup, importBackup } from './library.js';

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
    saveBook({ id: res.id, kind: 'epub', title: opts.title, author: opts.author, size: res.epub.size, added: Date.now(), opened: Date.now(), progress: 0, blob: res.epub, cover: res.coverBlob }).catch(() => {});
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
    if (/\.pdf$/i.test(f.name)) pick(f); else addBooks([f]);
  });
}

/* ---------- reader & library ---------- */
const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

const pref = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
let coverUrls = [], libSort = pref('libSort', 'recent'), libFilter = 'All', libQuery = '';
const hue = (s) => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
function toast(msg, ms = 3200) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms); }
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
const KIND_LABEL = { cbz: 'Comic', txt: 'Text', md: 'Markdown', docx: 'Word', html: 'HTML' };

async function renderLibrary() {
  coverUrls.forEach(URL.revokeObjectURL); coverUrls = [];
  const all = await listBooks();
  const cols = [...new Set(all.map((b) => b.collection).filter(Boolean))].sort((x, y) => x.localeCompare(y));
  if (libFilter !== 'All' && !cols.includes(libFilter)) libFilter = 'All';
  const q = libQuery.trim().toLowerCase();
  let books = all.filter((b) => (libFilter === 'All' || b.collection === libFilter) && (!q || `${b.title} ${b.author || ''}`.toLowerCase().includes(q)));
  if (libSort === 'title') books.sort((x, y) => x.title.localeCompare(y.title));
  else if (libSort === 'progress') books.sort((x, y) => (y.progress || 0) - (x.progress || 0));
  $('libEmpty').hidden = all.length > 0; $('shelfHead').hidden = !all.length; $('libTools').hidden = !all.length;
  $('libCount').textContent = all.length ? `${all.length} book${all.length > 1 ? 's' : ''} on this device` : 'Pick up where you left off.';
  $('shelfTitle').textContent = libFilter === 'All' ? (q ? 'Results' : 'All books') : libFilter;
  $('noMatch').hidden = !all.length || books.length > 0;
  document.querySelectorAll('[data-sort]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.sort === libSort)));
  $('colList').innerHTML = cols.map((c) => `<option value="${c.replace(/"/g, '&quot;')}">`).join('');

  // collection chips
  const chips = $('chips'); chips.innerHTML = '';
  if (cols.length) for (const c of ['All', ...cols]) {
    const x = document.createElement('button'); x.type = 'button'; x.className = 'cchip'; x.textContent = c === 'All' ? `All (${all.length})` : `${c} (${all.filter((b) => b.collection === c).length})`;
    x.setAttribute('aria-pressed', String(c === libFilter)); x.onclick = () => { libFilter = c; renderLibrary(); }; chips.appendChild(x);
  }

  // "Continue reading": the book opened most recently (hidden while searching / filtering)
  const cc = $('continueCard'); cc.innerHTML = ''; cc.hidden = !all.length || libFilter !== 'All' || !!q;
  if (!cc.hidden) {
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
    if (KIND_LABEL[b.kind]) { const k = document.createElement('span'); k.className = 'kind'; k.textContent = KIND_LABEL[b.kind]; cover.appendChild(k); }
    const meta = document.createElement('div'); meta.className = 'bmeta';
    meta.innerHTML = '<b></b><small></small>'; meta.querySelector('b').textContent = b.title; meta.querySelector('small').textContent = b.author || fmtSize(b.size);
    meta.appendChild(progressRow(p));
    li.append(cover, meta);
    li.onclick = () => openSaved(b.id);
    li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSaved(b.id); } };
    ul.appendChild(li);
  }
}
$('libSearch').addEventListener('input', (e) => { libQuery = e.target.value; renderLibrary(); });
document.querySelectorAll('[data-sort]').forEach((x) => (x.onclick = () => { libSort = x.dataset.sort; setPref('libSort', libSort); renderLibrary(); }));

/* ----- book options, edit details, library menu (bottom sheets) ----- */
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
$('bsDownload').onclick = async () => { const b = sheetBook; closeBookSheet(); if (!b) return; const blob = await getBlob(b.id); blob ? downloadBlob(blob, b.title, b.kind || 'epub') : toast('The file for this book is missing.'); };
$('bsRemove').onclick = async () => { const b = sheetBook; closeBookSheet(); if (b && confirm(`Remove “${b.title}” from this device?`)) { await deleteBook(b.id); renderLibrary(); } };

let editBook = null, editCover;   // editCover: undefined = unchanged, null = removed, Blob = new
function showEditCover() {
  const c = $('edCover'); c.innerHTML = '';
  const blob = editCover === undefined ? editBook.cover : editCover;
  if (blob) { const img = new Image(); img.alt = ''; img.src = URL.createObjectURL(blob); coverUrls.push(img.src); c.appendChild(img); }
}
$('bsEdit').onclick = () => {
  const b = sheetBook; closeBookSheet(); if (!b) return;
  editBook = b; editCover = undefined; $('edTitle').value = b.title; $('edAuthor').value = b.author || ''; $('edCollection').value = b.collection || '';
  showEditCover(); $('editSheet').hidden = false;
};
const closeEdit = () => { $('editSheet').hidden = true; editBook = null; };
$('editBg').onclick = closeEdit; $('edCancel').onclick = closeEdit;
$('edCoverClear').onclick = () => { editCover = null; showEditCover(); };
$('edCoverFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try { // shrink to a sensible cover size
    const bmp = await createImageBitmap(f), s = Math.min(1, 640 / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
    editCover = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88)); showEditCover();
  } catch { toast('That file is not an image this phone can read.'); }
});
$('edSave').onclick = async () => {
  const b = editBook; if (!b) return;
  const patch = { title: $('edTitle').value.trim() || b.title, author: $('edAuthor').value.trim(), collection: $('edCollection').value.trim() };
  if (editCover !== undefined) patch.cover = editCover;
  closeEdit(); await updateBook(b.id, patch); renderLibrary(); toast('Saved');
};

$('libMenu').onclick = async () => { const bs = await listBooks(); $('libStats').textContent = `${bs.length} book${bs.length === 1 ? '' : 's'} on this device`; $('libSheet').hidden = false; };
$('libSheetBg').onclick = () => ($('libSheet').hidden = true);
$('lsBackup').onclick = async () => {
  $('libSheet').hidden = true; busy(true, 'Preparing backup…');
  try {
    const blob = await exportBackup((p, msg) => ($('busyText').textContent = msg));
    const u = URL.createObjectURL(blob), a = Object.assign(document.createElement('a'), { href: u, download: `ebook-library-backup-${new Date().toISOString().slice(0, 10)}.zip` });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 15000); toast('Backup saved to your downloads');
  } catch (err) { console.error(err); alert('Backup failed: ' + (err.message || err)); } finally { busy(false); }
};
$('restoreFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return; $('libSheet').hidden = true; busy(true, 'Restoring…');
  try { const r = await importBackup(f, (p, msg) => ($('busyText').textContent = msg)); await renderLibrary(); toast(`Restored ${r.added} new book${r.added === 1 ? '' : 's'}${r.merged ? `, updated ${r.merged}` : ''}`); }
  catch (err) { console.error(err); alert(err.message || String(err)); } finally { busy(false); }
});

const safeName = (s) => (s || '').replace(/[\\/:*?"<>|]+/g, '').trim() || 'book';
function downloadBlob(blob, name, ext = 'epub') {
  const u = URL.createObjectURL(blob), el = Object.assign(document.createElement('a'), { href: u, download: safeName(name) + '.' + ext });
  document.body.appendChild(el); el.click(); el.remove(); setTimeout(() => URL.revokeObjectURL(u), 10000);
}
const busy = (on, text = 'Opening…') => { $('busy').hidden = !on; $('busyText').textContent = text; };

let readerId = null, seeking = false;
const savePos = () => { if (readerBook && readerId) updateBook(readerId, { progress: readerBook.progress(), anchor: readerBook.anchorOfPage(readerBook.currentPage()), opened: Date.now() }).catch(() => {}); };
addEventListener('pagehide', savePos);
document.addEventListener('visibilitychange', () => { if (document.hidden) savePos(); });

const THEMES = ['light', 'dark', 'warm'];
function setTheme(t) {
  if (!THEMES.includes(t)) t = 'light';
  setPref('readerTheme', t);
  document.body.dataset.theme = t;
  document.querySelectorAll('.tbtn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.theme === t)));
}
document.querySelectorAll('.tbtn').forEach((b) => (b.onclick = () => setTheme(b.dataset.theme)));

const FONTS = {
  serif: 'Iowan Old Style, "New York", "Noto Serif", Georgia, "Times New Roman", serif',
  palatino: '"Palatino Linotype", Palatino, "Book Antiqua", "URW Palladio L", Georgia, serif',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  easy: 'Verdana, Tahoma, "Trebuchet MS", "DejaVu Sans", sans-serif',
  mono: '"Courier New", ui-monospace, "Roboto Mono", monospace',
};
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const fmtMin = (m) => (m < 1 ? 'under a minute' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);
let fontSize = 19, fontKey = 'serif', lineH = 1.55, padX = 26, turn = 'curl', bright = 100;
let annot = { bookmarks: [], highlights: [] }, hitPage;

/* ----- text, spacing, page-turn and brightness settings ----- */
function syncSettingsUi() {
  $('rFontVal').textContent = fontSize; $('rFontSel').value = fontKey;
  document.querySelectorAll('#rSheet [data-lh]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.lh === lineH)));
  document.querySelectorAll('#rSheet [data-px]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.px === padX)));
  document.querySelectorAll('#rSheet [data-turn]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.turn === turn)));
  $('rBright').value = bright; $('rBrightVal').textContent = bright + '%';
}
function applyLayout() {
  setPref('readerFontSize', fontSize); setPref('readerFont', fontKey); setPref('readerLH', lineH); setPref('readerPadX', padX);
  syncSettingsUi(); readerBook && readerBook.setFont({ size: fontSize, family: FONTS[fontKey], lineHeight: lineH, padX });
}
function applyBright() { setPref('readerBright', bright); $('dimVeil').style.opacity = ((100 - bright) / 100 * 0.85).toFixed(2); syncSettingsUi(); }
$('rFontDown').onclick = () => { fontSize = Math.max(13, fontSize - 1); applyLayout(); };
$('rFontUp').onclick = () => { fontSize = Math.min(32, fontSize + 1); applyLayout(); };
$('rFontSel').onchange = (e) => { fontKey = e.target.value; applyLayout(); };
document.querySelectorAll('#rSheet [data-lh]').forEach((b) => (b.onclick = () => { lineH = +b.dataset.lh; applyLayout(); }));
document.querySelectorAll('#rSheet [data-px]').forEach((b) => (b.onclick = () => { padX = +b.dataset.px; applyLayout(); }));
document.querySelectorAll('#rSheet [data-turn]').forEach((b) => (b.onclick = () => { turn = b.dataset.turn; setPref('readerTurn', turn); if (readerBook) readerBook.opts.turnStyle = turn; syncSettingsUi(); }));
$('rBright').oninput = (e) => { bright = +e.target.value; applyBright(); };

/* ----- settings sheet and its panels ----- */
const showPanel = (name) => document.querySelectorAll('#rSheet [data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== name));
function updateSheetInfo() {
  if (!readerBook) return;
  const p = readerBook.progress(); $('rPct').textContent = Math.round(p * 100) + '%'; if (!seeking) $('rSeek').value = Math.round(p * 1000);
  const t = readerBook.timeLeft();
  $('rTimeLeft').textContent = t ? (t.chapter != null ? `About ${fmtMin(t.chapter)} left in this chapter · ${fmtMin(t.book)} left in the book` : `About ${fmtMin(t.book)} left in the book`) : '';
}
const sheet = (on) => { $('rSheet').hidden = !on; if (on) { showPanel('main'); updateSheetInfo(); $('selBar').hidden = true; } };
document.querySelectorAll('#rSheet [data-back]').forEach((b) => (b.onclick = () => showPanel('main')));
const pageNo = (p) => Math.max(1, p + 1 - (readerBook && readerBook.hasCover ? 1 : 0));

$('rToc').onclick = () => {
  const ul = $('rTocList'); ul.innerHTML = '';
  for (const t of (readerBook && readerBook.toc) || []) {
    const li = document.createElement('li'); li.className = t.level === 2 ? 'h2' : ''; li.innerHTML = '<span></span><small></small>';
    li.firstChild.textContent = t.title; li.lastChild.textContent = pageNo(t.page);
    li.onclick = () => { readerBook.goToPage(t.page); sheet(false); };
    ul.appendChild(li);
  }
  if (!ul.children.length) ul.innerHTML = '<li><span>This book has no chapter list.</span></li>';
  showPanel('toc');
};

let searchTimer;
function runSearch() {
  const q = $('rSearchIn').value, ul = $('rSearchList'); ul.innerHTML = '';
  if (q.trim().length < 2) { $('rSearchInfo').textContent = 'Type at least 2 letters.'; return; }
  const res = readerBook.search(q);
  $('rSearchInfo').textContent = res.length ? `${res.length}${res.length >= 150 ? '+' : ''} result${res.length === 1 ? '' : 's'}` : 'No results.';
  for (const r of res) {
    const li = document.createElement('li'); li.innerHTML = '<span class="snip"></span><small></small>';
    const sn = li.querySelector('.snip'); sn.append(document.createTextNode(r.snippet.slice(0, r.at)));
    const em = document.createElement('em'); em.textContent = r.snippet.slice(r.at, r.at + (r.e - r.s)); sn.appendChild(em); sn.append(document.createTextNode(r.snippet.slice(r.at + (r.e - r.s))));
    li.lastChild.textContent = pageNo(r.page);
    li.onclick = () => { sheet(false); readerBook.goToPage(r.page); hitPage = r.page; readerBook.hitAt({ b: r.b, s: r.s, e: r.e }); };
    ul.appendChild(li);
  }
}
$('rSearchBtn').onclick = () => { showPanel('search'); $('rSearchIn').focus(); };
$('rSearchIn').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 250); });

/* ----- bookmarks, highlights and notes ----- */
const saveAnnot = () => readerId && updateBook(readerId, (r) => { r.bookmarks = annot.bookmarks; r.highlights = annot.highlights; }).catch(() => {});
const setHighlights = (arr) => { annot.highlights = arr; if (readerBook) readerBook.opts.highlights = arr; };
const pageBookmarks = () => (readerBook ? annot.bookmarks.filter((m) => readerBook.pageOfAnchor(m.a) === readerBook.currentPage()) : []);
const syncMark = () => $('rMark').setAttribute('aria-pressed', String(pageBookmarks().length > 0));
$('rMark').onclick = () => {
  const have = pageBookmarks();
  if (have.length) { annot.bookmarks = annot.bookmarks.filter((m) => !have.includes(m)); toast('Bookmark removed', 1600); }
  else {
    const pg = readerBook.currentPage(), label = (readerBook.pageText(pg) || '').replace(/\s+/g, ' ').trim().slice(0, 80) || `Page ${pageNo(pg)}`;
    annot.bookmarks.push({ id: uid(), a: readerBook.anchorOfPage(pg), label, created: Date.now() }); toast('Page bookmarked', 1600);
  }
  saveAnnot(); syncMark();
};

let mtab = 'bm';
function renderMarks() {
  const ul = $('rMarksList'); ul.innerHTML = '';
  document.querySelectorAll('#rSheet [data-mtab]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mtab === mtab)));
  $('rCopyNotes').hidden = mtab !== 'hl' || !annot.highlights.length;
  const rows = mtab === 'bm'
    ? annot.bookmarks.map((m) => ({ id: m.id, page: readerBook.pageOfAnchor(m.a), text: m.label, created: m.created, del: () => { annot.bookmarks = annot.bookmarks.filter((x) => x.id !== m.id); saveAnnot(); syncMark(); renderMarks(); } }))
    : annot.highlights.map((h) => ({ id: h.id, page: readerBook.pageOfAnchor({ b: h.b, o: h.s }), text: h.text, note: h.note, color: h.c, created: h.created, del: () => { setHighlights(annot.highlights.filter((x) => x.id !== h.id)); saveAnnot(); readerBook.refreshMarks(); renderMarks(); } }));
  rows.sort((x, y) => x.page - y.page);
  if (!rows.length) { ul.innerHTML = `<li><span>${mtab === 'bm' ? 'No bookmarks yet. Tap the bookmark icon at the top of a page.' : 'No highlights yet. Press and hold a word, then drag to select text.'}</span></li>`; return; }
  const cols = { y: '#ffe566', g: '#7be6a3', b: '#7bbcff', p: '#ff9ec9' };
  for (const r of rows) {
    const li = document.createElement('li'); li.innerHTML = '<div class="row1"><span></span><button class="del" type="button">Delete</button></div><div class="q"></div><div class="n"></div>';
    li.querySelector('.row1 span').textContent = `Page ${pageNo(r.page)}`; li.querySelector('.q').textContent = r.text; li.querySelector('.q').style.setProperty('--c', cols[r.color] || '#ff9a3c');
    li.querySelector('.n').textContent = r.note || ''; li.querySelector('.n').hidden = !r.note;
    li.querySelector('.del').onclick = (e) => { e.stopPropagation(); r.del(); };
    li.onclick = () => { sheet(false); readerBook.goToPage(r.page); };
    ul.appendChild(li);
  }
}
$('rMarksBtn').onclick = () => { mtab = annot.bookmarks.length || !annot.highlights.length ? 'bm' : 'hl'; renderMarks(); showPanel('marks'); };
document.querySelectorAll('#rSheet [data-mtab]').forEach((b) => (b.onclick = () => { mtab = b.dataset.mtab; renderMarks(); }));
$('rCopyNotes').onclick = async () => {
  const text = annot.highlights.slice().sort((x, y) => x.b - y.b || x.s - y.s).map((h) => `“${h.text}”${h.note ? `\n  — ${h.note}` : ''}`).join('\n\n');
  try { await navigator.clipboard.writeText(`${$('rTitle').textContent}\n\n${text}`); toast('Highlights copied'); } catch { toast('Could not copy'); }
};

// text selection -> highlight toolbar
function addHighlights(color, note = '') {
  const rs = readerBook.selectionRanges(); if (!rs.length) return;
  const g = uid(); setHighlights([...annot.highlights, ...rs.map((r) => ({ id: uid(), g, b: r.b, s: r.s, e: r.e, c: color, note, text: r.text, created: Date.now() }))]);
  getSelection().removeAllRanges(); $('selBar').hidden = true; saveAnnot(); readerBook.refreshMarks(); toast(note ? 'Note saved' : 'Highlighted', 1400);
}
document.addEventListener('selectionchange', () => {
  if (!readerBook || $('stepReader').hidden) return;
  $('selBar').hidden = !readerBook.selectionRanges().length || !$('rSheet').hidden;
});
for (const ev of ['pointerdown', 'mousedown', 'touchstart']) $('selBar').addEventListener(ev, (e) => e.preventDefault()); // keep the selection alive while tapping the bar
document.querySelectorAll('#selBar .hlc').forEach((b) => (b.onclick = () => addHighlights(b.dataset.c)));
$('selNote').onclick = () => { const rs = readerBook.selectionRanges(); if (!rs.length) return; const n = prompt('Note for this highlight:', ''); if (n !== null) addHighlights('y', n.trim()); };
$('selCopy').onclick = async () => { const t = readerBook.selectionRanges().map((r) => r.text).join('\n'); try { await navigator.clipboard.writeText(t); toast('Copied', 1200); } catch { toast('Could not copy'); } getSelection().removeAllRanges(); $('selBar').hidden = true; };

// tapping a highlight
let hlOpen = null;
function openHighlight(id) {
  const h = annot.highlights.find((x) => x.id === id); if (!h) return; hlOpen = h;
  $('hlText').textContent = h.text; $('hlNote').textContent = h.note ? `Note: ${h.note}` : ''; $('hlNote').hidden = !h.note; $('hlEdit').textContent = h.note ? 'Edit note' : 'Add note';
  document.querySelectorAll('#hlSheet .hlc').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.c === (h.c || 'y'))));
  $('hlSheet').hidden = false;
}
const closeHl = () => { $('hlSheet').hidden = true; hlOpen = null; };
$('hlBg').onclick = closeHl;
document.querySelectorAll('#hlSheet .hlc').forEach((b) => (b.onclick = () => { if (hlOpen) { hlOpen.c = b.dataset.c; saveAnnot(); readerBook.refreshMarks(); openHighlight(hlOpen.id); } }));
$('hlEdit').onclick = () => { const h = hlOpen; if (!h) return; const n = prompt('Note:', h.note || ''); if (n !== null) { h.note = n.trim(); saveAnnot(); readerBook.refreshMarks(); openHighlight(h.id); } };
$('hlDel').onclick = () => { const h = hlOpen; closeHl(); if (h) { setHighlights(annot.highlights.filter((x) => x.id !== h.id)); saveAnnot(); readerBook.refreshMarks(); } };

/* ----- read aloud (the phone's own voices) ----- */
const ttsOk = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
const tts = { on: false, rate: parseFloat(pref('ttsRate', '1')) || 1, token: 0, auto: false };
const speakPage = () => {
  if (!tts.on || !readerBook) return;
  const text = readerBook.pageText(readerBook.currentPage()).replace(/\s+/g, ' ').trim();
  if (!text) return ttsNext();
  const my = ++tts.token, u = new SpeechSynthesisUtterance(text); u.rate = tts.rate; u.lang = document.documentElement.lang || 'en';
  u.onend = () => { if (tts.on && my === tts.token) ttsNext(); };
  speechSynthesis.cancel(); speechSynthesis.speak(u);
};
function ttsNext() {
  if (!readerBook.status().canNext) { ttsStop(); toast('Finished reading aloud'); return; }
  tts.auto = true; readerBook.next();
  setTimeout(() => { tts.auto = false; speakPage(); }, turn === 'none' ? 150 : 950);
}
function ttsStart() { if (!ttsOk) return toast('This device has no read-aloud voice.'); tts.on = true; $('ttsBar').hidden = false; $('ttsPause').textContent = 'Pause'; $('ttsRate').textContent = tts.rate + '×'; sheet(false); speakPage(); }
function ttsStop() { tts.on = false; tts.token++; if (ttsOk) speechSynthesis.cancel(); $('ttsBar').hidden = true; }
$('rTts').onclick = () => (tts.on ? ttsStop() : ttsStart());
$('ttsStop').onclick = ttsStop;
$('ttsPause').onclick = () => { if (!ttsOk) return; if (speechSynthesis.paused) { speechSynthesis.resume(); $('ttsPause').textContent = 'Pause'; } else { speechSynthesis.pause(); $('ttsPause').textContent = 'Resume'; } };
$('ttsRate').onclick = () => { const r = [0.8, 1, 1.25, 1.5, 1.8]; tts.rate = r[(r.indexOf(tts.rate) + 1) % r.length] || 1; setPref('ttsRate', tts.rate); $('ttsRate').textContent = tts.rate + '×'; speakPage(); };

/* ----- opening a book in the reader ----- */
async function openReader(data, id, startFrac = 0, from = 'stepLibrary') {
  backTo = from; readerId = id; ttsStop();
  if (readerBook) { readerBook.destroy(); readerBook = null; }
  const rec = id ? await getBook(id).catch(() => null) : null;
  annot = { bookmarks: rec?.bookmarks || [], highlights: rec?.highlights || [] }; hitPage = undefined;
  $('rTitle').textContent = data.title;
  show('stepReader');
  setTheme(pref('readerTheme', 'light'));
  fontSize = Math.max(13, Math.min(32, parseInt(pref('readerFontSize', '19'), 10) || 19)); fontKey = FONTS[pref('readerFont', 'serif')] ? pref('readerFont', 'serif') : 'serif';
  lineH = parseFloat(pref('readerLH', '1.55')) || 1.55; padX = parseInt(pref('readerPadX', '26'), 10) || 26; turn = ['curl', 'slide', 'none'].includes(pref('readerTurn', 'curl')) ? pref('readerTurn', 'curl') : 'curl';
  bright = Math.max(25, Math.min(100, parseInt(pref('readerBright', '100'), 10) || 100)); applyBright(); syncSettingsUi(); sheet(false); closeHl(); $('selBar').hidden = true;
  const reader = $('stepReader');
  reader.classList.remove('chrome-hidden');
  $('rProg').hidden = true;
  const isText = !data.pageImages && !data.lazyImages;
  document.querySelectorAll('#rSheet .txt').forEach((x) => (x.hidden = !isText)); // text-only settings
  $('rMark').hidden = false;
  readerBook = new Book($('rStage'), $('rBook'), (s) => {
    $('rInfo').textContent = s.label;
    if (!$('rSheet').hidden) updateSheetInfo();
    $('rToc').hidden = !(readerBook && readerBook.toc && readerBook.toc.length);
    if (hitPage !== undefined && readerBook.currentPage() !== hitPage) { hitPage = undefined; readerBook.hitAt(null); }
    syncMark(); savePos(); // saved on every page change, so the next open resumes here
    if (tts.on && !tts.auto) { clearTimeout(tts.t); tts.t = setTimeout(speakPage, 500); } // you turned the page yourself: read from here
  }, { fullBleed: true, fontSize, fontFamily: FONTS[fontKey], lineHeight: lineH, padX, turnStyle: turn, highlights: annot.highlights, onHighlightTap: openHighlight, onCenterTap: () => reader.classList.toggle('chrome-hidden') });
  if (startFrac > 0) { const hint = Object.assign(document.createElement('div'), { className: 'read-hint', textContent: `Resumed where you left off (${Math.round(startFrac * 100)}%)` }); document.body.appendChild(hint); setTimeout(() => (hint.style.opacity = 0), 2200); setTimeout(() => hint.remove(), 2900); }
  readerBook.load(data, startFrac);
  if (isText && rec?.anchor && rec.anchor.b !== undefined) readerBook.goToPage(readerBook.pageOfAnchor(rec.anchor)); // exact paragraph, even if the text size changed
}

async function openSaved(id) {
  const rec = await getBook(id);
  if (!rec) return;
  busy(true, 'Opening book…');
  try {
    const blob = await getBlob(id); if (!blob) throw new Error('The file for this book is missing. Remove it and add it again.');
    openReader(await parseAny(blob, rec.kind || 'epub', rec.title), id, rec.progress || 0);
  } catch (err) { console.error(err); alert('Could not open this book: ' + (err.message || err)); show('stepLibrary'); }
  finally { busy(false); }
}

// Add one or many books (EPUB, CBZ, Word, Markdown, HTML, text). A single book opens straight away.
async function addBooks(list) {
  const files = [...list], added = [], problems = [];
  busy(true, 'Adding books…');
  try {
    for (const [i, f] of files.entries()) {
      $('busyText').textContent = files.length > 1 ? `Adding ${i + 1} of ${files.length}…` : 'Opening book…';
      const kind = kindOf(f.name) || (/epub/.test(f.type) ? 'epub' : null);
      if (!kind) { problems.push(`${f.name}: unsupported file type`); continue; }
      try {
        const data = await parseAny(f, kind, f.name), id = bookId(data.title, f), old = await getBook(id);
        await saveBook({ id, title: old?.title || data.title, author: old ? old.author : data.author, kind, size: f.size, added: old?.added || Date.now(), opened: Date.now(), progress: old?.progress || 0, collection: old?.collection || '', bookmarks: old?.bookmarks || [], highlights: old?.highlights || [], cover: old?.cover || data.coverBlob || data.libCover || null, blob: f });
        added.push({ id, data: { ...data, title: old?.title || data.title }, progress: old?.progress || 0 });
      } catch (err) { console.error(err); problems.push(`${f.name}: ${err.message || err}`); }
    }
  } finally { busy(false); }
  if (added.length === 1 && !problems.length) return openReader(added[0].data, added[0].id, added[0].progress);
  show('stepLibrary');
  if (added.length) toast(`Added ${added.length} book${added.length > 1 ? 's' : ''}` + (problems.length ? ` · ${problems.length} skipped` : ''));
  if (problems.length) alert('Some files could not be added:\n\n' + problems.join('\n'));
}

$('epubFile').addEventListener('change', async (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) await addBooks(fs); });
$('readBtn').onclick = () => lastResult && openReader({ ...lastResult, title: $('fname').value.trim() || lastResult.title }, lastResult.id, 0, 'stepResult');
$('rBack').onclick = () => {
  savePos(); sheet(false); ttsStop();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (readerBook) { readerBook.destroy(); readerBook = null; }
  show(backTo);
};
$('rMenu').onclick = () => sheet(true);
$('rSheetBg').onclick = () => sheet(false);
$('rSeek').addEventListener('input', () => { seeking = true; $('rPct').textContent = Math.round($('rSeek').value / 10) + '%'; });
$('rSeek').addEventListener('change', () => { seeking = false; readerBook && readerBook.goTo($('rSeek').value / 1000); });
$('rFull').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.().catch(() => {}));
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => show(t.dataset.tab)));
document.querySelectorAll('[data-go]').forEach((x) => (x.onclick = () => show(x.dataset.go)));
$('libBtn').onclick = () => show('stepLibrary');
initHub({ show });
// start on the Library when there are books, otherwise on Convert
listBooks().then((b) => show(b.length ? 'stepLibrary' : 'stepPick')).catch(() => show('stepPick'));
