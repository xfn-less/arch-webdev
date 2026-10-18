# Text Vault MVP Implementation Plan

> Superseded on 2026-08-30 for authentication only: the implemented interface uses one master password and a separately derived browser credential, as recorded in the design specification. References below to a configured access token describe the original implementation history.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a daily-usable single-user encrypted text workspace with live in-memory search, desktop/mobile navigation, bottom query tabs, one global Save action, and atomic ciphertext persistence.

**Architecture:** A no-build VanJS frontend owns the decrypted object repository, query results, workspace, dirty tracking, and Web Crypto boundary. A small Go server embeds the frontend, authenticates one operator, and atomically commits batches of independently encrypted object versions in one SQLite transaction; it never sees plaintext.

**Tech Stack:** Void Linux Go 1.26.5, Go standard library, `modernc.org/sqlite` v1.57.0, browser ES modules, VanJS 1.6.1 vendored locally, Web Crypto PBKDF2-HMAC-SHA-256 and AES-256-GCM, Go `testing`, Node 24.18+ built-in test runner, Playwright for final browser verification.

**Spec:** `apps/text-vault/docs/superpowers/specs/2026-08-29-text-vault-design.md`

## Global Constraints

- Project root is `apps/text-vault`; do not modify unrelated host configuration under `msi/`, `asus/`, `home/`, or `etc/`.
- The UI exposes exactly one global button labeled `保存`; no per-entry, per-tab, or workspace save control exists.
- Every edit updates the unified in-memory repository and live search immediately; internal navigation never prompts or discards memory changes.
- Plaintext, search terms, unwrapped keys, and workspace content never enter URLs, logs, localStorage, IndexedDB, or server files.
- The server stores ciphertext and synchronization metadata only; all public production traffic requires HTTPS.
- A SQLite transaction publishes all changed objects and the workspace together or publishes none of them.
- Unsaved changes may be lost on reload or process termination; dirty pages register native `beforeunload` protection.
- First release is single-user, online-only, plain text only, with no attachments, Markdown preview, properties UI, collaboration, AI, or server-side search.
- Runtime data and local secrets are ignored by Git; the existing `msi/home/.config/tri/config` worktree change must remain untouched.
- Build and test with Void Linux Go 1.26.5; set `go 1.26.0` in `go.mod` and build production binaries with `CGO_ENABLED=0`.
- Cryptographic envelope formats include explicit version and algorithm identifiers; do not invent cryptographic primitives.
- Prefer clear browser-native APIs, but use focused mature libraries when they materially improve correctness or maintenance; pin exact versions, vendor production assets locally, record license/checksum/provenance, lazy-load format-specific code, and hide each dependency behind a small project-owned adapter.
- Do not add a runtime dependency merely for convenience already covered clearly by the platform; do not reimplement specialist parsers, editors, or search algorithms merely to claim zero dependencies.

## Planned File Structure

```text
apps/text-vault/
├── .gitignore                       runtime data, binaries, and local config
├── README.md                        local run, production deploy, backup/restore
├── go.mod                           Go module with pinned pure-Go SQLite driver
├── package.json                     ESM test scripts and pinned Playwright dev tool
├── playwright.config.mjs            isolated browser-test server and projects
├── cmd/text-vault/main.go           flags, server construction, graceful shutdown
├── internal/auth/session.go         single-user token login and in-memory sessions
├── internal/auth/session_test.go
├── internal/httpapi/api.go          JSON routes and error mapping
├── internal/httpapi/api_test.go
├── internal/store/model.go          ciphertext envelopes and commit contracts
├── internal/store/store.go          SQLite schema, transactions, reads, and backup
├── internal/store/store_test.go
├── web/embed.go                     embedded frontend filesystem
├── web/index.html                    application shell and lock screen
├── web/styles.css                    Smartisan-inspired responsive visual system
├── web/vendor/van-1.6.1.js           pinned local VanJS browser module
├── web/js/api.js                     authenticated ciphertext API client
├── web/js/codec.js                   canonical UTF-8/JSON/base64 helpers
├── web/js/crypto.js                  vault key wrapping and object encryption
├── web/js/model.js                   object constructors and schema validation
├── web/js/repository.js              unified memory state, dirty set, live search
├── web/js/workspace.js               tabs, selection, layout, mobile navigation
├── web/js/save.js                    one global atomic-save coordinator
├── web/js/app.js                     VanJS composition and lifecycle
├── web/js/*.test.js                  Node unit tests beside frontend modules
├── tests/e2e/setup.mjs                reset explicit disposable E2E data directory
└── tests/e2e/text-vault.spec.mjs      browser-level daily workflow verification
```

---

### Task 1: Runnable Go shell with embedded no-build frontend

