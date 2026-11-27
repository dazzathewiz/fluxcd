'use strict';
// Run with: node --test apps/tools/n8n/triage/
// R11, the rendered-chart diff: classifyRender, the request the poll queues,
// the result it reads back, shadow vs on, the poll end to end, the render
// job's script, and its manifests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const rules = require('./rules.js');
const h = require('./poll-harness.js');

const HERE = __dirname;
const N8N = path.join(HERE, '..');
const read = (p) => fs.readFileSync(path.join(N8N, p), 'utf8');
const CONFIG_TEXT = read('triage/config.yaml');
const R11_LINE = /^r11_mode: .*$/gm;
const withR11 = (text, mode) => {
  assert.equal((text.match(R11_LINE) || []).length, 1, 'config.yaml has one r11_mode line');
  return text.replace(R11_LINE, `r11_mode: "${mode}"`);
};
const withWriteMode = (text, mode) => text.replace(/^write_mode: .*$/m, `write_mode: "${mode}"`);
const CONFIG = rules.loadConfig(CONFIG_TEXT);
const ON = rules.loadConfig(withR11(CONFIG_TEXT, 'on'));
const squash = (s) => s.replace(/\s+/g, ' ');
const node = (name) => h.nodeOf(h.POLL, name);

// ------------------------------------------------------------ renders

const deployment = (o) => ({
  apiVersion: 'apps/v1', kind: 'Deployment',
  metadata: { name: 'app', namespace: 'ns', labels: Object.assign({ app: 'app', 'helm.sh/chart': `app-${o.chart}`, 'app.kubernetes.io/version': o.app, chart: `app-${o.chart}` }, o.labels || {}) },
  spec: {
    replicas: 1,
    selector: { matchLabels: { app: 'app' } },
    template: {
      metadata: { labels: { app: 'app', 'app.kubernetes.io/version': o.app }, annotations: { 'checksum/config': o.checksum || 'c0' } },
      spec: { containers: [{ name: 'app', image: o.image || `example.invalid/app:${o.app}`, args: o.args || ['--serve'] }] },
    },
  },
});
const service = (o) => ({
  apiVersion: 'v1', kind: 'Service',
  metadata: { name: 'app', namespace: 'ns', labels: { app: 'app', 'helm.sh/chart': `app-${o.chart}` } },
  spec: Object.assign({ type: 'ClusterIP', selector: { app: 'app' }, ports: [{ name: 'http', port: 80, targetPort: 8080, protocol: 'TCP' }] }, o.spec || {}),
});
const crd = (name, schema) => ({
  apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition',
  metadata: { name },
  spec: { group: 'example.invalid', names: { kind: 'Thing', plural: 'things' }, scope: 'Namespaced', versions: [{ name: 'v1', served: true, storage: true, schema }] },
});
const pair = (oldDocs, newDocs) => rules.classifyRender(oldDocs, newDocs, { oldAppVersion: '1.4.0', newAppVersion: '1.4.1' });
const OLD = [deployment({ chart: '1.0.0', app: '1.4.0' }), service({ chart: '1.0.0' })];
// The same objects from the next chart version: only noise moved.
const NEW = [deployment({ chart: '1.0.1', app: '1.4.1' }), service({ chart: '1.0.1' })];

test('classifyRender: the rook-ceph 1.21.0 -> 1.21.1 render pair is deep-review on its changed CRDs', () => {
  const fx = JSON.parse(read('triage/fixtures/rook-ceph-crds.json'));
  const c = rules.classifyRender(fx.render.old.docs, fx.render.new.docs, { oldAppVersion: fx.render.old.app_version, newAppVersion: fx.render.new.app_version });
  assert.equal(c.level, fx.expect.level);
  assert.deepEqual(c.findings, fx.expect.findings);
  // The one unchanged doc: the operator, whose image tag moved with the appVersion.
  const op = (docs) => docs.filter((d) => d.kind === 'Deployment');
  assert.equal(op(fx.render.old.docs).length, 1);
  assert.equal(rules.classifyRender(op(fx.render.old.docs), op(fx.render.new.docs), { oldAppVersion: 'v1.21.0', newAppVersion: 'v1.21.1' }).level, 'clean');
  assert.notEqual(JSON.stringify(op(fx.render.old.docs)), JSON.stringify(op(fx.render.new.docs)), 'the raw docs do differ');
});

test('classifyRender: chart labels, checksum annotations and an appVersion image tag move are clean', () => {
  const neu = [deployment({ chart: '1.0.1', app: '1.4.1', checksum: 'c1' }), service({ chart: '1.0.1' })];
  assert.deepEqual(pair(OLD, NEW), { level: 'clean', findings: [], docs: { old: 2, new: 2 } });
  assert.deepEqual(pair(OLD, neu), { level: 'clean', findings: [], docs: { old: 2, new: 2 } });
  // v-prefixed tags against a bare appVersion count too.
  const v = rules.classifyRender([deployment({ chart: '1', app: '1.4.0', image: 'example.invalid/app:v1.4.0' })],
    [deployment({ chart: '2', app: '1.4.1', image: 'example.invalid/app:v1.4.1' })], { oldAppVersion: '1.4.0', newAppVersion: '1.4.1' });
  assert.equal(v.level, 'clean');
});

