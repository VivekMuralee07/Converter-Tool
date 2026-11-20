// PDF -> EPUB conversion, entirely client-side (pdf.js + JSZip).
import * as pdfjsLib from './lib/pdf.min.mjs';
import { loadScript } from './loader.js';
import { normalize, shiftFmt, toHtml } from './inline.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sleep0 = () => new Promise((r) => setTimeout(r, 0));

export async function openPdf(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  let meta = {};
  try { meta = (await pdf.getMetadata()).info || {}; } catch { /* ignore */ }
  return { pdf, meta };
}

async function renderPage(page, scale, quality) {
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
  const out = { blob, w: canvas.width, h: canvas.height };
  canvas.width = canvas.height = 0;
  return out;
}

/* ---------- "fit to screen": trim margins, then cut pages into screen-shaped slices ---------- */
const toBlob = (c, q) => new Promise((res) => c.toBlob(res, 'image/jpeg', q));

async function renderCanvas(page, width) {
  const vp = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return canvas;
}

// ---- page analysis: find the body, its bands and columns on a downscaled copy of the page ----
function analyze(big, smallW = 600) {
  const f = big.width / smallW, h = Math.round(big.height / f);
  const sm = document.createElement('canvas'); sm.width = smallW; sm.height = h;
  const c = sm.getContext('2d', { willReadFrequently: true });
  c.drawImage(big, 0, 0, smallW, h);
  const d = c.getImageData(0, 0, smallW, h).data;
  sm.width = sm.height = 0;
  const ink = new Uint8Array(smallW * h);
  for (let p = 0, i = 0; p < ink.length; p++, i += 4) ink[p] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 < 222 ? 1 : 0;
  const mn = new Int32Array(h).fill(-1), mx = new Int32Array(h).fill(-1);
  for (let y = 0; y < h; y++) for (let x = 0; x < smallW; x++) if (ink[y * smallW + x]) { if (mn[y] < 0) mn[y] = x; mx[y] = x; }
  return { ink, w: smallW, h, f, mn, mx };
}

function groupRows(a, y0, y1, gap) { // runs of ink rows separated by more than `gap` blank rows
  const segs = []; let cur = null;
  for (let y = y0; y <= y1; y++) if (a.mn[y] >= 0) { if (cur && y - cur.y1 <= gap) cur.y1 = y; else { cur = { y0: y, y1: y }; segs.push(cur); } }
  return segs;
}

// Page body = everything except a running header/footer (thin band at the edge, set apart by a gap).
function findBody(a) {
  const segs = groupRows(a, 0, a.h - 1, Math.round(a.h * 0.012));
  if (!segs.length) return null;
  if (segs.length > 1 && segs[0].y1 < a.h * 0.12) segs.shift();
  if (segs.length > 1 && segs[segs.length - 1].y0 > a.h * 0.9) segs.pop();
  const y0 = segs[0].y0, y1 = segs[segs.length - 1].y1;
  let x0 = a.w, x1 = 0;
  for (let y = y0; y <= y1; y++) if (a.mn[y] >= 0) { if (a.mn[y] < x0) x0 = a.mn[y]; if (a.mx[y] > x1) x1 = a.mx[y]; }
  return { x0, x1, y0, y1 };
}

// Split a band into side-by-side columns where a clear vertical gutter runs through its whole height.
function splitColumns(a, band, x0, x1) {
  const bh = band.y1 - band.y0 + 1;
  if (bh < a.h * 0.11) return [{ x0, x1 }];
  const col = new Int32Array(a.w);
  for (let y = band.y0; y <= band.y1; y++) { const o = y * a.w; for (let x = x0; x <= x1; x++) col[x] += a.ink[o + x]; }
  const gutMin = Math.max(8, Math.round(a.w * 0.025)), minCol = Math.round(a.w * 0.11), speck = bh * 0.01;
  const cols = []; let start = x0, run = 0, runStart = 0;
  for (let x = x0; x <= x1; x++) {
    if (col[x] <= speck) { if (!run) runStart = x; run++; }
    else { if (run >= gutMin && runStart > start) { cols.push({ x0: start, x1: runStart - 1 }); start = x; } run = 0; }
  }
  cols.push({ x0: start, x1 });
  return cols.length > 1 && cols.every((c) => c.x1 - c.x0 >= minCol) ? cols : [{ x0, x1 }];
}

// Segments to show, in reading order (small-image coordinates). `split` = detect bands/columns.
function planSegments(a, split) {
  const body = findBody(a);
  if (!body) return null;
  if (!split) return { body, segs: [body] };
  const segs = [];
  for (const band of groupRows(a, body.y0, body.y1, Math.max(4, Math.round(a.h * 0.007)))) {
    let x0 = a.w, x1 = 0;
    for (let y = band.y0; y <= band.y1; y++) if (a.mn[y] >= 0) { if (a.mn[y] < x0) x0 = a.mn[y]; if (a.mx[y] > x1) x1 = a.mx[y]; }
    for (const c of splitColumns(a, band, x0, x1)) segs.push({ x0: c.x0, x1: c.x1, y0: band.y0, y1: band.y1 });
  }
  return { body, segs };
}

