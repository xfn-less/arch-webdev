package panel

import (
	"encoding/json"
	"testing"
)

func TestTasksAreLimitedPerNodeAndScopedBeforeRemoteAccess(t *testing.T) {
	a := newTestApp(t)
	cookie, csrf := setup(t, a)
	nodes := []Node{
		{ID: ID(), Name: "A", Host: "127.0.0.1", Port: 1, User: "root", Fingerprint: "SHA256:test"},
		{ID: ID(), Name: "B", Host: "127.0.0.2", Port: 1, User: "root", Fingerprint: "SHA256:test"},
	}
	latest := make([]string, 2)
	for i, n := range nodes {
		if e := a.Store.SaveNode(n, "password"); e != nil {
			t.Fatal(e)
		}
		for range 60 {
			latest[i] = ID()
			if e := a.Store.NewTask(Task{ID: latest[i], NodeID: n.ID, Status: "queued", Step: "prepare"}); e != nil {
				t.Fatal(e)
			}
		}
	}
	for i, n := range nodes {
		w := request(t, a, "GET", "/api/tasks?node_id="+n.ID, "", cookie, csrf)
		var list []Task
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &list) != nil || len(list) != 50 {
			t.Fatal(w.Code, w.Body.String())
		}
		if list[0].ID != latest[i] {
			t.Fatal("wrong ordering", list[0])
		}
		for _, task := range list {
			if task.NodeID != n.ID {
				t.Fatal("cross-node task", task)
			}
		}
	}
	for _, path := range []string{
		"/api/tasks/" + latest[0] + "/logs?node_id=" + nodes[1].ID,
		"/api/tasks/" + latest[0] + "/refresh?node_id=" + nodes[1].ID,
	} {
		method := "GET"
		if path == "/api/tasks/"+latest[0]+"/refresh?node_id="+nodes[1].ID {
			method = "POST"
		}
		if w := request(t, a, method, path, "", cookie, csrf); w.Code != 404 {
			t.Fatal(path, w.Code, w.Body.String())
		}
	}
	if w := request(t, a, "GET", "/api/tasks/"+latest[0]+"/logs?node_id="+nodes[0].ID, "", cookie, csrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := request(t, a, "GET", "/api/tasks?node_id=bad", "", cookie, csrf); w.Code != 400 {
		t.Fatal(w.Code)
	}
	if w := request(t, a, "GET", "/api/tasks?node_id="+ID(), "", cookie, csrf); w.Code != 404 {
		t.Fatal(w.Code)
	}
	if w := request(t, a, "GET", "/api/tasks?node_id="+nodes[0].ID, "", nil, ""); w.Code != 401 {
		t.Fatal(w.Code)
	}
}
