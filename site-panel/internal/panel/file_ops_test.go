package panel

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"site-panel/internal/node"
)

func TestFileManagerOps(t *testing.T) {
	a := newTestApp(t)
	cookie, csrf := setup(t, a)
	n := Node{ID: ID(), Name: "n", Host: "127.0.0.1", Port: 22, User: "root", Fingerprint: "SHA256:test"}
	if e := a.Store.SaveNode(n, "password"); e != nil {
		t.Fatal(e)
	}
	s := Site{Site: node.Site{ID: ID(), Name: "site", Domains: []string{"example.test"}, Port: 80}, NodeID: n.ID, Enabled: true}
	if e := a.Store.SaveSite(s); e != nil {
		t.Fatal(e)
	}
	base := "/api/sites/" + s.ID
	if e := os.MkdirAll(filepath.Join(a.Store.Dir, "sites", s.ID), 0700); e != nil {
		t.Fatal(e)
	}
	w := request(t, a, "POST", base+"/file?path=a/hello.txt", "hi", cookie, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(t, a, "POST", base+"/mkdir", `{"path":"empty/dir"}`, cookie, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(t, a, "GET", base+"/files", "", cookie, csrf)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"dir":true`) || !strings.Contains(w.Body.String(), "empty/dir") {
		t.Fatal(w.Body.String())
	}
	w = request(t, a, "POST", base+"/rename", `{"from":"a/hello.txt","to":"a/hi.txt"}`, cookie, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(t, a, "GET", base+"/download?path=a/hi.txt", "", cookie, csrf)
	if w.Code != 200 || w.Body.String() != "hi" {
		t.Fatal(w.Code, w.Body.String())
	}
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	f, e := z.Create("nested/x.txt")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.Write([]byte("zipped")); e != nil {
		t.Fatal(e)
	}
	if e = z.Close(); e != nil {
		t.Fatal(e)
	}
	w = request(t, a, "POST", base+"/unzip?dest=pack", buf.String(), cookie, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	b, e := os.ReadFile(filepath.Join(a.Store.Dir, "sites", s.ID, "pack/nested/x.txt"))
	if e != nil || string(b) != "zipped" {
		t.Fatal(string(b), e)
	}
	w = request(t, a, "POST", base+"/unzip?dest=", mustZip(t, "../escape.txt", "no"), cookie, csrf)
	if w.Code != 400 {
		t.Fatal("accepted traversal", w.Code, w.Body.String())
	}
	w = request(t, a, "DELETE", base+"/file?path=a/hi.txt", "", cookie, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(t, a, "DELETE", base+"/file?path=pack", "", cookie, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if _, e = os.Stat(filepath.Join(a.Store.Dir, "sites", s.ID, "pack")); !os.IsNotExist(e) {
		t.Fatal("dir remained", e)
	}
}

func mustZip(t *testing.T, name, body string) string {
	t.Helper()
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	f, e := z.Create(name)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.Write([]byte(body)); e != nil {
		t.Fatal(e)
	}
	if e = z.Close(); e != nil {
		t.Fatal(e)
	}
	return buf.String()
}
