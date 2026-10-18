package main

import "testing"

func TestParseConfigAcceptsDatabaseWithoutASeparateAccessToken(t *testing.T) {
	got, err := parseConfig([]string{"-listen", "127.0.0.1:9000", "-database", "/tmp/vault.db", "-secure-cookie=false"})
	if err != nil {
		t.Fatal(err)
	}
	if got.listen != "127.0.0.1:9000" || got.database != "/tmp/vault.db" || got.secureCookie {
		t.Fatalf("config = %#v", got)
	}
}

func TestParseBackupConfigRequiresExplicitPaths(t *testing.T) {
	got, err := parseBackupConfig([]string{"-database", "/tmp/live.db", "-output", "/tmp/backup.db"})
	if err != nil {
		t.Fatal(err)
	}
	if got.database != "/tmp/live.db" || got.output != "/tmp/backup.db" {
		t.Fatalf("config = %#v", got)
	}
	if _, err := parseBackupConfig([]string{"-database", "/tmp/live.db"}); err == nil {
		t.Fatal("missing backup output was accepted")
	}
}
