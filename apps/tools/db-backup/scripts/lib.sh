# Sourced by backup.sh, restore-test.sh and retention.test.js. POSIX sh.
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
