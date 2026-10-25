package node

import (
	"errors"
	"os"
	"path/filepath"
)

// Certbot updates its live symlinks before Nginx is loaded. If a domain-change
// deployment fails, restoring nginx.conf alone would still serve the NEW cert
// under the OLD names. Preserve both live links and renewal settings.
func saveCertbotState(id, recoveryDir string) (func() error, error) {
	return saveCertbotStateAt(acmeRoot, id, recoveryDir)
}
func saveCertbotStateAt(root, id string, recoveryDir ...string) (func() error, error) {
	dir := filepath.Join(root, "config/live/site-"+id)
	links := map[string]string{}
	for _, name := range []string{"cert.pem", "chain.pem", "fullchain.pem", "privkey.pem"} {
		p := filepath.Join(dir, name)
		target, e := os.Readlink(p)
		if e != nil {
			return nil, e
		}
		links[p] = target
	}
	renewal := filepath.Join(root, "config/renewal/site-"+id+".conf")
	contents, e := os.ReadFile(renewal)
	if e != nil {
		return nil, e
	}
	if len(recoveryDir) > 0 {
		if e = AtomicJSON(filepath.Join(recoveryDir[0], "certificate-recovery.json"), map[string]any{"links": links, "renewal_path": renewal, "renewal_config": string(contents)}); e != nil {
			return nil, e
		}
	}
	return func() error {
		var result error
		for p, target := range links {
			temp := p + ".site-panel-restore"
			_ = os.Remove(temp)
			e := os.Symlink(target, temp)
			if e == nil {
				e = os.Rename(temp, p)
			}
			result = errors.Join(result, e)
		}
		result = errors.Join(result, atomicWrite(renewal, contents, 0600))
		return result
	}, nil
}
