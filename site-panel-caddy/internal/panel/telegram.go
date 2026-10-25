package panel

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"site-panel/internal/remote"
)

const (
	telegramTokenKey  = "telegram_bot_token"
	telegramChatKey   = "telegram_chat_id"
	telegramMsgIDsKey = "telegram_last_message_ids"
	telegramMaxMsg    = 3900
	telegramTZName    = "Asia/Shanghai"
)

type telegramConfig struct {
	Configured bool   `json:"configured"`
	HasToken   bool   `json:"has_token"`
	BotToken   string `json:"bot_token,omitempty"`
	ChatID     string `json:"chat_id"`
	Schedule   string `json:"schedule"`
}

type telegramPut struct {
	BotToken   *string `json:"bot_token"`
	ChatID     *string `json:"chat_id"`
	ClearToken bool    `json:"clear_token"`
}

type telegramLastMessages struct {
	ChatID string  `json:"chat_id"`
	IDs    []int64 `json:"ids"`
}

func (a *App) getTelegram(w http.ResponseWriter, r *http.Request) {
	cfg, e := a.telegramConfig()
	if e != nil {
		fail(w, 500, "读取 Telegram 配置失败")
		return
	}
	reply(w, 200, cfg)
}

func (a *App) putTelegram(w http.ResponseWriter, r *http.Request) {
	var body telegramPut
	if e := decode(w, r, &body); e != nil {
		fail(w, 400, e.Error())
		return
	}
	if body.ClearToken {
		if e := a.Store.DeleteSecret(telegramTokenKey); e != nil {
			fail(w, 500, "清除 Token 失败")
			return
		}
	}
	if body.BotToken != nil {
		token := strings.TrimSpace(*body.BotToken)
		if token == "" {
			fail(w, 400, "Bot Token 不能为空")
			return
		}
		if e := a.Store.SetSecret(telegramTokenKey, token); e != nil {
			fail(w, 500, "保存 Token 失败")
			return
		}
	}
	if body.ChatID != nil {
		chat := strings.TrimSpace(*body.ChatID)
		if chat == "" {
			_ = a.Store.DeleteSetting(telegramChatKey)
		} else if e := a.Store.SetSetting(telegramChatKey, chat); e != nil {
			fail(w, 500, "保存 Chat ID 失败")
			return
		}
	}
	cfg, e := a.telegramConfig()
	if e != nil {
		fail(w, 500, "读取 Telegram 配置失败")
		return
	}
	reply(w, 200, cfg)
}

func (a *App) pushTelegramOverview(w http.ResponseWriter, r *http.Request) {
	n, e := a.publishTelegramOverview(r.Context())
	if e != nil {
		if strings.Contains(e.Error(), "请先配置") {
			fail(w, 400, e.Error())
			return
		}
		fail(w, 502, e.Error())
		return
	}
	reply(w, 200, map[string]any{"ok": true, "parts": n})
}

func (a *App) telegramConfig() (telegramConfig, error) {
	token, e := a.Store.GetSecret(telegramTokenKey)
	if e != nil {
		return telegramConfig{}, e
	}
	chat, e := a.Store.GetSetting(telegramChatKey)
	if e != nil {
		return telegramConfig{}, e
	}
	return telegramConfig{
		Configured: token != "" && chat != "",
		HasToken:   token != "",
		BotToken:   token,
		ChatID:     chat,
		Schedule:   "每天 06:00 / 18:00（上海时区）全检，只保留最新一条",
	}, nil
}

func (a *App) telegramCreds() (token, chat string, err error) {
	token, err = a.Store.GetSecret(telegramTokenKey)
	if err != nil {
		return "", "", err
	}
	chat, err = a.Store.GetSetting(telegramChatKey)
	if err != nil {
		return "", "", err
	}
	if token == "" || chat == "" {
		return "", "", errors.New("请先配置 Bot Token 和 Chat ID")
	}
	return token, chat, nil
}

