# Database dumps

A daily logical backup of the two app databases in `tools`: `n8n` on `n8n-db`
and `inventree` on `inventory-db`. Manifests are in `apps/tools/db-backup/`.

Longhorn volume backups already cover both database volumes. They're
crash-consistent copies of a running Postgres, and they restore only onto the
same major version. The dump adds four things:

- **It fails loudly on corruption.** `pg_amcheck` checks every table and index
  first, and a corrupt page fails the job instead of being copied offsite.
- **It restores across Postgres majors**, so it is the dump a major upgrade needs.
- **It allows a partial restore**: one table, or one schema.
- **It is checked every day.** `pg_restore --list` reads every dump before it's
  kept.

## What runs when

`CronJob db-backup`, at 10:30 Australia/Brisbane. That's 30 minutes before
Longhorn's `daily-backups` RecurringJob (11:00 Brisbane time), so each daily
offsite backup carries that morning's dumps. One attempt (`backoffLimit: 0`), a 30-minute
deadline, and no overlap. For each database, as that database's owner user:

1. Wait up to 90 s for `pg_isready`, polling every 2 s, and log how long it
   took. A fresh Job pod's IP takes a moment to be admitted by `n8n-db`'s
   NetworkPolicy, so connecting at once can be refused.
2. `pg_amcheck --install-missing --heapallindexed`. The first run installs the
   `amcheck` extension in the database.
3. `pg_dump -Fc` to `<db>-<UTC yyyymmddThhmmZ>.dump.tmp`, then
   `pg_restore --list` on it. Only when both succeed is it renamed to `.dump`,
   with a `.sha256` written beside it.
4. Keep the newest 14 dumps (by name, which is by time) and delete older ones
   with their `.sha256`. `.tmp` files older than a day are deleted.

One database failing doesn't stop the other. After both, the job logs the `n8n`
database's size and its five largest relations, then `df` for `/backup`. That's
logging only. Over 80% used (`USAGE_LIMIT`), `backup-volume` is added to the
failures. The job exits non-zero if anything failed.

The script is `apps/tools/db-backup/scripts/backup.sh`. It's mounted from a
generated ConfigMap with Flux substitution disabled. The retention, naming,
wait, usage and data-directory logic in `scripts/lib.sh` has tests:
`node --test apps/tools/db-backup/`.

**Two n8n tables are dumped without their rows:** `triage.alert_target` (the
Home Assistant webhook URL) and `triage.redaction_patterns`. Both are secrets,
and the n8n pod reseeds both from its Secret on every start.

## Where the dumps live

PVC `db-backup`, 5Gi, `longhorn-diskencrypt-global`, one directory per database:
`/backup/n8n/` and `/backup/inventree/`. Like every other volume, it's in the
default Longhorn recurring-job group with no label, so the daily and weekly
volume backups take it offsite. No other offsite step exists.

The volume is detached outside the dump job. Longhorn backs it up anyway only
because `allowRecurringJobWhileVolumeDetached` is on, in
`infrastructure/controllers/longhorn.yaml`.

The pod has no service-account token. It runs as the image's `postgres` user
(UID/GID 70) with a read-only root filesystem, and it can reach DNS, the two
databases on 5432 and Home Assistant on 8123. `n8n-db`'s NetworkPolicy admits it
on 5432. `inventory-db` has no NetworkPolicy.

The image is the same `postgres` tag as the two database Deployments, so
Renovate bumps all three in one PR. `pg_dump` must not be older than the server.

## Secrets

`ExternalSecret db-backup-secrets` reuses existing 1Password fields:
`n8n`/`db-password`, `inventory`/`db-password` and `n8n`/`ha-heartbeat-url`.
The script never prints them and never writes them to the volume.

## Home Assistant ping

At the end of every run, success or failure, the job POSTs one JSON object to
the same webhook as the n8n heartbeat, with a 10 s timeout:

```json
{"source": "pg-dump", "ok": true, "checked": "<ISO-8601 UTC>", "failed": []}
```

`failed` lists the databases that failed, and `backup-volume` when the volume is
over 80% used. A failed ping logs one line, without
the URL, and doesn't change the exit code. The receiver and its alerts live in
Home Assistant, outside this repo. A missing ping is the signal that the job
didn't run at all.

## Restore test

`CronJob db-restore-test` is suspended and runs only by hand. It mounts
`db-backup` read-only and starts a throwaway Postgres in an `emptyDir`,
listening on a Unix socket only. Its NetworkPolicy denies all traffic. For each
database it verifies the newest dump against its `.sha256` and restores it with
`pg_restore --no-owner --no-privileges --exit-on-error`. Roles aren't in a
dump, so grants are skipped. Then it checks row counts: at least 5 in
`workflow_entity` and 1 in `triage.runs` for n8n, and at least 1 in
`stock_stockitem` for InvenTree. It prints the dump names and the counts only.

```bash
kubectl -n tools create job --from=cronjob/db-restore-test restore-test-$(date +%Y%m%d)
kubectl -n tools logs -f job/restore-test-$(date +%Y%m%d)
kubectl -n tools delete job restore-test-$(date +%Y%m%d)
```

`db-backup` is RWO, so the test pod schedules only on the node that has the
volume attached, or anywhere once no pod has it. Don't run it while the daily
job is running.

To take a dump by hand, before a Postgres major upgrade for example:

```bash
kubectl -n tools create job --from=cronjob/db-backup db-backup-manual-$(date +%Y%m%d)
```

## Volume restore test

The restore test above proves the dumps. This one proves the other path: a
Longhorn offsite backup of the `n8n-db` volume, restored to a new volume, holds
a database that starts and reads cleanly.

`CronJob db-volume-restore-test` is suspended and runs only by hand. It mounts
PVC `n8n-db-restore` read-only, finds the data directory (`pgdata/`, as in
`n8n-db`'s `PGDATA`, or the volume root) and copies it to a 2Gi `emptyDir`.
The backup is crash-consistent, so the throwaway server runs crash recovery on
the copy. It listens on a Unix socket only, and its NetworkPolicy denies all
traffic. If the copied `pg_hba.conf` doesn't start with a local trust rule, the
copy's is replaced; the mount is never written. As the `n8n` role it checks at
least 5 rows in `workflow_entity` and 1 in `triage.runs`, prints
`max(finished)` from `triage.runs` (roughly the backup's point in time), and
runs `pg_amcheck --heapallindexed`. It needs no secrets.

**`n8n-db-restore` is deliberately outside Git.** It exists only for the length
of a drill. `prune` only removes objects Flux applied, so Flux leaves it alone.

1. In the Longhorn UI, under Backup, restore the `n8n-db` backup to a new
   volume named `n8n-db-restore`, with **Encrypted** ticked.
2. On that volume, Create PV/PVC: namespace `tools`, PVC `n8n-db-restore`,
   StorageClass `longhorn-diskencrypt-global`, and the encryption secret
   `longhorn-system`/`longhorn-disk-encrypt`. Wait for the PVC to be Bound.
3. Run the job:

   ```bash
   kubectl -n tools create job --from=cronjob/db-volume-restore-test vrt-$(date +%Y%m%d)
   kubectl -n tools logs -f job/vrt-$(date +%Y%m%d)
   ```

   Empty logs mean the pod is still attaching the volume; re-run `logs`. It
   ends with `volume restore test ok`.
4. Clean up the same day:

   ```bash
   kubectl -n tools delete job vrt-$(date +%Y%m%d)
   kubectl -n tools delete pvc n8n-db-restore
   kubectl delete pv n8n-db-restore
   ```

   Then delete the `n8n-db-restore` volume in the Longhorn UI. Left in place,
   it's in the default recurring-job group and gets backed up offsite like any
   other volume.

## Restoring a database for real

This overwrites live data. Run the restore test on the dump first.

1. Stop the app's writers. Scale the app Deployment (not the database) to 0
   through a Git change, or suspend the `apps` Kustomization and scale it.
2. Start a shell pod with the `app: db-backup` label, so the NetworkPolicies
   admit it, and the volume mounted read-only:

   ```bash
   kubectl -n tools run db-restore-shell --rm -it --restart=Never \
     --image=postgres:17.12-alpine --labels=app=db-backup --overrides='
   {"spec":{"automountServiceAccountToken":false,
     "securityContext":{"runAsUser":70,"runAsGroup":70,"runAsNonRoot":true},
     "containers":[{"name":"db-restore-shell","image":"postgres:17.12-alpine",
       "stdin":true,"tty":true,"command":["/bin/sh"],
       "envFrom":[{"secretRef":{"name":"db-backup-secrets"}}],
       "volumeMounts":[{"name":"backup","mountPath":"/backup","readOnly":true}]}],
     "volumes":[{"name":"backup","persistentVolumeClaim":{"claimName":"db-backup","readOnly":true}}]}}'
   ```

   Use the image tag the database runs. The pod isn't in Git, and `--rm`
   removes it when the shell exits.
3. Inside it, pick a dump (`ls /backup/n8n`), check it, and restore over the
   live database:

   ```sh
   cd /backup/n8n && sha256sum -c n8n-<stamp>.dump.sha256
   PGPASSWORD="$N8N_DB_PASSWORD" pg_restore -h n8n-db -U n8n -d n8n \
     --clean --if-exists --exit-on-error n8n-<stamp>.dump
   ```

   For InvenTree: `/backup/inventree`, host `inventory-db`, user and database
   `inventree`, `$INVENTORY_DB_PASSWORD`. For a partial restore, add
   `-t <table>`, or write `pg_restore --list` to a file, edit it, and pass it
   with `-L`.
4. Scale the app back up. For n8n, the pod start reseeds `triage.alert_target`
   and `triage.redaction_patterns`, which the dump carries empty. For n8n, the
   encryption key in 1Password must be the one in use when the dump was taken.

To restore into a new Postgres major, restore into the new, empty server
instead of with `--clean`.

## Rollback

`git revert` of the PR that added this removes the CronJobs and prunes the
`db-backup` PVC. The backing PV is reclaimed with `Delete` (see `AGENTS.md`), so
the dumps on it go with it, with no Released volume left. **Take a Longhorn
backup of the `db-backup` volume before reverting.** Older offsite backups of it
remain under Longhorn's retention either way.

## Not declarative

- The Home Assistant receiver for `source: pg-dump`, and its alerts.
- The `amcheck` extension, which the first run installs in each database.
- PVC and PV `n8n-db-restore` and their Longhorn volume, made by hand for
  each volume restore test and deleted after it.
