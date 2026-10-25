package node

import (
	"strings"
	"testing"
)

func TestCaddyfileExamples(t *testing.T) {
	s := Site{ID: strings.Repeat("a", 32), Name: "demo", Domains: []string{"demo.example.com"}, Port: 80, Cert: "auto"}
	c, e := s.Config()
	if e != nil || !strings.Contains(c, "demo.example.com {") || !strings.Contains(c, "file_server") || !strings.Contains(c, "try_files {path} /index.html") {
		t.Fatal(c, e)
	}
	t.Log("\n" + c)
	s.Cert = "off"
	s.Port = 18080
	c, e = s.Config()
	if e != nil || !strings.Contains(c, "http://demo.example.com:18080") {
		t.Fatal(c, e)
	}
	t.Log(c)
	// Mixed: domains HTTPS + IP:port HTTP + proxy
	s.Mode = "proxy"
	s.Upstreams = []string{"127.0.0.1:3000", "127.0.0.1:3001"}
	s.Cert = "auto"
	s.Port = 80
	s.Domains = []string{"app.example.com", "1.2.3.4:8888"}
	c, e = s.Config()
	if e != nil {
		t.Fatal(e)
	}
	for _, part := range []string{
		"app.example.com {",
		"http://1.2.3.4:8888 {",
		"reverse_proxy 127.0.0.1:3000 127.0.0.1:3001",
	} {
		if !strings.Contains(c, part) {
			t.Fatal("missing", part, c)
		}
	}
	t.Log(c)
	// HTTP redirect off keeps explicit http://domain in HTTPS block group
	f := false
	s.RedirHTTPS = &f
	s.Domains = []string{"app.example.com"}
	c, e = s.Config()
	if e != nil || !strings.Contains(c, "http://app.example.com") || !strings.Contains(c, "app.example.com") {
		t.Fatal(c, e)
	}
	stub := disabledCaddyStub(s)
	if !IsDisabledStub([]byte(stub)) || !strings.Contains(stub, "respond \"site disabled\" 503") {
		t.Fatal(stub)
	}
	t.Log(stub)
}

func TestSyncCustomConfigKeepsHandlers(t *testing.T) {
	s := Site{ID: strings.Repeat("b", 32), Name: "app", Domains: []string{"old.example.com"}, Cert: "auto"}
	old := `old.example.com {
	handle /api* {
		reverse_proxy 127.0.0.1:8080
	}
	root * /srv/site-panel/sites/` + s.ID + `/current
	try_files {path} /index.html
	file_server
}
`
	s.Domains = []string{"new.example.com", "1.2.3.4:8888"}
	next, e := SyncCustomConfig(old, s)
	if e != nil {
		t.Fatal(e)
	}
	for _, part := range []string{
		"new.example.com {",
		"http://1.2.3.4:8888 {",
		"handle /api*",
		"reverse_proxy 127.0.0.1:8080",
		"try_files {path} /index.html",
	} {
		if !strings.Contains(next, part) {
			t.Fatal("missing", part, next)
		}
	}
	if strings.Contains(next, "old.example.com") {
		t.Fatal(next)
	}
}


func TestPathProxiesGenerateHandles(t *testing.T) {
	s := Site{
		ID: strings.Repeat("c", 32),
		Name: "vue",
		Domains: []string{"app.example.com"},
		Cert: "auto",
		Proxies: []ProxyRoute{
			{Path: "/api", Upstream: "127.0.0.1:8080"},
			{Path: "/uploads", Upstream: "127.0.0.1:8080"},
		},
	}
	c, e := s.Config()
	if e != nil {
		t.Fatal(e)
	}
	for _, part := range []string{
		"handle /api* {",
		"handle /uploads* {",
		"reverse_proxy 127.0.0.1:8080",
		"try_files {path} /index.html",
		"/srv/site-panel/sites/" + s.ID + "/current",
	} {
		if !strings.Contains(c, part) {
			t.Fatal("missing", part, c)
		}
	}
	t.Log("\n" + c)
}
