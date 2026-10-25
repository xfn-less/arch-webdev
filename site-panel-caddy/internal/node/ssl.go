package node

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/mail"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

const ChallengeRoot = "/srv/site-panel/acme"
const acmeRoot = Base + "/acme"
const stagingRoot = Base + "/acme-staging"
const liveCA = "https://acme-v02.api.letsencrypt.org/directory"
const stagingCA = "https://acme-staging-v02.api.letsencrypt.org/directory"

var dnsLabel = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

type SSLRequest struct {
	Domains       []string `json:"domains"`
	Email         string   `json:"email,omitempty"`
	Staging       bool     `json:"staging"`
	Agree         bool     `json:"agree_terms"`
	NodeIP        string   `json:"node_ip,omitempty"`
	PreserveNginx bool     `json:"preserve_nginx,omitempty"`
}

func ValidDNSName(h string) bool {
	if len(h) > 253 || net.ParseIP(h) != nil || !strings.Contains(h, ".") {
		return false
	}
	for _, part := range strings.Split(h, ".") {
		if !dnsLabel.MatchString(part) {
			return false
		}
	}
	return true
}
func (s SSLRequest) Validate() error {
	if !s.Agree {
		return errors.New("申请前需要同意 Let's Encrypt 服务条款")
	}
	if len(s.Domains) == 0 || len(s.Domains) > 30 {
		return errors.New("需要 1～30 个具体域名")
	}
	seen := map[string]bool{}
	for _, h := range s.Domains {
		if !ValidDNSName(h) || seen[h] {
			return errors.New("仅支持不重复的具体域名，不支持 IP 或通配符证书；通配符需 DNS 验证")
		}
		seen[h] = true
	}
	if s.NodeIP != "" && net.ParseIP(s.NodeIP) == nil {
		return errors.New("invalid node IP")
	}
	if s.Email != "" {
		m, e := mail.ParseAddress(s.Email)
		if e != nil || m.Address != s.Email {
			return errors.New("邮箱无效")
		}
	}
	return nil
}

type CertificateInfo struct {
	Domains     []string  `json:"domains"`
	NotBefore   time.Time `json:"not_before"`
	NotAfter    time.Time `json:"not_after"`
	Fingerprint string    `json:"fingerprint"`
	Issuer      string    `json:"issuer"`
	Applied     bool      `json:"applied"`
	RenewTimer  bool      `json:"renew_timer"`
	ObservedAt  time.Time `json:"observed_at"`
}
type CertificateBundle struct {
	Info       CertificateInfo `json:"info"`
	Fullchain  string          `json:"fullchain"`
	PrivateKey string          `json:"private_key"`
}

