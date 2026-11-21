'use strict';
// Run with: node --test apps/tools/n8n/triage/
// The poll's Triage node gets the cluster version from the unsaved sub-workflow
// (workflows/triage-cluster-version.json) and replays it into rules.js. These
// tests run the Triage node's real code against each outcome of that call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HERE = __dirname;
const WORKFLOWS = path.join(HERE, '..', 'workflows');
const poll = JSON.parse(fs.readFileSync(path.join(WORKFLOWS, 'triage-poll.json'), 'utf8'));
const sub = JSON.parse(fs.readFileSync(path.join(WORKFLOWS, 'triage-cluster-version.json'), 'utf8'));
const CONFIG_TEXT = fs.readFileSync(path.join(HERE, 'config.yaml'), 'utf8');
const triageCode = poll.nodes.find((n) => n.name === 'Triage').parameters.jsCode;
const h = require('./poll-harness.js');

const VERSION_200 = {
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: { major: '1', minor: '34', gitVersion: 'v1.34.12+k3s1', gitCommit: 'b1c2d3e4f5' },
};
// What the cluster actually returned to the unauthenticated call (2026-11-15).
const VERSION_401 = {
  statusCode: 401,
  headers: { 'content-type': 'application/json' },
  body: { kind: 'Status', apiVersion: 'v1', status: 'Failure', message: 'Unauthorized', reason: 'Unauthorized', code: 401 },
};
// Execute Workflow with onError: continueRegularOutput passes an error item.
const SUB_ERROR = { error: 'Access to the file is not allowed.' };

// One run with no PRs to triage: the list is unchanged (304).
async function runTriage(clusterVersionJson) {
  const out = {
    'Start run': [{ json: { run_id: 1, ruleset: 'rtest.ctest', repo: 'dazzathewiz/fluxcd', list_etag: 'W/"e"', config_body: CONFIG_TEXT, config_sha: 'sha', patterns: [], seen: [] } }],
    'Get dashboard': [{ json: { statusCode: 200, headers: {}, body: [] } }],
    'List PRs': [{ json: { statusCode: 304, headers: {} } }],
    'Get PR': [{ json: { statusCode: 200, headers: {}, body: { resources: {} } } }],
    'Get files': [{ json: { statusCode: 200, headers: {}, body: { resources: {} } } }],
    'Cluster version': [{ json: clusterVersionJson }],
  };
  const calls = [];
  const ctx = vm.createContext({
    helpers: { httpRequest: async (o) => { calls.push(o.url); return { statusCode: 404, headers: {}, body: '' }; } },
    $input: { first: () => out['Cluster version'][0], all: () => out['Cluster version'] },
    $: (n) => ({ first: () => (out[n] || [])[0], all: () => out[n] || [] }),
  });
  const items = await vm.runInContext(`module = { exports: {} }; module.exports = async function VmCodeWrapper() {${triageCode}\n}()`, ctx);
  return { run: items[0].json, calls };
}

test('a 200 from the sub-workflow makes the negative control fail and the run ok', async () => {
  const { run, calls } = await runTriage(VERSION_200);
  assert.equal(run.kind, 'run');
  assert.equal(run.ruleset, 'rtest.ctest');
  assert.equal(run.negative_control.result, 'fail');
  assert.equal(run.negative_control.evidence.compared.cluster, 'v1.34.12+k3s1');
  assert.equal(run.negative_control.evidence.etag_or_sha, 'b1c2d3e4f5');
  assert.equal(run.ok, true);
  assert.deepEqual(calls, [], 'Triage must not call /version itself');
});

test('the 401 seen live keeps R4 not_run and the run not ok', async () => {
  const { run } = await runTriage(VERSION_401);
  assert.equal(run.negative_control.result, 'not_run');
  assert.equal(run.ok, false);
});

test('a failed sub-workflow (error item) keeps the run finishing, not ok', async () => {
  const { run } = await runTriage(SUB_ERROR);
  assert.equal(run.negative_control.result, 'not_run');
  assert.equal(run.ok, false);
});

