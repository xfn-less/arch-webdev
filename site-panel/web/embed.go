package web

import "embed"

//go:embed index.html styles.css js/*.js vendor/*.js vendor/ace vendor/lucide
var Assets embed.FS
