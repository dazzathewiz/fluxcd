'use strict';
// Run with: node --test apps/tools/n8n/triage/
// write_mode digest: the rendered body, the publish decisions, the poll
// workflow's digest nodes against a stubbed GitHub, and the write allowlist.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rules = require('./rules.js');
const { checkWrites } = require('./sync-code-nodes.js');

const N8N = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(N8N, p), 'utf8');
const CONFIG_TEXT = read('triage/config.yaml');
const CONFIG = rules.loadConfig(CONFIG_TEXT);
const POLL = JSON.parse(read('workflows/triage-poll.json'));
const node = (name) => POLL.nodes.find((n) => n.name === name);
const REPO = 'dazzathewiz/fluxcd';
const LOGIN = 'triage-bot';
const PATTERNS = ['/example-private-term/'];

const sha = (n) => String(n).repeat(40).slice(0, 40);
const pr = (number, extra) => Object.assign({
  number, title: `chore(deps): update thing to v1.${number}`, head_sha: sha(number % 10), created_at: `2026-11-${10 + (number % 10)}T03:00:00Z`, draft: false, user_login: 'renovate[bot]',
}, extra || {});
const key = (p) => `${REPO}#${p.number}@${p.head_sha}`;
const verdictsFor = (list) => Object.fromEntries(list.map(([p, verdict, reasons, finalised]) => [key(p), { verdict, reasons: reasons || [], finalised: !!finalised }]));

// ------------------------------------------------------------ rendering

test('render: same inputs give a byte-identical body, marker first', () => {
  const prs = [pr(266), pr(276), pr(278)];
  const v = verdictsFor(prs.map((p) => [p, 'review', ['floor review: n8nio/n8n is never low-risk']]));
  const a = rules.renderDigest(REPO, prs, v, CONFIG);
  const b = rules.renderDigest(REPO, JSON.parse(JSON.stringify(prs)).reverse(), JSON.parse(JSON.stringify(v)), CONFIG);
  assert.equal(a, b);
  assert.ok(a.startsWith(`${rules.DIGEST_MARKER}\n\n${rules.DIGEST_HEADER}\n\n`));
  assert.ok(!/\d{2}:\d{2}|run|ruleset/i.test(a.replace(rules.DIGEST_HEADER, '')), 'no timestamps, run IDs or rulesets');
  assert.match(a, /opened 2026-11-16/, 'a date, never an age');
});

