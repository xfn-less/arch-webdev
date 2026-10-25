package panel

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// Opt-in read-only integration test. Uses a fresh temporary controller DB and
// reads an existing task's journal; never deploys files or changes the real DB.
func TestLogsFromLiveNode(t *testing.T) {
	host := os.Getenv("SITE_PANEL_LOG_TEST_HOST")
	if host == "" {
		t.Skip("set SITE_PANEL_LOG_TEST_* for read-only SSH integration")
	}
	key, fp, taskID := os.Getenv("SITE_PANEL_LOG_TEST_KEY"), os.Getenv("SITE_PANEL_LOG_TEST_FINGERPRINT"), os.Getenv("SITE_PANEL_LOG_TEST_TASK")
	if key == "" || fp == "" || taskID == "" {
		t.Fatal("key path, independently verified fingerprint and existing task ID are required")
	}
	a := newTestApp(t)
	a.Remote.KeyFile = key
	cookie, csrf := setup(t, a)
	n := Node{ID: ID(), Name: "read-only integration", Host: host, Port: 22, User: "root", Fingerprint: fp}
	if e := a.Store.SaveNode(n, ""); e != nil {
		t.Fatal(e)
	}
	if e := a.Store.NewTask(Task{ID: taskID, NodeID: n.ID, SiteID: ID(), Status: "succeeded", Step: "done"}); e != nil {
		t.Fatal(e)
	}
	w := request(t, a, "GET", "/api/tasks/"+taskID+"/logs", "", cookie, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var result map[string]string
	if e := json.Unmarshal(w.Body.Bytes(), &result); e != nil {
		t.Fatal(e)
	}
	if result["remote_error"] != "" {
		t.Fatal(result["remote_error"])
	}
	if !strings.Contains(result["text"], "节点 journal") || !strings.Contains(result["text"], "site-panel-task") {
		t.Fatal("remote journal did not contain the known task")
	}
}
