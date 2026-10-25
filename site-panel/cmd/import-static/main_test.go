package main

import (
	"os"
	"path/filepath"
	"testing"

	"site-panel/internal/node"
	"site-panel/internal/panel"
)

func TestImportPreservesSiteIDAndRefusesOverwrite(t *testing.T) {
	data := t.TempDir()
	key := filepath.Join(data, "master.key")
	store, e := panel.Open(data, key)
	if e != nil {
		t.Fatal(e)
	}
	n := panel.Node{ID: panel.ID(), Name: "existing customer", Host: "127.0.0.1", Port: 22, User: "root", Fingerprint: "SHA256:test"}
	if e = store.SaveNode(n, "saved-password"); e != nil {
		t.Fatal(e)
	}
	store.Close()
	source := t.TempDir()
	if e = os.WriteFile(filepath.Join(source, "index.html"), []byte("original"), 0600); e != nil {
		t.Fatal(e)
	}
	spec := node.Site{ID: panel.ID(), Name: "demo", Domains: []string{"127.0.0.1"}, Port: 18080}
	if e = run(data, key, n.ID, source, spec); e != nil {
		t.Fatal(e)
	}
	if e = run(data, key, n.ID, source, spec); e == nil {
		t.Fatal("overwrote existing site")
	}
	store, e = panel.Open(data, key)
	if e != nil {
		t.Fatal(e)
	}
	defer store.Close()
	s, e := store.GetSite(spec.ID)
	if e != nil || s.NodeID != n.ID {
		t.Fatal(s, e)
	}
	_, password, e := store.GetNode(n.ID)
	if e != nil || password != "saved-password" {
		t.Fatal("changed credentials", e)
	}
	b, e := os.ReadFile(filepath.Join(data, "sites", spec.ID, "index.html"))
	if e != nil || string(b) != "original" {
		t.Fatal(string(b), e)
	}
}
