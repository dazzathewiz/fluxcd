'use strict';
// Run with: node --test apps/tools/n8n/triage/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rules = require('./rules.js');

const HERE = __dirname;
const REPO_ROOT = path.resolve(HERE, '../../../..');
const CONFIG_TEXT = fs.readFileSync(path.join(HERE, 'config.yaml'), 'utf8');
const CONFIG = rules.loadConfig(CONFIG_TEXT);

function stubHttp(map) {
  const calls = {};
  const http = async (opts) => {
    const entry = map[opts.url];
    if (entry === undefined) return { statusCode: 404, headers: {}, body: '' };
    if (Array.isArray(entry)) {
      calls[opts.url] = (calls[opts.url] || 0) + 1;
      return entry[Math.min(calls[opts.url], entry.length) - 1];
    }
    return entry;
  };
  return http;
}

function loadFixtures() {
  const dir = path.join(HERE, 'fixtures');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => Object.assign({ file: f }, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))));
}

function withConfigSha(facts) {
  return Object.assign({ config_sha: 'test-config-sha' }, facts);
}

function configFor(fx) {
  const cfg = JSON.parse(JSON.stringify(CONFIG));
  const o = fx.config_overrides || {};
  if (o.helm_index) cfg.helm_index = Object.assign({}, cfg.helm_index, o.helm_index);
  return cfg;
}

function byId(result) {
  const out = {};
  for (const c of result.checks) out[c.id] = c;
  return out;
}

// ------------------------------------------------------------ fixtures

const fixtures = loadFixtures();

test('fixtures directory has the four known-answer cases', () => {
  const names = fixtures.map((f) => f.file);
  for (const want of ['caddy-patch.json', 'longhorn-kubeversion.json', 'negative-control.json', 'postgres-major.json']) {
    assert.ok(names.includes(want), `missing fixture ${want}`);
  }
});

for (const fx of fixtures) {
  test(`fixture ${fx.file}: ${fx.name}`, async () => {
    const result = await rules.triagePR(stubHttp(fx.http || {}), withConfigSha(fx.facts), configFor(fx), rules.newCaches());
    const checks = byId(result);
    assert.equal(result.verdict, fx.expect.verdict, `verdict; reasons: ${JSON.stringify(result.reasons)}`);
    for (const [id, want] of Object.entries(fx.expect.checks || {})) {
      assert.equal(checks[id].result, want, `${id}: ${JSON.stringify(checks[id].evidence)}`);
    }
    assert.deepEqual(result.checks.map((c) => c.id), rules.CHECK_IDS);
    for (const c of result.checks) {
      assert.ok(rules.RESULTS.includes(c.result), `${c.id} result ${c.result}`);
      if (c.result !== 'not_run') {
        assert.ok(c.evidence.source_url, `${c.id} has source_url`);
        assert.ok(c.evidence.etag_or_sha, `${c.id} has etag_or_sha`);
      }
    }
    if (fx.expect.negative_control) {
      assert.equal(rules.negativeControl(fx.facts.cluster, CONFIG).result, fx.expect.negative_control);
    }
  });
}

// ------------------------------------------------------------ negative control

test('negative control fails against any real cluster version', () => {
  for (const v of ['v1.30.6+k3s1', 'v1.34.12+k3s1', 'v1.40.0']) {
    const r = rules.negativeControl({ url: 'https://kubernetes.default.svc/version', gitVersion: v, etag_or_sha: 'abc' }, CONFIG);
    assert.equal(r.result, 'fail', v);
  }
});

test('negative control without a cluster version is not_run, never pass', () => {
  assert.equal(rules.negativeControl(null, CONFIG).result, 'not_run');
  assert.equal(rules.negativeControl({ url: 'x', error: 'HTTP 503' }, CONFIG).result, 'not_run');
});

// ------------------------------------------------------------ evidence

test('a pass with no evidence becomes not_run', () => {
  const c = rules.finalize({ id: 'R8', result: 'pass', evidence: { compared: 'x' } });
  assert.equal(c.result, 'not_run');
  assert.equal(c.evidence.missing_evidence, true);
  const f = rules.finalize({ id: 'R4', result: 'fail', evidence: { source_url: 'u' } });
  assert.equal(f.result, 'not_run');
});

