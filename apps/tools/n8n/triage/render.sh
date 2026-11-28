#!/bin/sh
# R11 render job (CronJob triage-render). Claims up to CLAIM_LIMIT pending
# render requests as the triage_render role, renders each one's old and new
# chart with the HelmRelease's values from Git, and stores both renders. The
# poll classifies them (classifyRender in rules.js).
#
# ${VAR} placeholders in the values become subst-<var>: resolved values never
# enter this job or the database. Logs one line per request, never a value.
#
# RENDER_DRY_RUN=1 RENDER_REQUESTS=<file> sh render.sh
#   skips the database: each line of <file> is one request as JSON (the
#   render_requests columns), and each result is printed to stdout as one JSON
#   line: {request, status, error, old: {digest, app_version, docs}, new}.
# POSIX sh; needs psql, helm, yq, wget, sha256sum, awk.
set -u
umask 077

WORK=${WORK:-/work}
MAX_BYTES=${MAX_BYTES:-8388608}
CLAIM_LIMIT=${CLAIM_LIMIT:-3}
MAX_ATTEMPTS=3
DRY_RUN=${RENDER_DRY_RUN:-0}
# Errors worth another try; anything else is final.
RETRYABLE="'fetch-failed', 'pull-failed', 'show-failed', 'db-failed', 'render-failed'"

export HOME="${HOME:-$WORK/home}"
export HELM_CACHE_HOME="${HELM_CACHE_HOME:-$WORK/helm/cache}"
export HELM_CONFIG_HOME="${HELM_CONFIG_HOME:-$WORK/helm/config}"
export HELM_DATA_HOME="${HELM_DATA_HOME:-$WORK/helm/data}"
mkdir -p "$WORK" "$HOME" "$HELM_CACHE_HOME" "$HELM_CONFIG_HOME" "$HELM_DATA_HOME"

log() { printf '%s\n' "$*" >&2; }

q() { psql -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }

# True when the whole value, a single line, matches the ERE.
valid() { # value ere
  case $1 in *'
'*) return 1 ;; esac
  printf '%s\n' "$1" | grep -Eq "^($2)\$"
}

# One request field from its JSON, as a plain string ('' when null).
field() { # file name
  yq -p=json -oy ".$2 // \"\"" "$1"
}

# ${VAR}, ${VAR:-x} and ${VAR:=x} become subst-<var lowercased>.
substitute() {
  awk '{
    out = ""; s = $0
    while (match(s, /\$\{[A-Za-z0-9_]+(:?[-=][^}]*)?\}/)) {
      tok = substr(s, RSTART + 2, RLENGTH - 3)
      sub(/:?[-=].*/, "", tok)
      out = out substr(s, 1, RSTART - 1) "subst-" tolower(tok)
      s = substr(s, RSTART + RLENGTH)
    }
    print out s
  }'
}

