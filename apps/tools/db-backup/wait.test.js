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
// its arguments. failures = Infinity never succeeds. Beside it, a fake clock:
// `date +%s` prints the seconds in `clock`, and `sleep N` adds N to it and logs
// N, so wait_ready's timing never depends on the wall clock.
function stub(failures) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-backup-wait-'));
  const limit = Number.isFinite(failures) ? failures : 1e9;
  const script = (name, body) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'clock'), '1000\n');
  script('pg_isready', `echo "$*" >> "${dir}/calls"
n=$(($(cat "${dir}/count" 2>/dev/null || echo 0) + 1))
echo "$n" > "${dir}/count"
[ "$n" -gt ${limit} ]
`);
  script('date', `[ "$*" = "+%s" ] || { echo "fake date: unexpected $*" >&2; exit 2; }
cat "${dir}/clock"
`);
  script('sleep', `echo "$1" >> "${dir}/sleeps"
echo $(($(cat "${dir}/clock") + $1)) > "${dir}/clock"
`);
  return dir;
}
const lines = (dir, name) => {
  const f = path.join(dir, name);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n') : [];
};
const calls = (dir) => lines(dir, 'calls');
const sleeps = (dir) => lines(dir, 'sleeps');

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
  assert.equal(r.stdout.trim(), 'n8n-db: reachable after 4s');
  assert.deepEqual(calls(dir), Array(3).fill('-q -h n8n-db -p 5432 -t 2'));
  assert.deepEqual(sleeps(dir), ['2', '2']);
});

test('wait_ready gives up after WAIT_READY seconds and returns 1', () => {
  const dir = stub(Infinity);
  const r = waitReady(dir, { WAIT_READY: '1' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), 'n8n-db: not reachable after 2s');
  assert.equal(calls(dir).length, 2);
  assert.deepEqual(sleeps(dir), ['2']);
});

test('wait_ready stops at the first check at or past the limit', () => {
  const dir = stub(Infinity);
  const r = waitReady(dir, { WAIT_READY: '6' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), 'n8n-db: not reachable after 6s');
  assert.equal(calls(dir).length, 4);
});

test('a database that is up at once is checked once', () => {
  const dir = stub(0);
  const r = waitReady(dir, { WAIT_READY: '10' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), 'n8n-db: reachable after 0s');
  assert.equal(calls(dir).length, 1);
  assert.deepEqual(sleeps(dir), []);
});
