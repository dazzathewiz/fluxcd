'use strict';
// Run with: node --test apps/tools/db-backup/
// Exercises scripts/lib.sh check_usage: the backup job fails, and so pings Home
// Assistant with ok:false, when the dump volume is over USAGE_LIMIT percent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LIB = path.join(__dirname, 'scripts', 'lib.sh');
// df replaced by busybox's POSIX output for a volume at the given Capacity.
const fakeDf = (capacity) => `df() { printf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on' '/dev/mapper/pvc-x 5074592 0 0 ${capacity} /backup'; }`;
function check(capacity, env = {}) {
  const r = spawnSync('sh', ['-c', `set -eu; . "${LIB}"; ${fakeDf(capacity)}; check_usage /backup`], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { ok: r.status === 0, out: r.stdout };
}

test('80% or less passes and logs the df lines and the percent', () => {
  for (const c of ['0%', '7%', '79%', '80%']) {
    const r = check(c);
    assert.ok(r.ok, c);
    assert.match(r.out, /^Filesystem .*Capacity Mounted on\n/);
    assert.match(r.out, new RegExp(`/backup: ${c.slice(0, -1)}% used \\(limit 80%\\)\\n$`));
  }
});

test('above 80% fails', () => {
  for (const c of ['81%', '95%', '100%']) {
    const r = check(c);
    assert.ok(!r.ok, c);
    assert.match(r.out, new RegExp(`/backup: ${c.slice(0, -1)}% used, over the 80% limit\\n$`));
  }
});

test('USAGE_LIMIT is honoured', () => {
  assert.ok(!check('51%', { USAGE_LIMIT: '50' }).ok);
  assert.ok(check('50%', { USAGE_LIMIT: '50' }).ok);
});

test('no number from df fails rather than passing silently', () => {
  for (const c of ['', '-', 'x%']) assert.ok(!check(c).ok, JSON.stringify(c));
});

test('used_pct reads the real df on this machine', () => {
  const r = spawnSync('sh', ['-c', `. "${LIB}"; used_pct "${__dirname}"`], { encoding: 'utf8' });
  assert.match(r.stdout.trim(), /^\d{1,3}$/);
});

test('backup.sh fails the run on usage after the dumps and before the ping', () => {
  const s = fs.readFileSync(path.join(__dirname, 'scripts', 'backup.sh'), 'utf8');
  const usage = s.indexOf('check_usage "$OUT" || failed="$failed backup-volume"');
  assert.ok(usage > s.indexOf('backup_db inventree'), 'after both dumps and their rotation');
  assert.ok(usage < s.indexOf('body=$('), 'before the Home Assistant ping is built');
  assert.match(s, /pg_database_size\(current_database\(\)\)/);
  assert.match(s, /ORDER BY pg_total_relation_size\(c\.oid\) DESC LIMIT 5/);
  assert.match(s, /\|\| echo "n8n: size report FAILED"/, 'the size report is logging only');
});