**Files:**
- Create: `apps/text-vault/go.mod`
- Create: `apps/text-vault/package.json`
- Create: `apps/text-vault/.gitignore`
- Create: `apps/text-vault/cmd/text-vault/main.go`
- Create: `apps/text-vault/internal/httpapi/api.go`
- Create: `apps/text-vault/internal/httpapi/api_test.go`
- Create: `apps/text-vault/web/embed.go`
- Create: `apps/text-vault/web/index.html`
- Create: `apps/text-vault/web/styles.css`
- Create: `apps/text-vault/web/js/app.js`

**Interfaces:**
- Produces: `httpapi.New(httpapi.Config) http.Handler`
- Produces: embedded `web.FS fs.FS`
- Consumes: no earlier task

- [ ] **Step 1: Write a failing server-shell test**

```go
func TestHealthAndSPA(t *testing.T) {
    h := New(Config{Frontend: fstest.MapFS{
        "index.html": {Data: []byte("<main>Text Vault</main>")},
    }})

    health := httptest.NewRecorder()
    h.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/api/health", nil))
    if health.Code != http.StatusOK || strings.TrimSpace(health.Body.String()) != `{"ok":true}` {
        t.Fatalf("health = %d %q", health.Code, health.Body.String())
    }

    page := httptest.NewRecorder()
    h.ServeHTTP(page, httptest.NewRequest(http.MethodGet, "/", nil))
    if page.Code != http.StatusOK || !strings.Contains(page.Body.String(), "Text Vault") {
        t.Fatalf("page = %d %q", page.Code, page.Body.String())
    }
}
```

Before running the test, execute `go version`. The current workstation does not have Go installed; install the current Void `go` package (observed as 1.26.5_1) through XBPS, then record the actual version in `README.md`. Do not download a separate compiler toolchain.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `cd apps/text-vault && go test ./internal/httpapi -run TestHealthAndSPA -v`

Expected: FAIL because `Config` and `New` do not exist.

- [ ] **Step 3: Implement the minimal HTTP shell and embedded frontend**

`httpapi.Config` contains `Frontend fs.FS`; `New` registers `GET /api/health` and serves `index.html` for non-API GET routes. `main.go` accepts `-listen` and `-data`, constructs the handler, uses `http.Server` timeouts, and handles SIGINT/SIGTERM with a 10-second graceful shutdown. `web/embed.go` exposes `//go:embed index.html styles.css js vendor` through `fs.Sub`.

The initial HTML contains `#app`, loads `/styles.css`, and imports `/js/app.js`. The first JS render must display `Text Vault` and `正在初始化…`; no framework CDN is permitted.

Create `package.json` with `"private": true`, `"type": "module"`, scripts `test:unit` as `node --test web/js/*.test.js` and `test:e2e` as `playwright test`, plus the exact development dependency `@playwright/test: "1.58.2"`. This package is development tooling only; production serves vendored browser modules and has no npm install step.

- [ ] **Step 4: Verify shell behavior**

Run: `cd apps/text-vault && gofmt -w cmd internal web && go test ./...`

Expected: PASS.

- [ ] **Step 5: Commit the shell**

```bash
git add apps/text-vault/.gitignore apps/text-vault/go.mod apps/text-vault/package.json apps/text-vault/cmd apps/text-vault/internal/httpapi apps/text-vault/web
git commit -m "feat: scaffold text vault server"
```

---

### Task 2: Transactional SQLite ciphertext object store

**Files:**
- Create: `apps/text-vault/internal/store/model.go`
- Create: `apps/text-vault/internal/store/store.go`
- Create: `apps/text-vault/internal/store/store_test.go`

**Interfaces:**
- Produces: `store.Open(root string) (*Store, error)`
- Produces: `(*Store).Snapshot(ctx context.Context) (Snapshot, error)`
- Produces: `(*Store).Commit(ctx context.Context, CommitRequest) (Manifest, error)`
- Produces: `(*Store).CreateVaultHeader(ctx context.Context, json.RawMessage) error`
- Produces: `(*Store).VaultHeader(ctx context.Context) (json.RawMessage, error)`
- Produces: `store.ErrConflict`
- Consumes: SQLite database path supplied by `main`

- [ ] **Step 1: Write failing atomic commit tests**

```go
func TestCommitPublishesBatchAndRejectsStaleBase(t *testing.T) {
    s, err := Open(filepath.Join(t.TempDir(), "text-vault.db"))
    if err != nil { t.Fatal(err) }

    first, err := s.Commit(context.Background(), CommitRequest{
        BaseGeneration: 0,
        Objects: []CipherObject{{ID: "entry-a", Kind: "entry", Revision: 1, Envelope: json.RawMessage(`{"ciphertext":"AA=="}`)}},
    })
    if err != nil { t.Fatal(err) }
    if first.Generation != 1 || first.Objects["entry-a"].Revision != 1 { t.Fatalf("manifest = %#v", first) }

    _, err = s.Commit(context.Background(), CommitRequest{
        BaseGeneration: 0,
        Objects: []CipherObject{{ID: "entry-b", Kind: "entry", Revision: 1, Envelope: json.RawMessage(`{"ciphertext":"AQ=="}`)}},
    })
    if !errors.Is(err, ErrConflict) { t.Fatalf("error = %v", err) }

    snap, err := s.Snapshot(context.Background())
    if err != nil { t.Fatal(err) }
    if _, leaked := snap.Objects["entry-b"]; leaked { t.Fatal("stale batch became visible") }
}
```

