#!/usr/bin/env python3
"""Fetch selected, unmodified Ace browser assets, verifying the pinned npm SRI.
No npm install/build, runtime CDN, workers, or IDE service is needed.
"""
import base64
import hashlib
import io
from pathlib import Path
import tarfile
import urllib.request

VERSION = '1.45.0'
INTEGRITY = 'sha512-tAAorvbQRlsdDeuf4RnBLgaRk4HVT9td2D4QKEqXyuQkZmFoqHxl9JuV2o1XkuDT+zOreooGPiG1tU/Y+pNFkg=='
URL = 'https://registry.npmjs.org/ace-builds/-/ace-builds-' + VERSION + '.tgz'
DEST = Path(__file__).resolve().parents[1] / 'web/vendor/ace'
FILES = ['ace.js', 'ext-searchbox.js'] + ['mode-' + mode + '.js' for mode in ['text', 'html', 'xml', 'javascript', 'css', 'json', 'nginx', 'yaml', 'sh', 'markdown']]

def main():
    with urllib.request.urlopen(URL, timeout=30) as response:
        data = response.read()
    actual = 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode()
    if actual != INTEGRITY:
        raise RuntimeError('Ace npm integrity mismatch; refusing to modify vendored files')
    DEST.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        selected = [('package/src-min-noconflict/' + name, name) for name in FILES]
        selected += [('package/css/ace.css', 'ace.css'), ('package/css/theme/textmate.css', 'theme-textmate.css'), ('package/LICENSE', 'LICENSE')]
        for source, name in selected:
            member = archive.getmember(source)
            if not member.isfile():
                raise RuntimeError('Unexpected non-regular asset: ' + source)
            (DEST / name).write_bytes(archive.extractfile(member).read())
    print('Verified and vendored Ace', VERSION)

if __name__ == '__main__':
    main()
