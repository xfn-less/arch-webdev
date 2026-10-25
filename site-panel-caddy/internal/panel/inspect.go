package panel

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"sort"

	"site-panel/internal/node"
)

func (a *App) siteInspect(w http.ResponseWriter, r *http.Request) {
	s, e := a.Store.GetSite(r.PathValue("id"))
	if e != nil {
		fail(w, 404, "站点不存在")
		return
	}
	if e = a.ensurePublishDir(s.ID, s.PublishPath); e != nil {
		fail(w, 500, e.Error())
		return
	}
	caddy, source, e := a.siteNginxText(s)
	if e != nil {
		fail(w, 400, e.Error())
		return
	}
	spec, e := encodeSiteSpec(s.Site, s.Enabled, s.Vars, s.PublishPath)
	if e != nil {
		fail(w, 500, e.Error())
		return
	}
	var specObj any
	_ = json.Unmarshal(spec, &specObj)
	snap, ok, e := loadDeploySnapshot(a.deploySnapshotPath(s.ID))
	if e != nil {
		fail(w, 500, e.Error())
		return
	}
	var snapObj any
	if ok {
		snapObj = snap
	}
	bundleFiles, e := a.listPublishFiles(s.ID)
	if e != nil {
		fail(w, 500, e.Error())
		return
	}
	req := node.Request{ID: "(preview)", Site: s.Site, BundleSHA256: "(deploy 时计算)", NginxConfig: ""}
	if custom, has, e := a.loadCustomNginx(s.ID); e != nil {
		fail(w, 500, e.Error())
		return
	} else if has {
		req.NginxConfig = custom
	}
	reqJSON, _ := json.MarshalIndent(req, "", "  ")
	label := s.PublishPath
	if label == "" {
		label = "(站点根目录)"
	} else {
		label += "/"
	}
	reply(w, 200, map[string]any{
		"publish_path":  s.PublishPath,
		"publish_label": label,
		"playground":    true,
		"spec":          specObj,
		"caddy":         caddy,
		"caddy_source":  source,
		"snapshot":      snapObj,
		"bundle_files":  bundleFiles,
		"request_json":  string(reqJSON),
		"snapshot_path": "deploy-snapshots/" + s.ID + ".json",
		"caddy_path":    "caddy-configs/" + s.ID + ".conf",
		"stages": []map[string]string{
			{"id": "spec", "title": "规格", "desc": "配置页保存后的站点 JSON（含 publish_path / proxies / vars）"},
			{"id": "caddy", "title": "Caddy", "desc": "由规格生成（或自定义）的最终 Caddyfile 文本"},
			{"id": "bundle", "title": "打包", "desc": "部署时从 publish_path 打进 bundle.tar 的文件列表"},
			{"id": "request", "title": "请求", "desc": "推到节点的 request.json 预览（SSH 提交用）"},
			{"id": "snapshot", "title": "快照", "desc": "上次成功部署后的内容清单，用来算 diff"},
		},
		"note": "只有 publish_path 指向的目录会打包；外层是 playground。空=整站根目录。",
	})
}

func (a *App) listPublishFiles(id string) ([]string, error) {
	root, e := a.sitePublishRoot(id)
	if e != nil {
		return nil, e
	}
	defer root.Close()
	var out []string
	e = fs.WalkDir(root.FS(), ".", func(p string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if p == "." || d.IsDir() {
			return nil
		}
		out = append(out, p)
		return nil
	})
	sort.Strings(out)
	return out, e
}
