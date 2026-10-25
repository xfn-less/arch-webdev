// Offline local maintenance: import a bundle obtained over authenticated SSH.
// The data-directory lock requires stopping the panel. Never print key material.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"site-panel/internal/node"
	"site-panel/internal/panel"
)

func main() {
	data := flag.String("data", "./data", "panel data directory")
	key := flag.String("key-file", "", "encryption key")
	id := flag.String("site-id", "", "existing site ID")
	bundlePath := flag.String("bundle", "", "private JSON bundle from certificate-export")
	taskID := flag.String("task-id", "", "completed production task ID")
	stagingID := flag.String("staging-task", "", "completed staging task ID")
	flag.Parse()
	if !node.ValidID(*id) || *bundlePath == "" {
		log.Fatal("site-id and bundle required")
	}
	if *key == "" {
		*key = filepath.Join(*data, "master.key")
	}
	raw, e := os.ReadFile(*bundlePath)
	if e != nil {
		log.Fatal("unable to read certificate bundle")
	}
	var b node.CertificateBundle
	if json.Unmarshal(raw, &b) != nil {
		log.Fatal("invalid certificate bundle")
	}
	info, e := node.VerifyBundle(b)
	if e != nil {
		log.Fatal(e)
	}
	store, e := panel.Open(*data, *key)
	if e != nil {
		log.Fatal(e)
	}
	defer store.Close()
	site, e := store.GetSite(*id)
	if e != nil {
		log.Fatal(e)
	}
	for _, h := range info.Domains {
		found := false
		for _, old := range site.Domains {
			found = found || old == h
		}
		if !found {
			site.Domains = append(site.Domains, h)
		}
	}
	if e = site.Site.Validate(); e != nil {
		log.Fatal(e)
	}
	if e = store.UpdateSite(site); e != nil {
		log.Fatal(e)
	}
	if e = store.SaveCertificate(site.ID, b); e != nil {
		log.Fatal(e)
	}
	for _, record := range []struct{ id, step string }{{*stagingID, "ssl_staging_done"}, {*taskID, "ssl_done"}} {
		if record.id == "" {
			continue
		}
		if !node.ValidID(record.id) {
			log.Fatal("invalid task id")
		}
		if _, e = store.GetTask(record.id); e == nil {
			continue
		}
		if e = store.NewTask(panel.Task{ID: record.id, Kind: "ssl", NodeID: site.NodeID, SiteID: site.ID, Status: "succeeded", Step: record.step}); e != nil {
			log.Fatal(e)
		}
	}
	fmt.Printf("Imported certificate metadata and encrypted backup for %s; expires %s\n", site.Name, info.NotAfter.Format("2006-01-02"))
}