test('render: section order, oldest first, empty sections omitted', () => {
  const p = [pr(271), pr(272), pr(273), pr(274), pr(275, { user_login: 'someone' }), pr(270)];
  const v = verdictsFor([
    [p[0], 'low-risk', ['all low-risk conditions hold']],
    [p[1], 'review', ['R6 release-note keywords: breaking']],
    [p[2], 'deep-review', ['deep-review package: postgres']],
    [p[3], 'blocked', ['R5 fail']],
    [p[4], 'human', ['not a Renovate PR: triaged by hand', 'R9 not run: left unfinalised']],
    [p[5], 'review', ['low-risk conditions not all met']],
  ]);
  const body = rules.renderDigest(REPO, p, v, CONFIG);
  const headings = body.split('\n').filter((l) => l.startsWith('## '));
  assert.deepEqual(headings, ['## blocked', '## deep-review', '## review', '## low-risk', '## human (unfinalised)']);
  const review = body.slice(body.indexOf('## review'), body.indexOf('## low-risk'));
  assert.ok(review.indexOf('#270 ') < review.indexOf('#272 '), 'oldest first');
  assert.match(body, /- #275 \(title not shown: not a Renovate PR\)/);
  const onlyReview = rules.renderDigest(REPO, [p[1]], v, CONFIG);
  assert.deepEqual(onlyReview.split('\n').filter((l) => l.startsWith('## ')), ['## review']);
});

test('render: empty state is one line', () => {
  const body = rules.renderDigest(REPO, [], {}, CONFIG);
  assert.equal(body, `${rules.DIGEST_MARKER}\n\n${rules.DIGEST_HEADER}\n\nNo open PRs to triage.`);
  // Drafts and finalised human verdicts aren't listed.
  const human = pr(280, { user_login: 'someone' });
  assert.equal(rules.renderDigest(REPO, [pr(281, { draft: true }), human], verdictsFor([[human, 'human', [], true]]), CONFIG), body);
});

test('render: the merge line appears only on low-risk, with the merge method and head check', () => {
  const p = [pr(290), pr(291), pr(292)];
  const body = rules.renderDigest(REPO, p, verdictsFor([[p[0], 'low-risk'], [p[1], 'review'], [p[2], 'deep-review']]), CONFIG);
  const merges = body.split('\n').filter((l) => l.includes('gh pr merge'));
  assert.deepEqual(merges, [`  - \`gh pr merge 290 --merge --admin --match-head-commit ${p[0].head_sha}\``]);
});

test('render: a dependant comes out with its check text, from the config', () => {
  const p = pr(278, { title: 'chore(deps): update inventree/inventree docker tag to v1.7.3' });
  const stored = `dependant intake-script (off-repo operator workspace): ${CONFIG.dependants['inventree/inventree'][0].check}`;
  const body = rules.renderDigest(REPO, [p], verdictsFor([[p, 'review', ['floor review: dependant intake-script of inventree/inventree', stored]]]), CONFIG);
  assert.ok(body.includes(`  - dependant intake-script (off-repo operator workspace): ${CONFIG.dependants['inventree/inventree'][0].check}`));
  assert.ok(body.includes('  - floor review: dependant intake-script of inventree/inventree'));
});

test('render: reasons go through fixed templates; titles go in a code span', () => {
  const p = pr(293, { title: 'chore: ping @someone about #12 `x`' });
  const body = rules.renderDigest(REPO, [p], verdictsFor([[p, 'review', ['free text from somewhere', 'R6 release-note keywords: not-a-keyword', 'required checks not run: R4, R8']]]), CONFIG);
  assert.equal((body.match(/other reason \(see triage\.verdicts\)/g) || []).length, 2);
  assert.ok(body.includes('  - required checks not run: R4, R8'));
  assert.ok(body.includes("`chore: ping @someone about #12 'x'`"));
});

// ------------------------------------------------------------ planDigest

function reads(prs, issues, user) {
  return {
    prs: { statusCode: 200, body: prs.map((p) => ({ number: p.number, title: p.title, head: { sha: p.head_sha }, created_at: p.created_at, draft: p.draft, user: { login: p.user_login } })) },
    user: user || { statusCode: 200, body: { login: LOGIN } },
    issues: { statusCode: 200, body: issues || [] },
  };
}
const planInput = (extra) => Object.assign({ repo: REPO, config: CONFIG, healthy: true, patterns: PATTERNS, reads: reads([pr(266)]), verdicts: verdictsFor([[pr(266), 'review']]), stored: null }, extra);

test('plan: a redaction hit blocks publish and records only a count', () => {
  const p = pr(266, { title: 'chore(deps): update example-private-term to v2' });
  const plan = rules.planDigest(planInput({ reads: reads([p]), verdicts: verdictsFor([[p, 'review']]) }));
  assert.deepEqual(plan, { repo: REPO, action: 'skip', digest: 'redaction-hit', ok: false, matched_patterns: 1 });
  assert.ok(!JSON.stringify(plan).includes('example-private-term'));
});

test('plan: no patterns loaded, or a bad one, is unhealthy', () => {
  assert.equal(rules.planDigest(planInput({ patterns: [] })).digest, 'skipped-unhealthy');
  assert.equal(rules.planDigest(planInput({ patterns: ['/(/'] })).digest, 'skipped-unhealthy');
});

test('plan: a failed digest read fails the digest, not the run', () => {
  const r = reads([pr(266)]);
  r.user = { statusCode: 401, body: {} };
  const plan = rules.planDigest(planInput({ reads: r }));
  assert.deepEqual([plan.action, plan.digest, plan.ok], ['skip', 'failed', false]);
});

test('plan: only issues the token opened can carry the marker', () => {
  const body = `${rules.DIGEST_MARKER}\n\nsomeone else's`;
  const plan = rules.planDigest(planInput({ reads: reads([pr(266)], [{ number: 5, state: 'open', body, user: { login: 'someone' } }]) }));
  assert.equal(plan.action, 'create');
});

// ------------------------------------------------------------ the workflow, GitHub stubbed

// Evaluates an n8n parameter: "=..." with {{ }} parts, or a plain value.
function param(value, scope) {
  if (typeof value !== 'string' || !value.startsWith('=')) return value;
  const text = value.slice(1);
  const run = (expr) => vm.runInNewContext(`(${expr})`, Object.assign({ Number, JSON, String, encodeURIComponent }, scope));
  const whole = text.match(/^\{\{([\s\S]*)\}\}$/);
  if (whole && !whole[1].includes('{{')) return run(whole[1]);
  return text.replace(/\{\{([\s\S]*?)\}\}/g, (m, e) => String(run(e)));
}

function ifResult(n, scope) {
  const c = n.parameters.conditions.conditions[0];
  const left = param(c.leftValue, scope);
  if (c.operator.operation === 'equals') return left === c.rightValue;
  if (c.operator.operation === 'notEquals') return left !== c.rightValue;
  throw new Error(`operator ${c.operator.operation}`);
}

// A GitHub with one repo's PRs and issues. Records every request.
function stubGithub(state) {
  const requests = [];
  const base = `https://api.github.com/repos/${REPO}`;
  const github = (method, url, body) => {
    requests.push({ method, url, body });
    if (url === 'https://api.github.com/user') return { statusCode: 200, headers: {}, body: { login: LOGIN } };
    if (url === 'https://api.github.com/rate_limit') return { statusCode: 200, headers: {}, body: { resources: {} } };
    if (url.startsWith(`${base}/pulls?state=open`)) {
      return { statusCode: 200, headers: {}, body: state.prs.map((p) => ({ number: p.number, title: p.title, head: { sha: p.head_sha }, created_at: p.created_at, draft: p.draft, user: { login: p.user_login } })) };
    }
    if (url.startsWith(`${base}/issues?state=all&creator=${encodeURIComponent(LOGIN)}&`)) return { statusCode: 200, headers: {}, body: state.issues };
    const one = url.match(/\/issues\/(\d+)$/);
    if (method === 'POST' && url === `${base}/issues`) {
      if (state.failWrite) return { statusCode: 500, headers: {}, body: {} };
      const issue = { number: 900 + state.issues.length, state: 'open', title: body.title, body: body.body, user: { login: LOGIN } };
      state.issues.push(issue);
      return { statusCode: 201, headers: {}, body: issue };
    }
    if (one) {
      const issue = state.issues.find((i) => i.number === Number(one[1]));
      if (!issue) return { statusCode: 404, headers: {}, body: {} };
      if (method === 'PATCH') {
        if (state.failWrite) return { statusCode: 500, headers: {}, body: {} };
        Object.assign(issue, body);
      }
      const copy = Object.assign({}, issue);
      if (method === 'GET' && state.mangleReadback) copy.body = `${copy.body}\n`;
      return { statusCode: 200, headers: {}, body: copy };
    }
    return { statusCode: 404, headers: {}, body: {} };
  };
  return { github, requests };
}

const CADDY = JSON.parse(read('triage/fixtures/caddy-patch.json'));

// One poll run: the reads before Triage, the real Triage code, then every node
// after the Write gate, walked from the workflow's own connections. The
// database is the `db` object: what Start run would read and Record digest
// would write. Record digest's SQL is modelled by digestReadback.
async function runPoll(opts) {
  const db = opts.db;
  const { github, requests } = stubGithub(opts.github);
  const triagePR = opts.triage ? CADDY.facts : null;
  const startRun = {
    run_id: db.runs.length + 1, ruleset: opts.ruleset || 'r1.c1', repo: REPO, list_etag: null, config_body: opts.config || CONFIG_TEXT, config_sha: 'sha',
    patterns: PATTERNS, seen: opts.seen || [], previous: {}, current_verdicts: db.current, digest_issue: db.digest ? db.digest.issue_number : null, digest_sha: db.digest ? db.digest.body_sha256 : null,
  };
  const out = { 'Start run': [{ json: startRun }] };
  const scopeFor = (current) => ({ $json: current, $: (n) => ({ item: { json: out[n][out[n].length - 1].json }, first: () => out[n][0], all: () => out[n] }) });
  const get = (name, current) => {
    const url = param(node(name).parameters.url, scopeFor(current));
    out[name] = [{ json: github('GET', url) }];
    return out[name][0].json;
  };
  out['Get dashboard'] = [{ json: { statusCode: 200, headers: {}, body: [{ title: 'Dependency Dashboard', html_url: CADDY.facts.dashboard.url, body: CADDY.facts.dashboard.body, updated_at: 'x' }] } }];
  get('Open PRs', startRun);
  const me = get('Who am I', out['Open PRs'][0].json);
  get('Digest issues', me);
  if (triagePR) {
    const f = triagePR;
    const prBody = {
      number: f.pr.number, html_url: f.pr.html_url, url: `https://api.github.com/repos/${REPO}/pulls/${f.pr.number}`,
      head: { sha: f.pr.head_sha, ref: f.pr.head_ref }, base: { repo: { full_name: REPO } }, user: { login: f.pr.user_login }, title: f.pr.title, body: f.pr.body,
      created_at: f.pr.created_at, mergeable: f.pr.mergeable, mergeable_state: f.pr.mergeable_state, draft: false,
    };
    out['List PRs'] = [{ json: { statusCode: 200, headers: { etag: '"l"' }, body: [{ number: f.pr.number, head: { sha: f.pr.head_sha }, created_at: f.pr.created_at, draft: false }] } }];
    out['Get PR'] = [{ json: { statusCode: 200, headers: { etag: f.pr.etag }, body: prBody } }];
    out['Get files'] = [{ json: { statusCode: 200, headers: { etag: f.files.etag }, body: f.files.items } }];
  } else {
    out['List PRs'] = [{ json: { statusCode: 304, headers: {} } }];
    out['Get PR'] = [{ json: { statusCode: 200, headers: {}, body: { resources: {} } } }];
    out['Get files'] = [{ json: { statusCode: 200, headers: {}, body: { resources: {} } } }];
  }
  out['Cluster version'] = [{ json: opts.cluster || { statusCode: 200, headers: {}, body: { gitVersion: 'v1.34.12+k3s1', gitCommit: 'c' } } }];
  const ctx = vm.createContext({
    helpers: { httpRequest: async (o) => CADDY.http[o.url] || { statusCode: 404, headers: {}, body: '' } },
    $input: { first: () => out['Cluster version'][0], all: () => out['Cluster version'] },
    $: (n) => ({ first: () => out[n][0], all: () => out[n] }),
  });
  const items = await vm.runInContext(`module = { exports: {} }; module.exports = async function VmCodeWrapper() {${node('Triage').parameters.jsCode}\n}()`, ctx);
  const runItem = JSON.parse(JSON.stringify(items[0].json));
  out.Triage = [{ json: runItem }];
  for (const v of runItem.verdicts) db.current[`${v.repo}#${v.pr}@${v.head_sha}`] = { verdict: v.verdict, reasons: v.reasons, finalised: v.finalise };
  const run = { id: runItem.run_id, ok: runItem.ok, digest: runItem.write_mode === 'digest' ? null : 'off' };
  db.runs.push(run);

  const gateOpen = ifResult(node('Write gate'), scopeFor({}));
  assert.equal(gateOpen, runItem.write_mode === 'digest');
  const before = requests.length;
  if (gateOpen) {
    const plans = vm.runInNewContext(`(function () {${node('Digest plan').parameters.jsCode}})()`, { $: (n) => ({ first: () => out[n][0] }) });
    for (const p of plans) {
      out['Digest plan'] = [{ json: p.json }];
      let current = p.json;
      let at = POLL.connections['Digest plan'].main[0][0].node;
      while (at) {
        const n = node(at);
        let branch = 0;
        if (n.type === 'n8n-nodes-base.if') {
          branch = ifResult(n, scopeFor(current)) ? 0 : 1;
        } else if (n.type === 'n8n-nodes-base.httpRequest') {
          const s = scopeFor(current);
          const method = n.parameters.method;
          const url = param(n.parameters.url, s);
          const body = n.parameters.jsonBody ? JSON.parse(param(n.parameters.jsonBody, s)) : undefined;
          current = github(method, url, body);
          out[at] = [{ json: current }];
        } else if (n.type === 'n8n-nodes-base.postgres') {
          const [runId, repo, issueNumber, outcome, readBody, bodySha] = param(n.parameters.options.queryReplacement, scopeFor(current));
          assert.equal(runId, run.id);
          assert.equal(repo, REPO);
          const status = outcome !== '' ? outcome : rules.digestReadback({ body_sha256: bodySha }, { statusCode: 200, body: { body: readBody } }).digest;
          const prev = db.digest || {};
          db.digest = {
            issue_number: issueNumber || prev.issue_number || null,
            body_sha256: status === 'published' ? bodySha : prev.body_sha256 || null,
            status,
          };
          run.digest = [run.digest, status].filter(Boolean).join(',');
          run.ok = run.ok && !['failed', 'redaction-hit'].includes(status);
        }
        const next = ((POLL.connections[at] || {}).main || [])[branch] || [];
        at = next.length ? next[0].node : null;
      }
    }
  }
  return { run, runItem, writes: requests.slice(before), all: requests };
}

const newDb = () => ({ runs: [], current: {}, digest: null });
const noWrites = (r) => assert.deepEqual(r.writes.filter((q) => q.method !== 'GET'), [], 'no write request');

test('publish: no issue yet, one POST with title and body, then readback, published', async () => {
  const db = newDb();
  const p = pr(266);
  db.current = verdictsFor([[p, 'review']]);
  const gh = { prs: [p], issues: [] };
  const r = await runPoll({ db, github: gh });
  assert.deepEqual(r.writes.map((q) => [q.method, q.url]), [
    ['POST', `https://api.github.com/repos/${REPO}/issues`],
    ['GET', `https://api.github.com/repos/${REPO}/issues/900`],
  ]);
  assert.deepEqual(Object.keys(r.writes[0].body), ['title', 'body']);
  assert.equal(r.writes[0].body.title, 'PR triage digest');
  assert.equal(r.run.digest, 'published');
  assert.equal(r.run.ok, true);
  assert.equal(db.digest.issue_number, 900);
  assert.equal(db.digest.body_sha256, rules.sha256Hex(gh.issues[0].body));

  const again = await runPoll({ db, github: gh });
  assert.equal(again.run.digest, 'unchanged');
  assert.deepEqual(again.writes, [], 'an unchanged body makes no request at all after the gate');
});

test('publish: a ruleset-only change with the same verdicts makes no request', async () => {
  const db = newDb();
  const f = CADDY.facts.pr;
  const p = { number: f.number, title: f.title, head_sha: f.head_sha, created_at: f.created_at, draft: false, user_login: f.user_login };
  const gh = { prs: [p], issues: [] };
  const first = await runPoll({ db, github: gh, triage: true, ruleset: 'r1.c1' });
  assert.equal(first.run.digest, 'published');
  assert.equal(first.runItem.verdicts.length, 1);
  db.current = {}; // a new ruleset: no verdicts under it yet
  const second = await runPoll({ db, github: gh, triage: true, ruleset: 'r2.c2' });
  assert.equal(second.runItem.verdicts.length, 1, 're-triaged under the new ruleset');
  assert.equal(second.run.digest, 'unchanged');
  noWrites(second);
});

test('publish: an unhealthy run makes no request', async () => {
  const db = newDb();
  db.current = verdictsFor([[pr(266), 'review']]);
  const r = await runPoll({ db, github: { prs: [pr(266)], issues: [] }, cluster: { statusCode: 401, headers: {}, body: {} } });
  assert.equal(r.runItem.negative_control.result, 'not_run');
  assert.equal(r.run.digest, 'skipped-unhealthy');
  assert.equal(r.run.ok, false);
  assert.deepEqual(r.writes, []);
});

test('publish: an open head SHA with no verdict yet makes no request', async () => {
  const db = newDb();
  db.current = verdictsFor([[pr(266), 'review']]);
  const r = await runPoll({ db, github: { prs: [pr(266), pr(277)], issues: [] } });
  assert.equal(r.run.digest, 'skipped-pending');
  assert.deepEqual(r.runItem.digests[0].pending, [277]);
  assert.deepEqual(r.writes, []);
});

test('publish: no stored number but our marker issue exists: PATCH the body, not POST', async () => {
  const db = newDb();
  db.current = verdictsFor([[pr(266), 'review']]);
  const gh = { prs: [pr(266)], issues: [{ number: 12, state: 'open', title: 'PR triage digest', body: `${rules.DIGEST_MARKER}\n\nold`, user: { login: LOGIN } }] };
  const r = await runPoll({ db, github: gh });
  assert.deepEqual(r.writes.map((q) => [q.method, q.url]), [
    ['PATCH', `https://api.github.com/repos/${REPO}/issues/12`],
    ['GET', `https://api.github.com/repos/${REPO}/issues/12`],
  ]);
  assert.deepEqual(Object.keys(r.writes[0].body), ['body'], 'never title, state, labels or assignees');
  assert.equal(r.run.digest, 'published');
  assert.equal(db.digest.issue_number, 12);
});

test('publish: a closed digest issue is never written or reopened', async () => {
  const db = newDb();
  db.current = verdictsFor([[pr(266), 'review']]);
  db.digest = { issue_number: 12, body_sha256: 'old' };
  const gh = { prs: [pr(266)], issues: [{ number: 12, state: 'closed', body: `${rules.DIGEST_MARKER}\n\nold`, user: { login: LOGIN } }] };
  const r = await runPoll({ db, github: gh });
  assert.equal(r.run.digest, 'closed');
  assert.equal(r.run.ok, true);
  assert.deepEqual(r.writes, []);
  gh.issues[0].state = 'open';
  const reopened = await runPoll({ db, github: gh });
  assert.equal(reopened.run.digest, 'published');
});

test('publish: a readback that does not match fails the run and stores no sha', async () => {
  const db = newDb();
  db.current = verdictsFor([[pr(266), 'review']]);
  const gh = { prs: [pr(266)], issues: [], mangleReadback: true };
  const r = await runPoll({ db, github: gh });
  assert.equal(r.run.digest, 'failed');
  assert.equal(r.run.ok, false);
  assert.equal(db.digest.body_sha256, null, 'so the next run writes again');
  gh.mangleReadback = false;
  const retry = await runPoll({ db, github: gh });
  assert.deepEqual(retry.writes.map((q) => q.method), ['PATCH', 'GET'], 'the issue it created is found by its number');
  assert.equal(retry.run.digest, 'published');
});

test('publish: a failed write fails the run, never blocks a PR', async () => {
  const db = newDb();
  db.current = verdictsFor([[pr(266), 'review']]);
  const r = await runPoll({ db, github: { prs: [pr(266)], issues: [], failWrite: true } });
  assert.deepEqual(r.writes.map((q) => q.url), [`https://api.github.com/repos/${REPO}/issues`, 'https://api.github.com/rate_limit']);
  assert.equal(r.run.digest, 'failed');
  assert.equal(r.run.ok, false);
});

test('publish: write_mode off runs no digest node and records off', async () => {
  const db = newDb();
  db.current = verdictsFor([[pr(266), 'review']]);
  const off = CONFIG_TEXT.replace('write_mode: "digest"', 'write_mode: "off"');
  const r = await runPoll({ db, github: { prs: [pr(266)], issues: [] }, config: off });
  assert.equal(r.run.digest, 'off');
  assert.deepEqual(r.writes, []);
  assert.match(node('Finish run').parameters.query, /digest = CASE WHEN \$5::text = 'digest' THEN NULL ELSE 'off' END/);
});

test('Record digest publishes only on a matching readback, with the marker rules.js uses', () => {
  const q = node('Record digest').parameters.query.replace(/\s+/g, ' ');
  assert.ok(q.includes(`starts_with($5::text, '${rules.DIGEST_MARKER}')`));
  assert.ok(q.includes("encode(sha256(convert_to($5::text, 'UTF8')), 'hex') = $6::text THEN 'published' ELSE 'failed'"));
  assert.match(q, /body_sha256 = CASE WHEN excluded\.status = 'published' THEN excluded\.body_sha256 ELSE d\.body_sha256 END/);
  assert.match(q, /ok = coalesce\(r\.ok, false\) AND s\.status NOT IN \('failed', 'redaction-hit'\)/);
  for (const o of rules.DIGEST_OUTCOMES) assert.ok(read('triage/schema.sql').includes(o), `schema comment names ${o}`);
});

// ------------------------------------------------------------ allowlist

const clone = (x) => JSON.parse(JSON.stringify(x));

test('allowlist: the poll workflow has exactly the two digest writes, after the gate', () => {
  const { problems, writes } = checkWrites(POLL);
  assert.deepEqual(problems, []);
  assert.deepEqual(writes.map((w) => [w.node, w.method]), [['Create digest issue', 'POST'], ['Edit digest issue', 'PATCH']]);
});

test('allowlist: a labels POST fails, even after the gate', () => {
  const wf = clone(POLL);
  const n = wf.nodes.find((x) => x.name === 'Create digest issue');
  n.parameters.url = '=https://api.github.com/repos/{{ $json.repo }}/issues/{{ Number($json.issue_number) }}/labels';
  n.parameters.jsonBody = '={{ JSON.stringify({ labels: ["low-risk"] }) }}';
  assert.match(checkWrites(wf).problems.join('\n'), /"Create digest issue" is a POST .*labels that matches neither digest write/);
});

test('allowlist: a PATCH carrying state fails', () => {
  const wf = clone(POLL);
  wf.nodes.find((x) => x.name === 'Edit digest issue').parameters.jsonBody = '={{ JSON.stringify({ body: $json.body, state: "closed" }) }}';
  assert.match(checkWrites(wf).problems.join('\n'), /"Edit digest issue" is a PATCH .* matches neither digest write/);
});

test('allowlist: a digest write outside the gate, or with a query string, fails', () => {
  const wf = clone(POLL);
  wf.connections['Write gate'].main = [[], [{ node: 'Digest plan', type: 'main', index: 0 }]];
  assert.match(checkWrites(wf).problems.join('\n'), /outside the "Write gate" node's true output/);
  const q = clone(POLL);
  Object.assign(q.nodes.find((x) => x.name === 'Edit digest issue').parameters, { sendQuery: true, queryParameters: { parameters: [{ name: 'state', value: 'closed' }] } });
  assert.match(checkWrites(q).problems.join('\n'), /sends something besides its JSON body/);
});

test('the negative control still fails against the live cluster version', () => {
  assert.equal(rules.negativeControl({ url: 'u', gitVersion: 'v1.34.12+k3s1', etag_or_sha: 'c' }, CONFIG).result, 'fail');
});