test('the sub-workflow saves no executions and ends on binary-free nodes', () => {
  const s = sub.settings;
  assert.equal(s.saveDataSuccessExecution, 'none');
  assert.equal(s.saveDataErrorExecution, 'none');
  assert.equal(s.saveManualExecutions, false);
  assert.equal(s.saveExecutionProgress, false);
  const targets = new Set(Object.values(sub.connections).flatMap((c) => c.main.flat().map((l) => l.node)));
  const sources = new Set(Object.keys(sub.connections));
  const last = sub.nodes.filter((n) => targets.has(n.name) && !sources.has(n.name));
  // n8n copies the sub-workflow's last-node binary into the parent execution:
  // the request (status and body) or the rejection (a new object).
  assert.deepEqual(last.map((n) => [n.name, n.type]), [['GET', 'n8n-nodes-base.httpRequest'], ['Rejected', 'n8n-nodes-base.code']]);
  assert.equal(last[0].parameters.options.response.response.responseFormat, undefined);
  assert.equal(last[0].parameters.method, 'GET');
  assert.equal(last[0].parameters.url, "={{ 'https://kubernetes.default.svc' + $('Allowed path').first().json.path }}");
  // The token is read only on the allowed branch.
  assert.deepEqual(sub.connections['Allowed?'].main.map((b) => b.map((l) => l.node)), [['Read service-account token'], ['Rejected']]);
  assert.deepEqual(sub.connections['When called'].main[0].map((l) => l.node), ['Allowed path']);
});

// Runs the Allowed path node on one caller item.
const allowedPath = (json) => h.code(sub.nodes.find((n) => n.name === 'Allowed path'), {}, [{ json }], 0)[0].json;

test('the allowlist: no cluster_path is GET /version, exactly as the poll calls it', () => {
  // The poll's Cluster version call passes its current item, which has no cluster_path.
  assert.deepEqual(allowedPath({ key: 'o/r#1@x', events_url: 'https://api.github.com/x' }), { allowed: true, path: '/version' });
  assert.deepEqual(allowedPath({}), { allowed: true, path: '/version' });
  assert.equal(poll.nodes.find((n) => n.name === 'Cluster version').parameters.mode, 'once');
});

