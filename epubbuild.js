// HTML/DOM -> EPUB 3 (with NCX fallback). Images given as data: URIs are extracted into the package.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const XML_BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;
const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

export async function buildEpub(body, { title = 'Untitled', author = '', lang = 'en' } = {}) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/style.css', 'body{font-family:serif;line-height:1.5;margin:0 .6em}h1{font-size:1.6em;margin:1.2em 0 .6em}h2{font-size:1.3em}p{margin:0 0 .8em;text-align:justify}img{max-width:100%;height:auto}pre{white-space:pre-wrap;background:#f3f3f3;padding:.5em}table{border-collapse:collapse}td,th{border:1px solid #999;padding:.2em .4em}blockquote{margin-left:1.2em;border-left:3px solid #bbb;padding-left:.8em}');

  // unwrap single-wrapper documents, pull images into files
  const root = body.cloneNode(true);
  while (root.children.length === 1 && /^(DIV|SECTION|ARTICLE|MAIN)$/.test(root.children[0].tagName)) { const only = root.children[0]; while (root.firstChild) root.removeChild(root.firstChild); while (only.firstChild) root.appendChild(only.firstChild); }
  let imgN = 0, manifestImgs = '';
  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '', m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src);
    if (m && EXT[m[1]]) {
      const name = `images/img${++imgN}.${EXT[m[1]]}`;
      zip.file('OEBPS/' + name, m[2] ? m[3] : decodeURIComponent(m[3]), { base64: !!m[2] });
      manifestImgs += `<item id="img${imgN}" href="${name}" media-type="${m[1] === 'image/jpg' ? 'image/jpeg' : m[1]}"/>`;
      img.setAttribute('src', name); if (!img.getAttribute('alt')) img.setAttribute('alt', '');
    } else { const alt = img.getAttribute('alt'); const span = root.ownerDocument.createElement('em'); span.textContent = alt ? `[${alt}]` : ''; img.replaceWith(span); }
  }
  root.querySelectorAll('[style],[class],[id]').forEach((n) => { n.removeAttribute('style'); n.removeAttribute('class'); });

  // chapters: split on the heading level (h1, else h2) that appears at least twice
  const kids = [...root.childNodes].filter((n) => n.nodeType === 1 || (n.nodeType === 3 && n.nodeValue.trim()));
  const count = (tag) => kids.filter((n) => n.tagName === tag).length;
  const splitTag = count('H1') >= 2 ? 'H1' : count('H2') >= 2 ? 'H2' : null;
  const chapters = []; let cur = null;
  for (const n of kids) {
    if (splitTag && n.tagName === splitTag) { cur = { title: n.textContent.trim() || `Part ${chapters.length + 1}`, nodes: [n] }; chapters.push(cur); }
    else { if (!cur) { cur = { title, nodes: [] }; chapters.push(cur); } cur.nodes.push(n); }
  }
  if (!chapters.length) chapters.push({ title, nodes: [] });

  const ser = new XMLSerializer();
  let manifest = '', spine = '', toc = [];
  chapters.forEach((c, i) => {
    const name = `c${String(i + 1).padStart(3, '0')}.xhtml`;
    const inner = c.nodes.map((n) => (n.nodeType === 3 ? `<p>${esc(n.nodeValue.trim())}</p>` : ser.serializeToString(n))).join('\n') || '<p></p>';
    zip.file('OEBPS/' + name, `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}" lang="${lang}"><head><meta charset="utf-8"/><title>${esc(c.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${inner.replace(XML_BAD, '')}</body></html>`);
    manifest += `<item id="c${i + 1}" href="${name}" media-type="application/xhtml+xml"/>`; spine += `<itemref idref="c${i + 1}"/>`; toc.push({ href: name, title: c.title });
  });
  const id = 'urn:uuid:' + (crypto.randomUUID ? crypto.randomUUID() : Date.now());
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><meta charset="utf-8"/><title>Contents</title></head><body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${toc.map((t) => `<li><a href="${t.href}">${esc(t.title)}</a></li>`).join('')}</ol></nav></body></html>`);
  zip.file('OEBPS/toc.ncx', `<?xml version="1.0" encoding="utf-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${id}"/></head><docTitle><text>${esc(title)}</text></docTitle><navMap>${toc.map((t, i) => `<navPoint id="n${i}" playOrder="${i + 1}"><navLabel><text>${esc(t.title)}</text></navLabel><content src="${t.href}"/></navPoint>`).join('')}</navMap></ncx>`);
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">${id}</dc:identifier><dc:title>${esc(title)}</dc:title><dc:creator>${esc(author || 'Unknown')}</dc:creator><dc:language>${lang}</dc:language><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css" href="style.css" media-type="text/css"/>${manifestImgs}${manifest}</manifest><spine toc="ncx">${spine}</spine></package>`);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE' });
}
