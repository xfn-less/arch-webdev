#!/bin/sh
# Backup Site Panel master to Cloudflare R2 (encrypted with age).
#
# KINDS:
#   meta  = panel.db + master.key + nginx-configs + deploy-snapshots + ssh key
#   sites = per-site packs under data/sites/<id>/ (only changed sites upload)
#   full  = meta + all sites (manual/emergency)
#
# Unchanged fingerprints are skipped unless FORCE=1.
# Retention defaults: meta 12 hourly; sites 3 daily; no weekly force.
#
# Required env (or /etc/site-panel/backup.env):
#   AGE_RECIPIENT=age1...
#   RCLONE_REMOTE=r2:site-panel
# Optional:
#   KIND=meta|sites|full
#   FORCE=1
#   PANEL_HOME=/var/lib/site-panel
#   KEEP_HOURLY=12 KEEP_DAILY=3
#   INCLUDE_TASKS=0
#   LOCAL_ONLY=1 OUT=/path
#   ENV_FILE=/etc/site-panel/backup.env
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
DATA=${DATA:-$PANEL_HOME/data}
STATE_DIR=${STATE_DIR:-$PANEL_HOME/backup-state}
KIND=${KIND:-meta}
AGE_RECIPIENT=${AGE_RECIPIENT:-}
RCLONE_REMOTE=${RCLONE_REMOTE:-}
KEEP_HOURLY=${KEEP_HOURLY:-12}
KEEP_DAILY=${KEEP_DAILY:-3}
INCLUDE_TASKS=${INCLUDE_TASKS:-0}
LOCAL_ONLY=${LOCAL_ONLY:-0}
FORCE=${FORCE:-0}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK=${TMPDIR:-/tmp}/site-panel-backup-$KIND-$STAMP

die() { echo "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "need $1"; }

case "$KIND" in
  meta|sites|full) ;;
  *) die "KIND must be meta|sites|full (got $KIND)" ;;
esac

need tar
need sqlite3
need age
need sha256sum
need find
need sort
[ -d "$DATA" ] || die "data dir missing: $DATA"
[ -f "$DATA/panel.db" ] || die "missing $DATA/panel.db"
[ -f "$DATA/master.key" ] || die "missing $DATA/master.key"
[ -n "$AGE_RECIPIENT" ] || die "set AGE_RECIPIENT (age public key)"
if [ "$LOCAL_ONLY" != 1 ]; then
  need rclone
  [ -n "$RCLONE_REMOTE" ] || die "set RCLONE_REMOTE (e.g. r2:site-panel)"
fi

mkdir -p "$STATE_DIR" "$STATE_DIR/sites" "$WORK"
chmod 700 "$STATE_DIR" "$STATE_DIR/sites"

hash_tree() {
  root=$1
  rel=$2
  if [ ! -d "$root" ]; then
    printf 'MISSING %s\n' "$rel"
    return 0
  fi
  (
    cd "$root" || exit 1
    find . -type f -print | sed 's|^\./||' | sort | while IFS= read -r f; do
      [ -n "$f" ] || continue
      sum=$(sha256sum -- "$f" | awk '{print $1}')
      printf '%s  %s/%s\n' "$sum" "$rel" "$f"
    done
  )
}

fingerprint_meta() {
  {
    echo "kind=meta"
    sqlite3 "$DATA/panel.db" .dump
    sha256sum -- "$DATA/master.key"
    hash_tree "$DATA/nginx-configs" nginx-configs
    hash_tree "$DATA/deploy-snapshots" deploy-snapshots
    if [ -f "$PANEL_HOME/id_ed25519" ]; then
      sha256sum -- "$PANEL_HOME/id_ed25519"
      [ -f "$PANEL_HOME/id_ed25519.pub" ] && sha256sum -- "$PANEL_HOME/id_ed25519.pub"
    else
      echo "NO_SSH_KEY"
    fi
  } | sha256sum | awk '{print $1}'
}

fingerprint_site() {
  sid=$1
  {
    echo "kind=site"
    echo "id=$sid"
    hash_tree "$DATA/sites/$sid" "sites/$sid"
  } | sha256sum | awk '{print $1}'
}

