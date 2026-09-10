# AGENTS.md

Guidance for AI agents (and future humans) working in this repo. Written after the
changedetection.io deployment (PR #164) surfaced how much of this was discoverable in
the repo and the live cluster but not written down anywhere.

## Purpose and scope

This repo is the Flux GitOps state for a k3s cluster: Traefik, Longhorn, cert-manager,
1Password/External Secrets, Prometheus/Grafana, NUT, and the apps running on top of
all that. It has a sibling repo, `dazzathewiz/infrastructure` (Ansible, host/VM-level
config — the docker VM, Pi-holes, etc. that this cluster's apps sometimes need to talk
to). Changes that span both — e.g. a new app that needs a DNS record or a firewall
rule on the host side — should be treated as one piece of work, not committed as if
the other half doesn't exist.

## Read before you build

Model new work on the closest existing app rather than generic Kubernetes patterns.
Two good references:
- `apps/media/tautulli/` — a simple raw-manifest app (PVC + Deployment + Service),
  picked up directly by the top-level `apps` Kustomization.
- `apps/monitoring/grafana/app/` — a per-app Flux `Kustomization` (its own `app.yaml`
  with `postBuild.substitute`), used when an app needs its own variable substitution
  (e.g. a templated PV claim name). Most apps don't need this — default to the
  `tautulli` shape unless there's a concrete reason not to.

## Repo layout

`apps/`, `cluster/`, `cluster-config/`, `clusters/`, `docs/`, `global/`,
`infrastructure/`, `orchestration/`. Simple apps live at `apps/<group>/<app>/` and are
picked up by the single top-level `apps` Kustomization
([orchestration/apps.yaml](orchestration/apps.yaml)) — no per-app Flux Kustomization
needed unless you actually need per-app `postBuild.substitute` values.

## No CI

There are no GitHub Actions workflows in this repo. The PR is the only review gate.
Validation is local and manual — see below.

## Deploy and rollback — no manual apply, ever

- There is no staging cluster. `kubectl`/`flux` from a dev machine point at
  production.
- Pre-push validation: `kubectl kustomize apps/<group>` (pure local render, touches
  nothing) and `flux diff kustomization apps --path ./apps` (read-only server-side
  dry run against the live cluster — queries, doesn't apply). **The diff is the
  review gate, not a running pod.**
- Then: push → PR → merge → the `apps` Kustomization polls every 5 minutes
  (`interval: 5m`, `orchestration/apps.yaml`) and picks it up on its own.
- **A bad deploy is fixed by `git revert`, never by `kubectl apply -k` or
  `kubectl delete` used as a repair tool.** `prune: true` is set on the `apps`
  Kustomization, so a revert genuinely removes the objects Flux owns. A manual
  apply/delete creates or removes state Flux doesn't know about — the exact drift
  this cluster exists to avoid.
- Revert the commit, not the repo.
- **A build failure in one app fails the whole `apps` Kustomization's reconcile**:
  `kustomize build` renders the entire tree in one shot, so if any single manifest
  fails to build, nothing in that Kustomization gets applied or pruned until it's
  fixed — already-running workloads keep running, but every app under `apps/` stops
  receiving updates. This is standard Flux/kustomize behavior, not something tested
  by deliberately breaking prod; it's the reason the local build check matters.
- `flux` on PATH may be InfluxData's Flux (a homebrew formula name collision, hit
  2026-09-10). The real CLI is `brew install fluxcd/tap/flux`; if that collides,
  download the binary directly and invoke it by full path rather than fighting
  homebrew over the `flux` name.

## PVC reclaim policy: the manifests say `Retain`, the cluster does `Delete`

Every PVC manifest in this repo (`tautulli-config`, `organizr-data`,
`changedetection-data`, etc.) sets `persistentVolumeReclaimPolicy: Retain` directly on
the PVC spec. **This field does nothing.** `persistentVolumeReclaimPolicy` is not part
of `PersistentVolumeClaimSpec` in the Kubernetes API — it's silently accepted and
ignored. Confirmed live on 2026-09-10: every PV backing these PVCs actually has
`reclaimPolicy: Delete`, inherited from the `longhorn-diskencrypt-global` StorageClass
default, regardless of what the PVC manifest says.

Practical consequence: if a `git revert` (or any change) causes Flux to prune a PVC,
the underlying PV and Longhorn volume are deleted immediately — there is no
"Released" PV left over to recover from.

**This is acceptable, not a bug to rush and fix.** For a new app that fails and gets
reverted, the PVC only ever held that app's own fresh data — losing it on revert is
the desired outcome (fix the problem, redeploy clean, don't carry forward a half-baked
volume). For an app removed and cleaned up deliberately, Longhorn's recurring backup
retention already covers it. The reclaim policy written in the manifest doesn't do
anything, but the actual behavior it implies isn't needed for either of those cases.

**The genuine caveat is data migration**: if a PVC is ever seeded with pre-existing
data being migrated in (not just freshly generated by the app itself), a revert before
that data is captured by a Longhorn backup cycle would delete it with no recovery
path. Take an explicit Longhorn snapshot/backup before a migration, or otherwise treat
that PVC as unsafe to revert-away-from until a backup exists — don't rely on the
manifest's `Retain` line, since it isn't doing anything. Don't copy
`persistentVolumeReclaimPolicy: Retain` into a new PVC assuming it protects anything;
it's cargo-culted from the existing apps.

## This repo is public

- A `git revert` does not remove anything from GitHub history — redaction has to be
  right *before* the first push, not fixed after.
- Redact **external** resources: personal names, third-party retailer/product names
  and URLs, and any resolved value of a SOPS-encrypted var.
- Internal `10.10.x` addressing is knowingly left public — that's a deliberate
  decision made for this repo, not an oversight to "fix."
- Grep the branch diff for the above before every push, not just once at the end.

## Exposure — HTTP apps share one Traefik IP

- Traefik holds a single `loadBalancerIP`. Confirmed live: `grafana.inf`,
  `influxdb.inf`, `longhorn.inf`, `nginx.inf`, and `portainer.inf` all resolve to the
  same address — Traefik's, not each app's own.
- Every HTTP UI is a Traefik **`IngressRoute` CRD** (`traefik.io/v1alpha1`, not
  `networking.k8s.io/Ingress`, not Gateway API), host
  `<app>.inf.${PERSONAL_DOMAIN}`, entrypoint `websecure`, TLS from the wildcard
  secret `inf-personal-domain-tls`, plus a per-namespace `default-headers`
  Middleware.
- **A new web app needs a ClusterIP Service only.** Don't allocate a new `LB_<NS>`
  var or a MetalLB Service for it — that pattern is reserved for non-HTTP / raw-TCP
  services (e.g. InfluxDB v1, MQTT), which do get their own dedicated LB IP because
  there's no Traefik layer in front of them.
- The wildcard TLS secret must be reflected into the app's namespace before its
  IngressRoute will get real TLS — see
  [infrastructure/configs/certificates/inf-personal-domain.yaml](infrastructure/configs/certificates/inf-personal-domain.yaml)'s
  `reflection-allowed-namespaces` annotation. Skipping this is a **silent** failure:
  Traefik falls back to its own default cert rather than erroring loudly, and the
  page still loads — check with `kubectl -n <ns> get secret inf-personal-domain-tls`
  and/or an `openssl s_client` check of the actual served cert's issuer, not just
  "does the page load."

## DNS is manual, on both Pi-holes

- Traefik cannot route until DNS delivers the packet to it. Every new `*.inf`
  hostname needs its own Pi-hole A record pointing at Traefik's IP.
- **No wildcard** covers `*.inf.${PERSONAL_DOMAIN}` — `influxdbv1.inf` points at a
  different, dedicated IP, so a `*.inf` wildcard would be wrong. This was considered
  and rejected 2026-09-10; don't re-propose it without a new reason.
- Local DNS records don't replicate between the two Pi-holes automatically. Add the
  record on **both** and verify both — a missing secondary record is invisible until
  the primary Pi-hole is down.

## Storage and backup

- StorageClass in use: `longhorn-diskencrypt-global` (encrypted, cluster default),
  `ReadWriteOnce`.
- Use `strategy: Recreate` with an RWO PVC — `RollingUpdate` deadlocks trying to
  mount the same volume from two pods at once.
- See the reclaim-policy warning above before assuming `Retain` in a PVC manifest
  means anything.
- **Longhorn recurring jobs need no per-volume label.** The RecurringJobs
  ([infrastructure/configs/longhorn.yaml](infrastructure/configs/longhorn.yaml))
  target `groups: [default]`, and the implicit `default` group covers any volume
  that doesn't explicitly opt out. A new PVC is backed up automatically — don't
  invent a labelling scheme. Given the reclaim-policy gap above, these backups are
  the actual safety net against data loss, not the PVC spec.

## Secrets

- App secrets: **1Password + External Secrets Operator**
  (`ClusterSecretStore onepassword-k3s`).
- **SOPS is only for the `cluster-config/` and `global/` var files.** Editing those
  needs the age key and has cluster-wide blast radius — every Kustomization that
  reads them via `postBuild.substituteFrom`.
- **Only add a `HOST_*`/`*_IP` SOPS var when a manifest actually consumes it.** Flux
  doesn't substitute vars into markdown, so a `${VAR}` placeholder in `docs/` is a
  dead reference and the SOPS edit buys nothing — describe the host in prose instead.
- Never commit a resolved SOPS value. Manifests and docs use `${VAR}` template
  syntax only; resolved values belong in throwaway shell commands, never a file.
- **basicAuth pattern** (used for longhorn/traefik/changedetection dashboards): the
  ExternalSecret copies a pre-hashed `users` field **verbatim** from 1Password
  (generate it with `htpasswd -nB <username>`). Don't template the hash with a
  `htpasswd(...)` sprig function in the ExternalSecret — bcrypt salts randomly on
  every evaluation, so templating rewrites the Secret on every refresh interval for
  a credential that never actually changes.

## Image tags

- Use a **readable semver tag** (e.g. `grafana/grafana:13.2.1`). Never `:latest` for
  a new app.
- Digest pinning (`image@sha256:...`) is **not** the repo convention —
  `linuxserver/tautulli` is the one outlier, pinned by digest only because Renovate
  couldn't detect a version scheme for that image. Don't generalize from it.
- Renovate needs no per-image annotation for a standard tag — its generic
  `kubernetes` manager autodetects `image:` fields in any `*.yaml` under scope.

## Documentation

- `docs/<app>.md` describes mechanism, generically, given this repo is public —
  see `docs/changedetection.md` for the shape: what's declarative vs. not, access/
  auth, storage/backup, notification wiring, DNS, all without naming third-party
  specifics that belong to the deployment rather than the pattern.
- Anything that can't be public, and anything that isn't in Git at all (Pi-hole DNS
  records, UniFi firewall rules, app state held only in a datastore), gets a note in
  `docs/` that a private record exists — not what's in it.
- **Name the IaC gaps rather than hiding them.** If something can't be declarative,
  write down that it isn't, and what actually protects it instead (a backup job, a
  manual DNS entry, whatever it is).

## Verification

- Run the checks and report real output — "should work" is not verification.
- Be explicit about verified vs. assumed vs. handed off to a human.
- For anything with a PVC, the non-disruptive proof is expected, not optional:
  cordon the pod's node, delete the pod, confirm it reschedules elsewhere and the
  volume detaches/reattaches with data intact (check the Longhorn volume's node and
  robustness, not just that the pod came back), then uncordon.