Add tests for invalid IDs, duplicate IDs, revision skips, transaction rollback after a forced second-object failure, reopening a committed database, create-only vault header, and reading the exact header bytes after reopen.

- [ ] **Step 2: Run store tests and verify failure**

Run: `cd apps/text-vault && go test ./internal/store -v`

Expected: FAIL because the store package is absent.

- [ ] **Step 3: Implement schema migration and atomic SQLite transactions**

Use these contracts:

```go
type CipherObject struct {
    ID       string          `json:"id"`
    Kind     string          `json:"kind"`
    Revision uint64          `json:"revision"`
    Envelope json.RawMessage `json:"envelope"`
}

type ObjectRef struct {
    Kind     string `json:"kind"`
    Revision uint64 `json:"revision"`
}

type Manifest struct {
    SchemaVersion int                  `json:"schemaVersion"`
    Generation    uint64               `json:"generation"`
    Objects       map[string]ObjectRef `json:"objects"`
}

type CommitRequest struct {
    BaseGeneration uint64         `json:"baseGeneration"`
    Objects        []CipherObject `json:"objects"`
}
```

Open SQLite through `database/sql` and the blank-imported `modernc.org/sqlite` driver. Set `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, and `synchronous=FULL`; limit the pool to one open writer connection. Create `metadata(key TEXT PRIMARY KEY,value BLOB NOT NULL)`, `objects(id TEXT PRIMARY KEY,kind TEXT NOT NULL,revision INTEGER NOT NULL,envelope BLOB NOT NULL,updated_at INTEGER NOT NULL)`, `object_versions(id TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL,envelope BLOB NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(id,revision))`, and `schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL)`.

Validate IDs with `^[A-Za-z0-9_-]{16,80}$`, permit kinds `entry`, `workspace`, `query`, and `view`, require new object revision 1 and existing object revision exactly current+1. `Commit` begins a transaction, reads and compares `metadata.generation`, validates every revision before any insertion, writes history and current rows, increments generation, and commits. Any error explicitly rolls back. `Snapshot` reads generation and all current rows in one read transaction.

`CreateVaultHeader` validates that the value is a JSON object no larger than 64 KiB and inserts the opaque bytes at `metadata.vault_header`; uniqueness returns `ErrConflict`. `VaultHeader` returns the stored raw JSON without interpreting cryptographic fields.

- [ ] **Step 4: Run store tests including race detector**

Run: `cd apps/text-vault && gofmt -w internal/store && go test -race ./internal/store`

Expected: PASS.

- [ ] **Step 5: Commit storage**

```bash
git add apps/text-vault/internal/store
git commit -m "feat: add transactional ciphertext store"
```

---

### Task 3: Single-user authentication and ciphertext API

**Files:**
- Create: `apps/text-vault/internal/auth/session.go`
- Create: `apps/text-vault/internal/auth/session_test.go`
- Modify: `apps/text-vault/internal/httpapi/api.go`
- Modify: `apps/text-vault/internal/httpapi/api_test.go`
- Modify: `apps/text-vault/cmd/text-vault/main.go`

**Interfaces:**
- Produces: `auth.New(accessToken string, secureCookie bool) (*Manager, error)`
- Produces: `(*Manager).Login(http.ResponseWriter, *http.Request) bool`
- Produces: `(*Manager).Require(http.Handler) http.Handler`
- Produces: `GET /api/vault`, `PUT /api/vault`, `GET /api/snapshot`, `POST /api/commit`, `POST /api/login`, `POST /api/logout`
- Consumes: `store.Snapshot`, `store.Commit`, `TEXT_VAULT_ACCESS_TOKEN`

- [ ] **Step 1: Write failing auth and API tests**

```go
func TestProtectedSnapshotRequiresSession(t *testing.T) {
    h := newTestAPI(t, "correct-horse-token")
    denied := httptest.NewRecorder()
    h.ServeHTTP(denied, httptest.NewRequest(http.MethodGet, "/api/snapshot", nil))
    if denied.Code != http.StatusUnauthorized { t.Fatalf("status = %d", denied.Code) }

    loginBody := strings.NewReader(`{"token":"correct-horse-token"}`)
    login := httptest.NewRecorder()
    h.ServeHTTP(login, httptest.NewRequest(http.MethodPost, "/api/login", loginBody))
    if login.Code != http.StatusOK { t.Fatalf("login = %d", login.Code) }

    req := httptest.NewRequest(http.MethodGet, "/api/snapshot", nil)
    req.AddCookie(login.Result().Cookies()[0])
    allowed := httptest.NewRecorder()
    h.ServeHTTP(allowed, req)
    if allowed.Code != http.StatusOK { t.Fatalf("snapshot = %d %s", allowed.Code, allowed.Body.String()) }
}
```

Define `newTestAPI` in the test file to open a temporary store, create an auth manager with `secureCookie=false`, and pass both into `New`. Add tests for incorrect token, logout, create-only vault header, missing header returning 404, 1 MiB JSON limit, malformed JSON, invalid content type, stale generation returning HTTP 409, and method rejection.

- [ ] **Step 2: Run API tests and verify failure**

Run: `cd apps/text-vault && go test ./internal/auth ./internal/httpapi -v`

Expected: FAIL because authentication and protected routes are absent.

- [ ] **Step 3: Implement authentication and API mapping**

Hash configured and supplied access tokens with SHA-256 and compare using `subtle.ConstantTimeCompare`. On success generate a 32-byte random opaque session ID, retain only its SHA-256 digest in an in-memory map, and set an HttpOnly, SameSite=Strict, path `/` cookie; apply Secure in production mode. Generate a per-session CSRF token, return it from login JSON, require it in `X-CSRF-Token` for commit and logout, and never log request bodies or tokens.

Successful login returns `200 {"csrfToken":"..."}`. `GET /api/vault` returns the opaque header, and `PUT /api/vault` creates it exactly once. `GET /api/snapshot` returns `{manifest, objects}` from the current store snapshot. `POST /api/commit` accepts `store.CommitRequest`, maps `ErrConflict` to `409 {"error":"conflict"}`, and returns the new manifest. Limit body size before JSON decoding and reject unknown fields.

- [ ] **Step 4: Verify authentication, API, and race safety**

Run: `cd apps/text-vault && gofmt -w cmd internal && go test -race ./...`

Expected: PASS.

- [ ] **Step 5: Commit API**

```bash
git add apps/text-vault/cmd apps/text-vault/internal/auth apps/text-vault/internal/httpapi
git commit -m "feat: expose authenticated ciphertext api"
```

---

### Task 4: Versioned browser cryptography boundary

**Files:**
- Create: `apps/text-vault/web/js/codec.js`
- Create: `apps/text-vault/web/js/crypto.js`
- Create: `apps/text-vault/web/js/crypto.test.js`

**Interfaces:**
- Produces: `createVault(password) -> Promise<{header, key}>`
- Produces: `unlockVault(password, header) -> Promise<CryptoKey>`
- Produces: `encryptObject(key, metadata, value) -> Promise<EnvelopeV1>`
- Produces: `decryptObject(key, metadata, envelope) -> Promise<unknown>`
- Consumes: standards-compliant `globalThis.crypto.subtle`

- [ ] **Step 1: Write failing deterministic round-trip and tamper tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createVault, unlockVault, encryptObject, decryptObject } from "./crypto.js";

test("correct password decrypts and tampering fails", async () => {
  const { header, key } = await createVault("a long unique passphrase");
  const metadata = { id: "entry_1234567890", kind: "entry", revision: 1 };
  const envelope = await encryptObject(key, metadata, { text: "1.2.3.4 客户A" });
  assert.deepEqual(await decryptObject(await unlockVault("a long unique passphrase", header), metadata, envelope), { text: "1.2.3.4 客户A" });

  const broken = { ...envelope, ciphertext: envelope.ciphertext.slice(0, -2) + "AA" };
  await assert.rejects(() => decryptObject(key, metadata, broken));
  await assert.rejects(() => unlockVault("wrong password", header));
});
```