// Joins segments into one tall strip and cuts it into slices shaped like the screen, preferring
// uniform (blank) rows so text lines aren't sliced.
function makeStripper(aspect, Wc, emit) {
  const sliceH = Math.round(Wc / aspect), GAP = Math.round(Wc * 0.012);
  let strip = document.createElement('canvas'); strip.width = Wc; strip.height = sliceH * 3;
  let sctx = strip.getContext('2d', { willReadFrequently: true });
  sctx.fillStyle = '#fff'; sctx.fillRect(0, 0, Wc, strip.height);
  let pendH = 0, texts = [];

  const flatRow = (data, y, top) => {
    const o = (y - top) * Wc * 4; let mn = 255, mx = 0;
    for (let x = 0; x < Wc; x++) { const g = data[o + x * 4 + 1]; if (g < mn) mn = g; if (g > mx) mx = g; if (mx - mn > 40) return false; }
    return true;
  };
  async function cut(final) {
    while (pendH >= sliceH || (final && pendH > 0)) {
      let end = Math.min(pendH, sliceH);
      if (pendH > sliceH) {
        const top = Math.floor(sliceH * 0.72), data = sctx.getImageData(0, top, Wc, sliceH - top).data;
        for (let t = sliceH; t > top; t--) if (t < pendH && flatRow(data, t - 1, top)) { end = t; break; }
      }
      const mine = texts.filter((t) => t.base <= end), rest = texts.filter((t) => t.base > end);
      rest.forEach((t) => { t.base -= end; }); texts = rest;
      const full = sctx.getImageData(0, 0, Wc, end).data;
      let ink = false;
      for (let i = 1; i < full.length; i += 16) if (full[i] < 200) { ink = true; break; }
      if (ink) {
        const c = document.createElement('canvas'); c.width = Wc; c.height = end;
        c.getContext('2d').drawImage(strip, 0, 0, Wc, end, 0, 0, Wc, end);
        await emit({ blob: await toBlob(c, 0.8), w: Wc, h: end, texts: mine });
        c.width = c.height = 0;
      }
      sctx.drawImage(strip, 0, end, Wc, pendH - end, 0, 0, Wc, pendH - end);
      sctx.fillStyle = '#fff'; sctx.fillRect(0, pendH - end, Wc, strip.height - (pendH - end));
      pendH -= end;
      if (final && pendH <= 0) break;
    }
  }
  return {
    async addSeg(src, sx, sy, sw, sh, dw, dh, items = []) {
      if (pendH + dh + GAP > strip.height) { // grow the strip
        const n = document.createElement('canvas'); n.width = Wc; n.height = pendH + dh + GAP + sliceH;
        const nc = n.getContext('2d', { willReadFrequently: true }); nc.fillStyle = '#fff'; nc.fillRect(0, 0, n.width, n.height);
        nc.drawImage(strip, 0, 0); strip.width = strip.height = 0; strip = n; sctx = nc;
      }
      const dx = Math.round(Wc * 0.015), kx = dw / sw, ky = dh / sh;
      sctx.drawImage(src, sx, sy, sw, sh, dx, pendH, dw, dh);
      for (const t of items) texts.push({ t: t.t, x: dx + (t.x - sx) * kx, base: pendH + (t.base - sy) * ky, fs: t.fs * kx, w: t.w * kx });
      pendH += dh + Math.round(GAP / 2);
    },
    async endPage() { pendH += GAP; await cut(false); },
    finish: () => cut(true),
    get pending() { return pendH; },
  };
}


/* ---------- pictures (e.g. decorative chapter numbers) ---------- */
const comp = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];

export async function imageBoxes(page) {
  if (page.rotate) return [];
  const OPS = pdfjsLib.OPS, [vx0, vy0, vx1, vy1] = page.view, W = vx1 - vx0, H = vy1 - vy0;
  const ol = await page.getOperatorList();
  let m = [1, 0, 0, 1, 0, 0]; const stack = [], out = [];
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], a = ol.argsArray[i];
    if (fn === OPS.save) stack.push(m);
    else if (fn === OPS.restore) m = stack.pop() || m;
    else if (fn === OPS.transform) m = comp(m, a);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(m); if (a && a[0]) m = comp(m, a[0]); }
    else if (fn === OPS.paintFormXObjectEnd) m = stack.pop() || m;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject || fn === OPS.paintJpegXObject) {
      const xs = [], ys = [];
      for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { xs.push(m[0] * u + m[2] * v + m[4]); ys.push(m[1] * u + m[3] * v + m[5]); }
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), w = x1 - x0, h = y1 - y0;
      if (w < 22 || h < 22) continue;                                   // rules, bullets, specks
      if (w > W * 0.9 && h > H * 0.55) continue;                        // full-page picture (scan/background)
      if (x1 < vx0 || x0 > vx1 || y1 < vy0 || y0 > vy1) continue;      // off the page
      if (out.some((o) => Math.abs(o.x0 - x0) < 2 && Math.abs(o.y1 - y1) < 2 && Math.abs(o.w - w) < 2)) continue; // drawn twice
      out.push({ x0, x1, y0, y1, w, h, pageW: W, pageH: H });
    }
  }
  return out;
}

// Crops the listed boxes out of one rendering of the page (opaque PNG/JPEG, so the picture looks exactly like the PDF).
export async function cropImages(page, boxes, scale = 2.5) {
  const vp = page.getViewport({ scale }), [vx0, , , vy1] = page.view;
  const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  for (const b of boxes) {
    const sx = Math.max(0, Math.floor((b.x0 - vx0) * scale)), sy = Math.max(0, Math.floor((vy1 - b.y1) * scale));
    const sw = Math.min(c.width - sx, Math.ceil(b.w * scale)), sh = Math.min(c.height - sy, Math.ceil(b.h * scale));
    if (sw < 4 || sh < 4) continue;
    const o = document.createElement('canvas'); o.width = sw; o.height = sh; o.getContext('2d').drawImage(c, sx, sy, sw, sh, 0, 0, sw, sh);
    const big = sw * sh > 700000;
    b.blob = await new Promise((r) => o.toBlob(r, big ? 'image/jpeg' : 'image/png', 0.88)); b.pw = sw; b.ph = sh; b.mime = big ? 'image/jpeg' : 'image/png';
    o.width = o.height = 0;
  }
  c.width = c.height = 0;
  return boxes.filter((b) => b.blob);
}

/* ---------- formulas and tables kept as pictures ---------- */
const MATHCH = /[=±×÷∑∫√∂∆≤≥≈≠∞→←↔∝≡∈∉∪∩⊂⊃∀∃∇∏°′″²³]/, GREEK = /[α-ωΑ-Ω]/;
const isMathLine = (l) => l.text.length <= 95 && /[\p{L}\p{N}]/u.test(l.text) && (l.text.match(/\p{L}{3,}/gu) || []).length <= 5 && (MATHCH.test(l.text) || GREEK.test(l.text)) && (l.sym >= 0.1 || /=/.test(l.text)); // few real words + operators = display formula
const isTableLine = (l) => l.cols >= 2 && l.text.length <= 140;

// Splits a page's lines into ordinary text lines and picture regions (display formulas, tables).
export function findRegions(lines) {
  const keep = [], boxes = []; let cur = null;
  const close = () => {
    if (!cur) return;
    const math = cur.lines.some(isMathLine), tableLines = cur.lines.filter(isTableLine).length;
    if (math || tableLines >= 3) {
      const ls = cur.lines, pw = ls[0].pageW, ph = ls[0].pageH, pad = 3;
      const x0 = Math.max(0, Math.min(...ls.map((l) => l.x)) - pad), x1 = Math.min(pw, Math.max(...ls.map((l) => l.right)) + pad);
      const y1 = Math.min(ph, Math.max(...ls.map((l) => l.y + l.size * 0.95)) + pad), y0 = Math.max(0, Math.min(...ls.map((l) => l.y - l.size * 0.4)) - pad);
      boxes.push({ x0, x1, y0, y1, w: x1 - x0, h: y1 - y0, pageW: pw, pageH: ph, region: true });
    } else keep.push(...cur.lines);
    cur = null;
  };
  for (const l of lines) { // lines come top to bottom
    const flagged = isMathLine(l) || isTableLine(l) || (cur && l.text.length <= 3);
    if (flagged && cur && cur.last.y - l.y <= Math.max(cur.last.size, l.size) * 2.4) { cur.lines.push(l); cur.last = l; }
    else { close(); if (flagged) cur = { lines: [l], last: l }; else keep.push(l); }
  }
  close();
  return { keep, boxes };
}

