#!/bin/sh
# Restores the newest dump of each database into a throwaway server on a Unix
# socket, then checks row counts. Prints file names and counts only.
set -eu
. /scripts/lib.sh

IN=/backup
PGDATA=/scratch/data
SOCK=/scratch/run

mkdir -p "$SOCK"
initdb -D "$PGDATA" -U postgres -A trust >/dev/null
pg_ctl -D "$PGDATA" -l /scratch/postgres.log -w -s \
  -o "-c listen_addresses='' -c unix_socket_directories=$SOCK" start
export PGHOST="$SOCK" PGUSER=postgres

# Run in an `if`/`||` context, where set -e is off: every step checks its own
# status. Roles aren't in a dump, so ownership and grants are skipped.
restore_db() { # db
  db=$1 dir="$IN/$1"
  f=$(newest_dump "$dir" "$db") || f=""
  [ -n "$f" ] || { echo "$db: no dump found"; return 1; }
  echo "$db: $f"
  (cd "$dir" && sha256sum -c "$f.sha256" >/dev/null) || { echo "$db: sha256 mismatch or missing"; return 1; }
  createdb -T template0 "$db" || return 1
  pg_restore --no-owner --no-privileges --exit-on-error -d "$db" "$dir/$f" || { echo "$db: restore FAILED"; return 1; }
}

at_least() { # db table min
  n=$(psql -X -At -d "$1" -c "SELECT count(*) FROM $2") || { echo "$1: $2 unreadable"; return 1; }
  echo "$1: $2 = $n"
  [ "$n" -ge "$3" ] || { echo "$1: $2 below $3"; return 1; }
}

failed=""
if restore_db n8n; then
  at_least n8n workflow_entity 5 || failed="$failed n8n"
  at_least n8n triage.runs 1 || failed="$failed n8n"
else
  failed="$failed n8n"
fi
if restore_db inventree; then
  at_least inventree stock_stockitem 1 || failed="$failed inventree"
else
  failed="$failed inventree"
fi

pg_ctl -D "$PGDATA" -w -s -m fast stop

if [ -n "$failed" ]; then
  echo "FAILED:$failed"
  exit 1
fi
echo "restore test ok"