test('the allowlist: the five templates with DNS labels pass, and nothing else does', () => {
  const rules = require('./rules.js');
  const node = sub.nodes.find((n) => n.name === 'Allowed path').parameters.jsCode;
  for (const t of rules.CLUSTER_PATHS) assert.ok(node.includes(`'${t}'`), `node lists ${t}`);
  assert.equal((node.match(/^ {2}'\//gm) || []).length, rules.CLUSTER_PATHS.length, 'and no other');
  const good = [
    '/version',
    '/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/flux-system/kustomizations/apps',
    '/apis/helm.toolkit.fluxcd.io/v2/namespaces/flux-system/helmreleases/1password',
    '/apis/apps/v1/namespaces/tools/deployments/n8n',
    '/apis/apps/v1/namespaces/tools/statefulsets/a-b-c',
    rules.clusterPath('deployment', 'tools', 'a'.repeat(63)),
  ];
  for (const p of good) {
    assert.deepEqual(allowedPath({ cluster_path: p }), { allowed: true, path: p }, p);
    assert.equal(rules.allowedClusterPath(p), true, p);
  }
  const bad = [
    null, '', 42, '/', '/version/', '/versions', '/api/v1/namespaces/tools/secrets/n8n-secrets', '/api/v1/secrets',
    '/apis/apps/v1/namespaces/tools/deployments', '/apis/apps/v1/namespaces/tools/deployments/n8n/scale',
    '/apis/apps/v1/namespaces/tools/deployments/n8n?watch=1', '/apis/apps/v1/namespaces/tools/deployments/N8N',
    '/apis/apps/v1/namespaces/tools/deployments/-n8n', '/apis/apps/v1/namespaces/tools/deployments/n8n.x',
    '/apis/apps/v1/namespaces/tools/deployments/../../../api/v1/secrets', '/apis/apps/v1/namespaces/tools%2fx/deployments/n8n',
    `/apis/apps/v1/namespaces/tools/deployments/${'a'.repeat(64)}`, '/apis/apps/v1/namespaces/tools/daemonsets/x',
    '/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/tools/kustomizations/apps', '/apis/helm.toolkit.fluxcd.io/v2beta1/namespaces/flux-system/helmreleases/x',
    '/apisXkustomize.toolkit.fluxcd.io/v1/namespaces/flux-system/kustomizations/apps', 'https://evil.example/version', '//evil.example/version',
    '/apis/apps/v1/namespaces/tools/deployments/n8n\n', ' /version',
  ];
  for (const p of bad) {
    assert.deepEqual(allowedPath({ cluster_path: p }), { allowed: false, path: null }, String(p));
    assert.equal(rules.allowedClusterPath(p), false, String(p));
  }
});

test('the allowlist: a rejected path reads no token and makes no request', () => {
  // Walk the sub-workflow: Allowed path, then Allowed?, then either branch.
  const run = (json) => {
    const out = { 'When called': [{ json }] };
    out['Allowed path'] = h.code(sub.nodes.find((n) => n.name === 'Allowed path'), out, out['When called'], 0);
    const yes = h.ifResult(sub.nodes.find((n) => n.name === 'Allowed?'), h.scope(out, out['Allowed path'][0].json, 0));
    if (!yes) return { visited: ['Rejected'], result: h.code(sub.nodes.find((n) => n.name === 'Rejected'), out, out['Allowed path'], 0)[0].json };
    const get = sub.nodes.find((n) => n.name === 'GET');
    return { visited: ['Read service-account token', 'Token as text', 'GET'], url: h.param(get.parameters.url, h.scope(out, {}, 0)) };
  };
  assert.deepEqual(run({ cluster_path: '/api/v1/namespaces/tools/secrets/n8n-secrets' }), { visited: ['Rejected'], result: { statusCode: null, rejected: true } });
  assert.deepEqual(run({ cluster_path: null }), { visited: ['Rejected'], result: { statusCode: null, rejected: true } });
  assert.deepEqual(run({}), { visited: ['Read service-account token', 'Token as text', 'GET'], url: 'https://kubernetes.default.svc/version' });
  assert.equal(run({ cluster_path: '/apis/apps/v1/namespaces/tools/deployments/n8n' }).url, 'https://kubernetes.default.svc/apis/apps/v1/namespaces/tools/deployments/n8n');
});

test('the poll calls the sub-workflow once, tolerates its failure, and never reads files itself', () => {
  const call = poll.nodes.find((n) => n.name === 'Cluster version');
  assert.equal(call.type, 'n8n-nodes-base.executeWorkflow');
  assert.equal(call.parameters.workflowId, sub.id);
  assert.equal(call.executeOnce, true);
  assert.equal(call.onError, 'continueRegularOutput');
  assert.ok(!poll.nodes.some((n) => n.type === 'n8n-nodes-base.readWriteFile'), 'the token must not be read in the saved workflow');
  assert.ok(!JSON.stringify(poll).includes('serviceaccount/token'));
});

test('binary data (the token read) lives on a tmpfs mounted only in the main container', () => {
  const dep = fs.readFileSync(path.join(HERE, '..', 'deployment.yaml'), 'utf8');
  const [, afterInit] = dep.split(/^      containers:$/m);
  const [main, volumes] = afterInit.split(/^      volumes:$/m);
  const initPart = dep.split(/^      containers:$/m)[0];
  const env = main.match(/- name: N8N_BINARY_DATA_STORAGE_PATH\n\s+value: "([^"]+)"/);
  assert.ok(env, 'main container sets N8N_BINARY_DATA_STORAGE_PATH');
  const mount = main.match(/- name: binary-data\n\s+mountPath: (\S+)/);
  assert.ok(mount, 'main container mounts binary-data');
  assert.equal(mount[1], env[1]);
  assert.ok(!env[1].startsWith('/home/node/.n8n'), 'not on the n8n-data PVC');
  assert.ok(!/binary-data/.test(initPart), 'initContainers do not mount it');
  assert.match(volumes, /- name: binary-data\n\s+emptyDir:\n\s+medium: Memory\n\s+sizeLimit: 16Mi/);
  // n8n refuses to start if N8N_STORAGE_PATH is also set to a different path.
  assert.ok(!/N8N_STORAGE_PATH/.test(dep));
  assert.ok(!/N8N_STORAGE_PATH/.test(fs.readFileSync(path.join(HERE, '..', 'configmap-env.yaml'), 'utf8')));
});

test('the n8n env allows the token directory in both /var/run and /run forms', () => {
  const env = fs.readFileSync(path.join(HERE, '..', 'configmap-env.yaml'), 'utf8');
  const m = env.match(/N8N_RESTRICT_FILE_ACCESS_TO:\s*"([^"]+)"/);
  assert.ok(m, 'N8N_RESTRICT_FILE_ACCESS_TO is set');
  const paths = m[1].split(';');
  for (const p of ['~/.n8n-files', '/var/run/secrets/kubernetes.io/serviceaccount', '/run/secrets/kubernetes.io/serviceaccount']) {
    assert.ok(paths.includes(p), `missing ${p}`);
  }
});
