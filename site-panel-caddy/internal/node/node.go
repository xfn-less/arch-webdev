// Package node implements a small, fixed-operation deployment executable.
// SSH submits work; systemd owns its lifetime. There is no network listener.
package node

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const Version = "0.3.1-caddy"
const Base = "/var/lib/site-panel"
const Sites = "/srv/site-panel/sites"

var idPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var hostPattern = regexp.MustCompile(`^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$`)

type ProxyRoute struct {
	Path     string `json:"path"`     // /api  /uploads
	Upstream string `json:"upstream"` // 127.0.0.1:8080
}

type Site struct {
	ID         string       `json:"id"`
	Name       string       `json:"name"`
	Domains    []string     `json:"domains"`
	Port       int          `json:"port"`
	Mode       string       `json:"mode,omitempty"`        // static|proxy (legacy whole-site)
	Upstreams  []string     `json:"upstreams,omitempty"`   // legacy whole-site proxy
	Proxies    []ProxyRoute `json:"proxies,omitempty"`     // path reverse_proxy rules
	Cert       string       `json:"cert,omitempty"`        // auto|off|custom
	RedirHTTPS *bool        `json:"redir_https,omitempty"` // domain HTTP→HTTPS; default true
}
type Request struct {
	Operation    string      `json:"operation,omitempty"`
	SSL          *SSLRequest `json:"ssl,omitempty"`
	ID           string      `json:"id"`
	Site         Site        `json:"site"`
	BundleSHA256 string      `json:"bundle_sha256"`
	NginxConfig  string      `json:"nginx_config,omitempty"` // legacy name; carries Caddyfile site text
	ConfigText   string      `json:"config,omitempty"`
}
type Result struct {
	ID        string `json:"id"`
	Status    string `json:"status"`
	Step      string `json:"step"`
	Error     string `json:"error,omitempty"`
	UpdatedAt string `json:"updated_at"`
}

func ValidID(id string) bool { return idPattern.MatchString(id) }
func (s Site) Validate() error {
	if !ValidID(s.ID) || strings.TrimSpace(s.Name) == "" {
		return errors.New("站点 ID 或名称无效")
	}
	if len(s.Domains) == 0 || len(s.Domains) > 30 {
		return errors.New("需要 1～30 个地址（域名 / IP / IP:端口）")
	}
	listens, e := ParseListens(s.Domains)
	if e != nil {
		return e
	}
	port := PrimaryPort(s.Domains, s.Port)
	if port < 1 || port > 65535 || port == 22 {
		return errors.New("监听端口无效或占用了 SSH 端口")
	}
	for _, r := range s.Proxies {
		p := strings.TrimSpace(r.Path)
		u := strings.TrimSpace(r.Upstream)
		if p == "" && u == "" {
			continue
		}
		if !strings.HasPrefix(p, "/") || strings.Contains(p, " ") || strings.Contains(p, "{") {
			return errors.New("反代路径无效，例如 /api")
		}
		if u == "" {
			return errors.New("反代上游不能为空，例如 127.0.0.1:8080")
		}
	}
	switch s.mode() {
	case "proxy":
		if len(s.Proxies) == 0 && len(s.Upstreams) == 0 {
			return errors.New("反代需要路径规则或上游")
		}
		for _, u := range s.Upstreams {
			if strings.TrimSpace(u) == "" {
				return errors.New("上游地址不能为空")
			}
		}
	case "static":
	default:
		return errors.New("站点模式仅支持 static / proxy")
	}
	_ = listens
	return nil
}
func (s Site) Config() (string, error) {
	return s.CaddyfileSite()
}

