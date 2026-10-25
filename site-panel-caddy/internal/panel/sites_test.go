package panel

import (
	"context"
	"errors"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"site-panel/internal/node"
)

func TestSiteEnableBindDelete(t *testing.T) {
	a := newTestApp(t)
	cookie, csrf := setup(t, a)
	n1 := Node{ID: ID(), Name: "n1", Host: "127.0.0.1", Port: 22, User: "root", Fingerprint: "SHA256:test"}
	n2 := Node{ID: ID(), Name: "n2", Host: "127.0.0.2", Port: 22, User: "root", Fingerprint: "SHA256:test2"}
	if e := a.Store.SaveNode(n1, "password"); e != nil {
		t.Fatal(e)
	}
	if e := a.Store.SaveNode(n2, "password"); e != nil {
		t.Fatal(e)
	}
	s := Site{Site: node.Site{ID: ID(), Name: "site", Domains: []string{"example.test"}, Port: 18080}, NodeID: n1.ID, Enabled: true, PublishPath: DefaultPublishPath}
	if e := a.Store.SaveSite(s); e != nil {
		t.Fatal(e)
	}
	if e := os.MkdirAll(filepath.Join(a.Store.Dir, "sites", s.ID, DefaultPublishPath), 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(a.Store.Dir, "sites", s.ID, DefaultPublishPath, "index.html"), []byte("ok"), 0600); e != nil {
		t.Fatal(e)
	}
	body, _ := json.Marshal(map[string]string{"node_id": n2.ID})
	w := request(t, a, "PUT", "/api/sites/"+s.ID+"/bind", string(body), cookie, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	got, e := a.Store.GetSite(s.ID)
	if e != nil || got.NodeID != n2.ID || !got.Enabled {
		t.Fatal(got, e)
	}
	w = request(t, a, "POST", "/api/sites/"+s.ID+"/disable", "", cookie, csrf)
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	got, e = a.Store.GetSite(s.ID)
	if e != nil || got.Enabled {
		t.Fatal(got, e)
	}
	// Finish disable even if the async submit goroutine flips status back to running.
	var task map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &task)
	disableID, _ := task["task_id"].(string)
	enableOK := false
	for i := 0; i < 50; i++ {
		if disableID != "" {
			_ = a.Store.SetTask(disableID, "succeeded", "disable_done", "")
		}
		w = request(t, a, "POST", "/api/sites/"+s.ID+"/enable", "", cookie, csrf)
		if w.Code == 202 {
			enableOK = true
			break
		}
		if w.Code != 409 {
			t.Fatal(w.Code, w.Body.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !enableOK {
		t.Fatal("enable stayed busy", w.Code, w.Body.String())
	}
	got, e = a.Store.GetSite(s.ID)
	if e != nil || !got.Enabled {
		t.Fatal(got, e)
	}
	_ = json.Unmarshal(w.Body.Bytes(), &task)
	enableID, _ := task["task_id"].(string)
	deleteOK := false
	for i := 0; i < 50; i++ {
		if enableID != "" {
			_ = a.Store.SetTask(enableID, "succeeded", "enable_done", "")
		}
		w = request(t, a, "DELETE", "/api/sites/"+s.ID, `{"purge_master":true,"force_remote":true}`, cookie, csrf)
		if w.Code == 200 {
			deleteOK = true
			break
		}
		if w.Code != 409 {
			t.Fatal(w.Code, w.Body.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !deleteOK {
		t.Fatal("delete stayed busy", w.Code, w.Body.String())
	}
	if _, e = a.Store.GetSite(s.ID); e == nil {
		t.Fatal("site still exists")
	}
	if _, e = os.Stat(filepath.Join(a.Store.Dir, "sites", s.ID)); !os.IsNotExist(e) {
		t.Fatal("master files not purged", e)
	}
}

func TestDeployDNSWarning(t *testing.T) {
	oldLookup := lookupSiteIPs
	lookupSiteIPs = func(host string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("198.51.100.9")}, nil
	}
	t.Cleanup(func() { lookupSiteIPs = oldLookup })
	a := newTestApp(t)
	cookie, csrf := setup(t, a)
	n := Node{ID: ID(), Name: "n", Host: "203.0.113.10", Port: 22, User: "root", Fingerprint: "SHA256:test"}
	if e := a.Store.SaveNode(n, "password"); e != nil {
		t.Fatal(e)
	}
	s := Site{Site: node.Site{ID: ID(), Name: "site", Domains: []string{"example.com"}, Port: 80}, NodeID: n.ID, Enabled: true, PublishPath: DefaultPublishPath}
	if e := a.Store.SaveSite(s); e != nil {
		t.Fatal(e)
	}
	w := request(t, a, "POST", "/api/sites/"+s.ID+"/deploy", "{}", cookie, csrf)
	if w.Code != 409 || !strings.Contains(w.Body.String(), "example.com") || !strings.Contains(w.Body.String(), "未对准节点") {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(t, a, "POST", "/api/sites/"+s.ID+"/deploy", `{"force":true}`, cookie, csrf)
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestLookupPublicIPsSkipsFakeIP(t *testing.T) {
	ips, e := lookupPublicIPs("panel-test.xfnss.top")
	if e != nil {
		t.Fatal(e)
	}
	want := net.ParseIP("103.149.201.31")
	ok := false
	for _, ip := range ips {
		if ip.Equal(want) {
			ok = true
		}
		if ip.IsPrivate() || strings.HasPrefix(ip.String(), "198.18.") {
			t.Fatalf("got local/fake IP %v", ips)
		}
	}
	if !ok {
		t.Fatalf("missing node IP in %v", ips)
	}
}

func TestDNSReportDetails(t *testing.T) {
	oldLookup := lookupSiteIPs
	lookupSiteIPs = func(host string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("198.51.100.9")}, nil
	}
	t.Cleanup(func() { lookupSiteIPs = oldLookup })
	s := Site{Site: node.Site{Domains: []string{"example.com", "203.0.113.8"}}, PublishPath: DefaultPublishPath}
	rep := buildDNSReport(s, "203.0.113.10")
	if rep.OK || !strings.Contains(rep.Summary, "example.com") || !strings.Contains(rep.Summary, "未对准节点") {
		t.Fatal(rep)
	}
	if len(rep.Domains) != 2 || !rep.Domains[1].Skipped {
		t.Fatal(rep.Domains)
	}
	if !strings.Contains(rep.Domains[0].Detail, "198.51.100.9") {
		t.Fatal(rep.Domains[0])
	}
	rep = buildDNSReport(s, "198.51.100.9")
	if !rep.OK || !strings.Contains(rep.Summary, "DNS 对照通过") {
		t.Fatal(rep)
	}
}

func TestDNSReportChecksDomainWithPort(t *testing.T) {
	oldLookup := lookupSiteIPs
	lookupSiteIPs = func(host string) ([]net.IP, error) {
		if host != "example.com" {
			t.Fatalf("host %s", host)
		}
		return []net.IP{net.ParseIP("198.51.100.9")}, nil
	}
	t.Cleanup(func() { lookupSiteIPs = oldLookup })
	s := Site{Site: node.Site{Domains: []string{"example.com:8080", "203.0.113.8"}}, PublishPath: DefaultPublishPath}
	rep := buildDNSReport(s, "198.51.100.9")
	if !rep.OK || len(rep.Domains) != 2 || !rep.Domains[0].OK || rep.Domains[1].Skipped != true {
		t.Fatal(rep)
	}
}

func TestExpandIPAliasOnUpdateSite(t *testing.T) {
	a := newTestApp(t)
	c, csrf := setup(t, a)
	n := Node{ID: ID(), Name: "jn", Host: "103.239.186.54", Port: 22, User: "root", Fingerprint: "SHA256:x", Note: ""}
	if e := a.Store.SaveNode(n, "pw"); e != nil {
		t.Fatal(e)
	}
	s := Site{Site: node.Site{ID: ID(), Name: "s1", Domains: []string{"z1.example.com"}, Port: 80, Cert: "auto"}, NodeID: n.ID, Enabled: true, PublishPath: DefaultPublishPath}
	if e := a.Store.SaveSite(s); e != nil {
		t.Fatal(e)
	}
	body := `{"name":"s1","domains":["z1.example.com","ip:10000","ip:10001"],"port":0,"cert":"auto","mode":"static","proxies":[],"redir_https":true}`
	w := request(t, a, "PUT", "/api/sites/"+s.ID, body, c, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	got, e := a.Store.GetSite(s.ID)
	if e != nil {
		t.Fatal(e)
	}
	want := []string{"z1.example.com", "103.239.186.54:10000", "103.239.186.54:10001"}
	if len(got.Domains) != len(want) {
		t.Fatalf("%v", got.Domains)
	}
	for i := range want {
		if got.Domains[i] != want[i] {
			t.Fatalf("%d %q", i, got.Domains[i])
		}
	}
}

func TestAgentVersionOK(t *testing.T) {
	oks := []string{"0.3.1", "0.3.1-caddy", "0.3.2-caddy", "0.4.0", "1.0.0"}
	bads := []string{"", "0.2.8", "0.3.0", "0.3.0-caddy", "bogus"}
	for _, v := range oks {
		if !agentVersionOK(v) {
			t.Fatalf("want ok %q", v)
		}
	}
	for _, v := range bads {
		if agentVersionOK(v) {
			t.Fatalf("want bad %q", v)
		}
	}
}

func TestNeedsPublicHTTPSport(t *testing.T) {
	auto := Site{Site: node.Site{Domains: []string{"z1.example.com", "1.2.3.4:10000"}, Cert: "auto"}}
	if !needsPublicHTTPSport(auto) {
		t.Fatal("auto domain should need 80/443")
	}
	httpOnly := Site{Site: node.Site{Domains: []string{"1.2.3.4:10000"}, Cert: "off"}}
	if needsPublicHTTPSport(httpOnly) {
		t.Fatal("http-only should skip")
	}
	ipAuto := Site{Site: node.Site{Domains: []string{"1.2.3.4"}, Cert: "auto"}}
	if needsPublicHTTPSport(ipAuto) {
		t.Fatal("pure IP should skip ACME ports")
	}
}

func TestHTTPSReachMismatch(t *testing.T) {
	old := dialTCP
	t.Cleanup(func() { dialTCP = old })
	dialTCP = func(ctx context.Context, network, address string) (net.Conn, error) {
		return nil, errors.New("refused")
	}
	s := Site{Site: node.Site{Domains: []string{"z1.example.com"}, Cert: "auto"}}
	msg := httpsReachMismatch(s, "203.0.113.10")
	if msg == "" || !strings.Contains(msg, "80/443") {
		t.Fatal(msg)
	}
	dialTCP = func(ctx context.Context, network, address string) (net.Conn, error) {
		// succeed both ports with a pipe endpoint
		c1, c2 := net.Pipe()
		go c2.Close()
		return c1, nil
	}
	if msg := httpsReachMismatch(s, "203.0.113.10"); msg != "" {
		t.Fatal(msg)
	}
	if msg := httpsReachMismatch(Site{Site: node.Site{Domains: []string{"1.2.3.4:10000"}, Cert: "off"}}, "203.0.113.10"); msg != "" {
		t.Fatal(msg)
	}
}

func TestDeployBlocksUnreachableHTTPSPorts(t *testing.T) {
	oldLookup := lookupSiteIPs
	lookupSiteIPs = func(host string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("203.0.113.10")}, nil
	}
	oldDial := dialTCP
	dialTCP = func(ctx context.Context, network, address string) (net.Conn, error) {
		return nil, errors.New("timeout")
	}
	t.Cleanup(func() {
		lookupSiteIPs = oldLookup
		dialTCP = oldDial
	})
	a := newTestApp(t)
	cookie, csrf := setup(t, a)
	n := Node{ID: ID(), Name: "n", Host: "203.0.113.10", Port: 22, User: "root", Fingerprint: "SHA256:test"}
	if e := a.Store.SaveNode(n, "password"); e != nil {
		t.Fatal(e)
	}
	s := Site{Site: node.Site{ID: ID(), Name: "site", Domains: []string{"example.com"}, Port: 80, Cert: "auto"}, NodeID: n.ID, Enabled: true, PublishPath: DefaultPublishPath}
	if e := a.Store.SaveSite(s); e != nil {
		t.Fatal(e)
	}
	w := request(t, a, "POST", "/api/sites/"+s.ID+"/deploy", "{}", cookie, csrf)
	if w.Code != 409 || !strings.Contains(w.Body.String(), "80/443") {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(t, a, "POST", "/api/sites/"+s.ID+"/deploy", `{"force":true}`, cookie, csrf)
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
}
