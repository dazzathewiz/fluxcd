'use strict';
// Test harness (not a test file): runs one poll the way n8n would, node by
// node, from the workflow JSON in Git. Expressions are evaluated from the
// nodes' own parameters and Code nodes run their own code. GitHub is a
// function the caller passes; Postgres is modelled in JS here, and
// publish.test.js pins the SQL each model stands in for.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rules = require('./rules.js');

const N8N = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(N8N, p), 'utf8');
const POLL = JSON.parse(read('workflows/triage-poll.json'));
const PUBLISH = JSON.parse(read('workflows/triage-publish.json'));
const nodeOf = (wf, name) => {
  const n = wf.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`no node ${name} in ${wf.id}`);
  return n;
};
const next = (wf, name, branch) => ((((wf.connections[name] || {}).main || [])[branch || 0]) || []).map((l) => l.node);

// ------------------------------------------------------------ expressions

// out: node name -> items; idx: the current item index for $('X').item.
function scope(out, json, idx, extra) {
  const $ = (n) => {
    const items = out[n] || [];
    return {
      first: () => items[0],
      all: () => items,
      get item() {
        if (items[idx] === undefined) throw new Error(`no paired item ${idx} for ${n}`);
        return items[idx];
      },
    };
  };
  return Object.assign({ $json: json, $, Number, JSON, String, Math, Date, encodeURIComponent, Array }, extra || {});
}

function param(value, sc) {
  if (typeof value !== 'string' || !value.startsWith('=')) return value;
  const text = value.slice(1);
  const run = (expr) => vm.runInNewContext(`(${expr})`, Object.assign({}, sc));
  const whole = text.match(/^\{\{([\s\S]*)\}\}$/);
  if (whole && !whole[1].includes('{{')) return run(whole[1]);
  return text.replace(/\{\{([\s\S]*?)\}\}/g, (m, e) => String(run(e)));
}

function ifResult(n, sc) {
  const conds = n.parameters.conditions.conditions;
  const each = conds.map((c) => {
    const left = param(c.leftValue, sc);
    const op = c.operator.operation;
    if (op === 'equals') return left === c.rightValue;
    if (op === 'notEquals') return left !== c.rightValue;
    if (op === 'true') return left === true;
    throw new Error(`operator ${op}`);
  });
  return n.parameters.conditions.combinator === 'or' ? each.some(Boolean) : each.every(Boolean);
}

function headersOf(n, sc) {
  const out = {};
  for (const h of ((n.parameters.headerParameters || {}).parameters || [])) out[h.name] = param(h.value, sc);
  return out;
}

// An HTTP Request node, pagination included: one item per page, paired to idx.
function http(n, sc, github, idx) {
  const p = n.parameters;
  const method = String(p.method || 'GET').toUpperCase();
  const headers = headersOf(n, sc);
  const body = p.sendBody ? JSON.parse(param(p.jsonBody, sc)) : undefined;
  let url = param(p.url, sc);
  const pag = ((p.options || {}).pagination || {}).pagination;
  const pages = [];
  for (let k = 0; ; k++) {
    const r = github(method, url, body, headers, n.name);
    pages.push({ json: { statusCode: r.statusCode, headers: r.headers || {}, body: r.body }, pairedItem: { item: idx } });
    if (!pag) break;
    const psc = Object.assign({}, sc, { $response: { statusCode: r.statusCode, headers: r.headers || {}, body: r.body } });
    if (param(pag.completeExpression, psc)) break;
    if (pag.limitPagesFetched && k + 1 >= pag.maxRequests) break;
    url = param(pag.nextURL, psc);
  }
  return pages;
}

function code(n, out, input, idx) {
  const ctx = vm.createContext(Object.assign(scope(out, input[idx] ? input[idx].json : {}, idx), {
    $input: { first: () => input[0], all: () => input, item: input[idx] },
    console,
  }));
  if (n.parameters.mode === 'runOnceForEachItem') {
    return input.map((it, i) => {
      const c = vm.createContext(Object.assign(scope(out, it.json, i), { $input: { item: it }, console }));
      const r = vm.runInContext(`(function () {${n.parameters.jsCode}\n})()`, c);
      return Object.assign({ pairedItem: { item: i } }, JSON.parse(JSON.stringify(r)));
    });
  }
  return JSON.parse(JSON.stringify(vm.runInContext(`(function () {${n.parameters.jsCode}\n})()`, ctx)));
}

// ------------------------------------------------------------ the database

function newDb() {
  return { runs: [], verdicts: [], publications: {}, config: {}, render_requests: [], renders: [], clock: Date.parse('2026-11-20T00:00:00Z') };
}
const iso = (t) => new Date(t).toISOString();
const keyOf = (o) => `${o.repo}#${o.pr}@${o.head_sha}`;

