package panel
import (
  "testing"
  "site-panel/internal/node"
)
func TestEncodeProxies(t *testing.T) {
  s := node.Site{ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Name: "t", Domains: []string{"a.com"}, Proxies: []node.ProxyRoute{{Path:"/api", Upstream:"127.0.0.1:8080"}}}
  b,e := encodeSiteSpec(s, true, nil, DefaultPublishPath)
  if e != nil { t.Fatal(e) }
  got, en, _, _, e := decodeSiteSpec(b)
  if e != nil || !en { t.Fatal(e, en) }
  if len(got.Proxies)!=1 || got.Proxies[0].Path!="/api" { t.Fatalf("%+v", got.Proxies) }
}
