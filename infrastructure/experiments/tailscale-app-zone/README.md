# tailscale-app-zone — Tailscale route into the `.app` zone, from inside k3s

## The question

A personal device needs to reach the `.app` zone and nothing else. The
hypervisor hosts already run Tailscale and could advertise the `.app` address
today. This experiment tries the alternative: a subnet router running in this
cluster, so the route is a manifest in this repo next to the app it serves,
rather than host config in the sibling Ansible repo.

The reason to bother: `tailscale set --advertise-routes` replaces the whole
list, on three hosts that must stay identical for failover. Every route change
restates all of them by hand, and leaving one out withdraws it silently.

## Exit condition

- **Graduates** if a `tag:personal-device` device can load the app, can't reach
  anything else, and the k3s router is the one carrying the traffic (see
  [Checking the route](#checking-the-route)). The operator moves to
  `infrastructure/controllers/`, the Connector to `apps/tools/inventory/`, and
  this reasoning to `docs/`.
- **Goes in the bin** if the route can't be made to work. The hypervisor
  routers stay the answer, and `docs/` gets a line saying this was tried and
  why it failed.

Either way this directory is deleted. See `../README.md`.

## Shape

Three Flux Kustomizations in `clusters/home/experiments.yaml`, each depending on
the one before:

| Kustomization | Path | Does |
|---|---|---|
| `experiment-hairpin-probe` | `probe/` | checks a pod can reach the `.app` address |
| `experiment-tailscale-operator` | `operator/` | installs the operator |
| `experiment-tailscale-connector` | `connector/` | advertises the `/32` route |

### The probe

A Job that runs once on each of three nodes:

| | Check | Expect |
|---|---|---|
| A | the app answers on the `.app` address from the pod network | `200` |
| B | the certificate on that path validates | `200` |
| C | a `.inf` hostname sent to the `.app` address is refused | `404` |

- **A will almost certainly pass**, because kube-proxy handles pod traffic to a
  LoadBalancer address inside the node. It's here because it's cheap, and
  because it stops the operator from being installed if it fails. A pass doesn't
  show the design works.
- **C is the useful one.** It's the only check in the repo that the `.app`
  address doesn't serve `.inf` routes. That separation is what makes it safe to
  point a restricted device at that address.
- **One line is `INFO`, not a check:** the pod can also reach the `.inf`
  address. Any pod can. The device is limited by its route and the tailnet
  access rule, not by the cluster.
- **If B fails**, curl's error includes the hostname, and so the domain, in a pod
  log that the read-only `view` identities can read. B needs the real hostname,
  so this is accepted.

The probe can't test whether the route is approved or whether the router
actually forwards traffic. Both are checked by hand after the Connector is up.

### The operator

Installed with the Ingress class, the API server proxy and impersonation all
off:

- **The Ingress class would put the app on a `ts.net` name.** That's a
  different design, and passkeys are tied to the domain, so they wouldn't work
  there.
- **The API server proxy would expose this cluster's control plane on the
  tailnet.**

The OAuth credential comes in through an ExternalSecret, not a Helm value, so it
never appears in the HelmRelease.

## Outside this repo

In this order:

1. **Tailnet policy.**
   - `tagOwners` for `tag:k3s-operator`, `tag:k3s` (owned by the operator tag)
     and `tag:personal-device`. These are renamed from the chart's defaults
     `tag:k8s-operator` / `tag:k8s`; the chart values here are set to match.
   - An `autoApprovers.routes` entry for the `/32` naming only `tag:k3s`. Leave
     the hypervisor routers' tag out until this graduates. If both advertise the
     route, a working device doesn't show which router carried the traffic — and
     check no hypervisor advertises a prefix that *covers* the `/32` either, or
     traffic falls back to it whenever the k3s router is down.
   - A rule letting `tag:personal-device` reach the `.app` address on 443, and
     the two resolvers on 53.

   Concrete values are in the private runbook.
2. **1Password item** `tailscale-operator`, with `client-id` and
   `client-secret`, from an OAuth client that owns `tag:k3s-operator`. A client
   can only be scoped to a tag that already exists, which is why the policy
   comes first. Until the item exists, the operator Kustomization waits. Nothing
   else is affected.
3. **DNS.** Nothing new. The tailnet already sends the domain to the two
   Pi-holes. Add the hostname's record on both, as for any `.app` host.

## Operating notes

- **Re-run the probe:** `kubectl -n tailscale delete job hairpin-probe`, then
  `flux reconcile kustomization experiment-hairpin-probe`. Jobs are immutable,
  and there's deliberately no TTL: with one, Flux would recreate the Job and
  the probe would run forever.
- **Read the result:** `kubectl -n tailscale logs -l job-name=hairpin-probe`.
- <a id="checking-the-route"></a>**Check the route:** `kubectl get connector`
  shows whether the router is up. It doesn't show whether the route is approved
  or primary. Use the admin console for that, or `tailscale status` on the
  device.

## Removal

```sh
git rm -r infrastructure/experiments/tailscale-app-zone
git rm clusters/home/experiments.yaml          # if no other experiment uses it
# drop the experiments rule from renovate.json
# drop the row from infrastructure/experiments/README.md
```

`prune: true` removes everything. There are no PVCs. The operator removes its
tailnet devices when it's deleted.