// ValidateNginxConfig kept as alias while call sites move to Caddy validation.
func ValidateNginxConfig(text string) error { return ValidateCaddyConfig(text) }
func TaskDir(id string) (string, error) {
	if !ValidID(id) {
		return "", errors.New("invalid task id")
	}
	return filepath.Join(Base, "tasks", id), nil
}
func AtomicJSON(path string, v any) error {
	b, e := json.MarshalIndent(v, "", "  ")
	if e != nil {
		return e
	}
	return atomicWrite(path, b, 0600)
}
func atomicWrite(path string, b []byte, mode os.FileMode) error {
	f, e := os.CreateTemp(filepath.Dir(path), ".pending-")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if e = f.Chmod(mode); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	if e = os.Rename(f.Name(), path); e != nil {
		return e
	}
	d, e := os.Open(filepath.Dir(path))
	if e != nil {
		return e
	}
	defer d.Close()
	return d.Sync()
}
func readRequest(id string) (Request, string, error) {
	d, e := TaskDir(id)
	if e != nil {
		return Request{}, "", e
	}
	b, e := os.ReadFile(filepath.Join(d, "request.json"))
	if e != nil {
		return Request{}, d, e
	}
	var r Request
	e = json.Unmarshal(b, &r)
	if e != nil {
		return r, d, e
	}
	if r.ID != id {
		return r, d, errors.New("task ID mismatch")
	}
	if e = r.Site.Validate(); e != nil {
		return r, d, e
	}
	if r.Operation == "ssl" {
		if r.SSL == nil {
			return r, d, errors.New("missing SSL request")
		}
		return r, d, r.SSL.Validate()
	}
	if r.Operation == "disable" || r.Operation == "enable" {
		return r, d, nil
	}
	if r.Operation != "" && r.Operation != "deploy" {
		return r, d, errors.New("unsupported operation")
	}
	if len(r.BundleSHA256) != 64 {
		return r, d, errors.New("invalid checksum")
	}
	return r, d, nil
}
func command(name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	b, e := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if len(b) > 8192 {
		b = b[len(b)-8192:]
	}
	if e != nil {
		return string(b), fmt.Errorf("%s: %w: %s", name, e, b)
	}
	return string(b), nil
}
func Submit(id string) error {
	_, d, e := readRequest(id)
	if e != nil {
		return e
	}
	lock, e := os.OpenFile(filepath.Join(d, "submit.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return e
	}
	defer lock.Close()
	if e = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); e != nil {
		return e
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	if _, e = os.Stat(filepath.Join(d, "result.json")); e == nil {
		return nil
	} else if !os.IsNotExist(e) {
		return e
	}
	unit := "site-panel-task@" + id + ".service"
	// Starting the same systemd unit twice cannot create two processes.
	if _, e = command("systemctl", "start", "--no-block", unit); e != nil {
		return e
	}
	return nil
}
func Status(id string) (Result, error) {
	d, e := TaskDir(id)
	if e != nil {
		return Result{}, e
	}
	b, e := os.ReadFile(filepath.Join(d, "result.json"))
	var r Result
	if e == nil {
		e = json.Unmarshal(b, &r)
	} else if os.IsNotExist(e) {
		r = Result{ID: id, Status: "queued", Step: "awaiting_executor"}
		e = nil
	}
	if e != nil {
		return r, e
	}
	if r.Status == "running" || r.Status == "queued" {
		out, _ := command("systemctl", "show", "site-panel-task@"+id+".service", "--property=ActiveState", "--value")
		state := strings.TrimSpace(out)
		if state != "active" && state != "activating" && state != "reloading" {
			r.Status = "needs_attention"
			r.Error = "执行进程未运行，需要核实结果；不会自动重复部署"
		}
	}
	return r, nil
}
func SystemStatus() map[string]any {
	return map[string]any{"version": Version, "caddy": caddyActive(), "observed_at": time.Now().UTC().Format(time.RFC3339)}
}
func Run(id string) (runErr error) {
	r, d, e := readRequest(id)
	if e != nil {
		return e
	}
	// A single node-wide lock serializes all configuration and file switches.
	lock, e := os.OpenFile(filepath.Join(Base, "operation.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return e
	}
	defer lock.Close()
	if e = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); e != nil {
		return e
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	if b, e := os.ReadFile(filepath.Join(d, "result.json")); e == nil {
		var prev Result
		if json.Unmarshal(b, &prev) != nil {
			return errors.New("invalid previous result")
		}
		if prev.Status == "succeeded" || prev.Status == "failed" {
			return nil
		}
		return errors.New("unfinished task requires manual inspection; refusing to repeat")
	}
	result := Result{ID: id, Status: "running", Step: "verify_bundle"}
	save := func() error {
		result.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		return AtomicJSON(filepath.Join(d, "result.json"), result)
	}
	if e = save(); e != nil {
		return e
	}
	defer func() {
		if runErr != nil {
			result.Status = "failed"
			result.Error = runErr.Error()
		} else {
			result.Status = "succeeded"
			if r.Operation == "ssl" {
				result.Step = "ssl_done"
				if r.SSL.Staging {
					result.Step = "ssl_staging_done"
				}
			} else {
				result.Step = "done"
			}
		}
		if e := save(); e != nil {
			runErr = errors.Join(runErr, e)
		}
	}()
	step := func(s string) error {
		result.Step = s
		fmt.Fprintf(os.Stderr, "[%s] %s\n", time.Now().UTC().Format(time.RFC3339), s)
		return save()
	}
	if r.Operation == "ssl" {
		return issueCertificate(r, step)
	}
	if r.Operation == "disable" {
		return DisableSite(r, step)
	}
	if r.Operation == "enable" {
		return EnableSite(r, step)
	}
	b, e := os.Open(filepath.Join(d, "bundle.tar"))
	if e != nil {
		return e
	}
	defer b.Close()
	hash := sha256.New()
	if _, e = io.Copy(hash, b); e != nil {
		return e
	}
	if hex.EncodeToString(hash.Sum(nil)) != r.BundleSHA256 {
		return errors.New("bundle checksum mismatch")
	}
	if _, e = b.Seek(0, 0); e != nil {
		return e
	}
	siteRoot := filepath.Join(Sites, r.Site.ID)
	if e = os.MkdirAll(siteRoot, 0755); e != nil {
		return e
	}
	prepared := filepath.Join(siteRoot, "deploy-"+id)
	if e = os.Mkdir(prepared, 0755); e != nil {
		return e
	}
	if e = step("prepare_files"); e != nil {
		return e
	}
	if e = Extract(b, prepared, 8<<30); e != nil {
		return e
	}
	if r.Site.mode() == "static" {
		indexInfo, e := os.Stat(filepath.Join(prepared, "index.html"))
		if e != nil || !indexInfo.Mode().IsRegular() {
			return errors.New("静态站要求根目录存在普通文件 index.html")
		}
	}
	conf := strings.TrimSpace(r.ConfigText)
	if conf == "" {
		conf = strings.TrimSpace(r.NginxConfig)
	}
	if conf == "" {
		var e error
		conf, e = r.Site.Config()
		if e != nil {
			return e
		}
	} else if e := ValidateCaddyConfig(conf); e != nil {
		return e
	}
	if e = EnsureBaseCaddyfile(); e != nil {
		return e
	}
	confPath := siteCaddyPath(r.Site.ID)
	oldConf, readErr := os.ReadFile(confPath)
	if readErr != nil && !os.IsNotExist(readErr) {
		return readErr
	}
	hadConf := readErr == nil
	// Stop-placeholder must not be restored on deploy failure, or the site gets stuck on 503.
	if hadConf && IsDisabledStub(oldConf) {
		hadConf = false
		oldConf = nil
	}
	current := filepath.Join(siteRoot, "current")
	oldTarget, e := os.Readlink(current)
	if e != nil && !os.IsNotExist(e) {
		return fmt.Errorf("current is not a managed link: %w", e)
	}
	if e = AtomicJSON(filepath.Join(d, "recovery.json"), map[string]any{"old_target": oldTarget, "had_config": hadConf, "config_path": confPath}); e != nil {
		return e
	}
	if hadConf {
		if e = atomicWrite(filepath.Join(d, "previous.conf"), oldConf, 0600); e != nil {
			return e
		}
	}
	if e = step("check_caddy"); e != nil {
		return e
	}
	if e = atomicWrite(confPath, []byte(conf), 0644); e != nil {
		return e
	}
	restoreConf := func() error {
		if hadConf {
			return atomicWrite(confPath, oldConf, 0644)
		}
		e := os.Remove(confPath)
		if os.IsNotExist(e) {
			return nil
		}
		return e
	}
	if _, checkErr := command("caddy", "validate", "--config", caddyMainFile); checkErr != nil {
		return errors.Join(checkErr, restoreConf())
	}
	if e = step("switch_files"); e != nil {
		return errors.Join(e, restoreConf())
	}
	tmp := filepath.Join(siteRoot, ".next-"+id)
	if e = os.Symlink(prepared, tmp); e != nil {
		return errors.Join(e, restoreConf())
	}
	defer os.Remove(tmp)
	if e = os.Rename(tmp, current); e != nil {
		return errors.Join(e, restoreConf())
	}
	rollback := func(cause error) error {
		re := restoreConf()
		if oldTarget != "" {
			p := filepath.Join(siteRoot, ".rollback-"+id)
			_ = os.Remove(p)
			le := os.Symlink(oldTarget, p)
			if le == nil {
				le = os.Rename(p, current)
			}
			re = errors.Join(re, le)
		} else {
			re = errors.Join(re, os.Remove(current))
		}
		_, le := validateAndReloadCaddy()
		re = errors.Join(re, le)
		if re != nil {
			return errors.Join(cause, fmt.Errorf("ROLLBACK FAILED: %w", re))
		}
		return cause
	}
	if e = step("reload_caddy"); e != nil {
		return rollback(e)
	}
	if _, e = validateAndReloadCaddy(); e != nil {
		return rollback(e)
	}
	_ = os.Remove(confPath + ".disabled")
	if r.Site.mode() == "proxy" {
		return nil
	}
	if e = step("check_http"); e != nil {
		return rollback(e)
	}
	checkHost := r.Site.Domains[0]
	checkPort := PrimaryPort(r.Site.Domains, r.Site.Port)
	if l, e := ParseListen(r.Site.Domains[0]); e == nil {
		checkHost = l.Host
		if l.Port > 0 {
			checkPort = l.Port
		}
	}
	if checkPort <= 0 {
		checkPort = 80
	}
	if r.Site.CertMode() != "off" && (checkPort == 0 || checkPort == 80 || checkPort == 443) {
		checkPort = 80
	}
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, _ := http.NewRequest("GET", "http://"+net.JoinHostPort("127.0.0.1", strconv.Itoa(checkPort))+"/", nil)
	req.Host = checkHost
	var last error
	for attempt := 0; attempt < 10; attempt++ {
		res, e := client.Do(req)
		if e != nil {
			last = e
		} else {
			code := res.StatusCode
			res.Body.Close()
			if code == 200 || code == 301 || code == 302 || code == 308 {
				last = nil
				break
			}
			last = fmt.Errorf("HTTP check returned %d", code)
		}
		time.Sleep(300 * time.Millisecond)
	}
	if last != nil {
		return rollback(last)
	}
	// Only the immediately preceding directory is retained. Never delete unknown paths.
	entries, _ := os.ReadDir(siteRoot)
	for _, entry := range entries {
		p := filepath.Join(siteRoot, entry.Name())
		if entry.IsDir() && strings.HasPrefix(entry.Name(), "deploy-") && p != prepared && p != oldTarget {
			_ = os.RemoveAll(p)
		}
	}
	return nil
}

// Extract rejects links, traversal, duplicates, special files and unbounded expansion.
func Extract(reader io.Reader, dest string, maxBytes int64) error {
	tr := tar.NewReader(reader)
	seen := map[string]bool{}
	var total int64
	for n := 0; ; n++ {
		h, e := tr.Next()
		if e == io.EOF {
			return nil
		}
		if e != nil {
			return e
		}
		if n >= 20000 {
			return errors.New("too many files")
		}
		name := h.Name
		clean := filepath.Clean(name)
		if name == "" || strings.Contains(name, "\\") || filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") || clean == "." {
			return errors.New("unsafe archive path")
		}
		if seen[clean] {
			return errors.New("duplicate archive entry")
		}
		seen[clean] = true
		p := filepath.Join(dest, clean)
		switch h.Typeflag {
		case tar.TypeDir:
			if e = os.MkdirAll(p, 0755); e != nil {
				return e
			}
		case tar.TypeReg:
			total += h.Size
			if h.Size < 0 || total > maxBytes {
				return errors.New("archive too large")
			}
			if e = os.MkdirAll(filepath.Dir(p), 0755); e != nil {
				return e
			}
			f, e := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
			if e != nil {
				return e
			}
			_, e = io.Copy(f, tr)
			if e == nil {
				e = f.Sync()
			}
			ce := f.Close()
			if e == nil {
				e = ce
			}
			if e != nil {
				return e
			}
		default:
			return errors.New("archive links and special files are not supported")
		}
	}
}
