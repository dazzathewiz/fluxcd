'use strict';
// Run with: node --test apps/tools/n8n/triage/
// TriageWatch00001 end to end, node by node from the workflow JSON: its
// expressions and Code nodes run as written, against a fake GitHub, cluster
// and Home Assistant. Postgres is modelled here; the SQL itself was checked
// against the live database in a rolled-back transaction (see the PR).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./poll-harness.js');
const rules = require('./rules.js');

const N8N = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(N8N, p), 'utf8');
const WATCH = JSON.parse(read('workflows/triage-watch.json'));
const CLUSTER = JSON.parse(read('workflows/triage-cluster-version.json'));
const ALERT = JSON.parse(read('workflows/triage-alert.json'));
const CONFIG_TEXT = read('triage/config.yaml');
// Explicit off and labels configs, whatever the live config says.
const withWatchMode = (mode) => CONFIG_TEXT.replace(/^watch_write_mode: .*$/m, `watch_write_mode: "${mode}"`);
const OFF_TEXT = withWatchMode('off');
const LABELS_TEXT = withWatchMode('labels');
// The repo from config.yaml: the Watch node checks the SQL's list against it.
const REPO = rules.loadConfig(CONFIG_TEXT).repos[0];
const OWNER = REPO.split('/')[0];
const API = `https://api.github.com/repos/${REPO}`;
const APP_SLUG = rules.loadConfig(CONFIG_TEXT).app_slug;
const APP_LOGIN = `${APP_SLUG}[bot]`;
const sha = (c) => c.repeat(40);
const next = (name, b) => ((((WATCH.connections[name] || {}).main || [])[b || 0]) || []).map((l) => l.node);
const node = (name) => h.nodeOf(WATCH, name);
const iso = (ms) => new Date(ms).toISOString();

const N8N_DEPLOY = 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  namespace: tools\n  name: n8n\nspec:\n  template:\n    spec:\n      containers:\n      - name: n8n\n        image: n8nio/n8n:2.48.4\n';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n');

// ------------------------------------------------------------ fakes

function fakeGithub() {
  const st = { prs: {}, listEtag: '"l1"', labels: ['triage:deep-review'], comments: {}, nextComment: 900, requests: [], files: {}, contents: {}, compare: {} };
  const prJson = (p) => ({
    number: p.number, url: `${API}/pulls/${p.number}`, issue_url: `${API}/issues/${p.number}`, state: 'closed',
    merged_at: p.merged_at, merge_commit_sha: p.merge_sha, updated_at: p.updated_at || p.merged_at,
    body: p.body || '', user: { login: p.author || 'renovate[bot]' }, merged_by: { login: p.merged_by || 'merger-z' },
    base: { ref: p.base || 'main', repo: { full_name: REPO, default_branch: 'main', owner: { login: OWNER } } }, labels: p.labels.map((name) => ({ name })),
  });
  const github = (method, url, body, headers) => {
    st.requests.push({ method, url, body });
    const u = new URL(url);
    const p = u.pathname.replace(`/repos/${REPO}`, '');
    const ok = (b, hd) => ({ statusCode: 200, headers: hd || {}, body: b });
    let m;
    if (url === 'https://api.github.com/rate_limit') return ok({ resources: {} });
    if (url === 'https://api.github.com/user') return ok({ login: 'the-bot' });
    if (url === 'https://api.github.com/app') return headers.Authorization === 'Bearer jwt-for-test' ? ok({ slug: APP_SLUG }) : { statusCode: 401, headers: {}, body: {} };
    if (method === 'POST' && /\/app\/installations\/\d+\/access_tokens$/.test(u.pathname)) return { statusCode: 201, headers: {}, body: { token: 'inst-token-1' } };
    if (method !== 'GET' && headers.Authorization !== 'token inst-token-1') return { statusCode: 401, headers: {}, body: {} };
    if (method === 'GET' && p === '/pulls') {
      assert.equal(u.searchParams.get('state'), 'closed');
      if (headers['If-None-Match'] === st.listEtag) return { statusCode: 304, headers: { etag: st.listEtag }, body: '' };
      const all = Object.values(st.prs).sort((a, b) => Date.parse(b.updated_at || b.merged_at) - Date.parse(a.updated_at || a.merged_at)).map(prJson);
      return ok(all, { etag: st.listEtag });
    }
    if ((m = p.match(/^\/pulls\/(\d+)(\/files|\/reviews)?$/))) {
      const pr = st.prs[m[1]];
      if (!m[2]) return ok(prJson(pr));
      return ok(m[2] === '/files' ? st.files[m[1]] || [] : pr.reviews || []);
    }
    if ((m = p.match(/^\/contents\/(.+)$/))) {
      const c = st.contents[`${decodeURIComponent(m[1])}@${u.searchParams.get('ref')}`];
      return c === undefined ? { statusCode: 404, headers: {}, body: {} } : ok({ encoding: 'base64', content: b64(c) });
    }
    if ((m = p.match(/^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/))) return ok({ status: st.compare[`${m[1]}...${m[2]}`] || 'diverged' });
    if (method === 'GET' && p === '/labels') return ok(st.labels.map((name) => ({ name })));
    if (method === 'POST' && p === '/labels') {
      if (!body.name) return { statusCode: 422, headers: {}, body: {} };
      if (st.labels.includes(body.name)) return { statusCode: 422, headers: {}, body: {} };
      st.labels.push(body.name);
      return { statusCode: 201, headers: {}, body: { name: body.name } };
    }
    if (method === 'GET' && (m = p.match(/^\/labels\/(.+)$/))) return st.labels.includes(decodeURIComponent(m[1])) ? ok({ name: decodeURIComponent(m[1]) }) : { statusCode: 404, headers: {}, body: {} };
    if ((m = p.match(/^\/issues\/(\d+)\/(labels|comments)$/))) {
      const pr = st.prs[m[1]];
      if (m[2] === 'labels' && method === 'GET') return ok(pr.labels.map((name) => ({ name })));
      if (m[2] === 'labels' && method === 'POST') {
        for (const n of body.labels) if (!pr.labels.includes(n)) pr.labels.push(n);
        return ok(pr.labels.map((name) => ({ name })));
      }
      if (m[2] === 'comments' && method === 'GET') return ok((pr.comments || []).map((id) => st.comments[id]));
      if (m[2] === 'comments' && method === 'POST') {
        const c = { id: st.nextComment++, body: body.body, user: { login: APP_LOGIN }, performed_via_github_app: { slug: APP_SLUG } };
        st.comments[c.id] = c;
        (pr.comments = pr.comments || []).push(c.id);
        return { statusCode: 201, headers: {}, body: c };
      }
    }
    if (method === 'GET' && (m = p.match(/^\/issues\/comments\/(\d+)$/))) return ok(st.comments[m[1]]);
    throw new Error(`fake GitHub: unexpected ${method} ${url}`);
  };
  return { st, github };
}

