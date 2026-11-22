'use strict';
// Run with: node --test apps/tools/n8n/triage/
// R10, the post-merge watch: planWatch, evaluateWatch, fixForward and
// planWatchPublish in rules.js, and the config they read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rules = require('./rules.js');

const HERE = __dirname;
const REPO = path.join(HERE, '..', '..', '..', '..');
const CONFIG_TEXT = fs.readFileSync(path.join(HERE, 'config.yaml'), 'utf8');
const CONFIG = rules.loadConfig(CONFIG_TEXT);
// The live watch_write_mode line, and the config with it set explicitly.
const WATCH_MODE_LINE = CONFIG_TEXT.match(/^watch_write_mode: .*$/m)[0];
const withWatchMode = (mode) => CONFIG_TEXT.replace(WATCH_MODE_LINE, `watch_write_mode: "${mode}"`);
const MERGE = 'a'.repeat(40);
const LATER = 'b'.repeat(40);
const MERGED_AT = '2026-11-21T10:00:00Z';
const at = (min) => new Date(Date.parse(MERGED_AT) + min * 60000).toISOString();
const APP = `${CONFIG.app_slug}[bot]`;
const IDS = { app_login: APP, bot_login: 'the-bot', owner_login: 'the-owner' };

// A unified diff for a one-line change at new line `no` of `content`.
function patchAt(content, no, oldLine) {
  const lines = content.split('\n');
  const from = Math.max(1, no - 3);
  const to = Math.min(lines.length, no + 3);
  const out = [`@@ -${from},${to - from + 1} +${from},${to - from + 1} @@`];
  for (let i = from; i <= to; i++) {
    if (i === no) out.push(`-${oldLine}`, `+${lines[i - 1]}`);
    else out.push(` ${lines[i - 1]}`);
  }
  return out.join('\n');
}
const lineOf = (content, re) => content.split('\n').findIndex((l) => re.test(l)) + 1;

const HR = `---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: reflector
  namespace: flux-system
spec:
  interval: 30m
  chart:
    spec:
      chart: reflector
      version: 10.0.81
      sourceRef:
        kind: HelmRepository
        name: emberstack
  values:
    image:
      tag: x
`;
const DEPLOY = `---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: inventree-data
  namespace: tools
spec:
  accessModes: [ReadWriteOnce]
---
apiVersion: apps/v1
kind: Deployment
metadata:
  namespace: tools
  name: inventree
spec:
  template:
    spec:
      initContainers:
      - name: migrate
        image: inventree/inventree:1.7.3
      containers:
      - name: server
        image: inventree/inventree:1.7.3
      - name: proxy
        image: caddy:2.10.2-alpine
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: backup
  namespace: tools
spec:
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: dump
            image: postgres:17.12-alpine
`;
const hrFile = () => ({
  filename: 'infrastructure/controllers/reflector.yaml', status: 'modified', content: HR,
  patch: patchAt(HR, lineOf(HR, /version: 10\.0\.81/), '      version: 10.0.78'),
});
const ids = (plan) => plan.targets.map((t) => t.id);

// ---------------------------------------------------------------- config

test('config: the watch keys load and are validated', () => {
  assert.ok(['off', 'labels'].includes(CONFIG.watch_write_mode));
  for (const mode of ['off', 'labels']) assert.equal(rules.loadConfig(withWatchMode(mode)).watch_write_mode, mode);
  assert.equal(CONFIG.write_mode, 'labels');
  assert.equal(CONFIG.watch_timeout_min, 30);
  assert.equal(CONFIG.watch_stale_min, 30);
  assert.deepEqual(CONFIG.fix_forward_packages, ['inventree/inventree']);
  assert.equal(rules.watchStaleFromConfigLine(CONFIG_TEXT), CONFIG.watch_stale_min, 'the heartbeat SQL reads the same value');
  const bad = (from, to, re) => assert.throws(() => rules.loadConfig(CONFIG_TEXT.replace(from, to)), re, `${from} -> ${to}`);
  bad(WATCH_MODE_LINE, 'watch_write_mode: "all"', /watch_write_mode/);
  bad(WATCH_MODE_LINE, '', /watch_write_mode/);
  bad('watch_timeout_min: 30', 'watch_timeout_min: 0', /watch_timeout_min/);
  bad('watch_stale_min: 30', 'watch_stale_min: "30"', /watch_stale_min/);
  bad('  - path: apps/\n', '  - path: ./apps\n', /path must be/);
  bad('    name: apps\n', '    name: Apps\n', /Kustomization name/);
  bad('    target_namespace: tools\n', '    target_namespace: Tools\n', /target_namespace/);
  bad('  - path: global/\n', '  - path: apps/\n', /repeats path apps\//);
  bad('fix_forward_packages: [inventree/inventree]', 'fix_forward_packages: [Inventree]', /invalid package/);
  bad('fix_forward_packages:', 'fix_forward_pkgs:', /unknown key/);
});

// Every Flux Kustomization defined in the repo, with its path and targetNamespace.
function fluxKustomizations() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ya?ml$/.test(e.name)) {
        for (const doc of fs.readFileSync(p, 'utf8').split(/^---\s*$/m)) {
          if (!/^apiVersion: kustomize\.toolkit\.fluxcd\.io\//m.test(doc) || !/^kind: Kustomization\s*$/m.test(doc)) continue;
          const name = (doc.match(/^ {2}name: (?:&\S+ )?(\S+)/m) || [])[1];
          const kpath = (doc.match(/^ {2}path: \.\/(\S+)/m) || [])[1];
          const ns = (doc.match(/^ {2}targetNamespace: (\S+)/m) || [])[1] || null;
          out.push({ name, path: `${kpath.replace(/\/$/, '')}/`, target_namespace: ns, file: path.relative(REPO, p) });
        }
      }
    }
  };
  for (const top of ['clusters', 'orchestration', 'apps', 'infrastructure']) walk(path.join(REPO, top));
  return out;
}

