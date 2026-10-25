package panel

import (
	"archive/tar"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"site-panel/internal/node"
)

func TestSiteVarsAndBundleReplace(t *testing.T) {
	a := newTestApp(t)
	cookie, csrf := setup(t, a)
	n := Node{ID: ID(), Name: "n", Host: "127.0.0.1", Port: 22, User: "root", Fingerprint: "SHA256:test"}
	if e := a.Store.SaveNode(n, "password"); e != nil {
		t.Fatal(e)
	}
	s := Site{Site: node.Site{ID: ID(), Name: "site", Domains: []string{"example.test"}, Port: 80}, NodeID: n.ID, Enabled: true, PublishPath: DefaultPublishPath}
	if e := a.Store.SaveSite(s); e != nil {
		t.Fatal(e)
	}
	dir := filepath.Join(a.Store.Dir, "sites", s.ID, DefaultPublishPath)
	if e := os.MkdirAll(filepath.Join(dir, "assets"), 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(dir, "index.html"), []byte(`<a href="{{DOWNLOAD_URL}}">apk</a><span>{{TG_LINK}}</span>`), 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(dir, "assets/app.apk"), []byte("binary{{DOWNLOAD_URL}}"), 0600); e != nil {
		t.Fatal(e)
	}
	body := `{"vars":{"DOWNLOAD_URL":"https://dl.example/a.apk","TG_LINK":"https://t.me/x"}}`
	w := request(t, a, "PUT", "/api/sites/"+s.ID+"/vars", body, cookie, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var got Site
	if json.Unmarshal(w.Body.Bytes(), &got) != nil || got.Vars["DOWNLOAD_URL"] == "" {
		t.Fatal(w.Body.String())
	}
	w = request(t, a, "PUT", "/api/sites/"+s.ID+"/vars", `{"vars":{"BAD-NAME":"x"}}`, cookie, csrf)
	if w.Code != 400 {
		t.Fatal(w.Code, w.Body.String())
	}
	loaded, e := a.Store.GetSite(s.ID)
	if e != nil || loaded.Vars["TG_LINK"] != "https://t.me/x" {
		t.Fatal(loaded, e)
	}
	dest := filepath.Join(t.TempDir(), "bundle.tar")
	_, nReplace, e := a.bundleWithVars(s.ID, dest, loaded.Vars)
	if e != nil || nReplace != 2 {
		t.Fatal(nReplace, e)
	}
	raw, e := os.ReadFile(filepath.Join(dir, "index.html"))
	if e != nil || !strings.Contains(string(raw), "{{DOWNLOAD_URL}}") {
		t.Fatal("master original changed", string(raw))
	}
	f, e := os.Open(dest)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	tr := tar.NewReader(f)
	found := map[string]string{}
	for {
		h, e := tr.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			t.Fatal(e)
		}
		b, e := io.ReadAll(tr)
		if e != nil {
			t.Fatal(e)
		}
		found[h.Name] = string(b)
	}
	if !strings.Contains(found["index.html"], "https://dl.example/a.apk") || strings.Contains(found["index.html"], "{{") {
		t.Fatal(found["index.html"])
	}
	if found["assets/app.apk"] != "binary{{DOWNLOAD_URL}}" {
		t.Fatal("apk should stay untouched", found["assets/app.apk"])
	}
}

func TestApplyVarsLongerKeyFirst(t *testing.T) {
	out, n := applyVars("{{A}} {{AB}}", map[string]string{"A": "1", "AB": "2"})
	if out != "1 2" || n != 2 {
		t.Fatal(out, n)
	}
}
