# The `.app` zone -- a second Traefik address

## What this is

Traefik serves two HTTPS entrypoints on two MetalLB addresses:

| Entrypoint  | Address       | Zone                       | Certificate               |
|-------------|---------------|----------------------------|---------------------------|
| `websecure` | `10.10.1.100` | `*.inf.${PERSONAL_DOMAIN}` | `inf-personal-domain-tls` |
| `appsecure` | `10.10.1.108` | `*.app.${PERSONAL_DOMAIN}` | `app-personal-domain-tls` |

Same Traefik pods, same middlewares, same chart. Only the listening port and the
published Service differ.

Each address also answers plain HTTP on port 80 with a redirect to HTTPS: `web`
on `.100`, and its own `appweb` entrypoint on `.108`. `appweb` exists so the
`.app` address shares no entrypoint with `.inf` at all -- reusing `web` would
put anything later bound to `web` on the restricted address.

## Why, specifically

Every `.inf` route answers on one address. Anything permitted to reach that
address can reach every application behind it -- Traefik will route on whatever
`Host` header arrives, and each app's own login is the only thing in the way.
For most clients on this network that is fine, because they are trusted to the
same degree everywhere.

It stops being fine when a client is deliberately *less* trusted than the
network: a device that lives in a bag, leaves the house, and connects from
places nobody controls. Such a device can be restricted to a single address at
the network layer, but restricting it to `10.10.1.100` restricts it to nothing
useful -- that address is the front door to everything.

`appsecure` exists so that restriction means something. It carries only `.app`
routes, so a client confined to `10.10.1.108` cannot reach a `.inf` application
at all, with or without a forged `Host` header. That is a network-layer
boundary rather than an application-layer one, and it holds even if one of the
`.inf` applications has an authentication bypass.

## How it is wired

- The entrypoints (`appsecure`, and `appweb` for the redirect) are declared in
  the Traefik chart values
  ([infrastructure/controllers/traefik.yaml](../infrastructure/controllers/traefik.yaml))
  with `expose: false`, which creates the listeners and container ports but
  keeps them off Traefik's own Service.
- They are published by a standalone Service
  ([infrastructure/controllers/traefik-app-service.yaml](../infrastructure/controllers/traefik-app-service.yaml))
  selecting the same pods. The pinned chart (`>=22.1.0 <24.0.0`) supports only
  one Service per release, which is why this is a hand-written object rather
  than a second entry in the chart's `service:` block.
- The certificate is a separate wildcard
  ([infrastructure/configs/certificates/app-personal-domain.yaml](../infrastructure/configs/certificates/app-personal-domain.yaml)).
  Separate zones, separate keys.
- An application joins the zone by setting `entryPoints: [appsecure]` and
  `tls.secretName: app-personal-domain-tls` on its IngressRoute. Nothing else
  changes.

## What is not in Git

- **DNS.** Each `*.app` hostname needs its own A record pointing at
  `10.10.1.108`, added by hand on **both** resolvers. There is no wildcard, for
  the same reason there is no `*.inf` wildcard: the zones do not map one-to-one
  onto a single address.
- **The overlay-network policy.** The access-control rules that decide which
  devices may reach which address live in the overlay network's policy file,
  not here. This repo builds the boundary; something else decides who is on
  which side of it. A private record covers the policy itself. The route
  below depends on the policy defining the tags this repo sets and
  auto-approving the route. Without approval the router comes up, reports the
  route, and carries no traffic.
- **The operator's OAuth client.** Credential-store item `tailscale-operator`
  (properties `client-id`, `client-secret`), from an OAuth client scoped to
  `tag:k3s-operator`. A client can only be scoped to a tag that already exists,
  so the policy edit comes first. Until the item exists, `tailscale-operator`
  waits and nothing else is affected.

## Reaching the zone from the tailnet

