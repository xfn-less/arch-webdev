package panel

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"site-panel/internal/node"
)

func TestCustomCaddyConfigRoundTrip(t *testing.T) {
	a := newTestApp(t)
	cookie, csrf := setup(t, a)
	s := Site{Site: node.Site{ID: ID(), Name: "demo", Domains: []string{"demo.example.com"}, Port: 80}, Enabled: true, PublishPath: DefaultPublishPath}
	if e := a.Store.SaveSite(s); e != nil {
		t.Fatal(e)
	}
	custom := "demo.example.com {\n\troot * /srv/site-panel/sites/" + s.ID + "/current\n\tfile_server\n}\n"
	body, _ := json.Marshal(map[string]string{"config": custom})
	w := request(t, a, "PUT", "/api/sites/"+s.ID+"/config", string(body), cookie, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	st, e := os.Stat(filepath.Join(a.Store.Dir, "caddy-configs", s.ID+".conf"))
	if e != nil || st.Size() == 0 {
		t.Fatal(e, st)
	}
	w = request(t, a, "GET", "/api/sites/"+s.ID+"/config", "", cookie, csrf)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "file_server") {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(t, a, "DELETE", "/api/sites/"+s.ID+"/config", "", cookie, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if _, e = os.Stat(filepath.Join(a.Store.Dir, "caddy-configs", s.ID+".conf")); !os.IsNotExist(e) {
		t.Fatal("expected cleared", e)
	}
}
