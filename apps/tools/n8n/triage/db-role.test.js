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

test('roles.sql grants only what the workflows use, inside the triage schema', () => {
  const sql = read('triage/roles.sql');
  const grants = sql.split('\n').filter((l) => /^\s*GRANT /.test(l));
  for (const g of grants) {
    assert.ok(!/\b(DELETE|TRUNCATE|ALL|REFERENCES|TRIGGER|CREATE)\b/.test(g), `too broad: ${g}`);
    assert.match(g, /\bTO triage;$/);
    assert.match(g, /(SCHEMA triage|triage\.)/, `outside the triage schema: ${g}`);
  }
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
