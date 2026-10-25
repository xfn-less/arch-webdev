package node

import "strings"
import "testing"

func TestDisabledStubConfigClaimsNames(t *testing.T) {
	original := []byte(`server {
    listen 80;
    listen 18080;
    listen 443 ssl;
    server_name download.xfnss.top www.download.xfnss.top;
    ssl_certificate /x.pem;
    ssl_certificate_key /x.key;
    location / { try_files $uri =404; }
}
`)
	got := disabledStubConfig(Site{ID: "abc", Domains: []string{"download.xfnss.top"}, Port: 80}, original)
	if !strings.HasPrefix(got, disabledStubMarker) {
		t.Fatal(got)
	}
	if !strings.Contains(got, "listen 80;") || !strings.Contains(got, "listen 18080;") {
		t.Fatal(got)
	}
	if !strings.Contains(got, "listen 443 ssl;") {
		t.Fatal("stub must claim TLS listens", got)
	}
	if !strings.Contains(got, "ssl_certificate /x.pem;") || !strings.Contains(got, "ssl_certificate_key /x.key;") {
		t.Fatal(got)
	}
	if !strings.Contains(got, "server_name download.xfnss.top www.download.xfnss.top;") {
		t.Fatal(got)
	}
	if !strings.Contains(got, "return 503") {
		t.Fatal(got)
	}
}

func TestDisabledStubConfigFallsBackToSite(t *testing.T) {
	got := disabledStubConfig(Site{Domains: []string{"a.example", "b.example"}, Port: 8080}, nil)
	if !strings.Contains(got, "listen 8080;") || !strings.Contains(got, "server_name a.example b.example;") {
		t.Fatal(got)
	}
}

func TestIsDisabledStub(t *testing.T) {
	if !IsDisabledStub([]byte(disabledStubMarker + "server {}\n")) {
		t.Fatal("expected stub")
	}
	if IsDisabledStub([]byte("# Managed by site-panel\nserver {}\n")) {
		t.Fatal("normal config")
	}
}