list_site_ids() {
  # Prefer directories that exist; also include DB ids so empty new sites get a pack.
  {
    if [ -d "$DATA/sites" ]; then
      find "$DATA/sites" -mindepth 1 -maxdepth 1 -type d -printf '%f\n'
    fi
    sqlite3 "$DATA/panel.db" 'SELECT id FROM sites;'
  } | sort -u
}

encrypt_dir() {
  # encrypt_dir <srcdir> <outfile>
  tar -C "$1" -cf - . | age -r "$AGE_RECIPIENT" -o "$2"
}

prune_prefix() {
  prefix=$1
  keep=$2
  remote_base=${RCLONE_REMOTE%/}
  list=$(rclone lsf --files-only "${remote_base}/${prefix}/" --s3-no-check-bucket 2>/dev/null | sort -r || true)
  n=0
  printf '%s\n' "$list" | while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
      latest.tar.age) continue ;;
    esac
    n=$((n + 1))
    if [ "$n" -gt "$keep" ]; then
      echo "prune ${prefix}/$f"
      rclone deletefile "${remote_base}/${prefix}/$f" --s3-no-check-bucket || true
    fi
  done
}

upload_or_local() {
  # upload_or_local <local-age-file> <remote-relpath-without-latest> <latest-relpath>
  local_file=$1
  remote_hist=$2
  remote_latest=$3
  remote_base=${RCLONE_REMOTE%/}
  if [ "$LOCAL_ONLY" = 1 ]; then
    OUT=${OUT:-$ROOT/tmp-backups}
    mkdir -p "$OUT/$(dirname "$remote_hist")" "$OUT/$(dirname "$remote_latest")"
    cp -a "$local_file" "$OUT/$remote_hist"
    cp -a "$local_file" "$OUT/$remote_latest"
    echo "local $OUT/$remote_hist"
  else
    rclone copyto "$local_file" "${remote_base}/${remote_hist}" --s3-no-check-bucket
    rclone copyto "$local_file" "${remote_base}/${remote_latest}" --s3-no-check-bucket
    echo "remote ${remote_base}/${remote_hist}"
  fi
}

backup_meta() {
  FP=$(fingerprint_meta)
  FP_FILE=$STATE_DIR/meta.fingerprint
  echo "fingerprint=$FP"
  if [ "$FORCE" != 1 ] && [ -f "$FP_FILE" ] && [ "$(cat "$FP_FILE")" = "$FP" ]; then
    echo "skip meta: unchanged"
    return 0
  fi

  B=$WORK/meta
  rm -rf "$B"
  mkdir -p "$B/data"
  sqlite3 "$DATA/panel.db" ".backup '$B/data/panel.db'"
  cp -a "$DATA/master.key" "$B/data/master.key"
  for d in nginx-configs deploy-snapshots; do
    if [ -d "$DATA/$d" ]; then
      tar -C "$DATA" -cf - "$d" | tar -C "$B/data" -xf -
    else
      mkdir -p "$B/data/$d"
    fi
  done
  mkdir -p "$B/data/sites" "$B/data/tasks" "$B/data/backups"
  if [ -f "$PANEL_HOME/id_ed25519" ]; then
    cp -a "$PANEL_HOME/id_ed25519" "$B/id_ed25519"
    [ -f "$PANEL_HOME/id_ed25519.pub" ] && cp -a "$PANEL_HOME/id_ed25519.pub" "$B/id_ed25519.pub"
  fi
  NODES=$(sqlite3 "$B/data/panel.db" 'SELECT count(*) FROM nodes;')
  SITES=$(sqlite3 "$B/data/panel.db" 'SELECT count(*) FROM sites;')
  {
    echo "kind=meta"
    echo "stamp=$STAMP"
    echo "nodes=$NODES"
    echo "sites=$SITES"
    echo "fingerprint=$FP"
  } > "$B/MANIFEST.txt"
  chmod 600 "$B/data/master.key" "$B/data/panel.db"
  [ -f "$B/id_ed25519" ] && chmod 600 "$B/id_ed25519"

  NAME="site-panel-meta-${STAMP}-n${NODES}-s${SITES}.tar.age"
  echo "== encrypt meta $NAME"
  encrypt_dir "$B" "$WORK/$NAME"
  SIZE=$(wc -c < "$WORK/$NAME" | tr -d ' ')
  echo "encrypted_bytes=$SIZE"
  upload_or_local "$WORK/$NAME" "meta/hourly/$NAME" "meta/latest.tar.age"
  if [ "$LOCAL_ONLY" != 1 ]; then
    prune_prefix meta/hourly "$KEEP_HOURLY"
  fi
  printf '%s\n' "$FP" > "$FP_FILE"
  printf '%s\n' "meta/hourly/$NAME" > "$STATE_DIR/meta.last-object"
  chmod 600 "$FP_FILE" "$STATE_DIR/meta.last-object"
  echo "OK: meta nodes=$NODES sites=$SITES size=$SIZE"
}

