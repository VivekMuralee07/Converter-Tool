// Page-turning book viewer: paginates converted content and animates 3D page flips.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class Book {
  constructor(stage, book, onChange) {
    this.stage = stage; this.el = book; this.onChange = onChange;
    this.pages = []; this.leaves = []; this.cur = 0; this.spread = 1;
    this.measure = document.createElement('div'); this.measure.className = 'measure';
    document.body.appendChild(this.measure);
    this._bind();
  }

  load(data, startFrac = 0) {
    this.data = data; this.cur = 0; this._startFrac = startFrac; this._layout();
  }

  progress() { return this.leaves.length ? this.cur / this.leaves.length : 0; }

  destroy() {
    this.measure.remove(); this.el.innerHTML = '';
    this._ac.abort(); clearTimeout(this._t);
    (this.urls || []).forEach(URL.revokeObjectURL);
  }

  _bind() {
    this._onResize = () => { clearTimeout(this._t); this._t = setTimeout(() => this.data && this._layout(), 200); };
    this._onKey = (e) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown') this.next();
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') this.prev();
    };
    this._ac = new AbortController(); const sig = { signal: this._ac.signal };
    addEventListener('resize', this._onResize, sig); addEventListener('keydown', this._onKey, sig);
    // Drag to turn: the page follows the finger, then settles forward or back on release.
    let drag = null;
    const travel = () => this.pw * (this.spread === 2 ? 1.5 : 1);
    this.stage.addEventListener('pointerdown', (e) => {
      if (drag && drag.leaf) return;
      drag = { x: e.clientX, t: performance.now(), dir: 0, leaf: null, p: 0, id: e.pointerId };
    }, sig);
    this.stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (!drag.dir) {
        if (Math.abs(dx) < 8) return;
        const dir = dx < 0 ? 1 : -1; // 1 = next page, -1 = previous page
        const st = this.status();
        if ((dir === 1 && !st.canNext) || (dir === -1 && !st.canPrev)) { drag = null; return; }
        drag.dir = dir; drag.leaf = this.leaves[dir === 1 ? this.cur : this.cur - 1];
        drag.leaf.classList.add('turning'); drag.leaf.style.transition = 'none';
        try { this.stage.setPointerCapture(drag.id); } catch { /* ignore */ }
      }
      const p = Math.max(0, Math.min(1, (drag.dir === 1 ? -dx : dx) / travel()));
      drag.p = p; drag.v = (e.clientX - (drag.lx ?? drag.x)) / Math.max(1, performance.now() - (drag.lt ?? drag.t)); drag.lx = e.clientX; drag.lt = performance.now();
      drag.leaf.style.transform = `rotateY(${drag.dir === 1 ? -180 * p : -180 + 180 * p}deg)`;
    }, sig);
    const end = (e, cancelled) => {
      const d = drag; drag = null;
      if (!d) return;
      if (!d.dir) { // a tap: left/right side turns the page
        if (cancelled) return;
        const r = this.el.getBoundingClientRect(), rel = (e.clientX - r.left) / r.width;
        return (rel > (this.spread === 2 ? 0.5 : 0.3)) ? this.next() : this.prev();
      }
      const flick = d.dir * -d.v > 0.5; // fast swipe in the turning direction
      const commit = !cancelled && (d.p > 0.3 || (flick && d.p > 0.04));
      void d.leaf.offsetWidth; // flush so the release animates from the finger position
      d.leaf.style.transition = ''; d.leaf.style.transform = '';
      if (commit) { this.cur += d.dir; }
      this._update();
      setTimeout(() => d.leaf.classList.remove('turning'), 1100); // in case no transition event fires
    };
    this.stage.addEventListener('pointerup', (e) => end(e, false), sig);
    this.stage.addEventListener('pointercancel', (e) => end(e, true), sig);
  }

  _layout() {
    const aw = this.stage.clientWidth, ah = this.stage.clientHeight;
    this.spread = aw >= 820 ? 2 : 1;
    // two-page spread: classic book proportion; single page: follow the screen shape so phones are filled
    const ratio = this.spread === 2 ? 0.72 : Math.max(0.5, Math.min(0.8, (aw - 16) / (ah - 16)));
    let ph = Math.min(ah - 16, (aw - 24) / this.spread / ratio);
    ph = Math.max(280, Math.floor(ph));
    const pw = Math.floor(ph * ratio);
    this.ph = ph; this.pw = pw;
    const s = this.el.style;
    s.setProperty('--pw', pw + 'px'); s.setProperty('--ph', ph + 'px'); s.setProperty('--spread', this.spread);
    s.setProperty('--fs', Math.max(12, Math.min(19, ph * 0.027)) + 'px');
    this.el.classList.toggle('spread', this.spread === 2);

    const keepPage = this.pages.length ? this.cur * this.spread : 0;
    this.pages = this._paginate();
    const per = this.spread, count = Math.ceil(this.pages.length / per);
    this.el.innerHTML = ''; this.leaves = [];
    for (let i = 0; i < count; i++) {
      const leaf = document.createElement('div'); leaf.className = 'leaf';
      leaf.innerHTML = '<div class="face front"></div><div class="face back"></div>';
      leaf.addEventListener('transitionend', (e) => { if (e.target === leaf) leaf.classList.remove('turning'); });
      this.el.appendChild(leaf); this.leaves.push(leaf);
    }
    this.cur = Math.min(count, Math.floor(keepPage / per));
    if (this._startFrac != null) { this.cur = Math.min(Math.max(0, count - (per === 2 ? 0 : 1)), Math.round(this._startFrac * count)); this._startFrac = null; }
    this._update(true);
  }

  _paginate() {
    const d = this.data, out = [];
    // cover
    const coverUrl = d.coverBlob ? this._url(d.coverBlob) : null;
    out.push(d.pageImages && coverUrl
      ? `<div class="page cover"><img src="${coverUrl}" alt="Cover"></div>`
      : `<div class="page cover"><h1>${esc(d.title)}</h1><p>${esc(d.author || '')}</p></div>`);
    if (d.pageImages) {
      d.pageImages.forEach((b, i) => { if (i === 0 && d.skipFirst) return; out.push(`<div class="page imgpage"><img src="${this._url(b)}" alt="Page ${i + 1}"></div>`); });
      return out;
    }
    const m = this.measure; m.innerHTML = '';
    m.style.cssText = `width:${this.pw}px;height:${this.ph}px;--pw:${this.pw}px;--ph:${this.ph}px;--fs:${this.el.style.getPropertyValue('--fs')}`;
    const mk = () => { const p = document.createElement('div'); p.className = 'page'; p.style.position = 'relative'; p.style.height = this.ph + 'px'; m.appendChild(p); return p; };
    const overflows = (p) => p.scrollHeight > p.clientHeight + 1;
    let page = mk(), pageNo = 1;
    const flush = () => { out.push(`<div class="page">${page.innerHTML}<div class="num">${pageNo++}</div></div>`); page.remove(); page = mk(); };
    for (const b of d.blocks) {
      if (b.t === 'h1' && page.childElementCount) flush();
      let words = b.t === 'p' ? b.text.split(' ') : null;
      const tag = b.t === 'p' ? 'p' : b.t;
      let first = true;
      while (true) {
        const node = document.createElement(tag);
        node.textContent = words ? words.join(' ') : b.text;
        page.appendChild(node);
        if (!overflows(page)) break;
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
        node.textContent = words.slice(0, lo).join(' '); if (!first) node.className = 'first';
        words = words.slice(lo); first = false; flush();
        if (!words.length) break;
      }
      if (words && !first) { const last = page.lastElementChild; if (last) last.className = 'first'; }
    }
    if (page.childElementCount) flush();
    m.innerHTML = '';
    return out;
  }

  _url(blob) { const u = URL.createObjectURL(blob); (this.urls ||= []).push(u); return u; }

  _fill(face, html) { face.innerHTML = html || '<div class="page blank"></div>'; }

  _update(instant) {
    const n = this.leaves.length, per = this.spread;
    this.leaves.forEach((leaf, i) => {
      const flipped = i < this.cur, near = Math.abs(i - this.cur) <= 2;
      const was = leaf.classList.contains('flipped');
      if (was !== flipped && !instant) leaf.classList.add('turning');
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
    const total = this.pages.length - 1, per = this.spread, c = this.cur;
    let label = 'Cover';
    if (c > 0 && per === 2) { const l = 2 * c - 1, r = Math.min(2 * c, total); label = l >= r ? `Page ${l}` : `Pages ${l}–${r}`; }
    else if (c > 0) label = `Page ${c}`;
    return { label: `${label} · ${total} pages`, canPrev: c > 0, canNext: c < this.leaves.length - (per === 2 ? 0 : 1) };
  }

  next() { if (this.status().canNext) { this.cur++; this._update(); } }
  prev() { if (this.cur > 0) { this.cur--; this._update(); } }
}
