package main

import (
	"encoding/json"
	"fmt"
	"os"
	"site-panel/internal/node"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: site-panel-node status | submit ID | task-status ID | run ID")
		os.Exit(2)
	}
	var result any
	var err error
	switch os.Args[1] {
	case "status":
		result = node.SystemStatus()
	case "submit":
		if len(os.Args) != 3 {
			os.Exit(2)
		}
		err = node.Submit(os.Args[2])
		result = map[string]any{"accepted": err == nil, "id": os.Args[2]}
	case "task-status":
		if len(os.Args) != 3 {
			os.Exit(2)
		}
		result, err = node.Status(os.Args[2])
	case "certificate-export":
		if len(os.Args) != 3 {
			os.Exit(2)
		}
		result, err = node.ExportCertificate(os.Args[2])
	case "renew":
		err = node.RenewCertificates()
		result = map[string]bool{"ok": err == nil}
	case "run":
		if len(os.Args) != 3 {
			os.Exit(2)
		}
		err = node.Run(os.Args[2])
		result = map[string]bool{"ok": err == nil}
	default:
		err = fmt.Errorf("unknown operation")
	}
	if err != nil {
		_ = json.NewEncoder(os.Stderr).Encode(map[string]string{"error": err.Error()})
		os.Exit(1)
	}
	_ = json.NewEncoder(os.Stdout).Encode(result)
}
