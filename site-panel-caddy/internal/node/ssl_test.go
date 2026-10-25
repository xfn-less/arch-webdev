package node

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"strings"
	"testing"
	"time"
)

func testCertificate(t *testing.T) CertificateBundle {
	t.Helper()
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "test.example.com"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		DNSNames:     []string{"test.example.com"},
	}
	der, e := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if e != nil {
		t.Fatal(e)
	}
	keyDER, e := x509.MarshalECPrivateKey(key)
	if e != nil {
		t.Fatal(e)
	}
	return CertificateBundle{
		Fullchain: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		PrivateKey:  string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})),
		Info:        CertificateInfo{Domains: []string{"test.example.com"}},
	}
}

func TestValidDNSName(t *testing.T) {
	for _, name := range []string{"a.example.com", "panel-test.xfnss.top"} {
		if !ValidDNSName(name) {
			t.Fatal(name)
		}
	}
	for _, name := range []string{"", "localhost", "*.example.com", "1.2.3.4", "bad..com"} {
		if ValidDNSName(name) {
			t.Fatal("accepted", name)
		}
	}
	s := SSLRequest{Domains: []string{"test.xfnss.top"}, Agree: true, NodeIP: "103.149.201.31"}
	if e := s.Validate(); e != nil {
		t.Fatal(e)
	}
	s.Agree = false
	if s.Validate() == nil {
		t.Fatal("accepted without terms")
	}
}

func TestCertificateAndConfig(t *testing.T) {
	b := testCertificate(t)
	if _, e := VerifyBundle(b); e != nil {
		t.Fatal(e)
	}
	bad := b
	bad.PrivateKey = "bad"
	if _, e := VerifyBundle(bad); e == nil {
		t.Fatal("accepted bad key")
	}
	// Caddy edition: PreviewConfig ignores cert material and emits a site block.
	s := Site{ID: strings.Repeat("a", 32), Name: "test", Domains: []string{"test.example.com"}, Port: 80, Cert: "auto"}
	conf, e := PreviewConfig(s, &b.Info)
	if e != nil {
		t.Fatal(e)
	}
	for _, part := range []string{"test.example.com", "file_server", "root *"} {
		if !strings.Contains(conf, part) {
			t.Fatal("missing", part, conf)
		}
	}
	if strings.Contains(conf, "ssl_certificate") || strings.Contains(conf, "panel.inc") {
		t.Fatal("nginx leftovers", conf)
	}
	s.Cert = "off"
	s.Port = 18080
	conf, e = s.Config()
	if e != nil || !strings.Contains(conf, "http://test.example.com:18080") {
		t.Fatal(conf, e)
	}
	s.Mode = "proxy"
	s.Upstreams = []string{"127.0.0.1:3000"}
	conf, e = s.Config()
	if e != nil || !strings.Contains(conf, "reverse_proxy 127.0.0.1:3000") {
		t.Fatal(conf, e)
	}
}
