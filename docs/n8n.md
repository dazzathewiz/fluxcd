# n8n

A self-hosted n8n instance in the `tools` namespace, with its own Postgres. It
runs automated triage of dependency-update PRs. Triage runs in **shadow mode**: it
reads PRs and records a verdict for each one in Postgres, and writes nothing to the
source host. See [PR triage](#pr-triage-shadow-mode) below.

## What's deployed

All manifests are in `apps/tools/n8n/`. The top-level `apps` Kustomization picks
them up.

| Object | Purpose |
| --- | --- |
| `Deployment n8n` | One replica, `Recreate`, runs as UID/GID 1000. `/home/node/.n8n` is on PVC `n8n-data` (1Gi). Binary data is on a 16Mi memory-backed `emptyDir`. |
| `Deployment n8n-db` + `Service n8n-db` | Postgres 17, database and user `n8n`, data on PVC `n8n-db` (5Gi). No service-account token mounted. |
| `ConfigMap n8n-env` | Non-secret env only: database coordinates, public URL, proxy hops, timezone, telemetry off, community packages off, env access from nodes blocked, execution pruning after 14 days. |
| `ConfigMap n8n-workflows-<hash>`, `n8n-triage-<hash>`, `n8n-credentials-<hash>` | Generated from `workflows/`, `triage/` and `credentials/`. A change to any file changes the hash, which rolls the pod. See below. |
| `ExternalSecret n8n-secrets` | Every secret value. See below. |
| `Service n8n` + `IngressRoute n8n` | ClusterIP on 5678, routed at `n8n.inf.${PERSONAL_DOMAIN}` on `websecure` with the wildcard `.inf` certificate and the namespace's `default-headers` Middleware. |
| `ServiceAccount n8n` + `ClusterRoleBinding n8n-view` | Read-only cluster identity. See below. |
| `NetworkPolicy n8n`, `NetworkPolicy n8n-db` | Network isolation. See below. |

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

All four fields must exist before the ExternalSecret syncs. The ExternalSecret
also templates two more keys. `CREDENTIALS_OVERWRITE_DATA` is built from
`github-token` and `db-password`, and `TRIAGE_DB_PASSWORD` is derived from
`db-password`. It uses `mergePolicy: Merge` so the plain keys stay alongside them.
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
  - Anything outside `10.0.0.0/8`, `172.16.0.0/12` and `192.168.0.0/16`
- **n8n-db:** ingress on 5432 from `n8n` only. Egress is DNS only.

So n8n can reach the internet and the k3s API, and it can't reach anything else on
the LAN or in the cluster.

**The API addresses are literal IPs.** No cluster var holds them. Rebuilding or
re-addressing a control-plane node means updating this policy, and the symptom of
a stale entry is API calls from n8n timing out.

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

1. `n8n import:credentials --separate` for the two credential records in
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
APIs, with network access passed in. The poll workflow has one Code node, `Triage`,
which carries a verbatim copy between `BEGIN rules.js` / `END rules.js` markers,
followed by a short driver. Every other node only reads data and passes it on. Before
pushing a change to either:

```sh
node --test apps/tools/n8n/triage/                     # fixtures and rule tests
node apps/tools/n8n/triage/sync-code-nodes.js --write  # copy rules.js into the Code node
node apps/tools/n8n/triage/sync-code-nodes.js          # check: exits 1 on drift
```

The check also fails if a workflow carries more than one copy, or if any non-GET
source-host request sits outside the `Write gate` node. The tests include drift
checks of `triage/config.yaml` against `renovate.json` and against the
HelmRepositories in this repo, so a change to either needs the config updated in the
same PR.

## Credential overwrites

The workflows use two stored credentials, a `githubApi` and a `postgres`, imported
from `credentials/` with every secret field empty. n8n fills empty fields at run
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
| `triage.heartbeat` | `SELECT`, `INSERT`, `UPDATE` | heartbeat upsert |
| the two `id` sequences | `USAGE` | inserts |

No `DELETE`, no DDL, and nothing in `public`, where n8n's tables live and where
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

## PR triage (shadow mode)

`PR triage: poll` runs every 15 minutes:

1. **Start run** works out the [ruleset](#rulesets-and-re-triage), inserts a
   `triage.runs` row, and reads the config, the redaction patterns, the PR-list
   ETags stored under this ruleset and the PRs already triaged under it. It lists the
   repos from the one-line `repos: [...]` in `config.yaml`.
2. **Get dashboard** reads the Dependency Dashboard issue.
3. **List PRs** sends `If-None-Match`. A `304` means nothing changed.
4. **One item per PR**, **Get PR** and **Get files** read each open PR. When the
   list is unchanged or empty, one placeholder item goes through instead and the two
   reads hit `/rate_limit`, which costs no quota. These reads are the only ones that
   carry the source-host credential, and only to `api.github.com`.
5. **Cluster version** calls the `PR triage: cluster version` sub-workflow once,
   which returns the live `/version` response. See
   [Cluster version](#cluster-version).
6. **Triage**, the only Code node, parses the config and checks it lists the same
   repos, and runs the negative control against that response. It keeps PRs whose
   `head_sha` has no verdict under this ruleset and no finalised one, oldest first, up to `per_run_cap`. Then it fetches
   the Helm index and registry manifests and runs R1–R9.
7. **Insert verdict**, then the **Write gate**.
8. **Finish run** records the PR count, the negative-control result and the ETags.

So when the PR list changes, every open PR's detail and files are read, and only
the new head SHAs are triaged. A failed read of a PR being triaged fails the run;
the run stays unfinished, no ETag is stored, and the next run retries.

`PR triage: heartbeat` runs every 30 minutes and writes the last successful run time
to `triage.heartbeat`. Its alert node is disabled until the alerting phase.

### Cluster version

R4 and the negative control compare charts against the live cluster version.
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
  the token is read only in the sub-workflow `PR triage: cluster version`
  (`workflows/triage-cluster-version.json`). It reads the token file, turns it
  into text and sends `GET /version` with `Authorization: Bearer`. It saves no
  executions, successful, failed or manual. Its last node is the HTTP request,
  whose output holds only the status and body. That matters because n8n copies a
  sub-workflow's last-node binary data into the caller.
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

The first matching verdict wins:

1. **blocked**: R4, R5, R8 or R9 failed.
2. **needs-claude**: R3 flagged, the package is in `needs_claude_packages`, the
   change touches CRDs, it touches `clusters/` or `gotk-components`, it moves a
   manifest's `apiVersion`, or a `needs-claude` floor applies.
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
`needs-claude` through R3). A dependant can carry its own floor. A floor joins the
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
`review` or `needs-claude` fails the run. A test checks that every package these
keys name is an image or chart in the repo.

**API-version changes.** Renovate's `kubernetes-api` updates move a manifest from
one API version to another, such as `notification.toolkit.fluxcd.io/v1beta3` to
`v1`. Its table calls that a patch, but no package version changes, and a schema
can drop or rename fields between versions. R1 classifies the change as
`api-version` and passes when the table names the same move. The verdict is
needs-claude, with the API group and versions in the reasons.

Release notes come from the section Renovate writes into the PR body. If Renovate
found none, R6 records that and passes.

**Negative control.** Every run checks R4 against a synthetic chart requiring
`kubeVersion >=99`. It must come back `fail`. If it doesn't, the run is recorded with
`ok = false`, and the heartbeat ignores it.

### write_mode

`triage/config.yaml` has `write_mode: off | digest | labels`, default `off`. It's a
reviewed value: changing it is a PR. With `off`, no node calls any source-host write
endpoint, and today there are none to call. Every future write node goes after the
`Write gate` node's true output, and `sync-code-nodes.js` refuses a write that isn't.

### Reading verdicts

```sh
kubectl -n tools exec deploy/n8n-db -- psql -U n8n -d n8n -c \
  "select pr, verdict, reasons, ruleset, finalised_at, created from triage.verdicts order by created desc limit 20;"
kubectl -n tools exec deploy/n8n-db -- psql -U n8n -d n8n -c \
  "select id, started, finished, pr_count, negative_control, ok, ruleset from triage.runs order by id desc limit 10;"
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

When `write_mode` publishes, it should publish only when a verdict changes, and
never re-label or re-comment because the ruleset changed.

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

## Upgrades

- The n8n image is pinned to an exact version, and Renovate bumps it after a 7-day
  release age, in a weekly window. n8n runs its own database migrations on start.
- n8n majors are held for approval on the Dependency Dashboard, and the triage
  config mirrors that gate.
- The `import-workflows` initContainer uses the same image as n8n, so both bump in
  one PR.
- Postgres majors are held for approval on the Dependency Dashboard. A major needs
  a dump and restore.

## Not declarative

- The owner account: datastore state, protected by the volume backups.
- Workflows or credentials created in the UI and not committed (see
  [Workflows from Git](#workflows-from-git)).
- The verdict and run history in the `triage` schema. It's a working record, and
  re-polling rebuilds it for open PRs. A `finalised_at` set by hand isn't rebuilt;
  the volume backups hold it.
- The DNS record on both local DNS resolvers.
