// Page-turning book viewer: paginates converted content and animates 3D page flips.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class Book {
  // opts: { margin: px kept free around the book, onCenterTap: called when the middle of the page is tapped }
  constructor(stage, book, onChange, opts = {}) {
    this.opts = opts; this.stage = stage; this.el = book; this.onChange = onChange;
    this.pages = []; this.leaves = []; this.cur = 0; this.spread = 1;
    this.measure = document.createElement('div'); this.measure.className = 'measure';
    document.body.appendChild(this.measure);
    this._bind();
  }

  load(data, startFrac = 0) {
    this.data = data; this.cur = 0; this._startFrac = startFrac; this._layout();
  }

  _maxCur() { return Math.max(1, this.leaves.length - (this.spread === 2 ? 0 : 1)); }
  progress() { return this.leaves.length ? Math.min(1, this.cur / this._maxCur()) : 0; }
  goTo(frac) { // jump (no animation) to a position 0..1
    if (this.busy || !this.leaves.length) return;
    this.cur = Math.max(0, Math.min(this._maxCur(), Math.round(frac * this._maxCur())));
    this._update(true);
  }

  destroy() {
    this.measure.remove(); this.el.innerHTML = '';
    this._ac.abort(); clearTimeout(this._t); cancelAnimationFrame(this.raf);
    (this.urls || []).forEach(URL.revokeObjectURL);
    if (this._lazy) this._lazy.forEach((p) => p.then((u) => u && URL.revokeObjectURL(u)));
  }

  _bind() {
    this._onResize = () => { clearTimeout(this._t); this._t = setTimeout(() => this.data && this._layout(), 200); };
    this._onKey = (e) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown') this.next();
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') this.prev();
    };
    this._ac = new AbortController(); const sig = { signal: this._ac.signal };
    addEventListener('resize', this._onResize, sig); addEventListener('keydown', this._onKey, sig);
    // Drag to turn: the page corner follows the finger and the paper folds along a diagonal line.
    let drag = null;
    this.stage.addEventListener('pointerdown', (e) => {
      if (this.busy) return;
      drag = { x: e.clientX, y: e.clientY, dir: 0, id: e.pointerId, v: 0, lx: e.clientX, lt: performance.now() };
    }, sig);
    this.stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (!drag.dir) {
        if (Math.abs(dx) < 8) return;
        const dir = dx < 0 ? 1 : -1; // 1 = next page, -1 = previous page
        if (this.opts.turnStyle && this.opts.turnStyle !== 'curl') { if (Math.abs(dx) > 30) drag.swipe = dir; return; } // slide / no animation: a swipe just turns the page
        const st = this.status();
        if ((dir === 1 && !st.canNext) || (dir === -1 && !st.canPrev)) { drag = null; return; }
        const r = this.el.getBoundingClientRect();
        const cy = (e.clientY - r.top) > this.ph / 2 ? this.ph : 0; // grab the nearest corner
        drag.dir = dir; drag.cy = cy; drag.x = e.clientX; drag.y = e.clientY;
        drag.P0 = { x: dir === 1 ? this.pw : -this.pw, y: cy };
        this._startFold(dir === 1 ? this.cur : this.cur - 1, cy);
        try { this.stage.setPointerCapture(drag.id); } catch { /* ignore */ }
      }
      const now = performance.now();
      drag.v = (e.clientX - drag.lx) / Math.max(1, now - drag.lt); drag.lx = e.clientX; drag.lt = now;
      drag.P = { x: Math.max(-this.pw, Math.min(this.pw, drag.P0.x + (e.clientX - drag.x))), y: drag.P0.y + (e.clientY - drag.y) * 0.8 };
      this._foldPos(drag.P);
    }, sig);
    const end = (e, cancelled) => {
      const d = drag; drag = null;
      if (!d) return;
      if (!d.dir) { // a tap (or a swipe when the page curl is switched off)
        if (cancelled) return;
        if (d.swipe) return d.swipe === 1 ? this.next() : this.prev();
        const sel = getSelection(); if (sel && !sel.isCollapsed) { sel.removeAllRanges(); return; } // a tap just clears a selection
        const hit = document.elementFromPoint(e.clientX, e.clientY), mk = hit && hit.closest && hit.closest('mark.hl[data-h]');
        if (mk && this.opts.onHighlightTap) return this.opts.onHighlightTap(mk.dataset.h);
        const r = this.el.getBoundingClientRect(), rel = (e.clientX - r.left) / r.width;
        if (this.opts.onCenterTap && rel > 0.3 && rel < 0.7) return this.opts.onCenterTap();
        if (this.opts.onCenterTap) return rel >= 0.7 ? this.next() : this.prev();
        return (rel > (this.spread === 2 ? 0.5 : 0.3)) ? this.next() : this.prev();
      }
      const w = this.pw, s = (w - d.P.x) / (2 * w); // 0 = page flat on the right, 1 = fully turned
      const flick = Math.abs(d.v) > 0.5;
      const turned = d.dir === 1 ? (!cancelled && (s > 0.35 || (flick && d.v < 0 && s > 0.05))) : (cancelled || !(s < 0.65 || (flick && d.v > 0 && s < 0.95)));
      const to = { x: turned ? -w : w, y: d.cy };
      this._animate(d.P, to, 160 + 320 * Math.abs(to.x - d.P.x) / (2 * w), 0, () => this._finishFold(d.dir, d.dir === 1 ? turned : !turned));
    };
    this.stage.addEventListener('pointerup', (e) => end(e, false), sig);
    this.stage.addEventListener('pointercancel', (e) => end(e, true), sig);
  }

  /* ---------- page fold (paper curl) ---------- */
  // Geometry: page-local coordinates with the spine at x = 0, page = [0,w] x [0,h]. The grabbed corner C = (w, cy)
  // follows P. The fold is the perpendicular bisector of C-P; the part of the page on C's side is mirrored across it.
  _startFold(L, cy) {
    const w = this.pw, h = this.ph, per = this.spread, leaf = this.leaves[L];
    this.busy = true;
    const el = document.createElement('div'); el.className = 'fold';
    el.style.cssText = `left:${w * (per - 1) - w}px;top:0;width:${2 * w}px;height:${h}px`;
    el.innerHTML = '<div class="f-under"></div><div class="f-flat fpage"></div><div class="f-flapout"><div class="f-flapclip"><div class="f-flap fpage"></div><div class="f-flapshade"></div></div></div>';
    const blank = '<div class="page blank"></div>';
    el.querySelector('.f-flat').innerHTML = this.pages[L * per] || blank;
    el.querySelector('.f-flap').innerHTML = per === 2 ? (this.pages[L * per + 1] || blank) : blank;
    this._hydrate(el); this._decorate(el);
    this.el.appendChild(el);
    leaf.style.visibility = 'hidden';
    this.fold = { el, L, cy, leaf, under: el.querySelector('.f-under'), flat: el.querySelector('.f-flat'), clip: el.querySelector('.f-flapclip'), flap: el.querySelector('.f-flap'), shade: el.querySelector('.f-flapshade') };
    this._foldPos({ x: L === this.cur ? w : -w, y: cy });
  }

  _foldPos(P) {
    const f = this.fold; if (!f) return;
    const w = this.pw, h = this.ph, cy = f.cy;
    let px = P.x, py = Math.max(-h * 0.25, Math.min(h * 1.25, P.y));
    const dist = Math.hypot(px, py - cy);
    if (dist > w) { px = px * w / dist; py = cy + (py - cy) * w / dist; } // paper can't stretch
    if (Math.hypot(px - w, py - cy) < 1) px = w - 1;
    const vx = px - w, vy = py - cy, len = Math.hypot(vx, vy), n = { x: vx / len, y: vy / len };
    const M = { x: (w + px) / 2, y: (cy + py) / 2 };
    const rect = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
    const side = (X) => (X.x - M.x) * n.x + (X.y - M.y) * n.y;
    const clip = (poly, sg) => {
      const out = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length], da = sg * side(a), db = sg * side(b);
        if (da >= 0) out.push(a);
        if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); }
      }
      return out;
    };
    const reflect = (X) => { const d = side(X); return { x: X.x - 2 * d * n.x, y: X.y - 2 * d * n.y }; };
    const poly = (pts, dx) => (pts.length < 3 ? 'inset(100%)' : `polygon(${pts.map((p) => `${(p.x + dx).toFixed(1)}px ${p.y.toFixed(1)}px`).join(',')})`);
    const flatPoly = clip(rect, 1), cSide = clip(rect, -1), flapPoly = cSide.map(reflect);
    f.flat.style.clipPath = poly(flatPoly, 0);
    f.under.style.clipPath = poly(cSide, w);
    f.clip.style.clipPath = poly(flapPoly, w);
    // back of the page: mirror the (natural) back content, then reflect it across the fold -> one affine matrix
    const mn = M.x * n.x + M.y * n.y;
    f.flap.style.transform = `matrix(${2 * n.x * n.x - 1},${2 * n.x * n.y},${-2 * n.x * n.y},${1 - 2 * n.y * n.y},${w * (1 - 2 * n.x * n.x) + 2 * mn * n.x + w},${-2 * w * n.x * n.y + 2 * mn * n.y})`;
    // shading: shadow cast on the page underneath, light/shadow bands on the folded back
    const grad = (d, stops) => {
      const ang = Math.atan2(d.x, -d.y), L = Math.abs(2 * w * Math.sin(ang)) + Math.abs(h * Math.cos(ang));
      const base = (M.x + w - w) * d.x + (M.y - h / 2) * d.y + L / 2;
      return `linear-gradient(${(ang * 180 / Math.PI).toFixed(2)}deg,${stops.map(([dd, c]) => `${c} ${((base + dd) / L * 100).toFixed(2)}%`).join(',')})`;
    };
    f.under.style.background = grad({ x: -n.x, y: -n.y }, [[0, 'rgba(0,0,0,.45)'], [w * 0.1, 'rgba(0,0,0,.2)'], [w * 0.32, 'rgba(0,0,0,0)']]);
    f.shade.style.background = grad(n, [[0, 'rgba(0,0,0,.3)'], [w * 0.05, 'rgba(255,255,255,.2)'], [w * 0.35, 'rgba(0,0,0,.05)'], [w * 2, 'rgba(0,0,0,.16)']]);
  }

  _animate(from, to, ms, lift, done) {
    const cy = this.fold.cy, sg = cy ? 1 : -1, t0 = performance.now();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) ms = 1;
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms), e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      this._foldPos({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e - sg * lift * Math.sin(Math.PI * e) });
      if (t < 1) this.raf = requestAnimationFrame(step); else done();
    };
    this.raf = requestAnimationFrame(step);
  }

  _finishFold(dir, commit) {
    const f = this.fold; if (!f) return;
    cancelAnimationFrame(this.raf);
    f.el.remove(); f.leaf.style.visibility = ''; this.fold = null;
    if (commit) this.cur += dir;
    this._update(true);
    this.busy = false;
  }

  _layout() {
    const aw = this.stage.clientWidth, ah = this.stage.clientHeight;
    const fb = !!this.opts.fullBleed;
    this.spread = !fb && aw >= 820 ? 2 : 1;
    let ph, pw;
    if (fb) { ph = ah; pw = Math.min(aw, this.opts.maxWidth || 760); } // edge-to-edge page (centred column on wide screens)
    else {
      // two-page spread: classic book proportion; single page: follow the screen shape so phones are filled
      const m = this.opts.margin ?? 16;
      const ratio = this.spread === 2 ? 0.72 : Math.max(0.5, Math.min(0.8, (aw - m) / (ah - m)));
      ph = Math.max(280, Math.floor(Math.min(ah - m, (aw - m - 8) / this.spread / ratio)));
      pw = Math.floor(ph * ratio);
    }
    this.ph = ph; this.pw = pw;
    const s = this.el.style;
    s.setProperty('--pw', pw + 'px'); s.setProperty('--ph', ph + 'px'); s.setProperty('--spread', this.spread);
    s.setProperty('--fs', (this.opts.fontSize || Math.max(12, Math.min(19, ph * 0.027))) + 'px');
    s.setProperty('--ff', this.opts.fontFamily || 'Georgia, "Times New Roman", serif');
    s.setProperty('--lh', this.opts.lineHeight || 1.55); s.setProperty('--padx', (this.opts.padX ?? 26) + 'px');
    this.el.classList.toggle('spread', this.spread === 2);

    const keepPage = this.pages.length ? this.cur * this.spread : 0;
    this.pages = this._paginate();
    const per = this.spread, count = Math.ceil(this.pages.length / per);
    this.el.innerHTML = ''; this.leaves = [];
    for (let i = 0; i < count; i++) {
      const leaf = document.createElement('div'); leaf.className = 'leaf';
      leaf.innerHTML = '<div class="face front"></div><div class="face back"></div>';
      this.el.appendChild(leaf); this.leaves.push(leaf);
    }
    this.cur = Math.min(count, Math.floor(keepPage / per));
    if (this._startFrac != null) { this.cur = Math.min(this._maxCur(), Math.round(this._startFrac * this._maxCur())); this._startFrac = null; }
    this._update(true);
  }

  _paginate() {
    const d = this.data, out = [];
    // cover (in the full-screen reader a text book without a cover image starts straight at page 1)
    const coverUrl = d.coverBlob ? this._url(d.coverBlob) : null;
    // running title (top) and page number (bottom) for the framed preview; the full-screen reader draws its own
    const dec = (n) => (this.opts.fullBleed ? '' : `<div class="run">${esc(d.title || '')}</div><div class="num">${n}</div>`);
    this.hasCover = !this.opts.fullBleed || !!coverUrl;
    this.toc = []; this.chunks = []; // chunks: where each piece of each block ended up { b: block, o: char offset, len, page }
    if (this.hasCover) out.push(coverUrl && (d.pageImages || d.lazyImages || this.opts.fullBleed)
      ? `<div class="page cover"><img src="${coverUrl}" alt="Cover"></div>`
      : `<div class="page cover"><h1>${esc(d.title)}</h1><p>${esc(d.author || '')}</p></div>`);
    if (d.lazyImages) {
      for (let i = 0; i < d.imageCount; i++) out.push(`<div class="page imgpage"><img data-i="${i}" alt="Page ${i + 1}">${dec(out.length)}</div>`);
      return out;
    }
    if (d.pageImages) {
      d.pageImages.forEach((b, i) => { if (i === 0 && d.skipFirst) return; out.push(`<div class="page imgpage"><img src="${this._url(b)}" alt="Page ${i + 1}">${dec(out.length)}</div>`); });
      return out;
    }
    const m = this.measure; m.innerHTML = '';
    m.style.cssText = `width:${this.pw}px;height:${this.ph}px;--pw:${this.pw}px;--ph:${this.ph}px;--fs:${this.el.style.getPropertyValue('--fs')};--ff:${this.el.style.getPropertyValue('--ff')};--lh:${this.el.style.getPropertyValue('--lh')};--padx:${this.el.style.getPropertyValue('--padx')};--pad-t:calc(env(safe-area-inset-top, 0px) + 78px);--pad-b:calc(env(safe-area-inset-bottom, 0px) + 74px)`;
    const mk = () => { const p = document.createElement('div'); p.className = 'page'; p.style.position = 'relative'; p.style.height = this.ph + 'px'; m.appendChild(p); return p; };
    const overflows = (p) => p.scrollHeight > p.clientHeight + 1;
    let page = mk(), pageNo = 1; const tocRaw = [];
    const flush = () => { out.push(`<div class="page">${page.innerHTML}${dec(pageNo)}</div>`); pageNo++; page.remove(); page = mk(); };
    let chapterNo = 0, bi = -1;
    for (const b of d.blocks) {
      bi++;
      if (b.t === 'img') { // picture block (e.g. chapter number); a chapter opener always starts a fresh page
        if (b.opener) { if (page.childElementCount) flush(); tocRaw.push({ level: 1, title: b.title || `Chapter ${++chapterNo}`, page: out.length }); }
        const node = document.createElement('div'); node.className = 'blk-img' + (b.opener ? ' opener' : '');
        node.innerHTML = `<img src="${this._url(b.blob)}" alt="" style="width:${b.em ? b.em.toFixed(2) + 'em' : Math.max(8, Math.round((b.wf || 0.5) * 100)) + '%'};max-width:100%;aspect-ratio:${b.pw || 1}/${b.ph || 1}">`;
        page.appendChild(node);
        if (overflows(page) && page.childElementCount > 1) { page.removeChild(node); flush(); page.appendChild(node); }
        this.chunks.push({ b: bi, o: 0, len: 0, page: out.length });
        continue;
      }
      if (b.t === 'h1' && page.childElementCount) flush();
      if (b.t === 'h1' || b.t === 'h2') tocRaw.push({ level: b.t === 'h1' ? 1 : 2, title: b.text.slice(0, 90), page: out.length });
      let words = b.t === 'p' ? b.text.split(' ') : null;
      const tag = b.t === 'p' ? 'p' : b.t;
      let first = true, off = 0;
      while (true) {
        const node = document.createElement(tag);
        if (b.align === 'center') node.classList.add('center');
        node.textContent = words ? words.join(' ') : b.text;
        page.appendChild(node);
        if (!overflows(page)) { node.dataset.b = bi; node.dataset.o = off; this.chunks.push({ b: bi, o: off, len: node.textContent.length, page: out.length }); break; }
        if (!words) { // heading: move to next page
          page.removeChild(node);
          if (page.childElementCount) { flush(); continue; }
          break;
        }
        // paragraph overflows: find largest word prefix that fits
        let lo = 0, hi = words.length - 1;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2); node.textContent = words.slice(0, mid).join(' ');
          if (overflows(page)) hi = mid - 1; else lo = mid;
        }
        if (lo === 0) { page.removeChild(node); if (page.childElementCount) { flush(); continue; } words = words.slice(1); continue; }
        node.textContent = words.slice(0, lo).join(' '); if (!first) node.classList.add('first');
        node.dataset.b = bi; node.dataset.o = off; this.chunks.push({ b: bi, o: off, len: node.textContent.length, page: out.length });
        off += node.textContent.length + 1;
        words = words.slice(lo); first = false; flush();
        if (!words.length) break;
      }
      if (words && !first) { const last = page.lastElementChild; if (last) last.classList.add('first'); }
    }
    if (page.childElementCount) flush();
    m.innerHTML = '';
    this.toc = tocRaw.filter((t) => t.level === 1).length >= 2 ? tocRaw.filter((t) => t.level === 1) : tocRaw;
    return out;
  }

  _url(blob) { const u = URL.createObjectURL(blob); (this.urls ||= []).push(u); return u; }

  _fill(face, html) { face.innerHTML = html || '<div class="page blank"></div>'; this._hydrate(face); this._decorate(face); }

  // wrap highlighted / searched-for ranges in <mark> (the stored page HTML always keeps the plain text)
  _decorate(root) {
    const hs = [...(this.opts.highlights || []), ...(this._hit ? [this._hit] : [])];
    if (!hs.length) return;
    root.querySelectorAll('[data-b]').forEach((node) => {
      const b = +node.dataset.b, o = +node.dataset.o, text = node.textContent, end = o + text.length;
      const mine = hs.filter((h) => h.b === b && h.e > o && h.s < end).sort((x, y) => x.s - y.s);
      if (!mine.length) return;
      node.textContent = ''; let pos = 0;
      for (const h of mine) {
        const s0 = Math.max(h.s - o, pos), e0 = Math.min(h.e - o, text.length);
        if (e0 <= s0) continue;
        if (s0 > pos) node.appendChild(document.createTextNode(text.slice(pos, s0)));
        const m = document.createElement('mark'); m.className = `hl hl-${h.c || 'y'}${h.note ? ' has-note' : ''}`; if (h.id) m.dataset.h = h.id; m.textContent = text.slice(s0, e0); node.appendChild(m); pos = e0;
      }
      if (pos < text.length) node.appendChild(document.createTextNode(text.slice(pos)));
    });
  }

  refreshMarks() { // call after highlights changed: redraw the pages that are on screen
    this.leaves.forEach((leaf) => { if (leaf.dataset.f) leaf.querySelectorAll('.face').forEach((face) => { face.querySelectorAll('[data-b]').forEach((n) => { n.textContent = n.textContent; }); this._decorate(face); }); });
  }

  // current text selection -> highlight ranges { b, s, e, text } (one per paragraph the selection touches)
  selectionRanges() {
    const sel = getSelection(); if (!sel || sel.isCollapsed || !sel.rangeCount) return [];
    const range = sel.getRangeAt(0), out = [];
    if (!this.el.contains(range.commonAncestorContainer)) return [];
    this.el.querySelectorAll('.face [data-b]').forEach((node) => {
      if (!range.intersectsNode(node)) return;
      const off = (container, offset) => { const r = document.createRange(); r.selectNodeContents(node); r.setEnd(container, offset); return r.toString().length; };
      const len = node.textContent.length;
      const s = node.contains(range.startContainer) ? off(range.startContainer, range.startOffset) : 0;
      const e = node.contains(range.endContainer) ? off(range.endContainer, range.endOffset) : len;
      if (e > s) out.push({ b: +node.dataset.b, s: +node.dataset.o + s, e: +node.dataset.o + e, text: node.textContent.slice(s, e) });
    });
    return out;
  }

  /* ---------- positions (stable across font changes) ---------- */
  currentPage() { return this.cur; }
  pageOfAnchor(a) {
    if (!a) return 0;
    if (a.p !== undefined) return Math.min(a.p, this.pages.length - 1);
    const cs = (this.chunks || []).filter((c) => c.b === a.b);
    if (!cs.length) return 0;
    return (cs.find((c) => a.o >= c.o && a.o <= c.o + c.len) || cs[cs.length - 1]).page;
  }
  anchorOfPage(i) {
    const c = (this.chunks || []).find((x) => x.page === i);
    return c ? { b: c.b, o: c.o } : { p: i };
  }
  pageText(i) {
    const tmp = document.createElement('div'); tmp.innerHTML = this.pages[i] || '';
    return [...tmp.querySelectorAll('[data-b]')].map((n) => n.textContent).join('\n');
  }
  hitAt(h) { // flash a search hit on the page it lives on
    this._hit = h ? { ...h, c: 'hit' } : null; this.refreshMarks();
  }

  // full-text search over the book's paragraphs
  search(q, max = 150) {
    const needle = q.trim().toLowerCase(), out = [];
    if (needle.length < 2 || !this.data || !this.data.blocks) return out;
    this.data.blocks.forEach((b, bi) => {
      if (!b.text) return;
      const low = b.text.toLowerCase(); let i = low.indexOf(needle);
      while (i >= 0 && out.length < max) {
        out.push({ b: bi, s: i, e: i + needle.length, page: this.pageOfAnchor({ b: bi, o: i }), snippet: (i > 40 ? '…' : '') + b.text.slice(Math.max(0, i - 40), i + needle.length + 60) + (i + needle.length + 60 < b.text.length ? '…' : ''), at: i - Math.max(0, i - 40) + (i > 40 ? 1 : 0) });
        i = low.indexOf(needle, i + needle.length);
      }
    });
    return out;
  }

  // rough reading time: ~230 words a minute
  timeLeft() {
    if (!this.data || !this.data.blocks || !this.chunks.length) return null;
    const words = (t) => (t ? t.split(/\s+/).length : 0), perPage = new Map();
    this.chunks.forEach((c) => { const b = this.data.blocks[c.b]; perPage.set(c.page, (perPage.get(c.page) || 0) + (b && b.text ? Math.round(words(b.text) * c.len / Math.max(1, b.text.length)) : 0)); });
    const upTo = (end) => { let n = 0; for (const [p, w] of perPage) if (p >= this.cur && p < end) n += w; return Math.round(n / 230); };
    const next = (this.toc || []).map((t) => t.page).filter((p) => p > this.cur)[0];
    return { book: upTo(Infinity), chapter: next !== undefined ? upTo(next) : null };
  }

  // lazy page images (EPUBs opened from a file): load the image for each <img data-i> when it is shown
  _hydrate(root) {
    if (!this.data || !this.data.lazyImages) return;
    root.querySelectorAll('img[data-i]:not([src])').forEach((img) => {
      const i = +img.dataset.i;
      this._lazy ||= new Map();
      if (!this._lazy.has(i)) {
        const p = this.data.loadImage(i).then((blob) => (blob ? URL.createObjectURL(blob) : ''));
        this._lazy.set(i, p);
        if (this._lazy.size > 40) { const k = this._lazy.keys().next().value; this._lazy.get(k).then((u) => u && URL.revokeObjectURL(u)); this._lazy.delete(k); }
      }
      this._lazy.get(i).then((u) => { if (u) img.src = u; });
    });
  }

  _update(instant) {
    const n = this.leaves.length, per = this.spread;
    this.leaves.forEach((leaf, i) => {
      const flipped = i < this.cur, near = Math.abs(i - this.cur) <= 2;
      leaf.classList.toggle('flipped', flipped);
      leaf.style.zIndex = flipped ? i : n - i;
      leaf.classList.toggle('hidden', !near);
      if (near && !leaf.dataset.f) {
        this._fill(leaf.children[0], this.pages[i * per]);
        if (per === 2) this._fill(leaf.children[1], this.pages[i * per + 1]);
        else leaf.children[1].innerHTML = '<div class="page blank"></div>';
        leaf.dataset.f = 1;
      }
      if (!near) { leaf.children[0].innerHTML = leaf.children[1].innerHTML = ''; delete leaf.dataset.f; }
    });
    this.el.classList.toggle('at-start', this.cur === 0);
    this.el.classList.toggle('at-end', this.cur === n && per === 2);
    this.onChange && this.onChange(this.status());
  }

  status() {
    const total = this.pages.length - (this.hasCover ? 1 : 0), per = this.spread, c = this.cur;
    const canPrev = c > 0, canNext = c < this.leaves.length - (per === 2 ? 0 : 1);
    if (this.opts.fullBleed) {
      const n = c + 1 - (this.hasCover ? 1 : 0);
      return { label: this.hasCover && c === 0 ? 'Cover' : `${n} of ${total}`, n, total, canPrev, canNext };
    }
    let label = 'Cover';
    if (c > 0 && per === 2) { const l = 2 * c - 1, r = Math.min(2 * c, total); label = l >= r ? `Page ${l}` : `Pages ${l}–${r}`; }
    else if (c > 0) label = `Page ${c}`;
    return { label: `${label} · ${total} pages`, canPrev, canNext };
  }

  goToPage(i) { if (this.busy || !this.leaves.length) return; this.cur = Math.max(0, Math.min(this._maxCur(), i)); this._update(true); }

  setFont({ size, family, lineHeight, padX }) { // re-paginate with new text settings, keeping the reading position
    if (size) this.opts.fontSize = size;
    if (family) this.opts.fontFamily = family;
    if (lineHeight) this.opts.lineHeight = lineHeight;
    if (padX !== undefined) this.opts.padX = padX;
    if (!this.data || this.busy) return;
    const a = this.anchorOfPage(this.cur);           // remember the exact text on screen, not just a percentage
    this._startFrac = this.progress(); this._layout();
    if (a && a.b !== undefined) this.goToPage(this.pageOfAnchor(a));
  }

  // simple slide / instant page changes (the paper curl lives in next()/prev() below)
  _slide(dir) {
    const style = this.opts.turnStyle;
    if (style === 'none' || this.spread !== 1 || matchMedia('(prefers-reduced-motion: reduce)').matches) { this.cur += dir; this._update(true); return; }
    this.busy = true;
    const ov = document.createElement('div'); ov.className = 'slide';
    ov.style.cssText = `left:0;top:0;width:${this.pw}px;height:${this.ph}px;transform:translateX(${dir === 1 ? 0 : -105}%)`;
    this._fill(ov, this.pages[dir === 1 ? this.cur : this.cur - 1]);
    this.el.appendChild(ov);
    if (dir === 1) { this.cur += 1; this._update(true); }
    void ov.offsetWidth;
    ov.style.transition = 'transform .28s ease'; ov.style.transform = `translateX(${dir === 1 ? -105 : 0}%)`;
    setTimeout(() => { if (dir === -1) { this.cur -= 1; this._update(true); } ov.remove(); this.busy = false; }, 300);
  }

  next() {
    if (this.busy || !this.status().canNext) return;
    if (this.opts.turnStyle && this.opts.turnStyle !== 'curl') return this._slide(1);
    const w = this.pw, cy = this.ph;
    this._startFold(this.cur, cy);
    this._animate({ x: w, y: cy }, { x: -w, y: cy }, 750, this.ph * 0.12, () => this._finishFold(1, true));
  }
  prev() {
    if (this.busy || this.cur <= 0) return;
    if (this.opts.turnStyle && this.opts.turnStyle !== 'curl') return this._slide(-1);
    const w = this.pw, cy = this.ph;
    this._startFold(this.cur - 1, cy);
    this._animate({ x: -w, y: cy }, { x: w, y: cy }, 750, this.ph * 0.12, () => this._finishFold(-1, true));
  }
}
