package node

import (
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const disabledStubMarker = "# site-panel-disabled-stub\n"

func IsDisabledStub(b []byte) bool {
	return strings.HasPrefix(string(b), disabledStubMarker)
}

func siteNginxPath(id string) string {
	return filepath.Join("/etc/nginx/conf.d", "site-panel-"+id+".conf")
}

func disabledStubConfig(site Site, original []byte) string {
	names := stubServerNames(original, site.Domains)
	listens := stubHTTPListens(original, site.Port)
	sslListens, cert, key := stubTLS(original)
	var b strings.Builder
	b.WriteString(disabledStubMarker)
	b.WriteString("# Managed by site-panel; site is stopped on purpose.\n")
	b.WriteString("server {\n")
	for _, listen := range listens {
		b.WriteString("    " + listen + "\n")
	}
	for _, listen := range sslListens {
		b.WriteString("    " + listen + "\n")
	}
	b.WriteString("    server_name " + strings.Join(names, " ") + ";\n")
	if len(sslListens) > 0 {
		b.WriteString("    ssl_certificate " + cert + ";\n")
		b.WriteString("    ssl_certificate_key " + key + ";\n")
		b.WriteString("    ssl_protocols TLSv1.2 TLSv1.3;\n")
	}
	b.WriteString("    location / {\n")
	b.WriteString("        default_type text/plain;\n")
	b.WriteString("        return 503 \"site disabled\\n\";\n")
	b.WriteString("    }\n")
	b.WriteString("}\n")
	return b.String()
}

func stubTLS(original []byte) (listens []string, cert, key string) {
	seen := map[string]bool{}
	add := func(listen string) {
		listen = strings.TrimSpace(listen)
		if listen == "" || seen[listen] {
			return
		}
		seen[listen] = true
		listens = append(listens, listen)
	}
	for _, line := range strings.Split(string(original), "\n") {
		line = strings.TrimSpace(line)
		lower := strings.ToLower(line)
		switch {
		case strings.HasPrefix(line, "listen") && (strings.Contains(lower, " ssl") || strings.HasSuffix(lower, "ssl;")):
			if !strings.HasSuffix(line, ";") {
				line += ";"
			}
			add(line)
		case strings.HasPrefix(line, "ssl_certificate_key"):
			key = strings.TrimSuffix(strings.TrimSpace(strings.TrimPrefix(line, "ssl_certificate_key")), ";")
		case strings.HasPrefix(line, "ssl_certificate"):
			cert = strings.TrimSuffix(strings.TrimSpace(strings.TrimPrefix(line, "ssl_certificate")), ";")
		}
	}
	if cert == "" || key == "" || len(listens) == 0 {
		return nil, "", ""
	}
	return listens, cert, key
}

func stubServerNames(original []byte, fallback []string) []string {
	seen := map[string]bool{}
	var out []string
	add := func(name string) {
		name = strings.TrimSpace(name)
		if name == "" || name == "_" || seen[name] {
			return
		}
		seen[name] = true
		out = append(out, name)
	}
	for _, line := range strings.Split(string(original), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "server_name") {
			continue
		}
		line = strings.TrimSuffix(strings.TrimSpace(strings.TrimPrefix(line, "server_name")), ";")
		for _, name := range strings.Fields(line) {
			add(name)
		}
	}
	if len(out) == 0 {
		for _, name := range fallback {
			add(name)
		}
	}
	if len(out) == 0 {
		out = []string{"_"}
	}
	return out
}

func stubHTTPListens(original []byte, port int) []string {
	seen := map[string]bool{}
	var out []string
	add := func(listen string) {
		listen = strings.TrimSpace(listen)
		if listen == "" || seen[listen] {
			return
		}
		seen[listen] = true
		out = append(out, listen)
	}
	for _, line := range strings.Split(string(original), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "listen") {
			continue
		}
		lower := strings.ToLower(line)
		if strings.Contains(lower, " ssl") || strings.HasSuffix(lower, "ssl;") || strings.Contains(lower, " quic") {
			continue // keep TLS off the stub; missing certs would break nginx -t
		}
		if !strings.HasSuffix(line, ";") {
			line += ";"
		}
		add(line)
	}
	if len(out) == 0 {
		if port <= 0 {
			port = 80
		}
		add(fmt.Sprintf("listen %d;", port))
	}
	return out
}