/* ---------- OCR (scanned pages) ---------- */
export const OCR_LANGS = { eng: 'English', hin: 'Hindi', tam: 'Tamil', tel: 'Telugu', mal: 'Malayalam', kan: 'Kannada', ben: 'Bengali', mar: 'Marathi', guj: 'Gujarati', fra: 'French', deu: 'German', spa: 'Spanish', ita: 'Italian', por: 'Portuguese', ara: 'Arabic', rus: 'Russian' };

async function makeOcr(lang) {
  await loadScript('lib/tesseract/tesseract.min.js');
  const local = lang === 'eng';
  return window.Tesseract.createWorker(lang, 1, {
    workerPath: 'lib/tesseract/worker.min.js', corePath: 'lib/tesseract', workerBlobURL: false, gzip: true,
    langPath: local ? 'lib/tesseract/lang' : `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}/4.0.0_best_int`, // English is built in; other languages download once
  });
}

// Reads one page image with OCR and returns lines in the same shape as extractLines()
async function ocrPageLines(worker, page, scale = 2.2) {
  const vp1 = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale });
  const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const { data } = await worker.recognize(c, {}, { blocks: true, text: false });
  c.width = c.height = 0;
  const raw = (data.lines || []).filter((l) => l.text && l.text.trim() && l.confidence > 35 && l.bbox.y1 > l.bbox.y0);
  const hs = raw.map((l) => l.bbox.y1 - l.bbox.y0).sort((a, b) => a - b), med = hs[Math.floor(hs.length / 2)] || 1;
  return raw.map((l) => {
    const h = l.bbox.y1 - l.bbox.y0, eff = h > med * 1.35 ? h : med; // lines with descenders must not look like headings
    return { text: l.text.replace(/\s+/g, ' ').trim(), x: l.bbox.x0 / scale, right: l.bbox.x1 / scale, y: vp1.height - l.bbox.y1 / scale + h * 0.2 / scale, size: eff / scale * 0.78, pageH: vp1.height, pageW: vp1.width, cols: 0, sym: 0 };
  });
}

/* ---------- text extraction ---------- */
// bold / italic flags for each font used on the page (1 = bold, 2 = italic); needs the page's operator list to have been read
async function fontFlags(page, tc) {
  try { await page.getOperatorList(); } catch { /* fonts unknown */ }
  const map = {};
  for (const fn of new Set(tc.items.map((i) => i.fontName))) {
    let f = null; try { f = page.commonObjs.has(fn) ? page.commonObjs.get(fn) : null; } catch { /* not loaded */ }
    const name = (f && f.name) || (tc.styles[fn] && tc.styles[fn].fontFamily) || '';
    map[fn] = ((f && f.bold) || /bold|black|heavy|semibold|demi/i.test(name) ? 1 : 0) | ((f && f.italic) || /italic|oblique/i.test(name) ? 2 : 0);
  }
  return map;
}

// groups text pieces into lines (top to bottom, left to right)
function groupItems(items, vp, col = 0) {
  items = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of items) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) < Math.max(it.size, last.size) * 0.55) { last.items.push(it); last.size = Math.max(last.size, it.size); }
    else lines.push({ y: it.y, size: it.size, items: [it] });
  }
  return lines.map((l) => {
    l.items.sort((a, b) => a.x - b.x);
    let raw = '', flags = [], prev = null, chars = {}, cols = 0;
    const put = (str, f) => { raw += str; for (let k = 0; k < str.length; k++) flags.push(f); };
    for (const it of l.items) {
      if (prev && it.x - (prev.x + prev.w) > Math.max(it.size * 1.8, 14)) cols++; // wide gap = another table column
      if (prev && !raw.endsWith(' ') && !it.str.startsWith(' ') && it.x - (prev.x + prev.w) > it.size * 0.15) put(' ', 0);
      put(it.str, it.fl); prev = it;
      const k = Math.round(it.size * 2) / 2; chars[k] = (chars[k] || 0) + it.str.length;
    }
    const size = +Object.entries(chars).sort((a, b) => b[1] - a[1])[0][0];
    const first = l.items[0], lastIt = l.items[l.items.length - 1];
    const { text: clean, fmt } = normalize(raw, flags), sym = clean.length ? (clean.match(/[^\p{L}\p{N}\s.,;:!?'"()\-–—’“”‘]/gu) || []).length / clean.length : 0;
    return { text: clean, fmt, y: l.y, x: first.x, right: lastIt.x + lastIt.w, size, pageH: vp.height, pageW: vp.width, cols, sym, col };
  }).filter((l) => l.text);
}

// A page set in two columns has a clear vertical gutter that (almost) no text crosses. Returns its x, or null.
function findGutter(items, W) {
  if (items.length < 30) return null;
  const xs = items.map((i) => [i.x, i.x + i.w]);
  let best = null;
  for (let g = W * 0.3; g <= W * 0.7; g += 2) {
    let cross = 0, l = 0, r = 0;
    for (const [x0, x1] of xs) { if (x0 < g + 4 && x1 > g - 4) cross++; else if (x1 <= g) l++; else r++; }
    if (cross <= items.length * 0.08 && l >= items.length * 0.25 && r >= items.length * 0.25 && (!best || cross < best.cross || (cross === best.cross && Math.abs(g - W / 2) < Math.abs(best.g - W / 2)))) best = { g, cross };
  }
  return best ? best.g : null;
}

export async function extractLines(page, withItems = false) {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const flags = await fontFlags(page, tc);
  const items = tc.items
    .filter((i) => i.str && i.str.trim() !== '')
    .map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], size: Math.hypot(i.transform[0], i.transform[1]) || i.height, w: i.width, fl: flags[i.fontName] || 0 }));
  let lines;
  const g = findGutter(items, vp.width);
  if (g !== null) {
    const L = items.filter((i) => i.x + i.w <= g + 4 && !(i.x < g + 4 && i.x + i.w > g - 4)), R = items.filter((i) => i.x >= g - 4 && !(i.x < g + 4 && i.x + i.w > g - 4));
    const F = items.filter((i) => i.x < g + 4 && i.x + i.w > g - 4);
    const mode = (ls, dflt) => { const c = {}; for (const l of ls) { const k = Math.round(l.x / 2) * 2; c[k] = (c[k] || 0) + 1; } const e = Object.entries(c).sort((a, b) => b[1] - a[1])[0]; return e ? +e[0] : dflt; };
    const gl = groupItems(L, vp, 1), gr = groupItems(R, vp, 2), gf = groupItems(F, vp, 0);
    // two columns only if both sides really hold running text
    const longL = gl.filter((l) => l.right - l.x > vp.width * 0.22).length, longR = gr.filter((l) => l.right - l.x > vp.width * 0.22).length;
    if (longL >= 6 && longR >= 6) {
      const bl = mode(gl, 0), br = mode(gr, g);
      gl.forEach((l) => { l.base = bl; l.gut = g; }); gr.forEach((l) => { l.base = br; l.gut = g; }); gf.forEach((l) => { l.gut = g; });
      // reading order: full-width lines separate bands; inside a band the left column comes first, then the right
      const out = []; let a = [], b = [];
      for (const l of [...gl, ...gr, ...gf].sort((p, q) => q.y - p.y)) {
        if (l.col === 0) { out.push(...a, ...b, l); a = []; b = []; } else (l.col === 1 ? a : b).push(l);
      }
      out.push(...a, ...b); lines = out;
    }
  }
  if (!lines) lines = groupItems(items, vp, 0);
  if (withItems) return { lines, items, vp };
  return lines;
}

