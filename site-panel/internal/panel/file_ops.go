package panel

import (
	"archive/zip"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

const (
	maxZipFiles = 20000
	maxZipBytes = 8 << 30
)

func (a *App) mkdirFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	unlock := a.lockSite(id)
	defer unlock()
	var body struct {
		Path string `json:"path"`
	}
	if e := decode(w, r, &body); e != nil {
		fail(w, 400, e.Error())
		return
	}
	p := strings.Trim(strings.ReplaceAll(body.Path, "\\", "/"), "/")
	if !safePath(p) {
		fail(w, 400, "目录路径无效")
		return
	}
	root, e := a.siteRoot(id)
	if e != nil {
		fail(w, 404, "站点不存在")
		return
	}
	defer root.Close()
	if e = root.MkdirAll(p, 0700); e != nil {
		fail(w, 400, "创建目录失败")
		return
	}
	reply(w, 200, map[string]string{"path": p})
}

func (a *App) deleteFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	unlock := a.lockSite(id)
	defer unlock()
	p := r.URL.Query().Get("path")
	if !safePath(p) {
		fail(w, 400, "路径无效")
		return
	}
	root, e := a.siteRoot(id)
	if e != nil {
		fail(w, 404, "站点不存在")
		return
	}
	defer root.Close()
	st, e := root.Lstat(p)
	if e != nil {
		fail(w, 404, "路径不存在")
		return
	}
	if st.Mode()&os.ModeSymlink != 0 {
		fail(w, 400, "不支持符号链接")
		return
	}
	if st.IsDir() {
		e = root.RemoveAll(p)
	} else {
		e = root.Remove(p)
	}
	if e != nil {
		fail(w, 400, "删除失败")
		return
	}
	reply(w, 200, map[string]bool{"deleted": true})
}

func (a *App) renameFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	unlock := a.lockSite(id)
	defer unlock()
	var body struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if e := decode(w, r, &body); e != nil {
		fail(w, 400, e.Error())
		return
	}
	from := strings.Trim(strings.ReplaceAll(body.From, "\\", "/"), "/")
	to := strings.Trim(strings.ReplaceAll(body.To, "\\", "/"), "/")
	if !safePath(from) || !safePath(to) {
		fail(w, 400, "路径无效")
		return
	}
	if from == to {
		reply(w, 200, map[string]string{"from": from, "to": to})
		return
	}
	root, e := a.siteRoot(id)
	if e != nil {
		fail(w, 404, "站点不存在")
		return
	}
	defer root.Close()
	if _, e = root.Lstat(from); e != nil {
		fail(w, 404, "源路径不存在")
		return
	}
	if _, e = root.Lstat(to); e == nil {
		fail(w, 409, "目标已存在")
		return
	} else if !errors.Is(e, fs.ErrNotExist) && !os.IsNotExist(e) {
		fail(w, 400, "检查目标失败")
		return
	}
	if dir := path.Dir(to); dir != "." {
		if e = root.MkdirAll(dir, 0700); e != nil {
			fail(w, 400, "创建目标目录失败")
			return
		}
	}
	if e = root.Rename(from, to); e != nil {
		fail(w, 400, "重命名失败")
		return
	}
	reply(w, 200, map[string]string{"from": from, "to": to})
}

func (a *App) downloadFile(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if p != "" && !safePath(p) {
		fail(w, 400, "路径无效")
		return
	}
	root, e := a.siteRoot(r.PathValue("id"))
	if e != nil {
		fail(w, 404, "站点不存在")
		return
	}
	defer root.Close()
	if p == "" {
		p = "."
	}
	st, e := root.Lstat(p)
	if e != nil {
		fail(w, 404, "路径不存在")
		return
	}
	if st.Mode()&os.ModeSymlink != 0 {
		fail(w, 400, "不支持符号链接")
		return
	}
	if st.IsDir() {
		name := filepath.Base(p)
		if p == "." {
			name = "site"
		}
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", "attachment; filename=\""+strings.ReplaceAll(name, "\"", "")+".zip\"")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		zw := zip.NewWriter(w)
		defer zw.Close()
		var files, bytes int64
		e = fs.WalkDir(root.FS(), p, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return err
			}
			if !info.Mode().IsRegular() {
				return errors.New("目录含有链接或特殊文件，无法打包")
			}
			files++
			bytes += info.Size()
			if files > maxZipFiles || bytes > maxZipBytes {
				return errors.New("目录过大，无法打包下载")
			}
			rel := path
			if p != "." {
				rel = strings.TrimPrefix(path, p+"/")
			}
			h, err := zip.FileInfoHeader(info)
			if err != nil {
				return err
			}
			h.Name = rel
			h.Method = zip.Deflate
			out, err := zw.CreateHeader(h)
			if err != nil {
				return err
			}
			in, err := root.Open(path)
			if err != nil {
				return err
			}
			_, err = io.Copy(out, in)
			ce := in.Close()
			return errors.Join(err, ce)
		})
		if e != nil {
			return
		}
		return
	}
	f, e := root.Open(p)
	if e != nil {
		fail(w, 404, "文件不存在")
		return
	}
	defer f.Close()
	if !st.Mode().IsRegular() {
		fail(w, 400, "只能下载普通文件或目录")
		return
	}
	name := filepath.Base(p)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+strings.ReplaceAll(name, "\"", "")+"\"")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, name, st.ModTime(), f)
}

