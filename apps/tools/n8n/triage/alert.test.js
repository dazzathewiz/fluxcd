'use strict';
// Run with: node --test apps/tools/n8n/triage/
// The dead-man ping: the heartbeat calls the unsaved TriageAlertV01
// sub-workflow, which alone reads the Home Assistant webhook URL.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const h = require('./poll-harness.js');

const N8N = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(N8N, p), 'utf8');
const WORKFLOWS = fs.readdirSync(path.join(N8N, 'workflows')).filter((f) => f.endsWith('.json')).sort();
const wf = (f) => JSON.parse(read(`workflows/${f}`));
const BEAT = wf('triage-heartbeat.json');
const ALERT = wf('triage-alert.json');
const next = (w, name) => (((w.connections[name] || {}).main || [])[0] || []).map((l) => l.node);
const KEYS = ['checked', 'last_success', 'source', 'stale', 'watch_last_success'];
const WATCH_KEYS = ['action', 'checked', 'fix_forward', 'pr', 'prs', 'source', 'status'];
const WATCH = wf('triage-watch.json');

// What Record last success returns: pg hands timestamptz back as Dates.
const ROW = { name: 'triage-poll', last_success: new Date('2026-11-20T01:15:00.123Z'), watch_last_success: new Date('2026-11-20T01:25:00Z'), checked: new Date('2026-11-20T01:30:00Z'), stale: false };

function payload(row) {
  return h.code(h.nodeOf(BEAT, 'Ping payload'), {}, [{ json: JSON.parse(JSON.stringify(row)) }], 0)[0].json;
}

// Evaluates a `={{ ... }}` n8n expression with $json and $(name).
function expr(value, $json, out) {
  const body = value.replace(/^=\{\{([\s\S]*)\}\}$/, '$1');
  const $ = (n) => ({ first: () => ({ json: out[n] }) });
  return vm.runInNewContext(`(${body})`, { $json, $ });
}

