package node

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const (
	caddySitesDir    = "/etc/caddy/sites"
	caddyMainFile    = "/etc/caddy/Caddyfile"
	caddyOwnedMark   = "site-panel-caddy-v1"
	// ACME contact + LE then ZeroSSL fallback. ZeroSSL API key comes from
	// /etc/caddy/zerossl.env (ZEROSSL_API_KEY) via systemd EnvironmentFile.
	// Same HTTP-01 path; closed public :80 still cannot issue.
	defaultCaddyfile = `{
	admin 127.0.0.1:2019
	email ssl@xfnss.top
	storage file_system {
		root /var/lib/caddy/.local/share/caddy
	}
	cert_issuer acme
	cert_issuer zerossl {env.ZEROSSL_API_KEY}
}
import /etc/caddy/sites/*.caddy
`
)

func siteCaddyPath(id string) string {
	return filepath.Join(caddySitesDir, "site-panel-"+id+".caddy")
}

func (s Site) mode() string {
	m := strings.ToLower(strings.TrimSpace(s.Mode))
	if m == "proxy" {
		return "proxy"
	}
	return "static"
}

func (s Site) CertMode() string {
	c := strings.ToLower(strings.TrimSpace(s.Cert))
	switch c {
	case "auto", "custom", "off":
		return c
	default:
		// Default: if any real domain exists, prefer auto HTTPS.
		// IP / IP:port rows do NOT force the whole site to HTTP-only.
		listens, e := ParseListens(s.Domains)
		if e != nil || len(listens) == 0 {
			return "auto"
		}
		hasDomain := false
		for _, l := range listens {
			if !l.IsIP() && l.Port == 0 {
				hasDomain = true
				break
			}
		}
		if hasDomain {
			return "auto"
		}
		return "off"
	}
}

// WantHTTPRedirect is on by default for auto/custom HTTPS domains.
func (s Site) WantHTTPRedirect() bool {
	switch s.CertMode() {
	case "auto", "custom":
	default:
		return false
	}
	if s.RedirHTTPS == nil {
		return true
	}
	return *s.RedirHTTPS
}

// splitListenAddrs separates domain HTTPS addresses from always-HTTP IP/port rows.
// One site can have both: domains get certificates; ip:port stays plain HTTP.
func (s Site) splitListenAddrs() (httpsAddrs, httpAddrs []string, err error) {
	listens, e := ParseListens(s.Domains)
	if e != nil {
		return nil, nil, e
	}
	cert := s.CertMode()
	redir := s.WantHTTPRedirect()
	applyPort := 0
	hasExplicit := false
	for _, l := range listens {
		if l.Port > 0 {
			hasExplicit = true
			break
		}
	}
	if !hasExplicit && cert == "off" && s.Port > 0 && s.Port != 80 && s.Port != 443 {
		applyPort = s.Port
	}
	for _, l := range listens {
		if applyPort > 0 && l.Port == 0 {
			l.Port = applyPort
		}
		// IP or explicit non-default port: always keep as HTTP sidecar.
		if l.IsIP() || l.Port > 0 {
			httpAddrs = append(httpAddrs, l.CaddyAddr("off"))
			continue
		}
		if cert == "off" {
			httpAddrs = append(httpAddrs, l.CaddyAddr("off"))
			continue
		}
		if redir {
			// Bare host: Caddy serves HTTPS and redirects :80 → HTTPS.
			httpsAddrs = append(httpsAddrs, l.Host)
		} else {
			// Explicit both: no automatic redirect between them.
			httpsAddrs = append(httpsAddrs, "http://"+l.Host, l.Host)
		}
	}
	return httpsAddrs, httpAddrs, nil
}

func (s Site) siteAddress() string {
	httpsAddrs, httpAddrs, e := s.splitListenAddrs()
	if e != nil {
		return strings.Join(s.Domains, ", ")
	}
	parts := append(append([]string{}, httpsAddrs...), httpAddrs...)
	return strings.Join(parts, ", ")
}