test('missing registry evidence turns a caddy patch into review, not low-risk', async () => {
  const fx = fixtures.find((f) => f.file === 'caddy-patch.json');
  const result = await rules.triagePR(stubHttp({}), withConfigSha(fx.facts), CONFIG, rules.newCaches());
  assert.equal(byId(result).R8.result, 'not_run');
  assert.equal(result.verdict, 'review');
});

test('missing cluster version makes R4 not_run for a chart', async () => {
  const fx = fixtures.find((f) => f.file === 'longhorn-kubeversion.json');
  const facts = Object.assign({}, withConfigSha(fx.facts), { cluster: null });
  const result = await rules.triagePR(stubHttp(fx.http), facts, CONFIG, rules.newCaches());
  assert.equal(byId(result).R4.result, 'not_run');
  assert.notEqual(result.verdict, 'low-risk');
});

// ------------------------------------------------------------ single rules

function caddyWith(mutate) {
  const fx = JSON.parse(JSON.stringify(fixtures.find((f) => f.file === 'caddy-patch.json')));
  mutate(fx);
  return fx;
}

test('R1: Renovate table disagreeing with the diff goes to review', async () => {
  const fx = caddyWith((f) => { f.facts.pr.body = f.facts.pr.body.replace('| patch |', '| minor |'); });
  const result = await rules.triagePR(stubHttp(fx.http), withConfigSha(fx.facts), CONFIG, rules.newCaches());
  assert.equal(byId(result).R1.result, 'flag');
  assert.equal(result.verdict, 'review');
});

test('R6: a release-note keyword goes to review', async () => {
  const fx = caddyWith((f) => {
    f.facts.pr.body = f.facts.pr.body.replace('---\n\n### Configuration', '---\n\n### Release Notes\n\nThis release has a BREAKING CHANGE.\n\n---\n\n### Configuration');
  });
  const result = await rules.triagePR(stubHttp(fx.http), withConfigSha(fx.facts), CONFIG, rules.newCaches());
  assert.equal(byId(result).R6.result, 'flag');
  assert.equal(result.verdict, 'review');
});

test('R8: an image without linux/amd64 is blocked', async () => {
  const fx = caddyWith((f) => {
    const key = Object.keys(f.http)[0];
    f.http[key].body = JSON.stringify({ manifests: [{ platform: { os: 'linux', architecture: 'arm64' } }] });
  });
  const result = await rules.triagePR(stubHttp(fx.http), withConfigSha(fx.facts), CONFIG, rules.newCaches());
  assert.equal(byId(result).R8.result, 'fail');
  assert.equal(result.verdict, 'blocked');
});

test('R8: a single-platform manifest is checked through its config blob', async () => {
  const fx = caddyWith((f) => {
    const key = Object.keys(f.http)[0];
    f.http[key].body = { schemaVersion: 2, config: { digest: 'sha256:cfg' }, layers: [] };
    f.http['https://registry-1.docker.io/v2/library/caddy/blobs/sha256:cfg'] = { statusCode: 200, headers: {}, body: { os: 'linux', architecture: 'amd64' } };
  });
  const result = await rules.triagePR(stubHttp(fx.http), withConfigSha(fx.facts), CONFIG, rules.newCaches());
  assert.equal(byId(result).R8.result, 'pass');
  assert.equal(result.verdict, 'low-risk');
});

test('R2: a second file makes the change wider than one line', async () => {
  const fx = caddyWith((f) => {
    f.facts.files.items.push({ filename: 'apps/tools/example/other.yaml', additions: 3, deletions: 0, patch: '@@ -1,1 +1,4 @@\n a: 1\n+b: 2\n+c: 3\n+d: 4' });
  });
  const result = await rules.triagePR(stubHttp(fx.http), withConfigSha(fx.facts), CONFIG, rules.newCaches());
  assert.equal(byId(result).R2.result, 'flag');
  assert.equal(result.verdict, 'review');
});

