#!/bin/sh
# Restore Site Panel master from age-encrypted R2 backups.
#
# Default: latest meta + each site's latest pack.
# Usage:
#   ./scripts/restore-master.sh
#   ./scripts/restore-master.sh /path/meta-or-full.tar.age
#   KIND=full ./scripts/restore-master.sh
#   META_FILE=... ./scripts/restore-master.sh   # then pulls site packs from R2 unless SITES_ONLY local dir
#
# Required env (or /etc/site-panel/backup.env):
#   AGE_IDENTITY=/etc/site-panel/age.key
#   RCLONE_REMOTE=r2:site-panel
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
ENV_FILE=${ENV_FILE:-/etc/site-panel/backup.env}
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a
  . "$ENV_FILE"
  set +a
fi

PANEL_HOME=${PANEL_HOME:-/var/lib/site-panel}
DATA=$PANEL_HOME/data
AGE_IDENTITY=${AGE_IDENTITY:-/etc/site-panel/age.key}
RCLONE_REMOTE=${RCLONE_REMOTE:-}
KIND=${KIND:-auto}
LOCAL_FILE=${1:-}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK=${TMPDIR:-/tmp}/site-panel-restore-$STAMP

die() { echo "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "need $1"; }

need tar
need age
need sqlite3
[ -f "$AGE_IDENTITY" ] || die "missing AGE_IDENTITY: $AGE_IDENTITY"
[ -d "$PANEL_HOME" ] || die "PANEL_HOME missing: $PANEL_HOME (run install-master.sh first)"
id site-panel >/dev/null 2>&1 || die "user site-panel missing"

mkdir -p "$WORK"
remote_base=${RCLONE_REMOTE%/}

fetch_obj() {
  need rclone
  [ -n "$RCLONE_REMOTE" ] || die "set RCLONE_REMOTE or pass local files"
  echo "== download $1"
  rclone copyto "$1" "$2" --s3-no-check-bucket
}

decrypt_tar() {
  enc=$1
  out=$2
  mkdir -p "$out"
  base=$(basename "$enc" .age)
  age -d -i "$AGE_IDENTITY" -o "$WORK/$base" "$enc"
  tar -C "$out" -xf "$WORK/$base"
}

META_DIR=$WORK/meta
HAVE_META=0
HAVE_FULL=0

if [ -n "$LOCAL_FILE" ]; then
  [ -f "$LOCAL_FILE" ] || die "file not found: $LOCAL_FILE"
  echo "== using local $LOCAL_FILE"
  decrypt_tar "$LOCAL_FILE" "$META_DIR"
  HAVE_META=1
  if [ -f "$META_DIR/MANIFEST.txt" ] && grep -q '^kind=full$' "$META_DIR/MANIFEST.txt"; then
    HAVE_FULL=1
  elif [ -d "$META_DIR/data/sites" ] && [ "$(find "$META_DIR/data/sites" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')" != 0 ]; then
    # likely full-ish tree
    HAVE_FULL=1
  fi
elif [ -n "${META_FILE:-}" ]; then
  [ -f "$META_FILE" ] || die "META_FILE missing"
  decrypt_tar "$META_FILE" "$META_DIR"
  HAVE_META=1
elif [ "$KIND" = full ]; then
  fetch_obj "${remote_base}/full/latest.tar.age" "$WORK/full.tar.age"
  decrypt_tar "$WORK/full.tar.age" "$META_DIR"
  HAVE_META=1
  HAVE_FULL=1
else
  fetch_obj "${remote_base}/meta/latest.tar.age" "$WORK/meta.tar.age"
  decrypt_tar "$WORK/meta.tar.age" "$META_DIR"
  HAVE_META=1
fi

[ "$HAVE_META" = 1 ] || die "no meta backup"
[ -f "$META_DIR/data/panel.db" ] || die "meta missing data/panel.db"
[ -f "$META_DIR/data/master.key" ] || die "meta missing data/master.key"
NODES=$(sqlite3 "$META_DIR/data/panel.db" 'SELECT count(*) FROM nodes;')
SITES=$(sqlite3 "$META_DIR/data/panel.db" 'SELECT count(*) FROM sites;')
echo "== meta inventory nodes=$NODES sites=$SITES"
[ -f "$META_DIR/MANIFEST.txt" ] && cat "$META_DIR/MANIFEST.txt" || true

if [ "${SKIP_SERVICE:-0}" != 1 ]; then
  systemctl stop site-panel 2>/dev/null || true
fi

BK=$PANEL_HOME/backups/pre-restore-$STAMP
echo "== backup current tree -> $BK"
mkdir -p "$PANEL_HOME/backups" "$BK"
if [ -d "$DATA" ]; then
  if [ -f "$DATA/panel.db" ]; then
    sqlite3 "$DATA/panel.db" ".backup '$BK/panel.db'" 2>/dev/null || cp -a "$DATA/panel.db" "$BK/panel.db"
  fi
  cp -a "$DATA/master.key" "$BK/master.key" 2>/dev/null || true
  tar -C "$DATA" --exclude='panel.db-shm' --exclude='panel.db-wal' -czf "$BK/data-rest.tgz" . 2>/dev/null || true
fi
[ -f "$PANEL_HOME/id_ed25519" ] && cp -a "$PANEL_HOME/id_ed25519" "$PANEL_HOME/id_ed25519.pub" "$BK/" 2>/dev/null || true

echo "== replace data from meta"
rm -rf "$DATA"
mkdir -p "$PANEL_HOME"
cp -a "$META_DIR/data" "$DATA"
if [ -f "$META_DIR/id_ed25519" ]; then
  cp -a "$META_DIR/id_ed25519" "$PANEL_HOME/id_ed25519"
  [ -f "$META_DIR/id_ed25519.pub" ] && cp -a "$META_DIR/id_ed25519.pub" "$PANEL_HOME/id_ed25519.pub"
elif [ ! -f "$PANEL_HOME/id_ed25519" ]; then
  ssh-keygen -t ed25519 -N "" -f "$PANEL_HOME/id_ed25519" -C site-panel-master
fi

# If not a full pack, pull per-site latest packs.
if [ "$HAVE_FULL" != 1 ]; then
  mkdir -p "$DATA/sites"
  SITE_IDS=$(sqlite3 "$DATA/panel.db" 'SELECT id FROM sites;')
  for sid in $SITE_IDS; do
    if [ -n "${LOCAL_SITES_DIR:-}" ] && [ -f "$LOCAL_SITES_DIR/$sid/latest.tar.age" ]; then
      echo "== site $sid from local"
      decrypt_tar "$LOCAL_SITES_DIR/$sid/latest.tar.age" "$WORK/site-$sid"
    else
      if [ -z "$RCLONE_REMOTE" ] && [ -z "$LOCAL_FILE" ]; then
        echo "WARN: no RCLONE_REMOTE for site $sid" >&2
        continue
      fi
      if [ -n "$RCLONE_REMOTE" ]; then
        if ! rclone lsf "${remote_base}/sites/$sid/latest.tar.age" --s3-no-check-bucket >/dev/null 2>&1; then
          echo "WARN: no sites/$sid/latest.tar.age" >&2
          continue
        fi
        fetch_obj "${remote_base}/sites/$sid/latest.tar.age" "$WORK/site-$sid.tar.age"
        decrypt_tar "$WORK/site-$sid.tar.age" "$WORK/site-$sid"
      else
        echo "WARN: skip site $sid (no remote/local pack)" >&2
        continue
      fi
    fi
    if [ -d "$WORK/site-$sid/data/sites/$sid" ]; then
      rm -rf "$DATA/sites/$sid"
      mkdir -p "$DATA/sites"
      cp -a "$WORK/site-$sid/data/sites/$sid" "$DATA/sites/$sid"
      echo "   restored $sid"
    else
      echo "WARN: site pack $sid missing data/sites/$sid" >&2
    fi
  done
fi

mkdir -p "$DATA/sites" "$DATA/tasks" "$DATA/nginx-configs" "$DATA/deploy-snapshots" "$DATA/backups"
rm -f "$DATA/panel.db-shm" "$DATA/panel.db-wal" "$DATA/panel.lock"
touch "$DATA/panel.lock"
if [ ! -f "$PANEL_HOME/id_ed25519" ]; then
  ssh-keygen -t ed25519 -N "" -f "$PANEL_HOME/id_ed25519" -C site-panel-master
fi

chown -R site-panel:site-panel "$PANEL_HOME"
chmod 700 "$PANEL_HOME" "$DATA"
chmod 600 "$DATA/master.key" "$DATA/panel.db" "$PANEL_HOME/id_ed25519" "$DATA/panel.lock"
[ -f "$PANEL_HOME/id_ed25519.pub" ] && chmod 644 "$PANEL_HOME/id_ed25519.pub"
find "$DATA" -type d -exec chmod 700 {} +
find "$DATA" -type f -exec chmod 600 {} +

MISS=0
for sid in $(sqlite3 "$DATA/panel.db" 'SELECT id FROM sites;'); do
  if [ ! -d "$DATA/sites/$sid" ]; then
    echo "WARN: site $sid missing under data/sites/" >&2
    MISS=$((MISS + 1))
  fi
done

if [ "${SKIP_SERVICE:-0}" != 1 ]; then
  systemctl start site-panel
  sleep 1
  systemctl is-active site-panel >/dev/null || die "site-panel failed to start"
  ss -lntp | grep -F 127.0.0.1:8090 >/dev/null || die "not listening on 127.0.0.1:8090"
fi

GOT_N=$(sqlite3 "$DATA/panel.db" 'SELECT count(*) FROM nodes;')
GOT_S=$(sqlite3 "$DATA/panel.db" 'SELECT count(*) FROM sites;')
rm -rf "$WORK"
echo "OK: restored nodes=$GOT_N sites=$GOT_S missing_site_dirs=$MISS"
echo "SSH pubkey: $(cat "$PANEL_HOME/id_ed25519.pub")"
echo "Previous tree kept at $BK"
if [ "$MISS" != 0 ]; then
  echo "WARN: $MISS site directories missing — restore newer per-site packs" >&2
  exit 2
fi
