package panel

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMissingKeyDoesNotRegenerate(t *testing.T) {
	dir := t.TempDir()
	key := filepath.Join(dir, "master.key")
	s, e := Open(dir, key)
	if e != nil {
		t.Fatal(e)
	}
	s.Close()
	if e = os.Remove(key); e != nil {
		t.Fatal(e)
	}
	if s, e = Open(dir, key); e == nil {
		s.Close()
		t.Fatal("generated a new key over existing database")
	}
	if _, e = os.Stat(key); !os.IsNotExist(e) {
		t.Fatal("unexpected replacement key", e)
	}
}
func TestReopenPreservesPasswordAndFlagsInterruptedLocalWork(t *testing.T) {
	dir := t.TempDir()
	key := filepath.Join(dir, "master.key")
	s, e := Open(dir, key)
	if e != nil {
		t.Fatal(e)
	}
	n := Node{ID: ID(), Name: "test", Host: "127.0.0.1", Port: 22, User: "root", Fingerprint: "SHA256:test"}
	if e = s.SaveNode(n, "original-password"); e != nil {
		t.Fatal(e)
	}
	task := Task{ID: ID(), NodeID: n.ID, Status: "running", Step: "install"}
	if e = s.NewTask(task); e != nil {
		t.Fatal(e)
	}
	s.Close()
	s, e = Open(dir, key)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	_, p, e := s.GetNode(n.ID)
	if e != nil || p != "original-password" {
		t.Fatal(p, e)
	}
	restored, e := s.GetTask(task.ID)
	if e != nil || restored.Status != "needs_attention" {
		t.Fatal(restored, e)
	}
}

func TestUpdateNodePassword(t *testing.T) {
	a := newTestApp(t)
	n := Node{ID: ID(), Name: "n", Host: "127.0.0.1", Port: 22, User: "root", Fingerprint: "SHA256:old"}
	if e := a.Store.SaveNode(n, "old-password"); e != nil {
		t.Fatal(e)
	}
	if e := a.Store.UpdateNodePassword(n.ID, ""); e == nil {
		t.Fatal("expected empty password error")
	}
	if e := a.Store.UpdateNodePassword(n.ID, "new-password"); e != nil {
		t.Fatal(e)
	}
	_, pw, e := a.Store.GetNode(n.ID)
	if e != nil || pw != "new-password" {
		t.Fatalf("got %q %v", pw, e)
	}
}

func TestUpdateNodeFingerprint(t *testing.T) {
	a := newTestApp(t)
	n := Node{ID: ID(), Name: "n", Host: "127.0.0.1", Port: 22, User: "root", Fingerprint: "SHA256:old"}
	if e := a.Store.SaveNode(n, "pw"); e != nil {
		t.Fatal(e)
	}
	if e := a.Store.UpdateNodeFingerprint(n.ID, "bad"); e == nil {
		t.Fatal("expected invalid fingerprint error")
	}
	if e := a.Store.UpdateNodeFingerprint(n.ID, "SHA256:new"); e != nil {
		t.Fatal(e)
	}
	got, _, e := a.Store.GetNode(n.ID)
	if e != nil {
		t.Fatal(e)
	}
	if got.Fingerprint != "SHA256:new" {
		t.Fatalf("got %q", got.Fingerprint)
	}
}

func TestDismissTask(t *testing.T) {
	a := newTestApp(t)
	n := Node{ID: ID(), Name: "n", Host: "127.0.0.1", Port: 22, User: "root", Fingerprint: "SHA256:x"}
	if e := a.Store.SaveNode(n, "pw"); e != nil {
		t.Fatal(e)
	}
	id := ID()
	if e := a.Store.NewTask(Task{ID: id, NodeID: n.ID, SiteID: ID(), Status: "needs_attention", Step: "submit", Error: "SSH boom"}); e != nil {
		t.Fatal(e)
	}
	if e := a.Store.DismissTask(id); e != nil {
		t.Fatal(e)
	}
	got, e := a.Store.GetTask(id)
	if e != nil || got.Status != "dismissed" || !strings.HasPrefix(got.Error, "已忽略") {
		t.Fatalf("%+v %v", got, e)
	}
	nCount, e := a.Store.DismissNodeAttention(n.ID)
	if e != nil || nCount != 0 {
		t.Fatalf("count=%d err=%v", nCount, e)
	}
}
