package panel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"site-panel/internal/node"
	"site-panel/internal/remote"
)

// lookupSiteIPs resolves A/AAAA without trusting the local stub resolver.
// Dev machines often run Clash/fake-ip and would otherwise report 198.18.x.x.
var lookupSiteIPs = lookupPublicIPs

const minAgentVersion = "0.3.1"

func parseAgentVersion(v string) (major, minor, patch int, ok bool) {
	v = strings.TrimSpace(v)
	v = strings.TrimSuffix(v, "-caddy")
	parts := strings.Split(v, ".")
	if len(parts) < 2 {
		return 0, 0, 0, false
	}
	nums := make([]int, 3)
	for i := 0; i < 3 && i < len(parts); i++ {
		n := 0
		for _, r := range parts[i] {
			if r < '0' || r > '9' {
				break
			}
			n = n*10 + int(r-'0')
		}
		nums[i] = n
	}
	return nums[0], nums[1], nums[2], true
}

func agentVersionOK(v string) bool {
	maj, min, pat, ok := parseAgentVersion(v)
	if !ok {
		return false
	}
	wMaj, wMin, wPat, _ := parseAgentVersion(minAgentVersion)
	if maj != wMaj {
		return maj > wMaj
	}
	if min != wMin {
		return min > wMin
	}
	return pat >= wPat
}

func lookupPublicIPs(host string) ([]net.IP, error) {
	if ips, e := lookupDoH(host); e == nil && len(ips) > 0 {
		return ips, nil
	}
	r := &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			d := net.Dialer{Timeout: 3 * time.Second}
			var last error
			for _, dns := range []string{"1.1.1.1:53", "8.8.8.8:53"} {
				c, e := d.DialContext(ctx, "udp", dns)
				if e == nil {
					return c, nil
				}
				last = e
			}
			return nil, last
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return r.LookupIP(ctx, "ip", host)
}

func lookupDoH(host string) ([]net.IP, error) {
	var last error
	client := &http.Client{Timeout: 5 * time.Second}
	for _, base := range []string{
		"https://cloudflare-dns.com/dns-query",
		"https://dns.google/resolve",
	} {
		u := base + "?name=" + url.QueryEscape(host) + "&type=A"
		req, e := http.NewRequest(http.MethodGet, u, nil)
		if e != nil {
			last = e
			continue
		}
		req.Header.Set("Accept", "application/dns-json")
		resp, e := client.Do(req)
		if e != nil {
			last = e
			continue
		}
		body, e := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		_ = resp.Body.Close()
		if e != nil {
			last = e
			continue
		}
		if resp.StatusCode != 200 {
			last = fmt.Errorf("DoH status %d", resp.StatusCode)
			continue
		}
		var parsed struct {
			Status int `json:"Status"`
			Answer []struct {
				Type int    `json:"type"`
				Data string `json:"data"`
			} `json:"Answer"`
		}
		if e = json.Unmarshal(body, &parsed); e != nil {
			last = e
			continue
		}
		if parsed.Status != 0 {
			last = fmt.Errorf("DNS status %d", parsed.Status)
			continue
		}
		var ips []net.IP
		for _, ans := range parsed.Answer {
			if ans.Type != 1 {
				continue
			}
			if ip := net.ParseIP(ans.Data); ip != nil {
				ips = append(ips, ip)
			}
		}
		if len(ips) > 0 {
			return ips, nil
		}
		last = fmt.Errorf("no A record")
	}
	return nil, last
}

type dnsDomainResult struct {
	Host    string   `json:"host"`
	IPs     []string `json:"ips,omitempty"`
	OK      bool     `json:"ok"`
	Skipped bool     `json:"skipped,omitempty"`
	Error   string   `json:"error,omitempty"`
	Detail  string   `json:"detail"`
}

