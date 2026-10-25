package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"site-panel/internal/panel"
	"site-panel/internal/remote"
)

func main() {
	if len(os.Args) != 4 {
		fmt.Fprintln(os.Stderr, "usage: tmp-reinstall <data-dir> <node-id> <node-binary>")
		os.Exit(2)
	}
	data, nodeID, bin := os.Args[1], os.Args[2], os.Args[3]
	s, e := panel.Open(data, filepath.Join(data, "master.key"))
	if e != nil {
		panic(e)
	}
	defer s.Close()
	n, pw, e := s.GetNode(nodeID)
	if e != nil {
		panic(e)
	}
	cl := remote.New("") // password auth only
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	t := remote.Target{Host: n.Host, Port: n.Port, User: n.User, Password: pw, Fingerprint: n.Fingerprint}
	ssh, close, e := cl.Connect(ctx, t)
	if e != nil {
		panic(e)
	}
	defer close()
	_, _ = remote.Run(ctx, ssh, "systemctl stop site-panel-install.service || true; sleep 1; fuser -k /var/lib/dpkg/lock-frontend 2>/dev/null || true; dpkg --configure -a || true")
	if e = remote.Install(ctx, ssh, bin); e != nil {
		panic(e)
	}
	fmt.Println("install unit started")
}
