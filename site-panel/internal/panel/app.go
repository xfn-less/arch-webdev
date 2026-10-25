package panel

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
	"site-panel/internal/node"
	"site-panel/internal/remote"
)

type App struct {
	Store        *Store
	Remote       *remote.Client
	NodeBinary   string
	SecureCookie bool
	mux          *http.ServeMux
	mu           sync.Mutex
	siteLocks    map[string]*sync.Mutex
	rateMu       sync.Mutex
	lastLogin    time.Time
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
}

func New(s *Store, keyFile, binary string, assets fs.FS) *App {
	ctx, cancel := context.WithCancel(context.Background())
	a := &App{Store: s, Remote: remote.New(keyFile), NodeBinary: binary, mux: http.NewServeMux(), siteLocks: map[string]*sync.Mutex{}, ctx: ctx, cancel: cancel}
	a.mux.HandleFunc("GET /api/session", a.session)
	a.mux.HandleFunc("POST /api/setup", a.setup)
	a.mux.HandleFunc("POST /api/login", a.login)
	a.mux.Handle("POST /api/logout", a.auth(http.HandlerFunc(a.logout)))
	a.mux.Handle("GET /api/nodes", a.auth(http.HandlerFunc(a.listNodes)))
	a.mux.Handle("POST /api/nodes/probe", a.auth(http.HandlerFunc(a.probe)))
	a.mux.Handle("POST /api/nodes", a.auth(http.HandlerFunc(a.addNode)))
	a.mux.Handle("PUT /api/nodes/{id}", a.auth(http.HandlerFunc(a.updateNode)))
	a.mux.Handle("PUT /api/nodes/{id}/fingerprint", a.auth(http.HandlerFunc(a.updateNodeFingerprint)))
	a.mux.Handle("POST /api/nodes/{id}/install", a.auth(http.HandlerFunc(a.installNode)))
	a.mux.Handle("GET /api/nodes/{id}/status", a.auth(http.HandlerFunc(a.nodeStatus)))
	a.mux.Handle("GET /api/sites", a.auth(http.HandlerFunc(a.listSites)))
	a.mux.Handle("POST /api/sites", a.auth(http.HandlerFunc(a.addSite)))
	a.mux.Handle("PUT /api/sites/{id}", a.auth(http.HandlerFunc(a.updateSite)))
	a.mux.Handle("PUT /api/sites/{id}/vars", a.auth(http.HandlerFunc(a.putSiteVars)))
	a.mux.Handle("PUT /api/sites/{id}/bind", a.auth(http.HandlerFunc(a.bindSite)))
	a.mux.Handle("POST /api/sites/{id}/copy", a.auth(http.HandlerFunc(a.copySite)))
	a.mux.Handle("POST /api/sites/{id}/disable", a.auth(http.HandlerFunc(a.disableSite)))
	a.mux.Handle("POST /api/sites/{id}/enable", a.auth(http.HandlerFunc(a.enableSite)))
	a.mux.Handle("DELETE /api/sites/{id}", a.auth(http.HandlerFunc(a.deleteSite)))
	a.mux.Handle("GET /api/sites/{id}/config", a.auth(http.HandlerFunc(a.siteConfig)))
	a.mux.Handle("PUT /api/sites/{id}/config", a.auth(http.HandlerFunc(a.putSiteConfig)))
	a.mux.Handle("DELETE /api/sites/{id}/config", a.auth(http.HandlerFunc(a.resetSiteConfig)))
	a.mux.Handle("POST /api/sites/{id}/ssl", a.auth(http.HandlerFunc(a.sslRequest)))
	a.mux.Handle("POST /api/sites/{id}/ssl/sync", a.auth(http.HandlerFunc(a.sslSync)))
	a.mux.Handle("GET /api/sites/{id}/files", a.auth(http.HandlerFunc(a.files)))
	a.mux.Handle("GET /api/sites/{id}/file", a.auth(http.HandlerFunc(a.readFile)))
	a.mux.Handle("POST /api/sites/{id}/file", a.auth(http.HandlerFunc(a.writeFile)))
	a.mux.Handle("DELETE /api/sites/{id}/file", a.auth(http.HandlerFunc(a.deleteFile)))
	a.mux.Handle("POST /api/sites/{id}/mkdir", a.auth(http.HandlerFunc(a.mkdirFile)))
	a.mux.Handle("POST /api/sites/{id}/rename", a.auth(http.HandlerFunc(a.renameFile)))
	a.mux.Handle("GET /api/sites/{id}/download", a.auth(http.HandlerFunc(a.downloadFile)))
	a.mux.Handle("POST /api/sites/{id}/unzip", a.auth(http.HandlerFunc(a.unzipFile)))
	a.mux.Handle("GET /api/sites/{id}/dns", a.auth(http.HandlerFunc(a.siteDNS)))
	a.mux.Handle("GET /api/sites/{id}/deploy-preview", a.auth(http.HandlerFunc(a.siteDeployPreview)))
	a.mux.Handle("POST /api/sites/{id}/deploy", a.auth(http.HandlerFunc(a.deploy)))
	a.mux.Handle("GET /api/telegram", a.auth(http.HandlerFunc(a.getTelegram)))
	a.mux.Handle("PUT /api/telegram", a.auth(http.HandlerFunc(a.putTelegram)))
	a.mux.Handle("POST /api/telegram/overview", a.auth(http.HandlerFunc(a.pushTelegramOverview)))
	a.mux.Handle("GET /api/tasks", a.auth(http.HandlerFunc(a.tasks)))
	a.mux.Handle("GET /api/tasks/{id}/logs", a.auth(http.HandlerFunc(a.taskLogs)))
	a.mux.Handle("POST /api/tasks/{id}/refresh", a.auth(http.HandlerFunc(a.refreshTask)))
	a.mux.Handle("POST /api/tasks/{id}/dismiss", a.auth(http.HandlerFunc(a.dismissTask)))
	a.mux.Handle("POST /api/nodes/{id}/dismiss-attention", a.auth(http.HandlerFunc(a.dismissNodeAttention)))
	a.mux.Handle("/api/", http.NotFoundHandler())
	a.mux.Handle("/", http.FileServer(http.FS(assets)))
	a.startTelegramScheduler()
	return a
}
func (a *App) Close() { a.cancel(); a.wg.Wait() }
func (a *App) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "same-origin")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
	if strings.HasPrefix(r.URL.Path, "/api/") {
		w.Header().Set("Cache-Control", "no-store")
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		if origin := r.Header.Get("Origin"); origin != "" {
			u, e := url.Parse(origin)
			if e != nil || u.Host != r.Host {
				fail(w, 403, "请求来源不匹配")
				return
			}
		}
	}
	a.mux.ServeHTTP(w, r)
}
func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, message string) {
	reply(w, status, map[string]string{"error": message})
}
func decode(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		return errors.New("请求 JSON 无效")
	}
	var tail any
	if e := d.Decode(&tail); e != io.EOF {
		return errors.New("请求包含多余数据")
	}
	return nil
}
func tokenHash(s string) string { v := sha256.Sum256([]byte(s)); return hex.EncodeToString(v[:]) }
func (a *App) lockSite(id string) func() {
	a.mu.Lock()
	m := a.siteLocks[id]
	if m == nil {
		m = &sync.Mutex{}
		a.siteLocks[id] = m
	}
	a.mu.Unlock()
	m.Lock()
	return m.Unlock
}
func (a *App) sessionData(r *http.Request) (string, bool) {
	c, e := r.Cookie("panel_session")
	if e != nil {
		return "", false
	}
	var csrf string
	var expires int64
	e = a.Store.db.QueryRow(`SELECT csrf,expires FROM session WHERE id=1 AND token=?`, tokenHash(c.Value)).Scan(&csrf, &expires)
	return csrf, e == nil && expires > time.Now().Unix()
}
func (a *App) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		csrf, ok := a.sessionData(r)
		if !ok {
			fail(w, 401, "请重新登录")
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" && subtle.ConstantTimeCompare([]byte(csrf), []byte(r.Header.Get("X-CSRF-Token"))) != 1 {
			fail(w, 403, "请求验证失败，请刷新页面")
			return
		}
		next.ServeHTTP(w, r)
	})
}
func (a *App) session(w http.ResponseWriter, r *http.Request) {
	var n int
	if e := a.Store.db.QueryRow(`SELECT COUNT(*) FROM account`).Scan(&n); e != nil {
		fail(w, 500, "数据库读取失败")
		return
	}
	csrf, ok := a.sessionData(r)
	reply(w, 200, map[string]any{"initialized": n > 0, "authenticated": ok, "csrf": csrf})
}
func (a *App) allowLogin() bool {
	a.rateMu.Lock()
	defer a.rateMu.Unlock()
	if time.Since(a.lastLogin) < time.Second {
		return false
	}
	a.lastLogin = time.Now()
	return true
}

