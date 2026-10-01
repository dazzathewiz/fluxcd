# infrastructure/experiments/

Time-boxed spikes that answer a question the repo cannot answer by reading it.

Everything under here is **expected to be deleted**, not maintained. The rules
that make that true, and that keep an experiment from becoming load-bearing:

- **Its own Flux `Kustomization`, and nothing depends on it.** An experiment must
  never appear in `dependsOn` of `infra-controllers`, `infra-configs` or `apps`.
  Those three form a chain with `wait: true` — a workload wedged inside one of
  them stops every app downstream from reconciling. An experiment that fails has
  to fail alone.
- **One directory, one namespace.** Removal is `git rm -r` of the directory plus
  the `Kustomization` that points at it. `prune: true` then takes the objects.
- **No PVCs.** `AGENTS.md` explains why a pruned PVC takes its Longhorn volume
  with it. An experiment that needs persistent state is not an experiment.
- **Excluded from Renovate** (`renovate.json`), so a spike does not generate
  dependency PRs for code that is meant to be thrown away.
- **A stated exit condition.** Each experiment's own README says what result
  makes it graduate into `infrastructure/` or `apps/`, and what result makes it
  go in the bin. If neither has happened, it is overdue either way.

Current experiments:

| Directory | Question | Status |
|---|---|---|
| `tailscale-app-zone/` | Can a personal device reach the `.app` zone through a Tailscale router that lives in k3s rather than on the hypervisors? | open |
