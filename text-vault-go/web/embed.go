package web

import (
	"embed"
	"io/fs"
)

//go:embed index.html styles.css js vendor assets
var files embed.FS

var FS fs.FS = files
