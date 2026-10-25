import test from "node:test";
import assert from "node:assert/strict";
import {modeForPath} from "../../web/js/editor.js";

test("selects only vendored language modes, otherwise plain text", () => {
  for (const [file, mode] of Object.entries({
    "index.html": "html", "nested/APP.JS": "javascript", "styles/main.css": "css",
    "settings.json": "json", "nginx.conf": "nginx", "sites/customer.conf": "nginx",
    "playbook.yaml": "yaml", "script.sh": "sh", "README.md": "markdown", "image.svg": "xml",
    "robots.txt": "text", "unknown.extension": "text", "noextension": "text",
  })) assert.equal(modeForPath(file), mode, file);
});
