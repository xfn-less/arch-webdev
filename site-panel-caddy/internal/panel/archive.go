package panel

import (
	"archive/tar"
	"archive/zip"
	"compress/bzip2"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
)

type archiveEntry struct {
	Name string
	Dir  bool
	Mode os.FileMode
	Size int64
	Open func() (io.ReadCloser, error)
}

func archiveBaseName(name string) string {
	base := path.Base(strings.ReplaceAll(name, "\\", "/"))
	lower := strings.ToLower(base)
	for _, suf := range []string{".tar.gz", ".tar.bz2", ".tgz", ".tbz2", ".tar", ".zip"} {
		if strings.HasSuffix(lower, suf) {
			base = base[:len(base)-len(suf)]
			break
		}
	}
	base = strings.TrimSpace(base)
	if base == "" || base == "." || base == ".." || strings.Contains(base, "/") {
		return "upload"
	}
	return base
}

func detectArchiveKind(name string, head []byte) string {
	lower := strings.ToLower(strings.ReplaceAll(name, "\\", "/"))
	switch {
	case strings.HasSuffix(lower, ".zip"):
		return "zip"
	case strings.HasSuffix(lower, ".tar.gz"), strings.HasSuffix(lower, ".tgz"):
		return "targz"
	case strings.HasSuffix(lower, ".tar.bz2"), strings.HasSuffix(lower, ".tbz2"):
		return "tarbz2"
	case strings.HasSuffix(lower, ".tar"):
		return "tar"
	case strings.HasSuffix(lower, ".rar"), strings.HasSuffix(lower, ".7z"):
		return "unsupported"
	}
	if len(head) >= 4 && head[0] == 'P' && head[1] == 'K' {
		return "zip"
	}
	if len(head) >= 2 && head[0] == 0x1f && head[1] == 0x8b {
		return "targz"
	}
	if len(head) >= 3 && head[0] == 'B' && head[1] == 'Z' && head[2] == 'h' {
		return "tarbz2"
	}
	if len(head) >= 262 && string(head[257:262]) == "ustar" {
		return "tar"
	}
	return ""
}

func listZipEntries(r *zip.Reader) []archiveEntry {
	out := make([]archiveEntry, 0, len(r.File))
	for _, zf := range r.File {
		zf := zf
		out = append(out, archiveEntry{
			Name: zf.Name,
			Dir:  zf.FileInfo().IsDir(),
			Mode: zf.Mode(),
			Size: int64(zf.UncompressedSize64),
			Open: zf.Open,
		})
	}
	return out
}

func archiveSingleRoot(entries []archiveEntry) string {
	var root string
	hasNested := false
	for _, ent := range entries {
		name := strings.Trim(strings.ReplaceAll(ent.Name, "\\", "/"), "/")
		if name == "" {
			continue
		}
		parts := strings.Split(name, "/")
		if parts[0] == "" || parts[0] == "." || parts[0] == ".." {
			return ""
		}
		if root == "" {
			root = parts[0]
		} else if root != parts[0] {
			return ""
		}
		if name != root && strings.HasPrefix(name, root+"/") {
			hasNested = true
		}
	}
	if root == "" || !hasNested {
		return ""
	}
	return root
}

func normalizeArchiveName(name, stripRoot string) (string, error) {
	name = strings.Trim(strings.ReplaceAll(name, "\\", "/"), "/")
	if name == "" {
		return "", nil
	}
	if strings.HasPrefix(name, "/") || strings.ContainsRune(name, 0) {
		return "", errors.New("压缩包包含非法路径")
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." {
			return "", errors.New("压缩包包含非法路径")
		}
	}
	if stripRoot != "" {
		if name == stripRoot {
			return "", nil
		}
		if strings.HasPrefix(name, stripRoot+"/") {
			name = strings.TrimPrefix(name, stripRoot+"/")
		}
	}
	return name, nil
}

func writeArchiveFile(root *os.Root, target string, size int64, rc io.Reader) error {
	if dir := path.Dir(target); dir != "." {
		if e := root.MkdirAll(dir, 0700); e != nil {
			return errors.New("创建解压目录失败")
		}
	}
	out, e := root.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if e != nil {
		return errors.New("写入解压文件失败")
	}
	_, e = io.Copy(out, io.LimitReader(rc, size+1))
	if ce := out.Close(); e == nil {
		e = ce
	}
	if e != nil {
		return errors.New("写入解压文件失败")
	}
	return nil
}

