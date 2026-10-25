package remote

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func testSSH(t *testing.T) (Target, func()) {
	t.Helper()
	_, private, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	signer, e := ssh.NewSignerFromKey(private)
	if e != nil {
		t.Fatal(e)
	}
	config := &ssh.ServerConfig{PasswordCallback: func(_ ssh.ConnMetadata, p []byte) (*ssh.Permissions, error) {
		if string(p) != "password" {
			return nil, errors.New("bad password")
		}
		return nil, nil
	}}
	config.AddHostKey(signer)
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			conn, e := l.Accept()
			if e != nil {
				return
			}
			go func() {
				c, ch, requests, e := ssh.NewServerConn(conn, config)
				if e != nil {
					conn.Close()
					return
				}
				defer c.Close()
				go ssh.DiscardRequests(requests)
				for nc := range ch {
					_ = nc.Reject(ssh.UnknownChannelType, "unsupported")
				}
			}()
		}
	}()
	host, p, _ := net.SplitHostPort(l.Addr().String())
	port, _ := strconv.Atoi(p)
	return Target{Host: host, Port: port, User: "root", Password: "password", Fingerprint: ssh.FingerprintSHA256(signer.PublicKey())}, func() { l.Close(); <-done }
}
func TestProbeAndPinnedAuthentication(t *testing.T) {
	target, stop := testSSH(t)
	defer stop()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	fp, e := Probe(ctx, target)
	if e != nil || fp != target.Fingerprint {
		t.Fatal(fp, e)
	}
	c := New("")
	cl, close, e := c.Connect(ctx, target)
	if e != nil {
		t.Fatal(e)
	}
	_ = cl
	close()
	target.Fingerprint = "SHA256:wrong"
	if _, _, e = c.Connect(ctx, target); e == nil {
		t.Fatal("accepted wrong key")
	}
	target.Fingerprint = fp
	target.Password = "wrong"
	if _, _, e = c.Connect(ctx, target); e == nil {
		t.Fatal("accepted wrong password")
	}
}
func TestCappedConcurrentOutput(t *testing.T) {
	b := &cappedBuffer{}
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 100 {
				_, _ = b.Write([]byte(strings.Repeat("x", 1024)))
			}
		}()
	}
	wg.Wait()
	if b.b.Len() != 65536 {
		t.Fatal(b.b.Len())
	}
}
func TestValidate(t *testing.T) {
	for _, v := range []Target{{Host: "example.com", Port: 22, User: "root"}, {Host: "127.0.0.1", Port: 0, User: "root"}, {Host: "127.0.0.1", Port: 22, User: "guest"}} {
		if Validate(v) == nil {
			t.Fatal("accepted invalid target", v)
		}
	}
}


func TestInstallCapabilityScripts(t *testing.T) {
	if strings.Contains(preflight, "仅支持 Debian 12") {
		t.Fatal("preflight still hard-locks Debian 12")
	}
	for _, part := range []string{"缺:", "需要 root", "无 systemctl", "无 apt-get", "conf.d 不可写", "检测到宝塔"} {
		if !strings.Contains(preflight, part) {
			t.Fatal("preflight missing", part)
		}
	}
	if !strings.Contains(install, "archive.ubuntu.com") || !strings.Contains(install, "deb.debian.org") {
		t.Fatal("install missing distro sources")
	}
	ubuntuStart := strings.Index(install, "ubuntu)")
	if ubuntuStart < 0 {
		t.Fatal("missing ubuntu branch")
	}
	ubuntuEnd := strings.Index(install[ubuntuStart:], "*)")
	ubuntu := install[ubuntuStart : ubuntuStart+ubuntuEnd]
	if strings.Contains(ubuntu, "bookworm") || strings.Contains(ubuntu, "deb.debian.org") {
		t.Fatal("ubuntu branch must not use Debian bookworm sources", ubuntu)
	}
}
