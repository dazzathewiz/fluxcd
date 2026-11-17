'use strict';
// Run with: node --test apps/tools/n8n/triage/
// Verdicts are kept per ruleset (the hashes of rules.js and config.yaml), so a
// rules change re-triages open PRs unless a verdict was finalised. These tests
// pin that wiring across the schema, the seed and the poll workflow's SQL.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

test('Insert verdict writes the ruleset, carried_from and finalised_at, and conflicts on the ruleset', () => {
  const n = node('Insert verdict');
  const q = squash(n.parameters.query);
  assert.match(q, /ON CONFLICT \(repo, pr, head_sha, ruleset\) DO NOTHING/);
  assert.match(q, /checks, ruleset, carried_from, finalised_at\) VALUES \(\$1, \$2, \$3, \$4, \$5, \$6::jsonb, NULLIF\(\$7::jsonb, 'null'::jsonb\), \$8, NULLIF\(\$9::bigint, 0\), CASE WHEN \$10::boolean THEN now\(\) END\)/);
  assert.match(n.parameters.options.queryReplacement, /JSON\.stringify\(\$json\.checks\), \$json\.ruleset, \$json\.carried_from \|\| 0, \$json\.finalise === true\] \}\}$/);
});

test('the schema allows the human verdict and carried rows with no checks, idempotently', () => {
  const sql = read('triage/schema.sql');
  assert.match(sql, /ALTER TABLE triage\.verdicts ADD COLUMN IF NOT EXISTS carried_from bigint REFERENCES triage\.verdicts \(id\);/);
  assert.match(sql, /ALTER TABLE triage\.verdicts ALTER COLUMN checks DROP NOT NULL;/);
  // Dropped by name first, then re-added: the live constraint is verdicts_verdict_check.
  assert.match(squash(sql), /DROP CONSTRAINT IF EXISTS verdicts_verdict_check; ALTER TABLE triage\.verdicts ADD CONSTRAINT verdicts_verdict_check CHECK \(verdict IN \('blocked', 'needs-claude', 'review', 'low-risk', 'human'\)\);/);
  assert.match(squash(sql), /DROP CONSTRAINT IF EXISTS verdicts_checks_or_carried; ALTER TABLE triage\.verdicts ADD CONSTRAINT verdicts_checks_or_carried CHECK \(\(checks IS NULL\) <> \(carried_from IS NULL\)\);/);
  const create = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS triage.verdicts'), sql.indexOf(');', sql.indexOf('CREATE TABLE IF NOT EXISTS triage.verdicts')));
  assert.ok(!/CHECK \(verdict IN/.test(create), 'the CHECK is added by name, so a fresh table gets no second, unnamed one');
  assert.ok(!/checks\s+jsonb NOT NULL/.test(create));
});

test('Start run reads the latest verdict per head SHA, resolving carried rows to their full row', () => {
  const q = squash(node('Start run').parameters.query);
  assert.match(q, /SELECT DISTINCT ON \(v\.repo, v\.pr, v\.head_sha\) v\.repo \|\| '#' \|\| v\.pr \|\| '@' \|\| v\.head_sha AS k/);
  assert.match(q, /'id', coalesce\(v\.carried_from, v\.id\)/);
  assert.match(q, /jsonb_array_elements\(coalesce\(v\.checks, src\.checks\)\)/);
  assert.match(q, /LEFT JOIN triage\.verdicts src ON src\.id = v\.carried_from/);
  assert.match(q, /ORDER BY v\.repo, v\.pr, v\.head_sha, v\.id DESC\) latest\) AS previous/);
});

test('the Triage driver refuses a run without a ruleset and stamps each verdict', () => {
  const code = node('Triage').parameters.jsCode;
  const driver = code.slice(code.indexOf('// ==== END rules.js ===='));
  assert.match(driver, /if \(!first\.ruleset\) throw new Error/);
  assert.equal((driver.match(/ruleset: first\.ruleset,/g) || []).length, 2, 'verdict items and the run item');
  assert.match(driver, /const carry = carryForward\(r, \(first\.previous \|\| \{\}\)\[`\$\{s\.repo\}#\$\{pr\.number\}@\$\{pr\.head\.sha\}`\]\);/);
  assert.match(driver, /checks: carry\.checks,\n\s+carried_from: carry\.carried_from,\n\s+finalise: r\.finalise === true,/);
});

