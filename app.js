import { convert } from './converter.js';
import { Book } from './book.js';
import { parseEpub } from './reader.js';
import { initHub } from './hub.js';
import { bookId, saveBook, getBook, deleteBook, listBooks, setProgress, renameBook } from './library.js';

const $ = (id) => document.getElementById(id);
const steps = ['stepPick', 'stepOptions', 'stepProgress', 'stepResult', 'stepReader', 'stepTool'];
const show = (id) => {
  steps.forEach((s) => ($(s).hidden = s !== id));
  $('stepLibrary').hidden = $('stepTools').hidden = id !== 'stepPick';
  document.body.classList.toggle('reading', id === 'stepReader');
  if (id !== 'stepReader') delete document.body.dataset.theme;
  if (id === 'stepPick') renderLibrary();
};

let file = null, book = null, downloadUrl = null, totalPages = 0, readerBook = null, lastResult = null, backTo = 'stepPick';

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

async function renderLibrary() {
  const books = await listBooks(), ul = $('bookList');
  $('libEmpty').hidden = books.length > 0;
  ul.innerHTML = '';
  for (const b of books) {
    const li = document.createElement('li');
    const cover = b.cover ? Object.assign(document.createElement('img'), { src: URL.createObjectURL(b.cover), alt: '' }) : Object.assign(document.createElement('div'), { className: 'nocover', textContent: '📖' });
    const meta = document.createElement('div'); meta.className = 'meta';
    const t = document.createElement('b'); t.textContent = b.title;
    const pct = Math.round((b.progress || 0) * 100);
    const sm = document.createElement('small'); sm.textContent = `${b.author ? b.author + ' · ' : ''}${fmtSize(b.size)}`;
    const row = document.createElement('div'); row.className = 'pbarrow';
    row.innerHTML = '<div class="pbar"><i></i></div><span class="pct"></span>';
    row.querySelector('i').style.width = pct + '%'; row.querySelector('.pct').textContent = pct + '%';
    row.title = pct + '% read';
    meta.append(t, sm, row);
    const acts = document.createElement('div'); acts.className = 'acts';
    const mk = (icon, aria, fn, cls = '') => { const x = document.createElement('button'); x.className = 'btn icon ' + cls; x.innerHTML = `<svg class="ico"><use href="#i-${icon}"/></svg>`; x.setAttribute('aria-label', aria); x.title = aria; x.onclick = (e) => { e.stopPropagation(); fn(); }; return x; };
    acts.append(
      mk('edit', 'Rename', async () => { const n = (prompt('New name for this book:', b.title) || '').trim(); if (n && n !== b.title) { await renameBook(b.id, n); renderLibrary(); } }),
      mk('download', 'Download EPUB', () => downloadBlob(b.blob, b.title)),
      mk('trash', 'Remove', async () => { if (confirm(`Remove “${b.title}” from this device?`)) { await deleteBook(b.id); renderLibrary(); } }, 'danger'),
    );
    li.append(cover, meta, acts);
    li.onclick = () => openSaved(b.id);
    ul.appendChild(li);
  }
}

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

function openReader(data, id, startFrac = 0, from = 'stepPick') {
  backTo = from; readerId = id;
  if (readerBook) { readerBook.destroy(); readerBook = null; }
  $('rTitle').textContent = data.title;
  show('stepReader');
  let saved = 'light'; try { saved = localStorage.getItem('readerTheme') || 'light'; } catch { /* ignore */ }
  setTheme(saved);
  const reader = $('stepReader');
  reader.classList.add('chrome-hidden'); // immersive by default; tap the middle of the page for controls
  $('rProg').hidden = false;
  readerBook = new Book($('rStage'), $('rBook'), (s) => {
    $('rInfo').textContent = `${s.label} · ${Math.round((readerBook ? readerBook.progress() : 0) * 100)}%`; $('rPrev').disabled = !s.canPrev; $('rNext').disabled = !s.canNext;
    const p = readerBook ? readerBook.progress() : 0;
    $('rProg').firstChild.style.width = (p * 100).toFixed(1) + '%';
    if (!seeking) $('rSeek').value = Math.round(p * 1000);
    savePos(); // saved on every page change, so the next open resumes here
  }, { margin: 6, onCenterTap: () => reader.classList.toggle('chrome-hidden') });
  const hint = Object.assign(document.createElement('div'), { className: 'read-hint', textContent: startFrac > 0 ? `Resumed where you left off (${Math.round(startFrac * 100)}%)` : 'Tap the middle of the page for controls' });
  document.body.appendChild(hint);
  setTimeout(() => (hint.style.opacity = 0), 2500); setTimeout(() => hint.remove(), 3200);
  readerBook.load(data, startFrac);
}

async function openSaved(id) {
  const rec = await getBook(id);
  if (!rec) return;
  busy(true, 'Opening book…');
  try { openReader(await parseEpub(rec.blob), id, rec.progress || 0); }
  catch (err) { console.error(err); alert('Could not open this book: ' + (err.message || err)); show('stepPick'); }
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
  savePos(); $('rProg').hidden = true;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (readerBook) { readerBook.destroy(); readerBook = null; }
  show(backTo);
};
$('rPrev').onclick = () => readerBook && readerBook.prev();
$('rNext').onclick = () => readerBook && readerBook.next();
$('rSeek').addEventListener('input', () => { seeking = true; });
$('rSeek').addEventListener('change', () => { seeking = false; readerBook && readerBook.goTo($('rSeek').value / 1000); });
$('rFull').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.().catch(() => {}));
renderLibrary();

initHub({ show });
