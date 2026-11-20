'use strict';
// Run with: node --test apps/tools/db-backup/
// Exercises wait_ready in scripts/lib.sh against a stub pg_isready on PATH.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LIB = path.join(__dirname, 'scripts', 'lib.sh');

// A pg_isready that fails the first `failures` calls, then succeeds, and logs
// its arguments. failures = Infinity never succeeds.
function stub(failures) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-backup-wait-'));
  const limit = Number.isFinite(failures) ? failures : 1e9;
  fs.writeFileSync(
    path.join(dir, 'pg_isready'),
    `#!/bin/sh
echo "$*" >> "${dir}/calls"
n=$(($(cat "${dir}/count" 2>/dev/null || echo 0) + 1))
echo "$n" > "${dir}/count"
[ "$n" -gt ${limit} ]
`,
    { mode: 0o755 },
  );
  return dir;
}
const calls = (dir) => fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n');

function waitReady(dir, env) {
  return spawnSync('sh', ['-c', `set -eu; . "${LIB}"; wait_ready n8n-db`], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...env },
  });
}

test('wait_ready retries every 2 s and reports how long it waited', () => {
  const dir = stub(2);
  const r = waitReady(dir, { WAIT_READY: '10' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const m = r.stdout.trim().match(/^n8n-db: reachable after (\d+)s$/);
  assert.ok(m, r.stdout);
  assert.ok(Number(m[1]) >= 3 && Number(m[1]) <= 6, `waited ${m[1]}s`);
  assert.deepEqual(calls(dir), Array(3).fill('-q -h n8n-db -p 5432 -t 2'));
});

test('wait_ready gives up after WAIT_READY seconds and returns 1', () => {
  const dir = stub(Infinity);
  const r = waitReady(dir, { WAIT_READY: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stdout.trim(), /^n8n-db: not reachable after [1-9]\d*s$/);
  assert.equal(calls(dir).length, 2);
});

test('a database that is up at once is checked once', () => {
  const dir = stub(0);
  const r = waitReady(dir, { WAIT_READY: '10' });
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^n8n-db: reachable after [01]s$/);
  assert.equal(calls(dir).length, 1);
});
