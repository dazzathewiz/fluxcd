# changedetection.io

A self-hosted web-page change monitor (`dgtlmoon/changedetection.io`), deployed on k3s
via Flux in the `tools` namespace ([apps/tools/changedetection/](../apps/tools/changedetection/)).
It replaced a cloud scheduled task and a third-party SaaS monitor. It's a general-purpose,
long-lived service — more watches will be added over time — so availability and
restart-survival matter more than anything else about it.

## What's declarative vs. what isn't

Everything in [apps/tools/changedetection/](../apps/tools/changedetection/) (Deployment,
PVC, Service, IngressRoute) is Flux-managed. **Watch configuration is not.**
changedetection.io has no declarative watch config — watches, their history, and
notification targets all live in its datastore (the Longhorn-backed PVC), not in Git.
That datastore is covered by the cluster's existing Longhorn recurring backup jobs (see
below), **not by Git** — if the volume were lost between backups, watch state and history
would be lost with it.

## Access

- Internal only, via Traefik: `https://changedetection.inf.${PERSONAL_DOMAIN}`
- TLS: the wildcard cert is only reflected into namespaces listed in
  [infrastructure/configs/certificates/inf-personal-domain.yaml](../infrastructure/configs/certificates/inf-personal-domain.yaml)'s
  `reflection-allowed-namespaces` annotation — `tools` was added there for this app.
  Skipping that step is a real, silent failure mode: grafana's IngressRoute in
  `monitoring` (not on that list) has been failing TLS config the same way, falling
  back to Traefik's default cert instead of erroring loudly — a pre-existing issue,
  left for a separate fix.
- Auth: a Traefik `basicAuth` Middleware in front of the IngressRoute
  ([apps/tools/changedetection/ingress.yaml](../apps/tools/changedetection/ingress.yaml)),
  credentials sourced from 1Password via
  [apps/tools/changedetection/externalsecret.yaml](../apps/tools/changedetection/externalsecret.yaml) —
  same `onepassword-k3s` ClusterSecretStore as every other app-secret in this repo.
  changedetection.io has no environment variable or file hook to pre-seed its own
  built-in password (confirmed against upstream docs), so unlike grafana/influxdb it
  can't take credentials directly — Traefik-level basic auth is the declarative
  substitute — same mechanism, and same 1Password item shape, already used for the
  longhorn/traefik dashboards. 1Password item: **`changedetection`**, with a **`users`**
  field holding a pre-hashed `username:hash` htpasswd entry (e.g. via `htpasswd -nB
  <username>`), which the ExternalSecret copies verbatim — no templating, so no
  regeneration on every sync. Plain `username`/`password` fields can also be kept on the
  same item purely for human reference; only `users` is ever read by the cluster.

## Storage / backups

- PVC on `longhorn-diskencrypt-global`, `ReadWriteOnce`, 5Gi, `Retain`.
- No special recurring-job label needed: the two backup RecurringJobs
  (`daily-backups`, `weekly-backups`, plus the snapshot job) target `groups: [default]`,
  and any volume that doesn't opt out is implicitly a member of that group — confirmed
  by other app PVCs in this repo carrying no such label either.
- Longhorn's backup target was confirmed live and healthy at time of deploy
  (`available: true`, reachable S3 target).

## Notifications

Notifications go through Apprise's generic JSON target to a Home Assistant webhook,
which triggers an automation that pushes to the HA companion app on a phone (the
`hassio://` Apprise target only creates a persistent notification inside HA — it does
not push to a phone, hence the webhook route).

- Notification URL shape: `json://<home-assistant-host>:8123/api/webhook/<webhook-id>`
  (`jsons://` if HA is on TLS). Both the host and the webhook ID are entered directly in
  the changedetection UI — datastore state, not committed anywhere.
- The HA-side automation is a webhook trigger with a long random webhook ID, whose
  action calls `notify.mobile_app_<device>` with the title/message/URL passed through
  from the payload. **Home Assistant automations are not Flux-managed** — the automation
  itself lives and is maintained directly in HA, not in this repo.

## DNS

`changedetection.inf.${PERSONAL_DOMAIN}` was added by hand as an A record to Traefik's
LB IP on **both** Pi-holes (there is no wildcard covering `*.inf.${PERSONAL_DOMAIN}` —
some subdomains under `inf` point elsewhere, e.g. a non-HTTP service's own dedicated LB
IP — so every new `*.inf` app needs its own two manual DNS entries). Local DNS records
don't replicate between the two Pi-holes automatically, so this is a manual step for
every future app of this kind, not just this one.

## Everything else that's drift, not Git

- Watch URL, CSS selector, trigger text, and any future additional watches.
- The Apprise notification URL (host + webhook ID).
- The DNS A record on both Pi-holes.
- Any UniFi inter-VLAN rule.
- The Home Assistant automation itself.