func (a *App) startTelegramScheduler() {
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		loc := telegramLocation()
		for {
			next := nextTelegramSlot(time.Now().In(loc))
			wait := time.Until(next)
			if wait < 0 {
				wait = time.Second
			}
			timer := time.NewTimer(wait)
			select {
			case <-a.ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
				ctx, cancel := context.WithTimeout(a.ctx, 10*time.Minute)
				if _, e := a.publishTelegramOverview(ctx); e != nil {
					if !strings.Contains(e.Error(), "请先配置") {
						log.Printf("telegram 定时汇报失败: %v", e)
					}
				}
				cancel()
			}
		}
	}()
}

func telegramLocation() *time.Location {
	loc, e := time.LoadLocation(telegramTZName)
	if e != nil {
		return time.FixedZone("CST", 8*3600)
	}
	return loc
}

func nextTelegramSlot(now time.Time) time.Time {
	y, m, d := now.Date()
	loc := now.Location()
	morning := time.Date(y, m, d, 6, 0, 0, 0, loc)
	evening := time.Date(y, m, d, 18, 0, 0, 0, loc)
	switch {
	case now.Before(morning):
		return morning
	case now.Before(evening):
		return evening
	default:
		return morning.Add(24 * time.Hour)
	}
}

func (a *App) publishTelegramOverview(ctx context.Context) (int, error) {
	token, chat, e := a.telegramCreds()
	if e != nil {
		return 0, e
	}
	nodes, e := a.Store.Nodes()
	if e != nil {
		return 0, e
	}
	live := map[string]string{}
	if len(nodes) > 0 {
		live = a.probeNodeStatuses(ctx, nodes)
	}
	parts, e := a.buildTelegramOverview(live)
	if e != nil {
		return 0, e
	}
	ids := make([]int64, 0, len(parts))
	for i, part := range parts {
		id, e := sendTelegramMessage(ctx, token, chat, part)
		if e != nil {
			return 0, fmt.Errorf("第 %d/%d 条发送失败：%w", i+1, len(parts), e)
		}
		ids = append(ids, id)
	}
	a.replaceTelegramMessages(ctx, token, chat, ids)
	return len(parts), nil
}

func (a *App) replaceTelegramMessages(ctx context.Context, token, chat string, newIDs []int64) {
	old := a.loadTelegramLastMessages()
	_ = a.saveTelegramLastMessages(telegramLastMessages{ChatID: chat, IDs: newIDs})
	if old.ChatID == "" || len(old.IDs) == 0 || old.ChatID != chat {
		return
	}
	for _, id := range old.IDs {
		_ = deleteTelegramMessage(ctx, token, old.ChatID, id)
	}
}

func (a *App) loadTelegramLastMessages() telegramLastMessages {
	var out telegramLastMessages
	raw, e := a.Store.GetSetting(telegramMsgIDsKey)
	if e != nil || raw == "" {
		return out
	}
	_ = json.Unmarshal([]byte(raw), &out)
	return out
}

func (a *App) saveTelegramLastMessages(v telegramLastMessages) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	return a.Store.SetSetting(telegramMsgIDsKey, string(b))
}

