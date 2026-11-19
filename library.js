// "My books": books kept on the device (IndexedDB). Two stores so that small, frequent updates
// (reading position, bookmarks, notes) never rewrite the big book file:
//   books  -> details { id, title, author, kind, cover, progress, collection, bookmarks, highlights, ... }
//   files  -> the book file itself (Blob), keyed by the same id
const DB = 'pdf2epub', META = 'books', FILES = 'files';

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = (ev) => {
      const db = r.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
      if (ev.oldVersion === 1) { // v1 kept the file inside the details record: move it to its own store
        const t = r.transaction, books = t.objectStore(META), files = t.objectStore(FILES);
        books.openCursor().onsuccess = (e) => {
          const c = e.target.result; if (!c) return;
          const rec = c.value;
          if (rec.blob) { files.put(rec.blob, rec.id); const { blob, ...rest } = rec; c.update({ kind: 'epub', ...rest }); }
          c.continue();
        };
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(stores, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(stores, mode);
    const out = fn(...stores.map((s) => t.objectStore(s)));
    t.oncomplete = () => { db.close(); res(out && out.result); };
    t.onerror = t.onabort = () => { db.close(); rej(t.error); };
  });
}

export const bookId = (title, blob) => `${title}|${blob.size}`;
export const saveBook = (rec) => { const { blob, ...meta } = rec; return tx([META, FILES], 'readwrite', (m, f) => { if (blob) f.put(blob, meta.id); return m.put(meta); }); };
export const getBook = (id) => tx([META], 'readonly', (m) => m.get(id));
export const getBlob = (id) => tx([FILES], 'readonly', (f) => f.get(id));
export const deleteBook = (id) => tx([META, FILES], 'readwrite', (m, f) => { f.delete(id); return m.delete(id); });
export async function listBooks() {
  try { return (await tx([META], 'readonly', (m) => m.getAll())).sort((a, b) => (b.opened || 0) - (a.opened || 0)); } catch { return []; }
}
export async function updateBook(id, patch) {
  const rec = await getBook(id);
  if (!rec) return null;
  const next = typeof patch === 'function' ? (patch(rec) || rec) : Object.assign(rec, patch);
  await tx([META], 'readwrite', (m) => m.put(next));
  return next;
}
export const setProgress = (id, progress) => updateBook(id, { progress, opened: Date.now() });
export const renameBook = (id, title) => updateBook(id, { title });

/* ---------- backup / restore ---------- */
const MIME = { epub: 'application/epub+zip', cbz: 'application/vnd.comicbook+zip', txt: 'text/plain', md: 'text/markdown', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', html: 'text/html' };

// One ZIP with every book file plus a manifest (titles, covers, progress, collections, bookmarks, notes).
export async function exportBackup(onProgress = () => {}) {
  const books = await listBooks(), zip = new JSZip(), manifest = { app: 'pdf2epub', version: 2, exported: Date.now(), books: [] };
  for (const [i, b] of books.entries()) {
    onProgress(i / Math.max(1, books.length), `Adding “${b.title}”`);
    const blob = await getBlob(b.id); if (!blob) continue;
    const kind = b.kind || 'epub', entry = { ...b, file: `books/${i}.${kind}` };
    delete entry.cover; zip.file(entry.file, blob);
    if (b.cover) { entry.coverFile = `covers/${i}.img`; entry.coverType = b.cover.type; zip.file(entry.coverFile, b.cover); }
    manifest.books.push(entry);
  }
  zip.file('manifest.json', JSON.stringify(manifest));
  return zip.generateAsync({ type: 'blob', compression: 'STORE' }, (m) => onProgress(0.9 + m.percent / 1000, 'Packing backup'));
}

export async function importBackup(file, onProgress = () => {}) {
  let zip; try { zip = await JSZip.loadAsync(file); } catch { throw new Error('This is not a backup file made by this app.'); }
  const mf = zip.file('manifest.json'); if (!mf) throw new Error('This is not a backup file made by this app.');
  const manifest = JSON.parse(await mf.async('string')); let added = 0, merged = 0;
  for (const [i, e] of (manifest.books || []).entries()) {
    onProgress(i / manifest.books.length, `Restoring “${e.title}”`);
    const { file: path, coverFile, coverType, ...meta } = e, entry = zip.file(path); if (!entry) continue;
    const kind = meta.kind || 'epub', blob = new Blob([await entry.async('arraybuffer')], { type: MIME[kind] || 'application/octet-stream' });
    if (coverFile && zip.file(coverFile)) meta.cover = new Blob([await zip.file(coverFile).async('arraybuffer')], { type: coverType || 'image/jpeg' });
    const old = await getBook(meta.id);
    if (!old) { await saveBook({ ...meta, blob }); added++; continue; }
    // already here: keep the furthest progress and merge bookmarks / notes by id
    const byId = (a = [], b = []) => [...new Map([...a, ...b].map((x) => [x.id, x])).values()];
    await updateBook(meta.id, (r) => { r.progress = Math.max(r.progress || 0, meta.progress || 0); r.bookmarks = byId(r.bookmarks, meta.bookmarks); r.highlights = byId(r.highlights, meta.highlights); r.collection = r.collection || meta.collection; });
    merged++;
  }
  return { added, merged };
}
