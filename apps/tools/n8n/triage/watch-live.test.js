'use strict';
// Run with: node --test apps/tools/n8n/triage/
// R10 regression tests on objects captured from the live cluster and GitHub
// (fixtures/watch/, trimmed to the fields the watcher reads).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rules = require('./rules.js');

const HERE = __dirname;
const CONFIG = rules.loadConfig(fs.readFileSync(path.join(HERE, 'config.yaml'), 'utf8'));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'watch', name), 'utf8'));
const MERGED_AT = '2026-11-21T11:53:00Z';
const NOW = '2026-11-21T12:04:51Z';
// What TriageClusterV01 hands back for a GET: the status code and the parsed body.
const read = (body) => ({ statusCode: 200, body });
const evaluate = (target, body, mergeSha, compare) => rules.evaluateWatch([target], { merge_sha: mergeSha, reads: { [target.id]: read(body) }, compare: compare || {} }, NOW, MERGED_AT, {}, { timeout_min: 30 });

// The apps Kustomization reconciles every 5 minutes, and the watcher runs every
// 5 minutes. For the few seconds a reconcile takes, Ready is Unknown while
// lastAppliedRevision already holds the merge; two of #287's checks landed in
// that window and read "merge not applied yet".
test('live Kustomization: applied while Flux reconciles again counts as applied', () => {
  const fx = fixture('kustomization-apps.json');
  const target = { id: 'kustomization apps', type: 'kustomization', name: 'apps' };
  const ready = fx.reconciling.status.conditions.find((c) => c.type === 'Ready');
  assert.equal(ready.status, 'Unknown', 'the fixture is the mid-reconcile read');
  assert.equal(rules.revisionSha(fx.reconciling.status.lastAppliedRevision), fx.merge_sha);

  const mid = evaluate(target, fx.reconciling, fx.merge_sha);
  assert.equal(mid.status, 'ok');
  assert.deepEqual(mid.detail, [{ id: target.id, state: 'ok', cond: 'applied (reconciling again)' }]);
  assert.deepEqual(evaluate(target, fx.ready, fx.merge_sha).detail[0], { id: target.id, state: 'ok', cond: 'applied' });

  // A later merge already applied: the compare API decides.
  const later = 'c'.repeat(40);
  const ahead = JSON.parse(JSON.stringify(fx.reconciling));
  ahead.status.lastAppliedRevision = `main@sha1:${later}`;
  ahead.status.lastAttemptedRevision = `main@sha1:${later}`;
  assert.equal(evaluate(target, ahead, fx.merge_sha, { [later]: 'ahead' }).status, 'ok');
  assert.equal(evaluate(target, ahead, fx.merge_sha).detail[0].cond, 'revision not compared yet');

  // Reconciling the merge for the first time, the old revision still applied:
  // still pending.
  const first = JSON.parse(JSON.stringify(fx.reconciling));
  first.status.lastAppliedRevision = `main@sha1:${later}`;
  const p = evaluate(target, first, fx.merge_sha, { [later]: 'behind' });
  assert.equal(p.status, 'pending');
  assert.equal(p.detail[0].cond, 'merge not applied yet (reconciling)');
});

test('live HelmRelease: the installed chart passes, and still passes while another reconcile runs', () => {
  const fx = fixture('helmrelease-reflector.json');
  const o = fx.object;
  const target = { id: `helmrelease ${o.metadata.namespace}/${o.metadata.name}`, type: 'helmrelease', ns: o.metadata.namespace, name: o.metadata.name, version: o.spec.chart.spec.version };
  assert.deepEqual(evaluate(target, o, 'a'.repeat(40)).detail[0], { id: target.id, state: 'ok', cond: `chart ${target.version} installed` });

  const again = JSON.parse(JSON.stringify(o));
  again.status.conditions.find((c) => c.type === 'Ready').status = 'Unknown';
  assert.equal(evaluate(target, again, 'a'.repeat(40)).detail[0].cond, `chart ${target.version} installed (reconciling again)`);

  const failedRelease = JSON.parse(JSON.stringify(again));
  failedRelease.status.history[0].status = 'failed';
  assert.equal(evaluate(target, failedRelease, 'a'.repeat(40)).status, 'pending');
  assert.equal(evaluate(Object.assign({}, target, { version: '10.0.79' }), o, 'a'.repeat(40)).status, 'pending', 'a newer chart not applied yet');
});

test('live Deployment: a rolled-out workload passes; an image not in the spec waits', () => {
  const o = fixture('deployment-n8n.json').object;
  const images = o.spec.template.spec.containers.map((c) => c.image);
  const target = { id: `deployment ${o.metadata.namespace}/${o.metadata.name}`, type: 'deployment', ns: o.metadata.namespace, name: o.metadata.name, images };
  assert.deepEqual(evaluate(target, o, 'a'.repeat(40)).detail[0], { id: target.id, state: 'ok', cond: 'rolled out' });
  assert.equal(evaluate(Object.assign({}, target, { images: ['n8nio/n8n:0.0.1'] }), o, 'a'.repeat(40)).detail[0].cond, 'new image not in the spec yet');
});

