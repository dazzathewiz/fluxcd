# Sourced by backup.sh, restore-test.sh and the *.test.js files. POSIX sh.
# Dumps are <dir>/<db>-<UTC yyyymmddThhmmZ>.dump, so name order is time order.

KEEP=${KEEP:-14}

dump_name() { # db
  printf '%s-%s.dump\n' "$1" "$(date -u +%Y%m%dT%H%MZ)"
}

# Finished dumps of one database, oldest first. Ignores .tmp and .sha256.
list_dumps() { # dir db
  ls "$1" | grep -E "^$2-[0-9]{8}T[0-9]{4}Z\.dump\$" | sort
}

newest_dump() { # dir db
  list_dumps "$1" "$2" | tail -n 1
}

# Keep the newest $KEEP dumps, delete older ones with their .sha256, and delete
# .tmp files older than a day.
prune() { # dir db
  list_dumps "$1" "$2" | sort -r | tail -n +$((KEEP + 1)) | while read -r f; do
    rm -f "$1/$f" "$1/$f.sha256" || return 1
  done || return 1
  find "$1" -maxdepth 1 -name "$2-*.dump.tmp" -mtime +0 -exec rm -f {} + || return 1
}

# Poll pg_isready every 2 s until the database answers or the timeout passes.
# A fresh pod's IP can take a moment to be admitted by an ingress NetworkPolicy.
wait_ready() { # host [timeout_s]
  limit=${2:-${WAIT_READY:-90}}
  start=$(date +%s)
  while :; do
    if pg_isready -q -h "$1" -p 5432 -t 2; then
      echo "$1: reachable after $(($(date +%s) - start))s"
      return 0
    fi
    waited=$(($(date +%s) - start))
    if [ "$waited" -ge "$limit" ]; then
      echo "$1: not reachable after ${waited}s"
      return 1
    fi
    sleep 2
  done
}