- [ ] **Step 2: Run crypto test and verify failure**

Run: `cd apps/text-vault && node --test web/js/crypto.test.js`

Expected: FAIL because crypto functions do not exist.

- [ ] **Step 3: Implement the v1 envelope exactly**

Use PBKDF2-HMAC-SHA-256 with a random 16-byte salt and 600,000 iterations to derive an AES-256-GCM key-encryption key. Generate a random 256-bit extractable data key, export raw bytes, and encrypt those bytes with a fresh 12-byte IV. Encrypt every object with the non-extractable imported data key and a fresh 12-byte IV. Use canonical UTF-8 JSON of `{schemaVersion:1,id,kind,revision}` as AES-GCM additional authenticated data.

Header shape:

```js
{
  schemaVersion: 1,
  kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 600000, salt: "base64" },
  wrap: { name: "AES-GCM", iv: "base64", ciphertext: "base64" }
}
```

Object envelope shape:

```js
{ schemaVersion: 1, algorithm: "AES-GCM", iv: "base64", ciphertext: "base64" }
```

Reject unknown versions, algorithms, iteration counts below 600,000, invalid base64, non-object decrypted JSON, and mismatched AAD metadata.

- [ ] **Step 4: Run frontend crypto tests**

Run: `cd apps/text-vault && node --test web/js/crypto.test.js`

Expected: PASS. The test may take approximately one second because it deliberately performs password derivation.

- [ ] **Step 5: Commit crypto boundary**