// Runs the Triage node's real code on one open PR, the caddy fixture, with a
// given previous verdict for its head SHA.
async function runDriver(previous) {
  const fx = JSON.parse(read('triage/fixtures/caddy-patch.json'));
  const f = fx.facts;
  const key = `dazzathewiz/fluxcd#${f.pr.number}@${f.pr.head_sha}`;
  const prBody = {
    number: f.pr.number, html_url: f.pr.html_url, url: `https://api.github.com/repos/dazzathewiz/fluxcd/pulls/${f.pr.number}`,
    head: { sha: f.pr.head_sha, ref: f.pr.head_ref }, base: { repo: { full_name: 'dazzathewiz/fluxcd' } },
    user: { login: f.pr.user_login }, title: f.pr.title, body: f.pr.body, created_at: f.pr.created_at,
    mergeable: f.pr.mergeable, mergeable_state: f.pr.mergeable_state, draft: false,
  };
  const out = {
    'Start run': [{ json: { run_id: 7, ruleset: 'rnew.cnew', repo: 'dazzathewiz/fluxcd', list_etag: null, config_body: read('triage/config.yaml'), config_sha: 'sha', patterns: [], seen: [], previous: previous ? { [key]: previous } : {} } }],
    'Get dashboard': [{ json: { statusCode: 200, headers: {}, body: [{ title: 'Dependency Dashboard', html_url: f.dashboard.url, body: f.dashboard.body, updated_at: 'x' }] } }],
    'List PRs': [{ json: { statusCode: 200, headers: { etag: '"l"' }, body: [{ number: f.pr.number, head: { sha: f.pr.head_sha }, created_at: f.pr.created_at, draft: false }] } }],
    'Get PR': [{ json: { statusCode: 200, headers: { etag: f.pr.etag }, body: prBody } }],
    'Get files': [{ json: { statusCode: 200, headers: { etag: f.files.etag }, body: f.files.items } }],
    'Cluster version': [{ json: { statusCode: 200, headers: {}, body: { gitVersion: 'v1.34.12+k3s1', gitCommit: 'c' } } }],
  };
  const http = async (o) => fx.http[o.url] || { statusCode: 404, headers: {}, body: '' };
  const ctx = vm.createContext({
    helpers: { httpRequest: http },
    $input: { first: () => out['Cluster version'][0], all: () => out['Cluster version'] },
    $: (n) => ({ first: () => out[n][0], all: () => out[n] }),
  });
  const code = node('Triage').parameters.jsCode;
  const items = await vm.runInContext(`module = { exports: {} }; module.exports = async function VmCodeWrapper() {${code}\n}()`, ctx);
  return JSON.parse(JSON.stringify(items.map((i) => i.json).filter((j) => j.kind === 'verdict')));
}

test('the driver carries an unchanged result forward and records a changed one in full', async () => {
  const [fresh] = await runDriver(null);
  assert.equal(fresh.verdict, 'low-risk', JSON.stringify(fresh.reasons));
  assert.equal(fresh.carried_from, null);
  assert.equal(fresh.checks.length, 9);
  assert.deepEqual(fresh.dependants.map((d) => d.id), ['media-serving']);
  const same = { id: 40, verdict: 'low-risk', results: fresh.checks.map((c) => ({ id: c.id, result: c.result })) };
  const [carried] = await runDriver(same);
  assert.equal(carried.carried_from, 40);
  assert.equal(carried.checks, null);
  assert.deepEqual(carried.reasons, fresh.reasons, 'a carried row still stores its reasons, dependants included');
  const changed = JSON.parse(JSON.stringify(same));
  changed.results[0].result = 'flag';
  const [full] = await runDriver(changed);
  assert.equal(full.carried_from, null);
  assert.equal(full.checks.length, 9);
});

test('the triage role can insert but not update or delete verdicts', () => {
  const grants = read('triage/roles.sql').split('\n').filter((l) => /^\s*GRANT /.test(l) && /triage\.verdicts/.test(l));
  assert.ok(grants.length > 0);
  for (const g of grants) assert.ok(!/\b(UPDATE|DELETE|TRUNCATE|ALL)\b/.test(g), `finalising an existing row is a manual step: ${g}`);
});