func staticHandlerBody(root, pad string) string {
	var b strings.Builder
	b.WriteString(pad + "root * " + root + "\n")
	b.WriteString(pad + "encode gzip\n")
	b.WriteString(pad + "try_files {path} /index.html\n")
	b.WriteString(pad + "file_server\n")
	// Common hardening / cache defaults for Vue static sites.
	b.WriteString(pad + "header {\n")
	b.WriteString(pad + "\tX-Content-Type-Options nosniff\n")
	b.WriteString(pad + "\tReferrer-Policy no-referrer-when-downgrade\n")
	b.WriteString(pad + "\t-Server\n")
	b.WriteString(pad + "}\n")
	b.WriteString(pad + "@assets {\n")
	b.WriteString(pad + "\tpath *.css *.js *.mjs *.map *.png *.jpg *.jpeg *.gif *.svg *.ico *.webp *.woff *.woff2 *.ttf\n")
	b.WriteString(pad + "}\n")
	b.WriteString(pad + "header @assets Cache-Control `public, max-age=31536000, immutable`\n")
	b.WriteString(pad + "header /index.html Cache-Control `no-cache`\n")
	return b.String()
}

func (s Site) handlerBlock() (string, error) {
	var b strings.Builder
	root := fmt.Sprintf("%s/%s/current", Sites, s.ID)
	proxies := s.Normalized().Proxies
	if len(proxies) > 0 {
		for _, r := range proxies {
			path := r.Path
			match := path
			if path != "/" {
				match = path + "*"
			}
			b.WriteString("\thandle " + match + " {\n")
			b.WriteString("\t\treverse_proxy " + r.Upstream + "\n")
			b.WriteString("\t}\n")
		}
		b.WriteString("\thandle {\n")
		b.WriteString(staticHandlerBody(root, "\t\t"))
		b.WriteString("\t}\n")
	} else if s.mode() == "proxy" {
		ups := append([]string{}, s.Upstreams...)
		if len(ups) == 0 {
			return "", errors.New("反代模式需要至少一个上游，例如 127.0.0.1:3000")
		}
		for i, u := range ups {
			u = strings.TrimSpace(u)
			if u == "" {
				return "", errors.New("上游地址不能为空")
			}
			ups[i] = u
		}
		b.WriteString("\treverse_proxy " + strings.Join(ups, " ") + "\n")
	} else {
		b.WriteString(staticHandlerBody(root, "\t"))
	}
	if s.CertMode() == "custom" {
		cert := filepath.Join(Base, "certs", s.ID, "fullchain.pem")
		key := filepath.Join(Base, "certs", s.ID, "privkey.pem")
		b.WriteString("\ttls " + cert + " " + key + "\n")
	}
	return b.String(), nil
}

func ExtractHandlerBodies(text string) []string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	var bodies []string
	i := 0
	for i < len(text) {
		if text[i] != '{' {
			i++
			continue
		}
		depth := 0
		start := i + 1
		for j := i; j < len(text); j++ {
			switch text[j] {
			case '{':
				depth++
			case '}':
				depth--
				if depth == 0 {
					bodies = append(bodies, text[start:j])
					i = j + 1
					goto next
				}
			}
		}
		break
	next:
	}
	return bodies
}

// CaddyfileWithHandler renders address blocks using a preserved handler body.
func (s Site) CaddyfileWithHandler(body string) (string, error) {
	if e := s.Validate(); e != nil {
		return "", e
	}
	body = strings.ReplaceAll(body, "\r\n", "\n")
	if !strings.HasSuffix(body, "\n") && strings.TrimSpace(body) != "" {
		body += "\n"
	}
	httpsAddrs, httpAddrs, e := s.splitListenAddrs()
	if e != nil {
		return "", e
	}
	var out strings.Builder
	out.WriteString("# Managed by site-panel-caddy; generated from 配置页.\n")
	if len(httpsAddrs) > 0 && len(httpAddrs) > 0 {
		out.WriteString("# Domains: auto HTTPS")
		if s.WantHTTPRedirect() {
			out.WriteString(" + HTTP→HTTPS")
		}
		out.WriteString("; IP:port stays HTTP.\n")
	}
	writeSiteBlock(&out, httpsAddrs, body)
	writeSiteBlock(&out, httpAddrs, body)
	if out.Len() == 0 || !strings.Contains(out.String(), "{") {
		return "", errors.New("没有可监听的地址")
	}
	return out.String(), nil
}