A restricted device reaches `10.10.1.108` through a subnet router that runs
in this cluster: a Tailscale operator plus one `Connector` advertising
`10.10.1.108/32`. That `/32` is the only route such a device gets.
Every `.app` application shares the address, so one route covers all of them.

### Why the route lives here, not on the hypervisors

The hypervisor hosts already run Tailscale and could advertise the route. They
aren't used for it because `tailscale set --advertise-routes` **replaces** the
whole list. The three hosts must advertise identical lists for failover, so
every route change restates every route on all three by hand, and leaving one
out withdraws it silently. In this repo the route is one line of YAML next to
the app it serves, reviewed and reverted like anything else.

### How it is wired

| Flux Kustomization | Path | Applies | `dependsOn` | `wait` |
|---|---|---|---|---|
| `tailscale-operator` | `infrastructure/tailscale/` | Namespace, ExternalSecret `operator-oauth`, HelmRepository, HelmRelease | `infra-configs` | `true` |
| `tailscale-connector` | `apps/tools/inventory/app-zone-route/` | Connector `app-zone-route` | `tailscale-operator` | `false` |

Both are defined in
[clusters/home/tailscale.yaml](../clusters/home/tailscale.yaml). **Nothing may
depend on either.**

- **Tags.** The operator's own device is `tag:k3s-operator`. The router device
  is `tag:k3s`, set on the Connector and as the chart's
  `proxyConfig.defaultTags` fallback. The chart defaults (`tag:k8s-operator`,
  `tag:k8s`) are overridden; the policy matches these names as plain strings.
- **Credential.** The chart uses a pre-existing Secret `operator-oauth` (keys
  `client_id`, `client_secret`) when no client id is passed as a value. It comes
  from an ExternalSecret, so the credential never appears in the HelmRelease.
- **Off on purpose.** The chart's IngressClass would publish workloads on
  `ts.net` names. Passkeys are bound to the domain they were enrolled on, so
  they wouldn't work there, and it would claim an IngressClass cluster-wide.
  The API server proxy would put this cluster's control plane on the tailnet.
- **Chart version** is pinned exactly. The chart version is the client version
  running on the tailnet.
- **The Connector has no useful health check.** Its condition is
  `ConnectorReady`, which kstatus doesn't read, so `wait: true` would pass
  immediately. `kubectl get connector` shows whether the router is up, not
  whether the route is approved or primary. Check those in the admin console,
  or with `tailscale status` on the device.
- **What the route doesn't constrain.** The router pod sits on the pod network
  and can reach the rest of the cluster like any pod. The device is limited by
  its `/32` and the access rule, not by anything the cluster enforces.

### Why not `infrastructure/controllers/` and `apps/`

This was the original plan. Both placements are wrong:

- **The operator in `infrastructure/controllers/` deadlocks a cold rebuild.**
  Its ExternalSecret resolves through `ClusterSecretStore onepassword-k3s`,
  which `infra-configs` creates. `infra-configs` depends on
  `infra-controllers`, and `infra-controllers` has `wait: true`. The credential
  would come from a Kustomization that is waiting on the operator that needs
  it. For this reason, nothing under `infrastructure/controllers/` carries an
  ExternalSecret.
- **The Connector in the `apps` render wedges `apps`.** The Connector is a CRD
  from the operator's chart. `apps` renders and applies the whole tree in one
  pass, so if the CRD is missing (a cold rebuild, or an operator that won't
  install) the unknown kind fails the dry-run and no app receives updates. The
  file sits next to the app, but `apps/tools/inventory/kustomization.yaml`
  doesn't list it. Its own Kustomization applies it.
- **Its Flux Kustomizations can't live in `apps/` either** (the grafana
  `app.yaml` shape). `apps` has `wait: true` and would wait on a child
  Kustomization that depends on the operator.

Cold rebuild from an empty cluster:

```text
flux-system
 └─ cluster-config
     └─ infra-controllers      (ESO, 1Password Connect, ...; wait)
         └─ infra-configs      (ClusterSecretStore onepassword-k3s)
             ├─ apps, cluster-orchestration
             └─ tailscale-operator   (Secret operator-oauth, then chart + CRDs; wait)
                 └─ tailscale-connector   (Connector; no wait)
```

The `tailscale-*` pair hangs off the end of the chain. If the credential item is
missing or the tailnet is unreachable, they stay not-Ready and nothing else
notices.

### What was tested before graduating

Before the operator was installed, a Job ran on each of the three worker nodes
and requested the `.app` address from the pod network (PR #188):

| | Check | Expect | Result |
|---|---|---|---|
| A | the app answers on `10.10.1.108` | `200` | `200` on all three |
| B | the certificate on that path validates | `200` | `200` on all three |
| C | a `.inf` hostname sent to `10.10.1.108` is refused | `404` | `404` on all three |

**C is the one that matters.** It is the only check that `10.10.1.108` really
doesn't serve `.inf` routes, that the zone is a boundary rather than a naming
convention. That separation is what makes it safe to give a restricted device a
route to this address. The Gotchas below are how it gets broken. A passes
almost by definition, because kube-proxy handles pod traffic to a LoadBalancer
address inside the node.

After the operator was installed: operator and router pods Running,
`10.10.1.108/32` approved on the tailnet, and a restricted device on
cellular loaded `inventory.app.${PERSONAL_DOMAIN}` and could not load a `.inf`
host. The probe was a gate, not a monitor, and was deleted at graduation. Re-run
the same checks by hand after any change to the Traefik entrypoints.

### Open question: one router, one node

The route is served by a single pod on a single node, and no hypervisor
advertises `10.10.1.108/32`. If that pod's node goes down, the route goes with
it until the pod reschedules. The app behind it is a single-replica Deployment
on an RWO volume, so this doesn't make anything worse today, but it is a single
point of failure.

Adding the `/32` to the hypervisor routers would give failover. Whether that
needs a policy edit is in the private record. It runs against the reason for
this design, which was to get the route off hand-maintained host lists on three
hosts. Not done; decide deliberately. Check
that no hypervisor advertises a prefix that *covers* the `/32` either, or
traffic silently falls back to it.

## Gotchas

- **A route that names no entrypoint joins every entrypoint, `appsecure`
  included.** Traefik v2 has no way to exclude an entrypoint from the default
  set (`asDefault` arrived in v3). Every `.inf` IngressRoute must keep
  `entryPoints: [websecure]`, and a plain `Ingress` needs the
  `traefik.ingress.kubernetes.io/router.entrypoints: websecure` annotation --
  otherwise it answers on the `.app` address to anyone who sends its `Host`
  header. Check with:
  `kubectl get ingress -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name} {.metadata.annotations.traefik\.ingress\.kubernetes\.io/router\.entrypoints}{"\n"}{end}'`
- **The ports must differ from `web`/`websecure`'s.** `appsecure` listens on
  8444 and `appweb` on 8001 because 8443 and 8000 are taken; two entrypoints on
  one address means only one binds, and the other fails without failing the pod.
- **`appsecure.exposedPort` must stay 443** even though the chart never
  publishes it. The chart builds `appweb`'s redirect as `:<exposedPort>` of the
  target entrypoint, so any other value redirects clients to a port the
  `traefik-app` Service doesn't serve.
- **`expose` changes shape on a chart major bump.** It is a boolean in chart 2x
  and a map in chart 26+ (`expose: {default: false}`). Revisit this block as
  part of any chart upgrade, not afterwards.
- **A wrong Service selector fails silently.** It produces a Service with no
  endpoints and an address that accepts connections and blackholes them. Verify
  against `kubectl -n traefik get svc traefik -o jsonpath='{.spec.selector}'`
  rather than assuming the chart's labels.
- **A missing namespace in the certificate's reflection annotation also fails
  silently.** Traefik falls back to its own default certificate and the page
  still loads. Check the served issuer, not whether the page renders.