function chartPR(chart, from, to, file, branch) {
  return {
    repo: 'owner/fluxcd',
    now: '2026-11-14T00:00:00Z',
    config_sha: 'test-config-sha',
    pr: {
      number: 1, html_url: 'https://github.com/owner/fluxcd/pull/1', etag: 'W/"e"', head_sha: 'a'.repeat(40),
      head_ref: branch || `renovate/${chart}-x`, user_login: 'renovate[bot]', title: 't',
      body: `| Package | Type | Update | Change |\n|---|---|---|---|\n| [${chart}](https://example.invalid) | HelmChart | ${rules.classifyUpdate(from, to)} | \`${from}\` → \`${to}\` |\n`,
      created_at: '2026-11-13T00:00:00Z', mergeable: true, mergeable_state: 'clean', draft: false,
    },
    files: {
      url: 'https://api.github.com/repos/owner/fluxcd/pulls/1/files', etag: 'W/"f"',
      items: [{ filename: file, additions: 1, deletions: 1, patch: `@@ -1,4 +1,4 @@\n   chart:\n     spec:\n       chart: ${chart}\n-      version: ${from}\n+      version: ${to}` }],
    },
    dashboard: { url: 'https://api.github.com/repos/owner/fluxcd/issues/2', etag: 'W/"d"', body: '## Open\n' },
    cluster: { url: 'https://kubernetes.default.svc/version', gitVersion: 'v1.34.12+k3s1', etag_or_sha: 'c' },
    patterns: [],
  };
}

function indexFor(chart, version, kubeVersion) {
  return {
    statusCode: 200,
    headers: { etag: '"i"' },
    body: `apiVersion: v1\nentries:\n  ${chart}:\n  - name: ${chart}\n${kubeVersion ? `    kubeVersion: '${kubeVersion}'\n` : ''}    version: ${version}\n`,
  };
}

test('R5: Traefik 24 breaks the cap and is blocked', async () => {
  const facts = chartPR('traefik', '23.2.0', '24.0.0', 'infrastructure/controllers/traefik.yaml');
  const http = stubHttp({ 'https://helm.traefik.io/traefik/index.yaml': indexFor('traefik', '24.0.0') });
  const result = await rules.triagePR(http, facts, CONFIG, rules.newCaches());
  assert.equal(byId(result).R5.result, 'fail');
  assert.equal(result.verdict, 'blocked');
});

test('R5: Longhorn skipping a minor is blocked', async () => {
  const facts = chartPR('longhorn', '1.11.3', '1.13.0', 'infrastructure/controllers/longhorn.yaml');
  const http = stubHttp({ 'https://charts.longhorn.io/index.yaml': indexFor('longhorn', '1.13.0', '>=1.25.0-0') });
  const result = await rules.triagePR(http, facts, CONFIG, rules.newCaches());
  assert.equal(byId(result).R5.result, 'fail');
  assert.equal(result.verdict, 'blocked');
});

test('R5: rook-ceph reappearing is blocked', async () => {
  const facts = chartPR('rook-ceph', '1.21.0', '1.21.1', 'infrastructure/controllers/rook.yaml');
  const result = await rules.triagePR(stubHttp({}), facts, CONFIG, rules.newCaches());
  assert.equal(byId(result).R5.result, 'fail');
  assert.equal(result.verdict, 'blocked');
});

test('R5: a Portainer member outside the group branch is blocked', async () => {
  const facts = chartPR('portainer', '245.3.1', '245.3.2', 'apps/infrastructure/portainer/app/helmrelease-portainer.yaml', 'renovate/portainer-245.x');
  const http = stubHttp({ 'https://portainer.github.io/k8s/index.yaml': indexFor('portainer', '245.3.2') });
  const result = await rules.triagePR(http, facts, CONFIG, rules.newCaches());
  assert.equal(byId(result).R5.result, 'fail');
  const ok = chartPR('portainer', '245.3.1', '245.3.2', 'apps/infrastructure/portainer/app/helmrelease-portainer.yaml', 'renovate/portainer');
  const okResult = await rules.triagePR(http, ok, CONFIG, rules.newCaches());
  assert.equal(byId(okResult).R5.result, 'pass');
  assert.equal(okResult.verdict, 'low-risk', JSON.stringify(okResult.reasons));
});

