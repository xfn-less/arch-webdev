#!/bin/sh
# Migrate Site Panel master data from this machine to a remote master.
# Path: SQLite snapshot → remote backup → replace data → keep server SSH key
# → push that pubkey to nodes → verify counts + SSH from master.
#
# Usage:
#   ./scripts/migrate-master.sh root@45.194.37.198
# Env:
#   DATA=./data
#   REMOTE_DATA=/var/lib/site-panel
#   NODE_SSH_KEY=~/.ssh/id_ed25519   current key that can reach nodes
#   SKIP_NODE_KEYS=1
#   SKIP_BINARY=1
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TARGET=${1:-}
LOCAL_DATA=${DATA:-$ROOT/data}
REMOTE_HOME=${REMOTE_DATA:-/var/lib/site-panel}
NODE_SSH_KEY=${NODE_SSH_KEY:-$HOME/.ssh/id_ed25519}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK=${TMPDIR:-/tmp}/site-panel-migrate-$STAMP

die() { echo "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "need $1"; }

[ -n "$TARGET" ] || die "usage: $0 root@master-host"
need ssh
need scp
need tar
need sqlite3
[ -d "$LOCAL_DATA" ] || die "local data missing: $LOCAL_DATA"
[ -f "$LOCAL_DATA/panel.db" ] || die "missing $LOCAL_DATA/panel.db"
[ -f "$LOCAL_DATA/master.key" ] || die "missing $LOCAL_DATA/master.key (node passwords sealed with it)"
[ -f "$ROOT/deploy/site-panel.service" ] || die "missing deploy/site-panel.service"

echo "== preflight remote $TARGET"
ssh -o BatchMode=yes -o ConnectTimeout=15 "$TARGET" 'set -e
command -v systemctl >/dev/null
command -v sqlite3 >/dev/null
id site-panel >/dev/null
test -x /usr/local/bin/site-panel
mkdir -p /var/lib/site-panel/data /var/lib/site-panel/backups
' || die "remote preflight failed"

LOCAL_NODES=$(sqlite3 "$LOCAL_DATA/panel.db" 'SELECT count(*) FROM nodes;')
LOCAL_SITES=$(sqlite3 "$LOCAL_DATA/panel.db" 'SELECT count(*) FROM sites;')
echo "== local inventory: nodes=$LOCAL_NODES sites=$LOCAL_SITES"

echo "== consistent snapshot -> $WORK"
mkdir -p "$WORK/data"
sqlite3 "$LOCAL_DATA/panel.db" ".backup '$WORK/data/panel.db'"
cp -a "$LOCAL_DATA/master.key" "$WORK/data/master.key"
for d in sites nginx-configs deploy-snapshots tasks backups; do
  if [ -d "$LOCAL_DATA/$d" ]; then
    tar -C "$LOCAL_DATA" -cf - "$d" | tar -C "$WORK/data" -xf -
  else
    mkdir -p "$WORK/data/$d"
  fi
done
sqlite3 "$WORK/data/panel.db" 'DELETE FROM session;' 2>/dev/null || true
SNAP_NODES=$(sqlite3 "$WORK/data/panel.db" 'SELECT count(*) FROM nodes;')
SNAP_SITES=$(sqlite3 "$WORK/data/panel.db" 'SELECT count(*) FROM sites;')
[ "$SNAP_NODES" = "$LOCAL_NODES" ] || die "snapshot node count mismatch"
[ "$SNAP_SITES" = "$LOCAL_SITES" ] || die "snapshot site count mismatch"
[ -s "$WORK/data/master.key" ] || die "snapshot master.key empty"
chmod 600 "$WORK/data/master.key" "$WORK/data/panel.db"

if [ "${SKIP_BINARY:-0}" != 1 ]; then
  if [ ! -x "$ROOT/bin/site-panel" ] || [ ! -x "$ROOT/bin/site-panel-node" ]; then
    die "missing binaries — run ./scripts/build.sh first (or SKIP_BINARY=1)"
  fi
  echo "== upload binaries + unit"
  scp -o BatchMode=yes \
    "$ROOT/bin/site-panel" \
    "$ROOT/bin/site-panel-node" \
    "$ROOT/deploy/site-panel.service" \
    "$TARGET:/tmp/"
fi

echo "== pack + upload snapshot"
tar -C "$WORK" -czf "$WORK/data.tgz" data
scp -o BatchMode=yes "$WORK/data.tgz" "$TARGET:/tmp/site-panel-data-$STAMP.tgz"

echo "== remote cutover"
ssh -o BatchMode=yes "$TARGET" \
  STAMP="$STAMP" REMOTE_HOME="$REMOTE_HOME" SKIP_BINARY="${SKIP_BINARY:-0}" \
  bash -s <<'REMOTE'
set -euo pipefail
DATA="$REMOTE_HOME/data"
BK="$REMOTE_HOME/backups/pre-migrate-$STAMP"
systemctl stop site-panel
mkdir -p "$REMOTE_HOME/backups"
if [ -d "$DATA" ]; then
  mkdir -p "$BK"
  if [ -f "$DATA/panel.db" ]; then
    sqlite3 "$DATA/panel.db" ".backup '$BK/panel.db'" 2>/dev/null || cp -a "$DATA/panel.db" "$BK/panel.db"
  fi
  cp -a "$DATA/master.key" "$BK/master.key" 2>/dev/null || true
  tar -C "$DATA" --exclude='panel.db-shm' --exclude='panel.db-wal' -czf "$BK/data-rest.tgz" . 2>/dev/null || true
fi
rm -rf "$DATA"
mkdir -p "$REMOTE_HOME"
tar -C "$REMOTE_HOME" -xzf "/tmp/site-panel-data-$STAMP.tgz"
if [ ! -f "$REMOTE_HOME/id_ed25519" ]; then
  ssh-keygen -t ed25519 -N "" -f "$REMOTE_HOME/id_ed25519" -C site-panel-master
fi
if [ "$SKIP_BINARY" != 1 ]; then
  install -m 755 /tmp/site-panel /usr/local/bin/site-panel
  install -m 755 /tmp/site-panel-node /usr/local/libexec/site-panel-node
  install -m 644 /tmp/site-panel.service /etc/systemd/system/site-panel.service
  systemctl daemon-reload
fi
chown -R site-panel:site-panel "$REMOTE_HOME"
chmod 700 "$REMOTE_HOME" "$DATA"
chmod 600 "$DATA/master.key" "$DATA/panel.db" "$REMOTE_HOME/id_ed25519"
chmod 644 "$REMOTE_HOME/id_ed25519.pub"
find "$DATA" -type d -exec chmod 700 {} +
find "$DATA" -type f -exec chmod 600 {} +
rm -f "$DATA/panel.db-shm" "$DATA/panel.db-wal" "$DATA/panel.lock"
touch "$DATA/panel.lock"
chown site-panel:site-panel "$DATA/panel.lock"
chmod 600 "$DATA/panel.lock"
systemctl enable site-panel >/dev/null
systemctl start site-panel
sleep 1
systemctl is-active site-panel >/dev/null
ss -lntp | grep -F 127.0.0.1:8090 >/dev/null
echo "REMOTE_COUNTS nodes=$(sqlite3 "$DATA/panel.db" 'SELECT count(*) FROM nodes;') sites=$(sqlite3 "$DATA/panel.db" 'SELECT count(*) FROM sites;')"
echo "REMOTE_PUBKEY $(cat "$REMOTE_HOME/id_ed25519.pub")"
rm -f /tmp/site-panel /tmp/site-panel-node /tmp/site-panel.service "/tmp/site-panel-data-$STAMP.tgz"
REMOTE

REMOTE_NODES=$(ssh -o BatchMode=yes "$TARGET" 'sqlite3 /var/lib/site-panel/data/panel.db "SELECT count(*) FROM nodes;"')
REMOTE_SITES=$(ssh -o BatchMode=yes "$TARGET" 'sqlite3 /var/lib/site-panel/data/panel.db "SELECT count(*) FROM sites;"')
SERVER_PUB=$(ssh -o BatchMode=yes "$TARGET" 'cat /var/lib/site-panel/id_ed25519.pub')
echo "== verify remote nodes=$REMOTE_NODES sites=$REMOTE_SITES"
[ "$REMOTE_NODES" = "$LOCAL_NODES" ] || die "remote node count $REMOTE_NODES != local $LOCAL_NODES"
[ "$REMOTE_SITES" = "$LOCAL_SITES" ] || die "remote site count $REMOTE_SITES != local $LOCAL_SITES"
[ -n "$SERVER_PUB" ] || die "missing server pubkey"

if [ "${SKIP_NODE_KEYS:-0}" = 1 ]; then
  echo "== skip node key distribute (SKIP_NODE_KEYS=1)"
  SSH_FAILS=0
else
  echo "== distribute server pubkey to nodes via $NODE_SSH_KEY"
  [ -f "$NODE_SSH_KEY" ] || die "NODE_SSH_KEY missing: $NODE_SSH_KEY"
  NODE_LIST=$WORK/nodes.txt
  REACHABLE=$WORK/nodes-reachable.txt
  : > "$REACHABLE"
  sqlite3 -separator '|' "$LOCAL_DATA/panel.db" 'SELECT host,port,username FROM nodes;' > "$NODE_LIST"
  while IFS='|' read -r host port user; do
    [ -n "$host" ] || continue
    echo "-- node $user@$host:$port"
    if ssh -i "$NODE_SSH_KEY" -p "$port" -o BatchMode=yes -o ConnectTimeout=12       -o StrictHostKeyChecking=accept-new "$user@$host"       "umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys; grep -qxF '$SERVER_PUB' ~/.ssh/authorized_keys || printf '%s\n' '$SERVER_PUB' >> ~/.ssh/authorized_keys; grep -qxF '$SERVER_PUB' ~/.ssh/authorized_keys"; then
      echo "   pubkey ok"
      printf '%s|%s|%s\n' "$host" "$port" "$user" >> "$REACHABLE"
    else
      echo "   WARN: laptop key cannot reach $host — add server pubkey manually:" >&2
      echo "          $SERVER_PUB" >&2
    fi
  done < "$NODE_LIST"

  echo "== verify SSH from master (server key only)"
  scp -o BatchMode=yes "$REACHABLE" "$TARGET:/tmp/site-panel-nodes-$STAMP.txt"
  SUMMARY=$(ssh -o BatchMode=yes "$TARGET" STAMP="$STAMP" bash -s <<'VERIFY'
set -eu
KEY=/var/lib/site-panel/id_ed25519
OK=0
BAD=0
if [ -s "/tmp/site-panel-nodes-$STAMP.txt" ]; then
  while IFS='|' read -r host port user; do
    [ -n "$host" ] || continue
    if runuser -u site-panel -- ssh -i "$KEY" -p "$port"         -o BatchMode=yes -o ConnectTimeout=12 -o StrictHostKeyChecking=accept-new         -o IdentitiesOnly=yes "$user@$host" 'echo ok' >/dev/null 2>&1; then
      echo "SSH_OK $host"
      OK=$((OK+1))
    else
      echo "SSH_FAIL $host" >&2
      BAD=$((BAD+1))
    fi
  done < "/tmp/site-panel-nodes-$STAMP.txt"
fi
rm -f "/tmp/site-panel-nodes-$STAMP.txt"
echo "SSH_SUMMARY ok=$OK fail=$BAD"
VERIFY
)
  echo "$SUMMARY"
  SSH_FAILS=$(printf '%s\n' "$SUMMARY" | awk '/^SSH_SUMMARY / { for (i=1;i<=NF;i++) if ($i ~ /^fail=/) { sub(/^fail=/,"",$i); print $i } }' | tail -1)
  SSH_FAILS=${SSH_FAILS:-0}
  TOTAL_N=$(wc -l < "$NODE_LIST" | tr -d ' ')
  REACH_N=$(wc -l < "$REACHABLE" | tr -d ' ')
  if [ "$REACH_N" -lt "$TOTAL_N" ]; then
    echo "WARN: pubkey installed on $REACH_N/$TOTAL_N nodes" >&2
  fi
fi

rm -rf "$WORK"
echo "OK: data migrated to $TARGET (nodes=$REMOTE_NODES sites=$REMOTE_SITES)"
echo "Login password = local data account password"
echo "Server node key: $SERVER_PUB"
echo "Remote backup: $REMOTE_HOME/backups/pre-migrate-$STAMP"
if [ "${SSH_FAILS:-0}" != 0 ]; then
  echo "WARN: $SSH_FAILS node(s) still not reachable with server key" >&2
  exit 2
fi
