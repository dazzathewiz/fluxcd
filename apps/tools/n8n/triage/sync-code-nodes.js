#!/usr/bin/env node
'use strict';
// Checks that the workflow Code node marked with the rules.js markers carries
// rules.js verbatim, that no workflow carries more than one copy, that every
// non-GET request is one of the two digest writes and sits after the Write
// gate's true output, and that a workflow reading the service-account token
// saves no executions. Run before every push (this repo has no CI):
//   node apps/tools/n8n/triage/sync-code-nodes.js           # check, exit 1 on drift
//   node apps/tools/n8n/triage/sync-code-nodes.js --write   # copy rules.js into the nodes

const fs = require('node:fs');
const path = require('node:path');

const BEGIN = '// ==== BEGIN rules.js (verbatim copy; edit triage/rules.js) ====\n';
const END = '\n// ==== END rules.js ====\n';
const GATE_NODE = 'Write gate';


// The only non-GET requests any workflow may make: create the digest issue
// (title and body), or edit its body. Matched exactly, so a write can't reach
// labels, comments, statuses, merges, reviews or refs, and a PATCH can't carry
// state, title, labels or assignees.
const WRITE_TEMPLATES = [
  {
    method: 'POST',
    url: '=https://api.github.com/repos/{{ $json.repo }}/issues',
    jsonBody: '={{ JSON.stringify({ title: $json.title, body: $json.body }) }}',
  },
  {
    method: 'PATCH',
    url: '=https://api.github.com/repos/{{ $json.repo }}/issues/{{ Number($json.issue_number) }}',
    jsonBody: '={{ JSON.stringify({ body: $json.body }) }}',
  },
];
const HEADERS = ['Accept', 'X-GitHub-Api-Version'];

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

// Problems with the workflow's non-GET source-host requests, and the writes that pass.
function checkWrites(wf) {
  const problems = [];
  const writes = [];
  const all = edges(wf);
  const targets = new Set([].concat(...Object.values(all)));
  const triggers = wf.nodes.map((n) => n.name).filter((n) => !targets.has(n));
  // Reachable from a trigger without the gate's true output: a write here could run with write_mode off.
  const ungated = reach(edges(wf, (from, index) => from === GATE_NODE && index === 0), triggers);
  const gated = reach(all, ((wf.connections[GATE_NODE] || {}).main || [])[0] ? wf.connections[GATE_NODE].main[0].map((l) => l.node) : []);
  for (const node of wf.nodes) {
    if (node.type !== 'n8n-nodes-base.httpRequest') continue;
    const p = node.parameters || {};
    const method = String(p.method || 'GET').toUpperCase();
    if (method === 'GET') continue;
    // A source-host request: it names GitHub or carries the GitHub credential.
    const github = /github\.com/i.test(String(p.url || '')) || p.nodeCredentialType === 'githubApi' || !!(node.credentials || {}).githubApi;
    if (!github) continue;
    const t = WRITE_TEMPLATES.find((w) => w.method === method && w.url === p.url && w.jsonBody === p.jsonBody);
    const headers = ((p.headerParameters || {}).parameters || []).map((h) => h.name);
    if (!t) {
      problems.push(`"${node.name}" is a ${method} to ${p.url} that matches neither digest write`);
      continue;
    }
    if (p.sendBody !== true || p.specifyBody !== 'json' || p.sendQuery || p.bodyParameters || !headers.every((h) => HEADERS.includes(h))) {
      problems.push(`"${node.name}" sends something besides its JSON body (query, form body or extra headers)`);
      continue;
    }
    if (ungated.has(node.name) || !gated.has(node.name)) {
      problems.push(`"${node.name}" is a GitHub ${method} outside the "${GATE_NODE}" node's true output`);
      continue;
    }
    writes.push({ node: node.name, method, url: p.url });
  }
  return { problems, writes };
}

module.exports = { WRITE_TEMPLATES, checkWrites };
if (require.main !== module) return;

const here = __dirname;
const workflowsDir = path.join(here, '..', 'workflows');
const rules = fs.readFileSync(path.join(here, 'rules.js'), 'utf8');
const write = process.argv.includes('--write');

let problems = 0;
let copies = 0;
const found = [];

function fail(msg) {
  console.error(`FAIL ${msg}`);
  problems++;
}

for (const file of fs.readdirSync(workflowsDir).filter((f) => f.endsWith('.json')).sort()) {
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

  const writes = checkWrites(wf);
  for (const p of writes.problems) fail(`${file}: ${p}`);
  for (const w of writes.writes) found.push(`${file}: ${w.method} ${w.url.replace(/^=/, '')} in "${w.node}", after "${GATE_NODE}" (true)`);

  // One copy per workflow: other nodes pass data to the node that holds it.
  if (copiesHere > 1) fail(`${file}: ${copiesHere} Code nodes carry rules.js; keep it in one`);
  if (changed) fs.writeFileSync(full, `${JSON.stringify(wf, null, 2)}\n`);
}

if (copies === 0) fail('no Code node carries rules.js');
if (problems) process.exit(1);
for (const f of found) console.log(`write: ${f}`);
console.log(`ok: ${copies} Code node(s) match rules.js; ${found.length} write(s), each a digest write after "${GATE_NODE}"`);