// Start run's SQL, for one repo.
function startRun(db, repo, ruleset, configText, patterns) {
  const run = { id: db.runs.length + 1, ruleset, started: iso(db.clock), list_etags: {}, ok: null, publish: null };
  db.runs.push(run);
  const latest = {};
  const current = {};
  const seen = new Set();
  for (const v of db.verdicts) {
    const k = keyOf(v);
    latest[k] = v;
    if (v.ruleset === ruleset || v.finalised) seen.add(k);
    if (v.ruleset === ruleset || (v.finalised && !(current[k] && current[k].ruleset === ruleset))) current[k] = { verdict: v.verdict, reasons: v.reasons, ruleset: v.ruleset };
  }
  const shaSeen = {};
  const touch = (o, t) => {
    const pk = `${o.repo}#${o.pr}`;
    shaSeen[pk] = shaSeen[pk] || {};
    if (!shaSeen[pk][o.head_sha] || t > shaSeen[pk][o.head_sha]) shaSeen[pk][o.head_sha] = t;
  };
  for (const v of db.verdicts) touch(v, v.created);
  const pubs = {};
  for (const [k, p] of Object.entries(db.publications)) {
    pubs[k] = { verdict: p.verdict, ruleset: p.ruleset, label: p.label, comment_id: p.comment_id, status_state: p.status_state, human_override: p.human_override, outcome: p.outcome };
    if (p.planned_at) touch(p, p.planned_at);
  }
  return {
    run,
    row: {
      run_id: run.id, ruleset, repo, list_etag: null, config_body: configText, config_sha: 'sha', patterns,
      seen: Array.from(seen), previous: {}, publications: pubs, sha_seen: shaSeen, current_verdicts: current,
      app_id: db.config['github-app-id'] || null, installation_id: db.config['github-app-installation-id'] || null,
    },
  };
}

// The Renders node's SQL, for one PR read URLs item: the head SHA's requests,
// the stored R11 cache under this ruleset, and docs only where it has no result.
function readRenders(db, item, ruleset) {
  const j = item || {};
  const pub = j.key ? db.publications[j.key] : null;
  const cache = pub && pub.planned && pub.planned.r11 && pub.planned.r11.ruleset === ruleset ? pub.planned.r11 : null;
  const cached = (rq) => !!cache && Array.isArray(cache.results)
    && cache.results.some((c) => String(c.id) === String(rq.id) && c.status === rq.status && c.state === 'done');
  const side = (rq, s) => {
    const r = db.renders.find((x) => x.request_id === rq.id && x.side === s);
    return r ? { digest: r.chart_digest, app_version: r.app_version, bytes: r.bytes } : null;
  };
  const requests = db.render_requests
    .filter((rq) => rq.repo === j.repo && rq.pr === j.pr && rq.head_sha === j.head_sha)
    .sort((a, b) => a.id - b.id)
    .map((rq) => {
      let docs = null;
      if ((rq.status === 'done' || rq.status === 'failed') && !cached(rq)) {
        const rs = db.renders.filter((x) => x.request_id === rq.id);
        if (rs.length) { docs = {}; for (const r of rs) docs[r.side] = r.docs; }
      }
      return {
        id: rq.id, path: rq.path, release: rq.release, chart: rq.chart, old_version: rq.old_version, new_version: rq.new_version,
        status: rq.status, error: rq.error, attempts: rq.attempts, old: side(rq, 'old'), new: side(rq, 'new'), docs,
      };
    });
  return { key: j.key || null, cache, requests };
}

// Queue render's SQL: insert unless (repo, pr, head_sha, path, release) exists.
function queueRender(db, j) {
  if (db.render_requests.some((x) => x.repo === j.repo && x.pr === j.pr && x.head_sha === j.head_sha && x.path === j.path && x.release === j.release)) return false;
  db.render_requests.push({
    id: db.render_requests.length + 1, repo: j.repo, pr: j.pr, head_sha: j.head_sha, path: j.path, release: j.release,
    namespace: j.namespace, chart: j.chart, helm_repo_url: j.helm_repo_url || null, old_version: j.old_version,
    new_version: j.new_version, kube_version: j.kube_version || null, status: j.status, error: j.error || null, attempts: 0,
    requested: iso(db.clock), finished: j.status === 'unsupported' ? iso(db.clock) : null,
  });
  return true;
}

// The render job finishing one request: both renders stored, status done.
function finishRender(db, id, old, neu, status, error) {
  const rq = db.render_requests.find((x) => x.id === id);
  if (old) db.renders.push({ request_id: id, side: 'old', chart_digest: old.digest, app_version: old.app_version, docs: old.docs, bytes: JSON.stringify(old.docs).length });
  if (neu) db.renders.push({ request_id: id, side: 'new', chart_digest: neu.digest, app_version: neu.app_version, docs: neu.docs, bytes: JSON.stringify(neu.docs).length });
  Object.assign(rq, { status: status || 'done', error: error || null, attempts: rq.attempts + 1, finished: iso(db.clock) });
}

