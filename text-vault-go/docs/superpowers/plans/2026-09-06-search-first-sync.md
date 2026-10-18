# Text Vault Search-First Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the internal workspace/tab UI with a minimal search-first responsive interface that autosaves encrypted entries, incrementally synchronizes tabs/devices, hands unlock keys to same-browser tabs, and exposes `/s` and `/changepwd` commands.

**Architecture:** The browser keeps one decrypted in-memory repository, with separate modules for querying, commands, saving, remote synchronization, and ephemeral cross-tab unlock handoff. Go and SQLite remain ciphertext-only and add a generation-based changes endpoint; the browser URL fragment stores only ordinary search text.

**Tech Stack:** Go standard library, modernc SQLite, native ES modules, VanJS 1.6.1, Web Crypto, BroadcastChannel, Node test runner, Playwright.

**Spec:** `apps/text-vault/docs/superpowers/specs/2026-09-06-search-first-sync-design.md`

## Global Constraints

- No build step and no new runtime dependencies.
- VanJS is a thin DOM/state layer; domain modules remain plain JavaScript.
- The server never receives the master password, plaintext entries, or data key.
- Only dirty objects are uploaded; commands and passwords never enter the URL.
- No CRDT, WebSocket, attachments, tables, internal query tabs, Pin, or saved layout.
- Use focused files and block comments around design/data-flow boundaries.

---

### Task 1: Adopt the memo ID format

**Files:**
- Modify: `apps/text-vault/web/js/model.js`
- Modify: `apps/text-vault/web/js/model.test.js`
- Modify: `apps/text-vault/internal/store/store.go`
- Modify: `apps/text-vault/internal/store/store_test.go`

**Interfaces:**
- Produces: `newMemoID(existingIDs, now)` returning a 9-character ID and `formatMemoTime(id)` returning display text.
- Produces: client and server validation accepting `^[0-9a-z]{9}$` for new entry IDs.

- [ ] **Step 1: Write failing JS tests** for same-minute sequence `00`, `01`, minute reset, base36 time fields, formatting, and rejection of malformed IDs.
- [ ] **Step 2: Run** `npm run test:unit -- --test-name-pattern='memo|entry|object'`; expect the new assertions to fail.
- [ ] **Step 3: Port the small algorithm** from `apps/vanjs/garden/src/memoId.js` into `model.js`; make `createEntry` require or derive the ID from `existingIDs` without hidden global state.
- [ ] **Step 4: Write failing Go validation tests** proving 9-character lowercase IDs pass and old malformed IDs fail.
- [ ] **Step 5: Change server validation** to accept only the 9-character memo ID for entry objects; reset the disposable development database instead of adding a legacy compatibility path.
- [ ] **Step 6: Run** `npm run test:unit && go test ./...`; expect PASS.
- [ ] **Step 7: Commit** with `feat: use chronological memo ids`.

### Task 2: Add generation-based incremental reads

**Files:**
- Modify: `apps/text-vault/internal/store/model.go`
- Modify: `apps/text-vault/internal/store/store.go`
- Modify: `apps/text-vault/internal/store/store_test.go`
- Modify: `apps/text-vault/internal/httpapi/api.go`
- Modify: `apps/text-vault/internal/httpapi/api_test.go`
- Modify: `apps/text-vault/web/js/api.js`
- Modify: `apps/text-vault/web/js/api.test.js`

**Interfaces:**
- Produces: `Store.Changes(ctx, after uint64) (Changes, error)`.
- Produces: `GET /api/changes?after=N` returning `{generation, objects}`.
- Produces: `api.changes(after)`.

- [ ] **Step 1: Write failing store tests** that commit revisions across multiple generations and assert `Changes(1)` returns only the latest version of objects changed after generation 1 plus the current generation.
- [ ] **Step 2: Run** `go test ./internal/store -run Changes`; expect FAIL because the API is absent.
- [ ] **Step 3: Implement `Changes`** as one read transaction using `object_versions`, choosing the greatest generation/revision for each changed ID.
- [ ] **Step 4: Write failing HTTP tests** for valid `after`, zero, malformed, and unauthenticated requests.
- [ ] **Step 5: Add the protected endpoint** with strict unsigned-integer parsing and stable JSON errors.
- [ ] **Step 6: Write failing JS API tests**, then add `changes(after)` using `encodeURIComponent(String(after))`.
- [ ] **Step 7: Run** `go test ./... && npm run test:unit`; expect PASS.
- [ ] **Step 8: Commit** with `feat: expose incremental vault changes`.

### Task 3: Make the repository merge remote changes safely

**Files:**
- Modify: `apps/text-vault/web/js/repository.js`
- Modify: `apps/text-vault/web/js/repository.test.js`

