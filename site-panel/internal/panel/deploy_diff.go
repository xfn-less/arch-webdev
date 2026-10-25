package panel

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"site-panel/internal/node"
)

const deployDiffSampleLimit = 8

type deploySnapshot struct {
	SiteID       string            `json:"site_id"`
	At           string            `json:"at"`
	Files        map[string]string `json:"files"`
	NginxHash    string            `json:"nginx_hash"`
	NginxSource  string            `json:"nginx_source"`
	VarsHash     string            `json:"vars_hash"`
	Replacements int               `json:"replacements"`
}

type deployDiff struct {
	HasBaseline  bool     `json:"has_baseline"`
	FirstDeploy  bool     `json:"first_deploy"`
	NginxChanged bool     `json:"nginx_changed"`
	NginxSource  string   `json:"nginx_source"`
	VarsChanged  bool     `json:"vars_changed"`
	Added        []string `json:"added"`
	Changed      []string `json:"changed"`
	Removed      []string `json:"removed"`
	Unchanged    int      `json:"unchanged"`
	FileCount    int      `json:"file_count"`
	Replacements int      `json:"replacements"`
	Summary      string   `json:"summary"`
	Note         string   `json:"note"`
}

func (a *App) deploySnapshotPath(id string) string {
	return filepath.Join(a.Store.Dir, "deploy-snapshots", id+".json")
}

func (a *App) taskManifestPath(taskID string) string {
	return filepath.Join(a.Store.Dir, "tasks", taskID, "manifest.json")
}

