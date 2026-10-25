package panel

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
	"site-panel/internal/node"
	"site-panel/internal/remote"
)

func (s *Store) UpdateSite(v Site) error {
	b, e := encodeSiteSpec(v.Site, v.Enabled, v.Vars)
	if e != nil {
		return e
	}
	result, e := s.db.Exec(`UPDATE sites SET spec=? WHERE id=?`, b, v.ID)
	if e != nil {
		return e
	}
	n, e := result.RowsAffected()
	if e == nil && n != 1 {
		return errors.New("站点不存在")
	}
	return e
}
func (s *Store) SaveCertificate(id string, b node.CertificateBundle) error {
	info, e := node.VerifyBundle(b)
	if e != nil {
		return e
	}
	existing, e := s.GetSite(id)
	if e != nil {
		return e
	}
	if existing.SSL != nil && existing.SSL.NotBefore.After(info.NotBefore) && existing.SSL.Fingerprint != info.Fingerprint {
		return errors.New("拒绝用旧证书覆盖较新备份")
	}
	info.Applied = b.Info.Applied
	info.RenewTimer = b.Info.RenewTimer
	b.Info = info
	plain, e := json.Marshal(b)
	if e != nil {
		return e
	}
	encrypted, e := s.seal("certificate:"+id, string(plain))
	if e != nil {
		return e
	}
	metadata, e := json.Marshal(info)
	if e != nil {
		return e
	}
	_, e = s.db.Exec(`INSERT INTO certificates(site_id,info,encrypted) VALUES(?,?,?) ON CONFLICT(site_id) DO UPDATE SET info=excluded.info,encrypted=excluded.encrypted`, id, string(metadata), encrypted)
	return e
}
func (a *App) syncCertificate(cl *ssh.Client, id string) error {
	if !node.ValidID(id) {
		return errors.New("invalid site ID")
	}
	ctx, cancel := context.WithTimeout(a.ctx, 20*time.Second)
	defer cancel()
	// This successful output contains private material. Never include it in logs
	// or HTTP responses. Only derived public metadata is returned to the browser.
	raw, e := remote.Run(ctx, cl, "/usr/local/libexec/site-panel-node certificate-export "+id)
	if e != nil {
		return errors.New("节点证书导出失败，请检查节点版本和证书是否已签发")
	}
	var bundle node.CertificateBundle
	if e = json.Unmarshal(raw, &bundle); e != nil {
		return errors.New("节点证书数据格式无效")
	}
	return a.Store.SaveCertificate(id, bundle)
}
func (a *App) updateSite(w http.ResponseWriter, r *http.Request) {
	current, e := a.Store.GetSite(r.PathValue("id"))
	if e != nil {
		fail(w, 404, "站点不存在")
		return
	}
	var input struct {
		Name    string   `json:"name"`
		Domains []string `json:"domains"`
		Port    int      `json:"port"`
	}
	if e = decode(w, r, &input); e != nil {
		fail(w, 400, e.Error())
		return
	}
	current.Name = input.Name
	current.Port = input.Port
	current.Domains = input.Domains
	for i := range current.Domains {
		current.Domains[i] = strings.ToLower(strings.TrimSpace(current.Domains[i]))
	}
	if e = current.Site.Validate(); e != nil {
		fail(w, 400, e.Error())
		return
	}
	others, e := a.Store.Sites()
	if e != nil {
		fail(w, 500, "读取站点失败")
		return
	}
	for _, other := range others {
		if other.ID == current.ID || other.NodeID != current.NodeID {
			continue
		}
		if other.Port == current.Port || other.SSL != nil {
			for _, a := range current.Domains {
				for _, b := range other.Domains {
					if a == b {
						fail(w, 409, "域名与其他站点冲突")
						return
					}
				}
			}
		}
	}
	if e = a.Store.UpdateSite(current); e != nil {
		fail(w, 500, "保存配置失败")
		return
	}
	reply(w, 200, current)
}
func (a *App) sslRequest(w http.ResponseWriter, r *http.Request) {
	site, e := a.Store.GetSite(r.PathValue("id"))
	if e != nil {
		fail(w, 404, "站点不存在")
		return
	}
	target, e := a.target(site.NodeID)
	if e != nil {
		fail(w, 400, "站点未绑定节点")
		return
	}
	if site.Port == 443 {
		fail(w, 400, "HTTP 端口不能是 443，请先修改端口")
		return
	}
	preserveNginx := false
	if _, ok, e := a.loadCustomNginx(site.ID); e != nil {
		fail(w, 500, "读取 Nginx 配置失败")
		return
	} else if ok {
		preserveNginx = true
	}
	var cfg node.SSLRequest
	if e = decode(w, r, &cfg); e != nil {
		fail(w, 400, e.Error())
		return
	}
	for i := range cfg.Domains {
		cfg.Domains[i] = strings.ToLower(strings.TrimSpace(cfg.Domains[i]))
	}
	cfg.Email = strings.TrimSpace(cfg.Email)
	cfg.NodeIP = target.Host
	if e = cfg.Validate(); e != nil {
		fail(w, 400, e.Error())
		return
	}
	for _, d := range cfg.Domains {
		found := false
		for _, old := range site.Domains {
			found = found || d == old
		}
		if !found {
			site.Domains = append(site.Domains, d)
		}
	}
	all, e := a.Store.Sites()
	if e != nil {
		fail(w, 500, "读取站点失败")
		return
	}
	for _, other := range all {
		if other.ID == site.ID || other.NodeID != site.NodeID {
			continue
		}
		for _, d := range cfg.Domains {
			for _, h := range other.Domains {
				if d == h {
					fail(w, 409, "域名已经属于此节点的其他站点，不能重复申请/监听 80 和 443")
					return
				}
			}
		}
	}
	if e = site.Site.Validate(); e != nil {
		fail(w, 400, e.Error())
		return
	}
	if e = a.Store.UpdateSite(site); e != nil {
		fail(w, 500, "保存站点域名失败")
		return
	}
	id := ID()
	if e = a.Store.NewTask(Task{ID: id, Kind: "ssl", NodeID: site.NodeID, SiteID: site.ID, Status: "queued", Step: "prepare"}); e != nil {
		fail(w, 500, "保存 SSL 任务失败")
		return
	}
	cfg.PreserveNginx = preserveNginx
	req := node.Request{ID: id, Operation: "ssl", Site: site.Site, SSL: &cfg}
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		unlock := a.Remote.Lock(site.NodeID)
		defer unlock()
		_ = a.Store.SetTask(id, "running", "prepare", "")
		ctx, cancel := context.WithTimeout(a.ctx, 30*time.Minute)
		defer cancel()
		err := a.sendSSL(ctx, target, req)
		if err != nil {
			_ = a.Store.SetTask(id, "failed", "submit", err.Error())
			return
		}
		_ = a.Store.SetTask(id, "running", "remote_execution", "")
	}()
	reply(w, 202, map[string]string{"task_id": id})
}
func (a *App) sendSSL(ctx context.Context, target remote.Target, req node.Request) error {
	dir := filepath.Join(a.Store.Dir, "tasks", req.ID)
	if e := os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	if e := node.AtomicJSON(filepath.Join(dir, "request.json"), req); e != nil {
		return e
	}
	cl, close, e := a.Remote.Connect(ctx, target)
	if e != nil {
		return e
	}
	defer close()
	status, e := remote.Run(ctx, cl, "/usr/local/libexec/site-panel-node status")
	if e != nil {
		return e
	}
	var v struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(status, &v) != nil || v.Version == "0.1.0" {
		return errors.New("节点执行器版本过旧，请先点击安装/更新节点")
	}
	f, e := os.Open(filepath.Join(dir, "request.json"))
	if e != nil {
		return e
	}
	defer f.Close()
	rd, _ := node.TaskDir(req.ID)
	if e = remote.Put(cl, rd+"/request.json", f, 0600); e != nil {
		return e
	}
	_, e = remote.Run(ctx, cl, "/usr/local/libexec/site-panel-node submit "+req.ID)
	return e
}
func (a *App) sslSync(w http.ResponseWriter, r *http.Request) {
	site, e := a.Store.GetSite(r.PathValue("id"))
	if e != nil {
		fail(w, 404, "站点不存在")
		return
	}
	target, e := a.target(site.NodeID)
	if e != nil {
		fail(w, 400, "节点不存在")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	cl, close, e := a.Remote.Connect(ctx, target)
	if e != nil {
		fail(w, 502, e.Error())
		return
	}
	defer close()
	if e = a.syncCertificate(cl, site.ID); e != nil {
		fail(w, 502, e.Error())
		return
	}
	site, e = a.Store.GetSite(site.ID)
	if e != nil {
		fail(w, 500, "读取状态失败")
		return
	}
	reply(w, 200, site.SSL)
}
