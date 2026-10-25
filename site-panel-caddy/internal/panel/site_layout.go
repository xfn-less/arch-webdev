package panel

import (
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"

	"site-panel/internal/node"
)

// DefaultPublishPath is the initial publish folder for new sites.
const DefaultPublishPath = "site"

func normalizePublishPath(p string) (string, error) {
	p = strings.Trim(strings.ReplaceAll(strings.TrimSpace(p), "\\", "/"), "/")
	if p == "" {
		return "", nil
	}
	if path.IsAbs(p) || strings.ContainsRune(p, 0) {
		return "", errors.New("站点目录路径无效")
	}
	clean := path.Clean(p)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", errors.New("站点目录路径无效")
	}
	for _, part := range strings.Split(clean, "/") {
		if part == "" || part == "." || part == ".." {
			return "", errors.New("站点目录路径无效")
		}
	}
	return clean, nil
}

func (a *App) siteDir(id string) (string, error) {
	if !node.ValidID(id) {
		return "", errors.New("无效站点")
	}
	return filepath.Join(a.Store.Dir, "sites", id), nil
}

func (a *App) ensureSiteWorkspace(id string) error {
	dir, e := a.siteDir(id)
	if e != nil {
		return e
	}
	return os.MkdirAll(dir, 0700)
}

func (a *App) ensurePublishDir(id, rel string) error {
	if e := a.ensureSiteWorkspace(id); e != nil {
		return e
	}
	dir, e := a.siteDir(id)
	if e != nil {
		return e
	}
	rel, e = normalizePublishPath(rel)
	if e != nil {
		return e
	}
	if rel == "" {
		return nil
	}
	publish := filepath.Join(dir, filepath.FromSlash(rel))
	if st, e := os.Stat(publish); e == nil {
		if !st.IsDir() {
			return errors.New("站点目录不是文件夹")
		}
		return nil
	} else if !os.IsNotExist(e) {
		return e
	}
	if e = os.MkdirAll(publish, 0700); e != nil {
		return e
	}
	// One-time migrate only for default top-level "site".
	if rel != DefaultPublishPath {
		return nil
	}
	entries, e := os.ReadDir(dir)
	if e != nil {
		return e
	}
	for _, ent := range entries {
		name := ent.Name()
		if name == DefaultPublishPath || strings.HasPrefix(name, ".") {
			continue
		}
		from := filepath.Join(dir, name)
		to := filepath.Join(publish, name)
		if _, e := os.Stat(to); e == nil {
			continue
		}
		_ = os.Rename(from, to)
	}
	return nil
}

func (a *App) sitePublishRoot(id string) (*os.Root, error) {
	s, e := a.Store.GetSite(id)
	if e != nil {
		return nil, e
	}
	rel, e := normalizePublishPath(s.PublishPath)
	if e != nil {
		return nil, e
	}
	if e = a.ensurePublishDir(id, rel); e != nil {
		return nil, e
	}
	dir, e := a.siteDir(id)
	if e != nil {
		return nil, e
	}
	if rel != "" {
		dir = filepath.Join(dir, filepath.FromSlash(rel))
	}
	return os.OpenRoot(dir)
}

func uniqueChildName(dir, base string) string {
	base = strings.Trim(strings.ReplaceAll(base, "\\", "/"), "/")
	if base == "" || base == "." || base == ".." || strings.Contains(base, "/") {
		base = "upload"
	}
	candidate := base
	for i := 2; ; i++ {
		if _, e := os.Stat(filepath.Join(dir, candidate)); os.IsNotExist(e) {
			return candidate
		}
		candidate = fmt.Sprintf("%s-%d", base, i)
	}
}
