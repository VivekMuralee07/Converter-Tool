import { convert } from './converter.js';
import { Book } from './book.js';

const $ = (id) => document.getElementById(id);
const steps = ['stepPick', 'stepOptions', 'stepProgress', 'stepResult'];
const show = (id) => steps.forEach((s) => ($(s).hidden = s !== id));

let file = null, book = null, downloadUrl = null;

async function pick(f) {
  if (!f) return;
  if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) { alert('Please choose a PDF file.'); return; }
  file = f;
  $('fileName').textContent = f.name;
  $('title').value = f.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ');
  $('author').value = '';
  show('stepOptions');
  try { // prefill from PDF metadata
    const { openPdf } = await import('./converter.js');
    const { meta, pdf } = await openPdf(f);
    if (meta.Title && meta.Title.trim()) $('title').value = meta.Title.trim();
    if (meta.Author) $('author').value = meta.Author.trim();
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
  try {
    const res = await convert(file, opts, (p, msg) => { $('barFill').style.width = Math.round(p * 100) + '%'; $('status').textContent = msg; });
    const fname = opts.title.replace(/[\\/:*?"<>|]+/g, '').trim() || 'book';
    downloadUrl = URL.createObjectURL(res.epub);
    const a = $('downloadBtn'); a.href = downloadUrl; a.download = fname + '.epub';
    const mb = (res.epub.size / 1048576).toFixed(1);
    $('resultTitle').textContent = `“${opts.title}” is ready`;
    $('resultInfo').textContent = `${res.pageCount} PDF pages · ${mb} MB` + (res.mode === 'reflow' && !res.hasText ? ' · no text found — try “Fixed pages”' : '');
    const shareFile = new File([res.epub], fname + '.epub', { type: 'application/epub+zip' });
    $('shareBtn').hidden = !(navigator.canShare && navigator.canShare({ files: [shareFile] }));
    $('shareBtn').onclick = () => navigator.share({ files: [shareFile], title: opts.title }).catch(() => {});
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
    if (params.files && params.files.length) pick(await params.files[0].getFile());
  });
}