type credential struct {
	Password string `json:"password"`
}

func (a *App) setup(w http.ResponseWriter, r *http.Request) {
	if !a.allowLogin() {
		fail(w, 429, "请稍后重试")
		return
	}
	var v credential
	if e := decode(w, r, &v); e != nil {
		fail(w, 400, e.Error())
		return
	}
	if len(v.Password) < 12 || len(v.Password) > 72 {
		fail(w, 400, "面板密码需要 12～72 字节")
		return
	}
	hash, e := bcrypt.GenerateFromPassword([]byte(v.Password), bcrypt.DefaultCost)
	if e != nil {
		fail(w, 500, "密码处理失败")
		return
	}
	if _, e = a.Store.db.Exec(`INSERT INTO account(id,hash) VALUES(1,?)`, hash); e != nil {
		fail(w, 409, "面板已初始化，请登录")
		return
	}
	a.startSession(w)
}
func (a *App) login(w http.ResponseWriter, r *http.Request) {
	if !a.allowLogin() {
		fail(w, 429, "请稍后重试")
		return
	}
	var v credential
	if e := decode(w, r, &v); e != nil {
		fail(w, 400, e.Error())
		return
	}
	var hash []byte
	e := a.Store.db.QueryRow(`SELECT hash FROM account WHERE id=1`).Scan(&hash)
	if e != nil || bcrypt.CompareHashAndPassword(hash, []byte(v.Password)) != nil {
		fail(w, 401, "密码错误或尚未初始化")
		return
	}
	a.startSession(w)
}
func (a *App) startSession(w http.ResponseWriter) {
	token, csrf := ID()+ID(), ID()
	expires := time.Now().Add(12 * time.Hour)
	if _, e := a.Store.db.Exec(`INSERT INTO session VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,csrf=excluded.csrf,expires=excluded.expires`, tokenHash(token), csrf, expires.Unix()); e != nil {
		fail(w, 500, "会话保存失败")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "panel_session", Value: token, Path: "/", HttpOnly: true, Secure: a.SecureCookie, SameSite: http.SameSiteStrictMode, MaxAge: 43200})
	reply(w, 200, map[string]string{"csrf": csrf})
}
func (a *App) logout(w http.ResponseWriter, r *http.Request) {
	_, e := a.Store.db.Exec(`DELETE FROM session`)
	if e != nil {
		fail(w, 500, "退出失败")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "panel_session", Value: "", Path: "/", HttpOnly: true, Secure: a.SecureCookie, SameSite: http.SameSiteStrictMode, MaxAge: -1})
	reply(w, 200, map[string]bool{"ok": true})
}
func (a *App) listNodes(w http.ResponseWriter, r *http.Request) {
	v, e := a.Store.Nodes()
	if e != nil {
		fail(w, 500, "节点读取失败")
		return
	}
	reply(w, 200, v)
}

