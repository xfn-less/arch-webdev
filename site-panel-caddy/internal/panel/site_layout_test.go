package panel

import (
	"os"
	"path/filepath"
	"testing"

	"site-panel/internal/node"
)

func TestEnsureSiteWorkspaceMigratesAndBundlesPublishDir(t *testing.T) {
	a := newTestApp(t)
	n := Node{ID: ID(), Name: "n", Host: "127.0.0.1", Port: 22, User: "root", Fingerprint: "SHA256:test"}
	if e := a.Store.SaveNode(n, "password"); e != nil {
		t.Fatal(e)
	}
	s := Site{Site: node.Site{ID: ID(), Name: "site", Domains: []string{"example.test"}, Port: 80}, NodeID: n.ID, Enabled: true, PublishPath: DefaultPublishPath}
	if e := a.Store.SaveSite(s); e != nil {
		t.Fatal(e)
	}
	root := filepath.Join(a.Store.Dir, "sites", s.ID)
	if e := os.MkdirAll(root, 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(root, "index.html"), []byte("live"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(root, "scratch.txt"), []byte("tmp"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := a.ensurePublishDir(s.ID, DefaultPublishPath); e != nil {
		t.Fatal(e)
	}
	if _, e := os.Stat(filepath.Join(root, DefaultPublishPath, "index.html")); e != nil {
		t.Fatal("expected migrate into site/", e)
	}
	// playground leftover after first ensure should not happen; both moved.
	if _, e := os.Stat(filepath.Join(root, "index.html")); !os.IsNotExist(e) {
		t.Fatal("root index should have moved")
	}
	// add playground-only file after publish dir exists
	if e := os.WriteFile(filepath.Join(root, "dist-note.txt"), []byte("play"), 0600); e != nil {
		t.Fatal(e)
	}
	dest := filepath.Join(t.TempDir(), "b.tar")
	_, _, e := a.bundleWithVars(s.ID, dest, nil)
	if e != nil {
		t.Fatal(e)
	}
	// unique names
	if g := uniqueChildName(root, "dist"); g != "dist" {
		t.Fatal(g)
	}
	_ = os.MkdirAll(filepath.Join(root, "dist"), 0700)
	if g := uniqueChildName(root, "dist"); g != "dist-2" {
		t.Fatal(g)
	}
}