test('classifyRender: a Service port, type or selector change is deep-review', () => {
  const ports = pair(OLD, [NEW[0], service({ chart: '1.0.1', spec: { ports: [{ name: 'http', port: 80, targetPort: 9090, protocol: 'TCP' }] } })]);
  assert.deepEqual(ports, { level: 'deep-review', findings: ['Service ports changed'], docs: { old: 2, new: 2 } });
  assert.equal(pair(OLD, [NEW[0], service({ chart: '1', spec: { ports: [{ name: 'http', port: 80, targetPort: 8080, protocol: 'UDP' }] } })]).level, 'deep-review');
  assert.equal(pair(OLD, [NEW[0], service({ chart: '1', spec: { type: 'NodePort' } })]).findings[0], 'Service type changed');
  assert.equal(pair(OLD, [NEW[0], service({ chart: '1', spec: { selector: { app: 'other' } } })]).findings[0], 'Service selector changed');
  // A renamed port is a Service change, not a port change.
  const renamed = pair(OLD, [NEW[0], service({ chart: '1', spec: { ports: [{ name: 'web', port: 80, targetPort: 8080, protocol: 'TCP' }] } })]);
  assert.deepEqual([renamed.level, renamed.findings], ['review', ['Service changed']]);
});

test('classifyRender: CRDs added, removed or with a changed spec are deep-review', () => {
  const a = crd('things.example.invalid', { openAPIV3Schema: { type: 'object' } });
  const b = crd('things.example.invalid', { openAPIV3Schema: { type: 'object', properties: { spec: { type: 'object' } } } });
  assert.deepEqual(pair([a], [b]).findings, ['CRD spec changed']);
  assert.deepEqual(pair([], [a]).findings, ['CRD added']);
  assert.deepEqual(pair([a], []).findings, ['CRD removed']);
  assert.equal(pair([a], [b]).level, 'deep-review');
  const meta = JSON.parse(JSON.stringify(a));
  meta.metadata.annotations = { 'controller-gen.kubebuilder.io/version': 'v2' };
  assert.deepEqual([pair([a], [meta]).level, pair([a], [meta]).findings], ['review', ['CRD metadata changed']]);
});

test('classifyRender: a new kind, a new image or another pod-template change is review', () => {
  const pdb = { apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', metadata: { name: 'app' }, spec: { minAvailable: 1 } };
  assert.deepEqual(pair(OLD, NEW.concat(pdb)).findings, ['kind added: PodDisruptionBudget']);
  assert.deepEqual(pair(OLD.concat(pdb), NEW).findings, ['kind removed: PodDisruptionBudget']);
  const img = pair(OLD, [deployment({ chart: '2', app: '1.4.1', image: 'example.invalid/other:7' }), OLD[1]]);
  assert.deepEqual([img.level, img.findings], ['review', ['new image']]);
  const args = pair(OLD, [deployment({ chart: '2', app: '1.4.1', args: ['--serve', '--extra'] }), OLD[1]]);
  assert.deepEqual([args.level, args.findings], ['review', ['Deployment pod template changed']]);
  const replicas = JSON.parse(JSON.stringify(NEW[0]));
  replicas.spec.replicas = 3;
  assert.deepEqual(pair(OLD, [replicas, NEW[1]]).findings, ['Deployment changed']);
  const cm = (v) => ({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'c' }, data: { k: v } });
  assert.deepEqual(pair([cm('a')], [cm('b')]).findings, ['ConfigMap changed']);
});

test('classifyRender: a new render that failed where the old one succeeded is review', () => {
  assert.deepEqual(rules.classifyRender(OLD, null, {}), { level: 'review', findings: ['new chart failed to render'], docs: { old: 2, new: null } });
  const row = { id: 9, path: 'p.yaml', release: 'app', status: 'failed', error: 'new-template-failed: some template error',
    old: { digest: 'd0', app_version: '1.4.0' }, new: null, docs: { old: OLD } };
  const r = rules.r11ForRequest(row, null);
  assert.deepEqual([r.state, r.level, r.findings], ['done', 'review', ['new chart failed to render']]);
  // The old chart failing, or anything else failing, is not run.
  assert.equal(rules.r11ForRequest(Object.assign({}, row, { error: 'template-failed: x', old: null, docs: null }), null).state, 'not_run');
});

test('classifyRender: findings carry kinds and counts only, never a rendered name or value', () => {
  const neu = [
    deployment({ chart: '2', app: '1.4.1', image: 'registry.invalid/secret-image:9', args: ['--token=value-from-values'] }),
    service({ chart: '2', spec: { ports: [{ port: 81, targetPort: 'value-port' }] } }),
    crd('private-name.example.invalid', {}),
  ];
  const c = pair(OLD, neu);
  const text = c.findings.join('\n');
  for (const leak of ['secret-image', 'registry.invalid', 'value-from-values', 'value-port', 'private-name', 'ns', 'app']) {
    assert.ok(!new RegExp(`\\b${leak}\\b`).test(text), `${leak} in ${text}`);
  }
  // A kind that isn't a plain word is not echoed either.
  assert.deepEqual(pair([], [{ apiVersion: 'x/v1', kind: 'Weird<kind>', metadata: { name: 'n' } }]).findings, ['kind added: object']);
});

// ------------------------------------------------------------ results and the comment line

const doneRow = (id, docsOld, docsNew) => ({
  id, path: 'apps/example/reloader.yaml', release: 'reloader', status: 'done', error: null,
  old: { digest: `old${id}`, app_version: '1.4.0' }, new: { digest: `new${id}`, app_version: '1.4.1' }, docs: { old: docsOld, new: docsNew },
});

