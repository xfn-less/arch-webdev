package node

import (
	"crypto/ed25519"
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
	pub, key, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test.example.com"}, DNSNames: []string{"test.example.com"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, e := x509.CreateCertificate(rand.Reader, template, template, pub, key)
	if e != nil {
		t.Fatal(e)
	}
	private, e := x509.MarshalPKCS8PrivateKey(key)
	if e != nil {
		t.Fatal(e)
	}
	b := CertificateBundle{Fullchain: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), PrivateKey: string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: private}))}
	b.Info, e = VerifyBundle(b)
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func TestSSLDomains(t *testing.T) {
	for _, name := range []string{"*.xfnss.top", "103.149.201.31", "evil;test.com", "test..com", "-a.test.com", "a.test_.com", "localhost"} {
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
	if b.Info.Fingerprint == "" || len(b.Info.Domains) != 1 {
		t.Fatal(b.Info)
	}
	bad := b
	bad.PrivateKey = "bad"
	if _, e := VerifyBundle(bad); e == nil {
		t.Fatal("accepted bad key")
	}
	s := Site{ID: strings.Repeat("a", 32), Name: "test", Domains: []string{"103.149.201.31", "test.example.com"}, Port: 18080}
	conf, e := configWithCert(s, &b, nil)
	if e != nil {
		t.Fatal(e)
	}
	inc := PanelIncPath(s.ID)
	for _, part := range []string{"listen 18080;", "listen 80;", "listen 443 ssl;", "include " + inc, "server_name test.example.com;"} {
		if !strings.Contains(conf, part) {
			t.Fatal("missing", part, conf)
		}
	}
	if strings.Contains(conf, "ssl_certificate ") {
		t.Fatal("certificate paths must live in panel.inc, not business conf")
	}
	body := panelIncContent(s.ID, true)
	for _, part := range []string{panelIncMarker, "/.well-known/acme-challenge/", "ssl_certificate ", "ssl_certificate_key "} {
		if !strings.Contains(body, part) {
			t.Fatal("panel.inc missing", part, body)
		}
	}
	tlsSection := conf[strings.Index(conf, "listen 443 ssl;"):]
	if strings.Contains(tlsSection, "103.149.201.31") {
		t.Fatal("IP included in TLS names")
	}
	s.Port = 80
	conf, e = configWithCert(s, &b, nil)
	if e != nil || strings.Count(conf, "listen 80;") != 1 {
		t.Fatal(conf, e)
	}
}
