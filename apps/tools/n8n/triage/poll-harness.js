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
  return { runs: [], verdicts: [], publications: {}, config: {}, clock: Date.parse('2026-11-20T00:00:00Z') };
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
  const logins = Object.values(db.publications).filter((p) => p.app_login).sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));
  return {
    run,
    row: {
      run_id: run.id, ruleset, repo, list_etag: null, config_body: configText, config_sha: 'sha', patterns,
      seen: Array.from(seen), previous: {}, publications: pubs, sha_seen: shaSeen, current_verdicts: current,
      app_id: db.config['github-app-id'] || null, installation_id: db.config['github-app-installation-id'] || null,
      app_login: logins.length ? logins[0].app_login : null,
    },
  };
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
    } else if (n.type === 'n8n-nodes-base.code') {
      out[at] = code(n, out, out[Object.keys(out).pop()], 0);
    } else {
      throw new Error(`unmodelled node type ${n.type}`);
    }
    if (n.type !== 'n8n-nodes-base.switch') current = out[at][0].json;
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

  // Branches in canvas order (executionOrder v1): verdicts, plans, run summary.
  assert.deepEqual(next(POLL, 'Triage'), ['Verdicts only', 'Plans only', 'Run summary only']);
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
        const [runId, r, pr, sha, outcome, commentId, appLogin] = param(nodeOf(POLL, 'Record publish').parameters.options.queryReplacement, scope(out, it.json, 0));
        const row = db.publications[`${r}#${pr}@${sha}`];
        if (!row || row.run_id !== runId) continue;
        row.outcome = outcome;
        if (commentId) row.comment_id = commentId;
        if (appLogin) row.app_login = appLogin;
        if (outcome === 'published') {
          Object.assign(row, {
            verdict: row.planned.verdict, ruleset: row.planned.ruleset, label: row.planned.label,
            status_state: (row.planned.status && row.planned.status.state) || row.status_state, published_at: iso(db.clock),
          });
        }
      }
    }
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

module.exports = { POLL, PUBLISH, nodeOf, param, ifResult, scope, http, code, newDb, startRun, runPublish, runPoll, iso };