func applyNginxConf(confPath string, next []byte, rollback []byte, hadRollback bool) error {
	if e := atomicWrite(confPath, next, 0644); e != nil {
		return e
	}
	restore := func() {
		if hadRollback {
			_ = atomicWrite(confPath, rollback, 0644)
		} else {
			_ = os.Remove(confPath)
		}
	}
	if _, e := command("nginx", "-t"); e != nil {
		restore()
		return e
	}
	if _, e := command("systemctl", "reload", "nginx"); e != nil {
		restore()
		_, _ = command("nginx", "-t")
		_, _ = command("systemctl", "reload", "nginx")
		return e
	}
	return nil
}

func DisableSite(r Request, step func(string) error) error {
	if e := step("disable_nginx"); e != nil {
		return e
	}
	confPath := siteNginxPath(r.Site.ID)
	disabled := confPath + ".disabled"
	cur, e := os.ReadFile(confPath)
	if e != nil && !os.IsNotExist(e) {
		return e
	}
	hadConf := e == nil
	if hadConf && strings.HasPrefix(string(cur), disabledStubMarker) {
		return step("disable_done")
	}
	var backup []byte
	if hadConf {
		backup = cur
		if e = atomicWrite(disabled, cur, 0644); e != nil {
			return e
		}
	} else if b, re := os.ReadFile(disabled); re == nil {
		backup = b
	} else if !os.IsNotExist(re) {
		return re
	}
	stub := []byte(disabledStubConfig(r.Site, backup))
	if e = applyNginxConf(confPath, stub, cur, hadConf); e != nil {
		return e
	}
	return step("disable_done")
}

func EnableSite(r Request, step func(string) error) error {
	if e := step("enable_nginx"); e != nil {
		return e
	}
	confPath := siteNginxPath(r.Site.ID)
	disabled := confPath + ".disabled"
	backup, e := os.ReadFile(disabled)
	if os.IsNotExist(e) {
		return errors.New("没有可恢复的停用备份，请重新部署该站")
	}
	if e != nil {
		return e
	}
	if strings.HasPrefix(string(backup), disabledStubMarker) {
		return errors.New("停用备份无效，请重新部署该站")
	}
	cur, re := os.ReadFile(confPath)
	hadConf := re == nil
	if re != nil && !os.IsNotExist(re) {
		return re
	}
	if e = applyNginxConf(confPath, backup, cur, hadConf); e != nil {
		return e
	}
	_ = os.Remove(disabled)
	return step("enable_done")
}

