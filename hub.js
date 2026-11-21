// Tool hub (tile grid) and the generic tool screen: choose files -> options -> convert -> download.
import { TOOLS } from './tools.js';

const $ = (id) => document.getElementById(id);
const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function matches(tool, f) {
  const toks = tool.accept.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (toks.includes('*/*')) return true;
  const name = f.name.toLowerCase();
  return toks.some((t) => (t.startsWith('.') ? name.endsWith(t) : t.endsWith('/*') ? (f.type || '').startsWith(t.slice(0, -1)) : f.type === t));
}

export function initHub({ show }) {
  let tool = null, files = [], opts = {}, inUrls = [], outUrls = [], busy = false;

  // ---- tiles on the home screen ----
  const grid = $('toolGrid');
  for (const t of TOOLS) {
    const b = el('button', 'tile', `<span class="tile-ico">${t.icon}</span><b>${escHtml(t.title)}</b><small>${escHtml(t.desc)}</small>`);
    b.type = 'button'; b.onclick = () => openTool(t.id);
    grid.appendChild(b);
  }

  const revokeIn = () => { inUrls.forEach(URL.revokeObjectURL); inUrls = []; };
  const revokeOut = () => { outUrls.forEach(URL.revokeObjectURL); outUrls = []; };
  const thumb = (blob) => { const u = URL.createObjectURL(blob); inUrls.push(u); return u; };
  const outUrl = (blob) => { const u = URL.createObjectURL(blob); outUrls.push(u); return u; };

  // ---- opening a tool ----
  function openTool(id) {
    tool = TOOLS.find((t) => t.id === id); files = []; opts = {}; revokeIn(); revokeOut();
    $('toolIcon').textContent = tool.icon; $('toolTitle').textContent = tool.title; $('toolDesc').textContent = tool.desc;
    $('toolFile').accept = tool.accept; $('toolFile').multiple = !!tool.multiple;
    $('toolDropText').textContent = tool.multiple ? 'Choose files' : 'Choose a file';
    $('toolOut').hidden = true; $('toolOut').innerHTML = ''; $('toolProg').hidden = true; $('toolErr').hidden = true;
    for (const o of tool.options) opts[o.id] = o.value ?? '';
    buildOptions(); renderFiles(); show('stepTool'); scrollTo(0, 0);
  }

  function buildOptions() {
    const box = $('toolOpts'); box.innerHTML = '';
    for (const o of tool.options) {
      const lab = el('label', 'field'); lab.dataset.opt = o.id;
      lab.appendChild(el('span', '', escHtml(o.label)));
      let input;
      if (o.type === 'select') {
        input = el('select'); for (const [v, l] of o.choices) { const op = el('option', '', escHtml(l)); op.value = v; input.appendChild(op); }
        input.value = opts[o.id];
      } else {
        input = el('input'); input.type = o.type === 'number' ? 'number' : 'text'; input.value = opts[o.id]; input.placeholder = o.placeholder || '';
        if (o.type === 'number') { input.min = o.min ?? 1; input.step = 'any'; input.inputMode = 'decimal'; }
      }
      input.oninput = input.onchange = () => { opts[o.id] = input.value; refreshVisibility(); };
      lab.appendChild(input); box.appendChild(lab);
    }
    refreshVisibility();
  }
  function refreshVisibility() {
    for (const o of tool.options) { const lab = $('toolOpts').querySelector(`[data-opt="${o.id}"]`); if (lab) lab.hidden = !!(o.show && !o.show(opts)); }
    $('toolOpts').hidden = !tool.options.length;
  }

  // ---- file list ----
  function addFiles(list) {
    const ok = [], bad = [];
    for (const f of list) (matches(tool, f) ? ok : bad).push(f);
    if (bad.length) showError(`Skipped ${bad.map((f) => `"${f.name}"`).join(', ')} — this tool does not accept that file type.`); else $('toolErr').hidden = true;
    files = tool.multiple ? files.concat(ok) : ok.slice(0, 1).length ? ok.slice(0, 1) : files;
    renderFiles();
  }
  function renderFiles() {
    const ul = $('toolFiles'); ul.innerHTML = ''; revokeIn();
    files.forEach((f, i) => {
      const li = el('li', 'tfile');
      const isImg = (f.type || '').startsWith('image/') && f.type !== 'image/svg+xml' || /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name);
      li.innerHTML = `<span class="tf-ico">${isImg ? '' : '📄'}</span><span class="tf-meta"><b></b><small>${fmtSize(f.size)}</small></span><span class="tf-acts"></span>`;
      li.querySelector('b').textContent = f.name;
      if (isImg) { const im = new Image(); im.src = thumb(f); im.alt = ''; li.querySelector('.tf-ico').appendChild(im); }
      const acts = li.querySelector('.tf-acts');
      const btn = (txt, label, fn, dis) => { const b = el('button', 'btn icon', txt); b.type = 'button'; b.setAttribute('aria-label', label); b.disabled = !!dis; b.onclick = fn; acts.appendChild(b); };
      if (tool.ordered && files.length > 1) {
        btn('↑', 'Move up', () => { [files[i - 1], files[i]] = [files[i], files[i - 1]]; renderFiles(); }, i === 0);
        btn('↓', 'Move down', () => { [files[i + 1], files[i]] = [files[i], files[i + 1]]; renderFiles(); }, i === files.length - 1);
      }
      btn('✕', 'Remove', () => { files.splice(i, 1); renderFiles(); });
      ul.appendChild(li);
    });
    const min = tool.min || 1;
    $('toolRun').disabled = files.length < min || busy;
    $('toolRunHint').textContent = files.length < min ? `Choose at least ${min} file${min > 1 ? 's' : ''}.` : tool.ordered && files.length > 1 ? 'Files are used in the order shown — use ↑ ↓ to change it.' : '';
    $('toolDropText').textContent = files.length ? (tool.multiple ? 'Add more files' : 'Choose a different file') : (tool.multiple ? 'Choose files' : 'Choose a file');
  }

  // ---- run ----
  const showError = (msg) => { $('toolErr').textContent = msg; $('toolErr').hidden = false; };
  async function run() {
    if (busy) return; busy = true; $('toolRun').disabled = true; $('toolErr').hidden = true; $('toolOut').hidden = true; $('toolOut').innerHTML = '';
    $('toolProg').hidden = false; $('toolBar').style.width = '2%'; $('toolStatus').textContent = 'Starting…';
    try {
      const res = await tool.run(files.slice(), { ...opts }, (p, msg) => { $('toolBar').style.width = Math.max(2, Math.round(p * 100)) + '%'; if (msg) $('toolStatus').textContent = msg; });
      showResults(res);
    } catch (e) { console.error(e); showError(e.message || String(e)); }
    finally { busy = false; $('toolProg').hidden = true; renderFiles(); }
  }

  function showResults(res) {
    revokeOut(); const out = $('toolOut'); out.innerHTML = ''; out.hidden = false;
    out.appendChild(el('h3', '', `✅ Done — ${res.length} file${res.length > 1 ? 's' : ''}`));
    const ul = el('ul', 'tfiles');
    const shown = res.slice(0, 60);
    for (const r of shown) {
      const url = outUrl(r.blob), li = el('li', 'tfile');
      const isImg = r.blob.type.startsWith('image/');
      li.innerHTML = `<span class="tf-ico">${isImg ? '' : r.name.endsWith('.pdf') ? '📕' : r.name.endsWith('.epub') ? '📚' : '📄'}</span><span class="tf-meta"><b></b><small>${fmtSize(r.blob.size)}${r.note ? ' · ' + escHtml(r.note) : ''}</small></span><span class="tf-acts"></span>`;
      li.querySelector('b').textContent = r.name;
      if (isImg) { const im = new Image(); im.src = url; im.alt = ''; li.querySelector('.tf-ico').appendChild(im); }
      const a = el('a', 'btn secondary', 'Download'); a.href = url; a.download = r.name; li.querySelector('.tf-acts').appendChild(a);
      ul.appendChild(li);
    }
    out.appendChild(ul);
    if (res.length > shown.length) out.appendChild(el('p', 'muted', `Showing the first ${shown.length} files. Use “Download all” to get everything.`));
    const row = el('div', 'actions row');
    if (res.length > 1) {
      const all = el('button', 'btn primary lg', 'Download all (ZIP)'); all.type = 'button';
      all.onclick = async () => {
        all.disabled = true; all.textContent = 'Preparing ZIP…';
        const zip = new JSZip(), seen = new Map();
        for (const r of res) { const n = seen.get(r.name) || 0; seen.set(r.name, n + 1); zip.file(n ? r.name.replace(/(\.[^.]*)?$/, `-${n}$1`) : r.name, r.blob); }
        const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
        const u = URL.createObjectURL(blob), a = Object.assign(document.createElement('a'), { href: u, download: `${tool.id}-results.zip` }); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 10000);
        all.disabled = false; all.textContent = 'Download all (ZIP)';
      };
      row.appendChild(all);
    }
    const sharable = res.map((r) => new File([r.blob], r.name, { type: r.blob.type }));
    if (navigator.canShare && navigator.canShare({ files: sharable })) { const s = el('button', 'btn secondary lg', 'Share'); s.type = 'button'; s.onclick = () => navigator.share({ files: sharable }).catch(() => {}); row.appendChild(s); }
    const again = el('button', 'btn text lg', 'Convert more'); again.type = 'button'; again.onclick = () => { files = []; revokeOut(); out.hidden = true; out.innerHTML = ''; renderFiles(); scrollTo({ top: 0, behavior: 'smooth' }); };
    row.appendChild(again); out.appendChild(row);
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- wiring ----
  $('toolFile').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
  const drop = $('toolDrop');
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('toolFile').click(); } });
  $('toolRun').onclick = run;
  $('toolBack').onclick = () => { if (busy) return; revokeIn(); revokeOut(); files = []; show('stepTools'); };
  return { openTool };
}
