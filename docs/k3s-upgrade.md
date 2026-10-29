# k3s upgrade -- v1.30 to v1.34

**Status: done on 2026-10-28.** All six nodes run v1.34.12+k3s1, the three
chart pins below are lifted, and `rancher-turtles` is healthy. This doc is now
the record of how it went and the procedure for future k3s minors, which
arrive as Renovate PRs (see "Future k3s upgrades").

The cluster had been on k3s v1.30.2+k3s2 since it was built. Three charts
outran it, and each was held back by a pin that existed only because of the
old Kubernetes version:

| Pin | Why | Lifted |
|---|---|---|
| Longhorn `<1.13.0` (`infrastructure/controllers/longhorn.yaml`) | Longhorn 1.13 requires Kubernetes 1.34+ | #215, upgraded to 1.13.0 |
| rook-ceph `1.21.0` (`infrastructure/controllers/rook-ceph.yaml`) | 1.21.1 CRDs use CEL format rules 1.30 rejects | #216, upgraded to v1.21.1 |
| Rancher `<2.16.0` (`infrastructure/configs/rancher.yaml`) | Rancher 2.15 supports 1.34 to 1.36, and 2.16 drops older releases | #217, still 2.15.2 (2.16 not yet published) |

The exit condition was the cluster on 1.34 or newer with those three pins
removed and the `rancher-turtles` release unlocked. All three held by
2026-10-28. The turtles release recovered by itself (see "After 1.34").

Kubernetes does not support skipping minor versions, so the path was four
steps, **one PR per step**:

| Step | Target | Plan version | PR | Rollout (UTC, 2026-10-28) |
|---|---|---|---|---|
| 1 | 1.31 | `v1.31.14+k3s1` | #207 | 06:38–06:52, then manual recovery to 07:22 |
| 2 | 1.32 | `v1.32.13+k3s1` | #211 | 07:42–07:49 |
| 3 | 1.33 | `v1.33.13+k3s2` | #213 | 08:13–08:22 |
| 4 | 1.34 | `v1.34.12+k3s1` | #214 | 08:33–08:41 |

