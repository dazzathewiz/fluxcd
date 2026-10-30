# Tailscale subnet routers

## What this is

A Tailscale operator runs in this cluster and manages two `Connector`s. Each
Connector is a subnet router advertising a few `/32` host routes onto the
tailnet:

| Connector | Tag | Routes | For |
|---|---|---|---|
| `app-zone-route` | `tag:k3s` | `${LB_TRAEFIK_APP}/32` (`10.10.1.108`) | restricted devices reaching the [`.app` zone](app-zone.md) |
| `inf-zone-route` | `tag:k3s-inf` | `10.10.1.200/32` (k3s API, :6443), `${LB_TRAEFIK}/32` (`10.10.1.100`, the `.inf` zone) | the operator workstation, off-LAN |

Host routes only. Neither router may advertise the `/24`.

The `.app` route is the only route a restricted device gets. Every `.app`
application shares that address, so one route covers all of them.

The k3s API address is the kube-vip VIP. It's set at install time by
k3s-ansible's `apiserver_endpoint`, not by this repo, so it's a literal
rather than a cluster var.

## Why the routes live here, not on the hypervisors

The hypervisor hosts already run Tailscale and could advertise these routes.
They aren't used for it because `tailscale set --advertise-routes`
**replaces** the whole list. The three hosts must advertise identical lists
for failover, so every route change restates every route on all three by
hand, and leaving one out withdraws it silently. In this repo a route is one
line of YAML, reviewed and reverted like anything else.

## Separate Connectors, separate tags

Route auto-approval is scoped per tag. If the two routers shared a tag, either
one could get the other's routes approved, and the `.app` router could end up
carrying the `.inf` and API routes. **Never merge the tags**, and
never add a route to a Connector without checking which tag approves it.

Restricted devices get an access grant to the `.app` `/32` only. The `.inf`
routes are granted to the operator workstation alone.

## How it is wired

| Flux Kustomization | Path | Applies | `dependsOn` | `wait` |
|---|---|---|---|---|
| `tailscale-operator` | `infrastructure/tailscale/` | Namespace, ExternalSecret `operator-oauth`, HelmRepository, HelmRelease | `infra-configs` | `true` |
| `tailscale-connector` | `infrastructure/tailscale-connectors/app-zone-route/` | Connector `app-zone-route` | `tailscale-operator` | `false` |
| `tailscale-inf-connector` | `infrastructure/tailscale-connectors/inf-zone-route/` | Connector `inf-zone-route` | `tailscale-operator` | `false` |

All three are defined in
[clusters/home/tailscale.yaml](../clusters/home/tailscale.yaml). **Nothing may
depend on any of them.**

- **Tags.** The operator's own device is `tag:k3s-operator`. Each router's tag
  is set on its Connector. `tag:k3s` is also the chart's
  `proxyConfig.defaultTags` fallback. The chart defaults (`tag:k8s-operator`,
  `tag:k8s`) are overridden; the policy matches these names as plain strings.
- **Credential.** The chart uses a pre-existing Secret `operator-oauth` (keys
  `client_id`, `client_secret`) when no client id is passed as a value. It comes
  from an ExternalSecret, so the credential never appears in the HelmRelease.
- **Off on purpose.** The chart's IngressClass would publish workloads on
  `ts.net` names. Passkeys are bound to the domain they were enrolled on, so
  they wouldn't work there, and it would claim an IngressClass cluster-wide.
  The API server proxy would put this cluster's control plane on the tailnet.
  The workstation reaches the API through the `inf-zone-route` host route
  instead.
- **Chart version** is pinned exactly. The chart version is the client version
  running on the tailnet.