func (a *App) buildTelegramOverview(live map[string]string) ([]string, error) {
	nodes, e := a.Store.Nodes()
	if e != nil {
		return nil, e
	}
	sites, e := a.Store.Sites()
	if e != nil {
		return nil, e
	}
	sort.SliceStable(nodes, func(i, j int) bool {
		if nodes[i].Host != nodes[j].Host {
			return nodes[i].Host < nodes[j].Host
		}
		return nodes[i].Name < nodes[j].Name
	})
	byNode := map[string][]Site{}
	unbound := []Site{}
	for _, s := range sites {
		if s.NodeID == "" {
			unbound = append(unbound, s)
			continue
		}
		byNode[s.NodeID] = append(byNode[s.NodeID], s)
	}
	for id := range byNode {
		list := byNode[id]
		sort.SliceStable(list, func(i, j int) bool { return list[i].Name < list[j].Name })
		byNode[id] = list
	}
	sort.SliceStable(unbound, func(i, j int) bool { return unbound[i].Name < unbound[j].Name })

	now := time.Now().In(telegramLocation())
	var b strings.Builder
	fmt.Fprintf(&b, "<b>%s</b>  共 <b>%d</b> 个 ip\n<a href=\"https://site-panel.xfnss.top/\">https://site-panel.xfnss.top/</a>\n",
		html.EscapeString(now.Format("2006-01-02 15:04")), len(nodes))

	var chunks []string
	flush := func(force bool) {
		if b.Len() == 0 {
			return
		}
		if force || b.Len() >= telegramMaxMsg {
			chunks = append(chunks, b.String())
			b.Reset()
		}
	}
	writeBlock := func(block string) {
		if block == "" {
			return
		}
		if b.Len() > 0 && b.Len()+len(block) > telegramMaxMsg {
			flush(true)
		}
		if len(block) > telegramMaxMsg {
			for len(block) > 0 {
				n := telegramMaxMsg
				if n > len(block) {
					n = len(block)
				}
				chunks = append(chunks, block[:n])
				block = block[n:]
			}
			return
		}
		b.WriteString(block)
	}

	for i, n := range nodes {
		if i > 0 {
			writeBlock("➖\n")
		}
		writeBlock(formatNodeBlock(n, byNode[n.ID], live[n.ID]))
		flush(false)
	}
	if len(unbound) > 0 {
		var nb strings.Builder
		if len(nodes) > 0 {
			nb.WriteString("➖\n")
		}
		nb.WriteString("📦 <b>未绑定</b>\n")
		for _, s := range unbound {
			nb.WriteString(formatSiteLines(s))
		}
		writeBlock(nb.String())
	}
	flush(true)
	if len(chunks) == 0 {
		chunks = []string{fmt.Sprintf("<b>%s</b>  共 <b>0</b> 个 ip\n<a href=\"https://site-panel.xfnss.top/\">https://site-panel.xfnss.top/</a>", html.EscapeString(now.Format("2006-01-02 15:04")))}
	}
	return chunks, nil
}

func formatNodeBlock(n Node, sites []Site, live string) string {
	var b strings.Builder
	label := strings.TrimSpace(n.Note)
	if label == "" {
		label = strings.TrimSpace(n.Name)
	}
	if live == "ok" {
		b.WriteString("✅ ")
	} else {
		b.WriteString("❌ ")
	}
	fmt.Fprintf(&b, "<code>%s</code>", html.EscapeString(n.Host))
	if label != "" && label != n.Host {
		fmt.Fprintf(&b, " %s", html.EscapeString(label))
	}
	b.WriteByte('\n')
	if live != "ok" {
		err := live
		if err == "" {
			err = "未返回"
		}
		fmt.Fprintf(&b, "⚠️ 检查 <b>%s</b>\n", html.EscapeString(err))
	}
	if len(sites) == 0 {
		b.WriteString("（无站点）\n")
		return b.String()
	}
	for _, s := range sites {
		b.WriteString(formatSiteLines(s))
	}
	return b.String()
}

func formatSiteLines(s Site) string {
	var b strings.Builder
	name := html.EscapeString(strings.TrimSpace(s.Name))
	if name == "" {
		name = "站点"
	}
	if s.Enabled {
		fmt.Fprintf(&b, "🌐 %s\n", name)
	} else {
		fmt.Fprintf(&b, "⏸ %s <i>已停用</i>\n", name)
	}
	doms := append([]string{}, s.Domains...)
	sort.Strings(doms)
	shown := 0
	for _, d := range doms {
		d = strings.TrimSpace(d)
		if d == "" || net.ParseIP(d) != nil {
			continue
		}
		fmt.Fprintf(&b, "  <code>%s</code>\n", html.EscapeString(d))
		shown++
	}
	if shown == 0 {
		b.WriteString("  （无域名）\n")
	}
	return b.String()
}

