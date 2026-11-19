// Lazy loader for the classic-script libraries (each tool only loads what it needs; the service worker caches them).
const loaded = new Map();

export function loadScript(src) {
  if (!loaded.has(src)) {
    loaded.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve;
      s.onerror = () => { loaded.delete(src); reject(new Error('Could not load ' + src + ' (are you offline before first use?)')); };
      document.head.appendChild(s);
    }));
  }
  return loaded.get(src);
}

export const LIBS = {
  pdflib: async () => { await loadScript('lib/pdf-lib.min.js'); return window.PDFLib; },
  mammoth: async () => { await loadScript('lib/mammoth.browser.min.js'); return window.mammoth; },
  marked: async () => { await loadScript('lib/marked.min.js'); return window.marked; },
  xlsx: async () => { await loadScript('lib/xlsx.mini.min.js'); return window.XLSX; },
};
