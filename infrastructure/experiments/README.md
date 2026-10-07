# infrastructure/experiments/

Short-lived spikes that are meant to be deleted, not maintained. Rules:

- **Its own Flux Kustomization, and nothing depends on it.** Kustomizations go
  in `clusters/home/experiments.yaml` (create it; it is deleted when empty).
  Never put an experiment in the `dependsOn` of `infra-controllers`,
  `infra-configs` or `apps`. Those three are chained by `dependsOn`, and each
  waits for the one before it to be Ready (`infra-controllers` and `apps` also
  have `wait: true`; `infra-configs` doesn't). A stuck experiment in that chain
  would stop every app from updating.
- **One directory, one namespace.** Removal is `git rm -r` of the directory
  plus its Kustomization. `prune: true` does the rest.
- **Graduating is a move, not a removal.** Suspend the experiment's
  Kustomizations before the graduation merges. A deleted, unsuspended
  Kustomization garbage-collects its inventory, racing the new owner for the
  same objects.
- **No PVCs.** A pruned PVC deletes its Longhorn volume (see `AGENTS.md`).
- **Excluded from Renovate** (`renovate.json`).
- **A stated exit condition.** Each README says what makes the experiment
  graduate and what makes it go in the bin.

| Directory | Question | Status |
|---|---|---|
| `tailscale-app-zone/` | Can a personal device reach the `.app` zone through a Tailscale router running in k3s instead of on the hypervisors? | graduated: `docs/app-zone.md` |
