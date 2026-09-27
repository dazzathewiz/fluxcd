# inventory -- InvenTree

A self-hosted catalogue of physical items held in an offsite storage location:
what is stored, which container it is in, what condition it was in when it was
packed, and which containers are not yet sealed. The records exist so that the
contents remain documented even if the goods themselves do not, so the backup
story below is the point of the deployment rather than an afterthought.

## Shape

`apps/tools/inventory/`, in the `tools` namespace, 10 resources.

| Resource | Notes |
|---|---|
| `inventory-secrets` (ExternalSecret) | database password and first-boot superuser, from the credential store |
| `inventory-env` (ConfigMap) | shared configuration for the server and worker |
| `inventory-caddy` (ConfigMap) | static/media file server config |
| `inventory-data` (PVC, 20Gi) | media (item photos), static, config, secret key |
| `inventory-db` (PVC, 5Gi) | Postgres data directory |
| `inventory-db` (Deployment + Service) | Postgres 17, ClusterIP |
| `inventory` (Deployment) | three containers: server, worker, Caddy |
| `inventory` (Service) | ClusterIP 8080 |
| `inventory` (IngressRoute) | `appsecure` entrypoint, `.app` zone |

### Why three containers in one pod

The application server, the background worker and the static/media file server
all need the same data volume. The storage class is ReadWriteOnce, so they
cannot be separate Deployments without a ReadWriteMany class or node-affinity
glue. Co-locating them makes the shared mount trivially correct, and has the
useful side effect that the server and worker can never run mismatched versions
across an upgrade.

### Why Caddy

The application server does not serve its own static assets or uploaded media in
a production configuration. Without the file server the interface loads unstyled
and every attachment 404s. The config is upstream's, with TLS removed because
Traefik terminates it -- Caddy listens plain inside the pod and never sees the
network.

One line in that config is load-bearing beyond convention: media requests are
passed through a `forward_auth` check against the application before the file is
served. Attachments here are photographs of the items and of where they are
kept, so an unauthenticated read of the media path would be a meaningful
disclosure rather than a cosmetic one.

### Why no cache container

Upstream's compose includes Redis. It is omitted: at two users and a few
thousand rows it changes nothing measurable, and it would be a fourth workload
to keep patched for the life of the deployment.

## Access

Reached on the `.app` zone only -- see [app-zone.md](app-zone.md). The
application is not published to the internet; it is reachable across the overlay
network, and the device used at the storage location is restricted at the
network layer to that zone's address alone.

Authentication is the application's own: local accounts with WebAuthn, and
role-based permissions per group. No proxy-level basic auth, because the mobile
client authenticates with a token and a proxy prompt would break it. The
first-boot superuser is the break-glass account -- it is the way back in if the
passkey flow fails, and it is not for daily use.

## Storage and backup

Both volumes are covered automatically by the Longhorn RecurringJobs, which
target `groups: [default]`; the implicit default group covers any volume that
does not opt out, so no labelling scheme is needed. Those backups land offsite
in object storage. Given the reclaim-policy behaviour described in `AGENTS.md`,
they are the actual protection for this data.

**A logical database dump is a separate, still-outstanding piece of work.** A
Longhorn volume backup of a running Postgres is crash-consistent -- recoverable,
because the write-ahead log replays, but not the same thing as a dump you can
restore onto any Postgres anywhere. For a dataset whose purpose includes being
producible as an itemised record after a loss, the portable form matters. That
job is tracked separately and is not in this deployment.

### This app stops being safe to revert once data entry begins

`AGENTS.md` records that `persistentVolumeReclaimPolicy: Retain` in a PVC spec
does nothing, and that the backing volumes are actually deleted on prune. That
is acceptable for a new app whose PVC only ever held its own freshly generated
data -- which is true of this app on day one, and false of it a week later.

Once real records exist, a `git revert` that prunes these PVCs destroys them
with no Released volume to recover from. From that point the rollback path is
a Longhorn restore, not a revert. The PVC manifests here deliberately do **not**
carry the cargo-culted `Retain` line, so that nothing in the repo implies a
protection that is not there.

## Upgrades

- The application image carries a readable semver tag and runs its own
  migrations on start, so a tag bump is a complete upgrade. Server and worker
  share the pod and therefore the version.
- **The Postgres major version is not a routine bump.** The application supports
  Postgres 17 and states newer versions are not guaranteed, and a Postgres major
  upgrade needs a dump and restore regardless -- the data directory is not
  forward-compatible and the container refuses to start against one written by
  an older major. Dependency automation will eventually offer `18-alpine` here.
  That PR must not be merged like an ordinary one.

## Not declarative

- **DNS.** `inventory.app.${PERSONAL_DOMAIN}` needs an A record pointing at the
  `.app` zone address, on both resolvers, added by hand.
- **The overlay-network access policy**, including which devices are confined to
  the `.app` zone.
- **Application configuration** -- categories, parameter templates, custom
  states, location types, users and roles -- is datastore state, not Git. It is
  protected by the volume backups, not by version control. A private record
  documents the intended configuration so it can be rebuilt.
- **The intake tooling** that creates records from the mobile client lives
  outside this repo; it talks to the application's REST API and holds its own
  credential.