test('an ungated chart patch under infrastructure/ is review, not low-risk', async () => {
  const facts = chartPR('tailscale-operator', '1.104.4', '1.104.7', 'infrastructure/tailscale/helmrelease.yaml');
  const http = stubHttp({ 'https://pkgs.tailscale.com/helmcharts/index.yaml': indexFor('tailscale-operator', '1.104.7') });
  const result = await rules.triagePR(http, facts, CONFIG, rules.newCaches());
  assert.equal(byId(result).R2.result, 'flag');
  assert.equal(result.verdict, 'review');
});

test('a chart major is gated (R3) and goes to needs-claude', async () => {
  const facts = chartPR('reflector', '9.1.0', '10.0.77', 'infrastructure/controllers/emberstack.yaml');
  const http = stubHttp({ 'https://emberstack.github.io/helm-charts/index.yaml': indexFor('reflector', '10.0.77') });
  const result = await rules.triagePR(http, facts, CONFIG, rules.newCaches());
  assert.equal(byId(result).R3.result, 'flag');
  assert.equal(result.verdict, 'needs-claude');
});

test('a change under clusters/ goes to needs-claude', async () => {
  const facts = chartPR('reloader', '2.2.19', '2.2.20', 'clusters/home/flux-system/gotk-components.yaml');
  const result = await rules.triagePR(stubHttp({}), facts, CONFIG, rules.newCaches());
  assert.equal(result.verdict, 'needs-claude');
});

test('R9: a deny-list hit on a non-Renovate PR is blocked and never echoes the pattern', async () => {
  const secretish = 'Example-Retailer-Name';
  const facts = {
    repo: 'owner/fluxcd', now: '2026-11-14T00:00:00Z', config_sha: 's',
    pr: { number: 5, html_url: 'https://github.com/owner/fluxcd/pull/5', etag: 'W/"p"', head_sha: 'b'.repeat(40), head_ref: 'feat/x', user_login: 'someone', title: 'feat: x', body: 'adds a thing', created_at: '2026-11-13T00:00:00Z', mergeable: true, mergeable_state: 'clean', draft: false },
    files: { url: 'https://api.github.com/repos/owner/fluxcd/pulls/5/files', etag: 'W/"f"', items: [{ filename: 'docs/x.md', additions: 1, deletions: 0, patch: `@@ -0,0 +1 @@\n+bought it from example-retailer-name last week` }] },
    dashboard: null, cluster: null,
    patterns: [secretish.toLowerCase(), '/never-matches-\\d+/'],
  };
  const result = await rules.triagePR(stubHttp({}), facts, CONFIG, rules.newCaches());
  assert.equal(byId(result).R9.result, 'fail');
  assert.equal(result.verdict, 'blocked');
  assert.ok(!JSON.stringify(result).toLowerCase().includes(secretish.toLowerCase()), 'pattern echoed');
  const clean = JSON.parse(JSON.stringify(facts));
  clean.files.items[0].patch = '@@ -0,0 +1 @@\n+nothing to see';
  const cleanResult = await rules.triagePR(stubHttp({}), clean, CONFIG, rules.newCaches());
  assert.equal(byId(cleanResult).R9.result, 'pass');
  assert.notEqual(cleanResult.verdict, 'low-risk');
  const none = Object.assign({}, clean, { patterns: [] });
  assert.equal(byId(await rules.triagePR(stubHttp({}), none, CONFIG, rules.newCaches())).R9.result, 'not_run');
});

// ------------------------------------------------------------ parsers