test('config: watch_kustomizations covers every Flux Kustomization in the repo, and names only those', () => {
  const live = fluxKustomizations();
  assert.ok(live.length >= 14, `found ${live.length}`);
  assert.ok(live.some((k) => k.file.startsWith('clusters/')));
  const byPath = Object.fromEntries(CONFIG.watch_kustomizations.map((k) => [k.path, k]));
  for (const k of live) {
    const m = byPath[k.path];
    assert.ok(m, `${k.name} (${k.file}) applies ${k.path}, which watch_kustomizations doesn't map`);
    assert.equal(m.name, k.name, `${k.path} maps to ${m.name}, but ${k.file} names ${k.name}`);
    assert.equal(m.target_namespace, k.target_namespace, `${k.name}: target_namespace`);
  }
  const names = new Set(live.map((k) => k.name));
  for (const m of CONFIG.watch_kustomizations) assert.ok(names.has(m.name), `watch_kustomizations names ${m.name}, which no Flux Kustomization defines`);
  // The one mapped path that no Kustomization's own path is: cluster-config renders it.
  const extra = CONFIG.watch_kustomizations.filter((m) => !live.some((k) => k.path === m.path)).map((m) => `${m.path}=${m.name}`);
  assert.deepEqual(extra, ['global/=cluster-config']);
  assert.match(fs.readFileSync(path.join(REPO, 'cluster-config/kustomization.yaml'), 'utf8'), /\.\.\/global\/vars\//);
});

test('config: every fix_forward package is an image in the repo', () => {
  const found = fs.readFileSync(path.join(REPO, 'apps/tools/inventory/deployment.yaml'), 'utf8');
  for (const p of CONFIG.fix_forward_packages) assert.match(found, new RegExp(`image: ${p.replace('/', '\\/')}:`), p);
});

// ---------------------------------------------------------------- planWatch

test('planWatch: a chart bump gives its Kustomization and the HelmRelease at the new version', () => {
  const plan = rules.planWatch([hrFile()], CONFIG);
  assert.deepEqual(plan.targets, [
    { id: 'kustomization infra-controllers', type: 'kustomization', name: 'infra-controllers' },
    { id: 'helmrelease flux-system/reflector', type: 'helmrelease', ns: 'flux-system', name: 'reflector', chart: 'reflector', version: '10.0.81' },
  ]);
  assert.deepEqual(plan.notes, []);
});

test('planWatch: an image bump gives the Deployment with the new image; a CronJob gets only a note', () => {
  // The server container's image line (the initContainer's comes first).
  const server = lineOf(DEPLOY, /^ {8}image: inventree/) + 3;
  assert.equal(DEPLOY.split('\n')[server - 1], '        image: inventree/inventree:1.7.3');
  const p2 = rules.planWatch([{ filename: 'apps/tools/inventory/deployment.yaml', status: 'modified', content: DEPLOY, patch: patchAt(DEPLOY, server, '        image: inventree/inventree:1.7.2') }], CONFIG);
  assert.deepEqual(p2.targets, [
    { id: 'kustomization apps', type: 'kustomization', name: 'apps' },
    { id: 'deployment tools/inventree', type: 'deployment', ns: 'tools', name: 'inventree', images: ['inventree/inventree:1.7.3'] },
  ]);
  const cron = lineOf(DEPLOY, /image: postgres/);
  const p3 = rules.planWatch([{ filename: 'apps/tools/inventory/deployment.yaml', status: 'modified', content: DEPLOY, patch: patchAt(DEPLOY, cron, '            image: postgres:17.11-alpine') }], CONFIG);
  assert.deepEqual(ids(p3), ['kustomization apps']);
  assert.deepEqual(p3.notes, ['CronJob tools/backup: image change in a CronJob; kustomization check only']);
});

test('planWatch: a change outside every object, or a non-image line, adds no workload', () => {
  const replicas = DEPLOY.replace('spec:\n  template:', 'spec:\n  replicas: 1\n  template:');
  const no = lineOf(replicas, /replicas: 1/);
  const plan = rules.planWatch([{ filename: 'apps/tools/inventory/deployment.yaml', status: 'modified', content: replicas, patch: patchAt(replicas, no, '  replicas: 2') }], CONFIG);
  assert.deepEqual(ids(plan), ['kustomization apps']);
});

test('planWatch: the longest prefix wins, targetNamespace overrides, and renames map both paths', () => {
  const sts = `apiVersion: apps/v1\nkind: StatefulSet\nmetadata:\n  name: suc\nspec:\n  template:\n    spec:\n      containers:\n      - name: c\n        image: rancher/system-upgrade-controller:v0.16.0\n`;
  const plan = rules.planWatch([{
    filename: 'apps/tools/system-upgrade-controller/app/sts.yaml', previous_filename: 'apps/tools/old/sts.yaml', status: 'renamed', content: sts,
    patch: patchAt(sts, 10, '        image: rancher/system-upgrade-controller:v0.15.0'),
  }], CONFIG);
  assert.deepEqual(plan.targets, [
    { id: 'kustomization apps', type: 'kustomization', name: 'apps' },
    { id: 'kustomization system-upgrade-controller', type: 'kustomization', name: 'system-upgrade-controller' },
    { id: 'statefulset tools/suc', type: 'statefulset', ns: 'tools', name: 'suc', images: ['rancher/system-upgrade-controller:v0.16.0'] },
  ]);
});

test('planWatch: no covered path gives no targets; a removed file gives only its Kustomization', () => {
  assert.deepEqual(rules.planWatch([{ filename: 'docs/n8n.md', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }, { filename: 'renovate.json', status: 'modified', patch: '' }], CONFIG), { targets: [], notes: [] });
  assert.deepEqual(rules.planWatch([], CONFIG), { targets: [], notes: [] });
  const gone = rules.planWatch([{ filename: 'apps/tools/inventory/deployment.yaml', status: 'removed', patch: DEPLOY.split('\n').map((l) => `-${l}`).join('\n'), content: null }], CONFIG);
  assert.deepEqual(ids(gone), ['kustomization apps']);
});

test('planWatch: unread content or an unresolved name falls back to the Kustomization check, with a note', () => {
  const unread = rules.planWatch([Object.assign(hrFile(), { content: null })], CONFIG);
  assert.deepEqual(ids(unread), ['kustomization infra-controllers']);
  assert.match(unread.notes[0], /not read at the merge commit/);
  const subst = HR.replace('name: reflector\n  namespace', 'name: ${APP}\n  namespace');
  const p = rules.planWatch([Object.assign(hrFile(), { content: subst, patch: patchAt(subst, lineOf(subst, /version: 10/), '      version: 1') })], CONFIG);
  assert.deepEqual(ids(p), ['kustomization infra-controllers']);
  assert.match(p.notes[0], /not resolved/);
  // No patch (a large diff): every object in the file is checked.
  const big = rules.planWatch([Object.assign(hrFile(), { patch: undefined })], CONFIG);
  assert.deepEqual(ids(big), ['kustomization infra-controllers', 'helmrelease flux-system/reflector']);
  assert.match(big.notes[0], /no patch/);
});

test('planWatch: a YAML anchor in the name is read as the name, and paging is not its concern', () => {
  const docs = rules.manifestDocs('apiVersion: v1\nkind: Plan\nmetadata:\n  name: &n server\nspec:\n  # renovate: x\n  version: v1.34.12+k3s1 # pinned\n');
  assert.equal(docs[0].name, 'server');
  assert.equal(docs[0].kind, 'Plan');
  assert.equal(rules.manifestDocs('kind: A\n---\nkind: B\n').map((d) => [d.kind, d.start, d.end]).join(';'), 'A,1,1;B,3,4');
});

test('watchReads and clusterPath: only allowlisted paths, DNS labels only', () => {
  const plan = rules.planWatch([hrFile()], CONFIG);
  assert.deepEqual(rules.watchReads(plan.targets), [
    { id: 'kustomization infra-controllers', path: '/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/flux-system/kustomizations/infra-controllers' },
    { id: 'helmrelease flux-system/reflector', path: '/apis/helm.toolkit.fluxcd.io/v2/namespaces/flux-system/helmreleases/reflector' },
  ]);
  assert.equal(rules.clusterPath('deployment', 'tools', 'n8n'), '/apis/apps/v1/namespaces/tools/deployments/n8n');
  assert.equal(rules.clusterPath('statefulset', 'tools', 'x'), '/apis/apps/v1/namespaces/tools/statefulsets/x');
  for (const [t, ns, n] of [['secret', 'tools', 'x'], ['deployment', 'tools', '../secrets'], ['deployment', 'Tools', 'x'], ['deployment', '', 'x'], ['helmrelease', 'a/b', 'x'], ['deployment', 'tools', 'a'.repeat(64)]]) {
    assert.equal(rules.clusterPath(t, ns, n), null, `${t} ${ns} ${n}`);
  }
});

// ---------------------------------------------------------------- evaluateWatch

const KS = { id: 'kustomization apps', type: 'kustomization', name: 'apps' };
const HRT = { id: 'helmrelease flux-system/reflector', type: 'helmrelease', ns: 'flux-system', name: 'reflector', version: '10.0.81' };
const DEP = { id: 'deployment tools/inventree', type: 'deployment', ns: 'tools', name: 'inventree', images: ['inventree/inventree:1.7.3'] };
const ks = (ready, reason, applied, attempted) => ({
  statusCode: 200,
  body: { status: { lastAppliedRevision: `main@sha1:${applied}`, lastAttemptedRevision: `main@sha1:${attempted || applied}`, conditions: [{ type: 'Ready', status: ready, reason }] } },
});
const hr = (o) => ({
  statusCode: 200,
  body: {
    metadata: { generation: o.gen || 5 },
    spec: { chart: { spec: { version: o.live || '10.0.81' } } },
    status: { observedGeneration: o.obs || 5, history: [{ chartVersion: o.hist || '10.0.81' }], conditions: [{ type: 'Ready', status: o.ready || 'True', reason: o.reason || 'UpgradeSucceeded' }].concat(o.stalled ? [{ type: 'Stalled', status: 'True', reason: o.stalled }] : []) },
  },
});
const dep = (o) => ({
  statusCode: 200,
  body: {
    metadata: { generation: 7 },
    spec: { replicas: o.want === undefined ? 1 : o.want, template: { spec: { containers: [{ image: o.image || 'inventree/inventree:1.7.3' }] } } },
    status: Object.assign({ observedGeneration: o.obs || 7, replicas: 1, updatedReplicas: 1, readyReplicas: 1 }, o.status || {}, o.progress ? { conditions: [{ type: 'Progressing', status: 'False', reason: o.progress }] } : {}),
  },
});
const ev = (targets, reads, min, history, compare) => rules.evaluateWatch(targets, { merge_sha: MERGE, reads, compare: compare || {} }, at(min), MERGED_AT, history || {}, { timeout_min: 30 });

test('evaluateWatch: ok when every target passes', () => {
  const r = ev([KS, HRT, DEP], { [KS.id]: ks('True', 'ReconciliationSucceeded', MERGE), [HRT.id]: hr({}), [DEP.id]: dep({}) }, 6);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.detail.map((d) => d.state), ['ok', 'ok', 'ok']);
  assert.deepEqual(r.fail_streak, {});
  // No targets at all: ok at once.
  assert.equal(ev([], {}, 0).status, 'ok');
});