type portCheck struct {
	Port   int    `json:"port"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

type dnsReport struct {
	NodeIP  string            `json:"node_ip"`
	OK      bool              `json:"ok"`
	Summary string            `json:"summary"`
	Domains []dnsDomainResult `json:"domains"`
	Ports   []portCheck       `json:"ports,omitempty"`
	PortsOK *bool             `json:"ports_ok,omitempty"`
}

// dialTCP is swapped in tests. Master probes the node public IP from outside.
var dialTCP = func(ctx context.Context, network, address string) (net.Conn, error) {
	d := net.Dialer{Timeout: 4 * time.Second}
	return d.DialContext(ctx, network, address)
}

func probeTCPPort(host string, port int) portCheck {
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	c, e := dialTCP(ctx, "tcp", addr)
	if e != nil {
		return portCheck{Port: port, OK: false, Detail: fmt.Sprintf(":%d 主控连不上", port)}
	}
	_ = c.Close()
	return portCheck{Port: port, OK: true, Detail: fmt.Sprintf(":%d 可达", port)}
}

type httpsReachReport struct {
	OK      bool
	Summary string
	Ports   []portCheck
}

func needsPublicHTTPSport(s Site) bool {
	if s.CertMode() != "auto" {
		return false
	}
	for _, h := range s.Domains {
		l, e := node.ParseListen(h)
		if e != nil {
			continue
		}
		// Bare domain (or domain without custom port) needs HTTP-01/TLS-ALPN on 80/443.
		if !l.IsIP() && !l.IsWildcard() && l.Port == 0 {
			return true
		}
	}
	return false
}

func buildHTTPSReachReport(nodeHost string) httpsReachReport {
	out := httpsReachReport{OK: true}
	if net.ParseIP(nodeHost) == nil {
		out.Summary = "节点主机不是 IP，跳过外网端口检查"
		return out
	}
	var bad []string
	for _, port := range []int{80, 443} {
		item := probeTCPPort(nodeHost, port)
		out.Ports = append(out.Ports, item)
		if !item.OK {
			out.OK = false
			bad = append(bad, item.Detail)
		}
	}
	if out.OK {
		out.Summary = "外网 :80/:443 主控可达（节点 " + nodeHost + "）"
		return out
	}
	out.Summary = "外网 80/443 主控不可达（节点 " + nodeHost + "）：" + strings.Join(bad, "；") + "。自动 HTTPS/ACME 会失败"
	return out
}

func attachHTTPSReach(rep *dnsReport, s Site, nodeHost string) {
	if !needsPublicHTTPSport(s) {
		return
	}
	reach := buildHTTPSReachReport(nodeHost)
	rep.Ports = reach.Ports
	ok := reach.OK
	rep.PortsOK = &ok
}

func httpsReachMismatch(s Site, nodeHost string) string {
	if !needsPublicHTTPSport(s) {
		return ""
	}
	reach := buildHTTPSReachReport(nodeHost)
	if reach.OK {
		return ""
	}
	return reach.Summary
}

func buildDNSReport(s Site, nodeHost string) dnsReport {
	rep := dnsReport{NodeIP: nodeHost, OK: true}
	ip := net.ParseIP(nodeHost)
	if ip == nil {
		rep.Summary = "节点主机不是 IP，跳过公网 DNS 对照"
		return rep
	}
	var bad []string
	for _, h := range s.Domains {
		item := dnsDomainResult{Host: h}
		l, e := node.ParseListen(h)
		// HTTP and HTTPS both benefit from DNS checks. Only skip literal IPs / wildcards.
		// domain:port still checks the domain host against the node IP.
		if e != nil || l.IsIP() || l.IsWildcard() || !strings.Contains(l.Host, ".") {
			item.Skipped = true
			item.OK = true
			item.Detail = "IP / 通配符，跳过公网 DNS"
			rep.Domains = append(rep.Domains, item)
			continue
		}
		h = l.Host
		ips, e := lookupSiteIPs(h)
		if e != nil {
			item.OK = false
			item.Error = e.Error()
			item.Detail = h + " 解析失败"
			bad = append(bad, item.Detail)
			rep.Domains = append(rep.Domains, item)
			continue
		}
		seen := make([]string, 0, len(ips))
		matched := false
		for _, got := range ips {
			seen = append(seen, got.String())
			matched = matched || got.Equal(ip)
		}
		item.IPs = seen
		item.OK = matched
		if matched {
			item.Detail = fmt.Sprintf("%s → %s（指向节点）", h, strings.Join(seen, ", "))
		} else {
			item.Detail = fmt.Sprintf("%s → %s（未指向节点 %s）", h, strings.Join(seen, ", "), nodeHost)
			bad = append(bad, item.Detail)
		}
		rep.Domains = append(rep.Domains, item)
	}
	if len(bad) == 0 {
		rep.Summary = "DNS 对照通过（节点 " + nodeHost + "）"
		return rep
	}
	rep.OK = false
	var names []string
	for _, d := range rep.Domains {
		if !d.OK && !d.Skipped {
			names = append(names, d.Host)
		}
	}
	if len(names) > 0 {
		rep.Summary = fmt.Sprintf("这些域名未对准节点 %s：%s", nodeHost, strings.Join(names, ", "))
	} else {
		rep.Summary = "域名解析检查未通过：" + strings.Join(bad, "；")
	}
	return rep
}

func dnsMismatch(s Site, nodeHost string) string {
	// Only auto HTTPS needs public DNS before deploy. HTTP-only / custom can proceed.
	if s.CertMode() != "auto" {
		return ""
	}
	rep := buildDNSReport(s, nodeHost)
	if rep.OK {
		return ""
	}
	return rep.Summary
}

func (a *App) bindSite(w http.ResponseWriter, r *http.Request) {
	s, e := a.Store.GetSite(r.PathValue("id"))
	if e != nil {
		fail(w, 404, "站点不存在")
		return
	}
	var body struct {
		NodeID string `json:"node_id"`
	}
	if e = decode(w, r, &body); e != nil {
		fail(w, 400, e.Error())
		return
	}
	if busy, e := a.Store.SiteHasActiveTask(s.ID); e != nil {
		fail(w, 500, "检查任务失败")
		return
	} else if busy {
		fail(w, 409, "站点有进行中的任务，稍后再换绑")
		return
	}
	if body.NodeID != "" {
		if _, _, e = a.Store.GetNode(body.NodeID); e != nil {
			fail(w, 400, "目标节点不存在")
			return
		}
	}
	if e = a.Store.BindSite(s.ID, body.NodeID); e != nil {
		fail(w, 500, e.Error())
		return
	}
	s.NodeID = body.NodeID
	reply(w, 200, s)
}

func (a *App) setSiteEnabled(id string, enabled bool) (Site, error) {
	s, e := a.Store.GetSite(id)
	if e != nil {
		return s, e
	}
	s.Enabled = enabled
	if e = a.Store.UpdateSite(s); e != nil {
		return s, e
	}
	return s, nil
}

func (a *App) disableSite(w http.ResponseWriter, r *http.Request) {
	s, e := a.Store.GetSite(r.PathValue("id"))
	if e != nil {
		fail(w, 404, "站点不存在")
		return
	}
	if busy, e := a.Store.SiteHasActiveTask(s.ID); e != nil {
		fail(w, 500, "检查任务失败")
		return
	} else if busy {
		fail(w, 409, "站点有进行中的任务，稍后再停用")
		return
	}
	if !s.Enabled {
		reply(w, 200, map[string]any{"site": s})
		return
	}
	if s.NodeID == "" {
		s, e = a.setSiteEnabled(s.ID, false)
		if e != nil {
			fail(w, 500, "保存停用状态失败")
			return
		}
		reply(w, 200, map[string]any{"site": s})
		return
	}
	target, e := a.target(s.NodeID)
	if e != nil {
		fail(w, 400, "站点未关联有效节点")
		return
	}
	s, e = a.setSiteEnabled(s.ID, false)
	if e != nil {
		fail(w, 500, "保存停用状态失败")
		return
	}
	id := ID()
	if e = a.Store.NewTask(Task{ID: id, Kind: "disable", NodeID: s.NodeID, SiteID: s.ID, Status: "queued", Step: "prepare"}); e != nil {
		fail(w, 500, "创建停用任务失败")
		return
	}
	req := node.Request{ID: id, Operation: "disable", Site: s.Site}
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		unlock := a.Remote.Lock(s.NodeID)
		defer unlock()
		_ = a.Store.SetTask(id, "running", "prepare", "")
		ctx, cancel := context.WithTimeout(a.ctx, 10*time.Minute)
		defer cancel()
		if e := a.sendSimpleOp(ctx, target, req); e != nil {
			_ = a.Store.SetTask(id, "failed", "submit", e.Error())
			return
		}
		_ = a.Store.SetTask(id, "running", "remote_execution", "")
	}()
	reply(w, 202, map[string]any{"task_id": id, "site": s})
}

func (a *App) enableSite(w http.ResponseWriter, r *http.Request) {
	s, e := a.Store.GetSite(r.PathValue("id"))
	if e != nil {
		fail(w, 404, "站点不存在")
		return
	}
	if busy, e := a.Store.SiteHasActiveTask(s.ID); e != nil {
		fail(w, 500, "检查任务失败")
		return
	} else if busy {
		fail(w, 409, "站点有进行中的任务，稍后再启用")
		return
	}
	if s.Enabled {
		reply(w, 200, map[string]any{"site": s})
		return
	}
	if s.NodeID == "" {
		s, e = a.setSiteEnabled(s.ID, true)
		if e != nil {
			fail(w, 500, "保存启用状态失败")
			return
		}
		reply(w, 200, map[string]any{"site": s})
		return
	}
	target, e := a.target(s.NodeID)
	if e != nil {
		fail(w, 400, "站点未关联有效节点")
		return
	}
	s, e = a.setSiteEnabled(s.ID, true)
	if e != nil {
		fail(w, 500, "保存启用状态失败")
		return
	}
	id := ID()
	if e = a.Store.NewTask(Task{ID: id, Kind: "enable", NodeID: s.NodeID, SiteID: s.ID, Status: "queued", Step: "prepare"}); e != nil {
		fail(w, 500, "创建启用任务失败")
		return
	}
	req := node.Request{ID: id, Operation: "enable", Site: s.Site}
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		unlock := a.Remote.Lock(s.NodeID)
		defer unlock()
		_ = a.Store.SetTask(id, "running", "prepare", "")
		ctx, cancel := context.WithTimeout(a.ctx, 10*time.Minute)
		defer cancel()
		if e := a.sendSimpleOp(ctx, target, req); e != nil {
			_ = a.Store.SetTask(id, "failed", "submit", e.Error())
			return
		}
		_ = a.Store.SetTask(id, "running", "remote_execution", "")
	}()
	reply(w, 202, map[string]any{"task_id": id, "site": s})
}

func (a *App) deleteSite(w http.ResponseWriter, r *http.Request) {
	s, e := a.Store.GetSite(r.PathValue("id"))
	if e != nil {
		fail(w, 404, "站点不存在")
		return
	}
	var body struct {
		PurgeMaster bool `json:"purge_master"`
		ForceRemote bool `json:"force_remote"`
	}
	if r.ContentLength != 0 {
		if e = decode(w, r, &body); e != nil {
			fail(w, 400, e.Error())
			return
		}
	}
	if busy, e := a.Store.SiteHasActiveTask(s.ID); e != nil {
		fail(w, 500, "检查任务失败")
		return
	} else if busy {
		fail(w, 409, "站点有进行中的任务，稍后再删除")
		return
	}
	var taskID string
	if s.NodeID != "" && s.Enabled {
		target, e := a.target(s.NodeID)
		if e != nil && !body.ForceRemote {
			fail(w, 400, "节点不可用：可先停用/解绑，或 force_remote 仅删主控记录")
			return
		}
		if e == nil {
			if _, e = a.setSiteEnabled(s.ID, false); e != nil {
				fail(w, 500, "保存停用状态失败")
				return
			}
			taskID = ID()
			if e = a.Store.NewTask(Task{ID: taskID, Kind: "disable", NodeID: s.NodeID, SiteID: s.ID, Status: "queued", Step: "prepare"}); e != nil {
				fail(w, 500, "创建远端停用任务失败")
				return
			}
			req := node.Request{ID: taskID, Operation: "disable", Site: s.Site}
			a.wg.Add(1)
			go func() {
				defer a.wg.Done()
				unlock := a.Remote.Lock(s.NodeID)
				defer unlock()
				_ = a.Store.SetTask(taskID, "running", "prepare", "")
				ctx, cancel := context.WithTimeout(a.ctx, 10*time.Minute)
				defer cancel()
				if e := a.sendSimpleOp(ctx, target, req); e != nil {
					_ = a.Store.SetTask(taskID, "failed", "submit", e.Error())
					return
				}
				_ = a.Store.SetTask(taskID, "running", "remote_execution", "")
			}()
		}
	}
	if e = a.Store.DeleteSite(s.ID); e != nil {
		fail(w, 500, e.Error())
		return
	}
	_ = a.clearCustomNginx(s.ID)
	a.clearDeploySnapshot(s.ID)
	if body.PurgeMaster {
		_ = os.RemoveAll(filepath.Join(a.Store.Dir, "sites", s.ID))
	}
	reply(w, 200, map[string]any{"ok": true, "task_id": taskID, "purged_master": body.PurgeMaster})
}

func (a *App) sendSimpleOp(ctx context.Context, target remote.Target, req node.Request) error {
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
	if json.Unmarshal(status, &v) != nil || !agentVersionOK(v.Version) {
		return fmt.Errorf("节点执行器版本过旧（%s），请先安装/更新节点到 %s+", v.Version, minAgentVersion)
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

func (a *App) copySite(w http.ResponseWriter, r *http.Request) {
	src, e := a.Store.GetSite(r.PathValue("id"))
	if e != nil {
		fail(w, 404, "站点不存在")
		return
	}
	var body struct {
		NodeID string `json:"node_id"`
		Name   string `json:"name"`
	}
	if e = decode(w, r, &body); e != nil {
		fail(w, 400, e.Error())
		return
	}
	if body.NodeID == "" {
		fail(w, 400, "请选择目标节点")
		return
	}
	if _, _, e = a.Store.GetNode(body.NodeID); e != nil {
		fail(w, 400, "目标节点不存在")
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = src.Name + " 副本"
	}
	dst := Site{
		Site: node.Site{
			ID:      ID(),
			Name:    name,
			Domains: append([]string{}, src.Domains...),
			Port:    src.Port,
		},
		NodeID:  body.NodeID,
		Enabled: true,
		Vars:    map[string]string{},
	}
	for k, v := range src.Vars {
		dst.Vars[k] = v
	}
	if e = dst.Site.Validate(); e != nil {
		fail(w, 400, e.Error())
		return
	}
	existing, e := a.Store.Sites()
	if e != nil {
		fail(w, 500, "读取站点失败")
		return
	}
	for _, s := range existing {
		if s.NodeID == dst.NodeID && s.Port == dst.Port {
			for _, h := range s.Domains {
				for _, h2 := range dst.Domains {
					if strings.EqualFold(h, h2) {
						fail(w, 409, "目标节点/端口已有相同域名，请先改域名再复制")
						return
					}
				}
			}
		}
	}
	srcRoot := filepath.Join(a.Store.Dir, "sites", src.ID)
	dstRoot := filepath.Join(a.Store.Dir, "sites", dst.ID)
	if e = copyDir(srcRoot, dstRoot); e != nil {
		fail(w, 500, "复制站点文件失败")
		return
	}
	if text, ok, e := a.loadCustomNginx(src.ID); e != nil {
		_ = os.RemoveAll(dstRoot)
		fail(w, 500, "读取 Nginx 配置失败")
		return
	} else if ok {
		if e = a.saveCustomNginx(dst.ID, text); e != nil {
			_ = os.RemoveAll(dstRoot)
			fail(w, 500, "复制 Nginx 配置失败")
			return
		}
	}
	if e = a.Store.SaveSite(dst); e != nil {
		_ = os.RemoveAll(dstRoot)
		_ = a.clearCustomNginx(dst.ID)
		fail(w, 500, "保存站点失败")
		return
	}
	reply(w, 201, dst)
}

func copyDir(src, dst string) error {
	if e := os.MkdirAll(dst, 0700); e != nil {
		return e
	}
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0700)
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return errors.New("不支持链接或特殊文件")
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		_, err = io.Copy(out, in)
		ce := out.Close()
		return errors.Join(err, ce)
	})
}
