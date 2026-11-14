# n8n

A self-hosted n8n instance in the `tools` namespace, with its own Postgres. It is
the platform for automated triage of dependency-update PRs. This deployment is the
platform only. No workflows or source-host credentials are wired into n8n yet.

## What's deployed

All manifests are in `apps/tools/n8n/`. The top-level `apps` Kustomization picks
them up.

| Object | Purpose |
| --- | --- |
| `Deployment n8n` | One replica, `Recreate`, runs as UID/GID 1000. `/home/node/.n8n` is on PVC `n8n-data` (1Gi). |
| `Deployment n8n-db` + `Service n8n-db` | Postgres 17, database and user `n8n`, data on PVC `n8n-db` (5Gi). No service-account token mounted. |
| `ConfigMap n8n-env` | Non-secret env only: database coordinates, public URL, proxy hops, timezone, telemetry off, community packages off, env access from nodes blocked, execution pruning after 14 days. |
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
| `db-password` | `DB_POSTGRESDB_PASSWORD`, `POSTGRES_PASSWORD` | n8n and Postgres (one source, so they can't drift) |
| `github-token` | `GITHUB_TOKEN` | Not consumed yet |
| `redaction-patterns` | `REDACTION_PATTERNS` | Not consumed yet |

All four fields must exist before the ExternalSecret syncs.

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

## Upgrades

- The n8n image is pinned to an exact version, and Renovate bumps it. n8n runs its
  own database migrations on start.
- Postgres majors are held for approval on the Dependency Dashboard. A major needs
  a dump and restore.

## Not declarative

- The owner account and every workflow and credential: datastore state, protected
  by the volume backups.
- The DNS record on both local DNS resolvers.