// ------------------------------------------------------------ the database

function newDb(configText) {
  return { config: configText, watches: [], cursor: {}, runs: [], patterns: ['secret-word'], app_id: '4242', installation_id: '77' };
}

// Start watch's SQL, for one repo.
function startWatch(db, now) {
  const run = { id: db.runs.length + 1, started: iso(now), finished: null, ok: null };
  db.runs.push(run);
  const c = db.cursor[REPO];
  const cursor = c ? c.merged_at : iso(now - 60 * 60000);
  const mine = db.watches.filter((w) => w.repo === REPO);
  const groupOf = (w) => (w.failure_group ? mine.filter((g) => g.failure_group === w.failure_group).sort((a, b) => a.id - b.id) : []);
  const publishable = mine.filter((w) => w.status !== 'pending' && w.finished_at && Date.parse(w.finished_at) > now - 86400000
    && (!w.planned_actions || (w.planned_actions.mode === 'labels'
      && (!w.published || (w.status !== 'ok' && w.alert_attempts < 3 && !(w.alert_status >= 200 && w.alert_status < 300)
        && !groupOf(w).some((g) => g.id < w.id))))));
  return {
    run,
    row: {
      run_id: run.id, repo: REPO, config_body: db.config, cursor, list_etag: c ? c.list_etag : null,
      known: mine.filter((w) => Date.parse(w.merged_at) >= Date.parse(cursor) - 86400000).map((w) => `${w.pr}@${w.merge_sha}`),
      pending: mine.filter((w) => w.status === 'pending').map((w) => ({ id: w.id, repo: w.repo, pr: w.pr, merge_sha: w.merge_sha, merged_at: w.merged_at, targets: w.targets, fail_streak: w.fail_streak, preexisting: w.preexisting })),
      history: mine.filter((w) => Date.parse(w.merged_at) > now - 7 * 86400000).sort((a, b) => Date.parse(a.merged_at) - Date.parse(b.merged_at) || a.id - b.id)
        .map((w) => ({ id: w.id, pr: w.pr, merge_sha: w.merge_sha, merged_at: w.merged_at, status: w.status, failure_group: w.failure_group || null, detail: w.last_detail })),
      publishable: publishable.map((w) => ({
        id: w.id, repo: w.repo, pr: w.pr, merge_sha: w.merge_sha, status: w.status, fix_forward: w.fix_forward, fix_forward_source: w.fix_forward_source,
        detail: w.last_detail, alert_status: w.alert_status, alert_attempts: w.alert_attempts, failure_group: w.failure_group || null, preexisting: w.preexisting,
        group: w.failure_group ? groupOf(w).map((g) => ({ id: g.id, pr: g.pr, merge_sha: g.merge_sha, fix_forward: g.fix_forward, preexisting: g.preexisting })) : null,
      })),
      patterns: db.patterns, app_id: db.app_id, installation_id: db.installation_id,
    },
  };
}

// ------------------------------------------------------------ the sub-workflows

// TriageClusterV01 for one item: the allowlist node, then the request or the rejection.
function runCluster(item, cluster, log) {
  const out = { 'When called': [{ json: item }] };
  out['Allowed path'] = h.code(h.nodeOf(CLUSTER, 'Allowed path'), out, out['When called'], 0);
  if (!h.ifResult(h.nodeOf(CLUSTER, 'Allowed?'), h.scope(out, out['Allowed path'][0].json, 0))) {
    return h.code(h.nodeOf(CLUSTER, 'Rejected'), out, out['Allowed path'], 0)[0];
  }
  const url = h.param(h.nodeOf(CLUSTER, 'GET').parameters.url, h.scope(out, {}, 0));
  log.push(url);
  const r = cluster(url.replace('https://kubernetes.default.svc', ''));
  return { json: { statusCode: r.statusCode, headers: {}, body: r.body } };
}

// TriageAlertV01 for one item: the body it would POST, and the status back.
function runAlert(item, ha) {
  const out = { 'When called': [{ json: item }] };
  const body = JSON.parse(h.param(h.nodeOf(ALERT, 'POST').parameters.jsonBody, h.scope(out, {}, 0)));
  const status = ha(body);
  return h.code(h.nodeOf(ALERT, 'Result'), out, [{ json: { statusCode: status } }], 0)[0];
}

// ------------------------------------------------------------ one run

// The Code nodes read the clock with new Date(); each run sets it to opts.now.
const RealDate = Date;
function withClock(ms, fn) {
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(ms); }
    static now() { return ms; }
  }
  globalThis.Date = FakeDate;
  try { return fn(); } finally { globalThis.Date = RealDate; }
}

// opts: {db, gh, cluster(path) -> {statusCode, body}, ha(body) -> status, now (ms)}
function runWatch(opts) {
  return withClock(opts.now, () => runWatchAt(opts));
}