**Interfaces:**
- Consumes: decrypted `{id, kind, revision, ...}` objects.
- Produces: `applyRemote(remoteObjects)` returning `{applied, conflicts}`.
- Produces: conflict entries created through `createConflictEntry(local, remote, existingIDs, now)`.

- [ ] **Step 1: Write failing tests** for clean remote replacement, unrelated dirty preservation, identical revision no-op, and same-object dirty conflict preservation.
- [ ] **Step 2: Run** `node --test web/js/repository.test.js`; expect FAIL.
- [ ] **Step 3: Implement merge rules**: clean objects adopt newer remote revisions; dirty objects remain untouched; a newer remote revision for the same dirty object creates one searchable conflict entry containing clear local/remote context.
- [ ] **Step 4: Ensure conflict copies are dirty** so autosave persists them, while the original local entry remains dirty and visible.
- [ ] **Step 5: Run** `node --test web/js/repository.test.js`; expect PASS.
- [ ] **Step 6: Commit** with `feat: merge remote vault changes safely`.

### Task 4: Build one save/sync state machine

**Files:**
- Modify: `apps/text-vault/web/js/save.js`
- Modify: `apps/text-vault/web/js/save.test.js`
- Create: `apps/text-vault/web/js/sync.js`
- Create: `apps/text-vault/web/js/sync.test.js`

**Interfaces:**
- Produces: `createSaveCoordinator({repository, api, key, generation, beforeSave})` with `save()`, `schedule()`, `status()`, `generation()`, `setGeneration()` and `subscribe()`.
- Produces: `createSyncCoordinator({repository, api, key, generation, intervalMs})` with `pull()`, `start()`, `stop()`, `generation()` and `subscribe()`.

- [ ] **Step 1: Extend failing save tests** for one-second debounce, edit-during-save scheduling, serial requests, retryable failure, and `/s`-style immediate save through the same method.
- [ ] **Step 2: Run** `node --test web/js/save.test.js`; expect FAIL.
- [ ] **Step 3: Refactor save coordinator** so `schedule()` resets one timer, `save()` serializes, and a sequence changed during upload stays dirty for the next pass.
- [ ] **Step 4: Write failing sync tests** for decrypting `api.changes`, advancing generation, merging results, preventing overlapping pulls, and continuing after a transient error.
- [ ] **Step 5: Implement `sync.js`** with a two-second timer and injectable timing dependencies for deterministic tests.
- [ ] **Step 6: Connect save-before-push to pull-before-save** without circular module imports; the app composes the two coordinators.
- [ ] **Step 7: Run** `npm run test:unit`; expect PASS.
- [ ] **Step 8: Commit** with `feat: autosave and incrementally sync entries`.

### Task 5: Add ephemeral same-browser unlock handoff

**Files:**
- Create: `apps/text-vault/web/js/tab-session.js`
- Create: `apps/text-vault/web/js/tab-session.test.js`
- Modify: `apps/text-vault/web/js/api.js`
- Modify: `apps/text-vault/web/js/api.test.js`

**Interfaces:**
- Produces: `createTabSession({channel, timeoutMs})` with `offer(session)`, `request()`, and `close()`.
- Produces: `api.setCSRFToken(token)` and `api.csrfToken()` for in-memory handoff only.
- Session shape: `{key: CryptoKey, csrfToken: string}`.

- [ ] **Step 1: Write failing fake-channel tests** for request/response, timeout, request correlation, ignoring malformed messages, and stopping offers after lock/logout.
- [ ] **Step 2: Run** `node --test web/js/tab-session.test.js`; expect FAIL.
- [ ] **Step 3: Implement the request protocol** with random request IDs, one response per request, structured-cloned CryptoKey, and no storage APIs.
- [ ] **Step 4: Add tested API token accessors** without exposing the token outside module composition.
- [ ] **Step 5: Run** `npm run test:unit`; expect PASS.
- [ ] **Step 6: Commit** with `feat: hand off unlocked tab sessions`.

### Task 6: Add search commands and password-change session

**Files:**
- Create: `apps/text-vault/web/js/commands.js`
- Create: `apps/text-vault/web/js/commands.test.js`
- Modify: `apps/text-vault/web/js/crypto.test.js`

**Interfaces:**
- Produces: `createCommands({save, changePassword})` with `search(input)` and `execute(name)`.
- Produces: password session states `new-password`, `repeat-password`, `confirm`, and `idle` without retaining completed password strings.
- Consumes: existing `rewrapVault(password, key)` and `api.rekey(header, credential)`.