test('r11: pending, failed and unsupported are not run, with a fixed reason', () => {
  const pending = rules.r11Summary([rules.r11ForRequest({ id: 1, status: 'pending' }, null)], 'shadow');
  assert.equal(rules.r11Line(pending), 'R11 (shadow, not used): not run yet — render pending');
  const unsupported = rules.r11Summary([rules.r11ForRequest({ id: 2, status: 'unsupported', error: 'oci-source' }, null)], 'shadow');
  assert.equal(rules.r11Line(unsupported), 'R11 (shadow, not used): not run — OCI chart source');
  const odd = rules.r11Summary([rules.r11ForRequest({ id: 3, status: 'failed', error: 'pull-failed: https://x.invalid/secret 403' }, null)], 'shadow');
  assert.equal(rules.r11Line(odd), 'R11 (shadow, not used): not run — chart pull failed', 'the detail never reaches the line');
  const unknown = rules.r11Summary([rules.r11ForRequest({ id: 4, status: 'failed', error: 'something new' }, null)], 'shadow');
  assert.equal(rules.r11Line(unknown), 'R11 (shadow, not used): not run — render failed');
  for (const s of [pending, unsupported, odd]) {
    const c = rules.finalize(rules.checkR11(s));
    assert.equal(c.result, 'not_run');
    assert.equal(c.required, false);
  }
  assert.equal(rules.r11Line(rules.r11Summary([], 'shadow')), null, 'no chart bump: no line');
});

test('r11: a done render records request id and both digests, and the line shows the level', () => {
  const s = rules.r11Summary([rules.r11ForRequest(doneRow(5, OLD, [NEW[0], service({ chart: '2', spec: { ports: [{ port: 81 }] } })]), null)], 'shadow');
  assert.equal(rules.r11Line(s), 'R11 (shadow, not used): deep-review — Service ports changed');
  const c = rules.finalize(rules.checkR11(s));
  assert.equal(c.result, 'flag');
  assert.equal(c.evidence.source_url, 'postgres:triage.renders?request_id=5');
  assert.equal(c.evidence.etag_or_sha, '5:old5..new5');
  assert.deepEqual(c.evidence.compared.requests.map((r) => [r.id, r.old_digest, r.new_digest, r.level]), [[5, 'old5', 'new5', 'deep-review']]);
  assert.equal(c.shadow, true);
  const clean = rules.r11Summary([rules.r11ForRequest(doneRow(6, OLD, NEW), null)], 'on');
  assert.equal(rules.r11Line(clean), 'R11: clean — nothing beyond chart labels and the app version');
  assert.equal(rules.finalize(rules.checkR11(clean)).result, 'pass');
  // A finding outside the templates is shown as a placeholder.
  assert.equal(rules.r11Line({ mode: 'shadow', state: 'done', level: 'review', findings: ['Service app changed in ns'] }), 'R11 (shadow, not used): review — other finding');
});

test('r11: a cached result is used without the docs, and only for the same request and status', () => {
  const row = doneRow(7, null, null);
  row.docs = null;
  const cached = { id: 7, status: 'done', state: 'done', level: 'review', findings: ['new image'] };
  assert.deepEqual([rules.r11ForRequest(row, cached).level, rules.r11ForRequest(row, cached).findings], ['review', ['new image']]);
  assert.equal(rules.r11ForRequest(row, Object.assign({}, cached, { id: 8 })).state, 'not_run', 'another request\'s result is not used');
  assert.equal(rules.r11ForRequest(row, Object.assign({}, cached, { status: 'failed' })).reason, 'renders-not-read');
});

// ------------------------------------------------------------ the request the poll queues

function chartPR(file, from, to, chart) {
  const c = chart || 'reloader';
  return {
    repo: 'owner/fluxcd',
    now: '2026-11-14T00:00:00Z',
    config_sha: 'test-config-sha',
    pr: {
      number: 1, html_url: 'https://github.com/owner/fluxcd/pull/1', etag: 'W/"e"', head_sha: 'a'.repeat(40),
      head_ref: `renovate/${c}-x`, user_login: 'renovate[bot]', title: 't',
      body: `| Package | Type | Update | Change |\n|---|---|---|---|\n| [${c}](https://example.invalid) | HelmChart | ${rules.classifyUpdate(from, to)} | \`${from}\` → \`${to}\` |\n`,
      created_at: '2026-11-13T00:00:00Z', mergeable: true, mergeable_state: 'clean', draft: false,
    },
    files: {
      url: 'https://api.github.com/repos/owner/fluxcd/pulls/1/files', etag: 'W/"f"',
      items: [{ filename: file, additions: 1, deletions: 1, patch: `@@ -1,4 +1,4 @@\n   chart:\n     spec:\n       chart: ${c}\n-      version: ${from}\n+      version: ${to}` }],
    },
    dashboard: { url: 'https://api.github.com/repos/owner/fluxcd/issues/2', etag: 'W/"d"', body: '## Open\n' },
    cluster: { url: 'https://kubernetes.default.svc/version', gitVersion: 'v1.34.12+k3s1', etag_or_sha: 'c' },
    patterns: [],
  };
}
const hr = (o) => [
  '---', 'apiVersion: helm.toolkit.fluxcd.io/v2', 'kind: HelmRelease', 'metadata:', `  name: ${o.name || 'reloader'}`,
  ...(o.namespace === null ? [] : [`  namespace: ${o.namespace || 'flux-system'}`]), 'spec:',
  ...(o.releaseName ? [`  releaseName: ${o.releaseName}`] : []), ...(o.targetNamespace ? [`  targetNamespace: ${o.targetNamespace}`] : []),
  '  chart:', '    spec:', `      chart: ${o.chart || 'reloader'}`, `      version: ${o.version || '2.2.21'}`, '      sourceRef:',
  `        kind: ${o.sourceKind || 'HelmRepository'}`, '        name: charts', ...(o.values ? ['  values:', ...o.values.map((l) => `    ${l}`)] : []), '',
].join('\n');
const INDEX = { statusCode: 200, headers: { etag: '"i"' }, body: 'apiVersion: v1\nentries:\n  reloader:\n  - name: reloader\n    version: 2.2.21\n' };
const RAW = (file) => `https://raw.githubusercontent.com/owner/fluxcd/${'a'.repeat(40)}/${file}`;
const httpFor = (map) => async (o) => map[o.url] || { statusCode: 404, headers: {}, body: '' };
const triage = (facts, map, config) => rules.triagePR(httpFor(Object.assign({ 'https://stakater.github.io/stakater-charts/index.yaml': INDEX }, map)), facts, config || CONFIG, rules.newCaches());

