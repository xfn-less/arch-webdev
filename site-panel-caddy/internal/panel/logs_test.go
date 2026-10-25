package panel

import (
	"strings"
	"testing"
)

func TestTaskEventsOnlyRecordTransitions(t *testing.T) {
	a := newTestApp(t)
	id := ID()
	if e := a.Store.NewTask(Task{ID: id, NodeID: ID(), Status: "queued", Step: "prepare"}); e != nil {
		t.Fatal(e)
	}
	for range 3 {
		if e := a.Store.SetTask(id, "running", "prepare", ""); e != nil {
			t.Fatal(e)
		}
	}
	events, e := a.Store.TaskEvents(id)
	if e != nil || len(events) != 2 {
		t.Fatal(events, e)
	}
	if e = a.Store.SetTask(id, "failed", "check_nginx", "invalid config"); e != nil {
		t.Fatal(e)
	}
	events, e = a.Store.TaskEvents(id)
	if e != nil || len(events) != 3 || events[2].Message != "invalid config" {
		t.Fatal(events, e)
	}
}
func TestLogsRequireAuthAndKeepUnknownSeparate(t *testing.T) {
	a := newTestApp(t)
	cookie, csrf := setup(t, a)
	n := Node{ID: ID(), Name: "offline", Host: "127.0.0.1", Port: 1, User: "root", Fingerprint: "SHA256:test"}
	const password = "root-password-for-redaction"
	if e := a.Store.SaveNode(n, password); e != nil {
		t.Fatal(e)
	}
	id := ID()
	if e := a.Store.NewTask(Task{ID: id, NodeID: n.ID, SiteID: ID(), Status: "running", Step: "remote_execution", Error: "failure with " + password}); e != nil {
		t.Fatal(e)
	}
	url := "/api/tasks/" + id + "/logs"
	if w := request(t, a, "GET", url, "", nil, ""); w.Code != 401 {
		t.Fatal(w.Code)
	}
	w := request(t, a, "GET", url, "", cookie, csrf)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "remote_error") || strings.Contains(w.Body.String(), password) || !strings.Contains(w.Body.String(), "PASSWORD REDACTED") {
		t.Fatal(w.Code, w.Body.String())
	}
	task, e := a.Store.GetTask(id)
	if e != nil || task.Status != "running" {
		t.Fatal("log query changed execution result", task, e)
	}
	w = request(t, a, "GET", "/api/tasks/not-a-task/logs", "", cookie, csrf)
	if w.Code != 400 {
		t.Fatal(w.Code)
	}
}
func TestPrivateKeyLogRedaction(t *testing.T) {
	text := "begin\n-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----\nend"
	redacted := redactLog(text, "")
	if strings.Contains(redacted, "secret") || !strings.Contains(redacted, "PRIVATE KEY REDACTED") {
		t.Fatal(redacted)
	}
}