```bash
git add apps/text-vault/web/js/codec.js apps/text-vault/web/js/crypto.js apps/text-vault/web/js/crypto.test.js
git commit -m "feat: add browser encryption boundary"
```

---

### Task 5: Unified in-memory object repository and live search

**Files:**
- Create: `apps/text-vault/web/js/model.js`
- Create: `apps/text-vault/web/js/model.test.js`
- Create: `apps/text-vault/web/js/repository.js`
- Create: `apps/text-vault/web/js/repository.test.js`

**Interfaces:**
- Produces: `createEntry({id, now}) -> EntryV1`
- Produces: `createRepository(initialObjects) -> Repository`
- `Repository` exposes `get`, `upsert`, `remove`, `search`, `subscribe`, `dirtyObjects`, `markCommitted`, `isDirty`
- Consumes: decrypted objects from Task 4

- [ ] **Step 1: Write failing live-search and dirty-state tests**

```js
test("unsaved edits immediately change search results", () => {
  const repo = createRepository([{schemaVersion:1,id:"entry_1234567890",kind:"entry",text:"客户A old",properties:{},createdAt:"2026-08-29T00:00:00Z",updatedAt:"2026-08-29T00:00:00Z",revision:1}]);
  assert.equal(repo.search("1.2.3.4").length, 0);

  repo.updateEntryText("entry_1234567890", "客户A 1.2.3.4");

  assert.equal(repo.search("1.2.3.4")[0].id, "entry_1234567890");
  assert.equal(repo.isDirty(), true);
  assert.equal(repo.dirtyObjects().length, 1);
});
```

Add tests for unsaved new entries, Unicode case folding, empty query ordering by updated time, matching snippet generation, subscribers, committed snapshots, and edits made while a save snapshot is in flight.

- [ ] **Step 2: Run repository tests and verify failure**

Run: `cd apps/text-vault && node --test web/js/repository.test.js`

Expected: FAIL because repository functions are absent.

- [ ] **Step 3: Implement one source of truth**

Store objects in `Map<string, object>`, baseline revisions in a second map, and monotonically increasing local change sequence numbers in a third map. `updateEntryText` replaces the immutable object value, updates `updatedAt`, increments its local sequence, and synchronously notifies subscribers. `search` always reads the current map, never an editor-local buffer. Return `{id, snippet, updatedAt}` results without persisting them.

`dirtyObjects()` returns current values whose local sequence differs from their committed sequence. `markCommitted(commitSnapshot, returnedRevisions)` advances only objects whose sequence still equals the captured save sequence, so typing during a save remains globally dirty.

- [ ] **Step 4: Verify repository tests**

Run: `cd apps/text-vault && node --test web/js/model.test.js web/js/repository.test.js`

Expected: PASS.

- [ ] **Step 5: Commit repository**

```bash
git add apps/text-vault/web/js/model.js apps/text-vault/web/js/repository.js apps/text-vault/web/js/*.test.js
git commit -m "feat: add live memory repository"
```

---

### Task 6: Workspace data and bottom query tabs

**Files:**
- Create: `apps/text-vault/web/js/workspace.js`
- Create: `apps/text-vault/web/js/workspace.test.js`

**Interfaces:**
- Produces: `createWorkspace(initial) -> WorkspaceController`
- `WorkspaceController` exposes `state`, `setQuery`, `pinCurrent`, `selectTab`, `closeTab`, `selectEntry`, `showList`, `setSplitRatio`, `subscribe`
- Consumes: repository search results by current tab query

- [ ] **Step 1: Write failing workspace transition tests**

```js
test("tabs retain independent query selection and mobile pane", () => {
  const ws = createWorkspace();
  ws.setQuery("1.2.3.4");
  ws.selectEntry("entry_1234567890");
  const first = ws.state().activeTabId;
  ws.pinCurrent();
  ws.setQuery("example.com");
  ws.showList();
  ws.selectTab(first);

  assert.equal(ws.state().tabs.find(tab => tab.id === first).query, "1.2.3.4");
  assert.equal(ws.state().selectedEntryId, "entry_1234567890");
  assert.equal(ws.state().mobilePane, "content");
});
```

Add tests for the last tab not closing, horizontal tab order, scroll position, split-ratio clamping to 0.25–0.60, and serializing only durable workspace fields (not transient focus or IME state).

- [ ] **Step 2: Run workspace tests and verify failure**

Run: `cd apps/text-vault && node --test web/js/workspace.test.js`

Expected: FAIL because workspace controller is absent.

- [ ] **Step 3: Implement workspace as ordinary mutable data behind a controller**

Persist `schemaVersion`, `activeTabId`, ordered tabs with query/selection/scroll, `splitRatio`, and `theme`. Keep `mobilePane`, focus, dialogs, and viewport measurements ephemeral. Every controller action synchronously updates state and calls subscribers; the application will mirror the durable snapshot into the repository as the single `workspace_main` object so it participates in global dirty state and saving.