// ------------------------------------------------------------ the sub-workflow

// One call of TriagePublishV01 with one action item. Returns the Result
// node's output, as the poll's Publish node receives it.
function runPublish(action, github, calls) {
  const out = { 'When called by the poll': [{ json: action }] };
  let at = next(PUBLISH, 'When called by the poll')[0];
  let current = action;
  while (at) {
    const n = nodeOf(PUBLISH, at);
    const sc = scope(out, current, 0);
    let branch = 0;
    if (n.type === 'n8n-nodes-base.jwt') {
      // Signs with the credential's key; the claims come from the node.
      const claims = JSON.parse(param(n.parameters.claimsJson, sc));
      calls.push({ kind: 'jwt', claims, algorithm: n.parameters.options.algorithm });
      out[at] = [{ json: { token: 'jwt-for-test' } }];
    } else if (n.type === 'n8n-nodes-base.httpRequest') {
      out[at] = http(n, sc, github, 0);
    } else if (n.type === 'n8n-nodes-base.switch') {
      branch = Number(param(n.parameters.output, sc));
      out[at] = [{ json: current }];
    } else if (n.type === 'n8n-nodes-base.if') {
      branch = ifResult(n, sc) ? 0 : 1;
      out[at] = [{ json: current }];
    } else if (n.type === 'n8n-nodes-base.code') {
      out[at] = code(n, out, out[Object.keys(out).pop()], 0);
    } else {
      throw new Error(`unmodelled node type ${n.type}`);
    }
    if (n.type !== 'n8n-nodes-base.switch' && n.type !== 'n8n-nodes-base.if') current = out[at][0].json;
    const nx = next(PUBLISH, at, branch);
    if (!nx.length) return out[at];
    at = nx[0];
  }
  throw new Error('publish walked off the end');
}

// ------------------------------------------------------------ the poll

