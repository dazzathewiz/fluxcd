'use strict';
// Run with: node --test apps/tools/n8n/triage/
// write_mode labels: the state machine (planPublish), the poll and the
// TriagePublishV01 sub-workflow walked node by node against a stubbed GitHub,
// the SQL the harness models, and the write allowlist.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rules = require('./rules.js');
const { checkWrites, writeTemplates } = require('./sync-code-nodes.js');
const h = require('./poll-harness.js');

const N8N = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(N8N, p), 'utf8');
const CONFIG_TEXT = read('triage/config.yaml');
// Sets the write_mode line, whatever it says now. Exactly one must match, so a
// format change fails here instead of running a test in the wrong mode.
const WRITE_MODE_LINE = /^write_mode: .*$/gm;
function setWriteModeLine(text, line) {
  const n = (text.match(WRITE_MODE_LINE) || []).length;
  assert.equal(n, 1, `config.yaml must have exactly one write_mode line (found ${n})`);
  return text.replace(WRITE_MODE_LINE, line);
}
const withWriteMode = (text, mode) => setWriteModeLine(text, `write_mode: "${mode}"`);
const OFF_TEXT = withWriteMode(CONFIG_TEXT, 'off');
const LABELS_TEXT = withWriteMode(CONFIG_TEXT, 'labels');
// The off parse: planPublish's default ctx and the off cases plan without the App.
const CONFIG = rules.loadConfig(OFF_TEXT);
const REPO = 'dazzathewiz/fluxcd';
const API = `https://api.github.com/repos/${REPO}`;
const APP_ID = '4242';
const INSTALLATION = '77';
const APP_SLUG = 'dtw-pr-triage';
const APP_LOGIN = 'dtw-pr-triage[bot]';
const PATTERNS = ['/example-private-term/'];
const RS1 = 'r111111111111.c111111111111';
const RS2 = 'r222222222222.c222222222222';
const sha = (c) => String(c).repeat(40).slice(0, 40);
const squash = (s) => s.replace(/\s+/g, ' ');

// ------------------------------------------------------------ a stubbed GitHub

function makeGithub(db) {
  const state = { labels: ['bug'], prs: {}, comments: {}, nextComment: 5000, statuses: {}, requests: [], pageSize: 100, gone: new Set(), failWrites: false, appSlug: APP_SLUG };
  let seq = 0;
  const now = () => h.iso(db.clock + (++seq) * 1000);
  const page = (url, all) => {
    const u = new URL(url);
    const size = Math.min(Number(u.searchParams.get('per_page') || 30), state.pageSize);
    const p = Number(u.searchParams.get('page') || 1);
    const body = all.slice((p - 1) * size, p * size);
    const headers = {};
    if (p * size < all.length) {
      u.searchParams.set('page', String(p + 1));
      headers.link = `<${u.toString()}>; rel="next", <x>; rel="last"`;
    }
    return { statusCode: 200, headers, body };
  };
  const prJson = (pr) => ({
    number: pr.number, url: `${API}/pulls/${pr.number}`, issue_url: `${API}/issues/${pr.number}`, html_url: `https://github.com/${REPO}/pull/${pr.number}`,
    state: 'open', draft: !!pr.draft, title: pr.title, body: '', created_at: pr.created_at, user: { login: pr.user },
    head: { sha: pr.head_sha, ref: `renovate/x-${pr.number}` }, base: { repo: { full_name: REPO, url: API } },
    labels: pr.labels.map((name) => ({ name })), mergeable: true, mergeable_state: 'clean',
  });
  const event = (pr, ev, name, actor) => pr.events.push({ id: 100000 + (++seq), event: ev, label: name ? { name } : undefined, actor: { login: actor }, created_at: now() });
  const appAuth = (hd) => hd.Authorization === 'token inst-token-1';
  const github = (method, url, body, headers) => {
    state.requests.push({ method, url, body, auth: headers.Authorization ? headers.Authorization.split(' ')[0] : null });
    const u = new URL(url);
    const p = u.pathname.replace(`/repos/${REPO}`, '');
    let m;
    if (method === 'GET' && url === 'https://api.github.com/app') {
      return headers.Authorization === 'Bearer jwt-for-test' ? { statusCode: 200, headers: {}, body: { id: Number(APP_ID), slug: state.appSlug } } : { statusCode: 401, headers: {}, body: {} };
    }
    if (url === 'https://api.github.com/rate_limit') return { statusCode: method === 'GET' ? 200 : 404, headers: {}, body: { resources: {} } };
    if (method === 'POST' && (m = p.match(/^\/app\/installations\/(\d+)\/access_tokens$/))) {
      const ok = headers.Authorization === 'Bearer jwt-for-test' && m[1] === INSTALLATION;
      return ok ? { statusCode: 201, headers: {}, body: { token: 'inst-token-1', expires_at: 'x' } } : { statusCode: 401, headers: {}, body: {} };
    }
    if (method !== 'GET' && !appAuth(headers)) return { statusCode: 401, headers: {}, body: {} };
    if (method !== 'GET' && state.failWrites) return { statusCode: 502, headers: {}, body: {} };
    if (method === 'GET' && p === '/issues' && u.searchParams.get('creator')) return { statusCode: 200, headers: {}, body: [] };
    if (method === 'GET' && p === '/labels') return { statusCode: 200, headers: {}, body: state.labels.map((name) => ({ name })) };
    if (method === 'POST' && p === '/labels') {
      if (state.labels.includes(body.name)) return { statusCode: 422, headers: {}, body: { errors: [{ code: 'already_exists' }] } };
      if (!body.name) return { statusCode: 422, headers: {}, body: {} };
      state.labels.push(body.name);
      return { statusCode: 201, headers: {}, body: { name: body.name } };
    }
    if (method === 'GET' && (m = p.match(/^\/labels\/(.+)$/))) {
      const name = decodeURIComponent(m[1]);
      return state.labels.includes(name) ? { statusCode: 200, headers: {}, body: { name } } : { statusCode: 404, headers: {}, body: {} };
    }
    if (method === 'GET' && p === '/pulls') return { statusCode: 200, headers: { etag: '"l"' }, body: Object.values(state.prs).map(prJson) };
    if ((m = p.match(/^\/pulls\/(\d+)(\/files)?$/))) {
      const pr = state.prs[m[1]];
      if (!pr) return { statusCode: 404, headers: {}, body: {} };
      return m[2] ? { statusCode: 200, headers: {}, body: [] } : { statusCode: 200, headers: {}, body: prJson(pr) };
    }
    if ((m = p.match(/^\/issues\/(\d+)\/(events|comments|labels)(?:\/(.+))?$/))) {
      const pr = state.prs[m[1]];
      if (m[2] === 'events') return page(url, pr.events);
      if (m[2] === 'comments' && method === 'GET') return page(url, pr.comments.map((id) => state.comments[id]).filter(Boolean));
      if (m[2] === 'comments' && method === 'POST') {
        const c = { id: state.nextComment++, body: body.body, user: { login: APP_LOGIN }, performed_via_github_app: { id: Number(APP_ID), slug: APP_SLUG } };
        state.comments[c.id] = c;
        pr.comments.push(c.id);
        return { statusCode: 201, headers: {}, body: c };
      }
      if (m[2] === 'labels' && method === 'GET') return { statusCode: 200, headers: {}, body: pr.labels.map((name) => ({ name })) };
      if (m[2] === 'labels' && method === 'POST') {
        for (const name of body.labels) if (!pr.labels.includes(name)) { pr.labels.push(name); event(pr, 'labeled', name, APP_LOGIN); }
        return { statusCode: 200, headers: {}, body: pr.labels.map((name) => ({ name })) };
      }
      if (m[2] === 'labels' && method === 'DELETE') {
        const name = decodeURIComponent(m[3]);
        if (!pr.labels.includes(name)) return { statusCode: 404, headers: {}, body: {} };
        pr.labels = pr.labels.filter((n) => n !== name);
        event(pr, 'unlabeled', name, APP_LOGIN);
        return { statusCode: 200, headers: {}, body: pr.labels.map((n) => ({ name: n })) };
      }
    }
    if ((m = p.match(/^\/issues\/comments\/(\d+)$/))) {
      const c = state.comments[m[1]];
      if (!c || state.gone.has(Number(m[1]))) return { statusCode: 404, headers: {}, body: {} };
      if (method === 'PATCH') c.body = body.body;
      return { statusCode: 200, headers: {}, body: JSON.parse(JSON.stringify(c)) };
    }
    if (method === 'POST' && (m = p.match(/^\/statuses\/([0-9a-f]{40})$/))) {
      const s = Object.assign({ creator: { login: APP_LOGIN } }, body);
      (state.statuses[m[1]] = state.statuses[m[1]] || []).unshift(s);
      return { statusCode: 201, headers: {}, body: s };
    }
    if (method === 'GET' && (m = p.match(/^\/commits\/([0-9a-f]{40})\/statuses$/))) return { statusCode: 200, headers: {}, body: state.statuses[m[1]] || [] };
    return { statusCode: 404, headers: {}, body: {} };
  };
  const pr = (number, headSha, extra) => {
    state.prs[number] = Object.assign({ number, head_sha: headSha, labels: [], events: [], comments: [], user: 'renovate[bot]', title: `chore(deps): update thing ${number}`, created_at: '2026-11-10T00:00:00Z' }, extra || {});
    return state.prs[number];
  };
  // A person adds or removes a label.
  const person = (number, ev, name) => {
    const p = state.prs[number];
    if (ev === 'labeled' && !p.labels.includes(name)) p.labels.push(name);
    if (ev === 'unlabeled') p.labels = p.labels.filter((n) => n !== name);
    event(p, ev, name, 'a-person');
  };
  // A new commit (Renovate force-pushes).
  const push = (number, headSha) => {
    const p = state.prs[number];
    p.head_sha = headSha;
    event(p, 'head_ref_force_pushed', null, 'renovate[bot]');
  };
  return { state, github, pr, person, push };
}