- [ ] **Step 4: Verify workspace tests**

Run: `cd apps/text-vault && node --test web/js/workspace.test.js`

Expected: PASS.

- [ ] **Step 5: Commit workspace**

```bash
git add apps/text-vault/web/js/workspace.js apps/text-vault/web/js/workspace.test.js
git commit -m "feat: model query tab workspace"
```

---

### Task 7: API client, vault bootstrap, and one global save coordinator

**Files:**
- Create: `apps/text-vault/web/js/api.js`
- Create: `apps/text-vault/web/js/save.js`
- Create: `apps/text-vault/web/js/save.test.js`
- Modify: `apps/text-vault/web/js/app.js`

**Interfaces:**
- Produces: `createAPI(fetchFn) -> {login, logout, snapshot, commit}`
- Produces: `createSaveCoordinator({repository, api, key, generation})`
- `SaveCoordinator` exposes `save()`, `status()`, `subscribe()`, `generation()`
- Consumes: Tasks 3–6

- [ ] **Step 1: Write failing global-save tests**

```js
test("one save commits every dirty object and preserves edits made in flight", async () => {
  const pending = Promise.withResolvers();
  const api = { commit: () => pending.promise };
  const testKey = await crypto.subtle.generateKey({name:"AES-GCM",length:256}, true, ["encrypt","decrypt"]);
  const repo = createRepository([
    {schemaVersion:1,id:"entry_1234567890",kind:"entry",text:"base",properties:{},createdAt:"2026-08-29T00:00:00Z",updatedAt:"2026-08-29T00:00:00Z",revision:1},
    {schemaVersion:1,id:"workspace_main_01",kind:"workspace",revision:1,state:{schemaVersion:1,activeTabId:"tab_main_00000001",tabs:[{id:"tab_main_00000001",query:"",selectedEntryId:"entry_1234567890",listScrollTop:0}],splitRatio:0.36,theme:"warm-paper"}}
  ]);
  repo.updateEntryText("entry_1234567890", "first edit");
  repo.upsert({...repo.get("workspace_main_01"),state:{...repo.get("workspace_main_01").state,tabs:[{...repo.get("workspace_main_01").state.tabs[0],query:"1.2.3.4"}]}});
  const saver = createSaveCoordinator({repository:repo, api, key:testKey, generation:3});

  const saving = saver.save();
  repo.updateEntryText("entry_1234567890", "second edit");
  pending.resolve({manifest:{generation:4,objects:{entry_1234567890:{revision:2},workspace_main:{revision:2}}}});
  await saving;

  assert.equal(saver.status(), "dirty");
  assert.equal(repo.get("entry_1234567890").text, "second edit");
});
```

Add tests for no-op save, all dirty kinds included, 401 switching to locked state, 409 conflict preserving memory, network failure preserving dirty state, and duplicate save clicks sharing one promise.

- [ ] **Step 2: Run save tests and verify failure**

Run: `cd apps/text-vault && node --test web/js/save.test.js`

Expected: FAIL because API and save coordinator are absent.

- [ ] **Step 3: Implement bootstrap and atomic save flow**

`api.js` sends same-origin JSON, stores the CSRF token only in module memory, and maps HTTP failures to typed `UnauthorizedError`, `ConflictError`, and `APIError`. Bootstrap logs into the server and retrieves the vault header. If the server returns 404, show a first-run form that requires the new vault password twice, calls `createVault`, uploads the header with `PUT /api/vault`, creates the initial workspace object, and performs the first global commit. Otherwise ask for the existing vault password, unlock the key, retrieve and decrypt the snapshot, validate schemas, then construct repository and workspace.

`save()` captures all dirty object values plus local sequence numbers, encrypts each with its proposed next revision, submits one commit with the current generation, and calls `markCommitted` only after success. Status is one of `clean`, `dirty`, `saving`, `failed`, `conflict`. Register `beforeunload` only while status is not `clean`; set `event.preventDefault()` and `event.returnValue = ""` without custom text.

- [ ] **Step 4: Verify all frontend logic tests**

Run: `cd apps/text-vault && node --test web/js/*.test.js`

Expected: PASS.

- [ ] **Step 5: Commit global persistence flow**

```bash
git add apps/text-vault/web/js/api.js apps/text-vault/web/js/save.js apps/text-vault/web/js/save.test.js apps/text-vault/web/js/app.js
git commit -m "feat: add global encrypted save flow"
```

---

### Task 8: Daily-use desktop interface

**Files:**
- Add: `apps/text-vault/web/vendor/van-1.6.1.js`
- Modify: `apps/text-vault/web/index.html`
- Modify: `apps/text-vault/web/styles.css`
- Modify: `apps/text-vault/web/js/app.js`
- Create: `apps/text-vault/tests/e2e/text-vault.spec.mjs`
- Create: `apps/text-vault/tests/e2e/setup.mjs`
- Create: `apps/text-vault/playwright.config.mjs`