func VerifyBundle(b CertificateBundle) (CertificateInfo, error) {
	pair, e := tls.X509KeyPair([]byte(b.Fullchain), []byte(b.PrivateKey))
	if e != nil {
		return CertificateInfo{}, errors.New("证书和私钥无法匹配")
	}
	cert, e := x509.ParseCertificate(pair.Certificate[0])
	if e != nil {
		return CertificateInfo{}, e
	}
	if len(cert.DNSNames) == 0 {
		return CertificateInfo{}, errors.New("证书未包含 DNS 域名")
	}
	for _, h := range cert.DNSNames {
		if !ValidDNSName(h) {
			return CertificateInfo{}, errors.New("只接受具体域名证书")
		}
	}
	sum := sha256.Sum256(cert.Raw)
	return CertificateInfo{Domains: cert.DNSNames, NotBefore: cert.NotBefore, NotAfter: cert.NotAfter, Fingerprint: hex.EncodeToString(sum[:]), Issuer: cert.Issuer.String(), ObservedAt: time.Now().UTC()}, nil
}
func certFiles(root, id string) (string, string) {
	return filepath.Join(root, "config/live/site-"+id, "fullchain.pem"), filepath.Join(root, "config/live/site-"+id, "privkey.pem")
}
func readBundle(root, id string) (CertificateBundle, error) {
	if !ValidID(id) {
		return CertificateBundle{}, errors.New("invalid site ID")
	}
	chain, key := certFiles(root, id)
	c, e := os.ReadFile(chain)
	if e != nil {
		return CertificateBundle{}, e
	}
	k, e := os.ReadFile(key)
	if e != nil {
		return CertificateBundle{}, e
	}
	b := CertificateBundle{Fullchain: string(c), PrivateKey: string(k)}
	b.Info, e = VerifyBundle(b)
	return b, e
}
func ExportCertificate(id string) (CertificateBundle, error) {
	b, e := readBundle(acmeRoot, id)
	if e != nil {
		return b, e
	}
	conf, e := os.ReadFile(filepath.Join("/etc/nginx/conf.d", "site-panel-"+id+".conf"))
	if e != nil {
		return b, e
	}
	certPath := filepath.Join(acmeRoot, "config/live/site-"+id, "fullchain.pem")
	inc, _ := os.ReadFile(PanelIncPath(id))
	b.Info.Applied = strings.Contains(string(inc), "ssl_certificate "+certPath) ||
		strings.Contains(string(conf), "ssl_certificate "+certPath)
	if b.Info.Applied {
		// Inspect the loopback peer certificate, even if expired, without sending
		// application data. This is not an HTTPS trust bypass for public requests.
		conn, err := tls.DialWithDialer(&net.Dialer{Timeout: 3 * time.Second}, "tcp", "127.0.0.1:443", &tls.Config{ServerName: b.Info.Domains[0], InsecureSkipVerify: true, MinVersion: tls.VersionTLS12})
		b.Info.Applied = false
		if err == nil {
			state := conn.ConnectionState()
			if len(state.PeerCertificates) > 0 {
				sum := sha256.Sum256(state.PeerCertificates[0].Raw)
				b.Info.Applied = hex.EncodeToString(sum[:]) == b.Info.Fingerprint
			}
			conn.Close()
		}
	}
	enabled, _ := command("systemctl", "is-enabled", "site-panel-cert-renew.timer")
	b.Info.RenewTimer = strings.TrimSpace(enabled) == "enabled"
	return b, nil
}
const panelIncMarker = "# site-panel-ssl-inc\n"
const panelIncDir = "/etc/nginx/site-panel"

func PanelIncPath(id string) string {
	return filepath.Join(panelIncDir, id+".panel.inc")
}

func panelIncludeLine(id string) string {
	_ = id
	return ""
}

func HasPanelInclude(conf, id string) bool {
	_, _ = conf, id
	return true
}

func WritePanelInc(id string, withCert bool) error {
	_, _ = id, withCert
	return nil
}

// EnsurePanelInclude is a no-op in the Caddy edition.
func EnsurePanelInclude(conf, id string) string {
	_ = id
	return conf
}

func coveredNames(s Site, b *CertificateBundle, bootstrap []string) ([]string, error) {
	names := bootstrap
	if b != nil {
		names = nil
		for _, h := range b.Info.Domains {
			for _, d := range s.Domains {
				if h == d {
					names = append(names, h)
					break
				}
			}
		}
		if len(names) == 0 {
			return nil, errors.New("现有证书不覆盖当前站点域名，请先重新申请证书")
		}
	}
	return names, nil
}