export function stripHeadersFooters(pagesLines) {
  const norm = (t) => t.toLowerCase().replace(/\d+/g, '#').replace(/[^\p{L}#]+/gu, ' ').trim();
  const DOMAIN = /\b[a-z0-9-]{3,}\.(com|net|org|io|co|in|me|ru|info|to)\b/i; // site watermarks such as "OceanofPDF.com"
  const edge = (l) => l.y > l.pageH * 0.92 || l.y < l.pageH * 0.07;
  const nearEdge = (l) => l.y > l.pageH * 0.84 || l.y < l.pageH * 0.14;
  const counts = new Map();
  for (const lines of pagesLines) {
    const seen = new Set();
    for (const l of lines) if (l.text.length <= 60) { const k = norm(l.text); if (k && !seen.has(k)) { seen.add(k); counts.set(k, (counts.get(k) || 0) + 1); } }
  }
  const n = pagesLines.length, min = Math.max(3, n * 0.4);
  return pagesLines.map((lines) => lines.filter((l) => {
    const c = counts.get(norm(l.text)) || 0;
    if (edge(l) && (/^\W*\d+\W*$/.test(l.text) || c >= min)) return false;
    if (DOMAIN.test(l.text) && l.text.length <= 60 && c >= Math.min(3, n)) return false; // watermark anywhere on the page
    if (nearEdge(l) && l.text.length <= 50 && c >= Math.max(4, n * 0.5)) return false;     // repeated running header/footer
    return true;
  }));
}

// joins two formatting range lists (the second one starts at `by` in the combined text)
const joinFmt = (a, b, by, max) => {
  const out = (a || []).map((r) => [r[0], Math.min(r[1], max), r[2]]).filter((r) => r[1] > r[0]);
  for (const r of shiftFmt(b, by)) { const p = out[out.length - 1]; if (p && p[2] === r[2] && r[0] - p[1] <= 1) p[1] = r[1]; else out.push(r); }
  return out;
};
const BULLET = /^[•●▪◦‣▫■□∙]\s*/, NUMBER = /^(\d{1,2})[.)]\s+(?=[\p{L}“"‘'(])/u;

export function buildBlocks(pagesLines, pagesImgs = []) {
  const all = pagesLines.flat();
  const sizeW = {};
  for (const l of all) sizeW[l.size] = (sizeW[l.size] || 0) + l.text.length;
  const body = +(Object.entries(sizeW).sort((a, b) => b[1] - a[1])[0] || [12])[0];
  const xs = {};
  for (const l of all) { const k = Math.round(l.x / 2) * 2; xs[k] = (xs[k] || 0) + 1; }
  const left = +(Object.entries(xs).sort((a, b) => b[1] - a[1])[0] || [0])[0];
  const widths = all.map((l) => l.right - l.x).sort((a, b) => a - b), bodyW = widths[Math.floor(widths.length * 0.9)] || 1; // typical full line width
  // bold / italic only where it is emphasis: if most of the book is flagged, the flag is just the body font
  let totalChars = 0, boldChars = 0, italChars = 0;
  for (const l of all) { totalChars += l.text.length; for (const [s0, e0, f] of l.fmt || []) { if (f & 1) boldChars += e0 - s0; if (f & 2) italChars += e0 - s0; } }
  const mask = (boldChars > totalChars * 0.5 ? 0 : 1) | (italChars > totalChars * 0.5 ? 0 : 2);
  const fmtOf = (l) => (l.fmt || []).map((r) => [r[0], r[1], r[2] & mask]).filter((r) => r[2]);

  const blocks = [];
  const endsSentence = /[.!?:"”’)\]]$/;
  pagesLines.forEach((lines, pi) => {
    const maxWc = {};
    for (const l of lines) maxWc[l.col || 0] = Math.max(maxWc[l.col || 0] || 1, l.right - l.x);
    // text lines and pictures in reading order (top to bottom; for a two-column page the lines already come in reading order)
    const imgs = pagesImgs[pi] || [];
    let items;
    if (lines.some((l) => l.col)) {
      items = lines.map((l) => ({ y: l.y, l }));
      const gut = lines.find((l) => l.gut).gut;
      for (const im of imgs) {
        const c = im.w > im.pageW * 0.6 ? 0 : (im.x0 + im.x1) / 2 < gut ? 1 : 2;
        let at = items.findIndex((it) => it.l && it.l.y < im.y1 - 1 && (c === 0 || !it.l.col || it.l.col === c));
        if (at < 0) at = items.length;
        items.splice(at, 0, { y: im.y1, im });
      }
    } else items = [...lines.map((l) => ({ y: l.y, l })), ...imgs.map((im) => ({ y: im.y1, im }))].sort((a, b) => b.y - a.y);
    let prev = null;
    items.forEach((it, idx) => {
      if (it.im) {
        const im = it.im;
        const opener = !im.region && idx === 0 && lines.length >= 3 && im.w <= im.pageW * 0.55 && im.h <= im.pageH * 0.3; // picture that starts the page = chapter opener
        blocks.push({ t: 'img', blob: im.blob, mime: im.mime, pw: im.pw, ph: im.ph, wf: Math.min(1, im.w / im.pageW), em: im.region ? im.w / body : undefined, region: !!im.region, opener, page: pi });
        prev = null; return;
      }
      const l = it.l;
      if (prev && (prev.col || 0) !== (l.col || 0)) prev = null; // moved to another column: decide like at the top of a page
      const lf = l.base !== undefined ? l.base : left, maxW = maxWc[l.col || 0];
      const level = l.size >= body * 1.5 ? 1 : l.size >= body * 1.15 ? 2 : 0;
      const isHead = level && l.text.length < 140;
      const last = blocks[blocks.length - 1];
      if (isHead) {
        if (last && last.t === 'h' + level && prev && last.page === pi) last.text += ' ' + l.text;
        else blocks.push({ t: 'h' + level, text: l.text, page: pi });
        prev = null; return;
      }
      // centred lines (titles, dedications, verse) stay centred, one block per line
      // (only clearly short lines: justified full-width lines measure a little narrow and must not count as centred)
      if (!l.col && Math.abs((l.x + l.right) / 2 - l.pageW / 2) < l.pageW * 0.025 && l.right - l.x < bodyW * 0.62 && l.x - left > l.size * 1.5) {
        blocks.push({ t: 'p', text: l.text, align: 'center', page: pi }); prev = null; return;
      }
      // bullets and numbered items
      let mk = null;
      const bm = BULLET.exec(l.text), nm = bm ? null : NUMBER.exec(l.text);
      if (bm && l.text.length > bm[0].length) mk = { ordered: false, len: bm[0].length };
      else if (nm) {
        const n = +nm[1];
        if (last && last.t === 'li' && last.ordered && n === last.n + 1 && last.page >= pi - 1) mk = { ordered: true, n, len: nm[0].length };
        else if (n === 1 && (!prev || endsSentence.test(prev.text) || !last || last.t !== 'p')) mk = { ordered: true, n, len: nm[0].length };
      }
      if (mk) {
        const text = l.text.slice(mk.len), fmt = shiftFmt(fmtOf(l), -mk.len);
        const blk = { t: 'li', ordered: mk.ordered, n: mk.n, text, page: pi }; if (fmt.length) blk.fmt = fmt;
        blocks.push(blk); prev = l; return;
      }
      const gap = prev ? prev.y - l.y : 0;
      const contLi = last && last.t === 'li' && (!prev || (gap <= l.size * 1.7 && (l.x - lf > l.size * 0.8 || !endsSentence.test(prev.text))));
      let startNew = !last || last.t[0] === 'h' || last.t === 'img' || last.align === 'center' || (last.t === 'li' && !contLi);
      if (!startNew && prev && !contLi) {
        const frag = l.text.length <= 4 || prev.text.length <= 4; // math symbols, bullets, stray glyphs
        const indent = !frag && l.x - lf > l.size * 0.8;
        const shortPrev = prev.text.length > 20 && prev.right - prev.x < maxW * 0.7 && endsSentence.test(prev.text);
        startNew = gap > l.size * (frag ? 3 : 1.9) || indent || shortPrev;
      } else if (!startNew && !prev && !contLi) {
        // first line on a new page (or column): continue the paragraph unless it clearly starts a new one
        startNew = endsSentence.test(last.text) && (l.x - lf > l.size * 0.8 || /^[A-Z“"‘']/.test(l.text) && /[.!?”"]$/.test(last.text));
        if (!/^[a-z0-9,;]/.test(l.text) && endsSentence.test(last.text)) startNew = true;
      }
      const f = fmtOf(l);
      if (startNew) { const blk = { t: 'p', text: l.text, page: pi }; if (f.length) blk.fmt = f; blocks.push(blk); }
      else {
        const hyph = /[-‐]$/.test(last.text) && /^[a-z]/.test(l.text), base = hyph ? last.text.length - 1 : last.text.length + 1;
        last.text = hyph ? last.text.slice(0, -1) + l.text : last.text + ' ' + l.text;
        const j = joinFmt(last.fmt, f, base, base); if (j.length) last.fmt = j; else delete last.fmt;
      }
      prev = l;
    });
  });
  return blocks;
}

// The PDF's own bookmarks, as [{ title, level (0/1), page (0-based, within the converted range) }]
async function readOutline(pdf, first, last) {
  let root; try { root = await pdf.getOutline(); } catch { return []; }
  if (!root || !root.length) return [];
  const out = [];
  const walk = async (items, level) => {
    for (const it of items) {
      if (out.length >= 400) return;
      let pg = null;
      try {
        let d = it.dest; if (typeof d === 'string') d = await pdf.getDestination(d);
        if (Array.isArray(d) && d[0] != null) pg = typeof d[0] === 'object' ? await pdf.getPageIndex(d[0]) : d[0];
      } catch { /* bookmark to nowhere */ }
      const title = (it.title || '').replace(/\s+/g, ' ').trim();
      if (pg != null && title && pg + 1 >= first && pg + 1 <= last) out.push({ title: title.slice(0, 120), level, page: pg + 1 - first });
      if (it.items && it.items.length && level < 1) await walk(it.items, level + 1);
    }
  };
  await walk(root, 0);
  return out;
}
const normTitle = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// bookmarks are usable when at least two top-level entries point to different pages
const usableOutline = (o) => { const top = o.filter((e) => e.level === 0); return top.length >= 2 && new Set(top.map((e) => e.page)).size >= 2 ? o : []; };

function chunkChapters(blocks, pageCount, title, offset = 0, outline = []) {
  if (outline.length) { // chapters straight from the PDF's bookmarks
    const tops = [];
    for (const e of outline) {
      if (e.level === 0 && !(tops.length && tops[tops.length - 1].page === e.page)) tops.push({ title: e.title, page: e.page, subs: [] });
      else if (tops.length) tops[tops.length - 1].subs.push({ title: e.title, page: e.page });
    }
    const chapters = []; let anchorN = 0;
    const front = blocks.filter((b) => b.page < tops[0].page);
    if (front.length) chapters.push({ title, blocks: front, subs: [] });
    tops.forEach((t, i) => {
      const end = i + 1 < tops.length ? tops[i + 1].page : Infinity;
      const bl = blocks.filter((b) => b.page >= t.page && b.page < end);
      // make sure the chapter starts with a heading carrying its bookmark title
      const head = bl.slice(0, 3).findIndex((b) => b.t === 'h1' || b.t === 'h2' || (b.t === 'p' && normTitle(b.text) === normTitle(t.title)));
      if (head >= 0 && (bl[head].t === 'p' || bl[head].t === 'h2')) bl[head].t = 'h1';
      else if (head < 0) bl.unshift({ t: 'h1', text: t.title, page: t.page });
      const subs = [];
      for (const sb of t.subs) {
        let at = bl.findIndex((b, k) => k > 0 && b.t !== 'img' && normTitle(b.text || '') === normTitle(sb.title)); // the heading itself
        if (at < 0 && sb.page > t.page) at = bl.findIndex((b) => b.page >= sb.page && b.t !== 'img'); // else the first text on its page
        if (at > 0) { bl[at].anchor = bl[at].anchor || `s${++anchorN}`; subs.push({ title: sb.title, anchor: bl[at].anchor }); }
      }
      chapters.push({ title: t.title, blocks: bl, subs });
    });
    return chapters.filter((c) => c.blocks.length);
  }
  const h1s = blocks.filter((b) => b.t === 'h1').length, openers = blocks.filter((b) => b.t === 'img' && b.opener).length;
  const chapters = [];
  if (h1s < 2 && openers >= 2) { // novels whose chapter numbers are pictures
    let cur = null, k = 0;
    for (const b of blocks) {
      if (b.t === 'img' && b.opener) { b.title = `Chapter ${++k}`; cur = { title: b.title, blocks: [b] }; chapters.push(cur); }
      else { if (!cur) { cur = { title: 'Front matter', blocks: [] }; chapters.push(cur); } cur.blocks.push(b); }
    }
  } else if (h1s >= 2) {
    let cur = null;
    for (const b of blocks) {
      if (b.t === 'h1') { cur = { title: b.text, blocks: [b] }; chapters.push(cur); }
      else { if (!cur) { cur = { title, blocks: [] }; chapters.push(cur); } cur.blocks.push(b); }
    }
  } else {
    const per = 10;
    for (let s = 0; s < pageCount; s += per) {
      const bl = blocks.filter((b) => b.page >= s && b.page < s + per);
      if (bl.length) chapters.push({ title: pageCount <= per ? title : `Pages ${offset + s + 1}–${offset + Math.min(pageCount, s + per)}`, blocks: bl });
    }
  }
  return chapters.length ? chapters : [{ title, blocks: [{ t: 'p', text: '(No extractable text found.)' }] }];
}

// contents list with one level of sub-entries -> nested <ol> for nav.xhtml, nested <navPoint> for toc.ncx
function navHtml(toc) {
  let h = '<ol>', li = false, sub = false;
  const closeLi = () => { if (sub) { h += '</ol>'; sub = false; } if (li) { h += '</li>'; li = false; } };
  for (const t of toc) {
    if (t.level === 1 && li) { if (!sub) { h += '<ol>'; sub = true; } h += `<li><a href="${t.href}">${esc(t.title)}</a></li>`; }
    else { closeLi(); h += `<li><a href="${t.href}">${esc(t.title)}</a>`; li = true; }
  }
  closeLi();
  return h + '</ol>';
}
function ncxPoints(toc) {
  let n = 0, h = '', li = false;
  const pt = (t) => `<navPoint id="n${++n}" playOrder="${n}"><navLabel><text>${esc(t.title)}</text></navLabel><content src="${t.href}"/>`;
  for (const t of toc) {
    if (t.level === 1 && li) h += pt(t) + '</navPoint>';
    else { if (li) h += '</navPoint>'; h += pt(t); li = true; }
  }
  return h + (li ? '</navPoint>' : '');
}

/* ---------- quick look at a PDF to recommend settings ---------- */
export async function profilePdf(pdf) {
  const n = pdf.numPages, k = Math.min(4, n), picks = [...new Set(Array.from({ length: k }, (_, i) => 1 + Math.floor((i + 0.5) * n / k)))];
  let chars = 0, lines = 0, flagged = 0, regions = 0, columns = 0, pics = 0;
  for (const i of picks) {
    const pg = await pdf.getPage(i);
    const ls = await extractLines(pg).catch(() => []);
    chars += ls.reduce((t, l) => t + l.text.length, 0); lines += ls.length;
    flagged += ls.filter((l) => isMathLine(l) || isTableLine(l)).length; regions += findRegions(ls).boxes.length;
    if (ls.some((l) => l.col)) columns++;
    if ((await imageBoxes(pg).catch(() => [])).length) pics++;
  }
  const outline = usableOutline(await readOutline(pdf, 1, n)).filter((e) => e.level === 0).length;
  return { pages: n, scanned: chars < 25 * picks.length, formulas: lines > 0 && (flagged / lines > 0.1 || regions / picks.length >= 4), columns: columns > 0, pictures: pics >= Math.max(2, picks.length - 1), outline };
}

/* ---------- invisible text over page pictures (search, select, dictionary) ---------- */
const mctx = document.createElement('canvas').getContext('2d');
const xmlSafe = (t) => t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '');
// items: { t, x, base, fs, w } in pixels of a W x H picture -> spans { t, l, tp (percent of the picture), fs (vw), sx (horizontal stretch) }
function layerSpans(items, W, H) {
  const out = []; mctx.font = '100px serif';
  const fm = mctx.measureText('Hg'), asc = (fm.fontBoundingBoxAscent || 89) / 100, off = (1 - (asc + (fm.fontBoundingBoxDescent || 22) / 100)) / 2 + asc; // where the baseline sits in a line-height:1 box
  for (const it of items) {
    const txt = xmlSafe(it.t); if (!txt.trim() || it.fs < 2) continue;
    let sx = 1; const m = mctx.measureText(txt).width * it.fs / 100;
    if (m > 0 && it.w > 0) { sx = it.w / m; if (!isFinite(sx) || sx < 0.3 || sx > 3) sx = 1; }
    out.push({ t: txt.endsWith(' ') ? txt : txt + ' ', l: +(it.x / W * 100).toFixed(2), tp: +((it.base - it.fs * off) / H * 100).toFixed(2), fs: +(it.fs / W * 100).toFixed(2), sx: Math.abs(sx - 1) > 0.02 ? +sx.toFixed(3) : 1 });
  }
  return out;
}
const spansHtml = (spans) => (spans.length ? `<div class="tl">${spans.map((o) => `<span style="left:${o.l}%;top:${o.tp}%;font-size:${o.fs}vw${o.sx !== 1 ? `;transform:scaleX(${o.sx})` : ''}">${esc(o.t)}</span>`).join('')}</div>` : '');
// text pieces of a page in pixels of a picture `W` wide
async function pageItemsPx(page, W) {
  if (page.rotate) return [];
  let tc; try { tc = await page.getTextContent(); } catch { return []; }
  const [vx0, , vx1, vy1] = page.view, s = W / (vx1 - vx0);
  return tc.items.filter((i) => i.str && i.str.trim()).map((i) => ({ t: i.str, x: (i.transform[4] - vx0) * s, base: (vy1 - i.transform[5]) * s, fs: (Math.hypot(i.transform[0], i.transform[1]) || i.height) * s, w: i.width * s }));
}

/* ---------- EPUB packaging ---------- */
const XHTML = (title, body, extra = '') => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
<head><meta charset="utf-8"/><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/>${extra}</head>
<body${body.startsWith('<div class="fx"') ? ' class="fxb"' : ''}>${body}</body></html>`;

const CSS = `body{font-family:serif;line-height:1.5;margin:0 .6em}h1{font-size:1.6em;margin:1.2em 0 .6em}h2{font-size:1.25em;margin:1em 0 .4em}
p{margin:0 0 .8em;text-align:justify}.center{text-align:center}.fig{text-align:center;margin:1em 0}.fig img{max-width:100%;height:auto}.fig.chap{margin:2.5em 0 1.5em}.fig.eq{margin:.7em 0}.page{margin:0;padding:0;text-align:center}.page img{max-width:100%;max-height:100%}
html,body.fxb{margin:0;padding:0;height:100%}.fx{margin:0;padding:0;width:100%;height:100vh;display:flex;align-items:center;justify-content:center;background:#fff}
.fx img{display:block;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain}
.pg{position:relative;width:100%}.pg img{width:100%;height:auto}.tl{position:absolute;left:0;top:0;right:0;bottom:0;overflow:hidden}.tl span{position:absolute;white-space:pre;color:transparent;line-height:1;transform-origin:0 0;font-family:serif}
ul,ol{margin:0 0 .8em;padding-left:1.6em}li{margin:0 0 .3em;text-align:left}`;

function uuid() { return 'urn:uuid:' + (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())); }

export async function convert(file, { title, author, mode, fit = false, aspect = 0.5, zoom = 1.5, from = 1, to = 0, ocr: opts_ocr = null, keepMath = true }, onProgress = () => {}) {
  const { pdf } = await openPdf(file);
  const total = pdf.numPages;
  const first = Math.min(total, Math.max(1, from | 0 || 1)), last = Math.min(total, Math.max(first, to | 0 || total));
  const n = last - first + 1; // pages converted
  const outline = usableOutline(await readOutline(pdf, first, last));
  const cover = await renderPage(await pdf.getPage(first), 1.2, 0.8);
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file('OEBPS/style.css', CSS);
  zip.file('OEBPS/cover.jpg', cover.blob);

  const id = uuid();
  const result = { mode, title, author, pageCount: n, blocks: null, pageImages: null, coverBlob: cover.blob, outline: outline.filter((e) => e.level === 0).length };
  let manifest = '', spine = '', toc = [];
  const fixed = mode === 'fixed';

  if (fixed) {
    result.pageImages = [];
    result.pageTexts = [];
    const add = (img, label, tocTitle, spans = []) => {
      const name = `p${String(result.pageImages.length + 1).padStart(4, '0')}`;
      zip.file(`OEBPS/${name}.jpg`, img.blob);
      if (spans.length) result.hasTextLayer = true;
      result.pageTexts.push(spans);
      zip.file(`OEBPS/${name}.xhtml`, XHTML(label, `<div class="fx"><div class="pg"><img src="${name}.jpg" alt="${esc(label)}" style="width:100%;height:auto"/>${spansHtml(spans)}</div></div>`, `<meta name="viewport" content="width=${img.w}, height=${img.h}"/>`));
      manifest += `<item id="${name}" href="${name}.xhtml" media-type="application/xhtml+xml"/><item id="${name}i" href="${name}.jpg" media-type="image/jpeg"/>`;
      spine += `<itemref idref="${name}"/>`;
      if (tocTitle) toc.push({ href: `${name}.xhtml`, title: tocTitle });
      result.pageImages.push(img.blob);
    };
    if (fit) {
      result.skipFirst = false;
      const Wc = 1100, split = zoom > 1;
      let emitted = 0;
      const starts = [];
      const strip = makeStripper(aspect, Wc, (img) => { emitted++; add(img, `Part ${emitted}`, null, layerSpans(img.texts || [], img.w, img.h)); });
      for (let k = 0; k < n; k++) {
        const pageNo = first + k;
        onProgress((k + 1) / n * 0.95, `Fitting page ${pageNo} (${k + 1} of ${n}) to screen`);
        const pg = await pdf.getPage(pageNo);
        const big = await renderCanvas(pg, Math.round(Wc * (split ? 2.1 : 1) * 1.3));
        const a = analyze(big), plan = planSegments(a, split), titems = plan ? await pageItemsPx(pg, big.width) : [];
        if (plan) {
          starts.push({ slice: emitted + 1, title: `Page ${pageNo}`, page: k });
          const f = a.f, pad = Math.round(5 * f), fillW = Wc * 0.97;
          const rects = plan.segs.map((sg) => {
            const sx = Math.max(0, Math.floor(sg.x0 * f) - pad), sy = Math.max(0, Math.floor(sg.y0 * f) - pad);
            return { sx, sy, sw: Math.min(big.width - sx, Math.ceil((sg.x1 + 1) * f) + pad - sx), sh: Math.min(big.height - sy, Math.ceil((sg.y1 + 1) * f) + pad - sy) };
          });
          // One text size per page: the main column (height-weighted median width, ignoring slivers) fills the
          // width; wider items (figures) shrink to fit, narrower ones (sidebars) are not blown up.
          let pageScale = fillW / ((plan.body.x1 - plan.body.x0 + 1) * f + 2 * pad);
          if (split) {
            const main = rects.filter((r) => r.sw >= big.width * 0.22).sort((p, q) => p.sw - q.sw);
            const tot = main.reduce((t, r) => t + r.sh, 0);
            let acc = 0;
            for (const r of main) { acc += r.sh; if (acc >= tot / 2) { pageScale = fillW / r.sw; break; } }
          }
          for (const r of rects) {
            const sc = Math.min(fillW / r.sw, pageScale);
            const inSeg = titems.filter((t) => { const cx = t.x + t.w / 2, cy = t.base - t.fs * 0.3; return cx >= r.sx && cx <= r.sx + r.sw && cy >= r.sy && cy <= r.sy + r.sh; });
            await strip.addSeg(big, r.sx, r.sy, r.sw, r.sh, Math.round(r.sw * sc), Math.round(r.sh * sc), inSeg);
          }
          await strip.endPage();
        }
        big.width = big.height = 0;
        await sleep0();
      }
      await strip.finish();
      const pad4 = (k) => `p${String(Math.min(k, emitted)).padStart(4, '0')}.xhtml`;
      if (outline.length) outline.forEach((e) => { const st = starts.find((t) => t.page >= e.page); if (st && emitted) toc.push({ href: pad4(st.slice), title: e.title, level: e.level }); });
      if (!toc.length) starts.forEach((t) => emitted && toc.push({ href: pad4(t.slice), title: t.title }));
    } else {
      result.skipFirst = true;
      for (let i = first; i <= last; i++) {
        onProgress((i - first + 1) / n * 0.9, `Rendering page ${i} of ${last}`);
        const pg = await pdf.getPage(i), img = i === first ? cover : await renderPage(pg, 1.6, 0.8);
        add(img, `Page ${i}`, outline.length ? null : `Page ${i}`, layerSpans(await pageItemsPx(pg, img.w), img.w, img.h));
        await sleep0();
      }
      const nm = (k) => `p${String(k + 1).padStart(4, '0')}.xhtml`;
      outline.forEach((e) => toc.push({ href: nm(Math.min(e.page, result.pageImages.length - 1)), title: e.title, level: e.level }));
    }
    if (!result.pageImages.length) { add(cover, 'Page 1', 'Page 1'); }
  } else {
    const raw = [], boxes = [], scanned = [];
    let ocr = null, ocrPages = 0;
    try {
      for (let i = first; i <= last; i++) {
        onProgress((i - first + 1) / n * 0.55, `Reading page ${i} of ${last}`);
        const pg = await pdf.getPage(i);
        let lines = await extractLines(pg), viaOcr = false;
        if (opts_ocr && lines.reduce((t, l) => t + l.text.length, 0) < 40) { // a page without a text layer: read it with OCR
          onProgress((i - first + 1) / n * 0.55, `Reading page ${i} of ${last} with OCR (${++ocrPages})`);
          ocr = ocr || await makeOcr(opts_ocr);
          lines = await ocrPageLines(ocr, pg); viaOcr = true;
        }
        raw.push(lines); scanned.push(viaOcr);
        boxes.push(viaOcr ? [] : await imageBoxes(pg).catch(() => []));
        await sleep0();
      }
    } finally { if (ocr) ocr.terminate().catch(() => {}); }
    result.ocrPages = ocrPages;

    // headers/footers/watermarks out; then (optionally) display formulas and tables become pictures
    let clean = stripHeadersFooters(raw);
    const regionBoxes = clean.map(() => []);
    if (keepMath) {
      let total = 0;
      clean = clean.map((lines, k) => {
        if (scanned[k]) return lines;
        const r = findRegions(lines); if (total + r.boxes.length > 2500) return lines; // keep a sane EPUB size
        total += r.boxes.length; regionBoxes[k] = r.boxes; return r.keep;
      });
    }
    // decorative pictures only for text-style books: a PDF with pictures on most pages is illustrated/scanned (use Fixed pages)
    const withImg = boxes.filter((b) => b.length).length, useImgs = withImg > 0 && withImg <= Math.max(3, n * 0.5);
    const pagesImgs = boxes.map(() => []), todo = [];
    for (let k = 0; k < n; k++) { const all = [...(useImgs ? boxes[k].slice(0, 6) : []), ...regionBoxes[k]]; if (all.length) todo.push([k, all]); }
    for (const [d, [k, all]] of todo.entries()) {
      onProgress(0.55 + 0.3 * d / todo.length, `Saving pictures and formulas (${d + 1} of ${todo.length} pages)`);
      pagesImgs[k] = await cropImages(await pdf.getPage(first + k), all).catch(() => []);
      await sleep0();
    }
    onProgress(0.88, 'Building chapters…');
    const blocks = buildBlocks(clean, pagesImgs);
    result.blocks = blocks;
    result.hasText = blocks.some((b) => b.t !== 'img');
    const flat = raw.flat();
    result.messy = !keepMath && flat.length > 0 && flat.filter((l) => l.text.length <= 3).length / flat.length > 0.2;
    const chapters = chunkChapters(blocks, n, title, first - 1, outline);
    let imgN = 0;
    chapters.forEach((c, i) => {
      const name = `c${String(i + 1).padStart(3, '0')}`;
      const html = []; let list = null;
      const closeList = () => { if (list) { html.push(`</${list}>`); list = null; } };
      for (const b of c.blocks) {
        const ida = b.anchor ? ` id="${b.anchor}"` : '';
        if (b.t === 'li') {
          const tag = b.ordered ? 'ol' : 'ul';
          if (list !== tag) { closeList(); html.push(tag === 'ol' && b.n > 1 ? `<ol start="${b.n}">` : `<${tag}>`); list = tag; }
          html.push(`<li${ida}>${toHtml(b.text, b.fmt)}</li>`); continue;
        }
        closeList();
        if (b.t === 'img') {
          const f = `images/img${++imgN}.${b.mime === 'image/jpeg' ? 'jpg' : 'png'}`;
          zip.file(`OEBPS/${f}`, b.blob);
          manifest += `<item id="img${imgN}" href="${f}" media-type="${b.mime}"/>`;
          const wd = b.em ? `${b.em.toFixed(2)}em;max-width:100%` : `${Math.max(8, Math.round(b.wf * 100))}%`;
          html.push(`<div${ida} class="fig${b.opener ? ' chap' : ''}${b.region ? ' eq' : ''}"><img src="${f}" alt="${esc(b.title || (b.region ? 'formula or table' : ''))}" style="width:${wd}"/></div>`);
        } else if (b.t === 'p') html.push(`<p${ida}${b.align === 'center' ? ' class="center"' : ''}>${toHtml(b.text, b.fmt)}</p>`);
        else html.push(`<${b.t}${ida}>${esc(b.text)}</${b.t}>`);
      }
      closeList();
      const body = html.join('\n');
      zip.file(`OEBPS/${name}.xhtml`, XHTML(c.title, body));
      manifest += `<item id="${name}" href="${name}.xhtml" media-type="application/xhtml+xml"/>`;
      spine += `<itemref idref="${name}"/>`;
      toc.push({ href: `${name}.xhtml`, title: c.title, level: 0 });
      for (const sb of c.subs || []) toc.push({ href: `${name}.xhtml#${sb.anchor}`, title: sb.title, level: 1 });
    });
  }

  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><meta charset="utf-8"/><title>Contents</title></head>
<body><nav epub:type="toc" id="toc"><h1>Contents</h1>${navHtml(toc)}</nav></body></html>`);
  zip.file('OEBPS/toc.ncx', `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${id}"/></head><docTitle><text>${esc(title)}</text></docTitle>
<navMap>${ncxPoints(toc)}</navMap></ncx>`);
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">${id}</dc:identifier><dc:title>${esc(title)}</dc:title><dc:creator>${esc(author || 'Unknown')}</dc:creator><dc:language>en</dc:language>
<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
<meta name="cover" content="cover-img"/>${fixed ? '<meta property="rendition:layout">pre-paginated</meta><meta property="rendition:spread">none</meta><meta property="rendition:orientation">auto</meta>' : ''}
</metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="style.css" media-type="text/css"/><item id="cover-img" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>${manifest}</manifest>
<spine toc="ncx">${spine}</spine></package>`);

  onProgress(0.95, 'Packing EPUB…');
  result.epub = await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE' }, (m) => onProgress(0.95 + m.percent / 2000, 'Packing EPUB…'));
  onProgress(1, 'Done');
  return result;
}
