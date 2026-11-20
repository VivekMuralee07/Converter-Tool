import { convert, OCR_LANGS } from './converter.js';
import { Book } from './book.js';
import { parseEpub, parseAny, kindOf } from './reader.js';
import { initHub } from './hub.js';
import { lookup, POS_NAME, saveForOffline } from './dictionary.js';
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

let pickedPdf = null;
const closePicked = () => { if (pickedPdf) { pickedPdf.destroy().catch(() => {}); pickedPdf = null; } };
$('ocrLang').innerHTML = Object.entries(OCR_LANGS).map(([k, v]) => `<option value="${k}">${v}${k === 'eng' ? ' (works offline)' : ''}</option>`).join('');

async function pick(f) {
  if (!f) return;
  if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) { alert('Please choose a PDF file.'); return; }
  file = f; closePicked();
  $('fileName').textContent = f.name;
  const guess = f.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ');
  $('title').value = guess;
  $('author').value = ''; $('from').value = ''; $('to').value = ''; $('ocr').checked = false; $('scanHint').hidden = true; $('recBox').hidden = true; $('pickPages').hidden = true; document.querySelector('input[name=mode][value=reflow]').checked = true; syncFit();
  show('stepOptions');
  try { // prefill from PDF metadata and look for a text layer
    const { openPdf } = await import('./converter.js');
    const { meta, pdf } = await openPdf(f);
    if (file !== f) { pdf.destroy(); return; }
    pickedPdf = pdf;
    // only fill from the PDF if the user hasn't typed something in the meantime, and this is still the same file
    if (meta.Title && meta.Title.trim() && $('title').value === guess) $('title').value = meta.Title.trim();
    if (meta.Author && !$('author').value) $('author').value = meta.Author.trim();
    totalPages = pdf.numPages; $('to').placeholder = totalPages; $('pickPages').hidden = false;
    $('rangeHint').textContent = `This PDF has ${totalPages} pages. Tip: for big books convert one chapter at a time — it is faster and the files stay small.`;
    let chars = 0; const sample = Math.min(5, totalPages);
    for (let i = 0; i < sample; i++) { const pg = await pdf.getPage(1 + Math.floor(i * totalPages / sample)); chars += (await pg.getTextContent()).items.reduce((t, x) => t + x.str.length, 0); }
    if (file === f && chars < 25 * sample) { $('scanHint').hidden = false; $('ocr').checked = true; syncFit(); return; } // no text layer: it is a scan
    const { profilePdf } = await import('./converter.js'), pr = await profilePdf(pdf);
    if (file !== f) return;
    const fixed = pr.formulas || pr.pictures;
    document.querySelector(`input[name=mode][value=${fixed ? 'fixed' : 'reflow'}]`).checked = true;
    if (fixed) $('fit').checked = matchMedia('(max-width: 700px)').matches;
    syncFit();
    $('recText').innerHTML = fixed
      ? '<b>Recommended: Fixed pages.</b> This PDF has many formulas, tables or pictures, so pages keep their exact look (the text on them is still searchable)' + (pr.outline ? ` and your ${pr.outline} bookmarks become the chapter list.` : '.')
      : '<b>Recommended: Reflowable text.</b> It is mostly running text, so it will adapt to your screen' + (pr.outline ? `, with ${pr.outline} chapters taken from the PDF bookmarks` : '') + (pr.columns ? '; two-column pages are read in the right order' : '') + '.';
    $('recBox').hidden = false;
  } catch { /* metadata is optional */ }
}

function reset() {
  if (book) { book.destroy(); book = null; }
  if (downloadUrl) { URL.revokeObjectURL(downloadUrl); downloadUrl = null; }
  file = null; closePicked(); $('file').value = ''; show('stepPick');
}

