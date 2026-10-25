package main
import (
  "encoding/json"
  "fmt"
  "os"
  "site-panel/internal/node"
)
func main(){
  var s node.Site
  _=json.Unmarshal([]byte(os.Args[1]), &s)
  txt,e:=s.CaddyfileSite()
  if e!=nil {panic(e)}
  fmt.Println(txt)
  fmt.Println("--- WantHTTPRedirect", s.WantHTTPRedirect(), "CertMode", s.CertMode())
}
