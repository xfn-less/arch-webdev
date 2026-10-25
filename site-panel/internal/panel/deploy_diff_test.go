package panel

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"site-panel/internal/node"
)

func TestDeployPreviewDiffAndCommit(t *testing.T) {
	a := newTestApp(t)
	cookie, csrf := setup(t, a)
	n := Node{ID: ID(), Name: "n", Host: "127.0.0.1", Port: 22, User: "root", Fingerprint: "SHA256:test"}
	if e := a.Store.SaveNode(n, "password"); e != nil {
		t.Fatal(e)
	}
	s := Site{Site: node.Site{ID: ID(), Name: "site", Domains: []string{"example.test"}, Port: 80}, NodeID: n.ID, Enabled: true}
	if e := a.Store.SaveSite(s); e != nil {
		t.Fatal(e)
	}
	dir := filepath.Join(a.Store.Dir, "sites", s.ID)
	if e := os.MkdirAll(dir, 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(dir, "index.html"), []byte("hello {{NAME}}"), 0600); e != nil {
		t.Fatal(e)
	}
	w := request(t, a, "PUT", "/api/sites/"+s.ID+"/vars", `{"vars":{"NAME":"world"}}`, cookie, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}

	w = request(t, a, "GET", "/api/sites/"+s.ID+"/deploy-preview", "", cookie, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var first deployDiff
	if e := json.Unmarshal(w.Body.Bytes(), &first); e != nil || !first.FirstDeploy || first.FileCount != 1 || first.Replacements != 1 {
		t.Fatal(w.Body.String())
	}

	loaded, e := a.Store.GetSite(s.ID)
	if e != nil {
		t.Fatal(e)
	}
	snap, e := a.siteContentManifest(loaded)
	if e != nil {
		t.Fatal(e)
	}
	taskID := ID()
	if e = os.MkdirAll(filepath.Join(a.Store.Dir, "tasks", taskID), 0700); e != nil {
		t.Fatal(e)
	}
	if e = a.writeTaskManifest(taskID, snap); e != nil {
		t.Fatal(e)
	}
	a.commitDeploySnapshot(s.ID, taskID)

	w = request(t, a, "GET", "/api/sites/"+s.ID+"/deploy-preview", "", cookie, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var same deployDiff
	if e = json.Unmarshal(w.Body.Bytes(), &same); e != nil || same.FirstDeploy || !same.HasBaseline {
		t.Fatal(w.Body.String())
	}
	if same.Summary != "相对上次成功部署无变化（仍会全量推送）" {
		t.Fatal(same.Summary)
	}

	if e = os.WriteFile(filepath.Join(dir, "index.html"), []byte("hello {{NAME}}!"), 0600); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(dir, "new.txt"), []byte("x"), 0600); e != nil {
		t.Fatal(e)
	}
	if e = a.saveCustomNginx(s.ID, "server { listen 80; server_name example.test; root /tmp; include /etc/nginx/site-panel/"+s.ID+".panel.inc; }"); e != nil {
		t.Fatal(e)
	}
	w = request(t, a, "GET", "/api/sites/"+s.ID+"/deploy-preview", "", cookie, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var changed deployDiff
	if e = json.Unmarshal(w.Body.Bytes(), &changed); e != nil {
		t.Fatal(e)
	}
	if !changed.NginxChanged || len(changed.Added) == 0 || len(changed.Changed) == 0 {
		t.Fatal(w.Body.String())
	}
	if !containsPath(changed.Added, "new.txt") || !containsPath(changed.Changed, "index.html") {
		t.Fatal(changed.Added, changed.Changed)
	}
}

func containsPath(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}
