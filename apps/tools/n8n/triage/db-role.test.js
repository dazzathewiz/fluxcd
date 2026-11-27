'use strict';
// Run with: node --test apps/tools/n8n/triage/
// The workflows' postgres credential logs in as the least-privilege `triage`
// role. These tests pin the wiring between the ExternalSecret, the role SQL
// and the initContainer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const N8N = path.join(HERE, '..');
const read = (p) => fs.readFileSync(path.join(N8N, p), 'utf8');

test('the overwrite logs in as triage with the same derived password the role gets', () => {
  const es = read('externalsecret.yaml');
  const derived = es.match(/TRIAGE_DB_PASSWORD: '\{\{ (printf "[^"]+" \.DB_POSTGRESDB_PASSWORD \| sha256sum) \}\}'/);
  assert.ok(derived, 'TRIAGE_DB_PASSWORD is templated from db-password');
  const overwrite = es.match(/CREDENTIALS_OVERWRITE_DATA: >-\n([\s\S]*?)\n {2}data:/)[1];
  assert.match(overwrite, /"user":"triage"/);
  assert.ok(!/"user":"n8n"/.test(overwrite), 'the workflows must not log in as the superuser');
  assert.ok(overwrite.includes(`{{ ${derived[1]} | toJson }}`), 'overwrite password must match TRIAGE_DB_PASSWORD');
});

// The GRANT lines for one role.
const grantsTo = (sql, role) => sql.split('\n').filter((l) => /^\s*GRANT /.test(l) && new RegExp(`\\bTO ${role};$`).test(l));

test('roles.sql grants only what the workflows use, inside the triage schema', () => {
  const sql = read('triage/roles.sql');
  const all = sql.split('\n').filter((l) => /^\s*GRANT /.test(l));
  const grants = grantsTo(sql, 'triage');
  assert.equal(all.length, grants.length + grantsTo(sql, 'triage_render').length, 'every GRANT names triage or triage_render');
  for (const g of grants) {
    assert.ok(!/\b(DELETE|TRUNCATE|ALL|REFERENCES|TRIGGER|CREATE)\b/.test(g), `too broad: ${g}`);
    assert.match(g, /\bTO triage;$/);
    assert.match(g, /(SCHEMA triage|triage\.)/, `outside the triage schema: ${g}`);
  }
  // The one way the role deletes: the heartbeat's retention function, run as its owner.
  assert.match(sql, /^GRANT EXECUTE ON FUNCTION triage\.prune_runs\(\) TO triage;$/m);
  const revoke = sql.indexOf('REVOKE ALL ON FUNCTION triage.prune_runs() FROM PUBLIC, triage;');
  assert.ok(revoke >= 0 && revoke < sql.indexOf('GRANT EXECUTE ON FUNCTION triage.prune_runs()'), 'PUBLIC loses EXECUTE before triage gets it');
  assert.equal(grants.filter((g) => /\bFUNCTION\b/.test(g)).length, 1, 'no other function grant');
  assert.match(sql, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT/);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA triage FROM triage;/);
  assert.match(sql, /RAISE EXCEPTION 'TRIAGE_DB_PASSWORD is missing or too short'/);
});

test('the triage-schema initContainer runs roles.sql with the derived password', () => {
  const dep = read('deployment.yaml');
  const init = dep.split(/^      - name: import-workflows$/m)[0];
  assert.match(init, /-f \/triage\/schema\.sql -f \/triage\/seed\.sql -f \/triage\/roles\.sql/);
  assert.match(init, /- name: TRIAGE_DB_PASSWORD\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: n8n-secrets\n\s+key: TRIAGE_DB_PASSWORD/);
  assert.match(read('kustomization.yaml'), /- triage\/roles\.sql/);
});

test('R11: triage queues render requests and reads renders, and nothing more on them', () => {
  const sql = read('triage/roles.sql');
  const on = (t) => grantsTo(sql, 'triage').filter((g) => new RegExp(`triage\\.${t}\\b`).test(g));
  assert.deepEqual(on('render_requests'), ['GRANT SELECT, INSERT ON triage.render_requests TO triage;']);
  assert.deepEqual(on('renders'), ['GRANT SELECT ON triage.renders TO triage;']);
  assert.match(sql, /^GRANT USAGE ON SEQUENCE .*triage\.render_requests_id_seq TO triage;$/m);
});

test('triage_render: claims and finishes requests and inserts renders, nothing else, no DELETE', () => {
  const sql = read('triage/roles.sql');
  assert.deepEqual(grantsTo(sql, 'triage_render'), [
    'GRANT USAGE ON SCHEMA triage TO triage_render;',
    'GRANT SELECT, UPDATE ON triage.render_requests TO triage_render;',
    'GRANT INSERT ON triage.renders TO triage_render;',
  ]);
  assert.match(sql, /ALTER ROLE triage_render WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT\n\s+NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD :'render_password';/);
  for (const what of ['ALL TABLES IN SCHEMA triage', 'ALL SEQUENCES IN SCHEMA triage', 'ALL FUNCTIONS IN SCHEMA triage', 'SCHEMA triage']) {
    assert.ok(sql.includes(`REVOKE ALL ON ${what} FROM triage_render;`), what);
  }
  assert.match(sql, /\\getenv render_password TRIAGE_RENDER_DB_PASSWORD/);
  assert.match(sql, /RAISE EXCEPTION 'TRIAGE_RENDER_DB_PASSWORD is missing or too short'/);
  assert.match(sql, /SELECT 'CREATE ROLE triage_render' WHERE NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'triage_render'\) \\gexec/);
  // The pod log still ends with the line the rollout check looks for.
  assert.match(sql, /SELECT 'triage role ready' AS status;\n$/);
});

test('the render password reaches the initContainer from n8n-secrets, and the CronJob from its own Secret', () => {
  const es = read('externalsecret.yaml');
  assert.equal((es.match(/property: triage-render-db-password/g) || []).length, 2, 'one field, read by both ExternalSecrets');
  const own = es.slice(es.indexOf('  name: triage-render-secrets'));
  assert.deepEqual(Array.from(own.matchAll(/- secretKey: ([A-Z0-9_]+)/g)).map((m) => m[1]), ['TRIAGE_RENDER_DB_PASSWORD'], 'that value and nothing else');
  const init = read('deployment.yaml').split(/^      - name: import-workflows$/m)[0];
  assert.match(init, /- name: TRIAGE_RENDER_DB_PASSWORD\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: n8n-secrets\n\s+key: TRIAGE_RENDER_DB_PASSWORD/);
  const job = read('triage-render.yaml');
  assert.match(job, /- name: PGPASSWORD\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: triage-render-secrets\n\s+key: TRIAGE_RENDER_DB_PASSWORD/);
  assert.match(job, /- name: PGUSER\n\s+value: "triage_render"/);
  assert.ok(!/n8n-secrets/.test(job), 'the CronJob reads nothing from n8n-secrets');
});
