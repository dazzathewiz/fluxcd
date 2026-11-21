#!/bin/sh
# Copies the data directory from a restored n8n-db volume to scratch, starts a
# throwaway server on the copy on a Unix socket only, then checks row counts
# and runs amcheck. The mount is read-only and never written.
set -eu
. /scripts/lib.sh

IN=/restore
PGDATA=/scratch/data
SOCK=/tmp/run
LOG=/tmp/postgres.log

src=$(find_pgdata "$IN") || { echo "no PG_VERSION in $IN/pgdata or $IN"; exit 1; }
echo "data dir: $src (PG_VERSION $(cat "$src/PG_VERSION"))"

# The backup is crash-consistent: expect crash recovery on start.
cp -Rp "$src" "$PGDATA"
chmod 700 "$PGDATA"
rm -f "$PGDATA/postmaster.pid"
if ! hba_local_trust "$PGDATA/pg_hba.conf"; then
  echo "pg_hba.conf: no local trust rule, replacing it in the copy"
  echo "local all all trust" > "$PGDATA/pg_hba.conf"
fi

mkdir -p "$SOCK"
pg_ctl -D "$PGDATA" -l "$LOG" -w -t 300 -s \
  -o "-c listen_addresses='' -c unix_socket_directories=$SOCK" start \
  || { echo "server did not start"; tail -n 50 "$LOG"; exit 1; }
wait_ready "$SOCK" 60 || { tail -n 50 "$LOG"; exit 1; }
# n8n-db's POSTGRES_USER: the database owner and bootstrap superuser.
export PGHOST="$SOCK" PGUSER=n8n PGDATABASE=n8n

# Run in an `||` context, where set -e is off: every step checks its own status.
q() { psql -X -At -v ON_ERROR_STOP=1 -c "$1"; }
at_least() { # table min
  n=$(q "SELECT count(*) FROM $1") || { echo "$1: unreadable"; return 1; }
  echo "$1 = $n"
  [ "$n" -ge "$2" ] || { echo "$1: below $2"; return 1; }
}

failed=""
at_least workflow_entity 5 || failed="$failed workflow_entity"
at_least triage.runs 1 || failed="$failed triage.runs"
if last=$(q "SELECT max(finished) FROM triage.runs"); then
  echo "triage.runs max(finished) = $last"
else
  failed="$failed max(finished)"
fi
if pg_amcheck --heapallindexed n8n; then
  echo "amcheck: clean"
else
  echo "amcheck: FAILED"
  failed="$failed amcheck"
fi

pg_ctl -D "$PGDATA" -w -s -m fast stop

if [ -n "$failed" ]; then
  echo "FAILED:$failed"
  exit 1
fi
echo "volume restore test ok"