func hashBytes(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func hashVars(vars map[string]string) string {
	if len(vars) == 0 {
		return hashBytes(nil)
	}
	keys := make([]string, 0, len(vars))
	for k := range vars {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		b.WriteString(k)
		b.WriteByte(0)
		b.WriteString(vars[k])
		b.WriteByte(0)
	}
	return hashBytes([]byte(b.String()))
}

func (a *App) siteContentManifest(s Site) (deploySnapshot, error) {
	out := deploySnapshot{
		SiteID:   s.ID,
		At:       time.Now().UTC().Format(time.RFC3339),
		Files:    map[string]string{},
		VarsHash: hashVars(s.Vars),
	}
	nginx, source, e := a.siteNginxText(s)
	if e != nil {
		return out, e
	}
	out.NginxSource = source
	out.NginxHash = hashBytes([]byte(nginx))

	root, e := a.siteRoot(s.ID)
	if e != nil {
		return out, e
	}
	defer root.Close()
	e = fs.WalkDir(root.FS(), ".", func(p string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if p == "." || d.IsDir() {
			return nil
		}
		st, e := d.Info()
		if e != nil {
			return e
		}
		if !st.Mode().IsRegular() {
			return errors.New("不支持链接或特殊文件")
		}
		input, e := root.Open(p)
		if e != nil {
			return e
		}
		raw, e := io.ReadAll(io.LimitReader(input, (8<<30)+1))
		ce := input.Close()
		if e != nil {
			return e
		}
		if ce != nil {
			return ce
		}
		if len(raw) > 8<<30 {
			return errors.New("单文件过大")
		}
		body := raw
		if shouldReplaceVars(p, raw) {
			text, n := applyVars(string(raw), s.Vars)
			if n > 0 {
				body = []byte(text)
				out.Replacements += n
			}
		}
		out.Files[p] = hashBytes(body)
		return nil
	})
	return out, e
}

func writeDeploySnapshot(path string, snap deploySnapshot) error {
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	b, e := json.MarshalIndent(snap, "", "  ")
	if e != nil {
		return e
	}
	return atomicWriteFile(path, b, 0600)
}

func loadDeploySnapshot(path string) (deploySnapshot, bool, error) {
	b, e := os.ReadFile(path)
	if os.IsNotExist(e) {
		return deploySnapshot{}, false, nil
	}
	if e != nil {
		return deploySnapshot{}, false, e
	}
	var snap deploySnapshot
	if e = json.Unmarshal(b, &snap); e != nil {
		return deploySnapshot{}, false, e
	}
	if snap.Files == nil {
		snap.Files = map[string]string{}
	}
	return snap, true, nil
}

func (a *App) clearDeploySnapshot(id string) {
	_ = os.Remove(a.deploySnapshotPath(id))
}

func samplePaths(paths []string, limit int) []string {
	sort.Strings(paths)
	if len(paths) <= limit {
		return paths
	}
	out := append([]string{}, paths[:limit]...)
	out = append(out, fmt.Sprintf("…另有 %d 个", len(paths)-limit))
	return out
}

func diffDeploySnapshots(prev deploySnapshot, hasPrev bool, cur deploySnapshot) deployDiff {
	d := deployDiff{
		HasBaseline:  hasPrev,
		FirstDeploy:  !hasPrev,
		NginxSource:  cur.NginxSource,
		Replacements: cur.Replacements,
		FileCount:    len(cur.Files),
		Note:         "仍全量推送文件与 Nginx",
		Added:        []string{},
		Changed:      []string{},
		Removed:      []string{},
	}
	if !hasPrev {
		src := "默认生成"
		if cur.NginxSource == "custom" {
			src = "自定义"
		}
		d.Summary = fmt.Sprintf("首次部署（全量）· %d 个文件 · Nginx %s · 变量替换 %d 处", len(cur.Files), src, cur.Replacements)
		return d
	}
	d.NginxChanged = prev.NginxHash != cur.NginxHash || prev.NginxSource != cur.NginxSource
	d.VarsChanged = prev.VarsHash != cur.VarsHash
	for path, hash := range cur.Files {
		old, ok := prev.Files[path]
		if !ok {
			d.Added = append(d.Added, path)
			continue
		}
		if old != hash {
			d.Changed = append(d.Changed, path)
			continue
		}
		d.Unchanged++
	}
	for path := range prev.Files {
		if _, ok := cur.Files[path]; !ok {
			d.Removed = append(d.Removed, path)
		}
	}
	parts := []string{}
	fileParts := []string{}
	if n := len(d.Added); n > 0 {
		fileParts = append(fileParts, fmt.Sprintf("新增 %d", n))
	}
	if n := len(d.Changed); n > 0 {
		fileParts = append(fileParts, fmt.Sprintf("修改 %d", n))
	}
	if n := len(d.Removed); n > 0 {
		fileParts = append(fileParts, fmt.Sprintf("删除 %d", n))
	}
	if len(fileParts) == 0 {
		parts = append(parts, "文件无变化")
	} else {
		parts = append(parts, "文件："+strings.Join(fileParts, " · "))
	}
	if d.NginxChanged {
		parts = append(parts, "Nginx 有改")
	} else {
		parts = append(parts, "Nginx 无改")
	}
	if d.VarsChanged {
		parts = append(parts, "变量有改")
	}
	if cur.Replacements > 0 {
		parts = append(parts, fmt.Sprintf("本次替换 %d 处", cur.Replacements))
	}
	if len(d.Added)+len(d.Changed)+len(d.Removed) == 0 && !d.NginxChanged && !d.VarsChanged {
		d.Summary = "相对上次成功部署无变化（仍会全量推送）"
	} else {
		d.Summary = strings.Join(parts, "；")
	}
	d.Added = samplePaths(d.Added, deployDiffSampleLimit)
	d.Changed = samplePaths(d.Changed, deployDiffSampleLimit)
	d.Removed = samplePaths(d.Removed, deployDiffSampleLimit)
	samples := []string{}
	samples = append(samples, trimSampleMarker(d.Added)...)
	samples = append(samples, trimSampleMarker(d.Changed)...)
	samples = append(samples, trimSampleMarker(d.Removed)...)
	if len(samples) > 0 && !d.FirstDeploy {
		if len(samples) > 4 {
			samples = append(samples[:4], "…")
		}
		d.Summary += "（" + strings.Join(samples, ", ") + "）"
	}
	return d
}

func trimSampleMarker(paths []string) []string {
	out := make([]string, 0, len(paths))
	for _, p := range paths {
		if strings.HasPrefix(p, "…") {
			continue
		}
		out = append(out, p)
	}
	return out
}

func (a *App) buildDeployDiff(s Site) (deployDiff, error) {
	cur, e := a.siteContentManifest(s)
	if e != nil {
		return deployDiff{}, e
	}
	prev, ok, e := loadDeploySnapshot(a.deploySnapshotPath(s.ID))
	if e != nil {
		return deployDiff{}, e
	}
	return diffDeploySnapshots(prev, ok, cur), nil
}

func (a *App) siteDeployPreview(w http.ResponseWriter, r *http.Request) {
	s, e := a.Store.GetSite(r.PathValue("id"))
	if e != nil {
		fail(w, 404, "站点不存在")
		return
	}
	diff, e := a.buildDeployDiff(s)
	if e != nil {
		fail(w, 400, e.Error())
		return
	}
	reply(w, 200, diff)
}

func (a *App) writeTaskManifest(taskID string, snap deploySnapshot) error {
	return writeDeploySnapshot(a.taskManifestPath(taskID), snap)
}

func (a *App) commitDeploySnapshot(siteID, taskID string) {
	if !node.ValidID(siteID) {
		return
	}
	snap, ok, e := loadDeploySnapshot(a.taskManifestPath(taskID))
	if e != nil || !ok {
		s, err := a.Store.GetSite(siteID)
		if err != nil {
			return
		}
		snap, err = a.siteContentManifest(s)
		if err != nil {
			return
		}
	}
	snap.SiteID = siteID
	snap.At = time.Now().UTC().Format(time.RFC3339)
	_ = writeDeploySnapshot(a.deploySnapshotPath(siteID), snap)
}