async function run(quick = false) {
  show('stepProgress');
  let wake = null; try { wake = await navigator.wakeLock?.request('screen'); } catch { /* not allowed */ }
  const opts = { title: $('title').value.trim() || 'Untitled', author: $('author').value.trim(), mode: document.querySelector('input[name=mode]:checked').value };
  opts.fit = opts.mode === 'fixed' && $('fit').checked;
  opts.zoom = parseFloat($('zoom').value) || 1.5;
  opts.from = parseInt($('from').value, 10) || 1; opts.to = parseInt($('to').value, 10) || 0;
  opts.keepMath = $('keepMath').checked; opts.ocr = opts.mode === 'reflow' && $('ocr').checked ? $('ocrLang').value : null;
  if (quick) opts.to = Math.min(totalPages || 9999, opts.from + 9);
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
    $('resultInfo').textContent = `${res.pageCount} PDF pages · ${mb} MB` + (res.outline ? ` · ${res.outline} chapters from bookmarks` : '') + (res.hasTextLayer ? ' · searchable text' : '') + (res.mode === 'reflow' && !res.hasText ? ' · no text found — try “Fixed pages”' : res.messy ? ' · lots of formulas/symbols detected — “Fixed pages” will look better' : '');
    const mkShare = () => new File([res.epub], safeName($('fname').value) + '.epub', { type: 'application/epub+zip' });
    $('shareBtn').hidden = !(navigator.canShare && navigator.canShare({ files: [mkShare()] }));
    $('shareBtn').onclick = () => navigator.share({ files: [mkShare()], title: $('fname').value }).catch(() => {});
    $('fname').oninput = () => { $('downloadBtn').download = safeName($('fname').value) + '.epub'; };
    $('fname').onchange = async () => { const n = $('fname').value.trim(); if (n) { await renameBook(res.id, n).catch(() => {}); $('resultTitle').textContent = `“${n}” is ready`; } };
    lastResult = res; res.id = bookId(opts.title, res.epub);
    if (!quick) saveBook({ id: res.id, kind: 'epub', title: opts.title, author: opts.author, size: res.epub.size, added: Date.now(), opened: Date.now(), progress: 0, blob: res.epub, cover: res.coverBlob }).catch(() => {});
    $('previewBanner').hidden = !quick; if (quick) $('pvRange').textContent = `pages ${opts.from}–${opts.to}`;
    if (res.ocrPages) $('resultInfo').textContent += ` · ${res.ocrPages} page${res.ocrPages > 1 ? 's' : ''} read with OCR`;
    show('stepResult');
    book = new Book($('stage'), $('book'), (s) => {
      $('pageInfo').textContent = s.label; $('prevBtn').disabled = !s.canPrev; $('nextBtn').disabled = !s.canNext;
    });
    book.load(res);
  } catch (err) {
    console.error(err);
    alert('Conversion failed: ' + (err && err.message || err));
    show('stepOptions');
  } finally { if (wake) wake.release().catch(() => {}); }
}