# Sets CODE and DETAIL (first line of a stderr file, cut short) and fails.
fail() { # code [stderr-file]
  CODE=$1
  DETAIL=''
  if [ $# -gt 1 ] && [ -s "$2" ]; then DETAIL=$(head -n 1 "$2" | cut -c 1-200); fi
  return 1
}

# Renders one side into $dir/<side>/docs.json; sets <SIDE>_DIGEST, _APP, _BYTES.
render_side() { # side version
  side=$1
  d="$dir/$side"
  mkdir -p "$d"
  helm pull "$chart" --repo "$helm_url" --version "$2" --destination "$d" >/dev/null 2>"$dir/err" || { fail pull-failed "$dir/err"; return 1; }
  set -- "$d"/*.tgz
  [ $# -eq 1 ] && [ -f "$1" ] || { fail pull-failed; return 1; }
  tgz=$1
  digest=$(sha256sum "$tgz" | cut -d ' ' -f 1)
  app=$(helm show chart "$tgz" 2>"$dir/err" | yq -oy '.appVersion // ""') || { fail show-failed "$dir/err"; return 1; }
  if ! helm template "$release" "$tgz" -n "$namespace" -f "$dir/values.yaml" --include-crds --skip-tests \
      --kube-version "$kube" >"$d/render.yaml" 2>"$dir/err"; then
    if [ "$side" = new ]; then fail new-template-failed "$dir/err"; else fail template-failed "$dir/err"; fi
    return 1
  fi
  yq ea -p=yaml -o=json -I=0 '[.] | map(select(. != null))' "$d/render.yaml" >"$d/docs.json" 2>"$dir/err" || { fail template-failed "$dir/err"; return 1; }
  bytes=$(wc -c <"$d/docs.json" | tr -d ' ')
  [ "$bytes" -le "$MAX_BYTES" ] || { fail too-large; return 1; }
  eval "${side}_digest=\$digest ${side}_app=\$app ${side}_bytes=\$bytes"
}

# Processes the request in $req. Returns 0 with both sides rendered.
render_request() {
  CODE='' DETAIL='' old_digest='' new_digest='' old_app='' new_app='' old_bytes=0 new_bytes=0
  id=$(field "$req" id); repo=$(field "$req" repo); sha=$(field "$req" head_sha); path=$(field "$req" path)
  release=$(field "$req" release); namespace=$(field "$req" namespace); chart=$(field "$req" chart)
  helm_url=$(field "$req" helm_repo_url); old_v=$(field "$req" old_version); new_v=$(field "$req" new_version)
  kube=$(field "$req" kube_version)
  valid "$id" '[0-9]+' || { id=0; fail bad-request; return 1; }
  case /$path/ in */../*|*/./*) fail bad-request; return 1 ;; esac
  dir="$WORK/req-$id"
  rm -rf "$dir" && mkdir -p "$dir" || { fail render-failed; return 1; }
  # Every value reaches helm and the URL as data; each is checked anyway.
  valid "$repo" '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+' && valid "$sha" '[0-9a-f]{40}' \
    && valid "$path" '[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*\.ya?ml' \
    && valid "$release" '[a-z0-9]([-a-z0-9.]{0,51}[a-z0-9])?' && valid "$namespace" '[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?' \
    && valid "$chart" '[a-z0-9][a-z0-9._-]{0,99}' && valid "$helm_url" 'https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~%/-]*)?' \
    && valid "$old_v" 'v?[0-9][0-9A-Za-z.+_-]{0,63}' && valid "$new_v" 'v?[0-9][0-9A-Za-z.+_-]{0,63}' \
    && valid "$kube" 'v?[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z.+_-]{0,32}' || { fail bad-request; return 1; }

  # The HelmRelease at the head commit, from the public raw URL.
  wget -q -T 30 -O "$dir/hr.yaml" "https://raw.githubusercontent.com/$repo/$sha/$path" 2>/dev/null || { fail fetch-failed; return 1; }
  R_CHART=$chart R_NEW=$new_v R_RELEASE=$release yq ea -oy '[select(
      .kind == "HelmRelease" and ((.apiVersion // "") | test("^helm\\.toolkit\\.fluxcd\\.io/"))
      and .spec.chart.spec.chart == strenv(R_CHART)
      and ((.spec.chart.spec.version // "") | tostring) == strenv(R_NEW)
      and ((.spec.releaseName // "") == strenv(R_RELEASE)
        or ((.spec.releaseName // "") == "" and (
          ((.spec.targetNamespace // "") == "" and .metadata.name == strenv(R_RELEASE))
          or ((.spec.targetNamespace // "") + "-" + .metadata.name) == strenv(R_RELEASE)))))] | .[0] // ""' \
    "$dir/hr.yaml" >"$dir/hr-doc.yaml" 2>"$dir/err" || { fail helmrelease-not-found; return 1; }
  [ "$(yq -oy '.kind // ""' "$dir/hr-doc.yaml")" = HelmRelease ] || { fail helmrelease-not-found; return 1; }
  [ "$(yq -oy '.spec | has("valuesFrom")' "$dir/hr-doc.yaml")" = false ] || { fail values-from; return 1; }
  [ "$(yq -oy '.spec | has("postRenderers")' "$dir/hr-doc.yaml")" = false ] || { fail post-renderers; return 1; }
  yq -oy '.spec.values // {}' "$dir/hr-doc.yaml" 2>"$dir/err" | substitute >"$dir/values.yaml" || { fail render-failed; return 1; }

  render_side old "$old_v" || return 1
  render_side new "$new_v" || return 1
}

# The status a failure leaves: unsupported for the two HelmRelease features
# R11 doesn't model, failed for the rest.
status_for() { # code
  case $1 in values-from|post-renderers) echo unsupported ;; *) echo failed ;; esac
}

store() { # status
  RENDER_OLD="$dir/old/docs.json" RENDER_NEW="$dir/new/docs.json" q \
    -v id="$id" -v status="$1" -v err="$CODE${DETAIL:+: $DETAIL}" \
    -v od="$old_digest" -v oa="$old_app" -v ob="$old_bytes" -v nd="$new_digest" -v na="$new_app" -v nb="$new_bytes" <<'SQL'
\set has_old 0
\set has_new 0
SELECT (:'od' <> '')::int AS has_old, (:'nd' <> '')::int AS has_new \gset
BEGIN;
\if :has_old
\set old_docs `cat "$RENDER_OLD"`
INSERT INTO triage.renders (request_id, side, chart_digest, app_version, docs, bytes)
VALUES (:id, 'old', :'od', NULLIF(:'oa', ''), :'old_docs'::jsonb, :ob);
\endif
\if :has_new
\set new_docs `cat "$RENDER_NEW"`
INSERT INTO triage.renders (request_id, side, chart_digest, app_version, docs, bytes)
VALUES (:id, 'new', :'nd', NULLIF(:'na', ''), :'new_docs'::jsonb, :nb);
\endif
UPDATE triage.render_requests
SET status = :'status', error = NULLIF(:'err', ''), finished = now()
WHERE id = :id;
COMMIT;
SQL
}

dry_result() { # status
  R_STATUS=$1 R_ERROR="$CODE${DETAIL:+: $DETAIL}" OD=$old_digest OA=$old_app ND=$new_digest NA=$new_app \
  R_OLD="$dir/old/docs.json" R_NEW="$dir/new/docs.json" R_REQ="$req" \
    yq -n -o=json -I=0 '{
      "request": load(strenv(R_REQ)), "status": strenv(R_STATUS), "error": strenv(R_ERROR),
      "old": (strenv(OD) as $d | if $d == "" then null else {"digest": $d, "app_version": strenv(OA), "docs": load(strenv(R_OLD))} end),
      "new": (strenv(ND) as $d | if $d == "" then null else {"digest": $d, "app_version": strenv(NA), "docs": load(strenv(R_NEW))} end)
    }'
}

handle() { # one request, as JSON in $req
  if render_request; then
    status=done
  else
    status=$(status_for "$CODE")
    # The new chart failing where the old rendered is kept: it's a finding.
    [ "$CODE" = new-template-failed ] || { old_digest='' new_digest=''; }
    new_digest=''
  fi
  if [ "$DRY_RUN" = 1 ]; then
    dry_result "$status" || log "render request $id: result not printed"
  elif ! store "$status"; then
    CODE=db-failed DETAIL=''
    q -v id="$id" -v err="$CODE" <<'SQL' || log "render request $id: outcome not recorded"
UPDATE triage.render_requests SET status = 'failed', error = :'err', finished = now() WHERE id = :id;
SQL
    status=failed
  fi
  sizes=''
  [ "$status" = done ] && sizes=", $old_bytes/$new_bytes bytes"
  log "render request $id: $chart $old_v -> $new_v: $status${CODE:+ ($CODE)}$sizes"
  rm -rf "$WORK/req-$id"
}

# RENDER_LIB=1: define the functions only (render.test.js sources them).
[ "${RENDER_LIB:-0}" = 1 ] && return 0

n=0
if [ "$DRY_RUN" = 1 ]; then
  [ -n "${RENDER_REQUESTS:-}" ] && [ -f "$RENDER_REQUESTS" ] || { log "RENDER_DRY_RUN needs RENDER_REQUESTS=<file>"; exit 2; }
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    req="$WORK/request.json"
    printf '%s\n' "$line" >"$req"
    handle
    n=$((n + 1))
  done <"$RENDER_REQUESTS"
  log "render: $n request(s), dry run"
  exit 0
fi

until pg_isready -q; do log "waiting for n8n-db"; sleep 2; done

# A request the last job claimed and never finished, out of attempts, is failed.
q -c "UPDATE triage.render_requests SET status = 'failed', error = coalesce(error, 'render-failed: out of attempts'), finished = now()
      WHERE status = 'pending' AND attempts >= $MAX_ATTEMPTS;" || exit 1

claimed="$WORK/claimed.jsonl"
q -v limit="$CLAIM_LIMIT" >"$claimed" <<SQL || exit 1
WITH c AS (
  SELECT id FROM triage.render_requests
  WHERE attempts < $MAX_ATTEMPTS
    AND (status = 'pending' OR (status = 'failed' AND split_part(coalesce(error, ''), ':', 1) IN ($RETRYABLE)))
  ORDER BY requested, id
  LIMIT :limit
  FOR UPDATE SKIP LOCKED
)
UPDATE triage.render_requests r
SET attempts = r.attempts + 1, status = 'pending'
FROM c WHERE r.id = c.id
RETURNING json_build_object('id', r.id, 'repo', r.repo, 'head_sha', r.head_sha, 'path', r.path,
  'release', r.release, 'namespace', r.namespace, 'chart', r.chart, 'helm_repo_url', r.helm_repo_url,
  'old_version', r.old_version, 'new_version', r.new_version, 'kube_version', r.kube_version)::text;
SQL

while IFS= read -r line; do
  [ -n "$line" ] || continue
  req="$WORK/request.json"
  printf '%s\n' "$line" >"$req"
  handle
  n=$((n + 1))
done <"$claimed"
log "render: $n request(s)"