test('satisfies: Helm kubeVersion constraints', () => {
  const cases = [
    ['v1.34.12+k3s1', '>=1.34.0-0', true],
    ['v1.30.6+k3s1', '>=1.34.0-0', false],
    ['v1.34.12+k3s1', '>=1.25.0-0', true],
    ['v1.34.12+k3s1', '>= 1.21.0 < 1.33.0', false],
    ['v1.32.1', '>= 1.21.0 < 1.33.0', true],
    ['v1.34.12', '>=1.21.0, <1.35.0', true],
    ['v1.34.12', '^1.20', true],
    ['v1.34.12', '~1.33', false],
    ['v1.34.12', '1.34.x', true],
    ['v1.34.12', '<1.30 || >=1.34', true],
    ['v1.34.12', '>=99', false],
    ['v1.34.12', 'not a constraint', null],
  ];
  for (const [v, c, want] of cases) assert.equal(rules.satisfies(v, c), want, `${v} vs ${c}`);
});

test('classifyUpdate', () => {
  assert.equal(rules.classifyUpdate('2.11.7-alpine', '2.11.9-alpine'), 'patch');
  assert.equal(rules.classifyUpdate('17.11-alpine', '18.6-alpine'), 'major');
  assert.equal(rules.classifyUpdate('1.12.2', '1.13.0'), 'minor');
  assert.equal(rules.classifyUpdate('v2.2.19', 'v2.2.20'), 'patch');
  assert.equal(rules.classifyUpdate('1.0', '1.0', null, 'sha256:x'), 'pin');
  assert.equal(rules.classifyUpdate('1.0', '1.0', 'sha256:x', 'sha256:y'), 'digest');
  assert.equal(rules.classifyUpdate('1.2.0', '1.1.0'), 'downgrade');
});

test('parseImageRef', () => {
  assert.deepEqual(rules.parseImageRef('caddy:2.11.9-alpine'), { registry: 'docker.io', repository: 'library/caddy', tag: '2.11.9-alpine', digest: null, depName: 'caddy' });
  assert.equal(rules.parseImageRef('n8nio/n8n:2.47.7').depName, 'n8nio/n8n');
  const g = rules.parseImageRef('ghcr.io/owner/app:v1.0.0@sha256:abc');
  assert.equal(g.registry, 'ghcr.io');
  assert.equal(g.repository, 'owner/app');
  assert.equal(g.digest, 'sha256:abc');
  assert.equal(rules.parseImageRef('localhost:5000/x').registry, 'localhost:5000');
});

test('parseDashboard reads the three sections', () => {
  const d = rules.parseDashboard('## Pending Approval\n - [ ] <!-- approve-branch=renovate/a -->x\n## Open\n - [ ] <!-- rebase-branch=renovate/b -->y\n## PR Closed (Blocked)\n - [ ] <!-- recreate-branch=renovate/c -->z\n## Detected Dependencies\n');
  assert.deepEqual(d, { pending: ['renovate/a'], open: ['renovate/b'], closed: ['renovate/c'] });
});

test('findChartEntry handles both index indentation styles and JSON', () => {
  const flat = 'apiVersion: v1\nentries:\n  a:\n  - version: 1.0.0\n    kubeVersion: ">=1.20"\n  b:\n  - version: 2.0.0\n';
  assert.deepEqual(rules.findChartEntry(flat, 'a', '1.0.0'), { found: true, kubeVersion: '>=1.20' });
  assert.deepEqual(rules.findChartEntry(flat, 'b', '2.0.0'), { found: true, kubeVersion: null });
  assert.deepEqual(rules.findChartEntry(flat, 'a', '9.9.9'), { found: false, kubeVersion: null });
  assert.equal(rules.findChartEntry('<html>', 'a', '1'), null);
  const json = JSON.stringify({ entries: { a: [{ version: 'v1.2.3', kubeVersion: '>=1.30' }] } });
  assert.deepEqual(rules.findChartEntry(json, 'a', '1.2.3'), { found: true, kubeVersion: '>=1.30' });
});

test('parseRenovateTable reads docker and helm tables', () => {
  const rows = rules.parseRenovateTable(fixtures.find((f) => f.file === 'postgres-major.json').facts.pr.body);
  assert.deepEqual(rows.map((r) => [r.package, r.update, r.from, r.to]), [['postgres', 'major', '17.11-alpine', '18.6-alpine']]);
  const helm = rules.parseRenovateTable(fixtures.find((f) => f.file === 'longhorn-kubeversion.json').facts.pr.body);
  assert.equal(helm[0].type, 'HelmChart');
});