function env() {
  const db = h.newDb();
  db.config = { 'github-app-id': APP_ID, 'github-app-installation-id': INSTALLATION };
  const gh = makeGithub(db);
  // A verdict the poll already holds for a head SHA (as if triaged earlier).
  const verdict = (number, headSha, v, ruleset, reasons) => db.verdicts.push({
    repo: REPO, pr: number, head_sha: headSha, verdict: v, ruleset: ruleset || RS1, reasons: reasons || ['low-risk conditions not all met'], created: h.iso(db.clock - 60000), finalised: false,
  });
  const poll = (o) => {
    const before = gh.state.requests.length;
    return h.runPoll(Object.assign({ db, github: gh.github, repo: REPO, ruleset: RS1, config: LABELS_TEXT, patterns: PATTERNS }, o || {})).then((r) => {
      r.requests = gh.state.requests.slice(before);
      r.writes = r.requests.filter((q) => q.method !== 'GET').map((q) => `${q.method} ${q.url.replace(/^https:\/\/api\.github\.com/, '')}`);
      r.appCalls = r.requests.filter((q) => q.auth === 'token' || q.auth === 'Bearer');
      return r;
    });
  };
  const triageComments = (number) => gh.state.prs[number].comments.map((id) => gh.state.comments[id]).filter((c) => rules.parseMarker(c.body));
  const managed = (number) => gh.state.prs[number].labels.filter((n) => rules.managedLabels(CONFIG).includes(n));
  const status = (headSha) => (gh.state.statuses[headSha] || [])[0] || null;
  return { db, gh, verdict, poll, triageComments, managed, status };
}

const S = { a: sha('a'), b: sha('b'), c: sha('c'), d: sha('d'), e: sha('e') };

// ------------------------------------------------------------ the state machine end to end