test('evaluateWatch: the Kustomization must have applied the merge SHA or a descendant (compare API)', () => {
  const reads = { [KS.id]: ks('True', 'ReconciliationSucceeded', LATER) };
  assert.equal(ev([KS], reads, 5).status, 'pending', 'not compared yet');
  assert.equal(ev([KS], reads, 5).detail[0].cond, 'revision not compared yet');
  assert.equal(ev([KS], reads, 5, {}, { [LATER]: 'ahead' }).status, 'ok');
  assert.equal(ev([KS], reads, 5, {}, { [LATER]: 'identical' }).status, 'ok');
  assert.equal(ev([KS], reads, 5, {}, { [LATER]: 'behind' }).status, 'pending');
  assert.equal(ev([KS], reads, 5, {}, { [LATER]: 'diverged' }).status, 'pending');
  assert.equal(rules.revisionSha(`main@sha1:${MERGE}`), MERGE);
  assert.equal(rules.revisionSha('main@sha1:abc'), null);
});

test('evaluateWatch: failed only on the same failing condition two checks in a row', () => {
  const bad = { [KS.id]: ks('False', 'ReconciliationFailed', LATER, MERGE) };
  const first = ev([KS], bad, 5);
  assert.equal(first.status, 'pending');
  assert.deepEqual(first.fail_streak, { [KS.id]: { cond: 'Ready=False (ReconciliationFailed)', count: 1 } });
  const second = ev([KS], bad, 10, first.fail_streak);
  assert.equal(second.status, 'failed');
  assert.equal(second.fail_streak[KS.id].count, 2);
  // A different condition starts again.
  const other = ev([KS], { [KS.id]: ks('False', 'HealthCheckFailed', LATER, MERGE) }, 10, first.fail_streak);
  assert.equal(other.status, 'pending');
  assert.equal(other.fail_streak[KS.id].count, 1);
  // A pass in between clears the streak.
  assert.deepEqual(ev([KS, DEP], { [KS.id]: ks('True', 'x', MERGE), [DEP.id]: dep({ status: { readyReplicas: 0 } }) }, 10, first.fail_streak).fail_streak, {});
});

