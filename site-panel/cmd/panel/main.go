package main

import (
	"context"
	"flag"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"site-panel/internal/panel"
	"site-panel/web"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:8090", "HTTP listen address (loopback by default)")
	data := flag.String("data", "./data", "private data directory")
	key := flag.String("key-file", "", "encryption key (defaults to data/master.key; keep a separate backup)")
	sshKey := flag.String("ssh-key", "", "optional LOCAL SSH private key for development; never exposed through API")
	binary := flag.String("node-binary", "./bin/site-panel-node", "Debian amd64 node executable")
	devWeb := flag.String("web-dir", "", "optional on-disk frontend directory for development")
	secure := flag.Bool("secure-cookie", false, "require HTTPS session cookies; required for non-loopback access")
	flag.Parse()
	host, _, e := net.SplitHostPort(*listen)
	if e != nil {
		log.Fatal(e)
	}
	ip := net.ParseIP(host)
	if (ip == nil || !ip.IsLoopback()) && !*secure {
		log.Fatal("non-loopback access requires HTTPS reverse proxy and -secure-cookie=true")
	}
	if *key == "" {
		*key = filepath.Join(*data, "master.key")
	}
	store, e := panel.Open(*data, *key)
	if e != nil {
		log.Fatal(e)
	}
	defer store.Close()
	var assets fs.FS = web.Assets
	if *devWeb != "" {
		assets = os.DirFS(*devWeb)
	}
	app := panel.New(store, *sshKey, *binary, assets)
	app.SecureCookie = *secure
	defer app.Close()
	server := &http.Server{Addr: *listen, Handler: app, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 20}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()
	log.Printf("Site Panel: http://%s (data: %s)", *listen, *data)
	if e = server.ListenAndServe(); e != nil && e != http.ErrServerClosed {
		log.Print(e)
	}
}