func (a *App) probeNodeStatuses(ctx context.Context, nodes []Node) map[string]string {
	out := make(map[string]string, len(nodes))
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for _, n := range nodes {
		n := n
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			nctx, cancel := context.WithTimeout(ctx, 12*time.Second)
			defer cancel()
			msg := a.probeOneNode(nctx, n)
			mu.Lock()
			out[n.ID] = msg
			mu.Unlock()
		}()
	}
	wg.Wait()
	return out
}

func (a *App) probeOneNode(ctx context.Context, n Node) string {
	t, e := a.target(n.ID)
	if e != nil {
		_ = a.Store.SaveNodeStatus(n.ID, NodeStatus{Error: "节点读取失败", ObservedAt: time.Now().UTC().Format(time.RFC3339)})
		return "节点读取失败"
	}
	cl, closeFn, e := a.Remote.Connect(ctx, t)
	if e != nil {
		_ = a.Store.SaveNodeStatus(n.ID, NodeStatus{Error: "SSH 不通", ObservedAt: time.Now().UTC().Format(time.RFC3339)})
		return "SSH 不通"
	}
	defer closeFn()
	b, e := remote.Run(ctx, cl, "/usr/local/libexec/site-panel-node status")
	if e != nil {
		_ = a.Store.SaveNodeStatus(n.ID, NodeStatus{Error: "agent 无响应", ObservedAt: time.Now().UTC().Format(time.RFC3339)})
		return "agent 无响应"
	}
	var st struct {
		Version    string `json:"version"`
		Nginx      string `json:"nginx"`
		Caddy      string `json:"caddy"`
		ObservedAt string `json:"observed_at"`
	}
	if e = json.Unmarshal(b, &st); e != nil {
		_ = a.Store.SaveNodeStatus(n.ID, NodeStatus{Error: "状态格式错误", ObservedAt: time.Now().UTC().Format(time.RFC3339)})
		return "状态格式错误"
	}
	nginx := st.Caddy
	if nginx == "" {
		nginx = st.Nginx
	}
	if nginx == "" {
		nginx = "?"
	}
	ver := st.Version
	if ver == "" {
		ver = "?"
	}
	obs := st.ObservedAt
	if obs == "" {
		obs = time.Now().UTC().Format(time.RFC3339)
	}
	_ = a.Store.SaveNodeStatus(n.ID, NodeStatus{Nginx: nginx, Caddy: nginx, Version: ver, ObservedAt: obs})
	if nginx != "active" {
		return "Caddy " + nginx
	}
	return "ok"
}

func sendTelegramMessage(ctx context.Context, token, chat, text string) (int64, error) {
	endpoint := "https://api.telegram.org/bot" + token + "/sendMessage"
	body, _ := json.Marshal(map[string]any{
		"chat_id":                  chat,
		"text":                     text,
		"parse_mode":               "HTML",
		"disable_web_page_preview": true,
	})
	req, e := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if e != nil {
		return 0, e
	}
	req.Header.Set("Content-Type", "application/json")
	resp, e := http.DefaultClient.Do(req)
	if e != nil {
		return 0, e
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return 0, fmt.Errorf("telegram HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var parsed struct {
		OK          bool   `json:"ok"`
		Description string `json:"description"`
		Result      struct {
			MessageID int64 `json:"message_id"`
		} `json:"result"`
	}
	_ = json.Unmarshal(raw, &parsed)
	if !parsed.OK {
		if parsed.Description == "" {
			parsed.Description = string(raw)
		}
		return 0, errors.New(parsed.Description)
	}
	return parsed.Result.MessageID, nil
}

func deleteTelegramMessage(ctx context.Context, token, chat string, messageID int64) error {
	if messageID == 0 {
		return nil
	}
	endpoint := "https://api.telegram.org/bot" + token + "/deleteMessage"
	body, _ := json.Marshal(map[string]any{
		"chat_id":    chat,
		"message_id": messageID,
	})
	req, e := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if e != nil {
		return e
	}
	req.Header.Set("Content-Type", "application/json")
	resp, e := http.DefaultClient.Do(req)
	if e != nil {
		return e
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	return nil
}