// #287 named inventree/inventree in config.yaml, and its tests hold an
// `image: inventree/inventree:…` line inside a JS string. Neither changes an
// image the cluster runs.
test('fixForward: #287 itself is not fix-forward', () => {
  const { files } = fixture('pr287-files.json');
  assert.ok(files.some((f) => /\.test\.js$/.test(f.filename) && /^\+\s*image: inventree\/inventree:/m.test(f.patch)), 'the fixture holds the line that matched');
  assert.deepEqual(rules.fixForward({ body: '', user: { login: 'someone' } }, [], [], files, {}, CONFIG), { fix_forward: false, source: null });
});

const ff = (files) => rules.fixForward({ body: '' }, [], [], files, {}, CONFIG);
const one = (filename, oldLine, newLine, context, extra) => Object.assign({
  filename, status: 'modified',
  patch: ['@@ -1,4 +1,4 @@'].concat((context || []).map((l) => ` ${l}`), oldLine === null ? [] : [`-${oldLine}`], newLine === null ? [] : [`+${newLine}`]).join('\n'),
}, extra || {});

test('fixForward: a listed package counts only as a changed image in a manifest', () => {
  assert.equal(ff([one('apps/tools/inventory/deployment.yaml', '        image: inventree/inventree:1.7.2', '        image: inventree/inventree:1.7.3')]).source, 'fix-forward package inventree/inventree');
  assert.equal(ff([one('apps/tools/inventory/deployment.yaml', '        image: inventree/inventree:1.7.3', null)]).fix_forward, true, 'a removed image line');
  assert.equal(ff([one('apps/x/values.yaml', '    tag: 1.7.2', '    tag: 1.7.3', ['  image:', '    repository: inventree/inventree'])]).source, 'fix-forward package inventree/inventree', 'repository plus a changed tag');
  assert.equal(ff([one('apps/x/values.yaml', '    tag: 1.7.3', '    tag: 1.7.3  ', ['    repository: inventree/inventree'])]).fix_forward, false, 'the same tag');
  // Never: docs, code or test data, lists of names, comments.
  assert.equal(ff([one('docs/inventory.md', null, '    image: inventree/inventree:1.7.3')]).fix_forward, false);
  assert.equal(ff([one('apps/tools/n8n/triage/watch.test.js', null, '        image: inventree/inventree:1.7.3')]).fix_forward, false);
  assert.equal(ff([one('apps/tools/n8n/triage/fixtures/x.yaml', null, '        image: inventree/inventree:1.7.3')]).fix_forward, false);
  assert.equal(ff([one('apps/tools/n8n/triage/config.yaml', 'fix_forward_packages: []', 'fix_forward_packages: [inventree/inventree]')]).fix_forward, false);
  assert.equal(ff([one('apps/tools/inventory/deployment.yaml', null, '        # image: inventree/inventree:1.7.3')]).fix_forward, false);
});

test('fixForward: Postgres major, k3s Plan and Longhorn chart need their version line changed', () => {
  assert.equal(ff([one('apps/x/db.yaml', '        image: postgres:17.12-alpine', '        image: postgres:18.1-alpine')]).source, 'Postgres major change');
  assert.equal(ff([one('docs/x.md', '        image: postgres:17.12-alpine', '        image: postgres:18.1-alpine')]).fix_forward, false);

  const plan = 'apiVersion: upgrade.cattle.io/v1\nkind: Plan\nmetadata:\n  name: server-plan\nspec:\n  concurrency: 1\n  version: v1.34.12+k3s1\n';
  const planFile = (patch) => ({ filename: 'apps/x/plans/server.yaml', status: 'modified', content: plan, patch });
  assert.equal(ff([planFile('@@ -7 +7 @@\n-  version: v1.34.11+k3s1\n+  version: v1.34.12+k3s1')]).source, 'k3s Plan version change');
  assert.equal(ff([planFile('@@ -6 +6 @@\n-  concurrency: 2\n+  concurrency: 1')]).fix_forward, false, 'another line of the Plan');

  const lh = 'apiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: longhorn\nspec:\n  interval: 5m\n  chart:\n    spec:\n      chart: longhorn\n      version: 1.13.0\n';
  const lhFile = (patch) => ({ filename: 'infrastructure/controllers/longhorn.yaml', status: 'modified', content: lh, patch });
  assert.equal(ff([lhFile('@@ -10 +10 @@\n-      version: 1.12.0\n+      version: 1.13.0')]).source, 'Longhorn chart change');
  assert.equal(ff([lhFile('@@ -6 +6 @@\n-  interval: 10m\n+  interval: 5m')]).fix_forward, false, 'another line of the HelmRelease');
});

test('fixForward: a deleted PersistentVolumeClaim counts only as a removed manifest document', () => {
  const doc = ['apiVersion: v1', 'kind: PersistentVolumeClaim', 'metadata:', '  name: data'];
  const removed = (filename) => ({ filename, status: 'modified', patch: `@@ -1,4 +0,0 @@\n${doc.map((l) => `-${l}`).join('\n')}` });
  assert.equal(ff([removed('apps/x/pvc.yaml')]).source, 'a PersistentVolumeClaim is deleted');
  assert.equal(ff([removed('docs/x.md')]).fix_forward, false);
  assert.equal(ff([removed('apps/tools/n8n/triage/watch.test.js')]).fix_forward, false);
  assert.equal(ff([one('apps/x/notes.yaml', '# a PersistentVolumeClaim', null)]).fix_forward, false, 'the word alone');
});