backup_one_site() {
  sid=$1
  FP=$(fingerprint_site "$sid")
  FP_FILE=$STATE_DIR/sites/$sid.fingerprint
  echo "-- site $sid fingerprint=$FP"
  if [ "$FORCE" != 1 ] && [ -f "$FP_FILE" ] && [ "$(cat "$FP_FILE")" = "$FP" ]; then
    echo "   skip unchanged"
    return 0
  fi

  B=$WORK/site-$sid
  rm -rf "$B"
  mkdir -p "$B/data/sites"
  if [ -d "$DATA/sites/$sid" ]; then
    tar -C "$DATA/sites" -cf - "$sid" | tar -C "$B/data/sites" -xf -
  else
    mkdir -p "$B/data/sites/$sid"
  fi
  {
    echo "kind=site"
    echo "site_id=$sid"
    echo "stamp=$STAMP"
    echo "fingerprint=$FP"
  } > "$B/MANIFEST.txt"

  NAME="site-${sid}-${STAMP}.tar.age"
  echo "   encrypt $NAME"
  encrypt_dir "$B" "$WORK/$NAME"
  SIZE=$(wc -c < "$WORK/$NAME" | tr -d ' ')
  echo "   encrypted_bytes=$SIZE"
  upload_or_local "$WORK/$NAME" "sites/$sid/daily/$NAME" "sites/$sid/latest.tar.age"
  if [ "$LOCAL_ONLY" != 1 ]; then
    prune_prefix "sites/$sid/daily" "$KEEP_DAILY"
  fi
  printf '%s\n' "$FP" > "$FP_FILE"
  printf '%s\n' "sites/$sid/daily/$NAME" > "$STATE_DIR/sites/$sid.last-object"
  chmod 600 "$FP_FILE" "$STATE_DIR/sites/$sid.last-object"
  UPLOADED=$((UPLOADED + 1))
  echo "   OK site=$sid size=$SIZE"
}

