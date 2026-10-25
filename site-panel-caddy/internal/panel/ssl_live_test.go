package panel

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"site-panel/internal/node"
)

// Explicitly opt-in. Exercises the authenticated controller API -> SSH -> node
// staging flow on the existing demo. Never enables staging TLS or deploys files.
func TestLiveSSLStagingThroughAPI(t *testing.T) {
	if os.Getenv("SITE_PANEL_SSL_TEST") != "1" {
		t.Skip("opt-in staging-only SSL integration")
	}
	a := newTestApp(t)
	a.Remote.KeyFile = os.Getenv("SITE_PANEL_LOG_TEST_KEY")
	if a.Remote.KeyFile == "" {
		t.Fatal("local SSH key required")
	}
	n := Node{ID: ID(), Name: "SSL integration", Host: "103.149.201.31", Port: 22, User: "root", Fingerprint: os.Getenv("SITE_PANEL_LOG_TEST_FINGERPRINT")}
	if n.Fingerprint == "" {
		t.Fatal("verified SSH fingerprint required")
	}
	if e := a.Store.SaveNode(n, ""); e != nil {
		t.Fatal(e)
	}
	site := Site{Site: node.Site{ID: "1b72d9296477b99f8d8edd5b8a926603", Name: "测试下载站", Domains: []string{"103.149.201.31", "panel-test.xfnss.top"}, Port: 18080}, NodeID: n.ID, PublishPath: DefaultPublishPath}
	if e := a.Store.SaveSite(site); e != nil {
		t.Fatal(e)
	}
	cookie, csrf := setup(t, a)
	w := request(t, a, "POST", "/api/sites/"+site.ID+"/ssl", `{"domains":["panel-test.xfnss.top"],"agree_terms":true,"staging":true}`, cookie, csrf)
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	var response map[string]string
	if e := json.Unmarshal(w.Body.Bytes(), &response); e != nil {
		t.Fatal(e)
	}
	id := response["task_id"]
	t.Logf("staging task ID: %s", id)
	for deadline := time.Now().Add(2 * time.Minute); time.Now().Before(deadline); time.Sleep(time.Second) {
		task, e := a.Store.GetTask(id)
		if e != nil {
			t.Fatal(e)
		}
		if task.Step != "prepare" && task.Status != "succeeded" {
			r := request(t, a, "POST", "/api/tasks/"+id+"/refresh", "", cookie, csrf)
			if r.Code == 502 {
				t.Log("temporary SSH query failure; retrying the same task status")
				continue
			}
			if r.Code != 200 {
				t.Fatal(r.Code, r.Body.String())
			}
			task, _ = a.Store.GetTask(id)
		}
		if task.Status == "failed" || task.Status == "needs_attention" {
			t.Fatal(task.Error)
		}
		if task.Status == "succeeded" {
			if task.Kind != "ssl" || task.Step != "ssl_staging_done" {
				t.Fatal(task)
			}
			s, e := a.Store.GetSite(site.ID)
			if e != nil || s.SSL != nil {
				t.Fatal("staging certificate incorrectly saved as production", e)
			}
			return
		}
	}
	t.Fatal("staging result unknown; inspect the node task, do not blindly retry")
}