test('sha256Hex matches node:crypto', () => {
  const crypto = require('node:crypto');
  const inputs = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'kubeVersion: ">=1.34.0-0" é ✓', CONFIG_TEXT];
  for (const s of inputs) {
    assert.equal(rules.sha256Hex(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'), JSON.stringify(s.slice(0, 20)));
  }
});

test('an index with no ETag still gives R4 evidence (content hash)', async () => {
  const facts = chartPR('reloader', '2.2.19', '2.2.20', 'apps/example/reloader.yaml');
  const idx = indexFor('reloader', '2.2.20', '>=1.20.0-0');
  idx.headers = {};
  const result = await rules.triagePR(stubHttp({ 'https://stakater.github.io/stakater-charts/index.yaml': idx }), facts, CONFIG, rules.newCaches());
  assert.equal(byId(result).R4.result, 'pass');
  assert.match(byId(result).R4.evidence.etag_or_sha, /^sha256:[0-9a-f]{64}$/);
});

// ------------------------------------------------------------ PR selection

test('selectPRs: oldest first, skip seen SHAs, cap clears the ETag', () => {
  const pr = (n, sha, created, draft) => ({ number: n, head: { sha }, created_at: created, draft: !!draft });
  const lists = [{
    repo: 'owner/fluxcd',
    previous_etag: '"old"',
    response: { statusCode: 200, headers: { etag: '"new"' }, body: [pr(3, 'c', '2026-11-03'), pr(1, 'a', '2026-11-01'), pr(2, 'b', '2026-11-02'), pr(4, 'd', '2026-11-04', true)] },
  }];
  const cfg = Object.assign({}, CONFIG, { per_run_cap: 10 });
  const all = rules.selectPRs(lists, ['owner/fluxcd#2@b'], cfg);
  assert.deepEqual(all.selected.map((s) => s.number), [1, 3]);
  assert.equal(all.etags['owner/fluxcd'], '"new"');
  const capped = rules.selectPRs(lists, [], Object.assign({}, cfg, { per_run_cap: 1 }));
  assert.deepEqual(capped.selected.map((s) => s.number), [1]);
  assert.equal(capped.etags['owner/fluxcd'], null);
  const notModified = rules.selectPRs([{ repo: 'owner/fluxcd', previous_etag: '"old"', response: { statusCode: 304, headers: {}, body: '' } }], [], cfg);
  assert.deepEqual(notModified.selected, []);
  assert.equal(notModified.etags['owner/fluxcd'], '"old"');
  assert.throws(() => rules.selectPRs([{ repo: 'owner/fluxcd', response: { statusCode: 403, body: {} } }], [], cfg));
});

// ------------------------------------------------------------ config

test('config: write_mode is off and validated', () => {
  assert.equal(CONFIG.write_mode, 'off');
  assert.deepEqual(CONFIG.repos, ['dazzathewiz/fluxcd']);
  assert.equal(CONFIG.per_run_cap, 10);
  assert.throws(() => rules.loadConfig(CONFIG_TEXT.replace('write_mode: "off"', 'write_mode: "all"')), /write_mode/);
  assert.throws(() => rules.loadConfig(CONFIG_TEXT.replace('write_mode: "off"', 'write_mode: off\n  bad: indent')));
});

test('config: the one-line repos list (read by SQL) matches the parsed config', () => {
  assert.deepEqual(rules.reposFromConfigLine(CONFIG_TEXT), CONFIG.repos);
  assert.doesNotThrow(() => rules.assertReposMatch(CONFIG, ['dazzathewiz/fluxcd']));
  assert.throws(() => rules.assertReposMatch(CONFIG, []), /repos from SQL/);
  assert.deepEqual(rules.reposFromConfigLine('a: 1\nrepos:\n  - x/y\n'), []);
});

function renovateRules() {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'renovate.json'), 'utf8')).packageRules;
}

const DATASOURCE_OF_MANAGER = { flux: null };