// issueCertificatePreserveNginx issues/renews certs for custom business nginx.
// Panel only rewrites <id>.panel.inc (ACME + certificate paths); business conf must include it.
func issueCertificatePreserveNginx(r Request, step func(string) error) (err error) {
	s := r.Site
	cfg := r.SSL
	if err = step("ssl_preserve_precheck"); err != nil {
		return err
	}
	confPath := filepath.Join("/etc/nginx/conf.d", "site-panel-"+s.ID+".conf")
	old, err := os.ReadFile(confPath)
	if err != nil {
		return errors.New("自定义 Nginx 模式下需要先部署配置，并 include panel.inc")
	}
	text := EnsurePanelInclude(string(old), s.ID)
	_, e := readBundle(acmeRoot, s.ID)
	hasCert := e == nil
	if e != nil && !os.IsNotExist(e) {
		return e
	}
	if err = WritePanelInc(s.ID, hasCert); err != nil {
		return err
	}
	appliedConf := false
	defer func() {
		if !appliedConf && text != string(old) {
			_ = atomicWrite(confPath, old, 0644)
			_, _ = command("nginx", "-t")
			_, _ = command("systemctl", "reload", "nginx")
		}
	}()
	if text != string(old) {
		if err = atomicWrite(confPath, []byte(text), 0644); err != nil {
			return err
		}
	}
	if _, err = command("nginx", "-t"); err != nil {
		return err
	}
	if _, err = command("systemctl", "reload", "nginx"); err != nil {
		return err
	}
	appliedConf = true
	token := "preflight-" + r.ID
	probePath := filepath.Join(ChallengeRoot, ".well-known/acme-challenge", token)
	if err = atomicWrite(probePath, []byte(r.ID), 0644); err != nil {
		return err
	}
	defer os.Remove(probePath)
	client := &http.Client{Timeout: 12 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for _, h := range cfg.Domains {
		var probeError error
		for attempt := 0; attempt < 5; attempt++ {
			res, e := client.Get("http://" + h + "/.well-known/acme-challenge/" + token)
			if e != nil {
				probeError = fmt.Errorf("80 端口验证失败 %s: %w（业务 conf 需 include %s）", h, e, PanelIncPath(s.ID))
				time.Sleep(300 * time.Millisecond)
				continue
			}
			b, e := io.ReadAll(io.LimitReader(res.Body, 1024))
			res.Body.Close()
			if e == nil && res.StatusCode == 200 && string(b) == r.ID {
				probeError = nil
				break
			}
			probeError = fmt.Errorf("%s 的 HTTP 验证路由不正确；确认已 include %s", h, PanelIncPath(s.ID))
			time.Sleep(300 * time.Millisecond)
		}
		if probeError != nil {
			return probeError
		}
	}
	root, server := acmeRoot, liveCA
	if cfg.Staging {
		root, server = stagingRoot, stagingCA
	}
	if err = os.MkdirAll(root, 0700); err != nil {
		return err
	}
	args := append([]string{"certonly", "--non-interactive", "--agree-tos", "--webroot", "-w", ChallengeRoot, "--cert-name", "site-" + s.ID, "--keep-until-expiring", "--renew-with-new-domains"}, certbotArgs(root, server)...)
	if cfg.Email != "" {
		args = append(args, "--email", cfg.Email)
	} else {
		args = append(args, "--register-unsafely-without-email")
	}
	for _, h := range cfg.Domains {
		args = append(args, "-d", h)
	}
	if err = step("ssl_request"); err != nil {
		return err
	}
	if _, err = sslCommand(5*time.Minute, "certbot", args...); err != nil {
		return err
	}
	if cfg.Staging {
		return step("ssl_staging_validated")
	}
	bundle, err := readBundle(acmeRoot, s.ID)
	if err != nil {
		return err
	}
	if err = verifyTrust(bundle, cfg.Domains); err != nil {
		return err
	}
	if err = WritePanelInc(s.ID, true); err != nil {
		return err
	}
	// Ensure an HTTPS server exists; certificate paths come from panel.inc.
	if !strings.Contains(strings.ToLower(text), "listen 443") {
		names := cfg.Domains
		text += fmt.Sprintf("\nserver {\n    listen 443 ssl;\n    server_name %s;\n    root %s/%s/current;\n    index index.html;\n%s    location / { try_files $uri $uri/ =404; }\n}\n", strings.Join(names, " "), Sites, s.ID, panelIncludeLine(s.ID))
		if err = atomicWrite(confPath, []byte(text), 0644); err != nil {
			return err
		}
	}
	if err = step("ssl_reload"); err != nil {
		return err
	}
	if _, err = command("nginx", "-t"); err != nil {
		return err
	}
	if _, err = command("systemctl", "reload", "nginx"); err != nil {
		return err
	}
	for _, h := range cfg.Domains {
		var last error
		for attempt := 0; attempt < 10; attempt++ {
			dialer := &net.Dialer{Timeout: 3 * time.Second}
			conn, e := tls.DialWithDialer(dialer, "tcp", "127.0.0.1:443", &tls.Config{ServerName: h, MinVersion: tls.VersionTLS12})
			last = e
			if e == nil {
				sum := sha256.Sum256(conn.ConnectionState().PeerCertificates[0].Raw)
				conn.Close()
				if hex.EncodeToString(sum[:]) == bundle.Info.Fingerprint {
					last = nil
					break
				}
				last = errors.New("Nginx 尚未加载本次证书")
			}
			time.Sleep(300 * time.Millisecond)
		}
		if last != nil {
			return last
		}
	}
	if err = installRenewal(); err != nil {
		return err
	}
	return step("ssl_done")
}