func extractArchiveEntries(root *os.Root, entries []archiveEntry, dest string) (files int64, stripped string, err error) {
	stripRoot := archiveSingleRoot(entries)
	var total int64
	for _, ent := range entries {
		name, e := normalizeArchiveName(ent.Name, stripRoot)
		if e != nil {
			return 0, "", e
		}
		if name == "" {
			continue
		}
		target := name
		if dest != "" {
			target = path.Join(dest, name)
		}
		if !safePath(target) {
			return 0, "", errors.New("压缩包目标路径无效")
		}
		if ent.Mode&os.ModeSymlink != 0 {
			return 0, "", errors.New("压缩包不支持符号链接")
		}
		if ent.Dir {
			if e = root.MkdirAll(target, 0700); e != nil {
				return 0, "", errors.New("创建解压目录失败")
			}
			continue
		}
		files++
		if files > maxZipFiles {
			return 0, "", errors.New("压缩包文件过多")
		}
		total += ent.Size
		if total > maxZipBytes {
			return 0, "", errors.New("压缩包解压后过大")
		}
		rc, e := ent.Open()
		if e != nil {
			return 0, "", errors.New("读取压缩条目失败")
		}
		e = writeArchiveFile(root, target, ent.Size, rc)
		_ = rc.Close()
		if e != nil {
			return 0, "", e
		}
	}
	return files, stripRoot, nil
}

func tarNames(r io.Reader) ([]string, error) {
	tr := tar.NewReader(r)
	var names []string
	for {
		h, e := tr.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			return nil, e
		}
		switch h.Typeflag {
		case tar.TypeReg, tar.TypeDir, tar.TypeGNUSparse:
			names = append(names, h.Name)
		case tar.TypeSymlink, tar.TypeLink:
			return nil, errors.New("压缩包不支持符号链接")
		}
	}
	return names, nil
}

func extractTarStream(root *os.Root, r io.Reader, dest, stripRoot string) (files int64, err error) {
	tr := tar.NewReader(r)
	var total int64
	for {
		h, e := tr.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			return 0, e
		}
		switch h.Typeflag {
		case tar.TypeReg, tar.TypeDir, tar.TypeGNUSparse:
		default:
			if h.Typeflag == tar.TypeSymlink || h.Typeflag == tar.TypeLink {
				return 0, errors.New("压缩包不支持符号链接")
			}
			continue
		}
		name, e := normalizeArchiveName(h.Name, stripRoot)
		if e != nil {
			return 0, e
		}
		if name == "" {
			continue
		}
		target := name
		if dest != "" {
			target = path.Join(dest, name)
		}
		if !safePath(target) {
			return 0, errors.New("压缩包目标路径无效")
		}
		isDir := h.Typeflag == tar.TypeDir || strings.HasSuffix(h.Name, "/")
		if isDir {
			if e = root.MkdirAll(target, 0700); e != nil {
				return 0, errors.New("创建解压目录失败")
			}
			continue
		}
		files++
		if files > maxZipFiles {
			return 0, errors.New("压缩包文件过多")
		}
		total += h.Size
		if total > maxZipBytes {
			return 0, errors.New("压缩包解压后过大")
		}
		if e = writeArchiveFile(root, target, h.Size, tr); e != nil {
			return 0, e
		}
	}
	return files, nil
}

func openTarReader(kind string, f *os.File) (io.ReadCloser, error) {
	if _, e := f.Seek(0, 0); e != nil {
		return nil, e
	}
	switch kind {
	case "targz":
		gz, e := gzip.NewReader(f)
		if e != nil {
			return nil, errors.New("不是有效 tar.gz")
		}
		return gz, nil
	case "tarbz2":
		return io.NopCloser(bzip2.NewReader(f)), nil
	case "tar":
		return io.NopCloser(f), nil
	default:
		return nil, errors.New("不是有效 tar")
	}
}

func extractUploadedArchive(root *os.Root, filename string, f *os.File, n int64, dest string) (files int64, stripped, kind string, err error) {
	head := make([]byte, 512)
	hn, _ := f.ReadAt(head, 0)
	head = head[:hn]
	kind = detectArchiveKind(filename, head)
	switch kind {
	case "zip":
		zr, e := zip.NewReader(f, n)
		if e != nil {
			return 0, "", "", errors.New("不是有效 ZIP")
		}
		files, stripped, e = extractArchiveEntries(root, listZipEntries(zr), dest)
		return files, stripped, "zip", e
	case "targz", "tarbz2", "tar":
		label := map[string]string{"targz": "tar.gz", "tarbz2": "tar.bz2", "tar": "tar"}[kind]
		pass1, e := openTarReader(kind, f)
		if e != nil {
			return 0, "", "", e
		}
		names, e := tarNames(pass1)
		_ = pass1.Close()
		if e != nil {
			return 0, "", "", fmt.Errorf("读取 %s 失败: %w", label, e)
		}
		entries := make([]archiveEntry, 0, len(names))
		for _, name := range names {
			entries = append(entries, archiveEntry{Name: name})
		}
		stripped = archiveSingleRoot(entries)
		pass2, e := openTarReader(kind, f)
		if e != nil {
			return 0, "", "", e
		}
		defer pass2.Close()
		files, e = extractTarStream(root, pass2, dest, stripped)
		if e != nil {
			return 0, "", "", fmt.Errorf("解压 %s 失败: %w", label, e)
		}
		return files, stripped, label, nil
	case "unsupported":
		return 0, "", "", errors.New("暂不支持 rar/7z，请用 zip / tar.gz / tar")
	default:
		return 0, "", "", errors.New("无法识别压缩格式，请用 zip / tar.gz / tar / tar.bz2")
	}
}