Step 1 was opened by hand. Steps 2–4 came from Renovate (#208) after ticking
each minor on the Dependency Dashboard. Each step's `rancher/k3s-upgrade`
image tag (version with `+` → `-`) was confirmed to exist before merge.

## Mechanism

`system-upgrade-controller` (SUC) in the `tools` namespace runs two Plans from
`apps/tools/system-upgrade-controller/plans/`, applied by their own Flux
Kustomization `system-upgrade-controller-plans` (not by `apps`):

- `server` -- control-plane nodes, one at a time, cordoned (not drained).
  Selects on `node-role.kubernetes.io/control-plane` only (#212), because
  k3s 1.34 stops setting the `master` label.
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

| Step | containerd | Container restarts (excluding upgrade Jobs) |
|---|---|---|
| 1.31 (`v1.31.14+k3s1`) | 1.7.17 → 2.1.5 | about 110 of 129 |
| 1.32 (`v1.32.13+k3s1`) | 2.1.5 → 2.1.5 | 4 (turtles crash loop, 3 Longhorn CSI helpers) |
| 1.33 (`v1.33.13+k3s2`) | 2.1.5 → 2.2.5 | 1 (turtles crash loop) |
| 1.34 (`v1.34.12+k3s1`) | 2.2.5 → 2.2.7 | 3 (turtles crash loop, Longhorn CSI snapshotter, NFD worker) |

Versions are from each release's component table.

The nodes' k3s services are named by the k3s-ansible installer: workers run
`k3s-node.service`, not `k3s-agent`. Confirm a node's unit with
`systemctl list-units --type=service --all | grep -i k3s` before acting on it.

**SUC "Ready but not advancing" was expected.** Before step 1, both Plans
reported `Complete` with `latestVersion: v1.30.2-k3s2` because that was the
version they asked for, and every node was already on it. SUC is idle between
steps, not broken. It acts as soon as `spec.version` changes.

**The rollout starts within minutes of merge.** The Git source polls every
minute, and a source change triggers the Plans Kustomization. **Merge only
when someone can watch the whole step.** That is a requirement, not a
suggestion. An unattended step is how a failure cascades: `infra-controllers`
has `wait: true`, so one HelmRelease that breaks on the new version holds back
`infra-configs`, `apps` and everything else.

### Rancher also has an upgrade controller

Rancher installs its own SUC in `cattle-system`. That one watches only its own
namespace. Rancher's `local` cluster object still records
`k3sConfig.kubernetesVersion: v1.25.12+k3s1`, with imported-cluster version
management on (the `system-default`, which is `true`). Rancher never created a
Plan in `cattle-system` through any of the four steps, which fits it acting
only on an *upgrade* set through its UI. **Don't set a Kubernetes version for
`local` in the Rancher UI.** That would make two controllers drive the same
nodes. Each step's checks include `kubectl get plans -A` to catch it. Turning
version management off for `local` (annotation
`rancher.io/imported-cluster-version-management: "false"`) is an option, but
it's a Rancher-side setting outside Git, so it's left as a decision.

## Future k3s upgrades

Renovate tracks the Plans' `# renovate:` comments (#208), one PR per minor,
and holds each one on the Dependency Dashboard. To take the next minor:

1. Check the release's support against the deployed charts and Rancher's
   matrix (Rancher 2.15 supports up to 1.36). Read the k3s release notes for
   the containerd version and any "action required" items.
2. Tick **only the next minor** on the Dependency Dashboard. Renovate opens a
   PR that changes both Plans' `version:`.
3. Check the PR's diff, then run "Before every step" below.
4. Merge when someone can watch, and follow "During and after every step".

## Before every step

1. **Open Renovate and chart PRs are reconciled first.** Merge, close or
   explicitly defer them, so a step's PR is the only moving part. During
   1.30 → 1.34, three groups were **deferred until after the upgrade**, each
   with a comment on the PR saying so. They're now unblocked (see "Open
   follow-ups"):
   - **InvenTree** (#203, image 1.5.8 → 1.6.3). No dependency on the
     Kubernetes version either way. Deferred because it needs preparatory
     work first. The app holds hand-entered records, so take a Longhorn
     backup before merging (`docs/inventory.md`).
   - **Flux** (#88, #92, #95, #101, #103, #104, #115, #153). Each bumps one
     controller image, or the Flux version, in `gotk-components.yaml`
     without the matching CRDs, so merging any of them alone leaves Flux
     half-upgraded. The Flux 2.9 CLI needs Kubernetes 1.33 or newer. Upgrade
     Flux as one regenerated install that supersedes all eight. The installed
     Flux (2.7.5) ran unchanged through every step.
   - **system-upgrade-controller** (#98, v0.16.3 → v0.20.2). It was the
     controller running the upgrade, so it didn't change mid-way. The PR
     moves only the image tag, leaving the controller manifests at v0.16.3
     and the CRD at v0.15.2. Bump all three together.
2. **Free disk.** Each node needs room for the new k3s binary and re-pulled
   system images. On 2026-10-28 the masters had 14-21G free and the workers
   10-21G. Stop if any node is under about 5G.
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
   so new failures are attributable to the step. A merge briefly makes most
   Kustomizations "not ready" while each waits for its dependency to apply the
   new revision. That ripple is normal and clears on its own; wait for it.
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

Also expect:

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
  percentages). Steps without a containerd major bump (1.32, 1.33, 1.34)
  kept every volume healthy throughout.
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
- [ ] `kubectl get pods -A | grep -vE 'Running|Completed'` -- nothing.
- [ ] No stale encrypted mappings on any node. See "Leftover encrypted
      mappings" below. A step that restarts containerd moves volumes, and a
      mapping left on the old node breaks the next pod scheduled there.
- [ ] `kubectl` still works through the VIP after the masters restart.
      The admin client certificate is signed by the cluster CA, which an
      upgrade doesn't rotate. It was valid to 2027-08 on 2026-10-28.

## Recovering a stuck volume

Four failure shapes came up. In each, the Longhorn volume itself was
healthy, and the node's view of it was stale or claimed by something else.
Diagnose with read-only commands first; each fix below is safe only when its
check holds.

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

### Pod stuck in `ContainerCreating`: `luksOpen` says the device is in use

`multipathd` has claimed the disk Longhorn attaches to the node. Longhorn
presents each attached volume as an iSCSI disk (`/dev/sdX`, vendor
`IET,VIRTUAL-DISK`). Without a blacklist, `multipathd` wraps it in an
`mpathX` map, and `cryptsetup luksOpen` then can't open the disk underneath.
There's no stale encrypted mapping for the volume on the node, which tells
this apart from the case above.

Seen on Tautulli and Grafana on k3sworker3 after the Longhorn 1.13 upgrade,
not during a k3s step. k3sworker3 was the one node whose
`/etc/multipath.conf` had no blacklist. The other two workers had one, set up
by hand.

On the node:

```bash
systemctl is-active multipathd
sudo multipath -ll
```

Any `mpath*` map with vendor `IET,VIRTUAL-DISK` is a Longhorn volume. Compare
its size with the stuck volumes. The node's root disk isn't multipathed on
these VMs, so blacklisting every `sd*` device doesn't touch it. Check that
with `multipath -ll` first on any new node type.

Fix, as Longhorn's documentation recommends:

```bash
printf 'blacklist {\n    devnode "^sd[a-z0-9]+"\n}\n' | sudo tee -a /etc/multipath.conf
sudo systemctl restart multipathd
sudo multipath -f <mpathX>   # once per Longhorn map
sudo multipath -ll           # nothing left
```

Flushing a map only removes the multipath layer. The data is on the disk
underneath and isn't touched. kubelet's next mount retry starts the pod.

**The blacklist isn't in Git.** Nothing in either repo puts it on a node,
so a rebuilt or new node will hit this the first time a volume attaches to
it. It belongs in node provisioning (see "Open follow-ups").

### Leftover encrypted mappings

When a volume moves to another node, the encrypted (`dm-crypt`) mapping can
stay behind on the old one. It does no harm until the volume is scheduled
back to that node. The CSI driver then can't open a mapping that already
exists, and the pod sticks in `ContainerCreating`. After the 1.31 step,
k3sworker2 still held mappings for three volumes (both InfluxDB volumes and
Mosquitto) that had moved to other workers. They were found and closed after
the upgrade was done, before any of those pods came back to k3sworker2.

After a step that restarts containerd, compare each node's mappings with
what Longhorn has attached to it:

```bash
# on each node
sudo dmsetup ls --target crypt
# from a workstation
kubectl -n longhorn-system get volumes.longhorn.io \
  -o custom-columns=NAME:.metadata.name,NODE:.status.currentNodeID
```

Every `pvc-...` mapping on a node should belong to a volume attached to that
node. For each one that doesn't:

```bash
sudo dmsetup info <pvc> | grep "Open count"
sudo dmsetup deps <pvc>
sudo findmnt -rn -S /dev/mapper/<pvc> -o TARGET
sudo fuser -vm /dev/mapper/<pvc>
```

- **`Open count: 0`, no mount, no process:** close it with
  `sudo cryptsetup luksClose <pvc>`.
- **`Open count: 1`, a single `globalmount`, only `kernel mount` from
  `fuser`:** unmount it first, as in the first case above, then close it.
- **A real process in `fuser`:** stop and investigate.

## Per-step notes

What was checked against the live cluster is in "Verified" at the end.
Everything below that isn't there is from release notes and support matrices.

### 1.30 → 1.31 (done 2026-10-28, #207)

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

### 1.31 → 1.32 (done 2026-10-28, #211)

- Kubernetes removes `flowcontrol.apiserver.k8s.io/v1beta3`. No client was
  seen requesting it on any apiserver.
- k3s removes its secrets-encryption controller. Doesn't apply: no server
  runs with `--secrets-encryption`.
- Rook 1.21 and Cluster API 1.13 (used by Rancher Turtles) both list 1.32 as
  their minimum.
- Outcome: 07:42–07:49, about 7 minutes. containerd unchanged. 4 container
  restarts, all 12 volumes healthy throughout, no manual recovery.

### 1.32 → 1.33 (done 2026-10-28, #213)

- **containerd 2.1 → 2.2.** The containerd 2 migration already happened at
  1.31, so the `config-v3.toml.tmpl` concern from the 1.33.0 release notes
  was settled.
- The `Endpoints` API is deprecated, with warnings only and no removal
  scheduled. Traefik v2 (chart 23.x) still reads it. This doesn't force the
  Traefik v3 migration.
- From 1.33, disabling a bundled k3s addon deletes everything that addon ever
  created. Doesn't apply: the cluster has no `traefik` or `servicelb` addon
  objects, and the Traefik CRDs carry no k3s or Helm ownership.
- cert-manager 1.21 and the Flux 2.9 CLI list 1.33 as their minimum. Both
  ran beforehand, so this brought them into support rather than fixing a
  fault.
- Outcome: 08:13–08:22. 1 container restart (the turtles crash loop), all 12
  volumes healthy throughout, no manual recovery. Traefik's three replicas
  kept running.

### 1.33 → 1.34 (done 2026-10-28, #214)

- **k3s stops setting the `node-role.kubernetes.io/master` label** on new
  nodes. The `server` Plan used to require `master In [true]`, so #212
  (merged before 1.33) dropped that and selects on `control-plane` only. The
  existing masters **kept** their `master=true` label after 1.34, so the old
  selector would still have worked today, but a rebuilt master wouldn't have
  matched.
- **k3s drops the `master` toleration from its packaged manifests** (CoreDNS,
  metrics-server, local-path-provisioner). Before 1.34 these three ran **on
  the masters** (k3smaster2 and k3smaster3), not on workers as this doc first
  said. The masters carry a custom `node-role.kubernetes.io/master=true:NoSchedule`
  taint, set by the provisioning repo's `--node-taint`, so the 1.34 manifests'
  replacement pods could only schedule on workers: all three landed on
  k3sworker1. Each is a single replica, so expect a brief DNS gap while
  CoreDNS moves. Cluster and external DNS and `kubectl top` were checked
  afterwards. Moving that taint to `node-role.kubernetes.io/control-plane` is
  a provisioning-repo change.
- kube-vip (deployed from the servers' auto-deploy manifests, not this repo)
  selects nodes by `master` **or** `control-plane`, so it's unaffected.
- The 1.34.12 release notes mention upgrading "Traefik chart to v40.x". That's
  k3s's bundled Traefik, which these servers disable (`--disable traefik`).
  The Flux-managed Traefik (chart 23.x, capped `<24.0.0`) is untouched.
- Outcome: 08:33–08:41. 3 container restarts, all 12 volumes healthy
  throughout, no manual recovery.

## After 1.34: pins, turtles and Longhorn

### Pins lifted

- **rook-ceph (#216)** → v1.21.1. All 27 1.21.1 CRDs passed a server-side dry
  run on 1.34 before merge, and `infra-controllers` applied them (the step
  that failed on 1.30). Rook currently manages no `CephCluster` and backs no
  PV (the external-cluster config is commented out), so its 1.21.1 changes
  had nothing to act on.
- **Rancher (#217)** → range `<3.0.0`, which still resolves to 2.15.2: no 2.16
  is published in `stable` or `latest`. No new Helm revision.
- **Longhorn (#215)** → 1.13.0, see below.

### Rancher Turtles recovered by itself

The `rancher-turtles` Helm release had been stuck in `pending-upgrade` since
2026-05-04, and #206 documented a manual unlock for after the upgrade. **It
wasn't needed.** At 08:47 UTC, just after the 1.34 rollout, Rancher retried
the release and it completed (revision 777, chart 110.0.2+up0.27.2). The
controller runs v0.27.2 and the `cluster-api` CAPIProvider is v1.13.3,
phase `Ready`. `fleet-agent-local`, also stuck in `pending-upgrade`, completed
at 08:38. The controller still logs `multiple ConfigMaps match selector`,
probably provider ConfigMaps left from the versions it was stuck between (see
"Open follow-ups").

### Longhorn 1.12.1 → 1.13.0 (#215)

Pre-flight found no blockers:

- The only applicable breaking change is the Kubernetes 1.34 minimum.
- All volumes use the V1 engine, so the V2-only notes didn't apply.
- All 28 CRDs passed a server-side dry run.
- There were no faulted volumes and no backing images.
- 9 volumes were still on the v1.7.2 engine. Longhorn 1.13.0's pre-upgrade
  check (`checkEngineUpgradePath`) accepts engines with controller API 4–6
  and CLI API 8–12; v1.7.2 reports 5 and 10.

A Longhorn system backup (`pre-longhorn-1-13-2026-10-28`, taken from v1.12.1)
was created first. The upgrade (Helm revision 20) ran 09:55:52–09:57:41 UTC.
All 12 volumes stayed attached and healthy throughout, and the new
`longhorn-global-manager` came up 3/3. Only Longhorn's own CSI helpers
restarted.

### Engine upgrades

`concurrent-automatic-engine-upgrade-per-node-limit` had been `0`, which is
why most volumes were still on the v1.7.2 engine. Set to `1`, Longhorn
live-upgraded all 12 volumes to the v1.13.0 engine in about 90 seconds
(10:06:20–10:07:33 UTC), with no detach, no unhealthy volume and no container
restart. The setting is now in Git (#219), so later Longhorn upgrades move
engines forward by themselves.

### Backup target in Git (#219)

The backup target was set under `defaultSettings`, which the chart has ignored
since Longhorn 1.8: `longhorn-default-resource` rendered empty, and the live
`BackupTarget` only survived from an older install. A rebuild from Git would
have come up with none. #219 moved it to `defaultBackupStore`. The live
`BackupTarget` spec (URL, credential secret, `pollInterval: 5m0s`) and
availability were identical before and after. longhorn-manager keeps existing
values for keys the ConfigMap omits and skips the update when nothing differs.

### Chart pins and Renovate (#218)

The lifted ranges (`>=1.4.2`, `1.x.x`, `<3.0.0`) floated outside Renovate's
view, which is how each chart outran Kubernetes in the first place. #218 pins
each to the version it runs (Longhorn `1.13.0`, rook-ceph `v1.21.1`, Rancher
`2.15.2`) and adds their files, plus Rancher's `HelmRepository` file, to
Renovate's `flux` manager:

- All three: one PR per minor (`separateMultipleMinor`), because each
  supports upgrading only one minor at a time.
- Longhorn and rook-ceph minors and majors wait on the Dependency Dashboard.
  Patches open PRs directly.
- Rancher has no approval gate: every release arrives as a PR, so it stays
  current without upgrading itself.

A Longhorn or Rook upgrade PR gets the same treatment as #215: release notes,
CRD dry run, and a system backup before a minor.

## Rollback

**`git revert` is not a rollback for a k3s step.** Reverting the Plan version
makes SUC install the *older* binary over an etcd datastore the newer
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

The same no-downgrade rule applies to Longhorn: don't revert a Longhorn
upgrade once it has started. Fix forward (the HelmRelease uses
`RetryOnFailure`), and restore from a system or volume backup if data is
at risk.

## Verified, assumed, handed off

Verified against the live cluster before step 1 (2026-10-28, read-only):

- All six nodes `v1.30.2+k3s2`, `Ready`. Plans `Complete` at that version, no
  Jobs, SUC log clean.
- No request to an API with a `removed_release` on any of the three
  apiservers. The check was repeated before each step.
- No Helm release declares a `kubeVersion` that excludes 1.31 to 1.34.
- Upstream support: Longhorn 1.12.1 needs 1.25+. Rook 1.21 supports 1.32 to
  1.37. cert-manager 1.21 supports 1.33 to 1.36. Rancher 2.15 supports 1.34
  to 1.36. Flux 2.7.5 supports 1.32 to 1.34.
- etcd: 12-hourly scheduled snapshots, five per master, local only (no S3).
- Longhorn: backup target available. Daily and weekly backups and 12-hourly
  snapshots cover the `default` group.
- k3s bundled Traefik and ServiceLB are disabled.
- All six VMs run CPU type `x86-64-v2-AES`. k3sworker2 has no `balloon` set,
  so its memory is fixed. k3sworker1 and k3sworker3 can still balloon down to
  half their memory under host pressure.

Verified by the upgrade itself:

- The Plans roll masters, then workers, one at a time, and the admin
  kubeconfig keeps working through the masters' restarts.
- Rancher didn't interfere: no Plans appeared outside `tools` in any step.
- The installed Flux (2.7.5), system-upgrade-controller (v0.16.3) and every
  HelmRelease ran on 1.31 through 1.34 without changes.
- Existing nodes kept the `master` label after 1.34.
- Longhorn recovers from a cluster-wide restart by itself, except for the
  two stale-node-state cases in "Recovering a stuck volume".

Assumed, not verified:

- Rancher won't act on the stale `v1.25.12` desired version. It didn't
  through 1.30–1.34, but the reason isn't confirmed from Rancher's code.
- The etcd restore procedure above. It has never been exercised here.

Handed off to a human: the pre-step etcd snapshot and off-host copy, saving
each node's binary, merging each step, and the host-side recoveries in 1.31.

## From the homelab backlog

The homelab project's backlog had hazards and requirements for this upgrade
written down before this plan. Here's where each one landed:

| Backlog item | Where it's handled |
|---|---|
| Upgrade controller and Plans "Ready but not advancing" | Investigated first, see Mechanism. They were idle at their own target version, not broken. |
| Reconcile open Renovate PRs before starting | Before every step, item 1. The InvenTree PR, the eight Flux PRs and the system-upgrade-controller PR were deliberately deferred, with a comment on each saying why. |
| Watch the upgrade as it runs, no fire-and-forget | Every step was watched to the end, and the post-merge checks were run. |
| No skipping minors; check API removals and chart support at each step | Four steps, one PR each. Per-step notes, and the removed-API check before each step. |
| Renovate has never tracked the Helm charts | Longhorn, rook-ceph and Rancher now pinned and tracked (#218). Other infrastructure charts still use ranges and aren't tracked (see "Open follow-ups"). |
| Rancher on a floating range, not to be pinned | Capped `<2.16.0` during the upgrade (#206), lifted after (#217), then pinned to its running version with Renovate PRs and no approval gate (#218). |
| Traefik v3 migration kept separate | No step through 1.34 forced it. |
| `infra-controllers` `wait: true` cascades a chart failure | Mechanism, and the HelmRelease check after each step. |
| Frozen HelmRelease conditions after a fix | Post-step checks: trust the helm-controller log and use `flux reconcile hr --force`. |
| Longhorn HelmRelease has no retry | #209 (`RetryOnFailure`, not remediation retries, because a remediation rolls back). |
| Lift the Longhorn cap once on 1.34 | #215: Longhorn 1.13.0, volumes healthy throughout. |
| Admin kubeconfig may go stale after master restarts | Expiry checked (2027-08, CA-signed). `kubectl` kept working through every step. |
| VM CPU type `x86-64-v2-AES` | Verified on all six VMs. |
| Master disks filled by log flooding | Free disk checked before each step. The journald cap itself is host config and wasn't checked from here. |
| Worker memory ballooning | Verified per VM. k3sworker2 is effectively static. k3sworker1 and k3sworker3 can still balloon. |
| k3sworker2 hard-pinned to its host | Nothing is drained, so its pods stayed on it through every step. |
| Transient `unexpected EOF` on Flux applies | "During and after every step": one `flux reconcile ks flux-system --with-source`. |
| Optional `--tls-san` for a tailnet address | Not part of this work. The Plans swap the binary and keep the server flags. Adding it is a change in the provisioning repo with its own restart. |
| Provisioning may pin the k3s version for new nodes | The `infrastructure` repo has no pin. k3s itself is installed by the separate k3s-ansible repo, which **hasn't been checked**. A node built from it now must not come up below 1.34. |

## Open follow-ups

- **Flux:** one regenerated install (1.33+ now satisfied) that supersedes the
  eight deferred Flux PRs.
- **system-upgrade-controller (#98):** bump the image, the controller
  manifests (still `?ref=v0.16.3`) and the CRD (still v0.15.2) together, and
  check its supported Kubernetes range.
- **InvenTree (#203):** after its preparatory work, with a Longhorn backup
  first.
- **Rancher Turtles:** clear the duplicate provider ConfigMaps behind
  `multiple ConfigMaps match selector`.
- **Renovate coverage for the other infrastructure charts** (Traefik,
  cert-manager, external-secrets and others), after reviewing their ranges
  per `AGENTS.md`.
- **Provisioning repo: the multipath blacklist.** Every k3s node needs the
  `/etc/multipath.conf` blacklist from "Recovering a stuck volume". Today it's
  set by hand only, and k3sworker3 didn't have it.
- **Provisioning repo (k3s-ansible):** check whether it pins a k3s version
  for new nodes, and consider moving the masters' custom taint from
  `node-role.kubernetes.io/master` to `node-role.kubernetes.io/control-plane`.
- **etcd snapshots are local only.** An S3 target for them would keep cluster
  state off the nodes it protects.