test('evaluateWatch: Progressing and DependencyNotReady, or an attempt without the merge, are not failures', () => {
  for (const reason of ['Progressing', 'DependencyNotReady']) {
    const r = ev([KS], { [KS.id]: ks('False', reason, LATER, MERGE) }, 10, { [KS.id]: { cond: `Ready=False (${reason})`, count: 5 } });
    assert.equal(r.status, 'pending', reason);
  }
  const old = ev([KS], { [KS.id]: ks('False', 'ReconciliationFailed', LATER, LATER) }, 10, {}, { [LATER]: 'behind' });
  assert.equal(old.status, 'pending');
  assert.equal(old.detail[0].cond, 'merge not applied yet');
});

test('evaluateWatch: HelmRelease upgrade failures for the new version fail; the old version still running waits', () => {
  for (const reason of ['UpgradeFailed', 'InstallFailed', 'RollbackSucceeded']) {
    const reads = { [HRT.id]: hr({ ready: 'False', reason, hist: '10.0.78' }) };
    const r1 = ev([HRT], reads, 5);
    assert.equal(r1.status, 'pending');
    assert.equal(ev([HRT], reads, 10, r1.fail_streak).status, 'failed', reason);
  }
  const stalled = { [HRT.id]: hr({ ready: 'False', reason: 'Whatever', stalled: 'RetriesExceeded' }) };
  assert.equal(ev([HRT], stalled, 10, ev([HRT], stalled, 5).fail_streak).status, 'failed');
  // Not yet applied (old spec), or an unrelated reason: pending, then timeout.
  assert.equal(ev([HRT], { [HRT.id]: hr({ live: '10.0.78', hist: '10.0.78', ready: 'False', reason: 'UpgradeFailed' }) }, 10, { [HRT.id]: { cond: 'x', count: 9 } }).status, 'pending');
  assert.equal(ev([HRT], { [HRT.id]: hr({ ready: 'Unknown', reason: 'Progressing', hist: '10.0.78' }) }, 10).detail[0].cond, 'chart 10.0.81 not installed yet');
  assert.equal(ev([HRT], { [HRT.id]: hr({ gen: 6 }) }, 10).status, 'pending', 'observedGeneration must catch up');
});

test('evaluateWatch: workloads need the new generation observed, every replica updated and ready, and the image live', () => {
  const ok = (o) => ev([DEP], { [DEP.id]: dep(o) }, 10).status;
  assert.equal(ok({}), 'ok');
  assert.equal(ok({ obs: 6 }), 'pending');
  assert.equal(ok({ image: 'inventree/inventree:1.7.2' }), 'pending');
  assert.equal(ok({ status: { updatedReplicas: 0 } }), 'pending');
  assert.equal(ok({ status: { replicas: 2 } }), 'pending', 'an old pod still running');
  // Recreate mid-rollout: everything 0 is not done.
  assert.equal(ok({ status: { replicas: 0, updatedReplicas: 0, readyReplicas: 0 } }), 'pending');
  assert.equal(ok({ want: 0, status: { replicas: 0, updatedReplicas: 0, readyReplicas: 0 } }), 'ok', 'scaled to zero');
  const stuck = { [DEP.id]: dep({ status: { readyReplicas: 0 }, progress: 'ProgressDeadlineExceeded' }) };
  assert.equal(ev([DEP], stuck, 10, ev([DEP], stuck, 5).fail_streak).status, 'failed');
});

