package panel

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"site-panel/internal/node"
)

func TestNextTelegramSlot(t *testing.T) {
	loc := telegramLocation()
	morning := time.Date(2026, 10, 22, 5, 0, 0, 0, loc)
	if got := nextTelegramSlot(morning); got.Hour() != 6 || got.Day() != 22 {
		t.Fatalf("got %v", got)
	}
	afternoon := time.Date(2026, 10, 22, 12, 0, 0, 0, loc)
	if got := nextTelegramSlot(afternoon); got.Hour() != 18 || got.Day() != 22 {
		t.Fatalf("got %v", got)
	}
	night := time.Date(2026, 10, 22, 18, 1, 0, 0, loc)
	if got := nextTelegramSlot(night); got.Hour() != 6 || got.Day() != 23 {
		t.Fatalf("got %v", got)
	}
}

func TestTelegramOverviewConfigAndBuild(t *testing.T) {
	a := newTestApp(t)
	c, csrf := setup(t, a)
	if w := request(t, a, "GET", "/api/telegram", "", c, csrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	} else {
		var cfg telegramConfig
		_ = json.Unmarshal(w.Body.Bytes(), &cfg)
		if cfg.Configured || cfg.HasToken || cfg.ChatID != "" {
			t.Fatalf("unexpected %#v", cfg)
		}
		if !strings.Contains(cfg.Schedule, "06:00") {
			t.Fatalf("schedule %q", cfg.Schedule)
		}
	}
	token := "123456:ABC-TEST"
	chat := "-100123"
	body := `{"bot_token":"` + token + `","chat_id":"` + chat + `"}`
	if w := request(t, a, "PUT", "/api/telegram", body, c, csrf); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	} else {
		var cfg telegramConfig
		_ = json.Unmarshal(w.Body.Bytes(), &cfg)
		if !cfg.Configured || !cfg.HasToken || cfg.ChatID != chat {
			t.Fatalf("cfg %#v", cfg)
		}
	}
	if w := request(t, a, "GET", "/api/telegram", "", c, csrf); !strings.Contains(w.Body.String(), token) {
		t.Fatal("expected bot_token for admin copy")
	}
	w := request(t, a, "POST", "/api/telegram/overview", `{}`, c, csrf)
	if w.Code == 200 {
		t.Fatal("unexpected success with fake token")
	}
	if w.Code == 400 {
		t.Fatal(w.Code, w.Body.String())
	}
	n := Node{ID: ID(), Name: "HK", Host: "103.149.201.31", Port: 22, User: "root", Fingerprint: "fp", Note: "香港测试机"}
	if e := a.Store.SaveNode(n, "pw"); e != nil {
		t.Fatal(e)
	}
	s := Site{Site: node.Site{ID: ID(), Name: "下载", Domains: []string{"103.149.201.31", "download.xfnss.top", "panel-test.xfnss.top"}, Port: 80}, NodeID: n.ID, Enabled: true, PublishPath: DefaultPublishPath}
	if e := a.Store.SaveSite(s); e != nil {
		t.Fatal(e)
	}
	off := Site{Site: node.Site{ID: ID(), Name: "网页", Domains: []string{"old.example.com"}, Port: 8080}, NodeID: n.ID, Enabled: false, PublishPath: DefaultPublishPath}
	if e := a.Store.SaveSite(off); e != nil {
		t.Fatal(e)
	}
	off.Enabled = false
	if e := a.Store.UpdateSite(off); e != nil {
		t.Fatal(e)
	}
	parts, e := a.buildTelegramOverview(map[string]string{n.ID: "ok"})
	if e != nil {
		t.Fatal(e)
	}
	text := strings.Join(parts, "\n")
	for _, want := range []string{
		"共 <b>1</b> 个 ip",
		`href="https://site-panel.xfnss.top/"`,
		"✅",
		"103.149.201.31",
		"香港测试机",
		"🌐 下载",
		"download.xfnss.top",
		"panel-test.xfnss.top",
		"⏸ 网页 <i>已停用</i>",
		"old.example.com",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in\n%s", want, text)
		}
	}
	// bare IP domain should be omitted from site domain list lines (still appears as node IP)
	if strings.Count(text, "103.149.201.31") != 1 {
		t.Fatalf("expected IP once (node line only), got\n%s", text)
	}
	if strings.Contains(text, "SSH ") || strings.Contains(text, "SSL ") || strings.Contains(text, ":8080") || strings.Contains(text, "运行中") {
		t.Fatalf("too noisy:\n%s", text)
	}
	bad, e := a.buildTelegramOverview(map[string]string{n.ID: "agent 无响应"})
	if e != nil {
		t.Fatal(e)
	}
	badText := strings.Join(bad, "\n")
	if !strings.Contains(badText, "❌") || !strings.Contains(badText, "⚠️ 检查 <b>agent 无响应</b>") {
		t.Fatalf("missing check err:\n%s", badText)
	}
	if strings.Contains(badText, "✅") {
		t.Fatalf("should not show ok:\n%s", badText)
	}
}
