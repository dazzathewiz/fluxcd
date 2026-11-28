'use strict';
// Run with: node --test apps/tools/n8n/triage/
// Rules drift end to end: the poll workflow from Git, run by poll-harness.js.
// A PR that changes renovate.json or config.yaml gets a drift line in its
// comment; the live check of renovate.json on the default branch alerts Home
// Assistant once per drifting blob. Neither changes a verdict.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./poll-harness.js');

const N8N = path.join(__dirname, '..');
const REPO_ROOT = path.resolve(N8N, '../../..');
const read = (p) => fs.readFileSync(path.join(N8N, p), 'utf8');
const node = (name) => h.nodeOf(h.POLL, name);
const squash = (s) => String(s).replace(/\s+/g, ' ');
const REPO = 'dazzathewiz/fluxcd';
const API = `https://api.github.com/repos/${REPO}`;
const CONFIG_TEXT = read('triage/config.yaml').replace(/^write_mode: .*$/m, 'write_mode: "off"');
const RENOVATE_TEXT = fs.readFileSync(path.join(REPO_ROOT, 'renovate.json'), 'utf8');
const DRIFTING = (() => {
  const d = JSON.parse(RENOVATE_TEXT);
  d.packageRules.push({ matchPackageNames: ['grafana/grafana'], dependencyDashboardApproval: true });
  return JSON.stringify(d, null, 2);
})();
const PATTERNS = ['/example-private-term/'];
const HEAD1 = '1'.repeat(40);
const HEAD2 = '2'.repeat(40);
const BLOB = (n) => String(n).repeat(40);
const b64 = (t) => Buffer.from(t, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n');

// GitHub, read-only (write_mode off): PR 1 changes renovate.json, PR 2 doesn't.
// main serves `state.main` ({blob, text}) with ETag "e<blob>", or fails.
function fakeGithub(state) {
  const pr = (number, sha, ref) => ({
    number, url: `${API}/pulls/${number}`, issue_url: `${API}/issues/${number}`, html_url: `https://github.com/${REPO}/pull/${number}`,
    state: 'open', draft: false, title: `change ${number}`, body: '', created_at: `2026-11-2${number}T00:00:00Z`,
    user: { login: 'someone' }, head: { sha, ref }, base: { repo: { full_name: REPO, url: API } }, labels: [], mergeable: true, mergeable_state: 'clean',
  });
  const prs = { 1: pr(1, HEAD1, 'feat/rules'), 2: pr(2, HEAD2, 'feat/other') };
  const files = {
    1: [{ filename: 'renovate.json', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-{\n+{ ' }],
    2: [{ filename: 'apps/tools/x.yaml', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a: 1\n+a: 2' }],
  };
  const contents = [];
  const github = (method, url, body, headers) => {
    assert.equal(method, 'GET', 'write_mode off writes nothing');
    const p = new URL(url).pathname.replace(`/repos/${REPO}`, '');
    if (url === 'https://api.github.com/rate_limit') return { statusCode: 200, headers: {}, body: {} };
    if (p === '/contents/renovate.json') {
      contents.push(headers['If-None-Match']);
      const m = state.main;
      if (!m) return { statusCode: 502, headers: {}, body: {} };
      const etag = `"e${m.blob}"`;
      if (headers['If-None-Match'] === etag) return { statusCode: 304, headers: { etag }, body: '' };
      return { statusCode: 200, headers: { etag }, body: { sha: BLOB(m.blob), encoding: 'base64', content: b64(m.text) } };
    }
    if (p === '/issues' || p === '/labels') return { statusCode: 200, headers: {}, body: [] };
    if (p === '/pulls') return { statusCode: 200, headers: { etag: '"l"' }, body: Object.values(prs) };
    let m;
    if ((m = p.match(/^\/pulls\/(\d+)(\/files)?$/))) return { statusCode: 200, headers: {}, body: m[2] ? files[m[1]] : prs[m[1]] };
    if ((m = p.match(/^\/issues\/(\d+)\/(events|comments)$/))) return { statusCode: 200, headers: {}, body: [] };
    return { statusCode: 404, headers: {}, body: {} };
  };
  return { github, contents };
}

// raw.githubusercontent.com at PR 1's head: the drifting renovate.json.
const external = async (o) => {
  if (o.url === `https://raw.githubusercontent.com/${REPO}/${HEAD1}/renovate.json`) return { statusCode: 200, headers: {}, body: DRIFTING };
  if (o.url === `https://raw.githubusercontent.com/${REPO}/${HEAD1}/apps/tools/n8n/triage/config.yaml`) return { statusCode: 200, headers: {}, body: CONFIG_TEXT };
  return { statusCode: 404, headers: {}, body: '' };
};

const commentOf = (r, pr) => {
  const plan = r.plans.find((p) => p.pr === pr);
  const a = plan.actions.find((x) => x.type === 'create_comment' || x.type === 'edit_comment');
  return { plan, body: a ? a.body : null };
};

function poll(db, state, extra) {
  const gh = fakeGithub(state);
  return h.runPoll(Object.assign({ db, github: gh.github, repo: REPO, ruleset: 'r1.c1', config: CONFIG_TEXT, config_sha: 'c1', patterns: PATTERNS, external }, extra || {}))
    .then((r) => Object.assign(r, { contents: gh.contents }));
}

test('poll: a PR that changes renovate.json gets one drift line; other PRs and both verdicts are unchanged', async () => {
  const db = h.newDb();
  const r = await poll(db, { main: { blob: 1, text: RENOVATE_TEXT } });
  const one = commentOf(r, 1);
  const two = commentOf(r, 2);
  assert.equal(one.plan.verdict, 'human');
  assert.equal(two.plan.verdict, 'human');
  assert.match(one.body, /\nRules drift: 1 item\(s\) — `gated grafana\/grafana@\*:\*`\n/);
  assert.ok(!/Rules drift/.test(two.body), 'a PR that touches neither file gets no line');
  // Same verdict, reasons and labels with or without the line.
  assert.deepEqual(one.plan.status, two.plan.status);
  assert.equal(one.body.split('\n').filter((l) => /Rules drift/.test(l)).length, 1);
});

test('poll: the live check reads renovate.json on main, records the result, and says nothing while it agrees', async () => {
  const db = h.newDb();
  const state = { main: { blob: 1, text: RENOVATE_TEXT } };
  const r1 = await poll(db, state);
  assert.deepEqual(r1.contents, ['"none"'], 'the first read is unconditional');
  assert.deepEqual(r1.run.drift, { sha: BLOB(1), drift: false, items: 0, keys: [], fresh: true });
  assert.deepEqual(r1.alerts, []);
  const row = db.heartbeat['rules-drift'];
  assert.equal(row.detail.sha, BLOB(1));
  assert.equal(row.detail.drift, false);
  assert.ok(row.last_success);
  // Next run: conditional, 304, nothing new.
  const r2 = await poll(db, state);
  assert.deepEqual(r2.contents, ['"e1"']);
  assert.deepEqual(r2.run.drift, { sha: BLOB(1), drift: false, items: 0, keys: [], fresh: false });
  assert.deepEqual(r2.alerts, []);
  // A new loaded config: the ETag isn't sent, so the file is compared again.
  const r3 = await poll(db, state, { config_sha: 'c2' });
  assert.deepEqual(r3.contents, ['"none"']);
  assert.equal(r3.run.drift.fresh, true);
});

test('poll: a drifting blob alerts once; a failed alert is sent again; a clean blob sends one recovery', async () => {
  const db = h.newDb();
  const state = { main: { blob: 1, text: RENOVATE_TEXT } };
  await poll(db, state);
  state.main = { blob: 2, text: DRIFTING };
  let status = 500;
  const alert = () => status;
  const r1 = await poll(db, state, { alert });
  assert.deepEqual(r1.alerts.map((a) => a.payload), [{ source: 'rules-drift', drift: true, items: 1, keys: ['gated grafana/grafana@*:*'], sha: '2222222', checked: r1.alerts[0].payload.checked }]);
  assert.equal(db.heartbeat['rules-drift'].detail.alerted, null, 'not recorded without a 2xx');
  status = 200;
  const r2 = await poll(db, state, { alert });
  assert.equal(r2.alerts.length, 1, 'sent again from the 304');
  assert.deepEqual(db.heartbeat['rules-drift'].detail.alerted, { key: `${BLOB(2)}.c1`, drift: true });
  const r3 = await poll(db, state, { alert });
  assert.deepEqual(r3.alerts, [], 'same blob: no second alert');
  assert.deepEqual(r3.run.drift, { sha: BLOB(2), drift: true, items: 1, keys: ['gated grafana/grafana@*:*'], fresh: false });
  state.main = { blob: 3, text: RENOVATE_TEXT };
  const r4 = await poll(db, state, { alert });
  assert.deepEqual(r4.alerts.map((a) => [a.payload.drift, a.payload.items, a.payload.keys, a.payload.sha]), [[false, 0, [], '3333333']]);
  const r5 = await poll(db, state, { alert });
  assert.deepEqual(r5.alerts, []);
});

test('poll: a failed read of main records drift null, never alerts, and reads unconditionally next time', async () => {
  const db = h.newDb();
  const state = { main: { blob: 2, text: DRIFTING } };
  await poll(db, state);
  assert.deepEqual(db.heartbeat['rules-drift'].detail.alerted, { key: `${BLOB(2)}.c1`, drift: true });
  const last = db.heartbeat['rules-drift'].last_success;
  state.main = null;
  const r = await poll(db, state);
  assert.deepEqual(r.run.drift, { sha: BLOB(2), drift: null, items: null, keys: [], fresh: false });
  assert.deepEqual(r.alerts, []);
  assert.equal(r.run.ok, true, 'a failed read never fails the run');
  assert.equal(db.heartbeat['rules-drift'].last_success, last);
  assert.equal(db.heartbeat['rules-drift'].detail.drift, null);
  // Back: same blob, same config, already alerted: no second alert.
  state.main = { blob: 2, text: DRIFTING };
  const back = await poll(db, state);
  assert.deepEqual(back.contents, ['"none"']);
  assert.equal(back.run.drift.drift, true);
  assert.deepEqual(back.alerts, []);
});

test('poll SQL: Start run reads the rules-drift row, Finish run stores the run\'s result, the branch writes only that row', () => {
  const start = squash(node('Start run').parameters.query);
  assert.match(start, /\(SELECT detail FROM triage\.heartbeat WHERE name = 'rules-drift'\) AS rules_drift,/);
  assert.match(start, /detail ->> 'config_sha' = cfg\.sha256 AND detail ->> 'drift' IN \('true', 'false'\)\) AS rules_drift_etag/);
  assert.match(squash(node('Finish run').parameters.query), /drift = NULLIF\(\$7::jsonb, 'null'::jsonb\)/);
  const rec = squash(node('Record rules drift').parameters.query);
  assert.match(rec, /^-- .* INSERT INTO triage\.heartbeat AS h \(name, last_success, checked, detail\) VALUES \('rules-drift',/);
  const sent = squash(node('Record drift alert').parameters.query);
  assert.match(sent, /UPDATE triage\.heartbeat SET detail = jsonb_set\(detail, '\{alerted\}', \$1::jsonb\) WHERE name = 'rules-drift' AND \$2::integer BETWEEN 200 AND 299/);
  // The read: one GET of renovate.json's contents, with the bot credential.
  const get = node('Get renovate.json');
  assert.equal(get.parameters.method, 'GET');
  assert.equal(get.parameters.url, "=https://api.github.com/repos/{{ $('Start run').item.json.repo }}/contents/renovate.json");
  assert.deepEqual(Object.keys(get.credentials), ['githubApi']);
  assert.deepEqual(get.parameters.options.response.response, { fullResponse: true, neverError: true });
  assert.deepEqual(h.POLL.connections['Repo labels'].main, [[{ node: 'Get renovate.json', type: 'main', index: 0 }]]);
  // The alert: TriageAlertV01 once, and its failure never fails the poll.
  const a = node('Alert rules drift');
  assert.deepEqual([a.parameters.workflowId, a.parameters.mode, a.onError], ['TriageAlertV01', 'once', 'continueRegularOutput']);
  // Above Run summary only, so Finish run still runs last.
  assert.ok(node('Rules drift only').position[1] < node('Run summary only').position[1]);
});

test('schema: the two drift columns are additive and idempotent; no new grant', () => {
  const schema = read('triage/schema.sql');
  assert.match(schema, /\nALTER TABLE triage\.runs ADD COLUMN IF NOT EXISTS drift jsonb;\n/);
  assert.match(schema, /\nALTER TABLE triage\.heartbeat ADD COLUMN IF NOT EXISTS detail jsonb;\n/);
  const roles = read('triage/roles.sql');
  assert.match(roles, /GRANT SELECT, INSERT, UPDATE ON triage\.heartbeat TO triage;/);
  assert.match(roles, /GRANT SELECT, INSERT, UPDATE ON triage\.runs TO triage;/);
});

test('heartbeat: Record last success returns the rules-drift row\'s result as a boolean or null', () => {
  const beat = JSON.parse(read('workflows/triage-heartbeat.json'));
  const q = squash(h.nodeOf(beat, 'Record last success').parameters.query);
  assert.match(q, /\(SELECT \(detail ->> 'drift'\)::boolean FROM triage\.heartbeat WHERE name = 'rules-drift'\) AS rules_drift,/);
});
