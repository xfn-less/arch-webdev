package panel

import (
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
	s := Site{Site: node.Site{ID: ID(), Name: "site", Domains: []string{"example.test"}, Port: 18080}, NodeID: n1.ID, Enabled: true}
	if e := a.Store.SaveSite(s); e != nil {
		t.Fatal(e)
	}
	if e := os.MkdirAll(filepath.Join(a.Store.Dir, "sites", s.ID), 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(a.Store.Dir, "sites", s.ID, "index.html"), []byte("ok"), 0600); e != nil {
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
	s := Site{Site: node.Site{ID: ID(), Name: "site", Domains: []string{"example.com"}, Port: 80}, NodeID: n.ID, Enabled: true}
	if e := a.Store.SaveSite(s); e != nil {
		t.Fatal(e)
	}
	w := request(t, a, "POST", "/api/sites/"+s.ID+"/deploy", "{}", cookie, csrf)
	if w.Code != 409 || !strings.Contains(w.Body.String(), "域名解析") {
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
	s := Site{Site: node.Site{Domains: []string{"example.com", "203.0.113.8"}}}
	rep := buildDNSReport(s, "203.0.113.10")
	if rep.OK || !strings.Contains(rep.Summary, "example.com") || !strings.Contains(rep.Summary, "198.51.100.9") {
		t.Fatal(rep)
	}
	if len(rep.Domains) != 2 || !rep.Domains[1].Skipped {
		t.Fatal(rep.Domains)
	}
	rep = buildDNSReport(s, "198.51.100.9")
	if !rep.OK || rep.Summary != "DNS 对照通过" {
		t.Fatal(rep)
	}
}
