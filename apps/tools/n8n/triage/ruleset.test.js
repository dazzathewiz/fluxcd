'use strict';
// Run with: node --test apps/tools/n8n/triage/
// Verdicts are kept per ruleset (the hashes of rules.js and config.yaml), so a
// rules change re-triages open PRs unless a verdict was finalised. These tests
// pin that wiring across the schema, the seed and the poll workflow's SQL.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const N8N = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(N8N, p), 'utf8');
const node = (name) => JSON.parse(read('workflows/triage-poll.json')).nodes.find((n) => n.name === name);
const squash = (s) => s.replace(/\s+/g, ' ');

test('the schema keys verdicts by ruleset and drops the old per-SHA constraint', () => {
  const sql = read('triage/schema.sql');
  assert.match(sql, /ALTER TABLE triage\.verdicts ADD COLUMN IF NOT EXISTS ruleset text;/);
  assert.match(sql, /ALTER TABLE triage\.verdicts ADD COLUMN IF NOT EXISTS finalised_at timestamptz;/);
  assert.match(sql, /ALTER TABLE triage\.runs ADD COLUMN IF NOT EXISTS ruleset text;/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS verdicts_repo_pr_head_sha_key;/);
  assert.match(squash(sql), /CREATE UNIQUE INDEX IF NOT EXISTS \w+ ON triage\.verdicts \(repo, pr, head_sha, ruleset\);/);
  assert.ok(!/UNIQUE \(repo, pr, head_sha\)/.test(sql), 'a fresh table must not get the old constraint back');
});

test('the seed loads rules.js and config.yaml with their hashes', () => {
  const seed = read('triage/seed.sql');
  for (const f of ['config.yaml', 'rules.js']) {
    assert.match(seed, new RegExp(`\\\\set \\w+ \`cat /triage/${f.replace('.', '\\.')}\``));
    assert.match(seed, new RegExp(`VALUES \\('${f.replace('.', '\\.')}', :'\\w+', encode\\(sha256`));
  }
  const kust = read('kustomization.yaml');
  assert.match(kust, /triage\/rules\.js/, 'rules.js must be in the n8n-triage ConfigMap');
});

test('Start run builds the ruleset and filters ETags and seen SHAs by it', () => {
  const q = squash(node('Start run').parameters.query);
  assert.match(q, /'r' \|\| left\(rules\.sha256, 12\) \|\| '\.c' \|\| left\(cfg\.sha256, 12\)/);
  assert.match(q, /INSERT INTO triage\.runs \(started, ruleset\)/);
  assert.match(q, /RETURNING id, ruleset/);
  assert.match(q, /WHERE finished IS NOT NULL AND ruleset = \(SELECT ruleset FROM active\)/);
  assert.match(q, /AND \(ruleset = run\.ruleset OR finalised_at IS NOT NULL\)\) AS seen/);
  assert.match(q, /run\.ruleset,/);
});

test('Insert verdict writes the ruleset and conflicts on it', () => {
  const n = node('Insert verdict');
  assert.match(n.parameters.query, /ON CONFLICT \(repo, pr, head_sha, ruleset\) DO NOTHING/);
  assert.match(n.parameters.query, /checks, ruleset\)\nVALUES \(\$1, \$2, \$3, \$4, \$5, \$6::jsonb, \$7::jsonb, \$8\)/);
  assert.match(n.parameters.options.queryReplacement, /JSON\.stringify\(\$json\.checks\), \$json\.ruleset\] \}\}$/);
});

test('the Triage driver refuses a run without a ruleset and stamps each verdict', () => {
  const code = node('Triage').parameters.jsCode;
  const driver = code.slice(code.indexOf('// ==== END rules.js ===='));
  assert.match(driver, /if \(!first\.ruleset\) throw new Error/);
  assert.equal((driver.match(/ruleset: first\.ruleset,/g) || []).length, 2, 'verdict items and the run item');
});

test('the triage role can insert but not finalise verdicts', () => {
  const grants = read('triage/roles.sql').split('\n').filter((l) => /^\s*GRANT /.test(l) && /triage\.verdicts/.test(l));
  assert.ok(grants.length > 0);
  for (const g of grants) assert.ok(!/\bUPDATE\b/.test(g), `finalising is a manual step: ${g}`);
});
