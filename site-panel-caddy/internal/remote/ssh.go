// Package remote is the only SSH/SFTP boundary. Commands are fixed; payloads are files.
package remote

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path"
	"strconv"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

type Target struct {
	Host                        string
	Port                        int
	User, Password, Fingerprint string
}
type Client struct {
	KeyFile string
	slots   chan struct{}
	mu      sync.Mutex
	locks   map[string]*sync.Mutex
}

func New(keyFile string) *Client {
	return &Client{KeyFile: keyFile, slots: make(chan struct{}, 4), locks: map[string]*sync.Mutex{}}
}
func (c *Client) Lock(id string) func() {
	c.mu.Lock()
	l := c.locks[id]
	if l == nil {
		l = &sync.Mutex{}
		c.locks[id] = l
	}
	c.mu.Unlock()
	l.Lock()
	return l.Unlock
}
func Validate(t Target) error {
	if net.ParseIP(t.Host) == nil {
		return errors.New("第一版节点地址请填写 IPv4 或 IPv6，不填写 URL")
	}
	if t.Port < 1 || t.Port > 65535 {
		return errors.New("invalid SSH port")
	}
	if t.User != "root" {
		return errors.New("第一版安装仅支持 root 用户")
	}
	return nil
}
var preferredHostKeyAlgos = []string{
	ssh.KeyAlgoED25519,
	ssh.KeyAlgoECDSA256,
	ssh.KeyAlgoECDSA384,
	ssh.KeyAlgoECDSA521,
	ssh.KeyAlgoRSASHA256,
	ssh.KeyAlgoRSASHA512,
}

func Probe(ctx context.Context, t Target) (string, error) {
	if e := Validate(t); e != nil {
		return "", e
	}
	fp := ""
	cl, e := dial(ctx, t, &ssh.ClientConfig{
		User:              t.User,
		HostKeyAlgorithms: preferredHostKeyAlgos,
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			fp = ssh.FingerprintSHA256(key)
			return nil
		},
	})
	if cl != nil {
		cl.Close()
	}
	if fp != "" {
		return fp, nil
	}
	return "", fmt.Errorf("无法读取 SSH 主机指纹: %w", e)
}
func dial(ctx context.Context, t Target, cfg *ssh.ClientConfig) (*ssh.Client, error) {
	addr := net.JoinHostPort(t.Host, strconv.Itoa(t.Port))
	conn, e := (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, "tcp", addr)
	if e != nil {
		return nil, e
	}
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	cc, ch, req, e := ssh.NewClientConn(conn, addr, cfg)
	if e != nil {
		conn.Close()
		return nil, e
	}
	_ = conn.SetDeadline(time.Time{})
	return ssh.NewClient(cc, ch, req), nil
}
func (c *Client) Connect(ctx context.Context, t Target) (*ssh.Client, func(), error) {
	if e := Validate(t); e != nil {
		return nil, nil, e
	}
	if t.Fingerprint == "" {
		return nil, nil, errors.New("请先确认服务器 SSH 指纹")
	}
	select {
	case c.slots <- struct{}{}:
	case <-ctx.Done():
		return nil, nil, ctx.Err()
	}
	release := func() { <-c.slots }
	auth := []ssh.AuthMethod{}
	if t.Password != "" {
		auth = append(auth, ssh.Password(t.Password))
	}
	if c.KeyFile != "" {
		b, e := os.ReadFile(c.KeyFile)
		if e != nil {
			release()
			return nil, nil, e
		}
		s, e := ssh.ParsePrivateKey(b)
		if e != nil {
			release()
			return nil, nil, errors.New("本地 SSH 私钥不可用")
		}
		auth = append(auth, ssh.PublicKeys(s))
	}
	cfg := &ssh.ClientConfig{User: t.User, Auth: auth, HostKeyAlgorithms: preferredHostKeyAlgos, HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
		got := ssh.FingerprintSHA256(key)
		if got != t.Fingerprint {
			return fmt.Errorf("SSH 主机指纹已变化（已存 %s，当前 %s）。打开该节点 → 机器 → 读取指纹 → 确认更新后再部署", t.Fingerprint, got)
		}
		return nil
	}}
	cl, e := dial(ctx, t, cfg)
	if e != nil {
		release()
		return nil, nil, fmt.Errorf("SSH 连接失败（请检查认证、网络和指纹）: %w", e)
	}
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			cl.Close()
		case <-done:
		}
	}()
	return cl, func() { close(done); cl.Close(); release() }, nil
}

type cappedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	remain := 65536 - b.b.Len()
	if remain > 0 {
		if len(p) > remain {
			p = p[:remain]
		}
		_, _ = b.b.Write(p)
	}
	return n, nil
}
func Run(ctx context.Context, c *ssh.Client, command string) ([]byte, error) {
	s, e := c.NewSession()
	if e != nil {
		return nil, e
	}
	defer s.Close()
	out := &cappedBuffer{}
	s.Stdout = out
	s.Stderr = out
	done := make(chan error, 1)
	go func() { done <- s.Run(command) }()
	select {
	case e = <-done:
	case <-ctx.Done():
		s.Close()
		return nil, ctx.Err()
	}
	if e != nil {
		return nil, fmt.Errorf("远端操作失败: %s", out.b.String())
	}
	return out.b.Bytes(), nil
}
func Put(c *ssh.Client, remotePath string, reader io.Reader, mode os.FileMode) error {
	s, e := sftp.NewClient(c)
	if e != nil {
		return e
	}
	defer s.Close()
	if e = s.MkdirAll(path.Dir(remotePath)); e != nil {
		return e
	}
	f, e := s.OpenFile(remotePath+".upload", os.O_CREATE|os.O_WRONLY|os.O_TRUNC)
	if e != nil {
		return e
	}
	if e = f.Chmod(mode); e == nil {
		_, e = io.Copy(f, reader)
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	return s.PosixRename(remotePath+".upload", remotePath)
}

const preflight = `set -eu
fail() { echo "缺: $*"; exit 1; }
. /etc/os-release
case "${ID:-}" in debian|ubuntu) ;; *) fail "发行版需 Debian/Ubuntu（当前 ID=${ID:-unknown}）" ;; esac
[ "$(id -u)" = 0 ] || fail "需要 root"
[ "$(uname -m)" = x86_64 ] || fail "架构需 x86_64（当前 $(uname -m)）"
command -v systemctl >/dev/null || fail "无 systemctl"
command -v curl >/dev/null || fail "无 curl（专用机最小依赖，请先装 curl）"
[ ! -d /www/server/panel ] || fail "检测到宝塔"
for d in /var/lib /srv /usr/local/libexec; do
  mkdir -p "$d" 2>/dev/null || fail "$d 不可创建"
  [ -w "$d" ] || fail "$d 不可写"
done
if [ -f /var/lib/site-panel/owned ]; then
  mark=$(tr -d '\r\n' < /var/lib/site-panel/owned || true)
  case "$mark" in
    site-panel-caddy-v1) ;;
    site-panel-v1) fail "此节点已是 Nginx 版 site-panel，请换干净机器做 Caddy 实验" ;;
    *) fail "未知 owned 标记: $mark" ;;
  esac
else
  if command -v nginx >/dev/null || [ -e /etc/nginx/nginx.conf ]; then fail "已有 Nginx，Caddy 实验版请用干净机器"; fi
  mkdir -p /var/lib/site-panel
  chmod 700 /var/lib/site-panel
  printf 'site-panel-caddy-v1\n' > /var/lib/site-panel/owned
fi
mkdir -p /usr/local/libexec /var/lib/site-panel/tasks /srv/site-panel/sites /etc/caddy/sites
chmod 700 /var/lib/site-panel /var/lib/site-panel/tasks
`
const install = `#!/bin/sh
set -eu
exec 9>/var/lib/site-panel/operation.lock
flock -w 900 9
# Dedicated node: drop Caddy binary + unit only.
# No package manager calls, no system upgrades, no rewriting host sources.
command -v curl >/dev/null || { echo "缺: 无 curl"; exit 1; }
command -v tar >/dev/null || { echo "缺: 无 tar"; exit 1; }
CADDY_VER=2.11.2
CADDY_TGZ="caddy_${CADDY_VER}_linux_amd64.tar.gz"
CADDY_PATH="caddyserver/caddy/releases/download/v${CADDY_VER}/${CADDY_TGZ}"
fetch() {
  url=$1
  echo "下载: $url"
  curl -fL --connect-timeout 15 --max-time 180 -o /tmp/site-panel-caddy.tgz "$url"
}
ok=0
for url in \
  "https://ghfast.top/https://github.com/${CADDY_PATH}" \
  "https://mirror.ghproxy.com/https://github.com/${CADDY_PATH}" \
  "https://github.com/${CADDY_PATH}"
do
  if fetch "$url"; then ok=1; break; fi
done
[ "$ok" = 1 ] || { echo "缺: 无法下载 Caddy ${CADDY_VER}"; exit 1; }
tmpd=$(mktemp -d)
tar -xzf /tmp/site-panel-caddy.tgz -C "$tmpd" caddy
install -m 755 "$tmpd/caddy" /usr/bin/caddy
rm -rf "$tmpd" /tmp/site-panel-caddy.tgz
id caddy >/dev/null 2>&1 || useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy
mkdir -p /etc/caddy/sites /var/lib/caddy /var/log/caddy /srv/site-panel
chown -R caddy:caddy /var/lib/caddy /var/log/caddy
cat > /etc/caddy/Caddyfile <<'CADDY'
{
	admin 127.0.0.1:2019
	email ssl@xfnss.top
	storage file_system {
		root /var/lib/caddy/.local/share/caddy
	}
	cert_issuer acme
	cert_issuer zerossl {env.ZEROSSL_API_KEY}
}
import /etc/caddy/sites/*.caddy
CADDY
[ -e /etc/caddy/sites/.keep.caddy ] || printf '# keep\n' > /etc/caddy/sites/.keep.caddy
[ -f /etc/caddy/zerossl.env ] || umask 077 && printf 'ZEROSSL_API_KEY=\n' > /etc/caddy/zerossl.env && chown root:caddy /etc/caddy/zerossl.env && chmod 640 /etc/caddy/zerossl.env
cat > /etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy (site-panel-caddy)
After=network-online.target
Wants=network-online.target
[Service]
Type=notify
User=caddy
Group=caddy
Environment=HOME=/var/lib/caddy
Environment=XDG_DATA_HOME=/var/lib/caddy/.local/share
EnvironmentFile=-/etc/caddy/zerossl.env
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now caddy
caddy validate --config /etc/caddy/Caddyfile
/usr/local/libexec/site-panel-node status
`
const installUnit = `[Unit]
Description=Site Panel environment installation
After=network.target
[Service]
Type=oneshot
ExecStart=/usr/local/libexec/site-panel-install
TimeoutStartSec=900
Restart=no
UMask=0022
`
const unit = `[Unit]
Description=Site Panel task %i
After=network.target
[Service]
Type=oneshot
ExecStart=/usr/local/libexec/site-panel-node run %i
TimeoutStartSec=0
Restart=no
UMask=0022
`

func Install(ctx context.Context, c *ssh.Client, binary string) error {
	if _, e := Run(ctx, c, preflight); e != nil {
		return e
	}
	f, e := os.Open(binary)
	if e != nil {
		return errors.New("节点执行器未构建，请先运行构建脚本")
	}
	defer f.Close()
	if e = Put(c, "/usr/local/libexec/site-panel-node", f, 0755); e != nil {
		return e
	}
	if e = Put(c, "/etc/systemd/system/site-panel-task@.service", bytes.NewBufferString(unit), 0644); e != nil {
		return e
	}
	if e = Put(c, "/usr/local/libexec/site-panel-install", bytes.NewBufferString(install), 0700); e != nil {
		return e
	}
	if e = Put(c, "/etc/systemd/system/site-panel-install.service", bytes.NewBufferString(installUnit), 0644); e != nil {
		return e
	}
	// systemd owns the installer, not the SSH session. A lost response is unknown,
	// not proof of failure; its state and journal remain queryable on reconnect.
	_, e = Run(ctx, c, "systemctl daemon-reload && systemctl start site-panel-install.service")
	if e != nil {
		logs, logErr := Run(ctx, c, "journalctl -u site-panel-install.service -n 35 --no-pager")
		if logErr == nil {
			return fmt.Errorf("安装未确认成功: %w\n%s", e, logs)
		}
	}
	return e
}
