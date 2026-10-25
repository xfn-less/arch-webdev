package panel

import (
	"archive/tar"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"sort"
	"strings"
	"unicode/utf8"
)

const maxVarReplaceBytes = 2 << 20

func (a *App) putSiteVars(w http.ResponseWriter, r *http.Request) {
	current, e := a.Store.GetSite(r.PathValue("id"))
	if e != nil {
		fail(w, 404, "站点不存在")
		return
	}
	var body struct {
		Vars map[string]string `json:"vars"`
	}
	if e = decode(w, r, &body); e != nil {
		fail(w, 400, e.Error())
		return
	}
	clean, e := normalizeVars(body.Vars)
	if e != nil {
		fail(w, 400, e.Error())
		return
	}
	if clean == nil {
		clean = map[string]string{}
	}
	current.Vars = clean
	if e = a.Store.UpdateSite(current); e != nil {
		fail(w, 500, "保存变量失败")
		return
	}
	reply(w, 200, current)
}

func applyVars(content string, vars map[string]string) (string, int) {
	if len(vars) == 0 {
		return content, 0
	}
	keys := make([]string, 0, len(vars))
	for k := range vars {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return len(keys[i]) > len(keys[j]) })
	replaced := 0
	out := content
	for _, k := range keys {
		needle := "{{" + k + "}}"
		count := strings.Count(out, needle)
		if count == 0 {
			continue
		}
		out = strings.ReplaceAll(out, needle, vars[k])
		replaced += count
	}
	return out, replaced
}

func shouldReplaceVars(path string, b []byte) bool {
	if len(b) == 0 || len(b) > maxVarReplaceBytes {
		return false
	}
	if !utf8.Valid(b) || strings.ContainsRune(string(b), 0) {
		return false
	}
	lower := strings.ToLower(path)
	for _, ext := range []string{".apk", ".ipa", ".zip", ".gz", ".tgz", ".7z", ".rar", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".mp4", ".mp3", ".wasm", ".bin", ".exe", ".dll", ".so"} {
		if strings.HasSuffix(lower, ext) {
			return false
		}
	}
	return true
}

// bundleWithVars packs the site tree; text files get {{VAR}} replaced for the deploy package only.
func (a *App) bundleWithVars(id, dest string, vars map[string]string) (string, int, error) {
	root, e := a.siteRoot(id)
	if e != nil {
		return "", 0, e
	}
	defer root.Close()
	f, e := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return "", 0, e
	}
	hash := sha256.New()
	tw := tar.NewWriter(io.MultiWriter(f, hash))
	replacements := 0
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
		if int64(len(raw)) != st.Size() && st.Size() <= 8<<30 {
			// size changed mid-read; still pack what we got unless truncated by limit
		}
		if len(raw) > 8<<30 {
			return errors.New("单文件过大")
		}
		body := raw
		if shouldReplaceVars(p, raw) {
			text, n := applyVars(string(raw), vars)
			if n > 0 {
				body = []byte(text)
				replacements += n
			}
		}
		h := &tar.Header{Name: p, Mode: 0644, Size: int64(len(body)), Typeflag: tar.TypeReg}
		if e = tw.WriteHeader(h); e != nil {
			return e
		}
		_, e = tw.Write(body)
		return e
	})
	ce := tw.Close()
	if e == nil {
		e = ce
	}
	if e == nil {
		e = f.Sync()
	}
	ce = f.Close()
	if e == nil {
		e = ce
	}
	return hex.EncodeToString(hash.Sum(nil)), replacements, e
}

