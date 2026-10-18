import {defineConfig} from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/setup.mjs",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:18081",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {executablePath: "/usr/bin/google-chrome-stable"},
  },
  projects: [{name: "chromium", use: {browserName: "chromium"}}],
  webServer: {
    command: "go run ./cmd/text-vault -listen 127.0.0.1:18081 -database .tmp/e2e-data/text-vault.db -secure-cookie=false",
    url: "http://127.0.0.1:18081/api/health",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
