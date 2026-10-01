# tailscale-app-zone — Tailscale route into the `.app` zone, from inside k3s

## The question

A personal device — a phone, away from home — needs to reach hostnames on the
`.app` zone and nothing else on the network. Tailscale already runs on the
hypervisor hosts, and adding the `.app` address to the routes they advertise
would work today with no new moving parts.

This experiment tests the alternative: a subnet router that runs **as a workload
in this cluster**, so the route into the `.app` zone is declared in this repo
alongside the app it serves, rather than in host-level config in the sibling
Ansible repo.

The honest case for it is not elegance. It is that
`tailscale set --advertise-routes` **replaces** the list rather than appending to
it, on three hosts that must advertise identical prefixes for failover to work.
Every future route change restates all of them, by hand, forever, and omitting
one withdraws it silently. A manifest does not have that failure mode.

Same containment goal either way. Different place for the truth to live.

## Exit condition

**Graduates** if the route works and a device tagged `tag:personal-device` can
load the app and nothing else. Then this directory moves to
`infrastructure/controllers/` (the operator) plus `apps/tools/inventory/`
(the route, next to the app it exists for), and the README's reasoning moves
into `docs/`.

**Goes in the bin** if the probe fails. Then the hypervisor-side router is the
answer, and `docs/` gets a line saying this was tried and why it did not work —
so it is not re-proposed.

Either way this directory does not survive. See `../README.md`.

## Shape — three Kustomizations, deliberately chained

`clusters/home/experiments.yaml` defines them. They run in order because each
one is only worth doing if the one before it worked:

| Kustomization | Path | What it proves / does |
|---|---|---|
| `experiment-hairpin-probe` | `probe/` | the cheap question, asked first |
| `experiment-tailscale-operator` | `operator/` | installs the operator |
| `experiment-tailscale-connector` | `connector/` | advertises the route |

### What the probe asserts, and what it is worth

Three checks, from three different nodes (`completions: 3` with an
anti-affinity rule, because "it worked from the node I happened to land on" is
not the same claim):

| | Assertion | Expect |
|---|---|---|
| A | the app answers through the zone address, from the pod network | `200` |
| B | the certificate served on that path validates against a public root | `200` |
| C | a hostname from the **other** zone, sent to this zone's address, is refused | `404` |

**Be honest about A.** With `kube-proxy` in iptables mode, traffic from a pod to
a `LoadBalancer` address is short-circuited inside the node and never touches
the wire, and `traefik-app` is `externalTrafficPolicy: Cluster` so it is not
even node-dependent. A is very likely to pass. It is here because it is nearly
free and because the design collapses outright if it fails — not because it is
the risk. **A pass is not evidence that the design works.**

**C is the assertion worth having**, and it outlives the experiment. The
containment story for this zone is that its address carries no route for the
other zone, so a forged `Host` header gets nowhere — and that property is
asserted nowhere else in this repo. It holds today only because `traefik-app`
targets `appsecure` while every `.inf` route names `websecure`; one route
merged without an `entryPoints` block joins every entrypoint and breaks it
silently. If C ever returns `200`, this experiment is the least of the problems.

**What the probe cannot test**, and what the real risks therefore are:

- whether the advertised route is **approved** on the tailnet (see
  `autoApprovers` below — an unapproved route is indistinguishable from a
  broken one from the client side);
- whether the router pod actually **forwards** tailnet traffic onto the LAN.
  That needs the router, so it cannot be tested before installing it;
- whether the device can **resolve the hostname** — see the name-resolution
  item below, which is the gap most likely to make a working route look broken.

So the probe gates the operator, and the operator Kustomization `dependsOn` it:
if A fails, **the operator is never installed** — no tailnet device registered,
no auth key minted, nothing to unpick. That is cheap insurance, not proof.

There is also one line of output that is **expected to succeed and is not a
failure**: the probe reaches the other zone's address directly, because any pod
can. That is the honest limit of this design — the router pod can reach more
than the device may. What confines the device is the single-address route plus
the tailnet access rules, not anything about the cluster. The same is true of a
router on a hypervisor host, which can reach more still.

One cost of B: on failure, curl's error text includes the full hostname, and
therefore the domain, in a pod log the read-only `view` identities can read.
B needs the real hostname for SNI, so this is accepted rather than solved.

### Why the operator, and why so little of it

It is installed with three of its features switched off:

- **no Ingress class.** The operator can instead publish a workload as its own
  tailnet node on a `ts.net` name it owns. That is a different design, and not a
  free one: WebAuthn relying-party IDs are domain-bound, so a passkey enrolled
  on the app's current hostname does not work on a `ts.net` name. It would also
  claim an IngressClass cluster-wide.
- **no API server proxy.** The operator can expose **this cluster's API server**
  over the tailnet. The reason for moving the router into k3s is to *narrow*
  what a personal device reaches, so the one switch that would widen it to the
  control plane is stated rather than inherited.
- **no impersonation.**

Left on: the CRD, and the ability to create router workloads. That is all this
needs.

The OAuth credential comes from the credential store into the `Secret` the chart
looks for, by the name and key names the chart fixes. The chart would also take
it as a Helm value — it is not given that way, because the value would be
rendered into the release and a release is not a `Secret`.

## Not declarative — three things outside this repo

1. **Credential store item** `tailscale-operator`, with properties `client-id`
   and `client-secret`, from an OAuth client scoped to *write* on Services,
   Devices/Core and Keys/Auth Keys, owning `tag:k8s-operator`. Without it the
   ExternalSecret never syncs and the operator Kustomization holds — contained,
   but stuck. **The tag must exist in the policy file before the client can be
   scoped to it**, so the policy edit comes first.
2. **Tailnet policy**: `tagOwners` for `tag:k8s-operator`, `tag:k8s` (owned by
   the operator tag) and `tag:personal-device`; an `autoApprovers.routes` entry
   for the `/32` listing both `tag:k8s` and the hypervisor routers' tag, so
   either route source is approved without a console click and the two can
   coexist as failover; and one rule letting `tag:personal-device` reach the
   zone address on `443`. Concrete values are in the private runbook.
3. **Name resolution — decide this before writing the access rule.** The two are
   coupled, and getting it wrong produces a working route that looks broken.

   A device whose access rule permits only the zone address on `443` **cannot
   reach a resolver**, so a local-only DNS record never resolves for it. There
   are two ways out, and they are not equivalent:

   - **A public `A` record** for the hostname pointing at the zone address.
     The device needs no resolver on the network at all, and the access rule
     stays exactly one address and one port. Internal `10.10.x` addressing is
     already knowingly public in this repo, so the only new disclosure is the
     subdomain name itself. **This is the simpler and tighter option.**
   - **Tailnet split DNS** for the domain, pointing at the two resolvers, with
     the access rule widened to allow `53` to both. This works, but note what
     it costs: the resolver routes are advertised by the **hypervisor** routers,
     so the device's DNS would still depend on them — which means this option
     does *not* deliver the decoupling from hypervisor routing that is the whole
     point of the experiment. Only the app route moves into the cluster.

   The local record on both resolvers stays either way, for devices at home.

## Operating notes

- **Re-running the probe** means deleting the `Job`; a `Job` is immutable, so
  Flux will not recreate it while it still exists with the same spec.
  `kubectl -n tailscale delete job hairpin-probe`, then
  `flux reconcile kustomization experiment-hairpin-probe`. This is the one
  sanctioned manual `kubectl delete` here: it is not repairing drift, it is
  re-asking a question, and Flux puts the object back from Git rather than
  losing track of it.
- `ttlSecondsAfterFinished` is deliberately **unset**. With a TTL the `Job`
  would delete itself, Flux would recreate it on the next reconcile, and the
  probe would run in a slow loop forever.
- **Reading the result:** `kubectl -n tailscale logs -l job-name=hairpin-probe`.
  Three pods, three sets of `PASS`/`FAIL` lines. The `Kustomization` going
  `Ready` is also a pass signal, but read the lines — an exit code is not
  verification.
- **Checking the route:** `kubectl get connector` shows the advertised routes
  and whether the router came up. It says nothing about whether the route was
  *approved* on the tailnet; that is the console, or the autoApprovers entry
  above.

## Removal

```
git rm -r infrastructure/experiments/tailscale-app-zone
git rm clusters/home/experiments.yaml          # if no other experiment uses it
# drop the experiments entry from renovate.json
# drop the row from infrastructure/experiments/README.md
```

`prune: true` removes the operator, its CRDs, the router workload and the
namespace. There are no PVCs, so nothing is destroyed that is not meant to be.
The tailnet device registrations left behind by the router are cleaned up
by the operator on delete; if the namespace is force-removed instead, expired
devices linger in the console and have to be removed there.