test('config drift: gated list mirrors renovate.json dependencyDashboardApproval rules', () => {
  const fromRenovate = [];
  for (const r of renovateRules()) {
    if (!r.dependencyDashboardApproval) continue;
    const pkgs = r.matchPackageNames || [null];
    const ds = r.matchDatasources ? r.matchDatasources[0] : (r.matchManagers ? DATASOURCE_OF_MANAGER[r.matchManagers[0]] : null);
    for (const p of pkgs) fromRenovate.push(JSON.stringify([p, ds || null, (r.matchUpdateTypes || []).slice().sort()]));
  }
  const fromConfig = CONFIG.gated.map((g) => JSON.stringify([g.package, g.datasource, g.update_types.slice().sort()]));
  assert.deepEqual(fromConfig.slice().sort(), fromRenovate.slice().sort());
});

test('config drift: caps mirror renovate.json allowedVersions', () => {
  const fromRenovate = [];
  for (const r of renovateRules()) {
    if (!r.allowedVersions) continue;
    const m = r.allowedVersions.match(/^<(\S+)$/);
    assert.ok(m, `unsupported allowedVersions ${r.allowedVersions}`);
    for (const p of r.matchPackageNames) fromRenovate.push(`${p} <${m[1]}`);
  }
  assert.deepEqual(CONFIG.caps.map((c) => `${c.package} <${c.below}`).sort(), fromRenovate.sort());
});

test('config drift: groups and one-minor packages mirror renovate.json', () => {
  const groups = renovateRules().filter((r) => r.groupName && (r.matchPackageNames || []).length > 1);
  assert.deepEqual(
    CONFIG.groups.map((g) => [g.name, g.branch, g.packages.slice().sort()]),
    groups.map((g) => [g.groupName, `renovate/${g.groupName}`, g.matchPackageNames.slice().sort()]),
  );
  const helmSeparate = renovateRules().filter((r) => r.separateMultipleMinor && (r.matchDatasources || []).includes('helm'));
  assert.deepEqual(CONFIG.one_minor_per_pr.slice().sort(), [].concat(...helmSeparate.map((r) => r.matchPackageNames)).sort());
});

function walkYaml(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!['experiments', 'node_modules', '.git'].includes(e.name)) walkYaml(p, out);
    } else if (/\.ya?ml$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

test('config drift: helm_index matches the repo HelmReleases and HelmRepositories', () => {
  const files = [].concat(
    walkYaml(path.join(REPO_ROOT, 'apps'), []),
    walkYaml(path.join(REPO_ROOT, 'infrastructure'), []),
    walkYaml(path.join(REPO_ROOT, 'clusters/home/helm-repositories'), []),
  );
  const repoUrls = {};
  const releases = [];
  for (const f of files) {
    for (const doc of fs.readFileSync(f, 'utf8').split(/^---\s*$/m)) {
      const kind = (doc.match(/^kind:[ \t]*(\S+)/m) || [])[1];
      if (kind === 'HelmRepository') {
        const name = (doc.match(/^metadata:[ \t]*\n(?:[ \t]+.*\n)*?[ \t]+name:[ \t]*(\S+)/m) || [])[1];
        const url = (doc.match(/^[ \t]+url:[ \t]*(\S+)/m) || [])[1];
        if (name && url) repoUrls[name] = url;
      }
      if (kind === 'HelmRelease') {
        const chart = (doc.match(/^[ \t]+chart:[ \t]*(\S+)[ \t]*$/m) || [])[1];
        const source = (doc.match(/sourceRef:[ \t]*\n(?:[ \t]+.*\n)*?[ \t]+name:[ \t]*(\S+)/m) || [])[1];
        if (chart) releases.push({ chart, source, file: path.relative(REPO_ROOT, f) });
      }
    }
  }
  assert.ok(releases.length > 5, 'found HelmReleases');
  const expected = {};
  for (const r of releases) {
    assert.ok(repoUrls[r.source], `${r.file}: no HelmRepository ${r.source}`);
    expected[r.chart] = repoUrls[r.source];
  }
  assert.deepEqual(CONFIG.helm_index, expected);
});