- **A Connector has no useful health check.** Its condition is
  `ConnectorReady`, which kstatus doesn't read, so `wait: true` would pass
  immediately. `kubectl get connector` shows whether the router is up, not
  whether the routes are approved or primary. Check those in the admin console
  (the machine's Subnets section), or with `tailscale status` on a device.
- **What a route doesn't constrain.** A router pod sits on the pod network
  and can reach the rest of the cluster like any pod. A device is limited by
  its routes and the access rules, not by anything the cluster enforces.

## What is not in Git

- **The tailnet policy.** Who may reach which address is decided in the
  tailnet policy file, not here. This repo builds the routes; the policy
  decides who uses them. A private record covers the policy itself. It must
  have:
  - `tagOwners` for `tag:k3s` and `tag:k3s-inf`, owned by `tag:k3s-operator`.
    The operator can't apply a tag it doesn't own, and the router fails to
    register.
  - `autoApprovers` `routes` entries approving each Connector's routes for its
    own tag only.
  - access grants as described under "Separate Connectors, separate tags"
    above.

  **Edit the policy before merging a Connector change.** Without approval the
  router comes up, reports its routes, and carries no traffic.
- **The operator's OAuth client.** Credential-store item `tailscale-operator`
  (properties `client-id`, `client-secret`), from an OAuth client scoped to
  `tag:k3s-operator`. A client can only be scoped to a tag that already exists,
  so the policy edit comes first. Until the item exists, `tailscale-operator`
  waits and nothing else is affected.

## Why not `infrastructure/controllers/` and `apps/`

This was the original plan. Both placements are wrong:

- **The operator in `infrastructure/controllers/` deadlocks a cold rebuild.**
  Its ExternalSecret resolves through `ClusterSecretStore onepassword-k3s`,
  which `infra-configs` creates. `infra-configs` depends on
  `infra-controllers`, and `infra-controllers` has `wait: true`. The credential
  would come from a Kustomization that is waiting on the operator that needs
  it. For this reason, nothing under `infrastructure/controllers/` carries an
  ExternalSecret.
- **A Connector in the `apps` render wedges `apps`.** The Connector is a CRD
  from the operator's chart. `apps` renders and applies the whole tree in one
  pass, so if the CRD is missing (a cold rebuild, or an operator that won't
  install) the unknown kind fails the dry-run and no app receives updates. The
  `.app` route originally sat next to the first `.app` app, unlisted in its
  `kustomization.yaml`, where one edit adding it to that list would have
  wedged every app. Both Connectors now live under
  `infrastructure/tailscale-connectors/`, outside `apps/` and outside the
  operator's own path.
- **Their Flux Kustomizations can't live in `apps/` either** (the grafana
  `app.yaml` shape). `apps` has `wait: true` and would wait on a child
  Kustomization that depends on the operator.

## Cold rebuild

```text
flux-system
 └─ cluster-config
     └─ infra-controllers      (ESO, 1Password Connect, ...; wait)
         └─ infra-configs      (ClusterSecretStore onepassword-k3s)
             ├─ apps, cluster-orchestration
             └─ tailscale-operator   (Secret operator-oauth, then chart + CRDs; wait)
                 ├─ tailscale-connector       (Connector app-zone-route; no wait)
                 └─ tailscale-inf-connector   (Connector inf-zone-route; no wait)
```

The `tailscale-*` Kustomizations hang off the end of the chain. If the
credential item is missing or the tailnet is unreachable, they stay not-Ready
and nothing else notices.

## Open question: one router, one node

Each Connector is a single pod on a single node, and no hypervisor advertises
these `/32`s. If a router's node goes down, its routes go with it until the pod
reschedules. For the `.app` route this doesn't make anything worse today: the
app behind it is a single-replica Deployment on an RWO volume. For the API
route it means off-LAN cluster access depends on one worker. On the LAN
nothing changes.

Adding the `/32`s to the hypervisor routers would give failover. Whether that
needs a policy edit is in the private record. It runs against the reason for
this design, which was to get routes off hand-maintained host lists on three
hosts. Not done; decide deliberately. Check that no hypervisor advertises a
prefix that *covers* these `/32`s either, or traffic silently falls back to
it.
