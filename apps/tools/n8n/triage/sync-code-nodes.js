#!/usr/bin/env node
'use strict';
// Checks that the workflow Code node marked with the rules.js markers carries
// rules.js verbatim, that no workflow carries more than one copy, and that no
// GitHub write sits outside the write_mode gate. Run before every push (this
// repo has no CI):
//   node apps/tools/n8n/triage/sync-code-nodes.js           # check, exit 1 on drift
//   node apps/tools/n8n/triage/sync-code-nodes.js --write   # copy rules.js into the nodes

const fs = require('node:fs');
const path = require('node:path');

const BEGIN = '// ==== BEGIN rules.js (verbatim copy; edit triage/rules.js) ====\n';
const END = '\n// ==== END rules.js ====\n';
const GATE_NODE = 'Write gate';

const here = __dirname;
const workflowsDir = path.join(here, '..', 'workflows');
const rules = fs.readFileSync(path.join(here, 'rules.js'), 'utf8');
const write = process.argv.includes('--write');

let problems = 0;
let copies = 0;

function fail(msg) {
  console.error(`FAIL ${msg}`);
  problems++;
}

function ancestors(wf, name) {
  const parents = {};
  for (const [from, outs] of Object.entries(wf.connections || {})) {
    for (const branch of (outs.main || [])) {
      for (const link of branch || []) (parents[link.node] = parents[link.node] || []).push(from);
    }
  }
  const seen = new Set();
  const stack = [name];
  while (stack.length) {
    for (const p of parents[stack.pop()] || []) {
      if (!seen.has(p)) {
        seen.add(p);
        stack.push(p);
      }
    }
  }
  return seen;
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

    if (node.type === 'n8n-nodes-base.httpRequest') {
      const url = String(node.parameters.url || '');
      const method = String(node.parameters.method || 'GET').toUpperCase();
      if (/api\.github\.com/.test(url) && method !== 'GET' && !ancestors(wf, node.name).has(GATE_NODE)) {
        fail(`${file}: "${node.name}" is a GitHub ${method} outside the "${GATE_NODE}" node`);
      }
    }
  }

  // One copy per workflow: other nodes pass data to the node that holds it.
  if (copiesHere > 1) fail(`${file}: ${copiesHere} Code nodes carry rules.js; keep it in one`);
  if (changed) fs.writeFileSync(full, `${JSON.stringify(wf, null, 2)}\n`);
}

if (copies === 0) fail('no Code node carries rules.js');
if (problems) process.exit(1);
console.log(`ok: ${copies} Code node(s) match rules.js; no GitHub write outside "${GATE_NODE}"`);
