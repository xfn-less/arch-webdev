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
command -v apt-get >/dev/null || fail "无 apt-get"
[ ! -d /www/server/panel ] || fail "检测到宝塔"
for d in /var/lib /srv /usr/local/libexec; do
  mkdir -p "$d" 2>/dev/null || fail "$d 不可创建"
  [ -w "$d" ] || fail "$d 不可写"
done
if [ ! -f /var/lib/site-panel/owned ]; then
  if command -v nginx >/dev/null || [ -e /etc/nginx/nginx.conf ]; then fail "已有非受管 Nginx"; fi
  mkdir -p /var/lib/site-panel
  chmod 700 /var/lib/site-panel
  printf 'site-panel-v1\n' > /var/lib/site-panel/owned
else
  if [ -d /etc/nginx/conf.d ]; then
    [ -w /etc/nginx/conf.d ] || fail "conf.d 不可写"
  fi
fi
mkdir -p /usr/local/libexec /var/lib/site-panel/tasks /srv/site-panel/sites /etc/nginx/site-panel
chmod 700 /var/lib/site-panel /var/lib/site-panel/tasks
`
const install = `#!/bin/sh
set -eu
export DEBIAN_FRONTEND=noninteractive
exec 9>/var/lib/site-panel/operation.lock
flock -w 900 9
. /etc/os-release
# Explicit managed source list; never rewrite the host's /etc/apt sources.
# Ubuntu must not receive Debian bookworm lists.
CODENAME=${VERSION_CODENAME:-}
if [ -z "$CODENAME" ]; then
  case "${ID}-${VERSION_ID:-}" in
    debian-12) CODENAME=bookworm ;;
    debian-13) CODENAME=trixie ;;
    ubuntu-22.04) CODENAME=jammy ;;
    ubuntu-24.04) CODENAME=noble ;;
    *) echo "缺: 无法识别 VERSION_CODENAME（ID=$ID VERSION_ID=${VERSION_ID:-}）"; exit 1 ;;
  esac
fi
case "$ID" in
  debian)
    cat > /var/lib/site-panel/apt.list <<SOURCES
deb https://deb.debian.org/debian $CODENAME main
deb https://deb.debian.org/debian $CODENAME-updates main
deb https://security.debian.org/debian-security $CODENAME-security main
SOURCES
    cp /var/lib/site-panel/apt.list /var/lib/site-panel/debian.list
    ;;
  ubuntu)
    cat > /var/lib/site-panel/apt.list <<SOURCES
deb https://archive.ubuntu.com/ubuntu $CODENAME main universe
deb https://archive.ubuntu.com/ubuntu $CODENAME-updates main universe
deb https://security.ubuntu.com/ubuntu $CODENAME-security main universe
SOURCES
    rm -f /var/lib/site-panel/debian.list
    ;;
  *)
    echo "缺: 发行版需 Debian/Ubuntu（当前 ID=$ID）"; exit 1
    ;;
esac
APT_SRC=/var/lib/site-panel/apt.list
apt-get -o Dir::Etc::sourcelist=$APT_SRC -o Dir::Etc::sourceparts=- -o Acquire::ForceIPv4=true -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o Acquire::Retries=1 -o APT::Update::Error-Mode=any -o DPkg::Lock::Timeout=120 update
apt-get -o Dir::Etc::sourcelist=$APT_SRC -o Dir::Etc::sourceparts=- -o Acquire::ForceIPv4=true -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o Acquire::Retries=1 -o DPkg::Lock::Timeout=120 install -y nginx ca-certificates
mkdir -p /etc/nginx/conf.d /etc/nginx/site-panel
[ -w /etc/nginx/conf.d ] || { echo '缺: conf.d 不可写'; exit 1; }
systemctl enable --now nginx
nginx -t
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