function runWatchAt(opts) {
  const { db, gh } = opts;
  const now = opts.now;
  const start = startWatch(db, now);
  const out = { 'Start watch': [{ json: start.row }] };
  const clusterLog = [];
  const alerts = [];
  const each = (name, input) => {
    const n = node(name);
    const items = [];
    const list = n.executeOnce ? input.slice(0, 1) : input;
    list.forEach((it, i) => items.push(...h.http(n, h.scope(out, it.json, i), gh.github, i)));
    out[name] = items;
    return items;
  };
  each('List merges', out['Start watch']);
  out.Work = h.code(node('Work'), out, out['List merges'], 0);
  let summary = out.Work[0].json;
  assert.deepEqual(next('Busy?', 0), ['Merge reads']);
  assert.deepEqual(next('Busy?', 1), ['Finish run']);
  if (h.ifResult(node('Busy?'), h.scope(out, summary, 0))) {
    out['Merge reads'] = h.code(node('Merge reads'), out, out.Work, 0);
    // Branches in canvas order (executionOrder v1).
    const branches = next('Merge reads');
    assert.deepEqual(branches, ['Get merged PR', 'Get files', 'Get reviews', 'Get merge comments', 'Bot login', 'Cluster reads']);
    const ys = branches.map((b) => node(b).position[1]);
    assert.deepEqual(ys.slice().sort((a, b) => a - b), ys, 'branches top to bottom');
    each('Get merged PR', out['Merge reads']);
    each('Get files', out['Merge reads']);
    out['Content URLs'] = h.code(node('Content URLs'), out, out['Get files'], 0);
    each('Get contents', out['Content URLs']);
    each('Get reviews', out['Merge reads']);
    each('Get merge comments', out['Merge reads']);
    each('Bot login', out['Merge reads']);
    out['Cluster reads'] = h.code(node('Cluster reads'), out, out['Merge reads'], 0);
    assert.equal(node('Cluster').parameters.workflowId, 'TriageClusterV01');
    out.Cluster = out['Cluster reads'].map((it) => runCluster(it.json, opts.cluster || (() => ({ statusCode: 404, body: {} })), clusterLog));
    out['Compare URLs'] = h.code(node('Compare URLs'), out, out.Cluster, 0);
    assert.deepEqual(next('Compare URLs'), ['Compare', 'Publish reads']);
    each('Compare', out['Compare URLs']);
    out['Publish reads'] = h.code(node('Publish reads'), out, out['Compare URLs'], 0);
    assert.deepEqual(next('Publish reads'), ['Watched PR labels', 'Watched PR comments', 'Repo labels', 'Watch']);
    each('Watched PR labels', out['Publish reads']);
    each('Watched PR comments', out['Publish reads']);
    each('Repo labels', out['Publish reads']);
    out.Watch = h.code(node('Watch'), out, out['Publish reads'], 0);
    summary = out.Watch[0].json;
    assert.equal(summary.kind, 'run');
    assert.deepEqual(next('Watch'), ['New watches only', 'Checks only', 'Plans only', 'Alerts only', 'Run summary only']);
    const of = (kind) => out.Watch.filter((i) => i.json.kind === kind);
    for (const it of of('insert')) {
      const [repo, pr, msha, mergedAt, mergedBy, targets, notes, status, ff, ffs, detail, pre] = h.param(node('Insert watch').parameters.options.queryReplacement, h.scope(out, it.json, 0));
      if (db.watches.some((w) => w.repo === repo && w.pr === pr && w.merge_sha === msha)) continue;
      db.watches.push({
        id: db.watches.length + 1, repo, pr, merge_sha: msha, merged_at: mergedAt, merged_by: mergedBy || null, targets: JSON.parse(targets), notes: JSON.parse(notes),
        status, fix_forward: ff, fix_forward_source: ffs || null, fail_streak: {}, last_detail: JSON.parse(detail), preexisting: JSON.parse(pre), planned_actions: null, published: false,
        publish_outcome: null, run_id: null, alert_status: null, alert_attempts: 0, created_at: iso(now), finished_at: status !== 'pending' ? iso(now) : null,
      });
    }
    for (const it of of('update')) {
      const [wid, status, streak, detail, group, pre] = h.param(node('Update watch').parameters.options.queryReplacement, h.scope(out, it.json, 0));
      const w = db.watches.find((x) => x.id === wid);
      if (!w || w.status !== 'pending') continue;
      Object.assign(w, { status, fail_streak: JSON.parse(streak), last_detail: JSON.parse(detail), finished_at: status !== 'pending' ? iso(now) : null, failure_group: group || null, preexisting: JSON.parse(pre) });
    }
    for (const it of of('plan')) {
      const [wid, plan, outcome, mode, runId] = h.param(node('Record watch plan').parameters.options.queryReplacement, h.scope(out, it.json, 0));
      const w = db.watches.find((x) => x.id === wid);
      Object.assign(w, { planned_actions: JSON.parse(plan), publish_outcome: outcome, run_id: runId, published: w.published || (mode === 'labels' && outcome === 'up-to-date') });
    }
    out['Record watch plan'] = of('plan').map(() => ({ json: { success: true } }));
    if (of('plan').length) {
      out['One item per action'] = h.code(node('One item per action'), out, out['Record watch plan'], 0);
      const passed = out['One item per action'].filter((it, i) => h.ifResult(node('Write gate'), h.scope(out, it.json, i)));
      out['Write gate'] = passed;
      if (passed.length) {
        assert.equal(node('Publish').parameters.workflowId, 'TriagePublishV01');
        out.Publish = passed.map((it) => h.runPublish(it.json, gh.github, [])[0]);
        out['Publish results'] = h.code(node('Publish results'), out, out.Publish, 0);
        for (const it of out['Publish results']) {
          const [wid, outcome] = h.param(node('Record publish').parameters.options.queryReplacement, h.scope(out, it.json, 0));
          const w = db.watches.find((x) => x.id === wid);
          Object.assign(w, { publish_outcome: outcome, published: w.published || outcome === 'published' });
        }
      }
    }
    const gatedAlerts = of('alert').filter((it, i) => h.ifResult(node('Alert gate'), h.scope(out, it.json, i)));
    out['Alert gate'] = gatedAlerts;
    if (gatedAlerts.length) {
      assert.equal(node('Alert').parameters.workflowId, 'TriageAlertV01');
      out.Alert = gatedAlerts.map((it) => runAlert(it.json, (body) => { alerts.push(body); return opts.ha ? opts.ha(body) : 200; }));
      out['Alert results'] = h.code(node('Alert results'), out, out.Alert, 0);
      for (const it of out['Alert results']) {
        const [wid, status] = h.param(node('Record alert').parameters.options.queryReplacement, h.scope(out, it.json, 0));
        const w = db.watches.find((x) => x.id === wid);
        Object.assign(w, { alert_status: status || null, alert_attempts: w.alert_attempts + 1 });
      }
    }
  }
  // Finish run
  const [runId, ok, newMerges, checked, repos] = h.param(node('Finish run').parameters.options.queryReplacement, h.scope(out, summary, 0));
  const failedWrite = db.watches.some((w) => w.run_id === runId && ['failed', 'publishing'].includes(w.publish_outcome));
  Object.assign(start.run, { finished: iso(now), ok: ok && !failedWrite, new_merges: newMerges, checked });
  for (const x of JSON.parse(repos)) {
    if (!x.listed) continue;
    const prev = db.cursor[x.repo];
    db.cursor[x.repo] = { merged_at: prev && Date.parse(prev.merged_at) > Date.parse(x.cursor_next) ? prev.merged_at : x.cursor_next, list_etag: x.etag_next || null };
  }
  return { run: start.run, out, summary, clusterLog, alerts };
}

