# Converter-Tool — PDF → EPUB

An installable PWA that converts PDF files to EPUB **entirely on-device** (no upload), with a
page-turning 3D book preview of the result.

- **Reflowable text** mode: extracts text, detects headings/paragraphs, strips repeated headers/footers
  and page numbers, splits into chapters, writes a valid EPUB 3 (with EPUB 2 NCX fallback).
- **Fixed pages** mode: renders every page as an image (EPUB 3 pre-paginated). Use for scanned PDFs, comics, complex layouts.
- Book preview: two-page spread on wide screens, single page on phones; tap edges, swipe, or use ← → keys.
- Offline-capable (service worker), installable, registers as a handler for `.pdf` files where supported.
- Libraries are vendored in `lib/` (pdf.js, JSZip) so no CDN is needed.

## Run locally
```sh
python3 -m http.server 8000   # or any static server; then open http://localhost:8000
```
(Service workers require `https://` or `localhost`.)

## Deploy (needed before building the APK)
PWABuilder needs a public HTTPS URL. A GitHub Pages workflow is included (`.github/workflows/pages.yml`):
repo **Settings → Pages → Source: GitHub Actions**, then push to `main`.
All paths are relative, so it works under `https://<user>.github.io/Converter-Tool/`.
Netlify / Vercel / Cloudflare Pages work too (just publish the repo root).

## Build the Android APK with PWABuilder
1. Go to <https://www.pwabuilder.com>, enter your deployed URL, and run the analysis (manifest + service worker should pass).
2. Click **Package for stores → Android**. Set a package ID (e.g. `com.yourname.pdftoepub`), and keep the
   signing key option “Create new” (**download and back up the key + fingerprint**).
3. Download the zip: it contains the `.apk` (for sideloading) and `.aab` (for Play Store).
4. **Digital Asset Links** (removes the browser URL bar so it looks like a real app): copy the SHA-256
   fingerprint from PWABuilder’s output into `.well-known/assetlinks.json`:
   ```json
   [{
     "relation": ["delegate_permission/common.handle_all_urls"],
     "target": { "namespace": "android_app", "package_name": "com.yourname.pdftoepub",
                 "sha256_cert_fingerprints": ["AA:BB:...:FF"] }
   }]
   ```
   The file must be served at the **domain root**: `https://<host>/.well-known/assetlinks.json`.
   On `username.github.io/Converter-Tool/` it can’t be (subpath), so use a `username.github.io` root repo
   or a custom domain / Netlify / Vercel. Without it the APK still works but shows a URL bar.

## More converters (all on-device)
The home screen has a grid of extra tools. Libraries load only when a tool is opened and are cached for offline use.

| Tool | What it does |
|---|---|
| Image converter | JPG / PNG / WebP, resize, quality |
| Images → PDF | Combine images into one PDF (page size, margins, reorder) |
| PDF → Images | PNG/JPG per page, page ranges |
| Merge / Split / Organize / Compress PDF | pdf-lib based; compress offers a light mode and a strong (rasterize) mode |
| Document → PDF | `.docx`, Markdown, HTML, text. Latin text becomes real selectable text; other scripts (Hindi, Tamil, …) are drawn as page images |
| Document → EPUB | `.docx`, Markdown, HTML, text → EPUB 3 (images kept, chapters from headings) |
| EPUB → PDF / text | Reflowable and image-based EPUBs |
| CSV · JSON · Excel | Any direction (`.xlsx` input; `.xls` not supported) |
| Create / Extract ZIP | Archive any files |

Code map: `tools.js` (tool registry and conversions), `hub.js` (tiles and generic tool screen), `pdfdoc.js` (document layout engine), `epubbuild.js`, `loader.js` (lazy library loading).
Not supported without a server: pixel-perfect Office → PDF, PDF → editable Word. Audio/video, OCR and HEIC are candidates for a later batch.

## Files
| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | UI and wiring |
| `converter.js` | PDF parsing → EPUB packaging |
| `book.js` | Pagination + 3D page-flip viewer |
| `manifest.webmanifest`, `sw.js`, `icons/` | PWA / PWABuilder requirements |
| `.well-known/assetlinks.json` | Android Digital Asset Links (fill in after packaging) |

## Limitations
Reflow mode doesn’t OCR scanned PDFs and handles multi-column layouts/tables/images only approximately;
use Fixed pages for those. Bump `VERSION` in `sw.js` when you change files so installed apps refresh.
