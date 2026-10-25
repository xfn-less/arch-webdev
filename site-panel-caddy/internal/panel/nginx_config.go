package panel

import (
	"errors"
	"os"
	"path/filepath"

	"site-panel/internal/node"
)

func (a *App) nginxPath(id string) (string, error) {
	if !node.ValidID(id) {
		return "", errors.New("无效站点")
	}
	dir := filepath.Join(a.Store.Dir, "caddy-configs")
	if e := os.MkdirAll(dir, 0700); e != nil {
		return "", e
	}
	return filepath.Join(dir, id+".conf"), nil
}

func (a *App) loadCustomNginx(id string) (string, bool, error) {
	path, e := a.nginxPath(id)
	if e != nil {
		return "", false, e
	}
	b, e := os.ReadFile(path)
	if os.IsNotExist(e) {
		return "", false, nil
	}
	if e != nil {
		return "", false, e
	}
	return string(b), true, nil
}

func (a *App) saveCustomNginx(id, text string) error {
	if e := node.ValidateCaddyConfig(text); e != nil {
		return e
	}
	path, e := a.nginxPath(id)
	if e != nil {
		return e
	}
	return atomicWriteFile(path, []byte(text), 0600)
}

func (a *App) clearCustomNginx(id string) error {
	path, e := a.nginxPath(id)
	if e != nil {
		return e
	}
	if e = os.Remove(path); e != nil && !os.IsNotExist(e) {
		return e
	}
	return nil
}

func (a *App) siteNginxText(s Site) (string, string, error) {
	if text, ok, e := a.loadCustomNginx(s.ID); e != nil {
		return "", "", e
	} else if ok {
		return text, "custom", nil
	}
	c, e := node.PreviewConfig(s.Site, s.SSL)
	if e != nil {
		return "", "", e
	}
	return c, "generated", nil
}

func atomicWriteFile(path string, b []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	f, e := os.CreateTemp(dir, ".caddy-")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if e = f.Chmod(mode); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	return os.Rename(f.Name(), path)
}