// ------------------------------------------------------------ scenarios

const T0 = Date.parse('2026-11-21T10:00:00Z');
const n8nMerge = (gh, number, msha, mergedAt, extra) => {
  gh.st.prs[number] = Object.assign({ number, merge_sha: msha, merged_at: iso(mergedAt), labels: ['triage:human'] }, extra || {});
  gh.st.files[number] = [
    { filename: 'apps/tools/n8n/workflows/triage-watch.json', status: 'added', patch: '@@ -0,0 +1 @@\n+{}' },
    { filename: 'docs/n8n.md', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' },
  ];
  gh.st.listEtag = `"l${number}"`;
};
const ksApps = (applied, ready) => ({
  statusCode: 200,
  body: { status: { lastAppliedRevision: `main@sha1:${applied}`, lastAttemptedRevision: `main@sha1:${applied}`, conditions: [{ type: 'Ready', status: ready || 'True', reason: 'ReconciliationSucceeded' }] } },
});
const writes = (gh, from) => gh.st.requests.slice(from || 0).filter((q) => q.method !== 'GET');

test('idle: an unchanged listing (304) is the only request, and nothing reads the cluster', () => {
  const db = newDb(OFF_TEXT);
  const gh = fakeGithub();
  db.cursor[REPO] = { merged_at: iso(T0 - 3600000), list_etag: gh.st.listEtag };
  const r = runWatch({ db, gh, now: T0 });
  assert.deepEqual(gh.st.requests.map((q) => `${q.method} ${q.url}`), [`GET ${API}/pulls?state=closed&sort=updated&direction=desc&per_page=50`]);
  assert.equal(r.summary.kind, 'work');
  assert.equal(r.summary.busy, false);
  assert.deepEqual(r.clusterLog, []);
  assert.equal(r.run.ok, true);
  assert.equal(db.cursor[REPO].list_etag, gh.st.listEtag);
});

test('first run: the cursor starts an hour back, so a merge from 40 minutes ago is watched; older ones are not', () => {
  const db = newDb(OFF_TEXT);
  const gh = fakeGithub();
  n8nMerge(gh, 286, sha('c'), T0 - 2 * 3600000);
  n8nMerge(gh, 287, sha('d'), T0 - 40 * 60000);
  gh.st.prs[285] = { number: 285, merge_sha: null, merged_at: null, updated_at: iso(T0 - 50 * 60000), labels: [] }; // closed unmerged
  gh.st.prs[284] = { number: 284, merge_sha: sha('e'), merged_at: iso(T0 - 30 * 60000), base: 'release', labels: [] }; // not the default branch
  const r = runWatch({ db, gh, now: T0 });
  assert.equal(r.summary.kind, 'run');
  assert.equal(r.summary.mode, 'off');
  assert.deepEqual(db.watches.map((w) => [w.pr, w.merge_sha, w.status, w.merged_by]), [[287, sha('d'), 'pending', 'merger-z']]);
  assert.deepEqual(db.watches[0].targets, [{ id: 'kustomization apps', type: 'kustomization', name: 'apps' }]);
  assert.equal(db.watches[0].fix_forward, false);
  assert.equal(db.cursor[REPO].merged_at, iso(T0 - 40 * 60000));
  assert.equal(r.run.ok, true);
  assert.deepEqual(writes(gh), []);
  // A new watch is first checked on the next run, not this one.
  assert.deepEqual(r.clusterLog, []);
});

test('shadow (watch_write_mode off): this PR\'s own merge goes ok, plans nothing and writes nothing', () => {
  const db = newDb(OFF_TEXT);
  const gh = fakeGithub();
  n8nMerge(gh, 287, sha('d'), T0 - 10 * 60000);
  runWatch({ db, gh, now: T0 });
  // Next run: Flux applied a later commit that includes the merge.
  const later = sha('f');
  gh.st.compare[`${sha('d')}...${later}`] = 'ahead';
  const r2 = runWatch({ db, gh, now: T0 + 5 * 60000, cluster: (p) => (p.endsWith('/kustomizations/apps') ? ksApps(later) : { statusCode: 404, body: {} }) });
  assert.deepEqual(r2.clusterLog, ['https://kubernetes.default.svc/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/flux-system/kustomizations/apps']);
  assert.ok(gh.st.requests.some((q) => q.url === `${API}/compare/${sha('d')}...${later}?per_page=1`));
  assert.equal(db.watches[0].status, 'ok');
  // Next run: the plan. off records it and writes nothing.
  const before = gh.st.requests.length;
  const r3 = runWatch({ db, gh, now: T0 + 10 * 60000 });
  const w = db.watches[0];
  assert.equal(w.planned_actions.mode, 'off');
  assert.equal(w.publish_outcome, 'up-to-date');
  assert.deepEqual(w.planned_actions.actions, []);
  assert.equal(w.published, false);
  assert.deepEqual(writes(gh, before), [], 'nothing written to GitHub');
  assert.deepEqual(r3.alerts, []);
  assert.equal(r3.run.ok, true);
  // And then idle again: a planned-only watch is never picked up again.
  const r4 = runWatch({ db, gh, now: T0 + 15 * 60000 });
  assert.equal(r4.summary.kind, 'work');
  assert.equal(r4.summary.busy, false);
});

test('labels: ok writes no label at all, reads no labels or comments, and never alerts', () => {
  const db = newDb(LABELS_TEXT);
  const gh = fakeGithub();
  n8nMerge(gh, 287, sha('d'), T0 - 10 * 60000);
  runWatch({ db, gh, now: T0 });
  runWatch({ db, gh, now: T0 + 5 * 60000, cluster: () => ksApps(sha('d')) });
  assert.equal(db.watches[0].status, 'ok');
  const from = gh.st.requests.length;
  const r3 = runWatch({ db, gh, now: T0 + 10 * 60000 });
  assert.deepEqual(gh.st.prs[287].labels, ['triage:human']);
  assert.deepEqual(writes(gh, from), [], 'no write of any kind');
  assert.ok(!gh.st.requests.slice(from).some((q) => /\/issues\/287\//.test(q.url)), 'no label or comment read');
  assert.equal(db.watches[0].published, true, 'recorded as done: nothing to publish');
  assert.equal(db.watches[0].publish_outcome, 'up-to-date');
  assert.equal(db.watches[0].status, 'ok', 'the row still records ok');
  assert.deepEqual(r3.alerts, []);
  assert.equal(r3.run.ok, true);
  assert.deepEqual(gh.st.comments, {});
  const before = gh.st.requests.length;
  const r4 = runWatch({ db, gh, now: T0 + 15 * 60000 });
  assert.equal(r4.summary.busy, false);
  assert.equal(gh.st.requests.length - before, 1, 'only the listing');
});

test('labels: a HelmRelease failing twice is failed: rollout:revert, one comment, one alert', () => {
  const db = newDb(LABELS_TEXT);
  const gh = fakeGithub();
  const HR = 'apiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: reflector\n  namespace: flux-system\nspec:\n  chart:\n    spec:\n      chart: reflector\n      version: 10.0.81\n';
  gh.st.prs[276] = { number: 276, merge_sha: sha('a'), merged_at: iso(T0 - 5 * 60000), labels: ['triage:low-risk'] };
  gh.st.files[276] = [{ filename: 'infrastructure/controllers/reflector.yaml', status: 'modified', patch: '@@ -8,3 +8,3 @@\n     spec:\n       chart: reflector\n-      version: 10.0.78\n+      version: 10.0.81' }];
  gh.st.contents[`infrastructure/controllers/reflector.yaml@${sha('a')}`] = HR;
  runWatch({ db, gh, now: T0 });
  assert.deepEqual(db.watches[0].targets.map((t) => t.id), ['kustomization infra-controllers', 'helmrelease flux-system/reflector']);
  const cluster = (p) => {
    if (p.includes('/kustomizations/')) return ksApps(sha('a'));
    return { statusCode: 200, body: { metadata: { generation: 3 }, spec: { chart: { spec: { version: '10.0.81' } } }, status: { observedGeneration: 3, history: [{ chartVersion: '10.0.81', status: 'failed' }], conditions: [{ type: 'Ready', status: 'False', reason: 'UpgradeFailed', message: 'secret details here' }] } } };
  };
  runWatch({ db, gh, now: T0 + 5 * 60000, cluster });
  assert.equal(db.watches[0].status, 'pending', 'one failing check is not enough');
  runWatch({ db, gh, now: T0 + 10 * 60000, cluster });
  assert.equal(db.watches[0].status, 'failed');
  const r = runWatch({ db, gh, now: T0 + 15 * 60000, cluster });
  const pr = gh.st.prs[276];
  assert.deepEqual(pr.labels, ['triage:low-risk', 'rollout:revert']);
  assert.ok(gh.st.labels.includes('rollout:revert'), 'created');
  const posted = Object.values(gh.st.comments);
  assert.equal(posted.length, 1);
  assert.ok(posted[0].body.startsWith(`<!-- pr-triage-watch:v1 sha=${sha('a')} status=failed -->`));
  assert.match(posted[0].body, /`helmrelease flux-system\/reflector`: Ready=False \(UpgradeFailed\)/);
  assert.ok(!posted[0].body.includes('secret details'), 'no cluster message text');
  assert.match(posted[0].body, /Revert by hand/);
  assert.deepEqual(r.alerts, [{ source: 'pr-watch', pr: 276, prs: [276], status: 'failed', action: 'revert', fix_forward: false, checked: r.alerts[0].checked }]);
  assert.equal(db.watches[0].failure_group, null, 'its own target: no group');
  assert.equal(db.watches[0].alert_status, 200);
  // The next run: no second comment, no second alert.
  const r2 = runWatch({ db, gh, now: T0 + 20 * 60000, cluster });
  assert.equal(Object.values(gh.st.comments).length, 1);
  assert.deepEqual(r2.alerts, []);
});

test('labels: a timeout with the owner\'s fix-forward marker is rollout:fix-forward, with no deep-review', () => {
  const db = newDb(LABELS_TEXT);
  const gh = fakeGithub();
  n8nMerge(gh, 290, sha('b'), T0 - 2 * 60000);
  gh.st.comments[1] = { id: 1, body: 'rollback: fix-forward', user: { login: OWNER } };
  gh.st.prs[290].comments = [1];
  runWatch({ db, gh, now: T0 });
  assert.equal(db.watches[0].fix_forward, true);
  assert.equal(db.watches[0].fix_forward_source, 'marker in a comment');
  // Flux never gets there: the merge isn't in what it applied.
  const old = sha('9');
  gh.st.compare[`${sha('b')}...${old}`] = 'behind';
  runWatch({ db, gh, now: T0 + 15 * 60000, cluster: () => ksApps(old) });
  assert.equal(db.watches[0].status, 'pending');
  runWatch({ db, gh, now: T0 + 30 * 60000, cluster: () => ksApps(old) });
  assert.equal(db.watches[0].status, 'timeout');
  const r = runWatch({ db, gh, now: T0 + 35 * 60000, ha: () => 200 });
  const pr = gh.st.prs[290];
  assert.deepEqual(pr.labels, ['triage:human', 'rollout:fix-forward']);
  const body = Object.values(gh.st.comments).find((c) => c.user.login === APP_LOGIN).body;
  assert.match(body, /status=timeout -->/);
  assert.match(body, /Fix forward — no revert\.\*\* Source: marker in a comment\./);
  assert.match(body, /`kustomization apps`: merge not applied yet/);
  assert.deepEqual(r.alerts.map((a) => [a.pr, a.prs, a.status, a.action, a.fix_forward]), [[290, [290], 'timeout', 'fix-forward', true]]);
});

// apps failing at a revision that includes every merge given.
const ksFailing = (rev) => ({
  statusCode: 200,
  body: { status: { lastAppliedRevision: `main@sha1:${sha('0')}`, lastAttemptedRevision: `main@sha1:${rev}`, conditions: [{ type: 'Ready', status: 'False', reason: 'HealthCheckFailed', message: 'details here' }] } },
});

test('labels: two merges failing on one Kustomization revision are both rollout:investigate, with one alert and both PRs in each comment', () => {
  const db = newDb(LABELS_TEXT);
  const gh = fakeGithub();
  // Merged a few minutes apart; Flux attempts one revision with both.
  n8nMerge(gh, 300, sha('1'), T0 - 4 * 60000);
  runWatch({ db, gh, now: T0 });
  n8nMerge(gh, 301, sha('2'), T0 + 60000);
  const rev = sha('2');
  gh.st.compare[`${sha('1')}...${rev}`] = 'ahead';
  const cluster = (p) => (p.endsWith('/kustomizations/apps') ? ksFailing(rev) : { statusCode: 404, body: {} });
  runWatch({ db, gh, now: T0 + 5 * 60000, cluster });
  assert.deepEqual(db.watches.map((w) => [w.pr, w.status]), [[300, 'pending'], [301, 'pending']]);
  // 300 sees its second failing check; 301 only its first, and finishes with it.
  runWatch({ db, gh, now: T0 + 10 * 60000, cluster });
  const key = `kustomization apps@${rev}`;
  assert.deepEqual(db.watches.map((w) => [w.pr, w.status, w.failure_group]), [[300, 'failed', key], [301, 'failed', key]]);
  const r = runWatch({ db, gh, now: T0 + 15 * 60000, cluster });
  for (const n of [300, 301]) {
    const pr = gh.st.prs[n];
    assert.deepEqual(pr.labels, ['triage:human', 'rollout:investigate'], `PR ${n}`);
    assert.equal(pr.comments.length, 1);
    const body = gh.st.comments[pr.comments[0]].body;
    assert.match(body, /`kustomization apps` failed at revision `2{12}` \(Ready=False \(HealthCheckFailed\)\)/);
    assert.match(body, new RegExp(`- PR 300, merge \`${sha('1').slice(0, 12)}\`\n- PR 301, merge \`${sha('2').slice(0, 12)}\``));
    assert.match(body, /can't be attributed to one merge/);
    assert.ok(!/Revert by hand/.test(body) && !body.includes('details here'));
  }
  assert.ok(!gh.st.labels.includes('rollout:revert'), 'no attributed label created');
  assert.deepEqual(r.alerts, [{ source: 'pr-watch', pr: 300, prs: [300, 301], status: 'failed', action: 'investigate', fix_forward: false, checked: r.alerts[0].checked }]);
  assert.deepEqual(db.watches.map((w) => [w.alert_attempts, w.alert_status]), [[1, 200], [0, null]]);
  // Nothing more: no second alert from the other member, no second comment.
  const r2 = runWatch({ db, gh, now: T0 + 20 * 60000, cluster });
  assert.deepEqual(r2.alerts, []);
  assert.equal(Object.values(gh.st.comments).length, 2);
  assert.equal(r2.summary.kind, 'work', 'idle: nothing left to publish');
});

test('labels: one merge failing on its own HelmRelease beside a fine one: only the first is labelled', () => {
  const db = newDb(LABELS_TEXT);
  const gh = fakeGithub();
  const HR = 'apiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata:\n  name: reflector\n  namespace: flux-system\nspec:\n  chart:\n    spec:\n      chart: reflector\n      version: 10.0.81\n';
  gh.st.prs[310] = { number: 310, merge_sha: sha('3'), merged_at: iso(T0 - 4 * 60000), labels: [] };
  gh.st.files[310] = [{ filename: 'infrastructure/controllers/reflector.yaml', status: 'modified', patch: '@@ -8,3 +8,3 @@\n     spec:\n       chart: reflector\n-      version: 10.0.78\n+      version: 10.0.81' }];
  gh.st.contents[`infrastructure/controllers/reflector.yaml@${sha('3')}`] = HR;
  gh.st.prs[311] = { number: 311, merge_sha: sha('4'), merged_at: iso(T0 - 3 * 60000), labels: [] };
  gh.st.files[311] = [{ filename: 'apps/tools/n8n/workflows/triage-watch.json', status: 'modified', patch: '@@ -1 +1 @@\n-{}\n+{ }' }];
  runWatch({ db, gh, now: T0 });
  // Both Kustomizations applied a revision with both merges; the HelmRelease failed.
  const rev = sha('4');
  gh.st.compare[`${sha('3')}...${rev}`] = 'ahead';
  const cluster = (p) => {
    if (p.includes('/kustomizations/')) return ksApps(rev);
    return { statusCode: 200, body: { metadata: { generation: 3 }, spec: { chart: { spec: { version: '10.0.81' } } }, status: { observedGeneration: 3, history: [{ chartVersion: '10.0.81', status: 'failed' }], conditions: [{ type: 'Ready', status: 'False', reason: 'UpgradeFailed' }] } } };
  };
  runWatch({ db, gh, now: T0 + 5 * 60000, cluster });
  runWatch({ db, gh, now: T0 + 10 * 60000, cluster });
  assert.deepEqual(db.watches.map((w) => [w.pr, w.status, w.failure_group || null]), [[310, 'failed', null], [311, 'ok', null]]);
  const from = gh.st.requests.length;
  const r = runWatch({ db, gh, now: T0 + 15 * 60000, cluster });
  assert.deepEqual(gh.st.prs[310].labels, ['rollout:revert']);
  assert.deepEqual(gh.st.prs[311].labels, [], 'the fine one gets nothing');
  assert.ok(!writes(gh, from).some((q) => q.url.includes('/issues/311/')));
  assert.equal((gh.st.prs[310].comments || []).length, 1);
  assert.deepEqual(r.alerts.map((a) => [a.prs, a.action]), [[[310], 'revert']]);
});

test('labels: a failed alert is retried, at most three tries', () => {
  const db = newDb(LABELS_TEXT);
  const gh = fakeGithub();
  n8nMerge(gh, 291, sha('7'), T0 - 2 * 60000);
  runWatch({ db, gh, now: T0 });
  runWatch({ db, gh, now: T0 + 31 * 60000 });
  assert.equal(db.watches[0].status, 'timeout');
  const sent = [];
  for (let k = 0; k < 5; k++) sent.push(...runWatch({ db, gh, now: T0 + (35 + 5 * k) * 60000, ha: () => 500 }).alerts);
  assert.equal(sent.length, 3);
  assert.equal(db.watches[0].alert_attempts, 3);
  assert.equal(Object.values(gh.st.comments).length, 1, 'still one comment');
});

test('the cluster reads the watcher builds are exactly rules.js watchReads, and go through the allowlist', () => {
  const db = newDb(OFF_TEXT);
  const targets = [
    { id: 'kustomization apps', type: 'kustomization', name: 'apps' },
    { id: 'helmrelease flux-system/reflector', type: 'helmrelease', ns: 'flux-system', name: 'reflector', version: '1' },
    { id: 'deployment tools/n8n', type: 'deployment', ns: 'tools', name: 'n8n', images: ['x'] },
    { id: 'statefulset tools/s', type: 'statefulset', ns: 'tools', name: 's', images: ['x'] },
    // A target that a tampered row might carry: rejected by the sub-workflow, never requested.
    { id: 'deployment ../x', type: 'deployment', ns: '..', name: 'x', images: ['x'] },
  ];
  db.watches.push({ id: 1, repo: REPO, pr: 1, merge_sha: sha('1'), merged_at: iso(T0), targets, fail_streak: {}, status: 'pending', alert_attempts: 0 });
  const gh = fakeGithub();
  db.cursor[REPO] = { merged_at: iso(T0), list_etag: gh.st.listEtag };
  const seen = [];
  const r = runWatch({ db, gh, now: T0 + 60000, cluster: (p) => { seen.push(p); return { statusCode: 404, body: {} }; } });
  const built = r.out['Cluster reads'].map((i) => i.json.cluster_path).sort();
  const expected = rules.watchReads(targets).map((x) => x.path).concat(['/apis/apps/v1/namespaces/../deployments/x']).sort();
  assert.deepEqual(built, expected);
  assert.deepEqual(seen.sort(), rules.watchReads(targets).map((x) => x.path).sort(), 'the tampered path was never requested');
  assert.ok(r.out.Cluster.some((i) => i.json.rejected === true));
});

test('the watcher workflow: unsaved settings aren\'t needed, but it reads no token, sends no secret and calls only its three sub-workflows', () => {
  assert.equal(WATCH.id, 'TriageWatch00001');
  assert.equal(WATCH.settings.executionOrder, 'v1');
  const text = JSON.stringify(WATCH);
  assert.ok(!text.includes('serviceaccount'), 'no token read here');
  assert.ok(!/alert_target/.test(text));
  assert.ok(!WATCH.nodes.some((n) => n.type === 'n8n-nodes-base.readWriteFile' || n.type === 'n8n-nodes-base.jwt'));
  const calls = WATCH.nodes.filter((n) => n.type === 'n8n-nodes-base.executeWorkflow').map((n) => [n.name, n.parameters.workflowId]);
  assert.deepEqual(calls, [['Cluster', 'TriageClusterV01'], ['Publish', 'TriagePublishV01'], ['Alert', 'TriageAlertV01']]);
  for (const n of WATCH.nodes.filter((x) => x.type === 'n8n-nodes-base.httpRequest')) {
    assert.equal(String(n.parameters.method), 'GET', n.name);
    assert.equal(n.nodeCredentialType || n.parameters.nodeCredentialType, 'githubApi', n.name);
  }
  const trigger = node('Every 5 minutes');
  assert.deepEqual(trigger.parameters.rule.interval, [{ field: 'minutes', minutesInterval: 5 }]);
  assert.match(read('deployment.yaml'), /n8n publish:workflow --id=TriageWatch00001\n/);
  assert.match(read('kustomization.yaml'), /- workflows\/triage-watch\.json/);
});

// ------------------------------------------------------------ pre-existing failures

// A (PR 310) breaks apps at its own revision and is labelled rollout:revert.
function aFails(db, gh) {
  n8nMerge(gh, 310, sha('3'), T0 - 4 * 60000);
  runWatch({ db, gh, now: T0 });
  const cluster = (p) => (p.endsWith('/kustomizations/apps') ? ksFailing(sha('3')) : { statusCode: 404, body: {} });
  runWatch({ db, gh, now: T0 + 5 * 60000, cluster });
  runWatch({ db, gh, now: T0 + 10 * 60000, cluster });
  assert.deepEqual(db.watches.map((w) => [w.pr, w.status, w.failure_group]), [[310, 'failed', `kustomization apps@${sha('3')}`]]);
  return cluster;
}
const commentOf = (gh, n) => gh.st.comments[gh.st.prs[n].comments[0]].body;

test('pre-existing: merge B on a target already failing from A is rollout:investigate, in A\'s group, and its comment names A', () => {
  const db = newDb(LABELS_TEXT);
  const gh = fakeGithub();
  const failingAtA = aFails(db, gh);
  n8nMerge(gh, 311, sha('4'), T0 + 11 * 60000);
  const r1 = runWatch({ db, gh, now: T0 + 15 * 60000, cluster: failingAtA });
  assert.deepEqual(r1.alerts.map((a) => [a.prs, a.action]), [[[310], 'revert']]);
  assert.deepEqual(db.watches[1].preexisting, [{ id: 'kustomization apps', pr: 310, merge_sha: sha('3'), failure_group: `kustomization apps@${sha('3')}`, source: 'watch' }]);
  // Flux then attempts B, which still carries A's breakage.
  const failingAtB = (p) => (p.endsWith('/kustomizations/apps') ? ksFailing(sha('4')) : { statusCode: 404, body: {} });
  runWatch({ db, gh, now: T0 + 20 * 60000, cluster: failingAtB });
  runWatch({ db, gh, now: T0 + 25 * 60000, cluster: failingAtB });
  assert.deepEqual(db.watches.map((w) => [w.pr, w.status, w.failure_group]), [[310, 'failed', `kustomization apps@${sha('3')}`], [311, 'failed', `kustomization apps@${sha('3')}`]]);
  const r2 = runWatch({ db, gh, now: T0 + 30 * 60000, cluster: failingAtB });
  assert.deepEqual(gh.st.prs[310].labels, ['triage:human', 'rollout:revert']);
  assert.deepEqual(gh.st.prs[311].labels, ['triage:human', 'rollout:investigate']);
  const body = commentOf(gh, 311);
  assert.match(body, /Target was already failing from PR 310 before this merge/);
  assert.ok(!/Revert by hand/.test(body));
  assert.deepEqual(r2.alerts, [], 'A\'s alert covered the failure');
});

test('pre-existing: B merged while A is still pending, with apps Ready=False at A\'s revision, is recorded at creation; A stays revert', () => {
  const db = newDb(LABELS_TEXT);
  const gh = fakeGithub();
  n8nMerge(gh, 310, sha('3'), T0 - 4 * 60000);
  runWatch({ db, gh, now: T0 });
  const failingAtA = (p) => (p.endsWith('/kustomizations/apps') ? ksFailing(sha('3')) : { statusCode: 404, body: {} });
  n8nMerge(gh, 311, sha('4'), T0 + 4 * 60000);
  gh.st.compare[`${sha('4')}...${sha('3')}`] = 'behind';
  runWatch({ db, gh, now: T0 + 5 * 60000, cluster: failingAtA });
  assert.deepEqual(db.watches.map((w) => [w.pr, w.status]), [[310, 'pending'], [311, 'pending']]);
  assert.deepEqual(db.watches[1].preexisting.map((p) => [p.pr, p.source]), [[310, 'cluster']]);
  runWatch({ db, gh, now: T0 + 10 * 60000, cluster: failingAtA });
  // B is held behind A until it times out.
  for (let m = 15; m <= 35; m += 5) runWatch({ db, gh, now: T0 + m * 60000, cluster: failingAtA });
  assert.deepEqual(db.watches.map((w) => [w.pr, w.status, w.failure_group]), [[310, 'failed', `kustomization apps@${sha('3')}`], [311, 'timeout', `kustomization apps@${sha('3')}`]]);
  runWatch({ db, gh, now: T0 + 40 * 60000, cluster: failingAtA });
  assert.deepEqual(gh.st.prs[310].labels, ['triage:human', 'rollout:revert']);
  assert.deepEqual(gh.st.prs[311].labels, ['triage:human', 'rollout:investigate']);
  assert.match(commentOf(gh, 311), /status=timeout -->[\s\S]*already failing from PR 310 before this merge/);
});

test('pre-existing: A failing alone is still rollout:revert', () => {
  const db = newDb(LABELS_TEXT);
  const gh = fakeGithub();
  const cluster = aFails(db, gh);
  const r = runWatch({ db, gh, now: T0 + 15 * 60000, cluster });
  assert.deepEqual(db.watches[0].preexisting, []);
  assert.deepEqual(gh.st.prs[310].labels, ['triage:human', 'rollout:revert']);
  assert.match(commentOf(gh, 310), /Revert by hand/);
  assert.ok(!/already failing/i.test(commentOf(gh, 310)));
  assert.deepEqual(r.alerts.map((a) => [a.pr, a.prs, a.action]), [[310, [310], 'revert']]);
});

test('pre-existing: B with a fix-forward marker on a target already failing is rollout:fix-forward', () => {
  const db = newDb(LABELS_TEXT);
  const gh = fakeGithub();
  const failingAtA = aFails(db, gh);
  n8nMerge(gh, 312, sha('6'), T0 + 11 * 60000, { body: 'rollback: fix-forward', author: OWNER });
  runWatch({ db, gh, now: T0 + 15 * 60000, cluster: failingAtA });
  const failingAtB = (p) => (p.endsWith('/kustomizations/apps') ? ksFailing(sha('6')) : { statusCode: 404, body: {} });
  runWatch({ db, gh, now: T0 + 20 * 60000, cluster: failingAtB });
  runWatch({ db, gh, now: T0 + 25 * 60000, cluster: failingAtB });
  runWatch({ db, gh, now: T0 + 30 * 60000, cluster: failingAtB });
  assert.equal(db.watches[1].failure_group, `kustomization apps@${sha('3')}`);
  assert.deepEqual(gh.st.prs[312].labels, ['triage:human', 'rollout:fix-forward']);
  const body = commentOf(gh, 312);
  assert.match(body, /already failing from PR 310 before this merge/);
  assert.match(body, /Fix forward — no revert\.\*\* Source: marker in the PR description\./);
});

test('pre-existing: once A is reverted and apps is ok, a new merge C that fails is rollout:revert, not in A\'s group', () => {
  const db = newDb(LABELS_TEXT);
  const gh = fakeGithub();
  aFails(db, gh);
  // The revert of A (PR 313) rolls out.
  n8nMerge(gh, 313, sha('5'), T0 + 11 * 60000);
  const okAtRevert = (p) => (p.endsWith('/kustomizations/apps') ? ksApps(sha('5')) : { statusCode: 404, body: {} });
  runWatch({ db, gh, now: T0 + 15 * 60000, cluster: okAtRevert });
  runWatch({ db, gh, now: T0 + 20 * 60000, cluster: okAtRevert });
  assert.deepEqual(db.watches.map((w) => [w.pr, w.status]), [[310, 'failed'], [313, 'ok']]);
  // C (PR 314) breaks apps again, on its own.
  n8nMerge(gh, 314, sha('7'), T0 + 21 * 60000);
  runWatch({ db, gh, now: T0 + 25 * 60000, cluster: okAtRevert });
  assert.deepEqual(db.watches[2].preexisting, []);
  const failingAtC = (p) => (p.endsWith('/kustomizations/apps') ? ksFailing(sha('7')) : { statusCode: 404, body: {} });
  runWatch({ db, gh, now: T0 + 30 * 60000, cluster: failingAtC });
  runWatch({ db, gh, now: T0 + 35 * 60000, cluster: failingAtC });
  assert.deepEqual(db.watches.map((w) => [w.pr, w.status, w.failure_group]),
    [[310, 'failed', `kustomization apps@${sha('3')}`], [313, 'ok', null], [314, 'failed', `kustomization apps@${sha('7')}`]]);
  const r = runWatch({ db, gh, now: T0 + 40 * 60000, cluster: failingAtC });
  assert.deepEqual(gh.st.prs[314].labels, ['triage:human', 'rollout:revert']);
  assert.ok(!/already failing/i.test(commentOf(gh, 314)));
  assert.deepEqual(r.alerts.map((a) => [a.pr, a.prs, a.action]), [[314, [314], 'revert']]);
});
