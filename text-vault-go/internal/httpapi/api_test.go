package httpapi

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/xfn/text-vault/internal/auth"
	"github.com/xfn/text-vault/internal/store"
)

func TestHealthAndSPA(t *testing.T) {
	h := New(Config{Frontend: fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<main>Text Vault</main>")},
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

	nested := httptest.NewRecorder()
	h.ServeHTTP(nested, httptest.NewRequest(http.MethodGet, "/anything", nil))
	if nested.Code != http.StatusOK || !strings.Contains(nested.Body.String(), "Text Vault") {
		t.Fatalf("spa fallback = %d %q", nested.Code, nested.Body.String())
	}
}

var _ fs.FS = fstest.MapFS{}

func TestProtectedVaultSnapshotAndCommit(t *testing.T) {
	h := newTestAPI(t)

	denied := httptest.NewRecorder()
	h.ServeHTTP(denied, httptest.NewRequest(http.MethodGet, "/api/snapshot", nil))
	if denied.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized snapshot = %d", denied.Code)
	}

	login := httptest.NewRecorder()
	credential := strings.Repeat("A", 43)
	setupRequest := httptest.NewRequest(http.MethodPost, "/api/setup", strings.NewReader(`{"header":{"schemaVersion":1,"auth":{"salt":"AA=="}},"credential":"`+credential+`"}`))
	setupRequest.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(login, setupRequest)
	if login.Code != http.StatusOK {
		t.Fatalf("setup = %d %s", login.Code, login.Body.String())
	}
	cookie := login.Result().Cookies()[0]
	csrf := login.Header().Get("X-CSRF-Token")

	commitRequest := httptest.NewRequest(http.MethodPost, "/api/commit", strings.NewReader(`{"baseGeneration":0,"objects":[{"id":"268t00000","kind":"entry","revision":1,"envelope":{"ciphertext":"AA=="}}]}`))
	commitRequest.AddCookie(cookie)
	commitRequest.Header.Set("X-CSRF-Token", csrf)
	commitRequest.Header.Set("Content-Type", "application/json")
	commitResponse := httptest.NewRecorder()
	h.ServeHTTP(commitResponse, commitRequest)
	if commitResponse.Code != http.StatusOK {
		t.Fatalf("commit = %d %s", commitResponse.Code, commitResponse.Body.String())
	}

	snapshotRequest := httptest.NewRequest(http.MethodGet, "/api/snapshot", nil)
	snapshotRequest.AddCookie(cookie)
	snapshotResponse := httptest.NewRecorder()
	h.ServeHTTP(snapshotResponse, snapshotRequest)
	if snapshotResponse.Code != http.StatusOK {
		t.Fatalf("snapshot = %d %s", snapshotResponse.Code, snapshotResponse.Body.String())
	}
	var snapshot store.Snapshot
	if err := json.NewDecoder(snapshotResponse.Body).Decode(&snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.Manifest.Generation != 1 || snapshot.Objects["268t00000"].Revision != 1 {
		t.Fatalf("snapshot = %#v", snapshot)
	}

	changesRequest := httptest.NewRequest(http.MethodGet, "/api/changes?after=0", nil)
	changesRequest.AddCookie(cookie)
	changesResponse := httptest.NewRecorder()
	h.ServeHTTP(changesResponse, changesRequest)
	if changesResponse.Code != http.StatusOK {
		t.Fatalf("changes = %d %s", changesResponse.Code, changesResponse.Body.String())
	}
	var changes store.Changes
	if err := json.NewDecoder(changesResponse.Body).Decode(&changes); err != nil {
		t.Fatal(err)
	}
	if changes.Generation != 1 || changes.Objects["268t00000"].Revision != 1 {
		t.Fatalf("changes = %#v", changes)
	}

	invalidRequest := httptest.NewRequest(http.MethodGet, "/api/changes?after=nope", nil)
	invalidRequest.AddCookie(cookie)
	invalidResponse := httptest.NewRecorder()
	h.ServeHTTP(invalidResponse, invalidRequest)
	if invalidResponse.Code != http.StatusBadRequest {
		t.Fatalf("invalid changes = %d %s", invalidResponse.Code, invalidResponse.Body.String())
	}
}

func newTestAPI(t *testing.T) http.Handler {
	t.Helper()
	database, err := store.Open(filepath.Join(t.TempDir(), "text-vault.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	sessions, err := auth.New(nil, false)
	if err != nil {
		t.Fatal(err)
	}
	return New(Config{
		Frontend: fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("Text Vault")}},
		Store:    database,
		Auth:     sessions,
	})
}

func TestSetupRejectsMalformedDerivedCredential(t *testing.T) {
	h := newTestAPI(t)
	request := httptest.NewRequest(http.MethodPost, "/api/setup", strings.NewReader(`{"header":{"schemaVersion":1},"credential":"!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("malformed credential status = %d body=%s", response.Code, response.Body.String())
	}
}

func TestAPIResponsesAreNeverCached(t *testing.T) {
	h := newTestAPI(t)
	response := httptest.NewRecorder()
	h.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/vault", nil))
	if response.Code != http.StatusNotFound {
		t.Fatalf("vault status = %d", response.Code)
	}
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}

	health := httptest.NewRecorder()
	h.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if got := health.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("health Cache-Control = %q", got)
	}
	page := httptest.NewRecorder()
	h.ServeHTTP(page, httptest.NewRequest(http.MethodGet, "/", nil))
	if got := page.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("page Cache-Control = %q", got)
	}
}

func TestRekeyRotatesServerAuthentication(t *testing.T) {
	h := newTestAPI(t)
	oldCredential := strings.Repeat("A", 43)
	newCredential := strings.Repeat("B", 43)
	setup := httptest.NewRecorder()
	setupRequest := httptest.NewRequest(http.MethodPost, "/api/setup", strings.NewReader(`{"header":{"schemaVersion":1,"name":"old"},"credential":"`+oldCredential+`"}`))
	setupRequest.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(setup, setupRequest)

	rekey := httptest.NewRecorder()
	rekeyRequest := httptest.NewRequest(http.MethodPost, "/api/rekey", strings.NewReader(`{"header":{"schemaVersion":1,"name":"new"},"credential":"`+newCredential+`"}`))
	rekeyRequest.Header.Set("Content-Type", "application/json")
	rekeyRequest.Header.Set("X-CSRF-Token", setup.Header().Get("X-CSRF-Token"))
	rekeyRequest.AddCookie(setup.Result().Cookies()[0])
	h.ServeHTTP(rekey, rekeyRequest)
	if rekey.Code != http.StatusOK || rekey.Header().Get("X-CSRF-Token") == "" || len(rekey.Result().Cookies()) == 0 {
		t.Fatalf("rekey = %d %s", rekey.Code, rekey.Body.String())
	}

	for _, check := range []struct {
		credential string
		want       int
	}{{newCredential, http.StatusOK}, {oldCredential, http.StatusUnauthorized}} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(`{"credential":"`+check.credential+`"}`))
		request.Header.Set("Content-Type", "application/json")
		h.ServeHTTP(response, request)
		if response.Code != check.want {
			t.Fatalf("credential %.4q status = %d want %d", check.credential, response.Code, check.want)
		}
	}
}
