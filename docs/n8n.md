# n8n

A self-hosted n8n instance in the `tools` namespace, with its own Postgres. It
runs automated triage of dependency-update PRs. It reads PRs and records a verdict
for each one in Postgres. With `write_mode: "labels"` it also publishes each verdict
on the PR (a label, a comment and a commit status) through a GitHub App. It ships
with `write_mode: "off"`, which records what it would publish and writes nothing to
the source host. See [PR triage](#pr-triage) and [write_mode](#write_mode) below.
After each merge, a watcher checks the change rolled out and alerts if it didn't;
see [R10: post-merge watch](#r10-post-merge-watch). Helm chart bumps also get a
rendered-chart diff; see [R11: rendered-chart diff](#r11-rendered-chart-diff).

## What's deployed

All manifests are in `apps/tools/n8n/`. The top-level `apps` Kustomization picks
them up.

| Object | Purpose |
| --- | --- |
| `Deployment n8n` | One replica, `Recreate`, runs as UID/GID 1000. `/home/node/.n8n` is on PVC `n8n-data` (1Gi). Binary data is on a 16Mi memory-backed `emptyDir`. |
| `Deployment n8n-db` + `Service n8n-db` | Postgres 17, database and user `n8n`, data on PVC `n8n-db` (5Gi). No service-account token mounted. |
| `ConfigMap n8n-env` | Non-secret env only: database coordinates, public URL, proxy hops, timezone, telemetry off, community packages off, env access from nodes blocked, execution pruning after 7 days or 2000 executions. |
| `ConfigMap n8n-workflows-<hash>`, `n8n-triage-<hash>`, `n8n-credentials-<hash>` | Generated from `workflows/`, `triage/` and `credentials/`. A change to any file changes the hash, which rolls the pod. See below. |
| `ExternalSecret n8n-secrets` | Every secret value. See below. |
| `Service n8n` + `IngressRoute n8n` | ClusterIP on 5678, routed at `n8n.inf.${PERSONAL_DOMAIN}` on `websecure` with the wildcard `.inf` certificate and the namespace's `default-headers` Middleware. |
| `ServiceAccount n8n` + `ClusterRoleBinding n8n-view` | Read-only cluster identity. See below. |
| `NetworkPolicy n8n`, `NetworkPolicy n8n-db` | Network isolation. See below. |
| `CronJob triage-render` + `ConfigMap triage-render-scripts-<hash>`, `ExternalSecret triage-render-secrets`, `NetworkPolicy triage-render` | The R11 render job. See [R11](#r11-rendered-chart-diff). |

Probes: liveness on `/healthz`, which answers without the database. Startup and
readiness on `/healthz/readiness`, which also waits for the database connection and
migrations.

The pod sets `enableServiceLinks: false`. Without it, the `n8n` Service injects
`N8N_PORT=tcp://...`, which clashes with n8n's own variable.

## Secrets

1Password item **`n8n`**, synced by ESO through `ClusterSecretStore onepassword-k3s`
into Secret `n8n-secrets`:

| 1Password field | Secret key(s) | Used by |
| --- | --- | --- |
| `encryption-key` | `N8N_ENCRYPTION_KEY` | n8n, to encrypt stored credentials |
| `db-password` | `DB_POSTGRESDB_PASSWORD`, `POSTGRES_PASSWORD`, and hashed into `TRIAGE_DB_PASSWORD` | n8n and Postgres (one source, so they can't drift); the workflows' `triage` role |
| `github-token` | `GITHUB_TOKEN`, and inside `CREDENTIALS_OVERWRITE_DATA` | The triage workflow's source-host reads |
| `redaction-patterns` | `REDACTION_PATTERNS` | Seeded into `triage.redaction_patterns` for the R9 hygiene check |
| `github-app-id` | `GITHUB_APP_ID` | Seeded into `triage.config`; the JWT's `iss` |
| `github-app-installation-id` | `GITHUB_APP_INSTALLATION_ID` | Seeded into `triage.config`; the installation token exchange |
| `github-app-private-key-b64` | Only decoded, inside `CREDENTIALS_OVERWRITE_DATA` (`jwtAuth`) | Signs the App JWT in the `PR triage: publish` sub-workflow |
| `ha-heartbeat-url` | `HA_HEARTBEAT_URL` | Seeded into `triage.alert_target`; see [Dead-man](#dead-man) |
| `triage-render-db-password` | `TRIAGE_RENDER_DB_PASSWORD` (also the only key of `triage-render-secrets`) | The `triage_render` role's password, set by the `triage-schema` initContainer; the [R11](#r11-rendered-chart-diff) job's login |

All nine fields must exist before the ExternalSecret syncs: a missing one stops
the whole Secret updating. The private key is the App's PEM, base64-encoded onto
one line, because 1Password password fields flatten line breaks. The template
decodes it (`b64dec`) into the `jwtAuth` overwrite, the key's only copy in the
Secret, so n8n gets the multi-line PEM and nothing sees the base64 form. The
`import-workflows` initContainer checks that the key starts with `-----BEGIN` and
parses as an RSA key, without printing it, and fails the pod start if not.

The ExternalSecret uses `mergePolicy: Replace` and templates every key the
Secret holds. Most are passed through unchanged. `CREDENTIALS_OVERWRITE_DATA` is
built from `github-token`, `db-password` and `github-app-private-key-b64`, and
`TRIAGE_DB_PASSWORD` is derived from `db-password`. The 1Password fields are only
template inputs, so a field that no template names never reaches the Secret.
See [Credential overwrites](#credential-overwrites) and
[The `triage` database role](#the-triage-database-role).

**The encryption key cannot change once credentials are stored.** n8n also writes
it to `/home/node/.n8n/config` on first boot. A key that differs from the one in
that file stops n8n from starting, and credentials encrypted with a lost key are
unrecoverable. Treat the 1Password field as write-once.

## Read-only cluster identity

`ServiceAccount tools/n8n` is bound to the built-in `view` ClusterRole. `view`
excludes Secrets. On this cluster it also aggregates get/list/watch on every Flux
kind, `kustomizations` and `helmreleases` included. So no extra role is needed.

Check it with:

```sh
kubectl auth can-i list secrets -A --as=system:serviceaccount:tools:n8n        # no
kubectl auth can-i list helmreleases.helm.toolkit.fluxcd.io -A --as=system:serviceaccount:tools:n8n  # yes
```

`view` can read every ConfigMap and ExternalSecret spec in the cluster. That is
why secret values must stay in Secrets.

## Network policy

k3s enforces NetworkPolicy through its embedded kube-router controller, because the
servers don't run with `--disable-network-policy`.

- **n8n ingress:** TCP 5678 from Traefik pods in the `traefik` namespace only.
- **n8n egress:**
  - DNS to CoreDNS
  - TCP 5432 to `n8n-db`
  - TCP 6443 to the control-plane VIP and each control-plane node
  - TCP 8123 to the home automation server, for the [dead-man](#dead-man) ping
  - Anything outside `10.0.0.0/8`, `172.16.0.0/12` and `192.168.0.0/16`
- **n8n-db:** ingress on 5432 from `n8n`, from the nightly dump (`app:
  db-backup`, see [db-backup.md](db-backup.md)) and from the R11 render job
  (`app: triage-render`). Egress is DNS only.
- **triage-render:** no ingress. Egress to CoreDNS, `n8n-db:5432`, and TCP 443
  outside the three private ranges.

So n8n can reach the internet, the k3s API and that one port, and it can't reach
anything else on the LAN or in the cluster.

**The API addresses are literal IPs.** No cluster var holds them. The home
automation server's address is outside the cluster, so it comes from the SOPS var
`HOST_HOMEASSISTANT` in `global-secrets`. Rebuilding or re-addressing a
control-plane node means updating this policy, and re-addressing the home
automation server means updating that var. The symptom of a stale entry is
requests from n8n timing out.

## First run

**The first visitor to the UI creates the owner account.** Open
`https://n8n.inf.<domain>` and claim it straight after the first rollout. Check
that the served certificate is the wildcard one, not Traefik's default.

## DNS

Not declarative. `n8n.inf.${PERSONAL_DOMAIN}` needs an A record pointing at
`LB_TRAEFIK`, added by hand on both local DNS resolvers.

## Storage, backup and restore

Both PVCs use `longhorn-diskencrypt-global`, RWO. They're backed up by the default
Longhorn recurring-job group with no label. The backing PVs are reclaimed with
`Delete`, so pruning a PVC deletes its volume.

- `n8n-db` holds workflows, credentials (encrypted), users and execution history.
  A nightly `pg_dump`, checked with `pg_amcheck`, also goes to its own volume;
  see [db-backup.md](db-backup.md).
- **Execution history is kept short.** n8n prunes executions older than 7 days,
  and keeps at most 2000 (`EXECUTIONS_DATA_MAX_AGE`, `EXECUTIONS_DATA_PRUNE_MAX_COUNT`).
  The watcher and the heartbeat save failed executions only. Their successful runs
  are already in `triage.watch_runs` and `triage.heartbeat`. The poll still saves
  every run.
- **The triage run logs are kept 90 days.** Once a day, the heartbeat's `Retention`
  step deletes `triage.runs` and `triage.watch_runs` rows that started more than 90 days ago
  (`triage.prune_runs()`). `watches`, `verdicts` and `publications` are kept, and
  a pruned run's `run_id` becomes NULL in them. The gate is the `retention` row in
  `triage.heartbeat`, and the counts go to the `n8n-db` log.
- **R11 renders are kept 30 days.** The same `prune_runs()` deletes
  `triage.render_requests` requested more than 30 days ago, and their renders
  with them (`ON DELETE CASCADE`).
- `n8n-data` holds n8n's local config, including the copy of the encryption key.
  Binary data is not on it: it lives in a memory-backed `emptyDir`. See
  [Cluster version](#cluster-version).

To restore:

1. Scale both Deployments to 0 through a Git change, or suspend the `apps`
   Kustomization.
2. Restore both volumes from the same Longhorn backup point, onto the existing
   PVC names.
3. Make sure the `encryption-key` field in 1Password is the key that was in use at
   that backup point.
4. Bring the Deployments back. `n8n-db` must be Ready before n8n can pass
   readiness.

**Revert-safety:** reverting this app is safe until an owner account or workflows
exist. After that, a `git revert` that prunes the PVCs destroys them with no
Released volume to recover from. Roll back with a Longhorn restore instead, and fix
forward.

## Workflows from Git

The workflows live in `apps/tools/n8n/workflows/`, one JSON file each, with a fixed
`id`. On every pod start the `import-workflows` initContainer runs:

1. `n8n import:credentials --separate` for the three credential records in
   `credentials/`
2. `n8n import:workflow --separate` for every workflow file
3. `n8n publish:workflow --id=<id>` for each workflow

Import unpublishes every workflow it overwrites (`--activeState` defaults to
`false`), so the publish step is what turns them back on.

**Git wins. Edits made in the UI are overwritten on the next restart**, and so is
anything that changes the ConfigMap hash. To change a workflow:

1. Edit it in the UI if that's easier, then export it (Download in the editor).
2. Replace the file in `workflows/`. Keep the `id` and credential IDs as they are,
   and check the export holds no secret or resolved value.
3. If a Code node changed, see the next section.
4. Open a PR. The merge rolls the pod and re-imports.

A workflow added in the UI and never committed survives restarts, because import
only touches the IDs in Git. Don't rely on that: it isn't backed by Git, only by the
volume backups.

The two ConfigMaps that hold JavaScript (`n8n-workflows`, `n8n-triage`) carry
`kustomize.toolkit.fluxcd.io/substitute: disabled`. Without it, Flux postBuild
substitution turns every JS template literal `${...}` into an empty string.

### Triage rules code

The check logic is one plain JS module, `triage/rules.js`: pure functions, no n8n
APIs, with network access passed in. The poll workflow's `Triage` Code node and
the watcher's `Watch` Code node each carry a verbatim copy between
`BEGIN rules.js` / `END rules.js` markers, followed by a short driver. The other
Code nodes only build URLs or reshape items; none decides a verdict or a write. Before
pushing a change to either:

```sh
node --test apps/tools/n8n/triage/                     # fixtures and rule tests
node apps/tools/n8n/triage/sync-code-nodes.js --write  # copy rules.js into the Code nodes
node apps/tools/n8n/triage/sync-code-nodes.js          # check: exits 1 on drift
```

The check also fails if a workflow carries more than one copy, and it enforces the
write allowlist (see [Where the writes are](#where-the-writes-are)). It prints
every write and where it sits. The tests include drift
checks of `triage/config.yaml` against `renovate.json` and against the
HelmRepositories in this repo, so a change to either needs the config updated in the
same PR.

## Credential overwrites

The workflows use three stored credentials, a `githubApi`, a `postgres` and a
`jwtAuth` (PEM key, RS256), imported from `credentials/` with every secret field
empty. n8n fills empty fields at run
time from `CREDENTIALS_OVERWRITE_DATA`, a JSON object keyed by credential type that
the ExternalSecret templates from 1Password. So the credential records in the
database hold no secret, and rotating the token is a 1Password change plus a pod
restart.

In this n8n version, overwrites apply to any credential type, not just OAuth ones.
They fill a field only when the stored value is empty, so a token typed into the
credential in the UI would win over the overwrite.

`N8N_BLOCK_ENV_ACCESS_IN_NODE=true` stays on. `$env` in expressions returns nothing,
and Code nodes run in a task-runner child process that gets a fixed allowlist of
variables, which doesn't include the overwrite data or any other Secret key.

### The `triage` database role

The `postgres` credential connects as `triage`, not as the `n8n` superuser that
n8n itself uses. So a workflow can't read or change n8n's own tables: users,
credentials and execution history. `triage/roles.sql` runs in the `triage-schema`
initContainer on every start. It creates the role if it's missing, sets its
password, revokes everything and grants back exactly:

| Object | Privileges | Used by |
| --- | --- | --- |
| schema `triage` | `USAGE` | every query |
| `triage.runs` | `SELECT`, `INSERT`, `UPDATE` | Start run, Finish run, heartbeat |
| `triage.verdicts` | `SELECT`, `INSERT` | the seen-SHA read, Insert verdict |
| `triage.config`, `triage.redaction_patterns` | `SELECT` | Start run |
| `triage.publications` | `SELECT`, `INSERT`, `UPDATE` | Start run, Record plan, Record publish, Finish run |
| `triage.heartbeat` | `SELECT`, `INSERT`, `UPDATE` | heartbeat upsert |
| `triage.alert_target` | `SELECT` | `TriageAlertV01` |
| `triage.watches`, `triage.watch_cursor`, `triage.watch_runs` | `SELECT`, `INSERT`, `UPDATE` | the [watcher](#r10-post-merge-watch) |
| `triage.render_requests` | `SELECT`, `INSERT` | [R11](#r11-rendered-chart-diff): Queue render, Renders |
| `triage.renders` | `SELECT` | R11: Renders |
| the five `id` sequences | `USAGE` | inserts |
| function `triage.prune_runs()` | `EXECUTE` | heartbeat Retention |

No `DELETE`: the one delete is `prune_runs()`, a `SECURITY DEFINER` function with a
pinned `search_path` and a fixed 90-day cutoff, run as its owner. No DDL, and nothing in `public`, where n8n's tables live and where
`PUBLIC` has no table privileges. The role is `NOSUPERUSER NOCREATEDB
NOCREATEROLE NOINHERIT` with a 10-connection limit. A manual grant is reset on the
next pod start. Admin work, such as finalising a verdict (see
[Rulesets and re-triage](#rulesets-and-re-triage)), still goes through
`kubectl exec` as `n8n`. Without `UPDATE` on `triage.verdicts`, the workflows
can't finalise anything themselves.

The role's password is `TRIAGE_DB_PASSWORD`. The ExternalSecret templates it as
`sha256("n8n-triage-db:" + db-password)`, and the overwrite uses the same
expression. So it needs no extra 1Password field, rotates with `db-password`, and
can't be turned back into the superuser password. The initContainer refuses to run
`roles.sql` if the value is missing or shorter than 32 characters.

To check the role from outside:

```sh
kubectl -n tools exec deploy/n8n-db -- psql -U n8n -d n8n -c \
  "select rolsuper, rolcreaterole, rolcanlogin, rolconnlimit from pg_roles where rolname = 'triage';" -c \
  "select table_name, string_agg(privilege_type, ', ' order by privilege_type) from information_schema.role_table_grants where grantee = 'triage' group by 1 order by 1;"
```

## PR triage

`PR triage: poll` runs every 15 minutes:

1. **Start run** works out the [ruleset](#rulesets-and-re-triage), inserts a
   `triage.runs` row, and reads the config, the redaction patterns, the PR-list
   ETags stored under this ruleset and the PRs already triaged under it. It lists the
   repos from the one-line `repos: [...]` in `config.yaml`.
2. **Get dashboard** reads the Dependency Dashboard issue, and **Repo labels** the
   repository's labels.
3. **List PRs** sends `If-None-Match`. A `304` means nothing changed.
4. **One item per PR**, **Get PR** and **Get files** read each open PR, its labels
   included. **PR read URLs** works out the per-PR reads below. **Label events**
   reads the PR's issue events, every page (it follows `Link`; a last page that
   still has a next link counts as unread). **Stored comment** reads the triage
   comment whose ID `triage.publications` holds, directly. Only when that isn't the
   App's comment for this head SHA does **PR comments** read every page of the PR's
   comments. When the list is unchanged or empty, one placeholder item goes through
   instead and the reads hit `/rate_limit`, which costs no quota. These reads carry
   the read-only source-host credential, and only to `api.github.com`.
5. **Cluster version** calls the `PR triage: cluster version` sub-workflow once,
   which returns the live `/version` response. See
   [Cluster version](#cluster-version).
6. **Triage** parses the config and checks it lists the same
   repos, and runs the negative control against that response. It keeps PRs whose
   `head_sha` has no verdict under this ruleset and no finalised one, oldest first, up to `per_run_cap`. Then it fetches
   the Helm index and registry manifests and runs R1–R9, and R11 from what
   **Renders** read. **Queue render** inserts R11's render requests.
   Then it plans the publish for every open PR it read (`planPublish` in
   `rules.js`). Planning only reads.
7. Three branches follow, top to bottom (n8n's v1 execution order runs one
   branch to the end before the next):
   - **Insert verdict**.
   - **Record plan** upserts `triage.publications.planned`. **One item per action**
     splits each plan into its writes, then the **Write gate**. Only its true
     output (`write_mode` is `labels`, and the run is healthy) leads to
     **Publish**, which runs the `PR triage: publish` sub-workflow once per write.
     **Publish results** and **Record publish** record the outcome.
   - **Finish run** records the PR count, the negative-control result, the ETags
     and `runs.publish`.

So when the PR list changes, every open PR's detail and files are read, and only
the new head SHAs are triaged. A failed read of a PR being triaged fails the run;
the run stays unfinished, no ETag is stored, and the next run retries.

`PR triage: heartbeat` runs every 30 minutes, writes the last successful run times
of the poll and the watcher to `triage.heartbeat`, and pings Home Assistant; see
[Dead-man](#dead-man). A second branch prunes the run logs once a day; see
[Storage, backup and restore](#storage-backup-and-restore).

### Dead-man

Every heartbeat run POSTs one JSON object to a Home Assistant webhook:

```json
{"source": "pr-triage", "last_success": "<ISO-8601 UTC or null>", "watch_last_success": "<ISO-8601 UTC or null>", "stale": false, "rules_drift": false, "checked": "<ISO-8601 UTC>"}
```

`stale` is true when no poll run has succeeded in 2 hours, or no watcher run in
`watch_stale_min` minutes (30). Before the watcher's first run, that clock starts
when the pod loaded the config. Home Assistant alerts on two
things: a ping that says `stale`, and no ping at all for longer than a couple of
intervals, which means n8n itself is down. The receiver, the watchdog and the phone
notification live in Home Assistant, outside this repo. `rules_drift` is the
last [rules drift](#rules-drift) result (true, false, or null for no result),
for visibility only: nothing alerts on it here.

- **The URL is a secret.** The webhook ID is in it. It comes from the 1Password
  field `ha-heartbeat-url`, and the `triage-schema` initContainer seeds it into
  `triage.alert_target` on every pod start (a missing field leaves the table
  empty). No credential type can carry a request URL, so a credential overwrite
  doesn't fit.
- **Only `PR triage: alert (unsaved)` (`TriageAlertV01`) reads it.** The heartbeat
  calls it once per run with the six keys above, the watcher once per failed
  watch or shared-failure group (see [R10](#r10-post-merge-watch)), and the
  poll once per [rules drift](#rules-drift) change. It reads the URL, POSTs with a 10 s
  timeout and one retry on a network error, and returns only the HTTP status. It
  saves no executions, and its caller policy admits only those three. The tests
  check that no other workflow names the table.
- **The heartbeat records the result** in `triage.heartbeat.last_ping` and
  `ping_status` (the status, or NULL on a network error). A status outside 2xx
  then fails that heartbeat execution. The poll and `triage.runs` are untouched.

### Cluster version

R4 and the negative control compare charts against the live cluster version, and
the [watcher](#r10-post-merge-watch) reads Flux and workload status.
The apiserver runs with anonymous auth off, so an unauthenticated `GET /version`
gets `401`. The call uses the pod's own projected service-account token instead.
No Secret holds a token, and kubelet rotates the file.

- **RBAC:** none added. `system:discovery` grants `/version` to every
  authenticated identity. Check:
  `kubectl auth can-i get /version --as=system:serviceaccount:tools:n8n` → `yes`.
- **File access:** `N8N_RESTRICT_FILE_ACCESS_TO` in `n8n-env` adds the token
  directory to `~/.n8n-files`. It's listed twice, as `/var/run/...` and `/run/...`.
  n8n checks a file's real path against the list without resolving the list
  itself, and in the n8n image `/var/run` links to `/run`. The setting is
  instance-wide, so any workflow the owner builds can read the token.
- **The token never reaches saved data.** n8n's execution redaction only hides
  data when the API or UI loads it: the execution is still stored in full. The
  pod's token is issued with `expirationSeconds: 3607`, which the apiserver
  extends to about a year, so a saved copy would outlive the hourly rotation. So
  the token is read only in the sub-workflow `PR triage: cluster read`
  (`workflows/triage-cluster-version.json`, `TriageClusterV01`). It reads the
  token file, turns it into text and sends one `GET` with `Authorization: Bearer`.
  It saves no executions, successful, failed or manual. Its last node is the HTTP
  request, whose output holds only the status and body, or on a rejected path a
  Code node that returns a new object. That matters because n8n copies a
  sub-workflow's last-node binary data into the caller.
- **An allowlist of paths, checked first.** A caller that passes no
  `cluster_path` gets `GET /version` (the poll). Otherwise the path must be one
  of these, with `{ns}` and `{name}` DNS labels, or the token isn't read and no
  request is made:

  | Path | Read by |
  | --- | --- |
  | `/version` | the poll (R4) |
  | `/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/flux-system/kustomizations/{name}` | the watcher |
  | `/apis/helm.toolkit.fluxcd.io/v2/namespaces/{ns}/helmreleases/{name}` | the watcher |
  | `/apis/apps/v1/namespaces/{ns}/deployments/{name}` | the watcher |
  | `/apis/apps/v1/namespaces/{ns}/statefulsets/{name}` | the watcher |

  `view` already covers all of them; no RBAC was added.
- **The Read node's binary copy of the token is RAM-only.** With pruning on, n8n
  doesn't delete an unsaved execution in flight. It soft-deletes it, and the next
  prune batch, every 15 minutes, hard-deletes it together with its binary data. The
  database row it keeps until then is a stub with no node output. But the binary
  copy of the token would otherwise sit in `~/.n8n/storage` on the backed-up
  `n8n-data` PVC for up to 15 minutes of every 15, so Longhorn snapshots could
  capture it. `N8N_BINARY_DATA_STORAGE_PATH=/n8n-binary-data` on the main container
  points binary data at a memory-backed `emptyDir` (`medium: Memory`,
  `sizeLimit: 16Mi`, counted against the container's memory limit). The
  initContainers don't mount it. No workflow here saves binary data, so losing the
  store on restart costs nothing. Don't also set `N8N_STORAGE_PATH`: n8n refuses to
  start if it differs from `N8N_BINARY_DATA_STORAGE_PATH`.
- **Copies written before the move are dead.** From the deployment of the
  cluster-version sub-workflow until binary data moved to tmpfs, token copies were
  written to `~/.n8n/storage` on the PVC, and some may be in Longhorn snapshots and
  backups. The projected token is bound to its pod, so the apiserver rejects it once
  that pod is deleted. The rollout that moved binary data to tmpfs replaced the pod,
  which invalidated every one of those copies, on the PVC and in backups alike. The
  `import-workflows` initContainer also deletes the sub-workflow's old binary
  directory on every start, because prune now looks only at the new path and can't
  reach it.
- **Fallback:** the poll calls the sub-workflow with `continueRegularOutput`. If the
  token read or the call fails, R4 and the negative control are `not_run`, and the
  run still finishes with `ok = false`.

`sync-code-nodes.js` fails if a workflow that reads the token has any execution
saving turned on. A **manual** test run of the sub-workflow from the editor is
still kept until the hard-delete buffer passes, so test it through the poll
instead.

### Checks and verdicts

Each check records `{id, result, evidence: {source_url, etag_or_sha, compared}}`.
`result` is `pass`, `flag`, `fail` or `not_run`. **A check with no evidence is
`not_run`, never `pass`.** Sources that send no ETag are recorded by a SHA-256 of
what was read.

| Check | Reads | Fails or flags when |
| --- | --- | --- |
| R1 update type | PR files, Renovate's PR table | The diff and the table disagree |
| R2 change shape | PR files | More than one version line, or outside `apps/` |
| R3 gated package | `config.yaml` (mirrors `renovate.json`), Dependency Dashboard | The package needs Dashboard approval |
| R4 chart `kubeVersion` | Helm repository `index.yaml`, live cluster version | The cluster doesn't satisfy it |
| R5 pins and caps | `config.yaml` | A cap, one-minor rule or group is broken, or a removed package reappears |
| R6 release notes | Release notes in the PR body | A keyword appears |
| R7 mergeability, age | PR detail | Informational only |
| R8 amd64 image | Registry manifest | No `linux/amd64` |
| R9 hygiene (non-Renovate PRs) | Added lines, PR text, redaction patterns | A pattern matches. Only counts and file paths are recorded, never the pattern |
| R11 rendered chart | The old and new chart, rendered with the repo's values | Not required. Shown, and used only with `r11_mode: "on"`; see [R11](#r11-rendered-chart-diff) |

The first matching verdict wins:

1. **blocked**: R4, R5, R8 or R9 failed.
2. **deep-review**: R3 flagged, the package is in `deep_review_packages`, the
   change touches CRDs, it touches `clusters/` or `gotk-components`, it moves a
   manifest's `apiVersion`, or a `deep-review` floor applies. This verdict was
   called `needs-claude` until the labels PR; `schema.sql` moved the stored rows
   and reasons, and `needs_claude_packages` is now an unknown key.
3. **review**: R1, R2 or R6 flagged, a required check didn't run, or a `review`
   floor applies.
4. **low-risk**: only when R1 is digest, patch or minor on an `apps/` image or an
   ungated chart, R2 is one version line, R3 and R5 are clear, R4 and R8 pass where
   they apply, and R6 has no hits.

**Path-class overrides.** `path_class_overrides` lets named updates pass R2
outside `apps/`. An entry names a package, its datasource, the path class
(`infrastructure` or `other`, never `clusters/` or `gotk-components`) and the
update types (never `major`). It lifts only R2's path reason: the change must
still be one version line in one file, and every other check applies as usual.
The Tailscale operator chart's patch and minor bumps are the one override today.
Its majors stay gated by the Helm-major rule in R3. R2's evidence records the
override it used.

**Floors.** A floor caps how good a verdict can be. `review_floor_packages` never
come out better than `review` (n8n today, whose majors still go to
`deep-review` through R3). A dependant can carry its own floor. A floor joins the
reasons at its own level, so it can make a verdict worse, never better.

**Dependants.** `dependants` lists things outside the repo that depend on a
package. Each entry has an `id`, `where` it lives, what to `check`, and an
optional `floor`. Every matching entry goes into the verdict's reasons, as
`dependant <id> (<where>): <check>`, so the review knows what to look at. The
names are generic, because this repo is public. Details of what depends on what
stay in the private records.

**Non-Renovate PRs** (author not in `renovate_logins`) are triaged by hand. Only
R9 runs, and the others are `not_run`, not required. The verdict is **human**,
inserted with `finalised_at` set, so no later ruleset re-triages it. An R9 hit
makes it **blocked**, not finalised. If R9 couldn't run (for example, no redaction
patterns loaded), the verdict is still `human` but left unfinalised, so a later
ruleset checks it again.

`config.yaml` is validated on load. An unknown key, an invalid package name, an
override naming a chart with no `helm_index` entry, or a floor that isn't
`review` or `deep-review` fails the run. A test checks that every package these
keys name is an image or chart in the repo.

**API-version changes.** Renovate's `kubernetes-api` updates move a manifest from
one API version to another, such as `notification.toolkit.fluxcd.io/v1beta3` to
`v1`. Its table calls that a patch, but no package version changes, and a schema
can drop or rename fields between versions. R1 classifies the change as
`api-version` and passes when the table names the same move. The verdict is
deep-review, with the API group and versions in the reasons.

Release notes come from the section Renovate writes into the PR body. If Renovate
found none, R6 records that and passes.

**Negative control.** Every run checks R4 against a synthetic chart requiring
`kubeVersion >=99`. It must come back `fail`. If it doesn't, the run is recorded with
`ok = false`, and the heartbeat ignores it.

### write_mode

`triage/config.yaml` has `write_mode: off | labels`, default `off`. It's a reviewed
value: changing it is a PR.

- **off** (shipped): every run plans what it would publish and stores it in
  `triage.publications.planned`, then sets `runs.publish = 'planned-only'`. No
  node calls a source-host write endpoint, and the App's key is never used.
- **labels**: the planned writes run, through the GitHub App.

#### What each open PR gets

One `triage:<verdict>` label, one triage comment, and one `pr-triage/verdict`
commit status on the head commit. The App writes all three. These are the only
labels it ever adds or removes:

| Verdict label | Meaning | Status | Next move |
| --- | --- | --- | --- |
| `triage:low-risk` | The merge signal | `success` | A person merges |
| `triage:review` | Needs a review | `pending` | Merge, or escalate to deep-review |
| `triage:deep-review` | Needs a deep review | `pending` | Merge, or hand to a person; never back to review |
| `triage:human` | A person decides | `pending` | A person merges or applies a merge label |
| `triage:blocked` | Blocked | `failure` | No further action on this commit |

Outcome labels: `merge` and `merge-watched`. The App never adds them; it removes
them when the verdict changes or the head SHA moves. Closing a PR is valid from
every state. n8n never merges or closes anything. `rules.js` pins all seven names,
so a config edit can't point a write at another label.

**Automation only escalates.** On one head SHA the order is low-risk, review,
deep-review, human, blocked. When a new ruleset gives a less severe verdict than
the one published, the published one stays, and the comment says it was held.

#### Identities

| Identity | Does |
| --- | --- |
| The read-only token (`github-token`) | Every read in the poll and the watcher |
| The GitHub App's installation token | Every write: labels, comments, statuses. Nothing else writes |
| The bot account | Nothing here. It opens PRs in this repo, and applies no labels. The watcher reads its login (`GET /user` with the read-only token) only to accept its fix-forward marker |

The App's slug is `app_slug` in `triage/config.yaml`, and its actor login is
`<app_slug>[bot]`. Label events name only the actor, so that login is how the
App's own label events are told apart from a person's, in every `write_mode`:
`off` already plans with it, so the plan is right before the App has ever
written. A comment is the App's when its author is that login and
`performed_via_github_app.slug` is `app_slug`. Nothing learns the login from a
write response, and the database doesn't store it.

#### Human override

A triage or outcome label added or removed by anyone but the App, as the PR's
label events show, is an override **for that head SHA**. From then on n8n doesn't
add, remove or change triage labels on that SHA, and sets no status. A ruleset
change only edits the comment. `triage.publications.human_override` is set, with
the actor and label as evidence. The actor stays in the database, never in the
comment. A new head SHA ends the override.

Events belong to a head SHA from the later of the last time the poll saw another
head SHA of the PR and the latest force push. Earlier events belong to an earlier
commit.

#### Re-triage and the commit binding

Everything is keyed to `(repo, pr, head_sha)`. The comment starts with
`<!-- pr-triage:v1 sha=<head> ruleset=<rs> verdict=<v> -->`, and the status is set
on that commit, so a verdict never outlives the commit it judged. A re-triage
happens on a new head SHA or a new ruleset:

- **Changed verdict:** swap the label, remove `merge` and `merge-watched`, post a
  new comment, set the status.
- **Same verdict:** edit the existing comment in place and re-set the status. No
  label change.
- **New head SHA:** remove the verdict and outcome labels, then triage fresh. The
  override ends.

An unchanged PR under unchanged rules makes no write at all.

The comment is built from fixed templates only. A reason that fits none shows as
`other reason (see triage.verdicts)`, and PR references are written without `#`.
The comment and status text go through the redaction patterns, and a hit
publishes nothing for that PR.

**Fail safe.** A run publishes nothing when the negative control isn't `fail`,
the cluster version couldn't be read (so R4 can't run), or no redaction patterns
loaded. A PR whose label events or comments couldn't all be read is skipped. A
failed write is recorded, never retried in the same run, and never blocks a PR.
The run clears its ETags, so the next run reads every PR again and plans from
what was last published. The published columns change only once every write of a
plan read back as sent.

#### Where the writes are

All writes live in the sub-workflow `PR triage: publish`
(`workflows/triage-publish.json`, ID `TriagePublishV01`). It saves no executions of
any kind, and only the poll and the watcher may call it
(`callerPolicy: workflowsFromAList`), each only through its own `Write gate`. Each
call carries one write. It signs a JWT with n8n's JWT node (RS256, the key from the
`jwtAuth` credential overwrite) and calls `GET /app` with it. If that App's `slug`
isn't `app_slug`, it stops there: no token, no write, and the PR's outcome is
`failed`, so the run is `ok = false`. Otherwise it exchanges the JWT for an
installation token scoped to this repository, makes the write, reads it back and
returns only statuses and IDs. The token never leaves it.

`sync-code-nodes.js` enforces the allowlist. Each write must match its template
exactly: method, URL, body and headers.

| Write | Node |
| --- | --- |
| `POST /app/installations/{id}/access_tokens` | Installation token |
| `POST /repos/{r}/labels` | Create label |
| `POST /repos/{r}/issues/{n}/labels` | Add label |
| `DELETE /repos/{r}/issues/{n}/labels/{name}` | Remove label (rule-1 names only) |
| `POST /repos/{r}/issues/{n}/comments` | Create comment |
| `PATCH /repos/{r}/issues/comments/{id}` | Edit comment (body only) |
| `POST /repos/{r}/statuses/{sha}` | Set status |
| `POST /repos/{r}/labels` | Create watch label (R10's three `rollout:` labels only) |
| `POST /repos/{r}/issues/{n}/labels` | Add watch label (R10's three `rollout:` labels only) |

It refuses any other non-GET request in the sub-workflow, any GitHub write
outside it, a call into it that doesn't come through a `Write gate` true output,
a Code node there that could make a request, and any execution saving there.

#### `runs.publish`

| Value | Meaning |
| --- | --- |
| `planned-only` | `write_mode` is `off`. The plans are in `triage.publications` |
| `skipped-unhealthy` | Fail safe: nothing published |
| `no-op` | Nothing to write |
| `published` | Every planned write read back as sent |
| `redaction-hit` | At least one PR's comment hit a pattern and was not published |
| `failed` | A write or its readback failed, or `GET /app` named a different App. The run is `ok = false` |

Per PR, `triage.publications.outcome` is `planned-only`, `publishing`, `published`,
`failed`, `up-to-date`, `redaction-hit` or `skipped-<reason>`.

#### The GitHub App

Created by hand under the owner's account, installed on this repository only. No
webhook, no events. Permissions, checked against GitHub's
"Permissions required for GitHub Apps":

- **Pull requests: write**, for labels (create, add, remove) and comments on PRs.
  The issues endpoints accept Pull requests or Issues, so Issues: write also
  works and isn't needed besides.
- **Commit statuses: write**, for `POST /repos/{r}/statuses/{sha}` and the
  readback.
- **Metadata: read**, which every App has.

The installation token asks for issues, pull requests and statuses (write) and
metadata (read), scoped to this one repository.

Three fields in the 1Password item `n8n`: `github-app-id`,
`github-app-installation-id` and `github-app-private-key-b64` (see
[Secrets](#secrets)). Rotating the key is a 1Password change plus a pod restart.
The App's slug is `app_slug` in `triage/config.yaml`; renaming the App needs a PR
changing it, or every write fails at the `GET /app` check.

#### Turning it on, and off

On: a one-line PR setting `write_mode: "labels"` in `triage/config.yaml`. That
changes the ruleset, so the next run re-triages and publishes every open PR. Each
gets one label, one comment and one status. The run after that makes no writes.

Off: a one-line PR setting `write_mode: "off"`. Labels, comments and statuses
already written stay. This is fix-forward. Don't revert the labels PR: its
migration moved the stored verdicts.

### Reading verdicts

```sh
kubectl -n tools exec deploy/n8n-db -- psql -U n8n -d n8n -c \
  "select pr, verdict, reasons, ruleset, finalised_at, created from triage.verdicts order by created desc limit 20;"
kubectl -n tools exec deploy/n8n-db -- psql -U n8n -d n8n -c \
  "select id, started, finished, pr_count, negative_control, ok, publish, ruleset from triage.runs order by id desc limit 10;"
kubectl -n tools exec deploy/n8n-db -- psql -U n8n -d n8n -c \
  "select pr, left(head_sha, 12), verdict, label, status_state, human_override, outcome, planned_at from triage.publications order by planned_at desc limit 20;"
kubectl -n tools exec deploy/n8n-db -- psql -U n8n -d n8n -c \
  "select c->>'id' as check, c->>'result' as result, c->'evidence'->>'source_url' as source, c->'evidence'->>'etag_or_sha' as etag
     from triage.verdicts v, jsonb_array_elements(v.checks) c where v.pr = <number> order by v.created desc limit 9;"
```

A run with `finished` empty failed partway. Its execution is in the n8n UI under
Executions.

### Rulesets and re-triage

Each verdict records the ruleset that produced it:
`r<sha256(rules.js)[:12]>.c<sha256(config.yaml)[:12]>`. The `triage-schema`
initContainer loads both files into `triage.config` with their hashes, and Start
run builds the ruleset from them. `sync-code-nodes.js` keeps the Triage node's copy
of `rules.js` identical to the file, so the hash names the code that ran.

Verdicts are keyed by `(repo, pr, head_sha, ruleset)`. A head SHA counts as done
when it has a verdict under the current ruleset, or a finalised verdict under any
ruleset. So:

- A Renovate rebase gets a new verdict.
- An unchanged PR under unchanged rules is never re-triaged.
- A merged change to `rules.js` or `config.yaml` re-triages every open PR on the
  next run after the pod restarts, `per_run_cap` at a time. PR-list ETags are
  stored per ruleset, so a `304` from the old one can't hold that back.
- Older verdicts stay as history. Rows from before rulesets have an empty
  `ruleset`.

**Carried rows.** When a new ruleset gives the same verdict and the same result
for every check as the latest row for that head SHA, the new row is *carried*: it
stores the verdict and reasons, `checks` is NULL, and `carried_from` names the full
row that holds the checks. A carried row's `carried_from` is always a full row,
never another carried row. Any changed result is recorded in full. Start run reads
the latest row per head SHA for the comparison. A carried row still counts as a
verdict under its ruleset, so each PR is evaluated once per ruleset.

```sh
kubectl -n tools exec deploy/n8n-db -- psql -U n8n -d n8n -c \
  "select v.pr, v.verdict, v.ruleset, v.carried_from, coalesce(v.checks, src.checks) is not null as has_checks
     from triage.verdicts v left join triage.verdicts src on src.id = v.carried_from
     order by v.created desc limit 15;"
```

With `write_mode: "labels"`, a new ruleset that gives the same verdict edits the
comment in place and re-sets the status, and never changes a label. See
[Re-triage and the commit binding](#re-triage-and-the-commit-binding).

To stop a head SHA being re-triaged, finalise its verdict:

```sh
kubectl -n tools exec deploy/n8n-db -- psql -U n8n -d n8n -c \
  "update triage.verdicts set finalised_at = now() where pr = <number> and head_sha = '<sha>' and finalised_at is null;"
```

To re-triage a PR under the current ruleset, delete its verdict rows for that
ruleset. A full row that a carried row names can't be deleted until the carried
row is.

### Redaction patterns

`REDACTION_PATTERNS` holds one pattern per line. Blank lines and lines starting with
`#` are skipped. A line written `/.../` is a case-insensitive regular expression, and
anything else is a case-insensitive substring. The `triage-schema` initContainer
replaces the table contents on every pod start, so after changing the 1Password
field, restart the pod. The patterns appear in the poll workflow's execution data,
which n8n users can see.

## R10: post-merge watch

`PR triage: post-merge watch` (`TriageWatch00001`) runs every 5 minutes. It is
alert-only: nothing reverts anything.

**What's watched.** Every merge to the default branch, whoever merged it. The
watcher lists closed PRs (`sort=updated`, with an ETag) and takes merges newer than
`triage.watch_cursor`. Its first run starts an hour back. For each merge, using the
merge commit SHA, `planWatch` reads the changed files (at the merge commit) and
picks targets:

- the Flux Kustomization that applies each changed path, from
  `watch_kustomizations` in `config.yaml` (longest prefix wins; a test checks it
  against every Flux Kustomization in the repo);
- each changed HelmRelease, at its new chart version;
- each Deployment or StatefulSet whose `image:` changed. An image change in any
  other kind gets only the Kustomization check, and a note.

A merge with no target (docs only, say) is `ok` at once.

**Pass, fail, timeout.** Each run checks each pending watch through
`TriageClusterV01`:

| Target | ok when |
| --- | --- |
| Kustomization | `lastAppliedRevision` is the merge SHA or a later commit that includes it (compare API `identical` or `ahead`), and `Ready` isn't `False` |
| HelmRelease | `history[0]` is the new chart version, `deployed`; `Ready` isn't `False`; `observedGeneration` current |
| Deployment, StatefulSet | generation observed, every replica updated and ready, the new image in the spec |

`failed` needs the same failing condition on two checks in a row: a Kustomization
`Ready=False` (not `Progressing` or `DependencyNotReady`) at a revision with the
merge, a HelmRelease install or upgrade failure on the new version, a Deployment
past its progress deadline, or a target that's gone. `timeout` is
`watch_timeout_min` (30) after the merge. Rows are in `triage.watches`.

`Ready=Unknown` with the revision already applied is a pass. Flux sets it for
the few seconds each reconcile takes, and the watcher and Flux both run every 5
minutes, so a check can land in that window every time.

**Fix forward.** A failure is fix-forward, and its comment says "Fix forward —
no revert", when the change is one-way, or the PR says so:

- a line `rollback: fix-forward` (case-insensitive, its own line, not in a code
  block or a quote) in the PR description, a review or a comment, written by the
  App, the bot (the read-only token's own login) or the repository owner. Logins
  are read at run time; none is in Git;
- a change to a YAML manifest (not docs, code, or YAML under `fixtures/`) that
  is one-way: an `image:` line for a `fix_forward_packages` package (InvenTree)
  added or removed, or a changed `tag:` under its `repository:`; a Postgres image
  whose major changes; a changed `spec.version` in a k3s Plan; a changed chart
  version in the Longhorn HelmRelease; or a removed `kind: PersistentVolumeClaim`
  document. Naming a package anywhere else doesn't count.

**Shared failures.** A Kustomization failing at revision R fails every pending
watch whose merge R includes, so one failure can't be pinned on one of them. When
a watch finishes (`failed` or `timeout`) and another watch fails on the same
Kustomization at the same revision in that run, they finish together, as one
group: `triage.watches.failure_group` holds `kustomization <name>@<sha>` for each.
A watch failing only on its own HelmRelease or workload has no group. A group of
one is attributed like any other failure.

**Already failing.** A merge whose failing target was already failing from an earlier merge (`triage.watches.preexisting`) joins that failure's group as `rollout:investigate` (fix-forward still wins), and its comment names the earlier PR.

**What it publishes.** Nothing on `ok`: no label and no comment. The row still
records `ok`. On `failed` or `timeout`, exactly one of these labels:

| Label | When | What to do |
| --- | --- | --- |
| `rollout:revert` | attributed to this merge, not fix-forward | Revert by hand: no automated merger made the merge, so nothing reverts it |
| `rollout:fix-forward` | attributed to this merge, fix-forward | Fix forward; never revert |
| `rollout:investigate` | a shared failure (a group of two or more) | Find which merge broke it; a fix-forward member still isn't reverted |

The watcher creates them if missing (`b60205`, `d93f0b`, `fbca04`). Each failed PR
also gets one App comment marked
`<!-- pr-triage-watch:v1 sha=<merge> status=<status> -->`, listing what didn't
roll out. For a shared failure it lists every PR in the group with its merge SHA,
and the failing Kustomization, revision and condition.

One Home Assistant alert goes through `TriageAlertV01` per attributed failure, and
one per group (sent for its lowest watch id):

```json
{"source": "pr-watch", "pr": 287, "prs": [287], "status": "failed", "action": "revert", "fix_forward": false, "checked": "<ISO-8601 UTC>"}
```

`action` is `revert`, `fix-forward` or `investigate`. `prs` lists the PR numbers,
one for an attributed failure; `pr` is the first of them. `fix_forward` is true
if any PR in it is. No URL, name or cluster detail goes in it.

There is never a second comment for one merge SHA, and never an alert on `ok`.
The watcher only reads the fix-forward marker; the triage comment doesn't mention
it. The old `triage:post-merge-*` labels stay on the PRs that have them; the
watcher no longer writes them.

**`watch_write_mode`** in `config.yaml` is `labels` (on since the R10 shadow run) or `off`. `off`
records each plan in `triage.watches.planned_actions` and writes nothing, sends no
alert, and doesn't revisit the watch. `labels` writes and alerts, and needs
`write_mode: "labels"` too. Turning it on is a one-line PR; watches planned under
`off` stay as they are. Like any `config.yaml` change, it re-triages open PRs (see
[Rulesets and re-triage](#rulesets-and-re-triage)).

**Idle runs are cheap.** With no new merge and nothing pending or to publish, a run
makes one request, the listing, usually a `304`. Each run is a row in
`triage.watch_runs`, and the heartbeat reports the last ok one.

```sh
kubectl -n tools exec deploy/n8n-db -- psql -U n8n -d n8n -c \
  "select pr, left(merge_sha, 12), status, fix_forward, failure_group, targets, planned_actions->>'rollout_action', publish_outcome, alert_status from triage.watches order by created_at desc limit 10;"
```

## R11: rendered-chart diff

`flux diff` sees a HelmRelease's version line, not what the chart renders. R11
renders the old and the new chart with the repo's values, and classifies the
difference. The poll queues, a CronJob renders, `rules.js` classifies.

**Queue.** When the poll triages a PR whose R1 change is a HelmRelease chart
version, it reads the HelmRelease file at the head commit (public raw URL) and
inserts one `triage.render_requests` row per release (`Queue render`,
`ON CONFLICT DO NOTHING` on `(repo, pr, head_sha, path, release)`). The row
holds the chart, both versions, the repository URL from `helm_index`, the
cluster version R4 read, and the release and namespace resolved the way Flux
does: `releaseName`, else `<targetNamespace>-<name>`, else the name; the
namespace is `targetNamespace`, else the Flux Kustomization's, else the
object's. A chart with no `helm_index` entry or an OCI source is inserted as
`unsupported`. A file that can't be read, or no cluster version, inserts
nothing, and R11 says why.

**Render.** `CronJob triage-render` (every 5 minutes, one at a time, 10-minute
deadline) runs `triage/render.sh` in the Postgres image, with static `helm` and
`yq` copied in by two initContainers. It logs in as `triage_render`, claims up
to 3 pending requests (`FOR UPDATE SKIP LOCKED`, `attempts + 1`) and for each:

1. fetches the HelmRelease at the head commit and finds the matching document;
2. stops at `valuesFrom` or `postRenderers` (`unsupported`);
3. takes `spec.values` and replaces every `${VAR}` with `subst-<var>`, so no
   resolved value enters the job or the database;
4. pulls each chart version, records the `.tgz` SHA-256 and `appVersion`, and
   runs `helm template --include-crds --skip-tests --kube-version <cluster>`;
5. stores both renders as JSON arrays in `triage.renders` (over 8 MiB is
   `failed`) and marks the request `done`.

An error marks it `failed` with an error code. A fetch or pull error is
retried until 3 attempts. The new chart failing to render where the old one
rendered keeps the old render: that is a finding, not a miss. The job logs one
line per request, never values. It mounts no service-account token, runs
non-root on a read-only root filesystem, and has no cluster credentials.

`triage_render` is a login role with the same hardening as `triage`, limited
to 2 connections. It has `SELECT, UPDATE` on `render_requests` and `INSERT` on
`renders`, and nothing else: no `DELETE`, no other table.

**Classify.** The poll's `Renders` node reads each open PR's requests and
renders. `classifyRender` keys objects by `apiVersion/kind/namespace/name` and
drops noise: the `helm.sh/chart`, `app.kubernetes.io/version` and `chart`
labels, `checksum/*` annotations, and an image tag that moves exactly from the
old `appVersion` to the new one. Then:

| Difference | Level |
| --- | --- |
| A CRD added, removed, or with a changed spec | `deep-review` |
| A Service's type, ports (port, targetPort, protocol, nodePort) or selector | `deep-review` |
| A kind added or removed, a new image, another pod-template change, the new chart failing to render, or any other change | `review` |
| Nothing left | `clean` |

Findings name kinds and counts only, never a rendered value, because they
reach a public comment. The `R11` check records the request ids, both chart
digests and the classification. Pending, `failed` and `unsupported` are
`not_run` with the reason.

**In the comment.** The triage comment gets one line, built from fixed
templates and checked by the redaction filter with the rest of the comment:
`R11 (shadow, not used): <level> — <findings>`, or `not run yet` / `not run`
with a reason. A render usually finishes after the PR was triaged, so the line
is worked out on every run that reads the PR, and the comment is edited in
place when it changes. A render that finished since the last run makes the next
run skip the PR-list ETag, so it reads every PR. The plan stores the result
(`publications.planned.r11`), and `Renders` sends the rendered objects only
while no plan holds the result under the current ruleset, so each render is
read about once.

**`r11_mode`** in `config.yaml`:

- `shadow` (shipped): the line is shown, and the verdict is computed exactly as
  without R11.
- `on`: a `review` or `deep-review` result raises the verdict to that level,
  never lowers it. A render that finishes after triage raises the published
  verdict on the next run, like any escalation. Not run changes nothing.

Turning it on is a one-line PR, and re-triages open PRs like any `config.yaml`
change.

**Testing a render locally.** `RENDER_DRY_RUN=1 RENDER_REQUESTS=<file> sh
triage/render.sh` takes one request per line as JSON, skips the database, and
prints each result (status, digests, `appVersion`s and both renders) as one JSON
line, ready for `classifyRender`. It needs `helm`, `yq` and `wget`, and no
database.

**Rollback** is `git revert`: the CronJob, its Secret and its network policy
are pruned. The tables and the role stay behind, unused.

## Rules drift

`config.yaml` mirrors `renovate.json` by hand: `gated` mirrors
`dependencyDashboardApproval`, `caps` mirrors `allowedVersions` (`<X` only),
`one_minor_per_pr` mirrors `separateMultipleMinor`, and `groups` mirrors
`groupName` (name and packages; the branch is config's own). A Renovate rule
added without its mirror would leave R3 and R5 judging against stale rules.
`deriveRenovateRules` in `rules.js` maps `renovate.json` to the config's shape,
and `compareRules` compares the two per section, as sets. Each difference is
`missing-in-config`, `missing-in-renovate`, or `unmappable`: an option or
matcher the mapping can't express (a regex package name, another
`allowedVersions` form, an unknown option or top-level key). Nothing is dropped
silently. Drift is advisory: no verdict reads it.

**`drift_ignore`** in `config.yaml` lists what has no mirror on purpose, each
with a one-line reason. An entry names a packageRule by its `match*` keys and
values (not its position or description), optionally narrowed to some of its
options with `keys`, or a top-level key with `top_level`. An entry that matches
nothing is reported as stale. Changing a rule's matchers makes it a new rule,
so its ignore stops matching and the drift shows.

It is checked in three places:

- **Tests.** `rules.test.js` compares the repo's two files and fails on any
  item or stale ignore. A Renovate rule change needs its mirror, or a
  `drift_ignore` entry, in the same PR.
- **The PR comment.** For an open PR whose changed files include either file,
  the poll reads both at the head commit (public raw URLs) and adds one line
  to the triage comment: `Rules drift: none`, `Rules drift: <n> item(s) —
  <first 3>…`, or `not checked` with a reason. Fixed templates, through the
  redaction filter with the rest of the comment. Other PRs get no line.
- **Live, on the default branch.** Once per poll run, `Get renovate.json` reads
  the file through the contents API, conditional on the last ETag, so it is
  usually a 304. The ETag is sent only while the loaded config is the one it
  was last compared with. A new blob, or a new loaded config, is compared with
  the **loaded** config (`triage.config`, not the file in Git). The run records
  the result in `triage.runs.drift`, and the `rules-drift` row of
  `triage.heartbeat` keeps the blob SHA, ETag, result and last alert in
  `detail`. A drifting result for a new (blob, config) pair calls
  `TriageAlertV01` once with `{source: "rules-drift", drift: true, items,
  keys (first 5), sha (short)}`. A later clean result sends one `drift: false`
  recovery. The alert counts as sent only on a 2xx, so a failed one is sent
  again on the next run. A failed read records `drift: null`, keeps no ETag,
  never alerts and never fails the run. The Home Assistant receiver for
  `rules-drift` lives outside this repo.

**Rollback** is `git revert`: `runs.drift` and `heartbeat.detail` (and the
`rules-drift` row) stay behind, unused.

## Upgrades

- The n8n image is pinned to an exact version, and Renovate bumps it after a 7-day
  release age, in a weekly window. n8n runs its own database migrations on start.
- n8n majors are held for approval on the Dependency Dashboard, and the triage
  config mirrors that gate.
- The `import-workflows` initContainer uses the same image as n8n, so both bump in
  one PR.
- Postgres majors are held for approval on the Dependency Dashboard. A major needs
  a dump and restore; [db-backup.md](db-backup.md) has the dump and the restore.

## Not declarative

- The owner account: datastore state, protected by the volume backups.
- Workflows or credentials created in the UI and not committed (see
  [Workflows from Git](#workflows-from-git)).
- The verdict and run history in the `triage` schema. It's a working record, and
  re-polling rebuilds it for open PRs. A `finalised_at` set by hand isn't rebuilt;
  the volume backups hold it.
- The DNS record on both local DNS resolvers.
- The Home Assistant side of the [dead-man](#dead-man): the webhook receiver,
  the watchdog and the notification, built by hand in Home Assistant.
- The GitHub App, its permissions and its installation: created by hand. Its
  identifiers and key are in 1Password, and its slug is in `config.yaml`.
- `triage.publications`. Like the verdicts, a working record: the labels,
  comments and statuses on GitHub are the visible state, and the next run plans
  from what it reads there.
- `triage.watches`, `triage.watch_cursor` and `triage.watch_runs`: the watcher's
  working record. A lost cursor restarts the watch an hour back.
- `triage.render_requests` and `triage.renders`: R11's working record. A lost
  request is queued again the next time the PR is triaged.
