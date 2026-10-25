import {defineConfig} from "@playwright/test";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
const data = mkdtempSync(join(tmpdir(), "site-panel-browser-"));
process.env.SITE_PANEL_TEST_DATA = data;
export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  use: {baseURL: "http://127.0.0.1:18091", headless: true},
  globalTeardown: "./tests/browser/cleanup.mjs",
  webServer: {command: `./bin/site-panel -listen 127.0.0.1:18091 -data '${data}'`, url: "http://127.0.0.1:18091/api/session", reuseExistingServer: false},
});
