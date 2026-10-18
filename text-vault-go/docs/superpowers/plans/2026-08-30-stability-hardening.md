# Text Vault Stability Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix cached first-run detection, distinguish content changes from quiet workspace changes, add safe password rotation and login throttling, and simplify the pin UI.

**Architecture:** Keep VanJS as the rendering layer and ordinary JavaScript modules as the application core. Keep the random data key stable during password changes; only its password wrapper and the independently derived server credential rotate. Track persistence dirtiness separately from user-visible content dirtiness so one global Save still commits both.

**Tech Stack:** Go standard library, existing SQLite store, browser Web Crypto, VanJS 1.6.1, Node test runner, Playwright.

**Spec:** `apps/text-vault/docs/superpowers/specs/2026-08-29-text-vault-design.md`

## Global Constraints

- Add no runtime dependencies.
- Comments explain boundaries and data flow, not elementary syntax.
- Never send the master password or data key to Go.
- The only persistence control remains the global `保存` button.
- Layout changes are saved with the next global save but do not show `未保存` or trigger `beforeunload`.

### Task 1: Prevent stale first-run detection

**Files:** `internal/httpapi/api.go`, `internal/httpapi/api_test.go`, `tests/e2e/text-vault.spec.mjs`

- [x] Write an HTTP test requiring `Cache-Control: no-store` on both successful and 404 `/api/vault` responses.
- [x] Run the focused test and observe failure because the header is absent.
- [x] Add one API middleware that sets `Cache-Control: no-store` on every `/api/*` response.
- [x] Add a browser regression path for setup followed by reload and unlock.
- [x] Run Go and Playwright tests.

### Task 2: Separate visible and quiet dirty state

**Files:** `web/js/repository.js`, `web/js/repository.test.js`, `web/js/save.js`, `web/js/save.test.js`, `web/js/app.js`

- [x] Write tests showing quiet workspace upserts appear in `captureDirty()` but not `isContentDirty()`.
- [x] Run the focused tests and observe the missing API failure.
- [x] Add `upsert(value, {quiet})`, persistence-dirty capture, and content-dirty reporting.
- [x] Make workspace changes quiet; make save status and unload protection observe content dirtiness only.
- [x] Verify one global save still commits quiet workspace objects.

### Task 3: Rotate passwords without re-encrypting entries

**Files:** `web/js/crypto.js`, `web/js/crypto.test.js`, `internal/store/store.go`, `internal/store/store_test.go`, `internal/auth/session.go`, `internal/httpapi/api.go`, `internal/httpapi/api_test.go`, `web/js/api.js`, `web/js/app.js`

- [x] Write crypto tests proving a new password unwraps the same data key while the old password fails.
- [x] Write store/API tests requiring header and authentication hash to rotate atomically.
- [x] Run focused tests and observe missing rewrap/update APIs.
- [x] Add an exportable in-memory data key, `rewrapVault`, transactional metadata update, protected `/api/rekey`, and manager hash replacement.
- [x] Add a small in-app password-change dialog under a `⋯` menu and keep failures non-destructive.
- [x] Run crypto, store, auth, and API tests.

### Task 4: Throttle login and simplify pin UI

**Files:** `internal/auth/session.go`, `internal/auth/session_test.go`, `web/js/app.js`, `web/styles.css`, `tests/e2e/text-vault.spec.mjs`, `README.md`

- [x] Write a deterministic auth test using an injected clock, proving repeated failures are delayed and success clears the failure state.
- [x] Run it and observe failure because throttling is absent.
- [x] Add a small in-memory exponential backoff with bounded delay and no dependency.
- [x] Replace the text pin action with a compact pin glyph while retaining accessible labels and the existing close control.
- [x] Add concise architectural comments at crypto, repository, save, and HTTP boundaries.
- [x] Run race tests, unit tests, no-CGO build, and Chromium desktop/mobile tests.
