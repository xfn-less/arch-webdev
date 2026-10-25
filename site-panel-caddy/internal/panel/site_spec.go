package panel

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"

	"site-panel/internal/node"
)

var varNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)

// storedSiteSpec keeps panel-only fields beside the node-facing site identity.
type storedSiteSpec struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	Domains     []string          `json:"domains"`
	Port        int               `json:"port"`
	Mode        string            `json:"mode,omitempty"`
	Upstreams   []string          `json:"upstreams,omitempty"`
	Proxies     []node.ProxyRoute `json:"proxies,omitempty"`
	Cert        string            `json:"cert,omitempty"`
	RedirHTTPS  *bool             `json:"redir_https,omitempty"`
	Enabled     *bool             `json:"enabled,omitempty"`
	Vars        map[string]string `json:"vars,omitempty"`
	PublishPath string            `json:"publish_path"` // empty packs sites/<id>/ root
}

func decodeSiteSpec(b []byte) (node.Site, bool, map[string]string, string, error) {
	var raw storedSiteSpec
	if e := json.Unmarshal(b, &raw); e != nil {
		return node.Site{}, true, nil, "", e
	}
	enabled := true
	if raw.Enabled != nil {
		enabled = *raw.Enabled
	}
	vars := map[string]string{}
	for k, v := range raw.Vars {
		vars[k] = v
	}
	publish, e := normalizePublishPath(raw.PublishPath)
	if e != nil {
		return node.Site{}, true, nil, "", e
	}
	// Legacy rows with no field still default to site/ so existing trees keep working.
	if raw.PublishPath == "" && publish == "" {
		// Distinguish omitted vs explicit empty: omitted JSON means default "site".
		// Explicit "" in JSON unmarshals to "" too — both look the same.
		// Prefer default "site" unless the key was present. Cheap check:
		var probe map[string]json.RawMessage
		_ = json.Unmarshal(b, &probe)
		if _, ok := probe["publish_path"]; !ok {
			publish = DefaultPublishPath
		}
	}
	return node.Site{
		ID:         raw.ID,
		Name:       raw.Name,
		Domains:    raw.Domains,
		Port:       raw.Port,
		Mode:       raw.Mode,
		Upstreams:  append([]string{}, raw.Upstreams...),
		Proxies:    append([]node.ProxyRoute{}, raw.Proxies...),
		Cert:       raw.Cert,
		RedirHTTPS: raw.RedirHTTPS,
	}, enabled, vars, publish, nil
}

func encodeSiteSpec(site node.Site, enabled bool, vars map[string]string, publishPath string) ([]byte, error) {
	en := enabled
	clean, e := normalizeVars(vars)
	if e != nil {
		return nil, e
	}
	publish, e := normalizePublishPath(publishPath)
	if e != nil {
		return nil, e
	}
	return json.Marshal(storedSiteSpec{
		ID:          site.ID,
		Name:        site.Name,
		Domains:     site.Domains,
		Port:        site.Port,
		Mode:        site.Mode,
		Upstreams:   append([]string{}, site.Upstreams...),
		Proxies:     append([]node.ProxyRoute{}, site.Proxies...),
		Cert:        site.Cert,
		RedirHTTPS:  site.RedirHTTPS,
		Enabled:     &en,
		Vars:        clean,
		PublishPath: publish,
	})
}

func normalizeVars(vars map[string]string) (map[string]string, error) {
	if len(vars) == 0 {
		return nil, nil
	}
	if len(vars) > 50 {
		return nil, errors.New("变量不能超过 50 个")
	}
	out := map[string]string{}
	for k, v := range vars {
		key := strings.TrimSpace(k)
		if !varNamePattern.MatchString(key) {
			return nil, errors.New("变量名仅允许字母数字下划线，并以字母或下划线开头")
		}
		if len(v) > 4096 {
			return nil, errors.New("变量值不能超过 4096 字符")
		}
		if strings.ContainsRune(v, 0) {
			return nil, errors.New("变量值不能包含空字节")
		}
		out[key] = v
	}
	return out, nil
}