// SyncCustomConfig keeps hand-edited handlers, rewrites site addresses from UI.
func SyncCustomConfig(old string, s Site) (string, error) {
	bodies := ExtractHandlerBodies(old)
	body := ""
	if len(bodies) > 0 {
		body = bodies[0]
	} else {
		var e error
		body, e = s.handlerBlock()
		if e != nil {
			return "", e
		}
	}
	return s.CaddyfileWithHandler(body)
}

func writeSiteBlock(out *strings.Builder, addrs []string, body string) {
	if len(addrs) == 0 {
		return
	}
	out.WriteString(strings.Join(addrs, ", "))
	out.WriteString(" {\n")
	out.WriteString(body)
	out.WriteString("}\n")
}

// CaddyfileSite renders site block(s). Domain HTTPS and IP:port HTTP can coexist.
func (s Site) CaddyfileSite() (string, error) {
	body, e := s.handlerBlock()
	if e != nil {
		return "", e
	}
	return s.CaddyfileWithHandler(body)
}

func ValidateCaddyConfig(text string) error {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	if strings.TrimSpace(text) == "" {
		return errors.New("配置不能为空")
	}
	if len(text) > 256<<10 {
		return errors.New("配置不能超过 256KB")
	}
	if strings.IndexByte(text, 0) >= 0 {
		return errors.New("配置不能包含空字节")
	}
	if !utf8.ValidString(text) {
		return errors.New("配置必须是 UTF-8")
	}
	if !strings.Contains(text, "{") || !strings.Contains(text, "}") {
		return errors.New("配置需要包含 Caddy 站点块")
	}
	return nil
}

func EnsureBaseCaddyfile() error {
	if e := os.MkdirAll(caddySitesDir, 0755); e != nil {
		return e
	}
	b, e := os.ReadFile(caddyMainFile)
	if e != nil && !os.IsNotExist(e) {
		return e
	}
	if e == nil &&
		strings.Contains(string(b), "/etc/caddy/sites/") &&
		strings.Contains(string(b), "storage file_system") &&
		strings.Contains(string(b), "cert_issuer zerossl {env.ZEROSSL_API_KEY}") {
		return nil
	}
	return atomicWrite(caddyMainFile, []byte(defaultCaddyfile), 0644)
}

func applyCaddySite(id string, next []byte, rollback []byte, hadRollback bool) error {
	path := siteCaddyPath(id)
	if e := EnsureBaseCaddyfile(); e != nil {
		return e
	}
	if e := atomicWrite(path, next, 0644); e != nil {
		return e
	}
	restore := func() {
		if hadRollback {
			_ = atomicWrite(path, rollback, 0644)
		} else {
			_ = os.Remove(path)
		}
	}
	if _, e := validateAndReloadCaddy(); e != nil {
		restore()
		_, _ = validateAndReloadCaddy()
		return e
	}
	return nil
}

func validateAndReloadCaddy() (string, error) {
	if e := EnsureBaseCaddyfile(); e != nil {
		return "", e
	}
	out, e := command("caddy", "validate", "--config", caddyMainFile)
	if e != nil {
		return out, e
	}
	if _, e = command("systemctl", "reload", "caddy"); e != nil {
		if _, e2 := command("caddy", "reload", "--config", caddyMainFile); e2 != nil {
			return out, errors.Join(e, e2)
		}
	}
	return out, nil
}

func caddyActive() string {
	out, _ := command("systemctl", "is-active", "caddy")
	return strings.TrimSpace(out)
}

func disabledCaddyStub(site Site) string {
	var b strings.Builder
	b.WriteString(disabledStubMarker)
	b.WriteString("# Managed by site-panel-caddy; site is stopped on purpose.\n")
	body := "\trespond \"site disabled\" 503\n"
	httpsAddrs, httpAddrs, e := site.splitListenAddrs()
	if e != nil || (len(httpsAddrs) == 0 && len(httpAddrs) == 0) {
		b.WriteString(site.siteAddress())
		b.WriteString(" {\n")
		b.WriteString(body)
		b.WriteString("}\n")
		return b.String()
	}
	writeSiteBlock(&b, httpsAddrs, body)
	writeSiteBlock(&b, httpAddrs, body)
	return b.String()
}
