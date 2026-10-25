# Third-party software

## VanJS 1.6.1

- Source: https://www.npmjs.com/package/vanjs-core/v/1.6.1
- Vendored file: `web/vendor/van-1.6.1.js`
- SHA-256: `ef8f52f40904f5f9165fa4a61f85114c10008f8a70a4c3634898df29c7afe413`
- License: MIT

Copyright (c) 2023 Tao Xin

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Ace 1.45.0 (ace-builds)

- Source: https://www.npmjs.com/package/ace-builds/v/1.45.0
- Archive: https://registry.npmjs.org/ace-builds/-/ace-builds-1.45.0.tgz
- npm integrity (verified): `sha512-tAAorvbQRlsdDeuf4RnBLgaRk4HVT9td2D4QKEqXyuQkZmFoqHxl9JuV2o1XkuDT+zOreooGPiG1tU/Y+pNFkg==`
- License: BSD-3-Clause, Copyright (c) 2010, Ajax.org B.V.
- Full notice: [web/vendor/ace/LICENSE](web/vendor/ace/LICENSE), included in embedded distribution.
- Only selected official browser JS, external CSS and language modes are vendored, unmodified; no worker binaries or entire IDE. All selected assets together are approximately 764 KB uncompressed, loaded as needed (core JS approximately 479 KB). No running editor server is required.
- Reproduce the selected files: `python scripts/vendor-ace.py`.

## Lucide 1.60.0

- Source: https://www.npmjs.com/package/lucide/v/1.60.0
- Archive: https://registry.npmjs.org/lucide/-/lucide-1.60.0.tgz
- npm integrity (verified): `sha512-nS9qchK+W+c58GZk8LRR/9X2t+AuC/qs4CeXQauA3l/sqkrl0wzZDjcwLPHSdvoE1HYwnqDZUIs/lYAdWx1a8Q==`
- License: ISC, with MIT notices for Feather-derived icons; full [notice](web/vendor/lucide/LICENSE) included.
- Only 27 icon modules and the official SVG creator, with source maps, are vendored unmodified (approximately 73 KB). Native browser ESM; no CDN, icon font, runtime DOM scanner or build dependency.
- Reproduce: `python scripts/vendor-lucide.py`.

## Other dependencies

Go dependencies and versions are pinned in go.mod/go.sum. Browser test dependencies are pinned in package-lock.json and are not needed to run the panel. Their upstream license files remain with the installed module/package distributions; review before redistributing compiled release packages. This is a development prototype, not a prepared third-party license bundle for release.