backup_sites() {
  UPLOADED=0
  SKIPPED=0
  TOTAL=0
  # subshell-safe counters via temp files
  up=$WORK/up.count
  sk=$WORK/sk.count
  tot=$WORK/tot.count
  echo 0 > "$up"
  echo 0 > "$sk"
  echo 0 > "$tot"
  list_site_ids > "$WORK/site-ids.txt"
  while IFS= read -r sid; do
    [ -n "$sid" ] || continue
    echo $(($(cat "$tot") + 1)) > "$tot"
    FP=$(fingerprint_site "$sid")
    FP_FILE=$STATE_DIR/sites/$sid.fingerprint
    echo "-- site $sid fingerprint=$FP"
    if [ "$FORCE" != 1 ] && [ -f "$FP_FILE" ] && [ "$(cat "$FP_FILE")" = "$FP" ]; then
      echo "   skip unchanged"
      echo $(($(cat "$sk") + 1)) > "$sk"
      continue
    fi
    B=$WORK/site-$sid
    rm -rf "$B"
    mkdir -p "$B/data/sites"
    if [ -d "$DATA/sites/$sid" ]; then
      tar -C "$DATA/sites" -cf - "$sid" | tar -C "$B/data/sites" -xf -
    else
      mkdir -p "$B/data/sites/$sid"
    fi
    {
      echo "kind=site"
      echo "site_id=$sid"
      echo "stamp=$STAMP"
      echo "fingerprint=$FP"
    } > "$B/MANIFEST.txt"
    NAME="site-${sid}-${STAMP}.tar.age"
    echo "   encrypt $NAME"
    encrypt_dir "$B" "$WORK/$NAME"
    SIZE=$(wc -c < "$WORK/$NAME" | tr -d ' ')
    echo "   encrypted_bytes=$SIZE"
    upload_or_local "$WORK/$NAME" "sites/$sid/daily/$NAME" "sites/$sid/latest.tar.age"
    if [ "$LOCAL_ONLY" != 1 ]; then
      prune_prefix "sites/$sid/daily" "$KEEP_DAILY"
    fi
    printf '%s\n' "$FP" > "$FP_FILE"
    printf '%s\n' "sites/$sid/daily/$NAME" > "$STATE_DIR/sites/$sid.last-object"
    chmod 600 "$FP_FILE" "$STATE_DIR/sites/$sid.last-object"
    echo $(($(cat "$up") + 1)) > "$up"
    echo "   OK site=$sid size=$SIZE"
  done < "$WORK/site-ids.txt"

  # Drop state for removed sites (best-effort; remote prune optional)
  if [ -d "$STATE_DIR/sites" ]; then
    for f in "$STATE_DIR/sites"/*.fingerprint; do
      [ -f "$f" ] || continue
      sid=$(basename "$f" .fingerprint)
      if ! grep -qxF "$sid" "$WORK/site-ids.txt"; then
        echo "forget removed site state $sid"
        rm -f "$STATE_DIR/sites/$sid.fingerprint" "$STATE_DIR/sites/$sid.last-object"
      fi
    done
  fi

  echo "OK: sites uploaded=$(cat "$up") skipped=$(cat "$sk") total=$(cat "$tot")"
}

backup_full() {
  # Emergency whole-tree pack (still no tasks by default).
  FP_META=$(fingerprint_meta)
  {
    echo "kind=full"
    echo "meta=$FP_META"
    list_site_ids | while IFS= read -r sid; do
      [ -n "$sid" ] || continue
      echo "site.$sid=$(fingerprint_site "$sid")"
    done
  } | sha256sum | awk '{print $1}' > "$WORK/full.fp"
  FP=$(cat "$WORK/full.fp")
  FP_FILE=$STATE_DIR/full.fingerprint
  echo "fingerprint=$FP"
  if [ "$FORCE" != 1 ] && [ -f "$FP_FILE" ] && [ "$(cat "$FP_FILE")" = "$FP" ]; then
    echo "skip full: unchanged"
    return 0
  fi

  B=$WORK/full
  rm -rf "$B"
  mkdir -p "$B/data"
  sqlite3 "$DATA/panel.db" ".backup '$B/data/panel.db'"
  cp -a "$DATA/master.key" "$B/data/master.key"
  for d in nginx-configs deploy-snapshots sites; do
    if [ -d "$DATA/$d" ]; then
      tar -C "$DATA" -cf - "$d" | tar -C "$B/data" -xf -
    else
      mkdir -p "$B/data/$d"
    fi
  done
  if [ "$INCLUDE_TASKS" = 1 ] && [ -d "$DATA/tasks" ]; then
    tar -C "$DATA" -cf - tasks | tar -C "$B/data" -xf -
  else
    mkdir -p "$B/data/tasks"
  fi
  mkdir -p "$B/data/backups"
  if [ -f "$PANEL_HOME/id_ed25519" ]; then
    cp -a "$PANEL_HOME/id_ed25519" "$B/id_ed25519"
    [ -f "$PANEL_HOME/id_ed25519.pub" ] && cp -a "$PANEL_HOME/id_ed25519.pub" "$B/id_ed25519.pub"
  fi
  NODES=$(sqlite3 "$B/data/panel.db" 'SELECT count(*) FROM nodes;')
  SITES=$(sqlite3 "$B/data/panel.db" 'SELECT count(*) FROM sites;')
  {
    echo "kind=full"
    echo "stamp=$STAMP"
    echo "nodes=$NODES"
    echo "sites=$SITES"
    echo "fingerprint=$FP"
  } > "$B/MANIFEST.txt"
  NAME="site-panel-full-${STAMP}-n${NODES}-s${SITES}.tar.age"
  encrypt_dir "$B" "$WORK/$NAME"
  upload_or_local "$WORK/$NAME" "full/$NAME" "full/latest.tar.age"
  if [ "$LOCAL_ONLY" != 1 ]; then
    prune_prefix full "$KEEP_DAILY"
  fi
  printf '%s\n' "$FP" > "$FP_FILE"
  chmod 600 "$FP_FILE"
  echo "OK: full nodes=$NODES sites=$SITES"
}

case "$KIND" in
  meta) backup_meta ;;
  sites) backup_sites ;;
  full) backup_full ;;
esac

rm -rf "$WORK"
