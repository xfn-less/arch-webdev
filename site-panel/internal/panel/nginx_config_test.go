package panel

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"site-panel/internal/node"
)

func TestNginxConfigSaveResetAndSSLGuard(t *testing.T) {
	a := newTestApp(t)
	cookie, csrf := setup(t, a)
	n := Node{ID: ID(), Name: "n", Host: "127.0.0.1", Port: 22, User: "root", Fingerprint: "SHA256:test"}
	if e := a.Store.SaveNode(n, "password"); e != nil {
		t.Fatal(e)
	}
	s := Site{Site: node.Site{ID: ID(), Name: "site", Domains: []string{"example.test"}, Port: 18080}, NodeID: n.ID}
	if e := a.Store.SaveSite(s); e != nil {
		t.Fatal(e)
	}
	w := request(t, a, "GET", "/api/sites/"+s.ID+"/config", "", cookie, csrf)
	var got map[string]string
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &got) != nil || got["source"] != "generated" || !strings.Contains(got["config"], "server_name example.test;") {
		t.Fatal(w.Code, w.Body.String())
	}
	custom := "# custom\nserver {\n    listen 18080;\n    server_name example.test;\n    root /srv/site-panel/sites/" + s.ID + "/current;\n    location / { try_files $uri =404; }\n}\n"
	body, _ := json.Marshal(map[string]string{"config": custom})
	w = request(t, a, "PUT", "/api/sites/"+s.ID+"/config", string(body), cookie, csrf)
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &got) != nil || got["source"] != "custom" {
		t.Fatal(w.Code, w.Body.String())
	}
	st, e := os.Stat(filepath.Join(a.Store.Dir, "nginx-configs", s.ID+".conf"))
	if e != nil || st.Mode().Perm() != 0600 {
		t.Fatal(st, e)
	}
	w = request(t, a, "GET", "/api/sites/"+s.ID+"/config", "", cookie, csrf)
	want := node.EnsurePanelInclude(custom, s.ID)
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &got) != nil || got["config"] != want {
		t.Fatal(w.Body.String())
	}
	if !strings.Contains(got["config"], node.PanelIncPath(s.ID)) {
		t.Fatal("custom config missing panel.inc include")
	}
	w = request(t, a, "POST", "/api/sites/"+s.ID+"/ssl", `{"domains":["example.test"],"agree_terms":true,"staging":true}`, cookie, csrf)
	if w.Code != 202 {
		t.Fatal("custom nginx should still accept SSL in preserve mode", w.Code, w.Body.String())
	}
	w = request(t, a, "PUT", "/api/sites/"+s.ID+"/config", `{"config":"hello"}`, cookie, csrf)
	if w.Code != 400 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(t, a, "DELETE", "/api/sites/"+s.ID+"/config", "", cookie, csrf)
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &got) != nil || got["source"] != "generated" {
		t.Fatal(w.Code, w.Body.String())
	}
	if _, e = os.Stat(filepath.Join(a.Store.Dir, "nginx-configs", s.ID+".conf")); !os.IsNotExist(e) {
		t.Fatal(e)
	}
}
