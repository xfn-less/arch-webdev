#!/usr/bin/env python3
"""Vendor only the Lucide ESM icons used by this panel; no build step."""
import base64
import hashlib
import io
from pathlib import Path
import tarfile
from urllib.request import urlopen

VERSION = "1.60.0"
INTEGRITY = "sha512-nS9qchK+W+c58GZk8LRR/9X2t+AuC/qs4CeXQauA3l/sqkrl0wzZDjcwLPHSdvoE1HYwnqDZUIs/lYAdWx1a8Q=="
ICONS = "server globe folder folder-open file file-code file-cog search plus upload send refresh-cw save terminal chevron-right x log-out arrow-right copy download check scroll-text circle-check circle-x clock triangle-alert lock-keyhole pencil ban stethoscope".split()
root = Path(__file__).resolve().parents[1] / "web/vendor/lucide"
with urlopen(f"https://registry.npmjs.org/lucide/-/lucide-{VERSION}.tgz", timeout=60) as response:
    data = response.read()
actual = "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()
if actual != INTEGRITY:
    raise SystemExit("Lucide archive integrity mismatch")
with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
    sources = ["createElement.mjs", "defaultAttributes.mjs"] + [f"icons/{name}.mjs" for name in ICONS]
    for source in sources:
        for name in [source, source + ".map"]:
            dest = root / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(archive.extractfile("package/dist/esm/" + name).read())
    (root / "LICENSE").write_bytes(archive.extractfile("package/LICENSE").read())
print(f"Vendored Lucide {VERSION}: {len(ICONS)} icons, official ESM sources and license")
