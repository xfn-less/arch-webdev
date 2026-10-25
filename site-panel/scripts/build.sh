#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v go >/dev/null 2>&1; then
  export PATH="$HOME/.local/share/site-panel-toolchain/go/bin:$PATH"
fi
command -v go >/dev/null || { echo 'Go 1.26+ is required'; exit 1; }
mkdir -p bin
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o bin/site-panel-node ./cmd/node
CGO_ENABLED=0 go build -trimpath -o bin/site-panel ./cmd/panel
CGO_ENABLED=0 go build -trimpath -o bin/import-static ./cmd/import-static
CGO_ENABLED=0 go build -trimpath -o bin/import-certificate ./cmd/import-certificate
