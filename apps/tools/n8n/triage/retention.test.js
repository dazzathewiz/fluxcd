'use strict';
// Run with: node --test apps/tools/n8n/triage/
// Execution history and run-log retention: what n8n saves and for how long,
// and the heartbeat's once-a-day prune of triage.runs and triage.watch_runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./poll-harness.js');

const N8N = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(N8N, p), 'utf8');
const wf = (f) => JSON.parse(read(`workflows/${f}`));
const BEAT = wf('triage-heartbeat.json');
const SCHEMA = read('triage/schema.sql');
const PRUNE = SCHEMA.slice(SCHEMA.indexOf('CREATE OR REPLACE FUNCTION triage.prune_runs()'));
const statements = (sql) => sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

test('n8n prunes execution history after 7 days, at most 2000 kept', () => {
  const env = read('configmap-env.yaml');
  assert.match(env, /^ {2}EXECUTIONS_DATA_PRUNE: "true"$/m);
  assert.match(env, /^ {2}EXECUTIONS_DATA_MAX_AGE: "168"$/m);
  assert.match(env, /^ {2}EXECUTIONS_DATA_PRUNE_MAX_COUNT: "2000"$/m);
});

test('the watcher and the heartbeat save failed executions only; the poll saves as before', () => {
  for (const f of ['triage-watch.json', 'triage-heartbeat.json']) {
    const s = wf(f).settings;
    assert.equal(s.saveDataSuccessExecution, 'none', f);
    assert.equal(s.saveDataErrorExecution, 'all', f);
    assert.equal(s.saveManualExecutions, undefined, `${f}: manual runs keep the instance default`);
  }
  const poll = wf('triage-poll.json').settings;
  for (const k of ['saveDataSuccessExecution', 'saveDataErrorExecution', 'saveManualExecutions']) assert.equal(poll[k], undefined, k);
});

test('Retention: a second trigger branch, below the ping chain so v1 runs it last, with nothing after it', () => {
  const n = h.nodeOf(BEAT, 'Retention');
  assert.equal(n.type, 'n8n-nodes-base.postgres');
  assert.equal(n.parameters.operation, 'executeQuery');
  assert.equal(n.credentials.postgres.id, 'triagePostgres01', 'logs in as the triage role');
  const from = BEAT.connections['Every 30 minutes'].main[0].map((l) => l.node);
  assert.deepEqual(from, ['Record last success', 'Retention']);
  assert.ok(n.position[1] > h.nodeOf(BEAT, 'Record last success').position[1], 'v1 runs branches top to bottom');
  assert.equal(BEAT.connections.Retention, undefined);
});

test('Retention: the once-a-day gate claims the retention row and prunes only when it got the claim', () => {
  const q = statements(h.nodeOf(BEAT, 'Retention').parameters.query);
  // The claim: insert on the first run, then update only when a day has passed.
  assert.match(q, /INSERT INTO triage\.heartbeat AS h \(name, last_success, checked\)\n\s+VALUES \('retention', now\(\), now\(\)\)/);
  assert.match(q, /ON CONFLICT \(name\) DO UPDATE\n\s+SET last_success = excluded\.last_success, checked = excluded\.checked\n\s+WHERE h\.last_success IS NULL OR h\.last_success <= now\(\) - interval '1 day'\n\s+RETURNING h\.name/);
  // The prune is evaluated once per claimed row, so no claim means no call.
  assert.match(q, /\nSELECT name, triage\.prune_runs\(\) AS deleted FROM claim;$/);
  assert.equal((q.match(/prune_runs/g) || []).length, 1);
  // It writes only its own heartbeat row and deletes nothing itself.
  assert.ok(!/\b(DELETE|TRUNCATE)\b|\bUPDATE triage\./.test(q), q);
  assert.ok(!/'triage-poll'/.test(q), 'leaves the poll heartbeat row alone');
});

test('prune_runs: a definer function with a pinned search_path and no parameters', () => {
  assert.match(PRUNE, /^CREATE OR REPLACE FUNCTION triage\.prune_runs\(\) RETURNS jsonb\nLANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, triage\n/);
  assert.match(SCHEMA, /every statement must be idempotent/, 'CREATE OR REPLACE re-runs on every pod start');
});

test('prune_runs: deletes runs and watch_runs started over 90 days ago, nothing else, and returns the counts', () => {
  const body = statements(PRUNE);
  const deletes = body.match(/DELETE FROM [\w.]+[^;]*;/g);
  assert.deepEqual(deletes, [
    "DELETE FROM triage.runs WHERE started < now() - interval '90 days';",
    "DELETE FROM triage.watch_runs WHERE started < now() - interval '90 days';",
  ]);
  assert.ok(!/\b(TRUNCATE|UPDATE|INSERT)\b/.test(body), 'no other write');
  assert.ok(!/\b(watches|verdicts|publications)\b/.test(body), 'leaves watches, verdicts and publications alone');
  assert.match(body, /GET DIAGNOSTICS runs_deleted = ROW_COUNT;[\s\S]*GET DIAGNOSTICS watch_runs_deleted = ROW_COUNT;/);
  assert.match(body, /RAISE LOG 'triage\.prune_runs: deleted % runs, % watch_runs', runs_deleted, watch_runs_deleted;/);
  assert.match(body, /RETURN jsonb_build_object\('runs', runs_deleted, 'watch_runs', watch_runs_deleted\);/);
});

test('rows that point at a pruned run keep their own data: the run_id FKs are ON DELETE SET NULL', () => {
  const fk = /run_id\s+bigint REFERENCES triage\.runs \(id\) ON DELETE SET NULL,/g;
  const table = (name) => SCHEMA.slice(SCHEMA.indexOf(`CREATE TABLE IF NOT EXISTS triage.${name} (`)).split(/\n\);/)[0];
  assert.match(table('verdicts'), fk);
  fk.lastIndex = 0;
  assert.match(table('publications'), fk);
  // watches.run_id is the watcher run, with no FK: pruning leaves it dangling, not deleted.
  assert.match(table('watches'), /\n\s+run_id\s+bigint,\n/);
  assert.ok(!/REFERENCES triage\.watch_runs/.test(SCHEMA), 'nothing references watch_runs');
});
