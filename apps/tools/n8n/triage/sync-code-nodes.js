#!/usr/bin/env node
'use strict';
// Checks that the workflow Code node marked with the rules.js markers carries
// rules.js verbatim, that no workflow carries more than one copy, that a
// workflow reading the service-account token saves no executions, and the
// write allowlist:
//   - every non-GET request bound for GitHub is in the TriagePublishV01
//     sub-workflow, where every non-GET (to any host) must be one of the
//     writeTemplates exactly (method, URL, body, headers), so nothing can merge,
//     edit a PR or issue, review, or touch refs;
//   - that sub-workflow saves no executions, is callable only by the poll, and
//     its Code nodes make no requests;
//   - the poll reaches it only through the Write gate's true output.
// Run before every push (this repo has no CI):
//   node apps/tools/n8n/triage/sync-code-nodes.js           # check, exit 1 on drift
//   node apps/tools/n8n/triage/sync-code-nodes.js --write   # copy rules.js into the nodes

const fs = require('node:fs');
const path = require('node:path');

const BEGIN = '// ==== BEGIN rules.js (verbatim copy; edit triage/rules.js) ====\n';
const END = '\n// ==== END rules.js ====\n';
const GATE_NODE = 'Write gate';
const PUBLISH_ID = 'TriagePublishV01';
const POLL_ID = 'TriagePoll000001';

// The poll's caller-side trigger, as the expressions write it.
const A = "$('When called by the poll').first().json";
const TOKEN = "$('Installation token').first().json";
const HEADERS = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
const APP_TOKEN = `=token {{ ${TOKEN}.body.token }}`;

// The only writes any workflow may make. labels are rule 1's names and context
// the status context, both from config.yaml (rules.js pins them).
function writeTemplates(labels, context) {
  const list = `[${labels.map((l) => `'${l}'`).join(', ')}]`;
  const repo = `'https://api.github.com/repos/' + ${A}.repo`;
  return [
    {
      node: 'Installation token', method: 'POST', path: 'POST /app/installations/{id}/access_tokens',
      url: `=https://api.github.com/app/installations/{{ Number(${A}.installation_id) }}/access_tokens`,
      jsonBody: `={{ JSON.stringify({ repositories: [String(${A}.repo).split('/')[1]], permissions: { issues: 'write', pull_requests: 'write', statuses: 'write', metadata: 'read' } }) }}`,
      auth: '=Bearer {{ $json.token }}',
    },
    {
      node: 'Create label', method: 'POST', path: 'POST /repos/{r}/labels',
      url: `=https://api.github.com/repos/{{ ${A}.repo }}/labels`,
      jsonBody: `={{ JSON.stringify({ name: ${list}.includes(${A}.name) ? ${A}.name : '', color: ${A}.color, description: ${A}.description }) }}`,
    },
    {
      node: 'Add label', method: 'POST', path: 'POST /repos/{r}/issues/{n}/labels',
      url: `=https://api.github.com/repos/{{ ${A}.repo }}/issues/{{ Number(${A}.pr) }}/labels`,
      jsonBody: `={{ JSON.stringify({ labels: ${list}.includes(${A}.name) ? [${A}.name] : [] }) }}`,
    },
    {
      node: 'Remove label', method: 'DELETE', path: 'DELETE /repos/{r}/issues/{n}/labels/{name}',
      url: `={{ ${list}.includes(${A}.name) ? ${repo} + '/issues/' + Number(${A}.pr) + '/labels/' + encodeURIComponent(${A}.name) : 'https://api.github.com/rate_limit' }}`,
      jsonBody: undefined,
    },
    {
      node: 'Create comment', method: 'POST', path: 'POST /repos/{r}/issues/{n}/comments',
      url: `=https://api.github.com/repos/{{ ${A}.repo }}/issues/{{ Number(${A}.pr) }}/comments`,
      jsonBody: `={{ JSON.stringify({ body: ${A}.body }) }}`,
    },
    {
      node: 'Edit comment', method: 'PATCH', path: 'PATCH /repos/{r}/issues/comments/{id}',
      url: `=https://api.github.com/repos/{{ ${A}.repo }}/issues/comments/{{ Number(${A}.comment_id) }}`,
      jsonBody: `={{ JSON.stringify({ body: ${A}.body }) }}`,
    },
    {
      node: 'Set status', method: 'POST', path: 'POST /repos/{r}/statuses/{sha}',
      url: `=https://api.github.com/repos/{{ ${A}.repo }}/statuses/{{ ${A}.sha }}`,
      jsonBody: `={{ JSON.stringify({ state: ${A}.state, context: '${context}', description: ${A}.description }) }}`,
    },
  ].map((t) => Object.assign({ auth: APP_TOKEN }, t));
}

