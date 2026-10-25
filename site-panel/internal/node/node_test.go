package node

import (
	"archive/tar"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func archive(t *testing.T, name string, kind byte, content string) []byte {
	t.Helper()
	var b bytes.Buffer
	tw := tar.NewWriter(&b)
	h := &tar.Header{Name: name, Mode: 0644, Typeflag: kind}
	if kind == tar.TypeReg {
		h.Size = int64(len(content))
	}
	if e := tw.WriteHeader(h); e != nil {
		t.Fatal(e)
	}
	if kind == tar.TypeReg {
		_, _ = tw.Write([]byte(content))
	}
	if e := tw.Close(); e != nil {
		t.Fatal(e)
	}
	return b.Bytes()
}
func TestExtractRejectsUnsafeArchives(t *testing.T) {
	for _, name := range []string{"../escape", "/etc/escape", "a/../../escape", "a\\..\\escape"} {
		t.Run(name, func(t *testing.T) {
			if e := Extract(bytes.NewReader(archive(t, name, tar.TypeReg, "bad")), t.TempDir(), 100); e == nil {
				t.Fatal("accepted unsafe path")
			}
		})
	}
	if e := Extract(bytes.NewReader(archive(t, "link", tar.TypeSymlink, "")), t.TempDir(), 100); e == nil {
		t.Fatal("accepted symlink")
	}
	if e := Extract(bytes.NewReader(archive(t, "big", tar.TypeReg, "12345")), t.TempDir(), 4); e == nil {
		t.Fatal("accepted oversized archive")
	}
}
func TestExtractFiles(t *testing.T) {
	d := t.TempDir()
	if e := Extract(bytes.NewReader(archive(t, "assets/a.js", tar.TypeReg, "hello")), d, 100); e != nil {
		t.Fatal(e)
	}
	b, e := os.ReadFile(filepath.Join(d, "assets/a.js"))
	if e != nil || string(b) != "hello" {
		t.Fatalf("%s %v", b, e)
	}
}
func TestValidateNginxConfig(t *testing.T) {
	if e := ValidateNginxConfig("server {\n}\n"); e != nil {
		t.Fatal(e)
	}
	for _, bad := range []string{"", "listen 80;", "server {", string([]byte{0xff, 0xfe}) + "server {}\n", "server {\x00}\n"} {
		if ValidateNginxConfig(bad) == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}
func TestSiteConfigValidation(t *testing.T) {
	s := Site{ID: strings.Repeat("a", 32), Name: "test", Domains: []string{"example.com", "www.example.com"}, Port: 8080}
	c, e := s.Config()
	if e != nil || !strings.Contains(c, "server_name example.com www.example.com;") {
		t.Fatal(c, e)
	}
	for _, host := range []string{"a; root /etc;", "*.example.com", "a\n}", "http://example.com", "a..b"} {
		s.Domains = []string{host}
		if e := s.Validate(); e == nil {
			t.Fatalf("accepted %q", host)
		}
	}
	s.Domains = []string{"example.com"}
	s.Port = 22
	if s.Validate() == nil {
		t.Fatal("accepted SSH port")
	}
}
func TestTaskIDs(t *testing.T) {
	for _, s := range []string{"../bad", ";id", "", "a"} {
		if _, e := TaskDir(s); e == nil {
			t.Fatal("accepted bad id")
		}
	}
}
func TestAtomicJSON(t *testing.T) {
	p := filepath.Join(t.TempDir(), "state.json")
	if e := AtomicJSON(p, map[string]string{"state": "done"}); e != nil {
		t.Fatal(e)
	}
	st, e := os.Stat(p)
	if e != nil {
		t.Fatal(e)
	}
	if st.Mode().Perm() != 0600 {
		t.Fatal(st.Mode())
	}
}