- [ ] **Step 1: Write failing command tests** proving only `/s` and `/changepwd` appear, ordinary input is not command mode, and commands never request URL updates.
- [ ] **Step 2: Write failing password-session tests** for minimum length, mismatch restart, `y` confirmation, `n`/Escape cancellation, and clearing secret references on every exit.
- [ ] **Step 3: Run** `node --test web/js/commands.test.js`; expect FAIL.
- [ ] **Step 4: Implement a plain command registry** and state machine; keep DOM rendering out of this module.
- [ ] **Step 5: Add/confirm crypto tests** showing rewrap preserves the data key and old password fails after rotation while object ciphertext remains decryptable.
- [ ] **Step 6: Run** `npm run test:unit`; expect PASS.
- [ ] **Step 7: Commit** with `feat: add save and password commands`.

### Task 7: Replace the workspace UI with the minimal responsive shell

**Files:**
- Modify: `apps/text-vault/web/index.html`
- Rewrite: `apps/text-vault/web/js/app.js`
- Delete: `apps/text-vault/web/js/workspace.js`
- Delete: `apps/text-vault/web/js/workspace.test.js`
- Rewrite: `apps/text-vault/web/styles.css`
- Modify: `apps/text-vault/tests/e2e/text-vault.spec.mjs`

**Interfaces:**
- Consumes: repository, save/sync coordinators, commands, tab session, `location.hash`, and `history`.
- Produces: a desktop two-column and mobile single-pane application with one search/command input.

- [ ] **Step 1: Rewrite E2E expectations first** for the 6px status strip, fixed desktop columns, mobile list/content/back flow, no Pin/internal tabs, URL query, and ArrowUp/ArrowDown/Enter navigation.
- [ ] **Step 2: Run** `npm run test:e2e`; expect failures against the old UI.
- [ ] **Step 3: Build the dark shell immediately on load** and show the unlock overlay only after the tab-session request timeout.
- [ ] **Step 4: Render ordinary search results and virtual commands** through one list component; keep selected index in a small VanJS state and clamp it whenever results change.
- [ ] **Step 5: Wire URL fragments** only for ordinary queries, using `history.replaceState` while typing and `hashchange`/`popstate` for browser navigation.
- [ ] **Step 6: Wire the editor** to update the repository synchronously and schedule autosave; pull on focus, before opening, and before saving.
- [ ] **Step 7: Wire responsive navigation** so desktop always shows both panes and mobile history state selects list/content without losing query or list scroll.
- [ ] **Step 8: Implement command prompts** in the same bottom area; use `type=password` for both secret stages and return focus to search after completion/cancel.
- [ ] **Step 9: Replace CSS** with a compact dark grid, plain borders, no shadow/gradient/animation, and desktop/mobile media query.
- [ ] **Step 10: Run** `npm run test:unit && npm run test:e2e`; expect PASS.
- [ ] **Step 11: Commit** with `feat: simplify text vault search interface`.

### Task 8: Complete integration behavior and documentation

**Files:**
- Modify: `apps/text-vault/tests/e2e/text-vault.spec.mjs`
- Modify: `apps/text-vault/tests/e2e/setup.mjs`
- Modify: `apps/text-vault/README.md`

**Interfaces:**
- Verifies the complete user-visible system.
- Documents any one-time development database reset required by schema/ID changes.

- [ ] **Step 1: Add two-page E2E tests** for automatic unlock handoff, autosaved new/edited entry appearing in the other page after incremental pull, and URL queries remaining independent.
- [ ] **Step 2: Add a collision/conflict E2E or integration test** proving same-entry concurrent edits produce a preserved conflict copy rather than silent overwrite.
- [ ] **Step 3: Run** `npm run test:e2e`; fix only integration defects exposed by these scenarios.
- [ ] **Step 4: Rewrite README behavior sections** to describe autosave, `/s`, `/changepwd`, browser-tab queries, status colors, security limits, and exact run/backup commands.
- [ ] **Step 5: Run formatting and all checks:** `gofmt -w` on changed Go files, `go test ./...`, `npm run test:unit`, `npm run test:e2e`, `go vet ./...`, and `git diff --check`.
- [ ] **Step 6: Build the production binary** with `CGO_ENABLED=0 go build -trimpath -o /tmp/text-vault ./cmd/text-vault` and smoke-test `serve` against a temporary database.
- [ ] **Step 7: Commit** with `docs: explain autosaving text vault workflow`.

### Task 9: Final review

**Files:**
- Review all files changed by Tasks 1–8.

**Interfaces:**
- Produces a clean, verified branch ready for the user to run.

- [ ] **Step 1: Compare the implementation line-by-line with the design spec**, checking every completion criterion.
- [ ] **Step 2: Run the complete verification suite again** and retain the exact output for handoff.
- [ ] **Step 3: Inspect `git status`, recent commits, and diff from the design commit** for generated files, database files, secrets, or unrelated changes.
- [ ] **Step 4: Use `superpowers:requesting-code-review`**, address valid findings through tests, then rerun verification.
- [ ] **Step 5: Use `superpowers:verification-before-completion`** before reporting success.