function edges(wf, skip) {
  const out = {};
  for (const [from, outs] of Object.entries(wf.connections || {})) {
    (outs.main || []).forEach((branch, index) => {
      for (const link of branch || []) {
        if (skip && skip(from, index)) continue;
        (out[from] = out[from] || []).push(link.node);
      }
    });
  }
  return out;
}

function reach(next, starts) {
  const seen = new Set(starts);
  const stack = starts.slice();
  while (stack.length) {
    for (const n of next[stack.pop()] || []) {
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return seen;
}

const headerMap = (p) => {
  const out = {};
  for (const h of ((p.headerParameters || {}).parameters || [])) out[h.name] = h.value;
  return out;
};

// Problems with one workflow's requests, and the writes that pass.
// labels and context: from config.yaml.
function checkWrites(wf, labels, context) {
  const problems = [];
  const writes = [];
  const templates = writeTemplates(labels, context);
  const isPublish = wf.id === PUBLISH_ID;
  for (const node of wf.nodes) {
    const p = node.parameters || {};
    if (node.type === 'n8n-nodes-base.httpRequest') {
      const method = String(p.method || 'GET').toUpperCase();
      if (method === 'GET') {
        if (isPublish && (p.sendBody || p.sendQuery || !/^=(\{\{ .*'https:\/\/api\.github\.com\/|https:\/\/api\.github\.com\/)/.test(String(p.url || '')))) {
          problems.push(`"${node.name}" is a GET in ${PUBLISH_ID} that sends a body or query, or leaves api.github.com`);
        }
        continue;
      }
      if (!isPublish) {
        // A request bound for the source host: it names GitHub, carries the
        // GitHub credential, or sends its own Authorization header.
        const github = /github\.com/i.test(String(p.url || '')) || p.nodeCredentialType === 'githubApi'
          || !!(node.credentials || {}).githubApi || 'Authorization' in headerMap(p);
        if (github) problems.push(`"${node.name}" is a GitHub ${method} outside the ${PUBLISH_ID} sub-workflow`);
        continue;
      }
      const t = templates.find((w) => w.node === node.name);
      const h = headerMap(p);
      const want = Object.assign({}, HEADERS, { Authorization: t ? t.auth : null });
      const sameHeaders = Object.keys(h).length === Object.keys(want).length && Object.entries(want).every(([k, v]) => h[k] === v);
      if (!t || t.method !== method || t.url !== p.url || t.jsonBody !== p.jsonBody) {
        problems.push(`"${node.name}" is a ${method} to ${p.url} that matches no allowed write`);
        continue;
      }
      const bodyShape = t.jsonBody === undefined ? !p.sendBody : (p.sendBody === true && p.specifyBody === 'json');
      if (!bodyShape || p.sendQuery || p.bodyParameters || p.authentication || node.credentials || !sameHeaders) {
        problems.push(`"${node.name}" sends something besides its template (query, form body, credential or extra headers)`);
        continue;
      }
      writes.push({ node: node.name, method, path: t.path });
    }
    if (node.type === 'n8n-nodes-base.jwt' || (node.credentials && node.credentials.jwtAuth)) {
      if (!isPublish) problems.push(`"${node.name}" signs with the App key outside ${PUBLISH_ID}`);
    }
    if (isPublish && node.type === 'n8n-nodes-base.code' && /\b(helpers|fetch|require|XMLHttpRequest|httpRequest)\b/.test(String(p.jsCode || ''))) {
      problems.push(`"${node.name}" is a Code node in ${PUBLISH_ID} that could make a request`);
    }
    if (node.type === 'n8n-nodes-base.executeWorkflow' && String(p.workflowId && p.workflowId.value !== undefined ? p.workflowId.value : p.workflowId) === PUBLISH_ID && wf.id !== POLL_ID) {
      problems.push(`"${node.name}" calls ${PUBLISH_ID} from ${wf.id}; only the poll may`);
    }
  }
  if (isPublish) {
    const s = wf.settings || {};
    if (s.saveDataSuccessExecution !== 'none' || s.saveDataErrorExecution !== 'none' || s.saveManualExecutions !== false || s.saveExecutionProgress !== false) {
      problems.push(`${PUBLISH_ID} handles the App token, so it must save no executions`);
    }
    if (s.callerPolicy !== 'workflowsFromAList' || String(s.callerIds) !== POLL_ID) problems.push(`${PUBLISH_ID} must be callable by ${POLL_ID} only`);
    const triggers = wf.nodes.filter((n) => /trigger$/i.test(n.type) || n.type === 'n8n-nodes-base.webhook');
    if (triggers.length !== 1 || triggers[0].type !== 'n8n-nodes-base.executeWorkflowTrigger') problems.push(`${PUBLISH_ID} must have one trigger, the Execute Workflow trigger`);
    for (const t of templates) {
      if (!writes.some((w) => w.node === t.node)) problems.push(`${PUBLISH_ID} is missing the "${t.node}" write`);
    }
  } else {
    // A call into the sub-workflow must be reachable only through the gate's true output.
    const calls = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.executeWorkflow' && String(n.parameters.workflowId) === PUBLISH_ID).map((n) => n.name);
    if (calls.length) {
      const all = edges(wf);
      const targets = new Set([].concat(...Object.values(all)));
      const triggers = wf.nodes.map((n) => n.name).filter((n) => !targets.has(n));
      const ungated = reach(edges(wf, (from, index) => from === GATE_NODE && index === 0), triggers);
      const trueOut = (((wf.connections[GATE_NODE] || {}).main || [])[0] || []).map((l) => l.node);
      const gated = reach(all, trueOut);
      for (const c of calls) {
        if (ungated.has(c) || !gated.has(c)) problems.push(`"${c}" calls ${PUBLISH_ID} outside the "${GATE_NODE}" node's true output`);
        else writes.push({ node: c, method: 'CALL', path: `${PUBLISH_ID}, after "${GATE_NODE}" (true)` });
      }
      const gate = wf.nodes.find((n) => n.name === GATE_NODE);
      const conds = gate ? JSON.stringify(gate.parameters.conditions) : '';
      if (!conds.includes('"rightValue":"labels"') || !conds.includes('"combinator":"and"')) problems.push(`"${GATE_NODE}" must test write_mode == labels`);
    }
  }
  return { problems, writes };
}

module.exports = { PUBLISH_ID, writeTemplates, checkWrites };
if (require.main !== module) return;

const here = __dirname;
const workflowsDir = path.join(here, '..', 'workflows');
const rules = fs.readFileSync(path.join(here, 'rules.js'), 'utf8');
const write = process.argv.includes('--write');
const rulesModule = require('./rules.js');
const config = rulesModule.loadConfig(fs.readFileSync(path.join(here, 'config.yaml'), 'utf8'));
const LABELS = rulesModule.managedLabels(config);

let problems = 0;
let copies = 0;
const found = [];
const files = fs.readdirSync(workflowsDir).filter((f) => f.endsWith('.json')).sort();
let publishSeen = false;

function fail(msg) {
  console.error(`FAIL ${msg}`);
  problems++;
}

for (const file of files) {
  const full = path.join(workflowsDir, file);
  const text = fs.readFileSync(full, 'utf8');
  const wf = JSON.parse(text);
  let changed = false;
  let copiesHere = 0;

  for (const node of wf.nodes) {
    if (node.type === 'n8n-nodes-base.code') {
      const code = node.parameters.jsCode || '';
      const b = code.indexOf(BEGIN);
      const e = code.indexOf(END);
      if (b === -1 && e === -1) continue;
      if (b === -1 || e === -1 || e < b) {
        fail(`${file}: node "${node.name}" has unbalanced rules.js markers`);
        continue;
      }
      copies++;
      copiesHere++;
      const current = code.slice(b + BEGIN.length, e);
      if (current !== rules) {
        if (write) {
          node.parameters.jsCode = code.slice(0, b + BEGIN.length) + rules + code.slice(e);
          changed = true;
          console.log(`updated ${file}: "${node.name}"`);
        } else {
          fail(`${file}: node "${node.name}" differs from rules.js (run with --write)`);
        }
      }
    }

    // The service-account token must never be saved with run data.
    if (node.type === 'n8n-nodes-base.readWriteFile' && /serviceaccount/.test(String(node.parameters.fileSelector || ''))) {
      const s = wf.settings || {};
      if (s.saveDataSuccessExecution !== 'none' || s.saveDataErrorExecution !== 'none' || s.saveManualExecutions !== false) {
        fail(`${file}: "${node.name}" reads the service-account token, so the workflow must save no executions`);
      }
    }

  }

  if (wf.id === PUBLISH_ID) publishSeen = true;
  const checked = checkWrites(wf, LABELS, config.status_context);
  for (const p of checked.problems) fail(`${file}: ${p}`);
  for (const w of checked.writes) found.push(`${file}: ${w.path} in "${w.node}"`);

  // One copy per workflow: other nodes pass data to the node that holds it.
  if (copiesHere > 1) fail(`${file}: ${copiesHere} Code nodes carry rules.js; keep it in one`);
  if (changed) fs.writeFileSync(full, `${JSON.stringify(wf, null, 2)}\n`);
}

if (copies === 0) fail('no Code node carries rules.js');
if (!publishSeen) fail(`no workflow has id ${PUBLISH_ID}`);
if (problems) process.exit(1);
for (const f of found) console.log(`write: ${f}`);
console.log(`ok: ${copies} Code node(s) match rules.js; ${found.length - 1} write(s), all in ${PUBLISH_ID}, reached only through "${GATE_NODE}" (true)`);