test('evaluateWatch: timeout 30 minutes after merged_at; ok still wins at the end', () => {
  const slow = { [DEP.id]: dep({ status: { readyReplicas: 0 } }) };
  assert.equal(ev([DEP], slow, 29).status, 'pending');
  assert.equal(ev([DEP], slow, 30).status, 'timeout');
  assert.equal(ev([DEP], { [DEP.id]: dep({}) }, 45).status, 'ok');
  // An unreadable target never fails on its own; it times out.
  assert.equal(ev([DEP], { [DEP.id]: { statusCode: 500 } }, 10).status, 'pending');
  assert.equal(ev([DEP], {}, 31).status, 'timeout');
  const gone = { [DEP.id]: { statusCode: 404 } };
  assert.equal(ev([DEP], gone, 10, ev([DEP], gone, 5).fail_streak).status, 'failed');
});

test('evaluateWatch: reasons from the cluster are reduced to one word', () => {
  const r = ev([KS], { [KS.id]: ks('False', 'Bad <script>', LATER, MERGE) }, 5);
  assert.equal(r.detail[0].cond, 'Ready=False (Unknown)');
});

test('evaluateWatch: a failing Kustomization records the revision it failed at', () => {
  const bad = { [KS.id]: ks('False', 'ReconciliationFailed', LATER, MERGE) };
  assert.deepEqual(ev([KS], bad, 5).detail, [{ id: KS.id, state: 'fail', cond: 'Ready=False (ReconciliationFailed)', revision: MERGE }]);
  assert.equal(ev([KS], { [KS.id]: ks('True', 'x', MERGE) }, 5).detail[0].revision, undefined);
  assert.deepEqual(rules.failureKeys(ev([KS], bad, 5).detail), [`kustomization apps@${MERGE}`]);
  assert.deepEqual(rules.failureKeys([{ id: 'helmrelease a/b', state: 'fail', cond: 'x', revision: MERGE }, { id: 'kustomization apps', state: 'fail', cond: 'not found' }]), []);
});

// ---------------------------------------------------------------- groupFailures

const ksFail = (rev) => ({ id: 'kustomization apps', state: 'fail', cond: 'Ready=False (HealthCheckFailed)', revision: rev });
const hrFail = { id: 'helmrelease flux-system/reflector', state: 'fail', cond: 'Ready=False (UpgradeFailed)' };
const chk = (id, status, detail) => ({ watch_id: id, status, fail_streak: {}, detail });
const groups = (list) => rules.groupFailures(list).map((c) => [c.watch_id, c.status, c.failure_group]);

test('groupFailures: two watches failing on one Kustomization revision finish together, in one group', () => {
  const key = `kustomization apps@${LATER}`;
  assert.deepEqual(groups([chk(1, 'failed', [ksFail(LATER)]), chk(2, 'failed', [ksFail(LATER)])]), [[1, 'failed', key], [2, 'failed', key]]);
  // One reached two checks in a row, the other one so far: it finishes with it.
  assert.deepEqual(groups([chk(1, 'failed', [ksFail(LATER)]), chk(2, 'pending', [ksFail(LATER)])]), [[1, 'failed', key], [2, 'failed', key]]);
  assert.deepEqual(groups([chk(1, 'timeout', [ksFail(LATER)]), chk(2, 'pending', [ksFail(LATER)])]), [[1, 'timeout', key], [2, 'timeout', key]]);
  // Nobody finished: nothing moves.
  assert.deepEqual(groups([chk(1, 'pending', [ksFail(LATER)]), chk(2, 'pending', [ksFail(LATER)])]), [[1, 'pending', null], [2, 'pending', null]]);
});

test('groupFailures: a different revision or Kustomization, or the watch\'s own target, is not shared', () => {
  assert.deepEqual(groups([chk(1, 'failed', [ksFail(LATER)]), chk(2, 'pending', [ksFail(MERGE)])]), [[1, 'failed', `kustomization apps@${LATER}`], [2, 'pending', null]]);
  const other = { id: 'kustomization grafana', state: 'fail', cond: 'x', revision: LATER };
  assert.deepEqual(groups([chk(1, 'failed', [ksFail(LATER)]), chk(2, 'pending', [other])]).map((g) => g[1]), ['failed', 'pending']);
  // Its own HelmRelease, and the other watch fine: attributed, no group.
  assert.deepEqual(groups([chk(1, 'failed', [{ id: 'kustomization apps', state: 'ok', cond: 'applied' }, hrFail]), chk(2, 'ok', [{ id: 'kustomization apps', state: 'ok', cond: 'applied' }])]), [[1, 'failed', null], [2, 'ok', null]]);
});

test('watchAction and watchAlert: one alert per group, from its lowest id, listing every PR', () => {
  const group = [{ id: 7, pr: 300, merge_sha: MERGE, fix_forward: false }, { id: 8, pr: 299, merge_sha: LATER, fix_forward: true }];
  const lead = { id: 7, pr: 300, status: 'failed', fix_forward: false, group };
  assert.equal(rules.watchAction(lead), 'investigate');
  assert.deepEqual(rules.watchAlert(lead, 'T'), { source: 'pr-watch', pr: 299, prs: [299, 300], status: 'failed', action: 'investigate', fix_forward: true, checked: 'T' });
  assert.equal(rules.watchAlert(Object.assign({}, lead, { id: 8, pr: 299 }), 'T'), null, 'not the lowest id');
  assert.deepEqual(rules.watchAlert({ id: 3, pr: 12, status: 'timeout', fix_forward: false, group: null }, 'T'), { source: 'pr-watch', pr: 12, prs: [12], status: 'timeout', action: 'revert', fix_forward: false, checked: 'T' });
  assert.equal(rules.watchAlert({ id: 3, pr: 12, status: 'failed', fix_forward: true, group: [{ id: 3, pr: 12 }] }, 'T').action, 'fix-forward');
  assert.equal(rules.watchAlert({ id: 3, pr: 12, status: 'ok' }, 'T'), null, 'never on ok');
  assert.deepEqual(rules.WATCH_ACTIONS, ['revert', 'fix-forward', 'investigate']);
});