// opts: {db, github, repo, ruleset, config (text), patterns, cluster, external, now}
async function runPoll(opts) {
  const db = opts.db;
  const github = opts.github;
  const repo = opts.repo;
  const configText = opts.config;
  const start = startRun(db, repo, opts.ruleset, configText, opts.patterns);
  const out = { 'Start run': [{ json: start.row }] };
  const each = (name, input) => {
    const n = nodeOf(POLL, name);
    const items = [];
    input.forEach((it, i) => items.push(...http(n, scope(out, it.json, i), github, i)));
    out[name] = items;
    return items;
  };
  each('Get dashboard', out['Start run']);
  each('Repo labels', out['Get dashboard']);
  each('List PRs', out['Repo labels']);
  const list = out['List PRs'][0].json;
  const prItems = list.statusCode === 200 && Array.isArray(list.body) && list.body.length ? list.body.map((b, i) => ({ json: b, pairedItem: { item: i } })) : [{ json: {} }];
  out['One item per PR'] = prItems;
  // Get PR's URL check reads $json.url.
  each('Get PR', prItems);
  each('Get files', out['Get PR']);
  out['PR read URLs'] = code(nodeOf(POLL, 'PR read URLs'), out, out['Get files'], 0);
  each('Label events', out['PR read URLs']);
  each('Stored comment', out['PR read URLs']);
  each('PR comments', out['Stored comment']);
  assert.deepEqual(next(POLL, 'PR read URLs'), ['Label events', 'Stored comment', 'Renders', 'Cluster version']);
  out.Renders = out['PR read URLs'].map((it, i) => ({ json: readRenders(db, it.json, start.row.ruleset), pairedItem: { item: i } }));
  out['Cluster version'] = [{ json: opts.cluster || { statusCode: 200, headers: {}, body: { gitVersion: 'v1.34.12+k3s1', gitCommit: 'c' } } }];
  const ctx = vm.createContext({
    helpers: { httpRequest: async (o) => (opts.external ? opts.external(o) : { statusCode: 404, headers: {}, body: '' }) },
    $input: { first: () => out['Cluster version'][0], all: () => out['Cluster version'] },
    $: (n) => ({ first: () => (out[n] || [])[0], all: () => out[n] || [] }),
    console,
  });
  const items = await vm.runInContext(`module = { exports: {} }; module.exports = async function VmCodeWrapper() {${nodeOf(POLL, 'Triage').parameters.jsCode}\n}()`, ctx);
  out.Triage = JSON.parse(JSON.stringify(items));
  const runItem = out.Triage[0].json;
  assert.equal(runItem.kind, 'run');

  // Branches in canvas order (executionOrder v1): verdicts, plans, render
  // requests, run summary.
  assert.deepEqual(next(POLL, 'Triage'), ['Verdicts only', 'Plans only', 'Render requests only', 'Run summary only']);
  const ys = next(POLL, 'Triage').map((n) => nodeOf(POLL, n).position[1]);
  assert.deepEqual(ys.slice().sort((a, b) => a - b), ys, 'branches top to bottom');

  // Insert verdict
  const verdicts = out.Triage.filter((i) => i.json.kind === 'verdict');
  for (const v of verdicts) {
    const j = v.json;
    if (!db.verdicts.some((x) => keyOf(x) === keyOf(j) && x.ruleset === j.ruleset)) {
      db.verdicts.push({ repo: j.repo, pr: j.pr, head_sha: j.head_sha, verdict: j.verdict, reasons: j.reasons, ruleset: j.ruleset, created: iso(db.clock), finalised: j.finalise });
    }
  }
  // Record plan
  const plans = out.Triage.filter((i) => i.json.kind === 'plan');
  out['Plans only'] = plans;
  for (const it of plans) {
    const j = it.json;
    const [r, pr, sha, planned, runId, outcome, override, actor, label] = param(nodeOf(POLL, 'Record plan').parameters.options.queryReplacement, scope(out, j, 0));
    const k = `${r}#${pr}@${sha}`;
    const row = db.publications[k] || { repo: r, pr, head_sha: sha, human_override: false, override_actor: null, override_label: null };
    Object.assign(row, { planned: JSON.parse(planned), planned_at: iso(db.clock), run_id: runId, outcome });
    row.human_override = row.human_override || override;
    row.override_actor = actor || row.override_actor;
    row.override_label = label || row.override_label;
    db.publications[k] = row;
  }
  out['Record plan'] = plans.map(() => ({ json: { success: true } }));
  const calls = [];
  if (plans.length) {
    out['One item per action'] = code(nodeOf(POLL, 'One item per action'), out, out['Record plan'], 0);
    const gate = nodeOf(POLL, 'Write gate');
    const passed = out['One item per action'].filter((it, i) => ifResult(gate, scope(out, it.json, i)));
    out['Write gate'] = passed;
    if (passed.length) {
      assert.deepEqual(next(POLL, 'Write gate'), ['Publish']);
      out.Publish = passed.map((it) => runPublish(it.json, github, calls)[0]);
      out['Publish results'] = code(nodeOf(POLL, 'Publish results'), out, out.Publish, 0);
      for (const it of out['Publish results']) {
        const [runId, r, pr, sha, outcome, commentId] = param(nodeOf(POLL, 'Record publish').parameters.options.queryReplacement, scope(out, it.json, 0));
        const row = db.publications[`${r}#${pr}@${sha}`];
        if (!row || row.run_id !== runId) continue;
        row.outcome = outcome;
        if (commentId) row.comment_id = commentId;
        if (outcome === 'published') {
          Object.assign(row, {
            verdict: row.planned.verdict, ruleset: row.planned.ruleset, label: row.planned.label,
            status_state: (row.planned.status && row.planned.status.state) || row.status_state, published_at: iso(db.clock),
          });
        }
      }
    }
  }
  // Queue render
  const queued = out.Triage.filter((i) => i.json.kind === 'render_request');
  for (const it of queued) {
    const [repo2, pr2, sha2, path2, release2, ns2, chart2, url2, from2, to2, kube2, status2, error2] = param(nodeOf(POLL, 'Queue render').parameters.options.queryReplacement, scope(out, it.json, 0));
    queueRender(db, { repo: repo2, pr: Number(pr2), head_sha: sha2, path: path2, release: release2, namespace: ns2, chart: chart2, helm_repo_url: url2, old_version: from2, new_version: to2, kube_version: kube2, status: status2, error: error2 });
  }
  // Finish run
  const [runId, , ok, etags, mode, healthy] = param(nodeOf(POLL, 'Finish run').parameters.options.queryReplacement, scope(out, runItem, 0));
  const outcomes = Object.values(db.publications).filter((p) => p.run_id === runId).map((p) => p.outcome);
  let publish;
  if (mode === 'off') publish = 'planned-only';
  else if (!healthy) publish = 'skipped-unhealthy';
  else if (outcomes.some((o) => o === 'failed' || o === 'publishing')) publish = 'failed';
  else if (outcomes.includes('redaction-hit')) publish = 'redaction-hit';
  else if (outcomes.includes('published')) publish = 'published';
  else publish = 'no-op';
  Object.assign(start.run, { finished: iso(db.clock), ok: ok && publish !== 'failed', publish, list_etags: publish === 'failed' ? {} : JSON.parse(etags) });
  db.clock += 15 * 60 * 1000;
  return { run: start.run, runItem, plans: plans.map((p) => p.json.plan), calls, out };
}

module.exports = { POLL, PUBLISH, nodeOf, param, ifResult, scope, http, code, newDb, startRun, readRenders, queueRender, finishRender, runPublish, runPoll, iso };
