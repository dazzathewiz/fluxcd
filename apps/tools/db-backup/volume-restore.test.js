'use strict';
// Run with: node --test apps/tools/db-backup/
// Exercises find_pgdata and hba_local_trust in scripts/lib.sh, which
// volume-restore-test.sh uses on a mounted copy of a database volume.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LIB = path.join(__dirname, 'scripts', 'lib.sh');
const run = (script) =>
  spawnSync('sh', ['-c', `set -eu; . "${LIB}"; ${script}`], { encoding: 'utf8' });
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'db-volume-restore-'));
const write = (p, body = '') => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

test('find_pgdata finds the pgdata subdirectory n8n-db uses', () => {
  const mnt = scratch();
  fs.mkdirSync(path.join(mnt, 'lost+found'));
  write(path.join(mnt, 'pgdata', 'PG_VERSION'), '17\n');
  const r = run(`find_pgdata "${mnt}"`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), path.join(mnt, 'pgdata'));
});

test('find_pgdata falls back to the volume root', () => {
  const mnt = scratch();
  write(path.join(mnt, 'PG_VERSION'), '17\n');
  const r = run(`find_pgdata "${mnt}"`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), mnt);
});

test('find_pgdata prefers pgdata when both have PG_VERSION', () => {
  const mnt = scratch();
  write(path.join(mnt, 'PG_VERSION'), '16\n');
  write(path.join(mnt, 'pgdata', 'PG_VERSION'), '17\n');
  assert.equal(run(`find_pgdata "${mnt}"`).stdout.trim(), path.join(mnt, 'pgdata'));
});

test('find_pgdata fails with no output when there is no PG_VERSION', () => {
  const mnt = scratch();
  fs.mkdirSync(path.join(mnt, 'pgdata'));
  const r = run(`find_pgdata "${mnt}"`);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
});

const hba = (body) => {
  const f = path.join(scratch(), 'pg_hba.conf');
  fs.writeFileSync(f, body);
  return run(`hba_local_trust "${f}"`).status;
};

test('hba_local_trust accepts the image default: local trust first', () => {
  assert.equal(
    hba(`# TYPE  DATABASE  USER  ADDRESS  METHOD
# "local" is for Unix domain socket connections only
local   all       all              trust
host    all       all   127.0.0.1/32  trust
host all all all scram-sha-256
`),
    0,
  );
});

test('hba_local_trust rejects a first local rule that is not trust for all', () => {
  assert.equal(hba('local all all scram-sha-256\nlocal all all trust\n'), 1);
  assert.equal(hba('local n8n all trust\n'), 1);
  assert.equal(hba('local all n8n trust\n'), 1);
});

test('hba_local_trust rejects a file with no local rule, or no file', () => {
  assert.equal(hba('# local all all trust\nhost all all all trust\n'), 1);
  assert.equal(run(`hba_local_trust "${scratch()}/missing"`).status, 1);
});
