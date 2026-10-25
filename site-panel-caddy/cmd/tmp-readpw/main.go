package main

import (
	"fmt"
	"os"
	"path/filepath"

	"site-panel/internal/panel"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: tmp-readpw <data-dir> <node-id>")
		os.Exit(2)
	}
	s, e := panel.Open(os.Args[1], filepath.Join(os.Args[1], "master.key"))
	if e != nil {
		panic(e)
	}
	defer s.Close()
	n, pw, e := s.GetNode(os.Args[2])
	if e != nil {
		panic(e)
	}
	fmt.Printf("HOST=%s\nUSER=%s\nPORT=%d\nFP=%s\nPW=%s\n", n.Host, n.User, n.Port, n.Fingerprint, pw)
}