func configWithCert(s Site, b *CertificateBundle, bootstrap []string) (string, error) {
	plain, e := s.Config()
	if e != nil {
		return "", e
	}
	plain = EnsurePanelInclude(plain, s.ID)
	names, e := coveredNames(s, b, bootstrap)
	if e != nil {
		return "", e
	}
	validationNames := names
	if len(bootstrap) > 0 {
		validationNames = bootstrap
	}
	if len(validationNames) > 0 && s.Port != 80 {
		fallback := "return 404;"
		if b != nil {
			fallback = "return 301 https://$host$request_uri;"
		}
		plain += fmt.Sprintf("\nserver {\n    listen 80;\n    server_name %s;\n%s    location / { %s }\n}\n", strings.Join(validationNames, " "), panelIncludeLine(s.ID), fallback)
	}
	if b != nil {
		plain += fmt.Sprintf("\nserver {\n    listen 443 ssl;\n    server_name %s;\n    root %s/%s/current;\n    index index.html;\n%s    location / { try_files $uri $uri/ =404; }\n}\n", strings.Join(names, " "), Sites, s.ID, panelIncludeLine(s.ID))
	}
	return plain, nil
}
func PreviewConfig(s Site, info *CertificateInfo) (string, error) {
	_ = info
	return s.Config()
}
func RunningConfig(s Site) (string, error) {
	return s.Config()
}

type tailOutput struct{ b []byte }

func (t *tailOutput) Write(p []byte) (int, error) {
	n := len(p)
	t.b = append(t.b, p...)
	if len(t.b) > 65536 {
		t.b = append([]byte(nil), t.b[len(t.b)-65536:]...)
	}
	return n, nil
}
func sslCommand(timeout time.Duration, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out := &tailOutput{}
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdout = out
	cmd.Stderr = out
	cmd.Env = append(os.Environ(), "DEBIAN_FRONTEND=noninteractive")
	e := cmd.Run()
	text := strings.ToValidUTF8(string(out.b), "�")
	fmt.Fprintf(os.Stderr, "%s: %s\n", name, text)
	if e != nil {
		return text, fmt.Errorf("%s: %w: %s", name, e, text)
	}
	return text, nil
}
func managedAptList() (string, error) {
	for _, name := range []string{"/apt.list", "/debian.list"} {
		path := Base + name
		if _, e := os.Stat(path); e == nil {
			return path, nil
		}
	}
	return "", errors.New("节点缺少受管 apt 源，请先重新安装/更新节点")
}
func ensureCertbot() error {
	if _, e := exec.LookPath("certbot"); e == nil {
		return nil
	}
	src, e := managedAptList()
	if e != nil {
		return e
	}
	opts := []string{"-o", "Dir::Etc::sourcelist=" + src, "-o", "Dir::Etc::sourceparts=-", "-o", "Acquire::ForceIPv4=true", "-o", "Acquire::https::Timeout=20", "-o", "Acquire::Retries=1", "-o", "DPkg::Lock::Timeout=120"}
	if _, e := sslCommand(5*time.Minute, "apt-get", append(append([]string{}, opts...), "update")...); e != nil {
		return e
	}
	_, e = sslCommand(8*time.Minute, "apt-get", append(opts, "install", "-y", "certbot")...)
	if e == nil {
		_, _ = command("systemctl", "disable", "--now", "certbot.timer")
	} // fresh client: only our isolated config needs renewal
	return e
}
func certbotArgs(root, server string) []string {
	return []string{"--config-dir", root + "/config", "--work-dir", root + "/work", "--logs-dir", root + "/logs", "--server", server}
}
func installRenewal() error {
	service := "[Unit]\nDescription=Site Panel certificate renewal\nAfter=network-online.target\n[Service]\nType=oneshot\nExecStart=/usr/local/libexec/site-panel-node renew\nTimeoutStartSec=900\nUMask=0077\n"
	timer := "[Unit]\nDescription=Site Panel certificate renewal timer\n[Timer]\nOnCalendar=*-*-* 03,15:00:00\nRandomizedDelaySec=1800\nPersistent=true\n[Install]\nWantedBy=timers.target\n"
	if e := atomicWrite("/etc/systemd/system/site-panel-cert-renew.service", []byte(service), 0644); e != nil {
		return e
	}
	if e := atomicWrite("/etc/systemd/system/site-panel-cert-renew.timer", []byte(timer), 0644); e != nil {
		return e
	}
	if _, e := command("systemctl", "daemon-reload"); e != nil {
		return e
	}
	_, e := command("systemctl", "enable", "--now", "site-panel-cert-renew.timer")
	return e
}
func issueCertificate(r Request, step func(string) error) (err error) {
	s := r.Site
	cfg := r.SSL
	if cfg == nil {
		return errors.New("缺少 SSL 请求")
	}
	if err = cfg.Validate(); err != nil {
		return err
	}
	// Force auto HTTPS site addressing; Caddy obtains/renews certificates itself.
	s.Cert = "auto"
	if s.Port == 0 {
		s.Port = 80
	}
	if err = step("ssl_dns"); err != nil {
		return err
	}
	for _, h := range cfg.Domains {
		ips, e := net.LookupIP(h)
		if e != nil {
			return fmt.Errorf("域名解析失败 %s: %w", h, e)
		}
		if cfg.NodeIP != "" {
			matched := false
			for _, ip := range ips {
				matched = matched || ip.Equal(net.ParseIP(cfg.NodeIP))
			}
			if !matched {
				return fmt.Errorf("%s 未解析到节点 IP %s（自动 HTTPS 前必须对准，避免 CA 风控）", h, cfg.NodeIP)
			}
		}
	}
	if s.mode() == "static" {
		if _, err = os.Stat(filepath.Join(Sites, s.ID, "current/index.html")); err != nil {
			return errors.New("请先部署站点文件，再启用自动 HTTPS")
		}
	}
	if err = step("ssl_write_site"); err != nil {
		return err
	}
	conf, err := s.Config()
	if err != nil {
		return err
	}
	path := siteCaddyPath(s.ID)
	old, readErr := os.ReadFile(path)
	had := readErr == nil
	if readErr != nil && !os.IsNotExist(readErr) {
		return readErr
	}
	if err = applyCaddySite(s.ID, []byte(conf), old, had); err != nil {
		return err
	}
	if err = step("ssl_reload"); err != nil {
		return err
	}
	// Best-effort local HTTPS probe; issuance may finish shortly after reload.
	_ = step("ssl_probe")
	client := &http.Client{Timeout: 8 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true, ServerName: cfg.Domains[0]}}}
	req, _ := http.NewRequest("GET", "https://127.0.0.1/", nil)
	req.Host = cfg.Domains[0]
	if res, e := client.Do(req); e == nil {
		res.Body.Close()
	}
	return nil
}