// ---------------------------------------------------------------- fixForward

const pr = (body, login) => ({ body, user: { login: login || 'someone-else' } });
const marker = 'Some text.\n\nrollback: fix-forward\n';

test('fixForward: the marker counts from the App, the bot or the repo owner', () => {
  assert.deepEqual(rules.fixForward(pr(marker, 'the-owner'), [], [], [], IDS, CONFIG), { fix_forward: true, source: 'marker in the PR description' });
  assert.deepEqual(rules.fixForward(pr(marker, 'The-Bot'), [], [], [], IDS, CONFIG).fix_forward, true, 'logins compare case-insensitively');
  assert.deepEqual(rules.fixForward(pr(''), [{ body: 'ROLLBACK:  Fix-Forward  ', user: { login: APP } }], [], [], IDS, CONFIG), { fix_forward: true, source: 'marker in a review' });
  assert.deepEqual(rules.fixForward(pr(''), [], [{ body: 'rollback: fix-forward\r', user: { login: 'the-bot' } }], [], IDS, CONFIG), { fix_forward: true, source: 'marker in a comment' });
});

test('fixForward: the marker from anyone else, in code, quoted or inline does not count', () => {
  const no = (p, reviews, comments, ids) => assert.equal(rules.fixForward(p, reviews || [], comments || [], [], ids || IDS, CONFIG).fix_forward, false);
  no(pr(marker, 'someone-else'));
  no(pr(''), [{ body: marker, user: { login: 'reviewer' } }]);
  no(pr(''), [], [{ body: marker, user: { login: 'commenter' } }]);
  no(pr('```\nrollback: fix-forward\n```', 'the-owner'));
  no(pr('~~~yaml\nrollback: fix-forward\n~~~', 'the-owner'));
  no(pr('> rollback: fix-forward', 'the-owner'));
  no(pr('    rollback: fix-forward', 'the-owner'));
  no(pr('Set `rollback: fix-forward` to opt in.', 'the-owner'));
  no(pr('rollback: fix-forward please', 'the-owner'));
  // An unknown bot login (GET /user failed) admits nobody extra.
  no(pr(marker, 'the-bot'), [], [], { app_login: APP, bot_login: null, owner_login: 'the-owner' });
  no(pr(marker, ''), [], [], { app_login: '', bot_login: null, owner_login: null });
  no(pr(marker), [], [], {});
  // After a closed fence, it counts again.
  assert.equal(rules.fixForward(pr('```\nx\n```\nrollback: fix-forward', 'the-owner'), [], [], [], IDS, CONFIG).fix_forward, true);
});

test('fixForward: the one-way classes', () => {
  const ff = (files) => rules.fixForward(pr(''), [], [], files, IDS, CONFIG);
  const server = lineOf(DEPLOY, /^ {8}image: inventree/) + 3;
  assert.deepEqual(ff([{ filename: 'apps/tools/inventory/deployment.yaml', status: 'modified', content: DEPLOY, patch: patchAt(DEPLOY, server, '        image: inventree/inventree:1.7.2') }]), { fix_forward: true, source: 'fix-forward package inventree/inventree' });
  const pgMajor = { filename: 'apps/tools/n8n/postgres.yaml', status: 'modified', patch: '@@ -1,2 +1,2 @@\n       - name: postgres\n-        image: postgres:17.12-alpine\n+        image: postgres:18.1-alpine' };
  assert.deepEqual(ff([pgMajor]), { fix_forward: true, source: 'Postgres major change' });
  const pgMinor = { filename: 'apps/tools/n8n/postgres.yaml', status: 'modified', patch: '@@ -1,2 +1,2 @@\n       - name: postgres\n-        image: postgres:17.11-alpine\n+        image: postgres:17.12-alpine' };
  assert.equal(ff([pgMinor]).fix_forward, false);
  const plan = fs.readFileSync(path.join(REPO, 'apps/tools/system-upgrade-controller/plans/server.yaml'), 'utf8');
  const vline = lineOf(plan, /^ {2}version: /);
  assert.deepEqual(ff([{ filename: 'apps/tools/system-upgrade-controller/plans/server.yaml', status: 'modified', content: plan, patch: patchAt(plan, vline, '  version: v1.34.11+k3s1') }]), { fix_forward: true, source: 'k3s Plan version change' });
  assert.deepEqual(ff([{ filename: 'apps/tools/system-upgrade-controller/plans/server.yaml', status: 'modified', content: null, patch: patchAt(plan, vline, '  version: v1.34.11+k3s1') }]).source, 'k3s Plan version change', 'from the Renovate hint alone');
  const lh = HR.replace(/reflector/g, 'longhorn');
  assert.deepEqual(ff([{ filename: 'infrastructure/controllers/longhorn.yaml', status: 'modified', content: lh, patch: patchAt(lh, lineOf(lh, /version: 10/), '      version: 10.0.0') }]), { fix_forward: true, source: 'Longhorn chart change' });
  assert.equal(ff([hrFile()]).fix_forward, false);
});

