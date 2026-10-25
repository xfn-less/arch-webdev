package panel

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"site-panel/internal/node"
)

func newTestApp(t *testing.T) *App {
	t.Helper()
	d := t.TempDir()
	s, e := Open(d, filepath.Join(d, "master.key"))
	if e != nil {
		t.Fatal(e)
	}
	a := New(s, "", "/not-built", fstest.MapFS{"index.html": {Data: []byte("test")}})
	t.Cleanup(func() { a.Close(); s.Close() })
	return a
}
func request(t *testing.T, a *App, method, path, body string, cookie *http.Cookie, csrf string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if cookie != nil {
		r.AddCookie(cookie)
	}
	if csrf != "" {
		r.Header.Set("X-CSRF-Token", csrf)
	}
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	return w
}
func setup(t *testing.T, a *App) (*http.Cookie, string) {
	t.Helper()
	w := request(t, a, "POST", "/api/setup", `{"password":"test-password-long"}`, nil, "")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var v map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &v)
	return w.Result().Cookies()[0], v["csrf"]
}
func TestAuthSessionAndCSRF(t *testing.T) {
	a := newTestApp(t)
	if w := request(t, a, "GET", "/api/nodes", "", nil, ""); w.Code != 401 {
		t.Fatal(w.Code)
	}
	c, csrf := setup(t, a)
	if w := request(t, a, "GET", "/api/nodes", "", c, ""); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := request(t, a, "POST", "/api/logout", "", c, ""); w.Code != 403 {
		t.Fatal(w.Code)
	}
	a.rateMu.Lock()
	a.lastLogin = time.Time{}
	a.rateMu.Unlock()
	w := request(t, a, "POST", "/api/login", `{"password":"test-password-long"}`, nil, "")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w = request(t, a, "GET", "/api/nodes", "", c, csrf); w.Code != 401 {
		t.Fatal("old session survived", w.Code)
	}
}
func TestOriginAndCSP(t *testing.T) {
	a := newTestApp(t)
	r := httptest.NewRequest("POST", "http://localhost/api/setup", strings.NewReader(`{"password":"test-password-long"}`))
	r.Header.Set("Origin", "https://evil.example")
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
	if !strings.Contains(w.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") {
		t.Fatal("no CSP")
	}
}
func TestEncryptedPasswords(t *testing.T) {
	a := newTestApp(t)
	id := ID()
	n := Node{ID: id, Name: "node", Host: "127.0.0.1", Port: 22, User: "root", Fingerprint: "SHA256:test"}
	const secret = "top-secret-password"
	if e := a.Store.SaveNode(n, secret); e != nil {
		t.Fatal(e)
	}
	_, password, e := a.Store.GetNode(id)
	if e != nil || password != secret {
		t.Fatal(e)
	}
	var raw []byte
	if e = a.Store.db.QueryRow(`SELECT password FROM nodes WHERE id=?`, id).Scan(&raw); e != nil {
		t.Fatal(e)
	}
	if bytes.Contains(raw, []byte(secret)) {
		t.Fatal("plaintext stored")
	}
	raw[len(raw)-1] ^= 1
	if _, e = a.Store.db.Exec(`UPDATE nodes SET password=? WHERE id=?`, raw, id); e != nil {
		t.Fatal(e)
	}
	if _, _, e = a.Store.GetNode(id); e == nil {
		t.Fatal("accepted tampered ciphertext")
	}
}
func TestFilesAndBundle(t *testing.T) {
	a := newTestApp(t)
	c, csrf := setup(t, a)
	n := Node{ID: ID(), Name: "node", Host: "127.0.0.1", Port: 22, User: "root", Fingerprint: "SHA256:test"}
	if e := a.Store.SaveNode(n, "password"); e != nil {
		t.Fatal(e)
	}
	s := Site{Site: node.Site{ID: ID(), Name: "site", Domains: []string{"example.com"}, Port: 8080}, NodeID: n.ID, PublishPath: DefaultPublishPath}
	if e := a.Store.SaveSite(s); e != nil {
		t.Fatal(e)
	}
	if e := os.MkdirAll(filepath.Join(a.Store.Dir, "sites", s.ID), 0700); e != nil {
		t.Fatal(e)
	}
	base := "/api/sites/" + s.ID
	w := request(t, a, "POST", base+"/file?path=site/index.html", "<h1>hello</h1>", c, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(t, a, "GET", base+"/file?path=site/index.html", "", c, csrf)
	if w.Code != 200 || w.Body.String() != "<h1>hello</h1>" {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, p := range []string{"../escape", "/etc/passwd", "a%5C..%5Cb"} {
		w = request(t, a, "POST", base+"/file?path="+p, "bad", c, csrf)
		if w.Code != 400 {
			t.Fatalf("accepted %q: %d", p, w.Code)
		}
	}
	dest := filepath.Join(t.TempDir(), "bundle.tar")
	digest, e := a.bundle(s.ID, dest)
	if e != nil || len(digest) != 64 {
		t.Fatal(digest, e)
	}
	f, e := os.Open(dest)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	out := t.TempDir()
	if e = node.Extract(f, out, 1<<20); e != nil {
		t.Fatal(e)
	}
	b, e := os.ReadFile(filepath.Join(out, "index.html"))
	if e != nil || string(b) != "<h1>hello</h1>" {
		t.Fatal(e, string(b))
	}
	outside := filepath.Join(t.TempDir(), "secret")
	_ = os.WriteFile(outside, []byte("hidden"), 0600)
	if e = os.Symlink(outside, filepath.Join(a.Store.Dir, "sites", s.ID, "link")); e != nil {
		t.Fatal(e)
	}
	w = request(t, a, "GET", base+"/file?path=link", "", c, csrf)
	if w.Code == 200 {
		t.Fatal("symlink escaped root")
	}
}
func TestCorruptAndUnknownInputs(t *testing.T) {
	a := newTestApp(t)
	c, csrf := setup(t, a)
	w := request(t, a, "POST", "/api/nodes", `{"unexpected":true}`, c, csrf)
	if w.Code != 400 {
		t.Fatal(w.Code)
	}
	w = request(t, a, "GET", "/api/unknown", "", c, csrf)
	if w.Code != 404 {
		t.Fatal(w.Code)
	}
	r := httptest.NewRequest("GET", "/", nil)
	res := httptest.NewRecorder()
	a.ServeHTTP(res, r)
	b, _ := io.ReadAll(res.Result().Body)
	if string(b) != "test" {
		t.Fatal(string(b))
	}
}
