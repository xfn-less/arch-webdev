#!/bin/sh
# Install/update Site Panel master on Debian 12 (loopback + reverse proxy in front).
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
BIN=${BIN:-$ROOT/bin/site-panel}
NODE_BIN=${NODE_BIN:-$ROOT/bin/site-panel-node}
PREFIX=${PREFIX:-/usr/local}
DATA=${DATA:-/var/lib/site-panel}

if [ ! -x "$BIN" ]; then
  echo "missing $BIN — run ./scripts/build.sh first" >&2
  exit 1
fi
if [ "$(id -u)" != 0 ]; then
  echo "need root" >&2
  exit 1
fi

useradd --system --home "$DATA" --shell /usr/sbin/nologin site-panel 2>/dev/null || true
mkdir -p "$DATA/data" "$PREFIX/libexec"
install -m 755 "$BIN" "$PREFIX/bin/site-panel"
if [ -x "$NODE_BIN" ]; then
  install -m 755 "$NODE_BIN" "$PREFIX/libexec/site-panel-node"
fi
install -m 644 "$ROOT/deploy/site-panel.service" /etc/systemd/system/site-panel.service
chown -R site-panel:site-panel "$DATA"
chmod 700 "$DATA" "$DATA/data"
if [ ! -f "$DATA/id_ed25519" ]; then
  ssh-keygen -t ed25519 -N "" -f "$DATA/id_ed25519" -C site-panel-master
fi
chown site-panel:site-panel "$DATA/id_ed25519" "$DATA/id_ed25519.pub"
chmod 600 "$DATA/id_ed25519"
chmod 644 "$DATA/id_ed25519.pub"
systemctl daemon-reload
systemctl enable site-panel
systemctl restart site-panel
sleep 0.5
ss -lntp | grep -F 127.0.0.1:8090 || {
  echo "panel not listening on 127.0.0.1:8090" >&2
  systemctl --no-pager --full status site-panel || true
  exit 1
}
echo "OK: site-panel on 127.0.0.1:8090 (put HTTPS reverse proxy in front; see deploy/nginx-panel.conf.example)"