test('fixForward: deleting a PersistentVolumeClaim is one-way; moving one is not', () => {
  const ff = (files) => rules.fixForward(pr(''), [], [], files, IDS, CONFIG).fix_forward;
  const pvc = 'apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata:\n  name: data\n';
  const minus = pvc.split('\n').map((l) => `-${l}`).join('\n');
  const plus = pvc.split('\n').map((l) => `+${l}`).join('\n');
  assert.equal(ff([{ filename: 'apps/x/pvc.yaml', status: 'removed', patch: `@@ -1,5 +0,0 @@\n${minus}` }]), true);
  assert.equal(ff([{ filename: 'apps/x/pvc.yaml', status: 'removed', patch: `@@ -1,5 +0,0 @@\n${minus}` }, { filename: 'apps/y/pvc.yaml', status: 'added', patch: `@@ -0,0 +1,5 @@\n${plus}` }]), false);
  assert.equal(ff([{ filename: 'apps/x/pvc-data.yaml', status: 'removed' }]), true, 'a removed file with no patch, by name');
  assert.equal(ff([{ filename: 'apps/x/deployment.yaml', status: 'modified', patch: '@@ -1 +1 @@\n-  replicas: 1\n+  replicas: 2' }]), false);
});

// ---------------------------------------------------------------- publish plan

const PATTERNS = ['secret-word'];
const page = (body, link) => [{ statusCode: 200, headers: link ? { link } : {}, body }];
const watch = (o) => Object.assign({ repo: 'o/r', pr: 287, merge_sha: MERGE, status: 'ok', fix_forward: false, fix_forward_source: null, detail: [] }, o);
const reads = (o) => Object.assign({ pr_labels: page([{ name: 'triage:human' }]), comments: page([]), repo_labels: ['triage:deep-review'] }, o);
const pub = (w, r, mode) => rules.planWatchPublish(w, r, { config: CONFIG, patterns: PATTERNS, mode: mode || 'labels' });

test('planWatchPublish: ok writes nothing at all, and reads nothing', () => {
  const p = pub(watch(), {});
  assert.equal(p.action, 'skip');
  assert.equal(p.outcome, 'up-to-date');
  assert.deepEqual(p.actions, []);
  assert.deepEqual(p.labels, []);
  assert.equal(pub(watch(), {}, 'off').outcome, 'up-to-date');
});

const HR_FAIL = [{ id: 'helmrelease flux-system/reflector', state: 'fail', cond: 'Ready=False (UpgradeFailed)' }, { id: 'kustomization apps', state: 'ok', cond: 'applied' }];

test('planWatchPublish: an attributed failure gets rollout:revert and one comment saying revert by hand', () => {
  const p = pub(watch({ status: 'failed', detail: HR_FAIL }), reads({ repo_labels: [] }));
  assert.equal(p.rollout_action, 'revert');
  assert.deepEqual(p.labels, ['rollout:revert']);
  assert.deepEqual(p.actions.map((a) => [a.type, a.name]), [['watch_ensure_label', 'rollout:revert'], ['watch_add_label', 'rollout:revert'], ['create_comment', undefined]]);
  assert.deepEqual([p.actions[0].color, p.actions[0].description], ['b60205', rules.WATCH_LABEL_STYLES['rollout:revert'].description]);
  const body = p.actions[2].body;
  assert.ok(body.startsWith(`<!-- pr-triage-watch:v1 sha=${MERGE} status=failed -->\n`));
  assert.match(body, /`helmrelease flux-system\/reflector`: Ready=False \(UpgradeFailed\)/);
  assert.ok(!body.includes('kustomization apps'), 'only what did not roll out');
  assert.match(body, /\*\*Revert by hand\.\*\* This merge was not made by an automated merger, so nothing reverts it automatically\./);
  assert.ok(!/fix forward|shared/i.test(body));
  // Already labelled: only the comment is left.
  const again = pub(watch({ status: 'failed', detail: HR_FAIL }), reads({ pr_labels: page([{ name: 'rollout:revert' }]), repo_labels: ['rollout:revert'] }));
  assert.deepEqual(again.actions.map((a) => a.type), ['create_comment']);
});

test('planWatchPublish: a fix-forward failure gets rollout:fix-forward, never a revert, and no deep-review', () => {
  const ff = pub(watch({ status: 'failed', detail: HR_FAIL, fix_forward: true, fix_forward_source: 'Longhorn chart change' }), reads({ repo_labels: ['triage:deep-review'] }));
  assert.equal(ff.rollout_action, 'fix-forward');
  assert.deepEqual(ff.actions.map((a) => [a.type, a.name]), [['watch_ensure_label', 'rollout:fix-forward'], ['watch_add_label', 'rollout:fix-forward'], ['create_comment', undefined]]);
  assert.equal(ff.actions[0].color, 'd93f0b');
  assert.ok(!ff.actions.some((a) => a.name === 'triage:deep-review' || a.type === 'add_label' || a.type === 'ensure_label'));
  const text = ff.actions[2].body;
  assert.match(text, /\*\*Fix forward — no revert\.\*\* Source: Longhorn chart change\./);
  assert.ok(!/revert by hand|automated merger/i.test(text));
});

test('planWatchPublish: a timeout is labelled exactly like a failure', () => {
  const t = pub(watch({ status: 'timeout', detail: HR_FAIL }), reads({ repo_labels: ['rollout:revert'] }));
  assert.deepEqual(t.actions.map((a) => [a.type, a.name]), [['watch_add_label', 'rollout:revert'], ['create_comment', undefined]]);
  assert.match(t.actions[1].body, /status=timeout -->/);
  assert.match(t.actions[1].body, /30 minutes after the merge/);
  assert.match(t.actions[1].body, /Revert by hand/);
  const tf = pub(watch({ status: 'timeout', detail: HR_FAIL, fix_forward: true, fix_forward_source: 'marker in a comment' }), reads({ repo_labels: [] }));
  assert.deepEqual(tf.labels, ['rollout:fix-forward']);
});

