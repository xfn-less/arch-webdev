package panel

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"site-panel/internal/node"
)

func TestArchiveSingleRoot(t *testing.T) {
	ents := func(names ...string) []archiveEntry {
		out := make([]archiveEntry, 0, len(names))
		for _, n := range names {
			out = append(out, archiveEntry{Name: n})
		}
		return out
	}
	if g := archiveSingleRoot(ents("dist/index.html", "dist/app.js")); g != "dist" {
		t.Fatalf("folder pack: %q", g)
	}
	if g := archiveSingleRoot(ents("index.html", "app.js")); g != "" {
		t.Fatalf("flat pack: %q", g)
	}
	if g := archiveSingleRoot(ents("a/x", "b/y")); g != "" {
		t.Fatalf("multi root: %q", g)
	}
}

func mustGzipTar(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	for name, body := range files {
		h := &tar.Header{Name: name, Mode: 0644, Size: int64(len(body))}
		if e := tw.WriteHeader(h); e != nil {
			t.Fatal(e)
		}
		if _, e := tw.Write([]byte(body)); e != nil {
			t.Fatal(e)
		}
	}
	if e := tw.Close(); e != nil {
		t.Fatal(e)
	}
	if e := gw.Close(); e != nil {
		t.Fatal(e)
	}
	return buf.Bytes()
}

func TestUnzipFolderOrSpread(t *testing.T) {
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
	if e := os.MkdirAll(filepath.Join(a.Store.Dir, "sites", s.ID), 0700); e != nil {
		t.Fatal(e)
	}
	base := "/api/sites/" + s.ID

	// folder-packed zip -> create folder
	var zbuf bytes.Buffer
	zw := zip.NewWriter(&zbuf)
	f, e := zw.Create("dist/index.html")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.Write([]byte("hi")); e != nil {
		t.Fatal(e)
	}
	_ = zw.Close()
	w := request(t, a, "POST", base+"/unzip?dest=web&filename=dist.zip", zbuf.String(), cookie, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	b, e := os.ReadFile(filepath.Join(a.Store.Dir, "sites", s.ID, "web/index.html"))
	if e != nil || string(b) != "hi" {
		t.Fatal(string(b), e)
	}
	if _, e = os.Stat(filepath.Join(a.Store.Dir, "sites", s.ID, "web/dist/index.html")); !os.IsNotExist(e) {
		t.Fatal("should strip inner folder")
	}

	// flat tar.gz -> spread to root
	body := mustGzipTar(t, map[string]string{"app.js": "console.log(1)"})
	w = request(t, a, "POST", base+"/unzip?dest=&filename=flat.tar.gz", string(body), cookie, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "tar.gz") {
		t.Fatal(w.Body.String())
	}
	b, e = os.ReadFile(filepath.Join(a.Store.Dir, "sites", s.ID, "app.js"))
	if e != nil || string(b) != "console.log(1)" {
		t.Fatal(string(b), e)
	}
}
