# tailscale-shed -- overlay route into the `.app` zone, from inside k3s

## The question

The offsite device needs to reach one hostname on the `.app` zone and nothing
else. The overlay network already has routers on the hypervisor hosts, and
advertising the `.app` address from one of those would work today with no new
moving parts.

This experiment tests the alternative: a router that runs **as a workload in
this cluster**, so that the route into the `.app` zone is declared in this repo
alongside the app it serves, and the set of addresses reachable from the offsite
device is defined by a manifest here rather than by host-level config in the
sibling Ansible repo.

Same containment goal either way. Different place for the truth to live.

## Exit condition

**Graduates** if the probe below passes and a device holding the right overlay
tag can load the app and nothing else. Then this directory moves to
`infrastructure/controllers/` (the operator) plus `apps/tools/inventory/`
(the route, next to the app it exists for), and the README's reasoning moves
into `docs/`.

**Goes in the bin** if the probe fails. Then the hypervisor-side router is the
answer, and `docs/` gets a line saying this was tried and why it did not work --
so it is not re-proposed.

Either way this directory does not survive. See `../README.md`.

## Shape -- three Kustomizations, deliberately chained

`clusters/home/experiments.yaml` defines them. They run in order because each
one is only worth doing if the one before it worked:

| Kustomization | Path | What it proves / does |
|---|---|---|
| `experiment-hairpin-probe` | `probe/` | the cheap question, asked first |
| `experiment-tailscale-operator` | `operator/` | installs the controller |
| `experiment-tailscale-connector` | `connector/` | advertises the route |

### Why the probe gates the rest

A router pod on the pod network reaching the zone address is not a given. That
address is a `LoadBalancer` address served by pods **in this same cluster**, so
the traffic leaves the pod, is redirected by the node back into the cluster, and
arrives at a pod that may be the one next door. In theory `kube-proxy` rewrites
it locally and it never touches the wire. In practice that is the single
assumption the whole design rests on, and it costs one `Job` to check.

So the probe runs first, and the operator Kustomization `dependsOn` it. If the
redirect does not work, **the operator is never installed** -- no overlay client
registered, no credential minted, nothing to unpick. The failure is one
`Kustomization` reporting a failed `Job`, and one `kubectl logs` explaining
which assertion broke.

### What the probe asserts

Three checks, from three different nodes (`completions: 3` with an
anti-affinity rule, because "it worked from the node I happened to land on" is
not the same claim):

| | Assertion | Expect |
|---|---|---|
| A | the app answers through the zone address, from the pod network | `200` |
| B | the certificate served on that path validates against a public root | `200` |
| C | a hostname from the **other** zone, sent to this zone's address, is refused | `404` |

C is the one worth having. The containment story for this zone is that its
address carries no route for the other zone, so a forged `Host` header gets
nowhere. That property is asserted nowhere else in this repo, and it is the
reason an offsite device may be pointed at this address at all. If C ever
returns `200`, the zone separation has been broken by something unrelated and
this experiment is the least of the problems.

There is also one line of output that is **expected to succeed and is not a
failure**: the probe reaches the other zone's address directly, because any pod
can. That is the honest limit of this design -- the router pod can reach more
than the offsite device may. What confines the device is the single-address
route it is given plus the overlay access rules, not anything about the cluster.
The same is true of a router on a hypervisor host, which can reach more still.

### Why the operator, and why so little of it

The controller is installed with three of its features switched off:

- **no Ingress class.** The controller can publish a workload as its own node on
  the overlay network, on a name it owns. That is a different design -- it would
  replace the hostname and therefore the certificate, and a device credential
  bound to the current hostname would stop working. Not this experiment.
- **no API server proxy.** The controller can expose this cluster's API over the
  overlay network. Nothing here wants that, and the point of moving the router
  into k3s is to *narrow* what the offsite device can reach.
- **no impersonation.**

Left on: the CRD, and the ability to create router workloads. That is all this
needs.

The credential is a client with permission to mint devices, read from the
credential store into the `Secret` the chart expects. The chart would also take
it as a Helm value -- it is not given that way, because the value would be
rendered into the release and the release is not a `Secret`.

## Not declarative -- do these before merging

The controller cannot come up without a credential, and the route cannot be
approved without an overlay policy that permits it. Both live outside this repo.

1. **Credential store item** `tailscale-operator`, with properties `client-id`
   and `client-secret`, from a client scoped to *write* on services, devices and
   auth keys, owning the controller's own tag. Without it the ExternalSecret
   never syncs and the operator Kustomization holds -- contained, but stuck.
2. **Overlay access policy**: tag ownership for the controller tag, the proxy
   tag it creates, and the offsite device's tag; an auto-approver for the single
   `/32` route so it does not need clicking through a console; and one rule
   permitting the offsite tag to reach that address on `443` and nothing else.
   The concrete values are in the private runbook, not here.
3. **Name resolution for the offsite device.** The hostname must resolve to the
   zone address over the overlay network. Records are manual and live on both
   resolvers -- see `AGENTS.md`. A route that works and a name that does not
   resolve looks exactly like a route that does not work.

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
  `Ready` is also a pass signal, but read the lines -- an exit code is not
  verification.
- **Checking the route:** `kubectl get connector` shows the advertised routes
  and whether the router came up. It says nothing about whether the route was
  *approved* on the overlay side; that is the console, or the auto-approver
  above.

## Removal

```
git rm -r infrastructure/experiments/tailscale-shed
git rm clusters/home/experiments.yaml          # if no other experiment uses it
# drop the experiments entry from renovate.json
# drop the row from infrastructure/experiments/README.md
```

`prune: true` removes the controller, its CRDs, the router workload and the
namespace. There are no PVCs, so nothing is destroyed that is not meant to be.
The overlay-side device registrations left behind by the router are cleaned up
by the controller on delete; if the namespace is force-removed instead, expired
devices linger in the console and have to be removed there.