const OTHER = 'e'.repeat(40);
const GROUP = [{ id: 11, pr: 288, merge_sha: OTHER, fix_forward: false }, { id: 10, pr: 287, merge_sha: MERGE, fix_forward: false }];
const KS_FAIL = [{ id: 'kustomization apps', state: 'fail', cond: 'Ready=False (HealthCheckFailed)', revision: LATER }];

test('planWatchPublish: a shared failure gets rollout:investigate and a comment listing every PR in the group', () => {
  const w = watch({ status: 'failed', detail: KS_FAIL, failure_group: `kustomization apps@${LATER}`, group: GROUP });
  const p = pub(w, reads({ repo_labels: [] }));
  assert.equal(p.rollout_action, 'investigate');
  assert.deepEqual(p.actions.map((a) => [a.type, a.name]), [['watch_ensure_label', 'rollout:investigate'], ['watch_add_label', 'rollout:investigate'], ['create_comment', undefined]]);
  assert.equal(p.actions[0].color, 'fbca04');
  const body = p.actions[2].body;
  assert.match(body, new RegExp(`\`kustomization apps\` failed at revision \`${LATER.slice(0, 12)}\` \\(Ready=False \\(HealthCheckFailed\\)\\), which includes all of these merges:`));
  assert.ok(body.indexOf(`- PR 287, merge \`${MERGE.slice(0, 12)}\``) < body.indexOf(`- PR 288, merge \`${OTHER.slice(0, 12)}\``), 'both PRs, in order');
  assert.match(body, /\*\*Investigate\.\*\* The cause can't be attributed to one merge\./);
  assert.ok(!/revert by hand|automated merger/i.test(body), 'no revert suggested');
  assert.ok(!/#\d/.test(body));
  // A fix-forward member is told not to revert.
  const ffw = pub(Object.assign({}, w, { fix_forward: true, fix_forward_source: 'Postgres major change' }), reads({ repo_labels: [] }));
  assert.equal(ffw.rollout_action, 'investigate');
  assert.match(ffw.actions[2].body, /This merge is fix forward — don't revert it\.\*\* Source: Postgres major change\./);
  // A group of one is attributed.
  const one = pub(watch({ status: 'failed', detail: KS_FAIL, failure_group: `kustomization apps@${LATER}`, group: [GROUP[1]] }), reads({ repo_labels: [] }));
  assert.equal(one.rollout_action, 'revert');
  assert.ok(!/Shared failure/.test(one.actions[2].body));
});

test('planWatchPublish: never a second comment for the same merge SHA; only the App\'s marker counts', () => {
  const mine = { id: 5, body: `<!-- pr-triage-watch:v1 sha=${MERGE} status=failed -->\nx`, user: { login: APP }, performed_via_github_app: { slug: CONFIG.app_slug } };
  const p = pub(watch({ status: 'timeout' }), reads({ pr_labels: page([{ name: 'rollout:revert' }]), comments: page([mine]) }));
  assert.equal(p.outcome, 'up-to-date');
  const forged = Object.assign({}, mine, { user: { login: 'someone' }, performed_via_github_app: null });
  assert.deepEqual(pub(watch({ status: 'failed' }), reads({ pr_labels: page([{ name: 'rollout:revert' }]), comments: page([forged]) })).actions.map((a) => a.type), ['create_comment']);
  const other = Object.assign({}, mine, { body: mine.body.replace(MERGE, LATER) });
  assert.equal(pub(watch({ status: 'failed' }), reads({ pr_labels: page([{ name: 'rollout:revert' }]), comments: page([other]) })).actions.length, 1);
});

test('planWatchPublish: incomplete reads, no patterns or a redaction hit publish safely', () => {
  assert.equal(pub(watch({ status: 'failed' }), reads({ pr_labels: page([], '<https://api.github.com/x?page=2>; rel="next"') })).outcome, 'skipped-labels-incomplete');
  assert.equal(pub(watch({ status: 'failed' }), reads({ comments: [{ statusCode: 500, body: null }] })).outcome, 'skipped-comments-incomplete');
  assert.equal(rules.planWatchPublish(watch({ status: 'failed' }), reads(), { config: CONFIG, patterns: [], mode: 'labels' }).outcome, 'skipped-unhealthy');
  assert.equal(pub(watch({ status: 'pending' }), reads()).outcome, 'skipped-bad-input');
  const hit = pub(watch({ status: 'failed', detail: [{ id: 'deployment tools/secret-word', state: 'fail', cond: 'not found' }] }), reads({ repo_labels: ['rollout:revert'] }));
  assert.equal(hit.redaction_hit, true);
  assert.deepEqual(hit.actions.map((a) => a.type), ['watch_add_label'], 'the label still goes on; the comment does not');
});

test('the watch comment carries no PR reference with #, and names no login', () => {
  const body = rules.renderWatchComment(watch({ status: 'failed', detail: [{ id: 'x', state: 'fail', cond: 'see #12 @someone' }] }), CONFIG);
  assert.ok(!/#\d/.test(body));
  assert.ok(!/@someone/.test(body));
});

test('decodeBase64Utf8 matches Buffer, including multi-byte text', () => {
  for (const s of ['', 'a', 'ab', 'abc', 'kind: Deployment\n', 'Fix forward — no revert ✓\n'.repeat(50)]) {
    const b64 = Buffer.from(s, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n');
    assert.equal(rules.decodeBase64Utf8(b64), s);
  }
});