func verifyTrust(b CertificateBundle, domains []string) error {
	var certs []*x509.Certificate
	rest := []byte(b.Fullchain)
	for {
		block, next := pem.Decode(rest)
		if block == nil {
			break
		}
		rest = next
		if block.Type == "CERTIFICATE" {
			c, e := x509.ParseCertificate(block.Bytes)
			if e != nil {
				return e
			}
			certs = append(certs, c)
		}
	}
	if len(certs) == 0 {
		return errors.New("no certificate")
	}
	pool := x509.NewCertPool()
	for _, c := range certs[1:] {
		pool.AddCert(c)
	}
	for _, h := range domains {
		if _, e := certs[0].Verify(x509.VerifyOptions{DNSName: h, Intermediates: pool}); e != nil {
			return e
		}
	}
	return nil
}
func RenewCertificates() error {
	// Caddy manages ACME renewals itself; keep command for compatibility.
	if caddyActive() != "active" {
		return errors.New("caddy 未运行")
	}
	return nil
}

func renewCertificatesLegacyCertbot() error {
	lock, e := os.OpenFile(Base+"/operation.lock", os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return e
	}
	defer lock.Close()
	if e = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); e != nil {
		return e
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	args := append([]string{"renew", "--non-interactive", "--no-random-sleep-on-renew"}, certbotArgs(acmeRoot, liveCA)...)
	if _, e = sslCommand(10*time.Minute, "certbot", args...); e != nil {
		return e
	}
	if _, e = command("nginx", "-t"); e != nil {
		return e
	}
	_, e = command("systemctl", "reload", "nginx")
	return e
}