**Interfaces:**
- Produces: accessible lock/login screen and desktop workspace
- Consumes: repository, workspace, and save coordinator

- [ ] **Step 1: Vendor VanJS and record provenance**

Download the pinned VanJS 1.6.1 ESM release from the official `vanjs-core` package, store it as `web/vendor/van-1.6.1.js`, and record its upstream URL, version, SHA-256 checksum, and MIT license notice in `README.md`. The running application must not contact a CDN.

- [ ] **Step 2: Write a failing desktop browser workflow**

```js
test("unsaved text is searchable across tabs and one save persists it", async ({ page }) => {
  await unlockSeededVault(page);
  await page.getByRole("button", {name:"新建条目"}).click();
  await page.getByRole("textbox", {name:"条目内容"}).fill("客户B 1.2.3.4 宝塔");
  await page.getByRole("searchbox", {name:"搜索条目"}).fill("1.2.3.4");
  await expect(page.getByRole("option", {name:/客户B/})).toBeVisible();
  await expect(page.getByText("未保存", {exact:true})).toBeVisible();
  await page.getByRole("button", {name:"保存", exact:true}).click();
  await expect(page.getByText("已保存", {exact:true})).toBeVisible();
});
```

In `playwright.config.mjs`, define Chromium and WebKit projects, `baseURL: "http://127.0.0.1:18081"`, `globalSetup: "./tests/e2e/setup.mjs"`, and web server command `go run ./cmd/text-vault -listen 127.0.0.1:18081 -data .tmp/e2e-data -secure-cookie=false` with `TEXT_VAULT_ACCESS_TOKEN=e2e-access-token`. `setup.mjs` uses `rm(".tmp/e2e-data", {recursive:true,force:true})` and `mkdir(".tmp/e2e-data", {recursive:true,mode:0o700})`; `.gitignore` excludes the explicit `.tmp/` directory. In the spec, `unlockSeededVault` logs in with that access token; on a fresh server it enters the fixed test-only vault password twice, creates the vault, adds a known `客户A` entry through the public UI, presses the sole Save button, and reloads/unlocks before returning. Never use production credentials in tests.

- [ ] **Step 3: Run the desktop workflow and verify failure**

Run: `cd apps/text-vault && npx playwright test tests/e2e/text-vault.spec.mjs --project=chromium`

Expected: FAIL because the workspace UI is absent. If Playwright is unavailable, install it only after requesting the required network approval.

- [ ] **Step 4: Implement the desktop workspace**

Render a full-height `100dvh` shell: left pane contains a 16px-or-larger search input, New button, result count, and keyboard-selectable result list; right pane contains a plain textarea, object metadata line, and the global state plus sole Save button; bottom contains horizontally scrollable query tabs and Pin/+ controls. A pointer/keyboard-accessible divider updates `splitRatio`. Use stable object IDs as VanJS keys so typing does not replace the textarea node or lose selection.

Render result snippets from current repository search on every repository or query update. Selecting a result changes only workspace selection. New entries enter the repository immediately. No internal navigation action checks dirty state.

- [ ] **Step 5: Verify desktop workflow and accessibility basics**

Run: `cd apps/text-vault && npx playwright test tests/e2e/text-vault.spec.mjs --project=chromium`

Expected: PASS with no console errors; Tab reaches search, results, editor, Save, and bottom tabs in a logical order.

- [ ] **Step 6: Commit desktop UI**

```bash
git add apps/text-vault/web apps/text-vault/tests/e2e apps/text-vault/playwright.config.mjs apps/text-vault/README.md
git commit -m "feat: build daily desktop workspace"
```

---

### Task 9: Mobile navigation and Smartisan-inspired theme

**Files:**
- Modify: `apps/text-vault/web/styles.css`
- Modify: `apps/text-vault/web/js/app.js`
- Modify: `apps/text-vault/tests/e2e/text-vault.spec.mjs`

**Interfaces:**
- Produces: top-search / middle-list-or-content / bottom-tabs mobile behavior
- Consumes: same repository and workspace data as desktop; no separate mobile state model

- [ ] **Step 1: Add a failing iPhone 13-sized workflow**

```js
test("mobile uses one middle pane and preserves live edits", async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  await unlockSeededVault(page);
  await page.getByRole("searchbox", {name:"搜索条目"}).fill("客户A");
  await page.getByRole("option", {name:/客户A/}).click();
  await expect(page.getByRole("textbox", {name:"条目内容"})).toBeVisible();
  await page.getByRole("textbox", {name:"条目内容"}).fill("客户A changed-token");
  await page.getByRole("button", {name:"返回结果"}).click();
  await page.getByRole("searchbox", {name:"搜索条目"}).fill("changed-token");
  await expect(page.getByRole("option", {name:/客户A/})).toBeVisible();
});
```

- [ ] **Step 2: Run mobile workflow and verify failure**

Run: `cd apps/text-vault && npx playwright test tests/e2e/text-vault.spec.mjs --grep mobile --project=webkit`

