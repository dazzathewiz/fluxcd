#!/bin/sh
# Nightly, per database: pg_amcheck, then pg_dump -Fc, verified with
# pg_restore --list before it replaces the .tmp name. Then logs the n8n
# database's size and the volume's usage, and fails over $USAGE_LIMIT percent.
# Pings Home Assistant with the result. Never set -x: the env holds passwords and the webhook URL.
set -eu
. /scripts/lib.sh

OUT=/backup

# Reseeded from the Secret on every n8n pod start, and they hold the webhook URL
# and the redaction patterns, so their rows stay out of the dump.
N8N_EXCLUDE="--exclude-table-data=triage.alert_target --exclude-table-data=triage.redaction_patterns"

# Functions run in an `if`/`||` context, where set -e is off: every step
# checks its own status.
backup_db() { # db host password [pg_dump args]
  db=$1 dir="$OUT/$1"
  export PGHOST="$2" PGUSER="$1" PGDATABASE="$1" PGPASSWORD="$3"
  wait_ready "$2" || { echo "$db: database not reachable"; return 1; }
  shift 3
  mkdir -p "$dir" || return 1

  echo "$db: amcheck"
  pg_amcheck --install-missing --heapallindexed "$db" || { echo "$db: amcheck FAILED"; return 1; }

  name=$(dump_name "$db")
  tmp="$dir/$name.tmp"
  if ! pg_dump -Fc "$@" -f "$tmp"; then
    rm -f "$tmp"; echo "$db: pg_dump FAILED"; return 1
  fi
  if ! pg_restore --list "$tmp" >/dev/null; then
    rm -f "$tmp"; echo "$db: pg_restore --list FAILED"; return 1
  fi
  mv "$tmp" "$dir/$name" || return 1
  (cd "$dir" && sha256sum "$name" > "$name.sha256") || { echo "$db: sha256 FAILED"; return 1; }
  echo "$db: wrote $name ($(du -k "$dir/$name" | cut -f1) KiB)"

  prune "$dir" "$db" || { echo "$db: prune FAILED"; return 1; }
  echo "$db: keeping $(list_dumps "$dir" "$db" | wc -l | tr -d ' ') dumps"
}

failed=""
# shellcheck disable=SC2086
backup_db n8n n8n-db "${N8N_DB_PASSWORD:-}" $N8N_EXCLUDE || failed="$failed n8n"
backup_db inventree inventory-db "${INVENTORY_DB_PASSWORD:-}" || failed="$failed inventree"

# The n8n database and its five largest relations, to show what the dump holds.
# Logging only: a failed query doesn't fail the job.
PGHOST=n8n-db PGUSER=n8n PGDATABASE=n8n PGPASSWORD="${N8N_DB_PASSWORD:-}" psql -X -At -v ON_ERROR_STOP=1 \
  -c "SELECT 'n8n: database ' || pg_size_pretty(pg_database_size(current_database()))" \
  -c "SELECT 'n8n: ' || n.nspname || '.' || c.relname || ' ' || pg_size_pretty(pg_total_relation_size(c.oid))
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'm') ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 5" \
  || echo "n8n: size report FAILED"
unset PGPASSWORD

check_usage "$OUT" || failed="$failed backup-volume"

ok=true list=""
for db in $failed; do ok=false list="$list\"$db\","; done
body=$(printf '{"source":"pg-dump","ok":%s,"checked":"%s","failed":[%s]}' \
  "$ok" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${list%,}")

# wget's own errors can carry the URL, so they're dropped.
if ! wget -q -T 10 -O /dev/null --header 'Content-Type: application/json' \
    --post-data "$body" "${HA_HEARTBEAT_URL:-}" 2>/dev/null; then
  echo "ping to Home Assistant failed"
fi

if [ -n "$failed" ]; then
  echo "FAILED:$failed"
  exit 1
fi
echo "all databases ok"