test('the request names release and namespace the way Flux does', async () => {
  const f = 'apps/example/reloader.yaml';
  const plain = await triage(chartPR(f, '2.2.20', '2.2.21'), { [RAW(f)]: { statusCode: 200, body: hr({}) } });
  assert.deepEqual(plain.render_requests.map((q) => [q.release, q.namespace, q.status, q.helm_repo_url, q.kube_version, q.old_version, q.new_version, q.path]),
    [['reloader', 'flux-system', 'pending', 'https://stakater.github.io/stakater-charts', 'v1.34.12+k3s1', '2.2.20', '2.2.21', f]]);
  const target = await triage(chartPR(f, '2.2.20', '2.2.21'), { [RAW(f)]: { statusCode: 200, body: hr({ targetNamespace: 'tools' }) } });
  assert.deepEqual(target.render_requests.map((q) => [q.release, q.namespace]), [['tools-reloader', 'tools']]);
  const named = await triage(chartPR(f, '2.2.20', '2.2.21'), { [RAW(f)]: { statusCode: 200, body: hr({ targetNamespace: 'tools', releaseName: 'rl' }) } });
  assert.deepEqual(named.render_requests.map((q) => [q.release, q.namespace]), [['rl', 'tools']]);
  // The Flux Kustomization's targetNamespace sets the object's namespace.
  const pf = 'apps/infrastructure/portainer/app/helmrelease-portainer.yaml';
  const ks = await triage(chartPR(pf, '2.2.20', '2.2.21'), { [RAW(pf)]: { statusCode: 200, body: hr({ namespace: null }) } });
  assert.deepEqual(ks.render_requests.map((q) => [q.release, q.namespace]), [['reloader', 'infrastructure']]);
  // The first triage has nothing rendered yet.
  assert.equal(rules.r11Line(plain.r11), 'R11 (shadow, not used): not run yet — render pending');
});

test('unsupported: a chart with no helm_index entry, or an OCI source, is queued as unsupported', async () => {
  const f = 'apps/example/thing.yaml';
  const facts = chartPR(f, '1.0.0', '1.0.1', 'thing');
  const none = await triage(facts, { [RAW(f)]: { statusCode: 200, body: hr({ chart: 'thing', version: '1.0.1' }) } });
  assert.deepEqual(none.render_requests.map((q) => [q.status, q.error, q.helm_repo_url]), [['unsupported', 'not-in-helm-index', null]]);
  assert.equal(rules.r11Line(none.r11), 'R11 (shadow, not used): not run — chart has no helm_index entry');
  const rf = 'apps/example/reloader.yaml';
  const oci = await triage(chartPR(rf, '2.2.20', '2.2.21'), { [RAW(rf)]: { statusCode: 200, body: hr({ sourceKind: 'OCIRepository' }) } });
  assert.deepEqual(oci.render_requests.map((q) => [q.status, q.error]), [['unsupported', 'oci-source']]);
  const cfg = JSON.parse(JSON.stringify(CONFIG));
  cfg.helm_index.reloader = 'oci://ghcr.io/example/charts';
  const ociUrl = await triage(chartPR(rf, '2.2.20', '2.2.21'), { [RAW(rf)]: { statusCode: 200, body: hr({}) } }, cfg);
  assert.deepEqual(ociUrl.render_requests.map((q) => [q.status, q.error]), [['unsupported', 'oci-source']]);
});

