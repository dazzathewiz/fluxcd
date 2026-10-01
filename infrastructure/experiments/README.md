# infrastructure/experiments/

Short-lived spikes that are meant to be deleted, not maintained. Rules:

- **Its own Flux Kustomization, and nothing depends on it.** Never put an
  experiment in the `dependsOn` of `infra-controllers`, `infra-configs` or
  `apps`. Those three are chained with `wait: true`, so a stuck experiment would
  stop every app from updating.
- **One directory, one namespace.** Removal is `git rm -r` of the directory
  plus its Kustomization. `prune: true` does the rest.
- **No PVCs.** A pruned PVC deletes its Longhorn volume (see `AGENTS.md`).
- **Excluded from Renovate** (`renovate.json`).
- **A stated exit condition.** Each README says what makes the experiment
  graduate and what makes it go in the bin.

| Directory | Question | Status |
|---|---|---|
| `tailscale-app-zone/` | Can a personal device reach the `.app` zone through a Tailscale router running in k3s instead of on the hypervisors? | open |