test('each verdict gets its label, one comment and one status; the next run writes nothing', async () => {
  const t = env();
  const vs = ['low-risk', 'review', 'deep-review', 'human', 'blocked'];
  vs.forEach((v, i) => { t.gh.pr(300 + i, Object.values(S)[i]); t.verdict(300 + i, Object.values(S)[i], v); });
  const r = await t.poll();
  assert.equal(r.run.publish, 'published', JSON.stringify(r.plans.map((p) => [p.pr, p.outcome, p.reason])));
  assert.equal(r.run.ok, true);
  assert.equal(r.calls.filter((c) => c.kind === 'jwt').length, r.writes.length - r.writes.filter((w) => w.includes('access_tokens')).length);
  vs.forEach((v, i) => {
    const n = 300 + i;
    assert.deepEqual(t.managed(n), [`triage:${v}`]);
    const cs = t.triageComments(n);
    assert.equal(cs.length, 1);
    assert.ok(cs[0].body.startsWith(`<!-- pr-triage:v1 sha=${Object.values(S)[i]} ruleset=${RS1} verdict=${v} -->\n`));
    assert.ok(!/#\d/.test(cs[0].body), 'no # references');
    const st = t.status(Object.values(S)[i]);
    assert.equal(st.context, 'pr-triage/verdict');
    assert.equal(st.state, rules.STATUS_STATES[v]);
  });
  assert.deepEqual(['low-risk', 'blocked'].map((v) => rules.STATUS_STATES[v]), ['success', 'failure']);
  // Labels created once, each before it is added.
  assert.equal(r.writes.filter((w) => w === 'POST /repos/dazzathewiz/fluxcd/labels').length, 5);
  const db = t.db.publications[`${REPO}#301@${S.b}`];
  assert.deepEqual([db.verdict, db.ruleset, db.label, db.status_state, db.outcome], ['review', RS1, 'triage:review', 'pending', 'published']);
  assert.ok(!('app_login' in db), 'the login comes from config, never stored');
  assert.equal(db.comment_id, t.triageComments(301)[0].id);

  const again = await t.poll();
  assert.deepEqual(again.writes, []);
  assert.deepEqual(again.appCalls, [], 'no token is even requested');
  assert.equal(again.run.publish, 'no-op');
  assert.ok(again.plans.every((p) => p.outcome === 'up-to-date'));
});

test('same verdict under a new ruleset: the comment is edited in place and the status re-set, no label change', async () => {
  const t = env();
  t.gh.pr(310, S.a);
  t.verdict(310, S.a, 'review');
  await t.poll();
  const [c1] = t.triageComments(310);
  t.verdict(310, S.a, 'review', RS2);
  const r = await t.poll({ ruleset: RS2 });
  assert.deepEqual(r.writes.filter((w) => !w.includes('access_tokens')), [
    `PATCH /repos/${REPO}/issues/comments/${c1.id}`,
    `POST /repos/${REPO}/statuses/${S.a}`,
  ]);
  const [c2] = t.triageComments(310);
  assert.equal(c2.id, c1.id);
  assert.match(c2.body, new RegExp(`ruleset=${RS2} verdict=review`));
  assert.deepEqual(t.managed(310), ['triage:review']);
});

test('changed verdict: the label is swapped, merge is removed, and a new comment is posted', async () => {
  const t = env();
  t.gh.pr(320, S.a);
  t.verdict(320, S.a, 'review');
  await t.poll();
  // An outcome label the App applied (no human event): rule 4 removes it.
  const p = t.gh.state.prs[320];
  p.labels.push('merge');
  p.events.push({ id: 1, event: 'labeled', label: { name: 'merge' }, actor: { login: APP_LOGIN }, created_at: h.iso(t.db.clock) });
  t.verdict(320, S.a, 'deep-review', RS2, ['deep-review package: postgres']);
  const [old] = t.triageComments(320);
  const r = await t.poll({ ruleset: RS2 });
  assert.deepEqual(r.writes.filter((w) => !w.includes('access_tokens')), [
    `POST /repos/${REPO}/issues/320/comments`,
    `POST /repos/${REPO}/statuses/${S.a}`,
    `POST /repos/${REPO}/labels`,
    `DELETE /repos/${REPO}/issues/320/labels/triage%3Areview`,
    `DELETE /repos/${REPO}/issues/320/labels/merge`,
    `POST /repos/${REPO}/issues/320/labels`,
  ]);
  assert.deepEqual(t.managed(320), ['triage:deep-review']);
  const cs = t.triageComments(320);
  assert.equal(cs.length, 2);
  assert.equal(cs[0].id, old.id, 'the old comment stays as history');
  assert.match(cs[1].body, /verdict=deep-review -->/);
  assert.match(cs[1].body, /- deep-review package: postgres/);
  assert.equal(t.status(S.a).state, 'pending');
  assert.equal(t.status(S.a).description, 'deep-review: needs a deep review before merge');
});

test('new head SHA: verdict and outcome labels are reset, the override ends, and it is triaged fresh', async () => {
  const t = env();
  t.gh.pr(330, S.a);
  t.verdict(330, S.a, 'review');
  await t.poll();
  // A person applies merge-watched on the first commit: an override for it.
  t.gh.person(330, 'labeled', 'merge-watched');
  const held = await t.poll();
  assert.deepEqual(held.writes, []);
  assert.equal(t.db.publications[`${REPO}#330@${S.a}`].human_override, true);
  assert.equal(t.db.publications[`${REPO}#330@${S.a}`].override_label, 'merge-watched');
  // Renovate pushes a new commit, triaged low-risk.
  t.gh.push(330, S.b);
  t.verdict(330, S.b, 'low-risk', RS1, ['all low-risk conditions hold']);
  const r = await t.poll();
  assert.deepEqual(r.writes.filter((w) => !w.includes('access_tokens')), [
    `POST /repos/${REPO}/issues/330/comments`,
    `POST /repos/${REPO}/statuses/${S.b}`,
    `POST /repos/${REPO}/labels`,
    `DELETE /repos/${REPO}/issues/330/labels/triage%3Areview`,
    `DELETE /repos/${REPO}/issues/330/labels/merge-watched`,
    `POST /repos/${REPO}/issues/330/labels`,
  ]);
  assert.deepEqual(t.managed(330), ['triage:low-risk']);
  const pub = t.db.publications[`${REPO}#330@${S.b}`];
  assert.equal(pub.human_override, false, 'a new head SHA ends the override');
  assert.equal(t.status(S.b).state, 'success');
  assert.match(t.triageComments(330).pop().body, new RegExp(`sha=${S.b} `));
});

test('human-added label: no label writes on that SHA, and a ruleset change only edits the comment', async () => {
  const t = env();
  t.gh.pr(340, S.a);
  t.verdict(340, S.a, 'review');
  await t.poll();
  t.gh.person(340, 'labeled', 'triage:deep-review');
  // The changed verdict would swap the label, but the person owns the labels now.
  t.verdict(340, S.a, 'low-risk', RS2, ['all low-risk conditions hold']);
  const r = await t.poll({ ruleset: RS2 });
  const [c] = t.triageComments(340);
  assert.deepEqual(r.writes.filter((w) => !w.includes('access_tokens')), [`PATCH /repos/${REPO}/issues/comments/${c.id}`]);
  assert.match(c.body, /changed by hand/);
  assert.ok(!c.body.includes('a-person'), 'the actor is evidence in the database, never in the comment');
  assert.deepEqual(t.managed(340).sort(), ['triage:deep-review', 'triage:review']);
  const pub = t.db.publications[`${REPO}#340@${S.a}`];
  assert.deepEqual([pub.human_override, pub.override_actor, pub.override_label], [true, 'a-person', 'triage:deep-review']);
  assert.equal(r.plans[0].status, null, 'no status under an override');
});

test('human-removed label: it is not re-added', async () => {
  const t = env();
  t.gh.pr(350, S.a);
  t.verdict(350, S.a, 'low-risk', RS1, ['all low-risk conditions hold']);
  await t.poll();
  t.gh.person(350, 'unlabeled', 'triage:low-risk');
  const r = await t.poll();
  assert.deepEqual(r.writes, []);
  t.verdict(350, S.a, 'review', RS2);
  const again = await t.poll({ ruleset: RS2 });
  assert.ok(!again.writes.some((w) => /labels/.test(w)), JSON.stringify(again.writes));
  assert.deepEqual(t.managed(350), []);
});

test('merge-watched applied by a person survives a same-verdict re-triage', async () => {
  const t = env();
  t.gh.pr(360, S.a);
  t.verdict(360, S.a, 'review');
  await t.poll();
  t.gh.person(360, 'labeled', 'merge-watched');
  t.verdict(360, S.a, 'review', RS2);
  const r = await t.poll({ ruleset: RS2 });
  assert.ok(!r.writes.some((w) => /labels/.test(w)));
  assert.deepEqual(t.managed(360).sort(), ['merge-watched', 'triage:review']);
});

test('escalation never downgrades a head SHA', async () => {
  const t = env();
  t.gh.pr(370, S.a);
  t.verdict(370, S.a, 'deep-review', RS1, ['touches CRDs']);
  await t.poll();
  t.verdict(370, S.a, 'review', RS2);
  const r = await t.poll({ ruleset: RS2 });
  assert.equal(r.plans[0].verdict, 'deep-review');
  assert.equal(r.plans[0].triaged_verdict, 'review');
  assert.ok(!r.writes.some((w) => /labels/.test(w)), 'no label change');
  assert.deepEqual(t.managed(370), ['triage:deep-review']);
  assert.match(t.triageComments(370)[0].body, /Held at `deep-review`: this ruleset gave `review`/);
  for (const [published, triaged] of [['blocked', 'low-risk'], ['human', 'deep-review'], ['review', 'low-risk']]) {
    assert.ok(rules.SEVERITY.indexOf(published) > rules.SEVERITY.indexOf(triaged));
  }
});

test('an unhealthy run publishes nothing', async () => {
  for (const o of [{ cluster: { statusCode: 401, headers: {}, body: {} } }, { patterns: [] }]) {
    const t = env();
    t.gh.pr(380, S.a);
    t.verdict(380, S.a, 'review');
    const r = await t.poll(o);
    assert.deepEqual(r.writes, []);
    assert.deepEqual(r.appCalls, []);
    assert.equal(r.run.publish, 'skipped-unhealthy');
    assert.equal(r.plans[0].outcome, 'skipped-unhealthy');
  }
});

test('a redaction hit publishes nothing and records only a count', async () => {
  const t = env();
  t.gh.pr(390, S.a);
  t.verdict(390, S.a, 'review');
  const r = await t.poll({ patterns: ['/needs a review/'] });
  assert.deepEqual(r.writes, []);
  assert.equal(r.run.publish, 'redaction-hit');
  assert.equal(r.plans[0].outcome, 'redaction-hit');
  assert.equal(r.plans[0].matched_patterns, 1, 'patterns that matched, never the text');
  assert.deepEqual(r.plans[0].actions, []);
  assert.ok(!JSON.stringify(t.db.publications).includes('needs a review/'));
});

test('a stored comment_id that 404s falls back to the marker in the paged comments', async () => {
  const t = env();
  t.gh.pr(400, S.a);
  t.verdict(400, S.a, 'review');
  await t.poll();
  const [c] = t.triageComments(400);
  // The database lost track: it names a comment that is gone.
  t.db.publications[`${REPO}#400@${S.a}`].comment_id = 999999;
  t.gh.state.gone.add(999999);
  t.verdict(400, S.a, 'review', RS2);
  const r = await t.poll({ ruleset: RS2 });
  assert.ok(r.requests.some((q) => q.method === 'GET' && q.url.endsWith('/issues/comments/999999')));
  assert.ok(r.requests.some((q) => q.method === 'GET' && q.url.includes('/issues/400/comments?per_page=100')));
  assert.ok(r.writes.includes(`PATCH /repos/${REPO}/issues/comments/${c.id}`));
  assert.ok(!r.writes.includes(`POST /repos/${REPO}/issues/400/comments`));
  assert.equal(t.db.publications[`${REPO}#400@${S.a}`].comment_id, c.id);
});

test('the paged comments are read only when the stored comment is not usable', async () => {
  const t = env();
  t.gh.pr(405, S.a);
  t.verdict(405, S.a, 'review');
  await t.poll();
  t.verdict(405, S.a, 'review', RS2);
  const r = await t.poll({ ruleset: RS2 });
  assert.ok(!r.requests.some((q) => q.url.includes('/issues/405/comments?')));
});

test('label events over 3 pages: the human override on the last page is still found', async () => {
  const t = env();
  t.gh.pr(410, S.a);
  t.verdict(410, S.a, 'review');
  await t.poll();
  t.gh.state.pageSize = 2;
  for (let i = 0; i < 3; i++) t.gh.state.prs[410].events.push({ id: 10 + i, event: 'renamed', actor: { login: 'renovate[bot]' }, created_at: h.iso(t.db.clock) });
  t.gh.person(410, 'labeled', 'triage:blocked');
  assert.equal(t.gh.state.prs[410].events.length, 5);
  t.verdict(410, S.a, 'low-risk', RS2, ['all low-risk conditions hold']);
  const r = await t.poll({ ruleset: RS2 });
  const pages = r.requests.filter((q) => q.url.includes('/issues/410/events'));
  assert.equal(pages.length, 3);
  assert.ok(!r.writes.some((w) => /labels/.test(w)));
  assert.equal(r.plans[0].human_override, true);
  assert.equal(r.plans[0].override_label, 'triage:blocked');
});

test('label events cut off by the page limit publish nothing for that PR', () => {
  const pages = [{ statusCode: 200, headers: { link: '<https://api.github.com/repositories/1/issues/2/events?page=11>; rel="next"' }, body: [] }];
  assert.equal(rules.pagedItems(pages), null);
  assert.equal(rules.pagedItems([{ statusCode: 502, headers: {}, body: '' }]), null);
  assert.deepEqual(rules.pagedItems([{ statusCode: 200, headers: {}, body: [1] }, { statusCode: 200, headers: {}, body: [2] }]), [1, 2]);
});

test('write_mode off: planned-only, the plan is stored, and no App call is made', async () => {
  const t = env();
  t.gh.pr(420, S.a);
  t.verdict(420, S.a, 'review');
  const r = await t.poll({ config: OFF_TEXT });
  assert.deepEqual(r.writes, []);
  assert.deepEqual(r.appCalls, []);
  assert.deepEqual(r.calls, [], 'the JWT is never signed');
  assert.equal(r.run.publish, 'planned-only');
  assert.equal(r.run.ok, true);
  const pub = t.db.publications[`${REPO}#420@${S.a}`];
  assert.equal(pub.outcome, 'planned-only');
  assert.equal(pub.verdict, undefined, 'nothing is recorded as published');
  assert.deepEqual(pub.planned.actions.map((a) => a.type), ['create_comment', 'set_status', 'ensure_label', 'add_label']);
  assert.equal(r.out['Write gate'].length, 0);
});

test('a failed write never blocks: the run records failed, clears its ETags, and the next run converges', async () => {
  const t = env();
  t.gh.pr(430, S.a);
  t.verdict(430, S.a, 'review');
  t.gh.state.failWrites = true;
  const r = await t.poll();
  assert.equal(r.run.publish, 'failed');
  assert.equal(r.run.ok, false);
  assert.deepEqual(r.run.list_etags, {});
  assert.equal(t.db.publications[`${REPO}#430@${S.a}`].verdict, undefined);
  t.gh.state.failWrites = false;
  const retry = await t.poll();
  assert.equal(retry.run.publish, 'published');
  assert.deepEqual(t.managed(430), ['triage:review']);
  assert.equal(t.triageComments(430).length, 1);
  assert.equal((await t.poll()).writes.length, 0);
});

test('a PR triaged in the same run is planned from its fresh verdict (the caddy fixture)', async () => {
  const t = env();
  const fx = JSON.parse(read('triage/fixtures/caddy-patch.json'));
  const f = fx.facts;
  t.gh.pr(f.pr.number, f.pr.head_sha, { title: f.pr.title, created_at: f.pr.created_at });
  const gh = t.gh.github;
  // The fixture's files and body; everything else from the stub.
  const github = (method, url, body, headers) => {
    if (url === `${API}/pulls/${f.pr.number}/files?per_page=100`) return { statusCode: 200, headers: { etag: f.files.etag }, body: f.files.items };
    const r = gh(method, url, body, headers);
    if (url === `${API}/pulls/${f.pr.number}`) Object.assign(r, { headers: { etag: f.pr.etag } }).body.body = f.pr.body;
    if (url.startsWith(`${API}/issues?state=open`)) return { statusCode: 200, headers: {}, body: [{ title: 'Dependency Dashboard', html_url: f.dashboard.url, body: f.dashboard.body, updated_at: 'x' }] };
    return r;
  };
  const r = await h.runPoll({ db: t.db, github, repo: REPO, ruleset: RS1, config: LABELS_TEXT, patterns: PATTERNS, external: async (o) => fx.http[o.url] || { statusCode: 404, headers: {}, body: '' } });
  assert.equal(r.runItem.triaged, 1);
  assert.equal(r.plans[0].verdict, 'low-risk', JSON.stringify(r.plans[0]));
  assert.deepEqual(t.managed(f.pr.number), ['triage:low-risk']);
  const body = t.triageComments(f.pr.number)[0].body;
  assert.match(body, /\*\*Check outside the repo\*\*\n- media-serving \(inventory app\): after rollout/);
});

// ------------------------------------------------------------ planPublish directly

const ctx = (o) => Object.assign({ config: CONFIG, healthy: true, patterns: PATTERNS, app_id: APP_ID, installation_id: INSTALLATION }, o || {});
const prState = (o) => Object.assign({ repo: REPO, number: 5, head_sha: S.a, state: 'open', labels: [], repo_labels: [], since: null, comments: { stored_id: null, stored: null, list: [{ statusCode: 200, headers: {}, body: [] }] } }, o || {});
const noEvents = [{ statusCode: 200, headers: {}, body: [] }];
const v = (verdict, ruleset) => ({ verdict, reasons: [], ruleset: ruleset || RS1 });

test('planPublish: skips name their reason, and malformed input writes nothing', () => {
  const skip = (args, reason) => assert.equal(rules.planPublish(...args).reason, reason);
  skip([prState(), v('review'), null, noEvents, APP_LOGIN, ctx({ healthy: false })], 'unhealthy');
  skip([prState(), v('review'), null, noEvents, APP_LOGIN, ctx({ patterns: ['/(/'] })], 'unhealthy');
  skip([prState({ state: 'closed' }), v('review'), null, noEvents, APP_LOGIN, ctx()], 'closed');
  skip([prState({ draft: true }), v('review'), null, noEvents, APP_LOGIN, ctx()], 'draft');
  skip([prState(), null, null, noEvents, APP_LOGIN, ctx()], 'no-verdict');
  skip([prState(), v('needs-claude'), null, noEvents, APP_LOGIN, ctx()], 'no-verdict');
  skip([prState(), v('review'), null, null, APP_LOGIN, ctx()], 'label-events-incomplete');
  skip([prState({ comments: { stored_id: 9, stored: { statusCode: 502 }, list: null } }), v('review'), null, noEvents, APP_LOGIN, ctx()], 'comments-incomplete');
  skip([prState({ head_sha: 'nope' }), v('review'), null, noEvents, APP_LOGIN, ctx()], 'bad-input');
  skip([prState(), v('review'), null, noEvents, APP_LOGIN, ctx({ config: rules.loadConfig(LABELS_TEXT), app_id: null })], 'no-app');
  assert.equal(rules.planPublish(prState(), v('review'), null, noEvents, APP_LOGIN, ctx({ app_id: null })).action, 'publish', 'off plans without the App');
});

test('planPublish: only the App\'s own comments count, and the App\'s own label events are not overrides', () => {
  const marker = rules.publishMarker(S.a, RS1, 'review');
  const theirs = { id: 7, body: `${marker}\nfake`, user: { login: 'someone' }, performed_via_github_app: null };
  const p = rules.planPublish(prState({ comments: { stored_id: null, stored: null, list: [{ statusCode: 200, headers: {}, body: [theirs] }] } }), v('review'), null, noEvents, APP_LOGIN, ctx());
  assert.equal(p.actions[0].type, 'create_comment');
  const ev = [{ statusCode: 200, headers: {}, body: [{ event: 'labeled', label: { name: 'triage:review' }, actor: { login: APP_LOGIN }, created_at: '2026-11-01T00:00:00Z' }] }];
  assert.equal(rules.planPublish(prState(), v('review'), null, ev, APP_LOGIN, ctx()).human_override, false);
  assert.equal(rules.planPublish(prState(), v('review'), null, ev, 'someone-else[bot]', ctx()).reason, 'bad-input', 'the login always comes from config');
  const person = [{ statusCode: 200, headers: {}, body: [{ event: 'labeled', label: { name: 'triage:review' }, actor: { login: 'a-person' }, created_at: '2026-11-01T00:00:00Z' }] }];
  assert.equal(rules.planPublish(prState(), v('review'), null, person, APP_LOGIN, ctx()).human_override, true);
  const other = [{ statusCode: 200, headers: {}, body: [{ event: 'labeled', label: { name: 'bug' }, actor: { login: 'a-person' }, created_at: '2026-11-01T00:00:00Z' }] }];
  assert.equal(rules.planPublish(prState({ labels: ['bug'] }), v('review'), null, other, APP_LOGIN, ctx()).human_override, false, 'other labels are not ours');
  assert.ok(!rules.planPublish(prState({ labels: ['bug'] }), v('review'), null, noEvents, APP_LOGIN, ctx()).actions.some((a) => a.name === 'bug'), 'never touches another label');
});

test('planPublish: events before the window belong to an earlier commit', () => {
  const ev = [{ statusCode: 200, headers: {}, body: [{ event: 'labeled', label: { name: 'merge' }, actor: { login: 'a-person' }, created_at: '2026-11-01T00:00:00Z' }] }];
  assert.equal(rules.planPublish(prState({ since: '2026-11-02T00:00:00Z' }), v('review'), null, ev, APP_LOGIN, ctx()).human_override, false);
  assert.equal(rules.planPublish(prState({ since: '2026-10-31T00:00:00Z' }), v('review'), null, ev, APP_LOGIN, ctx()).human_override, true);
  assert.equal(rules.headSince({ [S.a]: '2026-11-03T00:00:00Z', [S.b]: '2026-11-05T00:00:00Z' }, S.b, [{ event: 'head_ref_force_pushed', created_at: '2026-11-04T00:00:00Z' }]), '2026-11-04T00:00:00Z');
  assert.equal(rules.headSince({}, S.b, []), null);
});

test('comment body: marker first, fixed templates, no # references, byte-stable', () => {
  const input = { head_sha: S.a, ruleset: RS1, verdict: 'review', triaged_verdict: 'review', reasons: ['R6 release-note keywords: breaking', 'free text about PR #12 from @someone', 'dependant intake-script (x): y'] };
  const a = rules.renderTriageComment(input, CONFIG);
  assert.equal(a, rules.renderTriageComment(JSON.parse(JSON.stringify(input)), CONFIG));
  assert.ok(a.startsWith(`<!-- pr-triage:v1 sha=${S.a} ruleset=${RS1} verdict=review -->\n`));
  assert.deepEqual(rules.parseMarker(a), { sha: S.a, ruleset: RS1, verdict: 'review' });
  assert.ok(a.includes('- other reason (see triage.verdicts)'));
  assert.ok(!a.includes('@someone') && !/#\d/.test(a));
  assert.ok(a.includes(`- intake-script (off-repo operator workspace): ${CONFIG.dependants['inventree/inventree'][0].check}`));
});

// ------------------------------------------------------------ the SQL the harness models

const poll = (name) => h.nodeOf(h.POLL, name);

test('Record plan upserts the plan per head SHA and never touches the published columns', () => {
  const q = squash(poll('Record plan').parameters.query);
  assert.match(q, /INSERT INTO triage\.publications \(repo, pr, head_sha, planned, planned_at, run_id, outcome, human_override, override_actor, override_label\)/);
  assert.match(q, /ON CONFLICT \(repo, pr, head_sha\) DO UPDATE/);
  assert.match(q, /human_override = triage\.publications\.human_override OR excluded\.human_override/);
  const set = q.slice(q.indexOf('DO UPDATE'));
  for (const col of ['verdict', 'ruleset', 'label', 'comment_id', 'status_state', 'published_at']) assert.ok(!new RegExp(`\\b${col} =`).test(set), col);
});

test('Record publish moves the published columns only on published, from the stored plan', () => {
  const q = squash(poll('Record publish').parameters.query);
  for (const [col, src] of [['verdict', "p.planned ->> 'verdict'"], ['ruleset', "p.planned ->> 'ruleset'"], ['label', "p.planned ->> 'label'"]]) {
    assert.ok(q.includes(`${col} = CASE WHEN $5 = 'published' THEN ${src} ELSE p.${col} END`), col);
  }
  assert.ok(q.includes("published_at = CASE WHEN $5 = 'published' THEN now() ELSE p.published_at END"));
  assert.ok(q.includes('WHERE p.run_id = $1 AND p.repo = $2 AND p.pr = $3 AND p.head_sha = $4'));
});

test('Finish run sums the plans into runs.publish, the values rules.js names', () => {
  const q = squash(poll('Finish run').parameters.query);
  assert.ok(q.includes("WHEN $5 = 'off' THEN 'planned-only'"));
  assert.ok(q.includes("WHEN NOT $6::boolean THEN 'skipped-unhealthy'"));
  assert.ok(q.includes("ok = $3 AND s.publish <> 'failed'"));
  assert.ok(q.includes("list_etags = CASE WHEN s.publish = 'failed' THEN '{}'::jsonb ELSE $4::jsonb END"));
  for (const o of rules.RUN_PUBLISH) {
    assert.ok(q.includes(`'${o}'`), o);
    assert.ok(read('triage/schema.sql').includes(o), `schema comment names ${o}`);
  }
});

test('Start run gives the plans what they need, and the schema and grants hold it', () => {
  const q = squash(poll('Start run').parameters.query);
  for (const k of ['publications', 'sha_seen', 'current_verdicts', 'app_id', 'installation_id']) assert.match(q, new RegExp(`\\) AS ${k}[, ]`), k);
  assert.match(q, /AND \(v\.ruleset = run\.ruleset OR v\.finalised_at IS NOT NULL\)/);
  const sql = read('triage/schema.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS triage\.publications \(/);
  assert.match(sql, /PRIMARY KEY \(repo, pr, head_sha\)/);
  assert.match(sql, /ALTER TABLE triage\.runs ADD COLUMN IF NOT EXISTS publish text;/);
  const grants = read('triage/roles.sql').split('\n').filter((l) => /^GRANT .*triage\.publications/.test(l));
  assert.deepEqual(grants, ['GRANT SELECT, INSERT, UPDATE ON triage.publications TO triage;']);
});

test('the rename migrates rows and reasons idempotently, and the old verdict is gone', () => {
  const sql = squash(read('triage/schema.sql'));
  assert.ok(sql.includes("UPDATE triage.verdicts SET verdict = 'deep-review' WHERE verdict = 'needs-claude';"));
  assert.ok(sql.includes("replace(replace(r, 'package needs Claude: ', 'deep-review package: '), 'needs-claude', 'deep-review')"));
  assert.ok(sql.indexOf('DROP CONSTRAINT IF EXISTS verdicts_verdict_check') < sql.indexOf("SET verdict = 'deep-review'"));
  assert.ok(!rules.VERDICTS.includes('needs-claude'));
  assert.throws(() => rules.loadConfig(CONFIG_TEXT.replace('deep_review_packages:', 'needs_claude_packages:')), /unknown key\(s\) needs_claude_packages/);
});

test('config: labels is a valid write_mode, digest is not, and the label names are pinned to rule 1', () => {
  assert.equal(rules.loadConfig(LABELS_TEXT).write_mode, 'labels');
  assert.deepEqual(rules.WRITE_MODES, ['off', 'labels']);
  assert.throws(() => rules.loadConfig(withWriteMode(CONFIG_TEXT, 'digest')), /write_mode/);
  assert.throws(() => rules.loadConfig(CONFIG_TEXT.replace('review: "triage:review"', 'review: "bug"')), /triage:review/);
  assert.throws(() => rules.loadConfig(CONFIG_TEXT.replace('outcome_labels: [merge, merge-watched]', 'outcome_labels: [merge, bug]')), /outcome_labels/);
  assert.deepEqual(rules.managedLabels(CONFIG), ['triage:blocked', 'triage:deep-review', 'triage:review', 'triage:low-risk', 'triage:human', 'merge', 'merge-watched']);
  assert.equal(CONFIG.status_context, 'pr-triage/verdict');
});

// ------------------------------------------------------------ secrets and the sub-workflow

test('the App key comes from 1Password base64, is decoded in the template, and checked as an RSA PEM without printing it', () => {
  const es = read('externalsecret.yaml');
  assert.match(es, /"jwtAuth":\{"privateKey":\{\{ \.GITHUB_APP_PRIVATE_KEY_B64 \| b64dec \| toJson \}\}\}/);
  for (const f of ['github-app-id', 'github-app-installation-id', 'github-app-private-key-b64']) assert.match(es, new RegExp(`property: ${f}\\n`));
  const cred = JSON.parse(read('credentials/github-app-jwt.json'));
  assert.deepEqual(cred.data, { keyType: 'pemKey', algorithm: 'RS256', privateKey: '', publicKey: '' });
  const dep = read('deployment.yaml');
  assert.ok(dep.includes('k.startsWith("-----BEGIN") && require("crypto").createPrivateKey(k).asymmetricKeyType === "rsa"'));
  const check = dep.slice(dep.indexOf('node -e'), dep.indexOf('n8n import:credentials'));
  assert.ok(!/console\.(log|error)\([^)]*\bk\b/.test(check), 'the key is never printed');
  assert.ok(dep.indexOf('createPrivateKey') < dep.indexOf('n8n import:credentials'));
  assert.match(dep, /n8n publish:workflow --id=TriagePublishV01/);
  assert.match(read('kustomization.yaml'), /- workflows\/triage-publish\.json\n[\s\S]*- credentials\/github-app-jwt\.json/);
});

test('the sub-workflow saves nothing, only the poll and the watcher may call it, and it returns no token', () => {
  const s = h.PUBLISH.settings;
  assert.deepEqual([s.saveDataSuccessExecution, s.saveDataErrorExecution, s.saveManualExecutions, s.saveExecutionProgress], ['none', 'none', false, false]);
  assert.deepEqual([s.callerPolicy, s.callerIds], ['workflowsFromAList', 'TriagePoll000001,TriageWatch00001']);
  const jwt = h.nodeOf(h.PUBLISH, 'Sign App JWT');
  assert.deepEqual([jwt.type, jwt.parameters.operation, jwt.parameters.options.algorithm], ['n8n-nodes-base.jwt', 'sign', 'RS256']);
  const db = h.newDb();
  const gh = makeGithub(db);
  gh.pr(5, S.a);
  const calls = [];
  const out = h.runPublish({ kind: 'action', type: 'add_label', name: 'triage:review', run_id: 1, repo: REPO, pr: 5, head_sha: S.a, app_id: APP_ID, installation_id: INSTALLATION, app_slug: APP_SLUG, index: 0, count: 1 }, gh.github, calls);
  assert.equal(out[0].json.ok, true);
  assert.ok(!JSON.stringify(out).includes('inst-token-1') && !JSON.stringify(out).includes('jwt-for-test'));
  assert.deepEqual(Object.keys(out[0].json).sort(), ['app_ok', 'app_status', 'comment_id', 'head_sha', 'index', 'name', 'ok', 'pr', 'readback_status', 'repo', 'run_id', 'token_status', 'type', 'write_status']);
  assert.deepEqual(calls[0].claims.iss, 4242);
  assert.ok(calls[0].claims.exp - calls[0].claims.iat <= 600, 'GitHub allows at most 10 minutes');
  const token = gh.state.requests.find((q) => q.url.endsWith('/access_tokens'));
  assert.deepEqual(token.body, { repositories: ['fluxcd'], permissions: { issues: 'write', pull_requests: 'write', statuses: 'write', metadata: 'read' } });
  // A name outside rule 1 never reaches the label path.
  const bad = h.runPublish({ kind: 'action', type: 'remove_label', name: 'bug', run_id: 1, repo: REPO, pr: 5, head_sha: S.a, app_id: APP_ID, installation_id: INSTALLATION, app_slug: APP_SLUG, index: 0, count: 1 }, gh.github, []);
  assert.equal(bad[0].json.ok, false);
  assert.ok(!gh.state.requests.some((q) => q.method === 'DELETE' && q.url.includes('/labels/bug')));
  // R10's label writes take only its two labels, and the triage writes never take them.
  const act = (type, name) => h.runPublish({ kind: 'action', type, name, color: '0e8a16', description: 'd', run_id: 1, repo: REPO, pr: 5, head_sha: S.a, app_id: APP_ID, installation_id: INSTALLATION, app_slug: APP_SLUG, index: 0, count: 1 }, gh.github, [])[0].json;
  assert.equal(act('watch_ensure_label', 'triage:post-merge-ok').ok, true);
  assert.equal(act('watch_add_label', 'triage:post-merge-ok').ok, true);
  assert.ok(gh.state.prs[5].labels.includes('triage:post-merge-ok'));
  for (const [type, name] of [['watch_add_label', 'triage:review'], ['watch_add_label', 'merge'], ['add_label', 'triage:post-merge-failed'], ['watch_ensure_label', 'bug']]) {
    const n = gh.state.requests.length;
    assert.equal(act(type, name).ok, false, `${type} ${name}`);
    assert.ok(!gh.state.requests.slice(n).some((q) => q.method === 'POST' && q.url.includes('/labels') && JSON.stringify(q.body).includes(name)), `${type} ${name} reached GitHub`);
  }
  // A failed token exchange writes nothing.
  const before = gh.state.requests.length;
  const none = h.runPublish({ kind: 'action', type: 'create_comment', body: 'x', run_id: 1, repo: REPO, pr: 5, head_sha: S.a, app_id: APP_ID, installation_id: '1', app_slug: APP_SLUG, index: 0, count: 1 }, gh.github, []);
  assert.equal(none[0].json.ok, false);
  assert.deepEqual(gh.state.requests.slice(before).map((q) => `${q.method} ${q.url}`), ['GET https://api.github.com/app', 'POST https://api.github.com/app/installations/1/access_tokens']);
});

// ------------------------------------------------------------ allowlist

const clone = (x) => JSON.parse(JSON.stringify(x));
const LABELS = rules.managedLabels(CONFIG);
const WATCH_LABELS = Object.values(rules.WATCH_LABELS);
const problems = (wf) => checkWrites(wf, LABELS, CONFIG.status_context, WATCH_LABELS).problems.join('\n');
const WATCH = JSON.parse(read('workflows/triage-watch.json'));

test('allowlist: exactly the nine writes, all in the sub-workflow, reached through the gate', () => {
  const pub = checkWrites(h.PUBLISH, LABELS, CONFIG.status_context, WATCH_LABELS);
  assert.deepEqual(pub.problems, []);
  assert.deepEqual(pub.writes.map((w) => w.path).sort(), writeTemplates(LABELS, CONFIG.status_context, WATCH_LABELS).map((t) => t.path).sort());
  assert.deepEqual(pub.writes.map((w) => w.path).sort(), [
    'DELETE /repos/{r}/issues/{n}/labels/{name}', 'PATCH /repos/{r}/issues/comments/{id}', 'POST /app/installations/{id}/access_tokens',
    'POST /repos/{r}/issues/{n}/comments', 'POST /repos/{r}/issues/{n}/labels', 'POST /repos/{r}/issues/{n}/labels (R10 labels only)',
    'POST /repos/{r}/labels', 'POST /repos/{r}/labels (R10 labels only)', 'POST /repos/{r}/statuses/{sha}',
  ]);
  const poll = checkWrites(h.POLL, LABELS, CONFIG.status_context, WATCH_LABELS);
  assert.deepEqual(poll.problems, []);
  assert.deepEqual(poll.writes.map((w) => w.node), ['Publish']);
  const watch = checkWrites(WATCH, LABELS, CONFIG.status_context, WATCH_LABELS);
  assert.deepEqual(watch.problems, []);
  assert.deepEqual(watch.writes.map((w) => w.node), ['Publish']);
});

test('allowlist: the watch label writes take only the two R10 labels', () => {
  assert.deepEqual(WATCH_LABELS, ['triage:post-merge-ok', 'triage:post-merge-failed']);
  for (const node of ['Create watch label', 'Add watch label']) {
    const wider = clone(h.PUBLISH);
    const n = wider.nodes.find((x) => x.name === node);
    n.parameters.jsonBody = n.parameters.jsonBody.replace("'triage:post-merge-failed']", "'triage:post-merge-failed', 'merge']");
    assert.match(problems(wider), new RegExp(`"${node}" is a POST .* matches no allowed write`));
  }
  // The watcher can't call around its gate either.
  const around = clone(WATCH);
  around.connections['One item per action'].main = [[{ node: 'Publish', type: 'main', index: 0 }]];
  assert.match(problems(around), /"Publish" calls TriagePublishV01 outside the "Write gate" node's true output/);
  // And no other workflow may call it.
  const other = clone(WATCH);
  other.id = 'SomethingElse001';
  assert.match(problems(other), /calls TriagePublishV01 from SomethingElse001; only TriagePoll000001 and TriageWatch00001 may/);
});

test('allowlist: a merge is refused', () => {
  const wf = clone(h.PUBLISH);
  const n = wf.nodes.find((x) => x.name === 'Add label');
  n.parameters.method = 'PUT';
  n.parameters.url = `=https://api.github.com/repos/{{ ${"$('When called by the poll').first().json"}.repo }}/pulls/{{ Number(${"$('When called by the poll').first().json"}.pr) }}/merge`;
  assert.match(problems(wf), /"Add label" is a PUT .*\/merge that matches no allowed write/);
});

test('allowlist: a PATCH carrying state or title is refused', () => {
  for (const extra of ['state: "closed"', 'title: "x"']) {
    const wf = clone(h.PUBLISH);
    const n = wf.nodes.find((x) => x.name === 'Edit comment');
    n.parameters.jsonBody = n.parameters.jsonBody.replace('}) }}', `, ${extra} }) }}`);
    assert.match(problems(wf), /"Edit comment" is a PATCH .* matches no allowed write/);
  }
  const issue = clone(h.PUBLISH);
  issue.nodes.find((x) => x.name === 'Edit comment').parameters.url = "=https://api.github.com/repos/{{ $('When called by the poll').first().json.repo }}/issues/{{ Number($('When called by the poll').first().json.pr) }}";
  assert.match(problems(issue), /"Edit comment" is a PATCH .* matches no allowed write/);
});

test('allowlist: a delete of a non-triage label is refused', () => {
  const any = clone(h.PUBLISH);
  any.nodes.find((x) => x.name === 'Remove label').parameters.url = "=https://api.github.com/repos/{{ $('When called by the poll').first().json.repo }}/issues/{{ Number($('When called by the poll').first().json.pr) }}/labels/{{ encodeURIComponent($('When called by the poll').first().json.name) }}";
  assert.match(problems(any), /"Remove label" is a DELETE .* matches no allowed write/);
  const wider = clone(h.PUBLISH);
  const n = wider.nodes.find((x) => x.name === 'Remove label');
  n.parameters.url = n.parameters.url.replace("'merge-watched']", "'merge-watched', 'bug']");
  assert.match(problems(wider), /"Remove label" is a DELETE .* matches no allowed write/);
  const all = clone(h.PUBLISH);
  all.nodes.find((x) => x.name === 'Remove label').parameters.url = "=https://api.github.com/repos/{{ $('When called by the poll').first().json.repo }}/issues/{{ Number($('When called by the poll').first().json.pr) }}/labels";
  assert.match(problems(all), /"Remove label" is a DELETE/);
});

test('allowlist: any write outside the sub-workflow is refused, and so is a call around the gate', () => {
  const wf = clone(h.POLL);
  const n = clone(wf.nodes.find((x) => x.name === 'Get PR'));
  Object.assign(n, { name: 'Sneaky label', id: 'x' });
  Object.assign(n.parameters, { method: 'POST', url: '=https://api.github.com/repos/{{ $json.repo }}/issues/1/labels', sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify({ labels: ["triage:low-risk"] }) }}' });
  wf.nodes.push(n);
  assert.match(problems(wf), /"Sneaky label" is a GitHub POST outside the TriagePublishV01 sub-workflow/);
  const around = clone(h.POLL);
  around.connections['One item per action'].main = [[{ node: 'Publish', type: 'main', index: 0 }]];
  assert.match(problems(around), /"Publish" calls TriagePublishV01 outside the "Write gate" node's true output/);
  const falseOut = clone(h.POLL);
  falseOut.connections['Write gate'].main = [[], [{ node: 'Publish', type: 'main', index: 0 }]];
  assert.match(problems(falseOut), /outside the "Write gate" node's true output/);
});

test('allowlist: the sub-workflow must stay unsaved, caller-limited and request-free in its Code', () => {
  const saved = clone(h.PUBLISH);
  saved.settings.saveDataErrorExecution = 'all';
  assert.match(problems(saved), /must save no executions/);
  const open = clone(h.PUBLISH);
  open.settings.callerPolicy = 'any';
  assert.match(problems(open), /callable by TriagePoll000001 and TriageWatch00001 only/);
  const one = clone(h.PUBLISH);
  one.settings.callerIds = 'TriagePoll000001';
  assert.match(problems(one), /callable by TriagePoll000001 and TriageWatch00001 only/);
  const hook = clone(h.PUBLISH);
  hook.nodes.push({ name: 'Hook', type: 'n8n-nodes-base.webhook', parameters: {} });
  assert.match(problems(hook), /one trigger/);
  const fetcher = clone(h.PUBLISH);
  fetcher.nodes.find((x) => x.name === 'Result').parameters.jsCode += '\nawait helpers.httpRequest({ method: "PUT", url: "x" });';
  assert.match(problems(fetcher), /could make a request/);
  const extraHeader = clone(h.PUBLISH);
  extraHeader.nodes.find((x) => x.name === 'Set status').parameters.headerParameters.parameters.push({ name: 'X-HTTP-Method-Override', value: 'PUT' });
  assert.match(problems(extraHeader), /sends something besides its template/);
});

test('the negative control still fails against the live cluster version', () => {
  assert.equal(rules.negativeControl({ url: 'u', gitVersion: 'v1.34.12+k3s1', etag_or_sha: 'c' }, CONFIG).result, 'fail');
});

// ------------------------------------------------------------ the App key

// The initContainer's check, run as written in deployment.yaml on keys made
// here, after the same encode (1Password) and decode (b64dec, toJson) steps.
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

function keyCheck(pemOrText) {
  const dep = read('deployment.yaml');
  const script = dep.match(/node -e '\n([\s\S]*?)\n\s*'\n/)[1];
  const b64 = Buffer.from(pemOrText, 'utf8').toString('base64');
  const decoded = Buffer.from(b64, 'base64').toString('utf8');
  const env = { PATH: process.env.PATH, CREDENTIALS_OVERWRITE_DATA: JSON.stringify({ jwtAuth: { privateKey: decoded } }) };
  try {
    const out = execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

// True if any 16-character run of the key's body appears in the text.
function leaks(text, pem) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  for (let i = 0; i + 16 <= body.length; i += 16) if (text.includes(body.slice(i, i + 16))) return true;
  return text.includes(Buffer.from(pem).toString('base64').slice(0, 32));
}

test('the App key check passes an RSA PEM and fails anything else, never printing the key', () => {
  const { privateKey: rsa } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pkcs1 = rsa.export({ type: 'pkcs1', format: 'pem' });
  const pkcs8 = rsa.export({ type: 'pkcs8', format: 'pem' });
  const { privateKey: ec } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecPem = ec.export({ type: 'pkcs8', format: 'pem' });
  for (const [pem, want] of [[pkcs1, true], [pkcs8, true], [ecPem, false], ['-----BEGIN RSA PRIVATE KEY-----\nnot a key\n-----END RSA PRIVATE KEY-----\n', false], ['', false],
    [Buffer.from(pkcs1).toString('base64'), false]]) {
    const r = keyCheck(pem);
    assert.equal(r.ok, want, r.out);
    assert.match(r.out, want ? /^GitHub App private key: RSA PEM ok\n$/ : /^GitHub App private key: not an RSA PEM/);
    if (pem.length > 100) assert.ok(!leaks(r.out, pem), 'the check output carries no key material');
  }
});

test('the ExternalSecret decodes the key, and only the decoded form reaches the Secret', () => {
  const es = read('externalsecret.yaml');
  assert.match(es, /mergePolicy: Replace/);
  const template = es.slice(es.indexOf('    template:'), es.indexOf('\n  data:\n'));
  const outputs = Array.from(template.matchAll(/^ {8}([A-Z0-9_]+):/gm)).map((m) => m[1]);
  assert.deepEqual(outputs.sort(), ['CREDENTIALS_OVERWRITE_DATA', 'DB_POSTGRESDB_PASSWORD', 'GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID',
    'GITHUB_TOKEN', 'HA_HEARTBEAT_URL', 'N8N_ENCRYPTION_KEY', 'POSTGRES_PASSWORD', 'REDACTION_PATTERNS', 'TRIAGE_DB_PASSWORD']);
  assert.ok(!outputs.some((k) => k.startsWith('GITHUB_APP_PRIVATE_KEY')), 'the key reaches n8n only inside the overwrite');
  // Every 1Password field is a template input; each but the base64 key is passed through.
  const inputs = Array.from(es.matchAll(/- secretKey: ([A-Z0-9_]+)/g)).map((m) => m[1]);
  for (const k of inputs) {
    if (k === 'GITHUB_APP_PRIVATE_KEY_B64') continue;
    assert.ok(template.includes(`${k}: '{{ .${k} }}'`), k);
  }
  const decodes = template.match(/\.GITHUB_APP_PRIVATE_KEY_B64 \| b64dec/g);
  assert.equal(decodes.length, 1, 'decoded once, for the jwtAuth overwrite');
  assert.match(template, /"jwtAuth":\{"privateKey":\{\{ \.GITHUB_APP_PRIVATE_KEY_B64 \| b64dec \| toJson \}\}\}/);
  assert.ok(!/github-app-private-key\n/.test(es), 'the old field name is gone');
  for (const f of ['deployment.yaml', 'triage/seed.sql', 'workflows/triage-publish.json', 'workflows/triage-poll.json']) {
    assert.ok(!read(f).includes('GITHUB_APP_PRIVATE_KEY'), `${f} names no copy of the key`);
  }
});

// ------------------------------------------------------------ the App's login, from config

test('config: app_slug is validated, and the App login is <app_slug>[bot]', () => {
  assert.equal(CONFIG.app_slug, APP_SLUG);
  assert.equal(rules.appLoginOf(CONFIG), APP_LOGIN);
  for (const bad of ['Dtw-PR', 'dtw_pr', '-dtw', 'dtw-pr-triage[bot]', '']) {
    assert.throws(() => rules.loadConfig(CONFIG_TEXT.replace(`app_slug: ${APP_SLUG}`, `app_slug: "${bad}"`)), /app_slug/, bad);
  }
  assert.throws(() => rules.loadConfig(CONFIG_TEXT.replace(`app_slug: ${APP_SLUG}\n`, '')), /app_slug/);
  // PR read URLs reads the same slug with its one-line pattern.
  const out = { 'Start run': [{ json: { config_body: CONFIG_TEXT, publications: {} } }], 'Get PR': [{ json: {} }] };
  const urls = h.code(h.nodeOf(h.POLL, 'PR read URLs'), out, [{ json: {} }], 0);
  assert.equal(urls[0].json.app_login, APP_LOGIN);
});

test('write_mode off: label events by <app_slug>[bot] count as the App\'s, before it has ever written', async () => {
  const t = env();
  t.gh.pr(440, S.a);
  // The App's label, and no App comment anywhere (nothing to learn a login from).
  t.gh.state.prs[440].labels.push('triage:review');
  t.gh.state.prs[440].events.push({ id: 1, event: 'labeled', label: { name: 'triage:review' }, actor: { login: APP_LOGIN }, created_at: h.iso(t.db.clock) });
  t.verdict(440, S.a, 'deep-review', RS1, ['touches CRDs']);
  const r = await t.poll({ config: OFF_TEXT });
  assert.deepEqual(r.appCalls, []);
  assert.equal(r.plans[0].human_override, false);
  assert.deepEqual(r.plans[0].actions.map((a) => a.type + (a.name ? `:${a.name}` : '')), [
    'create_comment', 'set_status', 'ensure_label:triage:deep-review', 'remove_label:triage:review', 'add_label:triage:deep-review',
  ]);
  // The same event by anyone else is an override.
  t.gh.state.prs[440].events[0].actor.login = 'a-person';
  const p = await t.poll({ config: OFF_TEXT });
  assert.equal(p.plans[0].human_override, true);
  assert.deepEqual(p.plans[0].actions.map((a) => a.type), ['create_comment']);
});

test('the first publish run on a PR treats its own label events as the App\'s', async () => {
  const t = env();
  t.gh.pr(450, S.a);
  t.verdict(450, S.a, 'review');
  const first = await t.poll();
  assert.equal(first.run.publish, 'published');
  assert.ok(t.gh.state.prs[450].events.some((e) => e.event === 'labeled' && e.actor.login === APP_LOGIN));
  // Even with its comment gone, its label events stay its own.
  t.gh.state.gone.add(t.triageComments(450)[0].id);
  t.gh.state.prs[450].comments = [];
  t.verdict(450, S.a, 'deep-review', RS2, ['touches CRDs']);
  const r = await t.poll({ ruleset: RS2 });
  assert.equal(r.plans[0].human_override, false);
  assert.deepEqual(t.managed(450), ['triage:deep-review']);
});

test('a slug mismatch at GET /app writes nothing and marks the run not ok', async () => {
  const t = env();
  t.gh.pr(460, S.a);
  t.verdict(460, S.a, 'review');
  t.gh.state.appSlug = 'some-other-app';
  const r = await t.poll();
  assert.deepEqual(r.writes, [], 'not even the token exchange');
  assert.ok(r.requests.some((q) => q.method === 'GET' && q.url === 'https://api.github.com/app'));
  assert.ok(r.out.Publish.every((i) => i.json.app_ok === false && i.json.ok === false));
  assert.equal(t.db.publications[`${REPO}#460@${S.a}`].outcome, 'failed');
  assert.equal(r.run.publish, 'failed');
  assert.equal(r.run.ok, false);
  assert.deepEqual(t.managed(460), []);
  // GET /app is a read: the allowlist is unchanged.
  const chk = h.nodeOf(h.PUBLISH, 'Check App');
  assert.deepEqual([chk.parameters.method, chk.parameters.url], ['GET', '=https://api.github.com/app']);
  assert.deepEqual(h.PUBLISH.connections['Sign App JWT'].main[0].map((l) => l.node), ['Check App']);
  assert.deepEqual(h.PUBLISH.connections['App matches'].main.map((b) => b.map((l) => l.node)), [['Installation token'], ['Result']]);
});