test('unsupported: valuesFrom and postRenderers are left to the render job, which marks them unsupported', () => {
  const sh = read('triage/render.sh');
  assert.match(sh, /has\("valuesFrom"\)'[^\n]*\|\| \{ fail values-from; return 1; \}/);
  assert.match(sh, /has\("postRenderers"\)'[^\n]*\|\| \{ fail post-renderers; return 1; \}/);
  assert.equal(shell('status_for values-from; status_for post-renderers; status_for pull-failed'), 'unsupported\nunsupported\nfailed');
  assert.equal(rules.r11Line(rules.r11Summary([rules.r11ForRequest({ id: 1, status: 'unsupported', error: 'values-from' }, null)], 'shadow')),
    'R11 (shadow, not used): not run — HelmRelease uses valuesFrom');
});

test('not queued: a HelmRelease that cannot be read, or no cluster version, inserts nothing and says why', async () => {
  const f = 'apps/example/reloader.yaml';
  const unread = await triage(chartPR(f, '2.2.20', '2.2.21'), {});
  assert.deepEqual(unread.render_requests, []);
  assert.equal(rules.r11Line(unread.r11), 'R11 (shadow, not used): not run — HelmRelease file not read');
  const facts = chartPR(f, '2.2.20', '2.2.21');
  facts.cluster = { url: facts.cluster.url, error: 'HTTP 401' };
  const noCluster = await triage(facts, { [RAW(f)]: { statusCode: 200, body: hr({}) } });
  assert.deepEqual(noCluster.render_requests, []);
  assert.equal(rules.r11Line(noCluster.r11), 'R11 (shadow, not used): not run — cluster version not read');
  // A file path or repo that can't form a raw URL is never fetched.
  assert.equal(rules.rawFileUrl('owner/fluxcd', 'a'.repeat(40), '../etc/x.yaml'), null);
  assert.equal(rules.rawFileUrl('owner/fluxcd', 'nope', 'a.yaml'), null);
  assert.equal(rules.rawFileUrl('owner/fluxcd', 'a'.repeat(40), 'apps/./x.yaml'), null);
  assert.match(read('triage/render.sh'), /case \/\$path\/ in \*\/\.\.\/\*\|\*\/\.\/\*\) fail bad-request; return 1 ;; esac/);
});

// ------------------------------------------------------------ shadow vs on

test('shadow: R11 is recorded and the verdict is exactly what it is without it', async () => {
  const f = 'apps/example/reloader.yaml';
  const facts = chartPR(f, '2.2.20', '2.2.21');
  const map = { [RAW(f)]: { statusCode: 200, body: hr({}) } };
  const without = await triage(facts, map);
  const rows = [doneRow(3, OLD, [NEW[0], service({ chart: '2', spec: { type: 'NodePort' } })])];
  const withRender = await triage(Object.assign({}, facts, { render_rows: rows }), map);
  assert.equal(without.verdict, 'low-risk', JSON.stringify(without.reasons));
  assert.deepEqual([withRender.verdict, withRender.reasons], [without.verdict, without.reasons]);
  const r11 = withRender.checks.find((c) => c.id === 'R11');
  assert.deepEqual([r11.result, r11.level, r11.shadow], ['flag', 'deep-review', true]);
  assert.equal(CONFIG.r11_mode, 'shadow', 'shipped in shadow');
  assert.match(CONFIG_TEXT, /^r11_mode: "shadow"$/m, 'quoted');
});

test('on: R11 raises the verdict, never lowers it', async () => {
  const f = 'apps/example/reloader.yaml';
  const facts = chartPR(f, '2.2.20', '2.2.21');
  const map = { [RAW(f)]: { statusCode: 200, body: hr({}) } };
  const deep = await triage(Object.assign({}, facts, { render_rows: [doneRow(3, OLD, [NEW[0], service({ chart: '2', spec: { type: 'NodePort' } })])] }), map, ON);
  assert.equal(deep.verdict, 'deep-review');
  assert.ok(deep.reasons.includes('R11 rendered chart: deep-review'));
  assert.ok(!deep.reasons.includes('all low-risk conditions hold'));
  const review = await triage(Object.assign({}, facts, { render_rows: [doneRow(3, OLD, null)] }), map, ON);
  assert.equal(review.verdict, 'low-risk', 'a done request needs both renders; a missing side is not run');
  const newFail = await triage(Object.assign({}, facts, { render_rows: [Object.assign(doneRow(3, OLD, null), { status: 'failed', error: 'new-template-failed', new: null })] }), map, ON);
  assert.deepEqual([newFail.verdict, newFail.reasons], ['review', ['R11 rendered chart: review']]);
  const clean = await triage(Object.assign({}, facts, { render_rows: [doneRow(3, OLD, NEW)] }), map, ON);
  assert.equal(clean.verdict, 'low-risk', 'clean never lowers or changes anything');
  const pending = await triage(Object.assign({}, facts, { render_rows: [{ id: 3, status: 'pending' }] }), map, ON);
  assert.equal(pending.verdict, 'low-risk', 'not run yet changes nothing (fail open)');
  // Never lowers: blocked and deep-review stay.
  const v = (verdict) => ({ verdict, reasons: ['x'] });
  const s = (level) => ({ mode: 'on', state: 'done', level });
  assert.deepEqual(rules.applyR11(v('blocked'), s('deep-review')), v('blocked'));
  assert.deepEqual(rules.applyR11(v('human'), s('deep-review')), v('human'));
  assert.deepEqual(rules.applyR11(v('deep-review'), s('review')), v('deep-review'));
  assert.deepEqual(rules.applyR11(v('review'), s('deep-review')), { verdict: 'deep-review', reasons: ['x', 'R11 rendered chart: deep-review'] });
  assert.deepEqual(rules.applyR11(v('review'), Object.assign(s('deep-review'), { mode: 'shadow' })), v('review'));
  assert.throws(() => rules.loadConfig(withR11(CONFIG_TEXT, 'yes')), /r11_mode must be one of shadow, on/);
});

test('on: planPublish raises a published verdict when a render finishes after triage; shadow only adds the line', () => {
  const prState = {
    repo: 'owner/fluxcd', number: 1, head_sha: 'a'.repeat(40), state: 'open', draft: false, labels: [], repo_labels: [],
    since: null, comments: { stored_id: null, stored: null, list: [{ statusCode: 200, headers: {}, body: [] }] },
  };
  const verdict = { verdict: 'review', reasons: ['low-risk conditions not all met'], ruleset: 'r1.c1' };
  const events = [{ statusCode: 200, headers: {}, body: [] }];
  const r11 = (mode) => rules.r11Summary([rules.r11ForRequest(doneRow(4, OLD, [NEW[0], service({ chart: '2', spec: { type: 'NodePort' } })]), null)], mode);
  const ctx = (config, mode) => ({ config, healthy: true, patterns: ['/example-private-term/'], app_id: '1', installation_id: '2', r11: r11(mode) });
  const shadow = rules.planPublish(prState, verdict, null, events, rules.appLoginOf(CONFIG), ctx(CONFIG, 'shadow'));
  assert.deepEqual([shadow.verdict, shadow.label], ['review', 'triage:review']);
  const body = shadow.actions.find((a) => a.type === 'create_comment').body;
  assert.match(body, /\nR11 \(shadow, not used\): deep-review — Service type changed\n/);
  const on = rules.planPublish(prState, verdict, null, events, rules.appLoginOf(ON), ctx(ON, 'on'));
  assert.deepEqual([on.verdict, on.label], ['deep-review', 'triage:deep-review']);
  assert.match(on.actions.find((a) => a.type === 'create_comment').body, /- R11 rendered chart: deep-review\n[\s\S]*\nR11: deep-review — Service type changed\n/);
  // The line goes through the redaction filter with the rest of the comment.
  const hit = rules.planPublish(prState, verdict, null, events, rules.appLoginOf(CONFIG), Object.assign(ctx(CONFIG, 'shadow'), { patterns: ['/Service type changed/'] }));
  assert.equal(hit.outcome, 'redaction-hit');
});

// ------------------------------------------------------------ the poll end to end

const REPO = 'dazzathewiz/fluxcd';
const API = `https://api.github.com/repos/${REPO}`;
const HEAD = 'b'.repeat(40);
const FILE = 'infrastructure/configs/reloader-helmrelease.yaml';

// A read-only GitHub for write_mode off: one chart PR; comments can be seeded.
function readOnlyGithub() {
  const comments = [];
  const pr = {
    number: 296, url: `${API}/pulls/296`, issue_url: `${API}/issues/296`, html_url: `https://github.com/${REPO}/pull/296`,
    state: 'open', draft: false, title: 'chore(deps): update helm release reloader to v2.2.21', created_at: '2026-11-10T00:00:00Z',
    body: '| Package | Type | Update | Change |\n|---|---|---|---|\n| [reloader](https://example.invalid) | HelmChart | patch | `2.2.20` → `2.2.21` |\n',
    user: { login: 'renovate[bot]' }, head: { sha: HEAD, ref: 'renovate/reloader-2.x' }, base: { repo: { full_name: REPO, url: API } },
    labels: [], mergeable: true, mergeable_state: 'clean',
  };
  const files = [{ filename: FILE, status: 'modified', additions: 1, deletions: 1, patch: '@@ -9,7 +9,7 @@ spec:\n   chart:\n     spec:\n       chart: reloader\n-      version: 2.2.20\n+      version: 2.2.21\n       sourceRef:\n         kind: HelmRepository\n         name: stakater-charts' }];
  const github = (method, url) => {
    assert.equal(method, 'GET', 'write_mode off writes nothing');
    const p = new URL(url).pathname.replace(`/repos/${REPO}`, '');
    if (url === 'https://api.github.com/rate_limit') return { statusCode: 200, headers: {}, body: {} };
    if (p === '/issues' || p === '/labels' || p === '/issues/296/events') return { statusCode: 200, headers: {}, body: [] };
    if (p === '/pulls') return { statusCode: 200, headers: { etag: '"l"' }, body: [pr] };
    if (p === '/pulls/296') return { statusCode: 200, headers: {}, body: pr };
    if (p === '/pulls/296/files') return { statusCode: 200, headers: {}, body: files };
    if (p === '/issues/296/comments') return { statusCode: 200, headers: {}, body: comments };
    const m = p.match(/^\/issues\/comments\/(\d+)$/);
    if (m) { const c = comments.find((x) => x.id === Number(m[1])); return c ? { statusCode: 200, headers: {}, body: c } : { statusCode: 404, headers: {}, body: {} }; }
    return { statusCode: 404, headers: {}, body: {} };
  };
  // Stands in for the App having posted the planned comment.
  const post = (body) => comments.push({ id: 7000 + comments.length, body, user: { login: 'dtw-pr-triage[bot]' }, performed_via_github_app: { slug: 'dtw-pr-triage' } });
  return { github, post, comments };
}
const external = async (o) => {
  if (o.url === 'https://stakater.github.io/stakater-charts/index.yaml') return INDEX;
  if (o.url === `https://raw.githubusercontent.com/${REPO}/${HEAD}/${FILE}`) return { statusCode: 200, headers: {}, body: hr({}) };
  return { statusCode: 404, headers: {}, body: '' };
};

test('poll: a chart bump queues one request; the finished render reaches the comment in place, once', async () => {
  const db = h.newDb();
  const gh = readOnlyGithub();
  const opts = { db, github: gh.github, repo: REPO, ruleset: 'r1.c1', config: withWriteMode(CONFIG_TEXT, 'off'), patterns: ['/example-private-term/'], external };
  const r1 = await h.runPoll(opts);
  assert.equal(r1.runItem.render_requests, 1);
  assert.equal(db.render_requests.length, 1);
  const rq = db.render_requests[0];
  assert.deepEqual([rq.pr, rq.head_sha, rq.path, rq.release, rq.namespace, rq.chart, rq.helm_repo_url, rq.old_version, rq.new_version, rq.kube_version, rq.status],
    [296, HEAD, FILE, 'reloader', 'flux-system', 'reloader', 'https://stakater.github.io/stakater-charts', '2.2.20', '2.2.21', 'v1.34.12+k3s1', 'pending']);
  const first = r1.plans[0].actions.find((a) => a.type === 'create_comment').body;
  assert.match(first, /\nR11 \(shadow, not used\): not run yet — render pending\n/);
  const v1 = db.verdicts[0];
  gh.post(first);

  // Same head SHA, same ruleset: not re-triaged, so nothing is queued again.
  const r2 = await h.runPoll(opts);
  assert.equal(r2.runItem.render_requests, 0);
  assert.equal(db.render_requests.length, 1);
  const comments = (plan) => plan.actions.filter((a) => a.type === 'create_comment' || a.type === 'edit_comment');
  assert.deepEqual(comments(r2.plans[0]), [], 'the comment is already right');

  // The job renders it: the next run edits the comment in place.
  h.finishRender(db, rq.id, { digest: 'o'.repeat(64), app_version: '1.4.0', docs: OLD },
    { digest: 'n'.repeat(64), app_version: '1.4.1', docs: [NEW[0], service({ chart: '2', spec: { ports: [{ port: 81 }] } })] });
  const r3 = await h.runPoll(opts);
  assert.ok(r3.out.Renders[0].json.requests[0].docs, 'docs read once, while no plan holds the result');
  const edit = r3.plans[0].actions.find((a) => a.type === 'edit_comment');
  assert.equal(edit.comment_id, 7000);
  assert.match(edit.body, /\nR11 \(shadow, not used\): deep-review — Service ports changed\n/);
  assert.equal(r3.plans[0].verdict, v1.verdict, 'shadow: the verdict is unchanged');
  assert.equal(r3.plans[0].r11.results[0].level, 'deep-review');
  gh.comments[0].body = edit.body;

  // Cached: the docs aren't read again and nothing changes.
  const r4 = await h.runPoll(opts);
  assert.equal(r4.out.Renders[0].json.requests[0].docs, null);
  assert.deepEqual(comments(r4.plans[0]), []);

  // A new ruleset re-triages and queues the same request: still one row.
  const r5 = await h.runPoll(Object.assign({}, opts, { ruleset: 'r2.c2' }));
  assert.equal(r5.runItem.render_requests, 1);
  assert.equal(db.render_requests.length, 1, 'ON CONFLICT DO NOTHING');
  assert.equal(r5.out.Renders[0].json.cache, null, 'a cache from another ruleset is not used');
  const check = db.verdicts.length;
  assert.equal(check, 2);
});

test('queue: the insert is idempotent on the table\'s unique key', () => {
  const db = h.newDb();
  const q = { repo: REPO, pr: 1, head_sha: HEAD, path: FILE, release: 'reloader', namespace: 'flux-system', chart: 'reloader', old_version: '1', new_version: '2', status: 'pending' };
  assert.equal(h.queueRender(db, q), true);
  assert.equal(h.queueRender(db, Object.assign({}, q, { kube_version: 'v9.9.9' })), false);
  assert.equal(h.queueRender(db, Object.assign({}, q, { release: 'other' })), true);
  const sql = squash(node('Queue render').parameters.query);
  assert.match(sql, /ON CONFLICT \(repo, pr, head_sha, path, release\) DO NOTHING;$/);
  assert.match(read('triage/schema.sql'), /CONSTRAINT render_requests_key UNIQUE \(repo, pr, head_sha, path, release\)/);
  assert.match(sql, /CASE WHEN \$12::text = 'unsupported' THEN now\(\) END/);
});

test('poll SQL: Renders reads one head SHA and sends docs only without a stored result; Start run skips the ETag after a render', () => {
  const r = squash(node('Renders').parameters.query);
  assert.equal(node('Renders').credentials.postgres.id, 'triagePostgres01');
  assert.match(r, /WHERE rq\.repo = \$2 AND rq\.pr = NULLIF\(\$3, ''\)::integer AND rq\.head_sha = \$4\) AS requests;$/);
  assert.match(r, /AND p\.planned -> 'r11' ->> 'ruleset' = \$5/);
  assert.match(r, /'docs', CASE WHEN rq\.status IN \('done', 'failed'\) AND NOT EXISTS \(/);
  assert.match(r, /c ->> 'id' = rq\.id::text AND c ->> 'status' = rq\.status AND c ->> 'state' = 'done'/);
  assert.ok(!/\b(INSERT|UPDATE|DELETE)\b/.test(r), 'read-only');
  const s = squash(node('Start run').parameters.query);
  assert.match(s, /CASE WHEN EXISTS \(SELECT 1 FROM triage\.render_requests rq WHERE rq\.repo = repos\.repo AND rq\.finished > \(SELECT started FROM last\)\) THEN NULL ELSE \(SELECT list_etags ->> repos\.repo FROM last\) END AS list_etag/);
  // Renders runs before the Triage branch, and the queue before Finish run.
  const ys = (names) => names.map((n) => node(n).position[1]);
  const kids = h.POLL.connections['PR read URLs'].main[0].map((l) => l.node);
  assert.deepEqual(kids, ['Label events', 'Stored comment', 'Renders', 'Cluster version']);
  assert.deepEqual(ys(kids), ys(kids).slice().sort((a, b) => a - b));
  assert.ok(node('Render requests only').position[1] < node('Run summary only').position[1]);
});

// ------------------------------------------------------------ the render job's script

const SCRIPT = path.join(HERE, 'render.sh');
function shell(cmd, input) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'render-test-'));
  try {
    return execFileSync('sh', ['-c', `RENDER_LIB=1 WORK="$1" . "$2"; ${cmd}`, 'sh', work, SCRIPT], { input: input || '', encoding: 'utf8' }).replace(/\n$/, '');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

test('render.sh: ${VAR} placeholders become subst-<var>, so no resolved value can reach the render', () => {
  const out = shell('substitute', 'host: app.${PERSONAL_DOMAIN}\nclaim: "${PV_CLAIM}"\nd: ${X:=dflt}-${Y:-z}\nkeep: $(not-a-var) $HOME\n');
  assert.equal(out, 'host: app.subst-personal_domain\nclaim: "subst-pv_claim"\nd: subst-x-subst-y\nkeep: $(not-a-var) $HOME');
});

test('render.sh: request fields are checked as whole single lines before use', () => {
  const ok = (v, re) => shell(`valid "$V" '${re}' && echo yes || echo no`.replace('$V', JSON.stringify(v).replace(/^"|"$/g, '')));
  assert.equal(ok('reloader', '[a-z0-9][a-z0-9._-]{0,99}'), 'yes');
  assert.equal(ok('reloader;rm', '[a-z0-9][a-z0-9._-]{0,99}'), 'no');
  assert.equal(shell("valid \"$(printf 'ok\\nbad;x')\" '[a-z]+' && echo yes || echo no"), 'no', 'a second line never slips past');
});

test('render.sh: claims at most 3, with SKIP LOCKED and attempts + 1, and stops after 3 attempts', () => {
  const sh = read('triage/render.sh');
  assert.match(sh, /^CLAIM_LIMIT=\$\{CLAIM_LIMIT:-3\}$/m);
  assert.match(sh, /^MAX_ATTEMPTS=3$/m);
  assert.match(sh, /^MAX_BYTES=\$\{MAX_BYTES:-8388608\}$/m);
  const claim = squash(sh.slice(sh.indexOf('WITH c AS ('), sh.indexOf('SQL', sh.indexOf('WITH c AS ('))));
  assert.match(claim, /WHERE attempts < \$MAX_ATTEMPTS AND \(status = 'pending' OR \(status = 'failed' AND split_part/);
  assert.match(claim, /LIMIT :limit FOR UPDATE SKIP LOCKED \)/);
  assert.match(claim, /SET attempts = r\.attempts \+ 1, status = 'pending'/);
  assert.match(sh, /helm template "\$release" "\$tgz" -n "\$namespace" -f "\$dir\/values\.yaml" --include-crds --skip-tests \\\n\s+--kube-version "\$kube"/);
  assert.match(sh, /https:\/\/raw\.githubusercontent\.com\/\$repo\/\$sha\/\$path/);
  // Logs: one line per request, from fixed fields only; never values or helm's output.
  const logs = sh.split('\n').filter((l) => /\blog "/.test(l));
  for (const l of logs) assert.ok(!/values|DETAIL|err"|hr-doc|docs\.json/.test(l), l);
  assert.ok(!/set -x/.test(sh));
  // The two renders and the outcome are one transaction.
  assert.match(squash(sh), /BEGIN; \\if :has_old .* \\endif \\if :has_new .* \\endif UPDATE triage\.render_requests SET status = :'status', error = NULLIF\(:'err', ''\), finished = now\(\) WHERE id = :id; COMMIT;/);
});

test('render.sh: a dry run needs no database', () => {
  const sh = read('triage/render.sh');
  const dry = sh.slice(sh.indexOf('if [ "$DRY_RUN" = 1 ]; then\n  [ -n'), sh.indexOf('until pg_isready'));
  assert.ok(dry.includes('exit 0'));
  assert.ok(!/\bq\b|psql/.test(dry), 'no database call before the dry run exits');
  assert.match(sh, /if \[ "\$DRY_RUN" = 1 \]; then\n\s+dry_result "\$status"/);
});

// ------------------------------------------------------------ manifests

test('the CronJob: every 5 minutes, one at a time, 10-minute deadline, no cluster credentials, locked down', () => {
  const y = read('triage-render.yaml');
  assert.match(y, /schedule: "\*\/5 \* \* \* \*"/);
  assert.match(y, /concurrencyPolicy: Forbid/);
  assert.match(y, /successfulJobsHistoryLimit: 1\n\s+failedJobsHistoryLimit: 3/);
  assert.match(y, /activeDeadlineSeconds: 600/);
  assert.match(y, /automountServiceAccountToken: false/);
  assert.match(y, /runAsNonRoot: true/);
  assert.equal((y.match(/readOnlyRootFilesystem: true/g) || []).length, 3, 'all three containers');
  assert.equal((y.match(/drop: \["ALL"\]/g) || []).length, 3);
  assert.equal((y.match(/allowPrivilegeEscalation: false/g) || []).length, 3);
  assert.ok(!/serviceAccountName/.test(y));
  // Readable tags, never latest or a digest; the main image tracks n8n-db's.
  const images = Array.from(y.matchAll(/image: (\S+)/g)).map((m) => m[1]);
  assert.deepEqual(images.map((i) => i.split(':')[0]), ['alpine/helm', 'mikefarah/yq', 'postgres']);
  for (const i of images) assert.match(i, /:\d+\.\d+(\.\d+)?(-alpine)?$/, i);
  const db = read('postgres.yaml').match(/image: (postgres:\S+)/)[1];
  assert.equal(images[2], db);
  for (const dir of ['/work', '/helm', '/tmp', '/tools']) assert.match(y, new RegExp(`mountPath: ${dir}\\n`), dir);
  assert.match(y, /value: "\/tools:\/usr\/local\/bin:\/usr\/bin:\/bin"/);
  assert.ok(!/\$\{/.test(y), 'nothing for Flux to substitute');
  const k = read('kustomization.yaml');
  assert.match(k, /- triage-render\.yaml/);
  assert.match(k, /- name: triage-render-scripts\n\s+namespace: tools\n\s+files:\n\s+- triage\/render\.sh\n\s+options:\n\s+annotations:\n\s+kustomize\.toolkit\.fluxcd\.io\/substitute: disabled/);
});

test('NetworkPolicy: triage-render has no ingress, and egress only to DNS, n8n-db and HTTPS outside private ranges', () => {
  const np = read('networkpolicy.yaml');
  const own = np.slice(np.indexOf('  name: triage-render'));
  assert.match(own, /podSelector:\n\s+matchLabels:\n\s+app: triage-render\n\s+policyTypes:\n\s+- Ingress\n\s+- Egress\n\s+egress:/);
  assert.ok(!/\n\s+ingress:/.test(own));
  assert.match(own, /k8s-app: kube-dns/);
  assert.match(own, /app: n8n-db\n\s+ports:\n\s+- protocol: TCP\n\s+port: 5432/);
  assert.match(own, /cidr: 0\.0\.0\.0\/0\n\s+except:\n\s+- 10\.0\.0\.0\/8\n\s+- 172\.16\.0\.0\/12\n\s+- 192\.168\.0\.0\/16\n\s+ports:\n\s+- protocol: TCP\n\s+port: 443\n?$/);
  const dbPolicy = np.slice(np.indexOf('  name: n8n-db'), np.indexOf('  name: triage-render'));
  assert.match(dbPolicy, /app: triage-render\n\s+ports:\n\s+- protocol: TCP\n\s+port: 5432/);
});
