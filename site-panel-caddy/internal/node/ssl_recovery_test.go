package node

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCertbotStateRestoreIncludesLinksAndRenewal(t *testing.T) {
	root := t.TempDir()
	id := "test"
	live := filepath.Join(root, "config/live/site-"+id)
	renew := filepath.Join(root, "config/renewal/site-"+id+".conf")
	if e := os.MkdirAll(live, 0700); e != nil {
		t.Fatal(e)
	}
	_ = os.MkdirAll(filepath.Dir(renew), 0700)
	_ = os.WriteFile(renew, []byte("old renewal config"), 0600)
	for _, name := range []string{"cert.pem", "chain.pem", "fullchain.pem", "privkey.pem"} {
		if e := os.Symlink("old-"+name, filepath.Join(live, name)); e != nil {
			t.Fatal(e)
		}
	}
	restore, e := saveCertbotStateAt(root, id)
	if e != nil {
		t.Fatal(e)
	}
	for _, name := range []string{"cert.pem", "chain.pem", "fullchain.pem", "privkey.pem"} {
		_ = os.Remove(filepath.Join(live, name))
		_ = os.Symlink("new-"+name, filepath.Join(live, name))
	}
	_ = os.WriteFile(renew, []byte("new renewal config"), 0600)
	if e = restore(); e != nil {
		t.Fatal(e)
	}
	for _, name := range []string{"cert.pem", "chain.pem", "fullchain.pem", "privkey.pem"} {
		target, e := os.Readlink(filepath.Join(live, name))
		if e != nil || target != "old-"+name {
			t.Fatal(target, e)
		}
	}
	b, e := os.ReadFile(renew)
	if e != nil || string(b) != "old renewal config" {
		t.Fatal(string(b), e)
	}
}
