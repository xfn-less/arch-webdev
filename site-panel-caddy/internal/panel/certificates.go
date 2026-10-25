package panel

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
	"site-panel/internal/node"
	"site-panel/internal/remote"
)

func (s *Store) UpdateSite(v Site) error {
	b, e := encodeSiteSpec(v.Site, v.Enabled, v.Vars, v.PublishPath)
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
		Name        string            `json:"name"`
		Domains     []string          `json:"domains"`
		Port        int               `json:"port"`
		Cert        string            `json:"cert"`
		Mode        string            `json:"mode"`
		Upstreams   []string          `json:"upstreams"`
		Proxies     []node.ProxyRoute `json:"proxies"`
		RedirHTTPS  *bool             `json:"redir_https"`
		PublishPath *string           `json:"publish_path"`
	}
	if e = decode(w, r, &input); e != nil {
		fail(w, 400, e.Error())
		return
	}
	current.Name = input.Name
	if input.PublishPath != nil {
		p, e := normalizePublishPath(*input.PublishPath)
		if e != nil {
			fail(w, 400, e.Error())
			return
		}
		current.PublishPath = p
	}
	nodeHost := ""
	if n, _, e := a.Store.GetNode(current.NodeID); e == nil {
		nodeHost = n.Host
	}
	expanded, e := node.ExpandIPAlias(input.Domains, nodeHost)
	if e != nil {
		fail(w, 400, e.Error())
		return
	}
	current.Domains = expanded
	for i := range current.Domains {
		current.Domains[i] = strings.ToLower(strings.TrimSpace(current.Domains[i]))
	}
	// Port is derived from the listen list (ip:8888 rows). Keep explicit only as fallback.
	current.Port = input.Port
	switch c := strings.ToLower(strings.TrimSpace(input.Cert)); c {
	case "", "auto", "off", "custom":
		current.Cert = c
	default:
		fail(w, 400, "证书模式仅支持 auto / off / custom")
		return
	}
	if m := strings.ToLower(strings.TrimSpace(input.Mode)); m != "" {
		switch m {
		case "static", "proxy":
			current.Mode = m
		default:
			fail(w, 400, "站点模式仅支持 static / proxy")
			return
		}
	}
	if input.Upstreams != nil {
		clean := make([]string, 0, len(input.Upstreams))
		for _, u := range input.Upstreams {
			u = strings.TrimSpace(u)
			if u != "" {
				clean = append(clean, u)
			}
		}
		current.Upstreams = clean
	}
	if input.Proxies != nil {
		current.Proxies = append([]node.ProxyRoute{}, input.Proxies...)
		// Path proxies mean generated static+proxy config; drop legacy whole-site proxy mode.
		if len(current.Proxies) > 0 {
			current.Mode = "static"
			current.Upstreams = nil
		}
	}
	if input.RedirHTTPS != nil {
		v := *input.RedirHTTPS
		current.RedirHTTPS = &v
	}
	current.Site = current.Site.Normalized()
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
		for _, a := range current.Domains {
			for _, b := range other.Domains {
				if strings.EqualFold(a, b) {
					fail(w, 409, "地址与其他站点冲突："+a)
					return
				}
			}
		}
	}
	if e = a.ensurePublishDir(current.ID, current.PublishPath); e != nil {
		fail(w, 500, e.Error())
		return
	}
	if e = a.Store.UpdateSite(current); e != nil {
		fail(w, 500, "保存配置失败")
		return
	}
	// 配置页 is source of truth; drop hand-edited Caddyfile so deploy uses generated config.
	if e = a.clearCustomNginx(current.ID); e != nil {
		fail(w, 500, e.Error())
		return
	}
	reply(w, 200, current)
}
func (a *App) sslRequest(w http.ResponseWriter, r *http.Request) {
	// Caddy edition: no separate certbot-style request. Certificates are issued by
	// Caddy on deploy for all site domains when cert=auto.
	if _, e := a.Store.GetSite(r.PathValue("id")); e != nil {
		fail(w, 404, "站点不存在")
		return
	}
	fail(w, 400, "Caddy 版不单独申请 SSL：域名页选「自动 HTTPS」，保存后点部署即可覆盖全部域名")
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
