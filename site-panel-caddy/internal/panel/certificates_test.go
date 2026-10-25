package panel

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"math/big"
	"site-panel/internal/node"
	"testing"
	"time"
)

func TestCertificateBackupIsEncryptedAndMetadataPublic(t *testing.T) {
	a := newTestApp(t)
	n := Node{ID: ID(), Name: "test", Host: "127.0.0.1", Port: 22, User: "root", Fingerprint: "SHA256:test"}
	if e := a.Store.SaveNode(n, "password"); e != nil {
		t.Fatal(e)
	}
	site := Site{Site: node.Site{ID: ID(), Name: "site", Domains: []string{"test.example.com"}, Port: 80}, NodeID: n.ID, PublishPath: DefaultPublishPath}
	if e := a.Store.SaveSite(site); e != nil {
		t.Fatal(e)
	}
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	c := &x509.Certificate{SerialNumber: big.NewInt(9), DNSNames: []string{"test.example.com"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, e := x509.CreateCertificate(rand.Reader, c, c, pub, key)
	if e != nil {
		t.Fatal(e)
	}
	pk, _ := x509.MarshalPKCS8PrivateKey(key)
	b := node.CertificateBundle{Fullchain: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), PrivateKey: string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pk})), Info: node.CertificateInfo{Applied: true, RenewTimer: true}}
	if e = a.Store.SaveCertificate(site.ID, b); e != nil {
		t.Fatal(e)
	}
	var cipher []byte
	if e = a.Store.db.QueryRow(`SELECT encrypted FROM certificates WHERE site_id=?`, site.ID).Scan(&cipher); e != nil {
		t.Fatal(e)
	}
	if bytes.Contains(cipher, []byte("PRIVATE KEY")) {
		t.Fatal("plaintext private key in DB")
	}
	fetched, e := a.Store.GetSite(site.ID)
	if e != nil || fetched.SSL == nil || !fetched.SSL.Applied {
		t.Fatal(fetched, e)
	}
	all, e := a.Store.Sites()
	if e != nil || len(all) != 1 || all[0].SSL == nil {
		t.Fatal(all, e)
	}
	cookie, csrf := setup(t, a)
	w := request(t, a, "GET", "/api/sites", "", cookie, csrf)
	if bytes.Contains(w.Body.Bytes(), []byte("PRIVATE KEY")) {
		t.Fatal("private key exposed")
	}
}
func TestInvalidSSLRequestsDoNotQueueTasks(t *testing.T) {
	a := newTestApp(t)
	cookie, csrf := setup(t, a)
	n := Node{ID: ID(), Name: "test", Host: "127.0.0.1", Port: 22, User: "root", Fingerprint: "SHA256:test"}
	_ = a.Store.SaveNode(n, "password")
	s := Site{Site: node.Site{ID: ID(), Name: "site", Domains: []string{"127.0.0.1"}, Port: 80}, NodeID: n.ID, PublishPath: DefaultPublishPath}
	_ = a.Store.SaveSite(s)
	for _, body := range []string{`{"domains":["*.xfnss.top"],"agree_terms":true}`, `{"domains":["test.xfnss.top"],"agree_terms":false}`, `{"domains":["127.0.0.1"],"agree_terms":true}`} {
		w := request(t, a, "POST", "/api/sites/"+s.ID+"/ssl", body, cookie, csrf)
		if w.Code != 400 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	tasks, e := a.Store.Tasks()
	if e != nil || len(tasks) != 0 {
		t.Fatal(tasks, e)
	}
}