Expected: FAIL because responsive single-pane behavior is absent.

- [ ] **Step 3: Implement responsive behavior and theme tokens**

At widths below 720px, show a top bar containing Back (only in content pane), the 16px search input, global status, and Save; show exactly one middle pane selected by ephemeral `mobilePane`; keep bottom tabs fixed within the `100dvh` app and account for `env(safe-area-inset-bottom)`. Do not encode the query in the URL.

Define CSS custom properties for warm paper, raised paper, deep brown text, muted brown, dark red accent, borders, focus ring, and error colors. Use fine separators and restrained shadows rather than glass blur. Use a system sans stack for controls and a system monospace stack for the editor. All interactive targets are at least 44 CSS px on mobile.

- [ ] **Step 4: Verify Chromium and WebKit layouts**

Run: `cd apps/text-vault && npx playwright test tests/e2e/text-vault.spec.mjs --project=chromium --project=webkit`

Expected: PASS; no horizontal page scrolling, no input zoom caused by fonts below 16px, and bottom tabs remain reachable.

- [ ] **Step 5: Commit responsive theme**

```bash
git add apps/text-vault/web/styles.css apps/text-vault/web/js/app.js apps/text-vault/tests/e2e/text-vault.spec.mjs
git commit -m "feat: add mobile workspace and warm paper theme"
```

---

### Task 10: Backup, recovery, deployment, and release verification

**Files:**
- Modify: `apps/text-vault/internal/httpapi/api.go`
- Modify: `apps/text-vault/internal/httpapi/api_test.go`
- Modify: `apps/text-vault/cmd/text-vault/main.go`
- Modify: `apps/text-vault/README.md`
- Create: `apps/text-vault/deploy/text-vault.service`
- Create: `apps/text-vault/deploy/Caddyfile.example`

**Interfaces:**
- Produces: authenticated `GET /api/export` ciphertext archive
- Produces: documented empty-instance restore procedure
- Consumes: committed store and authenticated API

- [ ] **Step 1: Write a failing export/restore test**

```go
func TestExportRestoresIntoEmptyStore(t *testing.T) {
    source := seededStore(t)
    archive := exportStore(t, source)
    restoredRoot := t.TempDir()
    restoreArchive(t, restoredRoot, archive)
    restored, err := store.Open(restoredRoot)
    if err != nil { t.Fatal(err) }
    got, err := restored.Snapshot(context.Background())
    if err != nil { t.Fatal(err) }
    if got.Manifest.Generation != 1 || len(got.Objects) == 0 { t.Fatalf("snapshot = %#v", got) }
}
```

The archive test must also reject absolute paths, `..` traversal, symlinks, multiple database files, and a database that fails SQLite integrity checks.

- [ ] **Step 2: Run export test and verify failure**

Run: `cd apps/text-vault && go test ./internal/httpapi -run TestExportRestoresIntoEmptyStore -v`

Expected: FAIL because export is absent.

- [ ] **Step 3: Implement consistent ciphertext export and operational docs**

Use SQLite's online backup facility exposed by the driver to create a consistent temporary `text-vault.db`, then export that file as a tar.gz. Require session plus CSRF confirmation token for export. Never decrypt or reinterpret envelope contents. Document a restore drill that stops the service, moves an explicit existing data directory aside, extracts into a new empty directory, starts the binary, unlocks, verifies known records, and only then retains the backup as tested. Explicitly warn against copying only a live WAL-mode main file.

Document build (`go test ./...`, `go build ./cmd/text-vault`), local HTTP mode, production HTTPS mode, access-token generation, permissions (`0700` data directories, `0600` files), Caddy reverse proxy, systemd hardening, and scheduled encrypted directory backups. Do not include real hostnames, tokens, passwords, or user data.

- [ ] **Step 4: Run the full verification matrix**

Run: `cd apps/text-vault && go test -race ./...`

Expected: PASS.

Run: `cd apps/text-vault && node --test web/js/*.test.js`

Expected: PASS.

Run: `cd apps/text-vault && npx playwright test tests/e2e/text-vault.spec.mjs --project=chromium --project=webkit`

Expected: PASS with no console errors.

Run: `cd apps/text-vault && go vet ./... && go build ./cmd/text-vault`

Expected: PASS and produce a runnable `text-vault` binary.

- [ ] **Step 5: Perform the manual daily-use acceptance pass**

Create several records containing an IP, domain, customer, multiline shell command, and password-like text. Edit one record, switch through multiple bottom tabs without saving, search for the newly typed token, return to the edited record, execute the sole Save button, restart the process, unlock, and verify entries plus layout. Open a second browser session from the old generation and verify its save receives a conflict without overwriting the first session.

- [ ] **Step 6: Commit release readiness**

```bash
git add apps/text-vault/internal/httpapi apps/text-vault/cmd apps/text-vault/README.md apps/text-vault/deploy
git commit -m "docs: add text vault deployment and recovery"
```