$('file').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; pick(f); }); // cleared so the same file can be chosen again
const drop = $('drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => pick(e.dataTransfer.files[0]));
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
function syncFit() { const fixed = document.querySelector('input[name=mode]:checked').value === 'fixed'; $('reflowRow').hidden = fixed; $('ocrLangBox').hidden = fixed || !$('ocr').checked; $('fitRow').hidden = !fixed; $('zoom').disabled = $('margins').disabled = !$('fit').checked; }
$('fit').addEventListener('change', syncFit);
$('ocr').addEventListener('change', syncFit);
$('ocrLang').addEventListener('change', () => { $('ocrLangNote').textContent = $('ocrLang').value === 'eng' ? '' : 'This language is downloaded the first time (needs internet), then reused.'; });
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', syncFit));
$('fit').checked = innerWidth < 820;
$('convertBtn').onclick = () => run(false);
$('previewBtn').onclick = () => run(true);
$('pvFull').onclick = () => run(false);
$('pvBack').onclick = () => show('stepOptions');
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
let dictAuto = pref('dictAuto', 'on') !== 'off';
let fontSize = 19, fontKey = 'serif', lineH = 1.55, padX = 26, turn = 'curl', bright = 100;
let annot = { bookmarks: [], highlights: [] }, hitPage;

/* ----- text, spacing, page-turn and brightness settings ----- */
function syncSettingsUi() {
  $('rFontVal').textContent = fontSize; $('rFontSel').value = fontKey;
  document.querySelectorAll('#rSheet [data-lh]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.lh === lineH)));
  document.querySelectorAll('#rSheet [data-px]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.px === padX)));
  document.querySelectorAll('#rSheet [data-turn]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.turn === turn)));
  $('rBright').value = bright; $('rBrightVal').textContent = bright + '%';
  document.querySelectorAll('#rSheet [data-dict]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.dict === 'on') === dictAuto)));
  $('dictState').textContent = pref('dictOffline', '') ? 'ready offline ✓' : '';
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
    li.onclick = () => { sheet(false); readerBook.goToPage(r.page); hitPage = r.page; readerBook.hitAt(r.ks ? { p: r.page, ks: r.ks } : { b: r.b, s: r.s, e: r.e }); };
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
  if (rs.some((r) => r.fixed)) { toast('Highlighting works in text books. Define and Copy work on page pictures.', 2600); return; }
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


/* ----- dictionary: select a word to see its meaning ----- */
const WORD = /^[\p{L}][\p{L}'’-]{1,29}$/u;
const selectedText = () => (window.getSelection ? getSelection().toString().replace(/\s+/g, ' ').trim() : '');
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
let dictTimer, dictWord = null, dsToken = 0;
function speakWord(w) { if (!ttsOk) return toast('No voice available on this device.', 1800); speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(w); u.lang = 'en-US'; u.rate = 0.9; speechSynthesis.speak(u); }
const hideDictCard = () => { $('dictCard').hidden = true; dictWord = null; };
for (const ev of ['pointerdown', 'mousedown', 'touchstart']) $('dictCard').addEventListener(ev, (e) => e.preventDefault()); // keep the selection alive while tapping the card

async function showDictCard(word) {
  dictWord = word;
  let res; try { res = await lookup(word); } catch (e) { res = { error: e.message }; }
  if (dictWord !== word || !$('rSheet').hidden) return; // selection changed while loading
  $('dcWord').textContent = word;
  if (res && res.error) { $('dcPos').textContent = ''; $('dcDef').textContent = res.error; }
  else if (!res) { $('dcPos').textContent = ''; $('dcDef').textContent = 'No entry for this word in the offline dictionary. Tap “Full entry” to look it up online.'; }
  else {
    const s = res.senses[0], form = res.lemma !== word.toLowerCase();
    $('dcPos').textContent = `${form ? `form of “${res.lemma}” · ` : ''}${POS_NAME[s[0]]}`; $('dcDef').textContent = cap(s[1]) + (res.senses.length > 1 ? ` (+${res.senses.length - 1} more)` : '');
  }
  $('dictCard').hidden = false; $('dcMore').onclick = () => openDictSheet(word); $('dcSpeak').onclick = () => speakWord(word);
}
$('dcClose').onclick = () => { hideDictCard(); getSelection().removeAllRanges(); $('selBar').hidden = true; };

async function openDictSheet(word) {
  const my = ++dsToken; hideDictCard(); $('selBar').hidden = true;
  $('dsWord').textContent = word; $('dsLemma').textContent = ''; $('dsBody').innerHTML = '<p class="ds-note">Looking up…</p>';
  $('dsOxford').href = `https://www.oxfordlearnersdictionaries.com/search/english/?q=${encodeURIComponent(word)}`; $('dsWeb').href = `https://www.google.com/search?q=define+${encodeURIComponent(word)}`;
  $('dsSpeak').onclick = () => speakWord(word); $('dictSheet').hidden = false;
  let res; try { res = await lookup(word); } catch (e) { if (my === dsToken) $('dsBody').innerHTML = `<p class="ds-note"></p>`, $('dsBody').firstChild.textContent = e.message; return; }
  if (my !== dsToken) return;
  const body = $('dsBody'); body.innerHTML = '';
  if (!res) { body.innerHTML = '<p class="ds-note"></p>'; body.firstChild.textContent = `There is no entry for “${word}” in the offline dictionary. Use the links below to look it up online.`; return; }
  if (res.lemma !== word.toLowerCase()) $('dsLemma').textContent = `form of “${res.lemma}”`;
  for (const pos of [...new Set(res.senses.map((s) => s[0]))]) { // most common part of speech first
    const group = res.senses.filter((s) => s[0] === pos);
    const h4 = document.createElement('h4'); h4.textContent = POS_NAME[pos]; const ol = document.createElement('ol');
    for (const [, def, ex, syn] of group) {
      const li = document.createElement('li'); li.append(document.createTextNode(cap(def)));
      for (const e of ex.slice(0, 1)) { const em = document.createElement('em'); em.textContent = `“${cap(e)}”`; li.appendChild(em); }
      if (syn.length) { const row = document.createElement('div'); row.className = 'ds-chips'; row.innerHTML = '<span>Similar:</span>'; syn.forEach((w) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'ds-chip'; b.textContent = w; b.onclick = () => openDictSheet(w); row.appendChild(b); }); li.appendChild(row); }
      ol.appendChild(li);
    }
    body.append(h4, ol);
  }
  if (res.related && res.related.length) { const row = document.createElement('div'); row.className = 'ds-chips'; row.innerHTML = '<span>Also see:</span>'; res.related.forEach((w) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'ds-chip'; b.textContent = w; b.onclick = () => openDictSheet(w); row.appendChild(b); }); body.appendChild(row); }
}
$('dictBg').onclick = () => { dsToken++; $('dictSheet').hidden = true; };
$('selDefine').onclick = () => { const t = selectedText(); if (t) openDictSheet(t.length > 60 ? t.slice(0, 60) : t); };
document.querySelectorAll('#rSheet [data-dict]').forEach((b) => (b.onclick = () => { dictAuto = b.dataset.dict === 'on'; setPref('dictAuto', dictAuto ? 'on' : 'off'); if (!dictAuto) hideDictCard(); syncSettingsUi(); }));
$('dictOffline').onclick = async () => {
  const btn = $('dictOffline'), label = btn.textContent; btn.disabled = true;
  try { await saveForOffline((p) => (btn.textContent = `Saving… ${Math.round(p * 100)}%`)); setPref('dictOffline', '1'); toast('Dictionary saved for offline use', 2500); }
  catch (e) { toast(e.message, 4500); } finally { btn.disabled = false; btn.textContent = label; syncSettingsUi(); }
};
// a word was selected -> show its meaning after a short pause (so dragging the selection handles does not flicker)
document.addEventListener('selectionchange', () => {
  if (!readerBook || $('stepReader').hidden) return;
  clearTimeout(dictTimer); const t = selectedText();
  if (!t || !WORD.test(t) || !dictAuto || !$('rSheet').hidden || !$('dictSheet').hidden) { if (!$('dictSheet').hidden) return; hideDictCard(); return; }
  dictTimer = setTimeout(() => showDictCard(t), 300);
});

/* ----- opening a book in the reader ----- */
async function openReader(data, id, startFrac = 0, from = 'stepLibrary') {
  backTo = from; readerId = id; ttsStop(); hideDictCard(); $('dictSheet').hidden = true;
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
  document.querySelectorAll('#rSheet .txt').forEach((x) => (x.hidden = !(isText || (data.pageTexts && x.hasAttribute('data-tl'))))); // text-only settings (search, read aloud and the dictionary also work on page pictures that carry a text layer)
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

/* ----- choose pages from thumbnails ----- */
function openPicker() {
  if (!pickedPdf) return;
  const n = pickedPdf.numPages, grid = $('pgGrid'); grid.innerHTML = '';
  let a = parseInt($('from').value, 10) || null, b = parseInt($('to').value, 10) || null; if (a && !b) b = a;
  const cells = [];
  const paint = () => {
    cells.forEach((c, i) => c.classList.toggle('sel', a !== null && i + 1 >= a && i + 1 <= (b ?? a)));
    $('pgHint').textContent = a === null ? 'Tap the first page, then tap the last page.' : b === null ? `Page ${a} selected — now tap the last page.` : `Pages ${a}–${b} selected (${b - a + 1}).`;
    $('pgUse').disabled = a === null;
  };
  let queue = Promise.resolve(); const done = new Set();
  const io = new IntersectionObserver((es) => es.forEach((en) => {
    if (!en.isIntersecting) return; const i = +en.target.dataset.p; if (done.has(i)) return; done.add(i); io.unobserve(en.target);
    queue = queue.then(async () => { try { const pg = await pickedPdf.getPage(i), vp = pg.getViewport({ scale: 1 }), sc = 120 / vp.width, v = pg.getViewport({ scale: sc }), cv = en.target.querySelector('canvas'); cv.width = Math.ceil(v.width); cv.height = Math.ceil(v.height); await pg.render({ canvasContext: cv.getContext('2d'), viewport: v }).promise; } catch { /* closed */ } });
  }), { root: grid, rootMargin: '300px' });
  pickedPdf.getPage(1).then((pg) => { const v = pg.getViewport({ scale: 1 }); grid.style.setProperty('--ar', (v.width / v.height).toFixed(3)); });
  for (let i = 1; i <= n; i++) {
    const c = document.createElement('div'); c.className = 'pgc'; c.dataset.p = i; c.innerHTML = `<canvas width="10" height="14"></canvas><span>${i}</span>`;
    c.onclick = () => { if (a === null || b !== null) { a = i; b = null; } else { b = i; if (b < a) [a, b] = [b, a]; } paint(); };
    grid.appendChild(c); cells.push(c); io.observe(c);
  }
  $('pgUse').onclick = () => { $('from').value = a; $('to').value = b ?? a; closePicker(); };
  $('pgAll').onclick = () => { $('from').value = ''; $('to').value = ''; closePicker(); };
  window._pgIo = io; paint(); $('pageSheet').hidden = false;
  if (a) setTimeout(() => cells[a - 1] && cells[a - 1].scrollIntoView({ block: 'center' }), 50);
}
function closePicker() { $('pageSheet').hidden = true; if (window._pgIo) window._pgIo.disconnect(); }
$('pickPages').onclick = openPicker; $('pageBg').onclick = closePicker;
