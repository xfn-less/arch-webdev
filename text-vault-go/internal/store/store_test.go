package store

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
)

func TestEntryIDsUseMemoFormat(t *testing.T) {
	valid := []CipherObject{{ID: "2696d0700", Kind: "entry", Revision: 1, Envelope: json.RawMessage(`{"ciphertext":"AA=="}`)}}
	if err := validateObjects(valid); err != nil {
		t.Fatalf("valid memo id: %v", err)
	}
	invalid := []CipherObject{{ID: "entry_1234567890", Kind: "entry", Revision: 1, Envelope: json.RawMessage(`{"ciphertext":"AA=="}`)}}
	if err := validateObjects(invalid); err == nil {
		t.Fatal("legacy entry id accepted")
	}
}

func TestCommitPublishesBatchAndRejectsStaleBase(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "text-vault.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })

	first, err := s.Commit(ctx, CommitRequest{
		BaseGeneration: 0,
		Objects: []CipherObject{
			{ID: "268t00000", Kind: "entry", Revision: 1, Envelope: json.RawMessage(`{"ciphertext":"AA=="}`)},
			{ID: "workspace_main_01", Kind: "workspace", Revision: 1, Envelope: json.RawMessage(`{"ciphertext":"AQ=="}`)},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.Generation != 1 || first.Objects["268t00000"].Revision != 1 {
		t.Fatalf("manifest = %#v", first)
	}

	_, err = s.Commit(ctx, CommitRequest{
		BaseGeneration: 0,
		Objects: []CipherObject{
			{ID: "268t00001", Kind: "entry", Revision: 1, Envelope: json.RawMessage(`{"ciphertext":"Ag=="}`)},
		},
	})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("stale commit error = %v", err)
	}

	snapshot, err := s.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Manifest.Generation != 1 || len(snapshot.Objects) != 2 {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	if _, exists := snapshot.Objects["268t00001"]; exists {
		t.Fatal("stale batch became visible")
	}
}

func TestChangesReturnsLatestObjectsAfterGeneration(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "text-vault.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })

	first := CipherObject{ID: "268t00000", Kind: "entry", Revision: 1, Envelope: json.RawMessage(`{"value":"first"}`)}
	second := CipherObject{ID: "268t00001", Kind: "entry", Revision: 1, Envelope: json.RawMessage(`{"value":"second"}`)}
	if _, err := s.Commit(ctx, CommitRequest{BaseGeneration: 0, Objects: []CipherObject{first}}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Commit(ctx, CommitRequest{BaseGeneration: 1, Objects: []CipherObject{second}}); err != nil {
		t.Fatal(err)
	}
	first.Revision = 2
	first.Envelope = json.RawMessage(`{"value":"newest"}`)
	if _, err := s.Commit(ctx, CommitRequest{BaseGeneration: 2, Objects: []CipherObject{first}}); err != nil {
		t.Fatal(err)
	}

	changes, err := s.Changes(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if changes.Generation != 3 || len(changes.Objects) != 2 {
		t.Fatalf("changes = %#v", changes)
	}
	if changes.Objects["268t00000"].Revision != 2 || string(changes.Objects["268t00000"].Envelope) != `{"value":"newest"}` {
		t.Fatalf("first object = %#v", changes.Objects["268t00000"])
	}
}

func TestCommitRollsBackWholeBatchOnInvalidRevision(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "text-vault.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })

	_, err = s.Commit(ctx, CommitRequest{BaseGeneration: 0, Objects: []CipherObject{
		{ID: "268t00002", Kind: "entry", Revision: 1, Envelope: json.RawMessage(`{"ciphertext":"AA=="}`)},
		{ID: "268t00003", Kind: "entry", Revision: 2, Envelope: json.RawMessage(`{"ciphertext":"AQ=="}`)},
	}})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("commit error = %v", err)
	}

	snapshot, err := s.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Manifest.Generation != 0 || len(snapshot.Objects) != 0 {
		t.Fatalf("partial batch visible: %#v", snapshot)
	}
}

func TestVaultHeaderIsCreateOnlyAndSurvivesReopen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "text-vault.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	header := json.RawMessage(`{"schemaVersion":1,"wrappedKey":"AA=="}`)
	if err := s.CreateVaultHeader(ctx, header); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateVaultHeader(ctx, header); !errors.Is(err, ErrConflict) {
		t.Fatalf("second create error = %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	got, err := s.VaultHeader(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(header) {
		t.Fatalf("header = %s", got)
	}
}

func TestBackupCreatesAConsistentReopenableDatabase(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "live.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if _, err := s.Commit(ctx, CommitRequest{BaseGeneration: 0, Objects: []CipherObject{
		{ID: "268t00004", Kind: "entry", Revision: 1, Envelope: json.RawMessage(`{"ciphertext":"AA=="}`)},
	}}); err != nil {
		t.Fatal(err)
	}

	backupPath := filepath.Join(dir, "backup.db")
	if err := s.Backup(ctx, backupPath); err != nil {
		t.Fatal(err)
	}
	backup, err := Open(backupPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = backup.Close() })
	snapshot, err := backup.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Manifest.Generation != 1 || snapshot.Objects["268t00004"].Revision != 1 {
		t.Fatalf("backup snapshot = %#v", snapshot)
	}
}

func TestVaultSetupStoresHeaderAndAuthenticationHashAtomically(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "text-vault.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })

	header := json.RawMessage(`{"schemaVersion":1,"auth":{"salt":"AA=="}}`)
	authHash := []byte("01234567890123456789012345678901")
	if err := s.CreateVault(ctx, header, authHash); err != nil {
		t.Fatal(err)
	}
	gotHash, err := s.AuthHash(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotHash) != string(authHash) {
		t.Fatalf("auth hash = %x", gotHash)
	}
	if err := s.CreateVault(ctx, header, authHash); !errors.Is(err, ErrConflict) {
		t.Fatalf("second setup error = %v", err)
	}
}

func TestRotateVaultReplacesHeaderAndAuthenticationHashTogether(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "text-vault.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	oldHash := []byte("01234567890123456789012345678901")
	newHash := []byte("abcdefghijklmnopqrstuvwxyzABCDEF")
	if err := s.CreateVault(ctx, json.RawMessage(`{"schemaVersion":1,"name":"old"}`), oldHash); err != nil {
		t.Fatal(err)
	}
	if err := s.RotateVault(ctx, json.RawMessage(`{"schemaVersion":1,"name":"new"}`), newHash); err != nil {
		t.Fatal(err)
	}
	header, err := s.VaultHeader(ctx)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := s.AuthHash(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if string(header) != `{"schemaVersion":1,"name":"new"}` || string(hash) != string(newHash) {
		t.Fatalf("rotated header=%s hash=%x", header, hash)
	}
}
