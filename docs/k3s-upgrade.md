# k3s upgrade -- v1.30 to v1.34

The cluster has been on k3s v1.30.2+k3s2 since it was built. Three charts have
since outrun it, and each is held back by a pin that exists only because of
the old Kubernetes version:

| Pin | Why | Lift when |
|---|---|---|
| Longhorn `<1.13.0` (`infrastructure/controllers/longhorn.yaml`) | Longhorn 1.13 requires Kubernetes 1.34+ | on 1.34 |
| rook-ceph `1.21.0` (`infrastructure/controllers/rook-ceph.yaml`) | 1.21.1 CRDs use CEL format rules 1.30 rejects | on 1.34 (1.32 would do) |
| Rancher `<2.16.0` (`infrastructure/configs/rancher.yaml`) | Rancher 2.15 supports 1.34 to 1.36, and 2.16 drops older releases | on 1.34 |

The exit condition for this work is the cluster on 1.34 or newer with those
three pins removed and the `rancher-turtles` release unlocked (procedure in
PR #206).

Kubernetes does not support skipping minor versions, so the path is four
steps, **one PR per step**:

| Step | Target | Plan version |
|---|---|---|
| 1 | 1.31 | `v1.31.14+k3s1` (done 2026-10-28) |
| 2 | 1.32 | `v1.32.13+k3s1` (latest patch on 2026-10-28; re-check) |
| 3 | 1.33 | `v1.33.13+k3s2` (re-check) |
| 4 | 1.34 | `v1.34.12+k3s1` (re-check) |

Each step's `rancher/k3s-upgrade` image tag (version with `+` → `-`) was
confirmed to exist on 2026-10-28.

## Mechanism

`system-upgrade-controller` (SUC) in the `tools` namespace runs two Plans from
`apps/tools/system-upgrade-controller/plans/`, applied by their own Flux
Kustomization `system-upgrade-controller-plans` (not by `apps`):

- `server` -- control-plane nodes, one at a time, cordoned (not drained).
- `agent` -- workers, one at a time, not cordoned or drained. Its `prepare`
  step waits for the `server` Plan to finish, so workers never run ahead of
  the control plane.

A step is a change to `spec.version` in **both** Plans. Nothing is evicted, so
there is no drain order to plan, and pods (including the one pinned to
k3sworker2 by its passthrough hardware) stay on their node. Whether their
containers keep running depends on the containerd version the step brings:

- **Same containerd, or a patch/minor bump:** restarting k3s leaves running
  containers alone. A plain `k3s-node` restart during the 1.31 recovery caused
  zero container restarts.
- **A containerd major bump:** expect nearly every container to restart. The
  1.31 step moved containerd 1.7 → 2.1 and restarted about 110 of 129
  containers. Volumes detach and reattach with them, so Longhorn goes through
  a degraded/rebuild cycle (see "During and after every step").

| Step | containerd | Expected restarts |
|---|---|---|
| 1.31 (`v1.31.14+k3s1`) | 1.7.17 → 2.1.5 | nearly all (happened) |
| 1.32 (`v1.32.13+k3s1`) | 2.1.5 → 2.1.5 | none expected |
| 1.33 (`v1.33.13+k3s2`) | 2.1.5 → 2.2.5 | few or none expected |
| 1.34 (`v1.34.12+k3s1`) | 2.2.5 → 2.2.7 | none expected |

Versions are from each release's component table. Re-check them if the target
patch changes.

The nodes' k3s services are named by the k3s-ansible installer: workers run
`k3s-node.service`, not `k3s-agent`. Confirm a node's unit with
`systemctl list-units --type=service --all | grep -i k3s` before acting on it.

**SUC "Ready but not advancing" is expected.** Both Plans report `Complete`
with `latestVersion: v1.30.2-k3s2` because that is the version they ask for,
and every node is already on it. There are no Jobs, and the controller log
is clean. SUC is idle, not broken. It acts as soon as `spec.version` changes.

**The rollout starts within minutes of merge.** The Git source polls every
minute, and a source change triggers the Plans Kustomization. **Merge only
when someone can watch the whole step.** That is a requirement, not a
suggestion. An unattended step is how a failure cascades: `infra-controllers`
has `wait: true`, so one HelmRelease that breaks on the new version holds back
`infra-configs`, `apps` and everything else.

### Rancher also has an upgrade controller

Rancher installs its own SUC in `cattle-system`. That one watches only its own
namespace, and today it has no Plans. Rancher's `local` cluster object still
records `k3sConfig.kubernetesVersion: v1.25.12+k3s1`, with imported-cluster
version management on (the `system-default`, which is `true`). The cluster is
on 1.30 anyway and there is no Plan in `cattle-system`, which suggests Rancher
acts only on an *upgrade* set through its UI. **Don't set a Kubernetes
version for `local` in the Rancher UI during this work.** That would make two
controllers drive the same nodes. Each step's checks include
`kubectl get plans -A` to catch it. Turning version management off for
`local` (annotation `rancher.io/imported-cluster-version-management: "false"`)
is an option, but it's a Rancher-side setting outside Git, so it's left as a
decision.

## Before every step

1. **Open Renovate and chart PRs are reconciled first.** Merge, close or
   explicitly defer them, so a step's PR is the only moving part. Three
   groups are **deferred until after this work**. Each PR has a comment
   saying so, and none should be merged before then. None of them is needed
   by the upgrade, and the upgrade doesn't break anything they'd replace:
   - **InvenTree** (#203, image 1.5.8 → 1.6.3). No dependency on the
     Kubernetes version either way. It's deferred because it needs
     preparatory work first. The app holds hand-entered records, so take a
     Longhorn backup before merging (`docs/inventory.md`).
   - **Flux** (#88, #92, #95, #101, #103, #104, #115, #153). Each bumps one
     controller image, or the Flux version, in `gotk-components.yaml`
     without the matching CRDs, so merging any of them alone leaves Flux
     half-upgraded. The current Flux CLI (2.9) also reports needing
     Kubernetes 1.33 or newer. Upgrade Flux once the cluster is on 1.33 or
     later, as one regenerated install that supersedes all eight. The
     installed Flux (2.7.5) is fine to keep through the upgrade: its release
     notes list 1.32 to 1.34 as supported (1.34.1 or newer), so it's below
     its supported floor today and the upgrade brings it inside.
   - **system-upgrade-controller** (#98, v0.16.3 → v0.20.2). This is the
     controller running the upgrade, so it doesn't change mid-way. The PR
     also moves only the image tag, leaving the controller manifests at
     v0.16.3 and the CRD at v0.15.2. Bump all three together after 1.34.
     The installed v0.16.3 is built against the Kubernetes 1.33 client
     libraries and uses only stable APIs (Nodes, Jobs, Secrets, its own
     Plan CRD). Upstream doesn't publish a supported range, so running it
     through 1.34 is assumed, not documented.
2. **Free disk.** Each node needs room for the new k3s binary and re-pulled
   system images. On 2026-10-28 the masters had 15-21G free and the workers
   10-14G. Stop if any node is under about 5G.
3. **Fresh etcd snapshot, copied off the node** (host step, on any master):

   ```bash
   sudo k3s etcd-snapshot save --name pre-v1.3X
   ```

   Then copy the file from `/var/lib/rancher/k3s/server/db/snapshots/` off
   the host. The scheduled snapshots (12-hourly, five kept per master) are
   **local only**: there is no S3 target, so they live on the disk of the
   node they protect. Also note which k3s binary version you came from. A
   restore has to run on that version, so keep a copy on every node first
   (repeat per node, with the version you're leaving):

   ```bash
   ssh <node> 'sudo cp /usr/local/bin/k3s /usr/local/bin/k3s-<current-version> && /usr/local/bin/k3s-<current-version> --version | head -1'
   ```

   Copy the token too, kept with the snapshot and out of both repos:
   `/var/lib/rancher/k3s/server/token`.
4. **Longhorn backup.** The `daily-backups` RecurringJob should have completed
   within the last 24h (`kubectl -n longhorn-system get backups.longhorn.io`,
   newest `Completed`), and every volume should be `healthy`.
5. **Baseline is green.** Every Flux Kustomization and HelmRelease is Ready,
   so new failures are attributable to the step.
6. **Removed APIs.** Check the `apiserver_requested_deprecated_apis` metric
   on **each** server, not the VIP, which only answers for one of them:

   ```bash
   kubectl --server=https://<server>:6443 get --raw /metrics | grep '^apiserver_requested_deprecated_apis'
   ```

   Any series with a `removed_release` at or below the target version is a
   blocker. The counter resets when the apiserver restarts, so a short uptime
   means a short window.
7. **Render and diff:**

   ```bash
   kubectl kustomize apps/tools/system-upgrade-controller/plans
   flux diff kustomization system-upgrade-controller-plans --path ./apps/tools/system-upgrade-controller/plans
   ```

## During and after every step

Watch it run:

```bash
kubectl -n tools get plans,jobs -w
kubectl get nodes -o wide -w
```

Expect one control-plane node at a time to go `SchedulingDisabled`, its Job
to complete, and the node to come back on the new version. Then the workers
go through the same cycle. Transient `dry-run failed ... unexpected EOF`
errors on Flux applies are normal while apiservers restart. One
`flux reconcile ks flux-system --with-source` clears them.

Also expect, from the 1.31 step:

- **Each upgrade Job shows one failed pod, then succeeds.** The first pod is
  killed when k3s restarts underneath it on its own node, and the Job
  retries. A pod in `Unknown` next to a `Completed` one is normal.
- **The API address drops briefly** (under a minute) when the master holding
  the kube-vip address restarts.
- **On a containerd major bump, Longhorn goes degraded and recovers by itself.**
  In 1.31, ten volumes went degraded, faulted or unknown, and auto-salvage
  plus replica rebuilds had all twelve healthy about 12 minutes after the
  last node. Don't intervene while rebuilds are progressing
  (`kubectl -n longhorn-system get engines.longhorn.io` shows rebuild
  percentages).
- **A pod or two may not come back on its own.** Check every namespace, and
  don't filter out `tools`: the 1.31 watcher did, and that hid InvenTree.
  Look for pods stuck in `ContainerCreating` or `Terminating` more than ten
  minutes after the last node finishes, then use "Recovering a stuck volume"
  below.

Done when all of these hold:

- [ ] `kubectl get nodes` -- all six `Ready`, none `SchedulingDisabled`, all
      on the target version.
- [ ] `kubectl -n tools get plans -o wide` -- both `Complete` with
      `latestVersion` the target. `kubectl get plans -A` shows nothing
      outside `tools`.
- [ ] `flux get ks -A` and `flux get hr -A` -- all Ready. If a
      HelmRelease shows a stale failure while helm-controller logs `release
      in-sync`, trust the log and use `flux reconcile hr <name> --force`.
- [ ] `kubectl -n longhorn-system get volumes.longhorn.io` -- every volume
      `healthy`, none `degraded` or `faulted`.
- [ ] `kubectl get pods -A | grep -vE 'Running|Completed'` -- nothing new
      beyond the known `rancher-turtles` crash loop.
- [ ] `kubectl` still works through the VIP after the masters restart.
      The admin client certificate is signed by the cluster CA, which an
      upgrade doesn't rotate. It was valid to 2027-08 on 2026-10-28.

## Recovering a stuck volume

Two failure shapes came up in the 1.31 step. In both, the Longhorn volume
itself was healthy, and the node's view of it was stale. Diagnose with
read-only commands first; each fix below is safe only when its check holds.

### Pod stuck in `ContainerCreating`: `failed to close active crypto device ... still in use`

The volume uses the encrypted StorageClass. A staging mount left on the node
from before the restart still holds the LUKS device open, so the CSI driver
can't close and reopen it. Seen on InvenTree's database in 1.31.

On the node the pod is scheduled to (`<pvc>` is the `pvc-...` name from the
event):

```bash
sudo dmsetup info <pvc> | grep "Open count"
sudo findmnt -rn -S /dev/mapper/<pvc> -o TARGET
sudo fuser -vm /dev/mapper/<pvc>
```

Proceed only if `findmnt` prints exactly one `.../globalmount` path and
`fuser` shows nothing but `kernel mount` (no process). Then:

```bash
sudo umount <the globalmount path>
sudo dmsetup info <pvc> | grep "Open count"
```

`Open count: 0` means it's free. kubelet's next mount retry (within a couple
of minutes) reopens the device and starts the pod. A database starts with
crash recovery, which is expected after the restart killed it.

`fuser` showing a real process instead means something still runs against
the volume. Stop there and investigate rather than unmounting.

### Pod stuck `Terminating`, then `Multi-Attach error` on the replacement

The old pod's phase is `Failed` with a deletion timestamp that never
completes, so the StatefulSet can't replace it. Seen on InfluxDB v2 in 1.31.

1. On the pod's node, confirm nothing is left:
   `sudo findmnt -rn | grep <pvc>` (nothing) and no process for the app.
2. Remove the API record:
   `kubectl -n <ns> delete pod <pod> --grace-period=0 --force`.
   This is safe only after step 1. The StatefulSet then creates a
   replacement.
3. If the replacement reports `Multi-Attach error` and the old node still
   lists the volume
   (`kubectl get node <node> -o json | jq '.status.volumesInUse'`),
   kubelet's state is stale. Restart the agent on the old node:
   `sudo systemctl restart k3s-node`. kubelet rebuilds its state from what's
   actually mounted, releases the volume, and the replacement attaches. In
   1.31 this caused no container restarts on that node.

A force-deleted pod isn't Flux drift: the StatefulSet that owns it is
unchanged.

InfluxDB v2 has a PodDisruptionBudget allowing zero disruptions. It played no
part here: a PDB only gates evictions (a drain), and these Plans don't drain.
It matters only if `drain` is ever added to the Plans, because a drain would
then block on InfluxDB v2's node indefinitely.

## Per-step notes

What was checked against the live cluster on 2026-10-28 is in "Verified" at
the end. Everything below that isn't there is from release notes and support
matrices.

### 1.30 → 1.31 (done 2026-10-28)

No Kubernetes API removals, and no chart excluded 1.31. **containerd moved
1.7.17 → 2.1.5.** The 1.33.0 release notes introduce containerd 2.0, so this
doc originally placed the change at 1.33, but later 1.31 patches carry it.

What happened, in UTC:

- 06:38–06:52: rollout, masters then workers. About 110 container restarts.
  The API address dropped for under a minute.
- 07:04: Longhorn healed all twelve volumes by itself.
- 07:18 and 07:21: InvenTree's database and InfluxDB v2 needed the two
  recoveries in "Recovering a stuck volume". Postgres crash recovery was
  clean.
- 07:22: everything Ready.

Any custom containerd config template would have broken at this step. None
did: all six nodes came up on containerd 2.1.

### 1.31 → 1.32

- Kubernetes removes `flowcontrol.apiserver.k8s.io/v1beta3`. No client was
  seen requesting it. Re-check the metric before this step.
- k3s removes its secrets-encryption controller. Doesn't apply: no server
  runs with `--secrets-encryption`.
- Rook 1.21 and Cluster API 1.13 (used by Rancher Turtles) both support 1.32
  as their minimum, so this is the first step where the turtles controller
  could start. It still needs the Helm release unlocked first (PR #206).

### 1.32 → 1.33

- **containerd 2.1 → 2.2.** The containerd 2 migration already happened at
  1.31, and every node runs 2.1 with whatever config it has, so the
  `config-v3.toml.tmpl` concern from the 1.33.0 release notes is settled.
  This step is a minor containerd bump, so few or no container restarts are
  expected.
- The `Endpoints` API is deprecated, with warnings only and no removal
  scheduled. Traefik v2 (chart 23.x) still reads it. This doesn't force the
  Traefik v3 migration.
- cert-manager 1.21 and the Flux 2.9 CLI list 1.33 as their minimum. Both
  run today, so this brings them into support rather than fixing a fault.

### 1.33 → 1.34

- **k3s stops setting the `node-role.kubernetes.io/master` label.** The
  `server` Plan's nodeSelector requires `master In [true]`. Existing nodes
  should keep the label they already have. A node built or rejoined later
  won't have it, and the `server` Plan would silently skip that node. **Drop
  the `master` matchExpression from `server.yaml` in the step-3 PR**, before
  1.34 lands. `control-plane Exists` already selects the same three nodes.
- k3s drops the `master` toleration from its packaged manifests (CoreDNS,
  metrics-server, local-path). The masters carry a custom
  `node-role.kubernetes.io/master=true:NoSchedule` taint, set by the
  provisioning repo's `--node-taint`, so those pods will only schedule on
  workers. That's already where they run. Moving that taint to
  `node-role.kubernetes.io/control-plane` is a provisioning-repo change and
  doesn't block this.
- kube-vip (deployed from the servers' auto-deploy manifests, not this repo)
  selects nodes by `master` **or** `control-plane`, so it's unaffected.
- After this step: remove the three pins (separate PRs), unlock
  `rancher-turtles`, and let Renovate offer Longhorn 1.13. Then pick up the
  deferred PRs (see "Before every step", item 1): a full Flux upgrade, which
  can happen as early as after the 1.33 step, and the system-upgrade-controller
  bump with its manifests and CRD.

## Rollback

**`git revert` is not a rollback for this change.** Reverting the Plan
version makes SUC install the *older* binary over an etcd datastore the newer
apiserver has already written. That is an in-place minor-version downgrade,
which Kubernetes doesn't support. So the usual rule in AGENTS.md doesn't apply
to this one change. In order of preference:

1. **Fix forward.** If one node's Job fails, or one HelmRelease breaks,
   fix that piece. Mixed versions mid-step are within the supported skew
   (kubelets one minor behind the apiserver, servers rolling one at a time),
   so a half-finished step is a stable state to debug from.
2. **Restore etcd (control plane unusable).** This is a host procedure for a
   human, and it hasn't been tested on this cluster:
   1. Stop SUC from re-applying the step:
      `flux suspend kustomization system-upgrade-controller-plans`.
   2. Stop k3s on all three servers. Workers run `k3s-node.service`.
      Confirm the servers' unit name with
      `systemctl list-units --type=service --all | grep -i k3s`.
   3. On one server, put back the k3s binary you came from, then run
      `k3s server --cluster-reset --cluster-reset-restore-path=<pre-step snapshot>`.
   4. Start k3s on it. On the other two servers, clear
      `/var/lib/rancher/k3s/server/db`, put back the old binary, and start
      them so they rejoin.
   5. Workers: put back the old agent binary and restart.
   6. Revert the step's PR. Once nodes and Plans agree, resume the
      Kustomization.
   (k3s documents this as "etcd snapshot restore".)

PVC data lives in Longhorn, not etcd, so an etcd restore doesn't touch volume
contents. Longhorn backups are the safety net for data. etcd snapshots are
the safety net for cluster state.

## Verified, assumed, handed off

Verified on 2026-10-28 against the live cluster (read-only):

- All six nodes `v1.30.2+k3s2`, `Ready`. Plans `Complete` at that version, no
  Jobs, SUC log clean.
- No request to an API with a `removed_release` on any of the three
  apiservers (about 32h of uptime each). Seen: `componentstatuses` (no removal
  scheduled) and Flux `notification v1beta2` (a Flux CRD version, not a
  Kubernetes API).
- No Helm release declares a `kubeVersion` that excludes 1.31 to 1.34. The
  constraints found were `>=1.16` to `>=1.25` minimums and Rancher's
  `<1.37.0-0`.
- Upstream support: Longhorn 1.12.1 needs 1.25+. Rook 1.21 supports 1.32 to
  1.37. cert-manager 1.21 supports 1.33 to 1.36. Rancher 2.15 supports 1.34
  to 1.36. Every step moves these toward or into support; none moves one out.
- All Flux Kustomizations and HelmReleases Ready. The only unhealthy pod is
  the known `rancher-turtles` crash loop. Both `rancher-turtles` and
  `fleet-agent-local` Helm releases are `pending-upgrade`.
- etcd: 12-hourly scheduled snapshots, five per master, local only (no S3).
- Longhorn: backup target available. Daily and weekly backups and 12-hourly
  snapshots cover the `default` group. All 12 volumes attached and healthy.
  Latest backups `Completed` on 2026-10-28.
- k3s bundled Traefik and ServiceLB are disabled, so k3s's own Traefik bumps
  (v3 from 1.33) don't touch the cluster's Traefik.
- All six VMs run CPU type `x86-64-v2-AES`. k3sworker2 has no `balloon` set,
  so its memory is fixed at its configured size (the `balloon: 0` setting
  isn't recorded, but the effect is the same). k3sworker1 and k3sworker3 can
  still balloon down to half their memory under host pressure.
- Masters are at about 3.5G of 4G memory in use.

Assumed, not verified:

- Rancher won't act on the stale `v1.25.12` desired version (inferred from
  it not having done so at 1.30).
- Existing nodes keep the `master` label after 1.34.
- system-upgrade-controller v0.16.3 works on 1.31 to 1.34 (no published
  support range).
- The etcd restore procedure above. It has never been exercised here.

Handed off to a human: the pre-step etcd snapshot and off-host copy, merging
each step, and watching each rollout.

Verified by the 1.31 step itself (2026-10-28):

- The Plans roll masters, then workers, one at a time, and the
  admin kubeconfig keeps working through the masters' restarts.
- Rancher didn't interfere: no Plans appeared outside `tools`.
- The installed Flux, the system-upgrade-controller and every HelmRelease
  ran on 1.31 without changes.
- Longhorn recovers from a cluster-wide restart by itself, except for the
  two stale-node-state cases in "Recovering a stuck volume".

## From the homelab backlog

The homelab project's backlog had hazards and requirements for this upgrade
written down before this plan. Here's where each one landed, so none is lost
between the two:

| Backlog item | Where it's handled |
|---|---|
| Upgrade controller and Plans "Ready but not advancing" | Investigated first, see Mechanism. They're idle at their own target version, not broken. |
| Reconcile open Renovate PRs before starting | Before every step, item 1. Exception: the InvenTree PR, the eight Flux PRs and the system-upgrade-controller PR are deliberately deferred until after this work, with a comment on each saying why. |
| Watch the upgrade as it runs, no fire-and-forget | Mechanism ("merge only when someone can watch") and "During and after every step". |
| No skipping minors; check API removals and chart support at each step | Four steps, one PR each. Per-step notes, and the removed-API check in "Before every step". |
| Renovate has never tracked the Helm charts | Every chart's supported Kubernetes range was checked by hand for 1.31 to 1.34 (Verified). Widening Renovate's `flux` manager is separate work. |
| Rancher on a floating range, not to be pinned | Rancher is currently capped `<2.16.0` (PR #206), a stopgap until 1.34. Removing the cap is part of the exit condition at the top. Rancher 2.15 supports 1.34 to 1.36. |
| Traefik v3 migration kept separate | No step through 1.34 forces it (1.33 note). |
| `infra-controllers` `wait: true` cascades a chart failure | Mechanism, and the HelmRelease check after each step. |
| Frozen HelmRelease conditions after a fix | Post-step checks: trust the helm-controller log and use `flux reconcile hr --force`. |
| Longhorn HelmRelease has no retry | PR #209 (`RetryOnFailure`, not remediation retries, because a remediation rolls back). |
| Admin kubeconfig may go stale after master restarts | Expiry checked (2027-08, CA-signed). Re-checking `kubectl` access is a post-step check. |
| VM CPU type `x86-64-v2-AES` | Verified on all six VMs. |
| Master disks filled by log flooding | Free disk checked before each step (threshold about 5G). The journald cap itself is host config and wasn't checked from here. |
| Worker memory ballooning | Verified per VM (see Verified). k3sworker2 is effectively static. k3sworker1 and k3sworker3 can still balloon. |
| k3sworker2 hard-pinned to its host | Nothing is drained, so its pods stay where they are through its upgrade. |
| Transient `unexpected EOF` on Flux applies | "During and after every step": one `flux reconcile ks flux-system --with-source`. |
| Optional `--tls-san` for a tailnet address | Not part of this work. The Plans swap the binary and keep the server flags, so a step's restart doesn't apply new args. Adding it is a change in the provisioning repo with its own restart. |
| Provisioning may pin the k3s version for new nodes | The `infrastructure` repo has no pin. k3s itself is installed by the separate k3s-ansible repo, which **hasn't been checked**. A node built from it after this upgrade must not come up on 1.30. |

## Known gaps

- The SUC CRD comes from release v0.15.2 while the controller runs v0.16.3
  (`apps/tools/system-upgrade-controller/app/kustomization.yaml`). The
  controller updates its embedded CRD at startup (it logs this), so it works.
  Align them when #98 is picked up after 1.34.
- Renovate doesn't propose k3s bumps: the Plans' `# renovate:` comments have
  no matching custom manager. PR #208 adds one.
- The Longhorn HelmRelease has no upgrade policy, so one failed upgrade
  leaves it failed until someone intervenes. PR #209 adds `RetryOnFailure`,
  which retries forward and never rolls back (Longhorn doesn't support
  downgrades). It should be merged before Longhorn 1.13 arrives at the end
  of this work.
