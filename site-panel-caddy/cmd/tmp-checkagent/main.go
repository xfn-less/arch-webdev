package main
import ("context";"fmt";"os";"strconv";"time";"site-panel/internal/remote")
func main(){
port,_:=strconv.Atoi(os.Getenv("PORT")); if port==0 {port=22}
t:=remote.Target{Host:os.Getenv("HOST"),Port:port,User:os.Getenv("USER"),Password:os.Getenv("PW"),Fingerprint:os.Getenv("FP")}
ctx,cancel:=context.WithTimeout(context.Background(),30*time.Second); defer cancel()
cl:=remote.New(""); c,unlock,e:=cl.Connect(ctx,t); if e!=nil {panic(e)}; defer unlock(); defer c.Close()
out,e:=remote.Run(ctx,c,`curl -skS -o /dev/null -w 'local-z1 %{http_code}\n' --resolve z1.nlpjbz.cn:443:127.0.0.1 https://z1.nlpjbz.cn/; curl -sS -o /dev/null -w 'local-10000 %{http_code}\n' http://127.0.0.1:10000/; curl -sS -o /dev/null -w 'local-http80 %{http_code} -> %{redirect_url}\n' -H 'Host: z1.nlpjbz.cn' http://127.0.0.1/`)
fmt.Printf("%sERR=%v\n",out,e)
}
