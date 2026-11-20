'use strict';
// Run with: node --test apps/tools/db-backup/
// Exercises scripts/lib.sh (naming, newest, retention) on plain files with sh.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LIB = path.join(__dirname, 'scripts', 'lib.sh');
const sh = (script, env = {}) =>
  execFileSync('sh', ['-c', `set -eu; . "${LIB}"; ${script}`], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-backup-'));
  return dir;
}
const touch = (dir, name, ageDays = 0) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, '');
  const t = Date.now() / 1000 - ageDays * 86400;
  fs.utimesSync(p, t, t);
};
// 20 nightly dumps, 1–20 Nov, each with its .sha256.
const stamp = (day) => `202611${String(day).padStart(2, '0')}T1030Z`;
function seed(dir, db = 'n8n') {
  for (let d = 1; d <= 20; d++) {
    touch(dir, `${db}-${stamp(d)}.dump`);
    touch(dir, `${db}-${stamp(d)}.dump.sha256`);
  }
}

test('dump_name is <db>-<UTC yyyymmddThhmmZ>.dump', () => {
  assert.match(sh('dump_name n8n').trim(), /^n8n-\d{8}T\d{4}Z\.dump$/);
});

test('prune keeps the newest 14 dumps and their .sha256, deletes the rest in pairs', () => {
  const dir = scratch();
  seed(dir);
  sh(`prune "${dir}" n8n`);
  const left = fs.readdirSync(dir).sort();
  const dumps = left.filter((f) => f.endsWith('.dump'));
  assert.equal(dumps.length, 14);
  assert.equal(dumps[0], `n8n-${stamp(7)}.dump`);
  assert.equal(dumps[13], `n8n-${stamp(20)}.dump`);
  for (const d of dumps) assert.ok(left.includes(`${d}.sha256`), `${d}.sha256 kept`);
  assert.equal(left.length, 28, 'no orphaned .sha256');
});

test('prune ignores other databases and fresh .tmp, deletes .tmp older than a day', () => {
  const dir = scratch();
  seed(dir);
  touch(dir, `other-${stamp(1)}.dump`);
  touch(dir, `n8n-${stamp(21)}.dump.tmp`);
  touch(dir, `n8n-${stamp(19)}.dump.tmp`, 2);
  sh(`prune "${dir}" n8n`);
  const left = fs.readdirSync(dir);
  assert.ok(left.includes(`other-${stamp(1)}.dump`));
  assert.ok(left.includes(`n8n-${stamp(21)}.dump.tmp`), 'a running dump is left alone');
  assert.ok(!left.includes(`n8n-${stamp(19)}.dump.tmp`), 'stale .tmp deleted');
  assert.equal(left.filter((f) => /^n8n-.*\.dump$/.test(f)).length, 14);
});

test('a .tmp never counts as a dump, so it can neither be restored nor push a dump out', () => {
  const dir = scratch();
  seed(dir);
  touch(dir, `n8n-${stamp(25)}.dump.tmp`);
  assert.equal(sh(`newest_dump "${dir}" n8n`).trim(), `n8n-${stamp(20)}.dump`);
  sh(`prune "${dir}" n8n`);
  assert.ok(fs.existsSync(path.join(dir, `n8n-${stamp(7)}.dump`)));
});

test('KEEP is honoured and prune is idempotent', () => {
  const dir = scratch();
  seed(dir);
  sh(`prune "${dir}" n8n`, { KEEP: '3' });
  sh(`prune "${dir}" n8n`, { KEEP: '3' });
  assert.equal(fs.readdirSync(dir).length, 6);
});

test('an empty directory is fine', () => {
  const dir = scratch();
  sh(`prune "${dir}" n8n`);
  assert.equal(sh(`newest_dump "${dir}" n8n || true`).trim(), '');
});