func (a *App) unzipFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	unlock := a.lockSite(id)
	defer unlock()
	dest := strings.Trim(strings.ReplaceAll(r.URL.Query().Get("dest"), "\\", "/"), "/")
	if dest != "" && !safePath(dest) {
		fail(w, 400, "解压目录无效")
		return
	}
	root, e := a.siteRoot(id)
	if e != nil {
		fail(w, 404, "站点不存在")
		return
	}
	defer root.Close()
	r.Body = http.MaxBytesReader(w, r.Body, 2<<30)
	tmpName := ".upload-zip-" + ID() + ".zip"
	f, e := root.OpenFile(tmpName, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if e != nil {
		fail(w, 400, "创建临时压缩包失败")
		return
	}
	defer func() { _ = root.Remove(tmpName) }()
	n, e := io.Copy(f, r.Body)
	if e != nil {
		_ = f.Close()
		fail(w, 400, "读取压缩包失败")
		return
	}
	if _, e = f.Seek(0, 0); e != nil {
		_ = f.Close()
		fail(w, 400, "读取压缩包失败")
		return
	}
	zr, e := zip.NewReader(f, n)
	if e != nil {
		_ = f.Close()
		fail(w, 400, "不是有效 ZIP")
		return
	}
	var files, total int64
	for _, zf := range zr.File {
		name := strings.Trim(strings.ReplaceAll(zf.Name, "\\", "/"), "/")
		if name == "" {
			continue
		}
		if strings.HasPrefix(zf.Name, "/") || strings.ContainsRune(name, 0) {
			_ = f.Close()
			fail(w, 400, "压缩包包含非法路径")
			return
		}
		for _, part := range strings.Split(name, "/") {
			if part == "" || part == "." || part == ".." {
				_ = f.Close()
				fail(w, 400, "压缩包包含非法路径")
				return
			}
		}
		target := name
		if dest != "" {
			target = path.Join(dest, name)
		}
		if !safePath(target) {
			_ = f.Close()
			fail(w, 400, "压缩包目标路径无效")
			return
		}
		if zf.Mode()&os.ModeSymlink != 0 {
			_ = f.Close()
			fail(w, 400, "压缩包不支持符号链接")
			return
		}
		if zf.FileInfo().IsDir() {
			if e = root.MkdirAll(target, 0700); e != nil {
				_ = f.Close()
				fail(w, 400, "创建解压目录失败")
				return
			}
			continue
		}
		files++
		if files > maxZipFiles {
			_ = f.Close()
			fail(w, 400, "压缩包文件过多")
			return
		}
		total += int64(zf.UncompressedSize64)
		if total > maxZipBytes {
			_ = f.Close()
			fail(w, 400, "压缩包解压后过大")
			return
		}
		if dir := path.Dir(target); dir != "." {
			if e = root.MkdirAll(dir, 0700); e != nil {
				_ = f.Close()
				fail(w, 400, "创建解压目录失败")
				return
			}
		}
		rc, e := zf.Open()
		if e != nil {
			_ = f.Close()
			fail(w, 400, "读取压缩条目失败")
			return
		}
		out, e := root.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
		if e != nil {
			_ = rc.Close()
			_ = f.Close()
			fail(w, 400, "写入解压文件失败")
			return
		}
		_, e = io.Copy(out, io.LimitReader(rc, int64(zf.UncompressedSize64)+1))
		ce1, ce2 := out.Close(), rc.Close()
		if e != nil || ce1 != nil || ce2 != nil {
			_ = f.Close()
			fail(w, 400, "写入解压文件失败")
			return
		}
	}
	_ = f.Close()
	reply(w, 200, map[string]any{"extracted": files, "dest": dest})
}

func listSiteEntries(root *os.Root) ([]map[string]any, error) {
	out := []map[string]any{}
	e := fs.WalkDir(root.FS(), ".", func(p string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if p == "." {
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			return errors.New("不支持符号链接")
		}
		if len(out) >= 20000 {
			return errors.New("文件过多")
		}
		if d.IsDir() {
			out = append(out, map[string]any{"path": p, "size": 0, "dir": true})
			return nil
		}
		st, e := d.Info()
		if e != nil {
			return e
		}
		out = append(out, map[string]any{"path": p, "size": st.Size(), "dir": false})
		return nil
	})
	return out, e
}