test('payload: exactly source, last_success, watch_last_success, stale and checked, in ISO-8601 UTC', () => {
  const p = payload(ROW);
  assert.deepEqual(Object.keys(p).sort(), KEYS);
  assert.deepEqual(p, { source: 'pr-triage', last_success: '2026-11-20T01:15:00.123Z', watch_last_success: '2026-11-20T01:25:00.000Z', stale: false, checked: '2026-11-20T01:30:00.000Z' });
  const none = payload(Object.assign({}, ROW, { last_success: null, watch_last_success: null, stale: true }));
  assert.equal(none.last_success, null);
  assert.equal(none.watch_last_success, null);
  assert.equal(none.stale, true);
  assert.match(none.checked, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});

test('payload: the body TriageAlertV01 sends is the same five keys, with no URL', () => {
  const post = h.nodeOf(ALERT, 'POST');
  const url = 'http://ha.example.test:8123/api/webhook/secret-id';
  const trigger = Object.assign(payload(ROW), { extra: 'dropped', url });
  const body = JSON.parse(expr(post.parameters.jsonBody, {}, { 'When called': trigger }));
  assert.deepEqual(Object.keys(body).sort(), KEYS);
  assert.deepEqual(body, payload(ROW));
  assert.ok(!JSON.stringify(body).includes('webhook'));
  const nulls = JSON.parse(expr(post.parameters.jsonBody, {}, { 'When called': payload(Object.assign({}, ROW, { last_success: null })) }));
  assert.equal(nulls.last_success, null);
  // The URL comes only from Read target's row.
  assert.equal(post.parameters.url, "={{ $json.url || '' }}");
  assert.equal(expr(post.parameters.url, { url }, {}), url);
});

test('payload: a watcher alert is exactly source, pr, prs, status, action, fix_forward and checked', () => {
  const post = h.nodeOf(ALERT, 'POST');
  // What the watcher's Alert node passes: the alert item, with the watch id and anything else.
  const item = { kind: 'alert', watch_id: 9, source: 'pr-watch', pr: 287, prs: [287, 288], status: 'timeout', action: 'investigate', fix_forward: true, checked: '2026-11-21T10:35:00.000Z', repo: 'o/r', url: 'https://x', detail: [{ id: 'deployment tools/n8n' }] };
  const body = JSON.parse(expr(post.parameters.jsonBody, {}, { 'When called': item }));
  assert.deepEqual(Object.keys(body).sort(), WATCH_KEYS);
  assert.deepEqual(body, { source: 'pr-watch', pr: 287, prs: [287, 288], status: 'timeout', action: 'investigate', fix_forward: true, checked: '2026-11-21T10:35:00.000Z' });
  // Nothing else gets through: no ok status, no stray types.
  const odd = JSON.parse(expr(post.parameters.jsonBody, {}, { 'When called': Object.assign({}, item, { status: 'ok', pr: '287', fix_forward: 'yes', action: 'merge', prs: [288, '289', 'https://x'] }) }));
  assert.deepEqual([odd.status, odd.pr, odd.fix_forward, odd.action, odd.prs], [null, null, false, null, [288]]);
  assert.deepEqual(JSON.parse(expr(post.parameters.jsonBody, {}, { 'When called': Object.assign({}, item, { prs: 'x' }) })).prs, []);
  // The watcher's Alert gate passes only failed and timeout, under labels.
  const gate = h.nodeOf(WATCH, 'Alert gate');
  const pass = (mode, wmode, status) => h.ifResult(gate, h.scope({ Watch: [{ json: { mode, watch_write_mode: wmode } }] }, { kind: 'alert', status }, 0));
  assert.equal(pass('labels', 'labels', 'failed'), true);
  assert.equal(pass('labels', 'labels', 'timeout'), true);
  assert.equal(pass('labels', 'labels', 'ok'), false);
  assert.equal(pass('off', 'labels', 'failed'), false);
  assert.equal(pass('off', 'off', 'failed'), false);
});

test('TriageAlertV01 saves no executions and only the heartbeat and the watcher may call it', () => {
  assert.equal(ALERT.id, 'TriageAlertV01');
  const s = ALERT.settings;
  assert.equal(s.saveDataSuccessExecution, 'none');
  assert.equal(s.saveDataErrorExecution, 'none');
  assert.equal(s.saveManualExecutions, false);
  assert.equal(s.saveExecutionProgress, false);
  assert.equal(s.callerPolicy, 'workflowsFromAList');
  assert.equal(String(s.callerIds), `${BEAT.id},${WATCH.id}`);
  const triggers = ALERT.nodes.filter((n) => /trigger$/i.test(n.type) || n.type === 'n8n-nodes-base.webhook');
  assert.deepEqual(triggers.map((n) => n.type), ['n8n-nodes-base.executeWorkflowTrigger']);
  // Only the heartbeat calls it.
  for (const f of WORKFLOWS) {
    for (const n of wf(f).nodes) {
      if (n.type === 'n8n-nodes-base.executeWorkflow' && n.parameters.workflowId === ALERT.id) assert.ok(['triage-heartbeat.json', 'triage-watch.json'].includes(f), `${f} calls ${ALERT.id}`);
    }
  }
});

test('TriageAlertV01: 10 s timeout, one retry, and only the status code goes back', () => {
  const post = h.nodeOf(ALERT, 'POST');
  assert.equal(post.parameters.method, 'POST');
  assert.equal(post.parameters.options.timeout, 10000);
  assert.equal(post.retryOnFail, true);
  assert.equal(post.maxTries, 2);
  assert.equal(post.onError, 'continueRegularOutput');
  assert.deepEqual(post.parameters.options.response.response, { fullResponse: true, neverError: true });
  assert.ok(!post.credentials && !post.parameters.authentication && !post.parameters.sendQuery && !post.parameters.sendHeaders);
  assert.deepEqual(next(ALERT, 'When called'), ['Read target']);
  assert.deepEqual(next(ALERT, 'Read target'), ['POST']);
  assert.deepEqual(next(ALERT, 'POST'), ['Result']);
  const result = (json) => h.code(h.nodeOf(ALERT, 'Result'), {}, [{ json }], 0);
  assert.deepEqual(result({ statusCode: 200, body: { echo: 'x' }, headers: { a: 'b' } }), [{ json: { status: 200 } }]);
  assert.deepEqual(result({ statusCode: 404, body: 'nope' }), [{ json: { status: 404 } }]);
  assert.deepEqual(result({ error: { message: 'connect ETIMEDOUT http://ha.example.test:8123/api/webhook/x' } }), [{ json: { status: null } }]);
});

test('only TriageAlertV01 reads the webhook URL', () => {
  for (const f of WORKFLOWS) {
    const text = read(`workflows/${f}`);
    if (f === 'triage-alert.json') {
      assert.equal((text.match(/alert_target/g) || []).length, 1);
    } else {
      assert.ok(!/alert_target/.test(text), `${f} reads triage.alert_target`);
    }
  }
  assert.ok(!/alert_target|HA_HEARTBEAT/.test(read('triage/rules.js')));
  assert.ok(!/alert_target|HA_HEARTBEAT/.test(read('triage/config.yaml')));
});

test('no workflow, credential or config holds a webhook path or the Home Assistant address', () => {
  // The address is a SOPS var, substituted by Flux; the repo holds no literal.
  const pol = read('networkpolicy.yaml');
  assert.match(pol, /# Home Assistant[^\n]*\n\s+- to:\n\s+- ipBlock:\n\s+cidr: \$\{HOST_HOMEASSISTANT\}\/32\n\s+ports:\n\s+- protocol: TCP\n\s+port: 8123\n/, 'one /32 egress rule on TCP 8123');
  assert.equal((pol.match(/HOST_HOMEASSISTANT/g) || []).length, 1);
  const files = [].concat(
    WORKFLOWS.map((f) => `workflows/${f}`),
    fs.readdirSync(path.join(N8N, 'credentials')).map((f) => `credentials/${f}`),
    ['triage/config.yaml', 'triage/rules.js', 'triage/schema.sql', 'triage/seed.sql', 'triage/roles.sql', 'configmap-env.yaml', 'externalsecret.yaml', 'deployment.yaml'],
  );
  for (const f of files) {
    const text = read(f);
    assert.ok(!/api\/webhook/i.test(text), `${f} names a webhook path`);
    assert.ok(!/HOST_HOMEASSISTANT/.test(text), `${f} names the Home Assistant address`);
    assert.ok(!/:8123\b/.test(text), `${f} names the Home Assistant port`);
  }
});

test('heartbeat: no disabled node, and it pings on every run', () => {
  for (const n of BEAT.nodes) assert.ok(n.disabled !== true, `"${n.name}" is disabled`);
  assert.ok(!BEAT.nodes.some((n) => n.name === 'Alert Home Assistant (P2)'));
  assert.ok(!BEAT.nodes.some((n) => n.type === 'n8n-nodes-base.httpRequest'), 'the heartbeat makes no request itself');
  // Retention (retention.test.js) is a second branch, run after this one.
  assert.deepEqual(next(BEAT, 'Every 30 minutes'), ['Record last success', 'Retention']);
  assert.deepEqual(next(BEAT, 'Record last success'), ['Ping payload']);
  assert.deepEqual(next(BEAT, 'Ping payload'), ['Ping Home Assistant']);
  assert.deepEqual(next(BEAT, 'Ping Home Assistant'), ['Record ping']);
  assert.deepEqual(next(BEAT, 'Record ping'), ['Ping ok?']);
  const call = h.nodeOf(BEAT, 'Ping Home Assistant');
  assert.equal(call.parameters.workflowId, ALERT.id);
  assert.equal(call.parameters.mode, 'once');
  assert.equal(call.parameters.options.waitForSubWorkflow, true);
  // Not ok fails this execution; ok ends it.
  const gate = BEAT.connections['Ping ok?'].main;
  assert.deepEqual(gate[0], []);
  assert.deepEqual(gate[1].map((l) => l.node), ['Ping failed']);
  assert.equal(h.nodeOf(BEAT, 'Ping failed').type, 'n8n-nodes-base.stopAndError');
  const ok = (s) => expr(h.nodeOf(BEAT, 'Ping ok?').parameters.conditions.conditions[0].leftValue, { ping_status: s }, {});
  assert.deepEqual([200, 204, 299, 300, 404, 500, null].map(ok), [true, true, true, false, false, false, false]);
});

test('heartbeat: Record ping writes last_ping and the status, NULL on a network error, and nothing else', () => {
  const rec = h.nodeOf(BEAT, 'Record ping');
  const q = rec.parameters.query;
  assert.match(q, /^UPDATE triage\.heartbeat\nSET last_ping = now\(\), ping_status = NULLIF\(\$1::integer, 0\)\nWHERE name = 'triage-poll'/);
  const args = (status) => JSON.parse(JSON.stringify(expr(rec.parameters.options.queryReplacement, { status }, {})));
  assert.deepEqual(args(200), [200]);
  assert.deepEqual(args(null), [0]);
  assert.deepEqual(args(undefined), [0]);
  // The heartbeat never writes the runs table itself (Retention calls triage.prune_runs()).
  for (const n of BEAT.nodes) {
    if (n.type === 'n8n-nodes-base.postgres') assert.ok(!/(INSERT INTO|UPDATE|DELETE FROM)\s+triage\.runs/i.test(n.parameters.query), n.name);
  }
});

test('wiring: the Secret, the seed, the role, the initContainers and the ConfigMap', () => {
  const es = read('externalsecret.yaml');
  assert.match(es, /HA_HEARTBEAT_URL: '\{\{ \.HA_HEARTBEAT_URL \}\}'/);
  assert.match(es, /- secretKey: HA_HEARTBEAT_URL\n\s+remoteRef:\n\s+key: n8n\n\s+property: ha-heartbeat-url/);
  const seed = read('triage/seed.sql');
  assert.match(seed, /\\getenv ha_url HA_HEARTBEAT_URL/);
  assert.match(seed, /DELETE FROM triage\.alert_target;/);
  assert.match(seed, /SELECT count\(\*\) AS alert_targets FROM triage\.alert_target;/);
  assert.ok(!/SELECT[^;]*\burl\b[^;]*FROM triage\.alert_target/.test(seed), 'the seed never prints the URL');
  const schema = read('triage/schema.sql');
  assert.match(schema, /ALTER TABLE triage\.heartbeat ADD COLUMN IF NOT EXISTS last_ping timestamptz, ADD COLUMN IF NOT EXISTS ping_status integer;/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS triage\.alert_target/);
  const roles = read('triage/roles.sql');
  assert.match(roles, /^GRANT SELECT ON triage\.alert_target TO triage;$/m);
  assert.match(roles, /^GRANT SELECT, INSERT, UPDATE ON triage\.heartbeat TO triage;$/m);
  const dep = read('deployment.yaml');
  const [init, rest] = dep.split(/^ {6}- name: import-workflows$/m);
  assert.match(init, /- name: HA_HEARTBEAT_URL\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: n8n-secrets\n\s+key: HA_HEARTBEAT_URL\n\s+optional: true/);
  assert.match(rest, /n8n publish:workflow --id=TriageAlertV01\n/);
  assert.match(read('kustomization.yaml'), /- workflows\/triage-alert\.json/);
  assert.match(read('configmap-env.yaml'), /N8N_BLOCK_ENV_ACCESS_IN_NODE: "true"/);
});
