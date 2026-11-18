// "My books": converted/opened EPUBs kept on the device (IndexedDB), with reading position.
const DB = 'pdf2epub', STORE = 'books';

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); res(req && req.result); };
    t.onerror = t.onabort = () => { db.close(); rej(t.error); };
  });
}

export const bookId = (title, blob) => `${title}|${blob.size}`;
export const saveBook = (rec) => tx('readwrite', (s) => s.put(rec));
export const getBook = (id) => tx('readonly', (s) => s.get(id));
export const deleteBook = (id) => tx('readwrite', (s) => s.delete(id));
export async function listBooks() {
  try { return (await tx('readonly', (s) => s.getAll())).sort((a, b) => b.opened - a.opened); } catch { return []; }
}
export async function setProgress(id, progress) {
  const rec = await getBook(id);
  if (rec) { rec.progress = progress; rec.opened = Date.now(); await saveBook(rec); }
}
export async function renameBook(id, title) {
  const rec = await getBook(id);
  if (rec) { rec.title = title; await saveBook(rec); }
}
