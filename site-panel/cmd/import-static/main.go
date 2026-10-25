// import-static is a local offline maintenance command, not a discovery API.
// Stop the panel first; the shared data-directory lock prevents concurrent edits.
package main

import (
	"flag"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"

	"site-panel/internal/node"
	"site-panel/internal/panel"
)

func main() {
	data := flag.String("data", "./data", "panel data directory")
	key := flag.String("key-file", "", "encryption key; defaults to data/master.key")
	nodeID := flag.String("node-id", "", "existing panel node ID")
	siteID := flag.String("site-id", "", "existing remote managed site ID")
	name := flag.String("name", "", "site display name")
	domains := flag.String("domains", "", "space-separated domains/IPs")
	port := flag.Int("port", 18080, "HTTP port")
	source := flag.String("source", "", "verified local source directory")
	flag.Parse()
	if *key == "" {
		*key = filepath.Join(*data, "master.key")
	}
	if !node.ValidID(*nodeID) || *source == "" {
		log.Fatal("node-id and source are required")
	}
	spec := node.Site{ID: *siteID, Name: *name, Domains: strings.Fields(*domains), Port: *port}
	if e := spec.Validate(); e != nil {
		log.Fatal(e)
	}
	if e := run(*data, *key, *nodeID, *source, spec); e != nil {
		log.Fatal(e)
	}
	fmt.Printf("Imported %s (%s) into node %s\n", spec.Name, spec.ID, *nodeID)
}
func run(data, key, nodeID, source string, spec node.Site) error {
	store, e := panel.Open(data, key)
	if e != nil {
		return e
	}
	defer store.Close()
	if _, _, e = store.GetNode(nodeID); e != nil {
		return fmt.Errorf("node does not exist: %w", e)
	}
	sites, e := store.Sites()
	if e != nil {
		return e
	}
	for _, s := range sites {
		if s.ID == spec.ID {
			return fmt.Errorf("site ID already exists; refusing to overwrite")
		}
		if s.NodeID == nodeID && s.Port == spec.Port {
			for _, h := range s.Domains {
				for _, other := range spec.Domains {
					if strings.EqualFold(h, other) {
						return fmt.Errorf("domain/port already exists on node")
					}
				}
			}
		}
	}
	input, e := os.OpenRoot(source)
	if e != nil {
		return e
	}
	defer input.Close()
	st, e := input.Stat("index.html")
	if e != nil || !st.Mode().IsRegular() {
		return fmt.Errorf("source needs a regular index.html")
	}
	if e = fs.WalkDir(input.FS(), ".", func(p string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if d.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("links are not supported: %s", p)
		}
		if !d.IsDir() {
			st, e := d.Info()
			if e != nil {
				return e
			}
			if !st.Mode().IsRegular() {
				return fmt.Errorf("special file: %s", p)
			}
		}
		return nil
	}); e != nil {
		return e
	}
	base := filepath.Join(data, "sites")
	if e = os.MkdirAll(base, 0700); e != nil {
		return e
	}
	dest := filepath.Join(base, spec.ID)
	if _, e = os.Lstat(dest); !os.IsNotExist(e) {
		return fmt.Errorf("destination exists or is inaccessible")
	}
	tmp, e := os.MkdirTemp(base, ".import-")
	if e != nil {
		return e
	}
	defer os.RemoveAll(tmp)
	if e = os.CopyFS(tmp, input.FS()); e != nil {
		return e
	}
	if e = os.Rename(tmp, dest); e != nil {
		return e
	}
	if e = store.SaveSite(panel.Site{Site: spec, NodeID: nodeID}); e != nil {
		_ = os.RemoveAll(dest)
		return e
	}
	return nil
}