type nodeInput struct {
	Node
	Password string `json:"password"`
}

func (a *App) probe(w http.ResponseWriter, r *http.Request) {
	var v struct {
		Host string `json:"host"`
		Port int    `json:"port"`
		User string `json:"user"`
	}
	if e := decode(w, r, &v); e != nil {
		fail(w, 400, e.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	fp, e := remote.Probe(ctx, remote.Target{Host: v.Host, Port: v.Port, User: v.User})
	if e != nil {
		fail(w, 400, e.Error())
		return
	}
	reply(w, 200, map[string]string{"fingerprint": fp})
}
func (a *App) addNode(w http.ResponseWriter, r *http.Request) {
	var v nodeInput
	if e := decode(w, r, &v); e != nil {
		fail(w, 400, e.Error())
		return
	}
	v.ID = ID()
	if strings.TrimSpace(v.Name) == "" || !strings.HasPrefix(v.Fingerprint, "SHA256:") {
		fail(w, 400, "需要名称并确认主机指纹")
		return
	}
	if e := remote.Validate(remote.Target{Host: v.Host, Port: v.Port, User: v.User}); e != nil {
		fail(w, 400, e.Error())
		return
	}
	if v.Password == "" && a.Remote.KeyFile == "" {
		fail(w, 400, "请填写 SSH 密码")
		return
	}
	if e := a.Store.SaveNode(v.Node, v.Password); e != nil {
		fail(w, 500, "保存节点失败")
		return
	}
	reply(w, 201, v.Node)
}

func (a *App) updateNode(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	n, _, e := a.Store.GetNode(id)
	if e != nil {
		fail(w, 404, "节点不存在")
		return
	}
	var body struct {
		Name     string `json:"name"`
		Note     string `json:"note"`
		Password string `json:"password"`
	}
	if e := decode(w, r, &body); e != nil {
		fail(w, 400, e.Error())
		return
	}
	if strings.TrimSpace(body.Name) != "" {
		n.Name = strings.TrimSpace(body.Name)
	}
	n.Note = strings.TrimSpace(body.Note)
	if e := a.Store.UpdateNodeMeta(n.ID, n.Name, n.Note); e != nil {
		fail(w, 500, "保存节点失败")
		return
	}
	if pw := strings.TrimSpace(body.Password); pw != "" {
		if e := a.Store.UpdateNodePassword(n.ID, pw); e != nil {
			fail(w, 400, e.Error())
			return
		}
	}
	reply(w, 200, n)
}

// updateNodeFingerprint re-probes the live host key and only accepts the
// fingerprint currently presented by that host. Used after OS reinstall / key rotate.
func (a *App) updateNodeFingerprint(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	n, _, e := a.Store.GetNode(id)
	if e != nil {
		fail(w, 404, "节点不存在")
		return
	}
	var body struct {
		Fingerprint string `json:"fingerprint"`
	}
	if e := decode(w, r, &body); e != nil {
		fail(w, 400, e.Error())
		return
	}
	want := strings.TrimSpace(body.Fingerprint)
	if !strings.HasPrefix(want, "SHA256:") {
		fail(w, 400, "需要确认主机指纹")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	live, e := remote.Probe(ctx, remote.Target{Host: n.Host, Port: n.Port, User: n.User})
	if e != nil {
		fail(w, 400, e.Error())
		return
	}
	if live != want {
		fail(w, 400, "指纹与当前主机不一致，请重新读取后再确认")
		return
	}
	if live == n.Fingerprint {
		reply(w, 200, map[string]any{"node": n, "changed": false})
		return
	}
	if e := a.Store.UpdateNodeFingerprint(n.ID, live); e != nil {
		fail(w, 500, "保存指纹失败")
		return
	}
	n.Fingerprint = live
	reply(w, 200, map[string]any{"node": n, "changed": true})
}
func (a *App) target(id string) (remote.Target, error) {
	n, p, e := a.Store.GetNode(id)
	return remote.Target{Host: n.Host, Port: n.Port, User: n.User, Password: p, Fingerprint: n.Fingerprint}, e
}
func (a *App) installNode(w http.ResponseWriter, r *http.Request) {
	nid := r.PathValue("id")
	t, e := a.target(nid)
	if e != nil {
		fail(w, 404, "节点不存在")
		return
	}
	id := ID()
	if e = a.Store.NewTask(Task{ID: id, NodeID: nid, Status: "queued", Step: "install"}); e != nil {
		fail(w, 500, "保存任务失败")
		return
	}
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		unlock := a.Remote.Lock(nid)
		defer unlock()
		_ = a.Store.SetTask(id, "running", "install", "")
		ctx, cancel := context.WithTimeout(a.ctx, 15*time.Minute)
		defer cancel()
		cl, close, e := a.Remote.Connect(ctx, t)
		if e == nil {
			defer close()
			e = remote.Install(ctx, cl, a.NodeBinary)
		}
		if e != nil {
			_ = a.Store.SetTask(id, "failed", "install", e.Error())
			return
		}
		_ = a.Store.SetTask(id, "succeeded", "installed", "")
	}()
	reply(w, 202, map[string]string{"task_id": id})
}
func (a *App) nodeStatus(w http.ResponseWriter, r *http.Request) {
	t, e := a.target(r.PathValue("id"))
	if e != nil {
		fail(w, 404, "节点不存在")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	cl, close, e := a.Remote.Connect(ctx, t)
	if e != nil {
		fail(w, 502, e.Error())
		return
	}
	defer close()
	b, e := remote.Run(ctx, cl, "/usr/local/libexec/site-panel-node status")
	if e != nil {
		fail(w, 502, e.Error())
		return
	}
	var result any
	if e = json.Unmarshal(b, &result); e != nil {
		fail(w, 502, "节点返回格式错误")
		return
	}
	reply(w, 200, result)
}
func (a *App) listSites(w http.ResponseWriter, r *http.Request) {
	v, e := a.Store.Sites()
	if e != nil {
		fail(w, 500, "读取站点失败")
		return
	}
	reply(w, 200, v)
}
func (a *App) addSite(w http.ResponseWriter, r *http.Request) {
	var v Site
	if e := decode(w, r, &v); e != nil {
		fail(w, 400, e.Error())
		return
	}
	v.ID = ID()
	v.Enabled = true
	if e := v.Site.Validate(); e != nil {
		fail(w, 400, e.Error())
		return
	}
	if _, _, e := a.Store.GetNode(v.NodeID); e != nil {
		fail(w, 400, "请选择节点")
		return
	}
	existing, e := a.Store.Sites()
	if e != nil {
		fail(w, 500, "读取站点失败")
		return
	}
	for _, s := range existing {
		if s.NodeID == v.NodeID && s.Port == v.Port {
			for _, h := range s.Domains {
				for _, h2 := range v.Domains {
					if strings.EqualFold(h, h2) {
						fail(w, 409, "相同节点/端口已有该域名")
						return
					}
				}
			}
		}
	}
	if e = os.MkdirAll(filepath.Join(a.Store.Dir, "sites", v.ID), 0700); e != nil {
		fail(w, 500, "创建目录失败")
		return
	}
	if e = a.Store.SaveSite(v); e != nil {
		fail(w, 500, "保存站点失败")
		return
	}
	reply(w, 201, v)
}
func (a *App) siteConfig(w http.ResponseWriter, r *http.Request) {
	s, e := a.Store.GetSite(r.PathValue("id"))
	if e != nil {
		fail(w, 404, "站点不存在")
		return
	}
	c, source, e := a.siteNginxText(s)
	if e != nil {
		fail(w, 400, e.Error())
		return
	}
	reply(w, 200, map[string]string{"config": c, "source": source})
}
func (a *App) putSiteConfig(w http.ResponseWriter, r *http.Request) {
	s, e := a.Store.GetSite(r.PathValue("id"))
	if e != nil {
		fail(w, 404, "站点不存在")
		return
	}
	var body struct {
		Config string `json:"config"`
	}
	if e = decode(w, r, &body); e != nil {
		fail(w, 400, e.Error())
		return
	}
	if e = a.saveCustomNginx(s.ID, body.Config); e != nil {
		fail(w, 400, e.Error())
		return
	}
	reply(w, 200, map[string]string{"config": body.Config, "source": "custom"})
}
func (a *App) resetSiteConfig(w http.ResponseWriter, r *http.Request) {
	s, e := a.Store.GetSite(r.PathValue("id"))
	if e != nil {
		fail(w, 404, "站点不存在")
		return
	}
	if e = a.clearCustomNginx(s.ID); e != nil {
		fail(w, 500, "清除自定义配置失败")
		return
	}
	c, e := node.PreviewConfig(s.Site, s.SSL)
	if e != nil {
		fail(w, 400, e.Error())
		return
	}
	reply(w, 200, map[string]string{"config": c, "source": "generated"})
}
func safePath(p string) bool {
	return p != "" && !filepath.IsAbs(p) && !strings.Contains(p, "\\") && filepath.Clean(p) != "." && filepath.Clean(p) != ".." && !strings.HasPrefix(filepath.Clean(p), "../") && !strings.ContainsRune(p, 0)
}
func (a *App) siteRoot(id string) (*os.Root, error) {
	if !node.ValidID(id) {
		return nil, errors.New("无效站点")
	}
	if _, e := a.Store.GetSite(id); e != nil {
		return nil, e
	}
	return os.OpenRoot(filepath.Join(a.Store.Dir, "sites", id))
}
func (a *App) files(w http.ResponseWriter, r *http.Request) {
	root, e := a.siteRoot(r.PathValue("id"))
	if e != nil {
		fail(w, 404, "站点不存在")
		return
	}
	defer root.Close()
	out, e := listSiteEntries(root)
	if e != nil {
		fail(w, 400, e.Error())
		return
	}
	reply(w, 200, out)
}
func (a *App) readFile(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if !safePath(p) {
		fail(w, 400, "文件路径无效")
		return
	}
	root, e := a.siteRoot(r.PathValue("id"))
	if e != nil {
		fail(w, 404, "站点不存在")
		return
	}
	defer root.Close()
	f, e := root.Open(p)
	if e != nil {
		fail(w, 404, "文件不存在")
		return
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil || !st.Mode().IsRegular() || st.Size() > 1<<20 {
		fail(w, 400, "文本编辑仅支持不超过 1 MB 的普通文件")
		return
	}
	content, e := io.ReadAll(io.LimitReader(f, (1<<20)+1))
	if e != nil || len(content) > 1<<20 || !utf8.Valid(content) || strings.ContainsRune(string(content), 0) {
		fail(w, 400, "该文件不是可编辑的 UTF-8 文本")
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write(content)
}
func (a *App) writeFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	unlock := a.lockSite(id)
	defer unlock()
	p := r.URL.Query().Get("path")
	if !safePath(p) {
		fail(w, 400, "文件路径无效")
		return
	}
	root, e := a.siteRoot(id)
	if e != nil {
		fail(w, 404, "站点不存在")
		return
	}
	defer root.Close()
	if e = root.MkdirAll(filepath.Dir(p), 0700); e != nil {
		fail(w, 400, "创建目录失败")
		return
	}
	tmp := p + ".upload-" + ID()
	f, e := root.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		fail(w, 400, "创建临时文件失败")
		return
	}
	defer root.Remove(tmp)
	r.Body = http.MaxBytesReader(w, r.Body, 2<<30)
	_, e = io.Copy(f, r.Body)
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e == nil {
		e = root.Rename(tmp, p)
	}
	if e != nil {
		fail(w, 400, "文件保存失败：大小超限、磁盘不足或路径错误")
		return
	}
	reply(w, 200, map[string]bool{"saved": true})
}
func (a *App) tasks(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("node_id")
	if id != "" {
		if !node.ValidID(id) {
			fail(w, 400, "无效节点 ID")
			return
		}
		if _, _, e := a.Store.GetNode(id); e != nil {
			fail(w, 404, "节点不存在")
			return
		}
	}
	v, e := a.Store.Tasks(id)
	if e != nil {
		fail(w, 500, "读取任务失败")
		return
	}
	reply(w, 200, v)
}
func (a *App) siteDNS(w http.ResponseWriter, r *http.Request) {
	s, e := a.Store.GetSite(r.PathValue("id"))
	if e != nil {
		fail(w, 404, "站点不存在")
		return
	}
	target, e := a.target(s.NodeID)
	if e != nil {
		fail(w, 400, "站点未关联有效节点")
		return
	}
	reply(w, 200, buildDNSReport(s, target.Host))
}
func (a *App) deploy(w http.ResponseWriter, r *http.Request) {
	s, e := a.Store.GetSite(r.PathValue("id"))
	if e != nil {
		fail(w, 404, "站点不存在")
		return
	}
	if !s.Enabled {
		fail(w, 400, "站点已停用，请先启用再部署")
		return
	}
	target, e := a.target(s.NodeID)
	if e != nil {
		fail(w, 400, "站点未关联有效节点")
		return
	}
	force := false
	if r.ContentLength != 0 {
		var body struct {
			Force bool `json:"force"`
		}
		if e = decode(w, r, &body); e != nil {
			fail(w, 400, e.Error())
			return
		}
		force = body.Force
	}
	if warn := dnsMismatch(s, target.Host); warn != "" && !force {
		fail(w, 409, warn+"。确认解析无误后可强制继续部署")
		return
	}
	id := ID()
	if e = a.Store.NewTask(Task{ID: id, NodeID: s.NodeID, SiteID: s.ID, Status: "queued", Step: "prepare"}); e != nil {
		fail(w, 500, "创建任务失败")
		return
	}
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		unlockNode := a.Remote.Lock(s.NodeID)
		defer unlockNode()
		_ = a.Store.SetTask(id, "running", "prepare", "")
		ctx, cancel := context.WithTimeout(a.ctx, 30*time.Minute)
		defer cancel()
		note, err := a.sendDeploy(ctx, target, s, id)
		if err != nil {
			_ = a.Store.SetTask(id, "failed", "submit", err.Error())
			return
		}
		_ = a.Store.SetTask(id, "running", "remote_execution", note)
	}()
	reply(w, 202, map[string]string{"task_id": id})
}
func (a *App) sendDeploy(ctx context.Context, target remote.Target, s Site, id string) (string, error) {
	unlock := a.lockSite(s.ID)
	dir := filepath.Join(a.Store.Dir, "tasks", id)
	if e := os.MkdirAll(dir, 0700); e != nil {
		unlock()
		return "", e
	}
	bundlePath := filepath.Join(dir, "bundle.tar")
	digest, replaced, e := a.bundleWithVars(s.ID, bundlePath, s.Vars)
	unlock()
	if e != nil {
		return "", e
	}
	note := fmt.Sprintf("已打包；替换 %d 处变量", replaced)
	if snap, e := a.siteContentManifest(s); e == nil {
		_ = a.writeTaskManifest(id, snap)
	}
	req := node.Request{ID: id, Site: s.Site, BundleSHA256: digest}
	if custom, ok, e := a.loadCustomNginx(s.ID); e != nil {
		return "", e
	} else if ok {
		req.NginxConfig = custom
	}
	b, e := json.Marshal(req)
	if e != nil {
		return "", e
	}
	cl, close, e := a.Remote.Connect(ctx, target)
	if e != nil {
		return "", e
	}
	defer close()
	remoteDir, _ := node.TaskDir(id)
	f, e := os.Open(bundlePath)
	if e != nil {
		return "", e
	}
	defer f.Close()
	if e = remote.Put(cl, remoteDir+"/bundle.tar", f, 0600); e != nil {
		return "", e
	}
	if e = remote.Put(cl, remoteDir+"/request.json", strings.NewReader(string(b)), 0600); e != nil {
		return "", e
	}
	_, e = remote.Run(ctx, cl, "/usr/local/libexec/site-panel-node submit "+id)
	if e != nil {
		return "", e
	}
	return note, nil
}
func (a *App) bundle(id, dest string) (string, error) {
	digest, _, e := a.bundleWithVars(id, dest, nil)
	return digest, e
}
func (a *App) dismissTask(w http.ResponseWriter, r *http.Request) {
	t, e := a.Store.GetTask(r.PathValue("id"))
	if e != nil {
		fail(w, 404, "任务不存在")
		return
	}
	if id := r.URL.Query().Get("node_id"); id != "" && id != t.NodeID {
		fail(w, 404, "当前节点没有此任务")
		return
	}
	if e = a.Store.DismissTask(t.ID); e != nil {
		fail(w, 400, e.Error())
		return
	}
	t, e = a.Store.GetTask(t.ID)
	if e != nil {
		fail(w, 500, "读取任务失败")
		return
	}
	reply(w, 200, t)
}

func (a *App) dismissNodeAttention(w http.ResponseWriter, r *http.Request) {
	n, e := a.Store.DismissNodeAttention(r.PathValue("id"))
	if e != nil {
		fail(w, 400, e.Error())
		return
	}
	reply(w, 200, map[string]any{"dismissed": n})
}

func (a *App) refreshTask(w http.ResponseWriter, r *http.Request) {
	t, e := a.Store.GetTask(r.PathValue("id"))
	if id := r.URL.Query().Get("node_id"); id != "" && id != t.NodeID {
		fail(w, 404, "当前节点没有此任务")
		return
	}
	if e != nil {
		fail(w, 404, "任务不存在")
		return
	}
	if t.SiteID == "" || t.Status == "succeeded" || t.Status == "failed" {
		reply(w, 200, t)
		return
	}
	if t.Step == "prepare" && t.Status != "needs_attention" {
		reply(w, 200, t)
		return
	}
	target, e := a.target(t.NodeID)
	if e != nil {
		fail(w, 404, "节点不存在")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	cl, close, e := a.Remote.Connect(ctx, target)
	if e != nil {
		fail(w, 502, "状态未知："+e.Error())
		return
	}
	defer close()
	b, e := remote.Run(ctx, cl, "/usr/local/libexec/site-panel-node task-status "+t.ID)
	if e != nil {
		fail(w, 502, "状态未知："+e.Error())
		return
	}
	var result node.Result
	if e = json.Unmarshal(b, &result); e != nil || result.ID != t.ID {
		fail(w, 502, "任务结果无效")
		return
	}
	if t.Kind == "ssl" && result.Status == "succeeded" && result.Step == "ssl_done" {
		if err := a.syncCertificate(cl, t.SiteID); err != nil {
			_ = a.Store.SetTask(t.ID, "needs_attention", "ssl_sync", "证书可能已启用，但主控备份同步失败："+err.Error())
			v, _ := a.Store.GetTask(t.ID)
			reply(w, 200, v)
			return
		}
	}
	if e = a.Store.SetTask(t.ID, result.Status, result.Step, result.Error); e != nil {
		fail(w, 500, "保存结果失败")
		return
	}
	if result.Status == "succeeded" && t.SiteID != "" && (t.Kind == "" || t.Kind == "deploy") {
		a.commitDeploySnapshot(t.SiteID, t.ID)
	}
	t, e = a.Store.GetTask(t.ID)
	if e != nil {
		fail(w, 500, "读取结果失败")
		return
	}
	reply(w, 200, t)
}
