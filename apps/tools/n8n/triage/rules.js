'use strict';
// PR triage rules R1-R9. Pure functions: no n8n APIs, no require().
// Network access is injected as `http(opts) -> {statusCode, headers, body}`.
// The triage-poll workflow's one Code node (Triage) carries a verbatim copy of
// this file (check with sync-code-nodes.js). Edit here, then run
// `node sync-code-nodes.js --write`.

const RESULTS = ['pass', 'flag', 'fail', 'not_run'];
const VERDICTS = ['blocked', 'needs-claude', 'review', 'low-risk'];
const WRITE_MODES = ['off', 'digest', 'labels'];
const CHECK_IDS = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9'];
const CONFIG_SOURCE = 'git:apps/tools/n8n/triage/config.yaml';

// ---------------------------------------------------------------- config

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(raw, lineNo) {
  const s = raw.trim();
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw new Error(`config line ${lineNo}: unterminated string`);
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new Error(`config line ${lineNo}: unterminated string`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new Error(`config line ${lineNo}: unterminated list`);
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((part) => parseScalar(part, lineNo));
  }
  if (s.startsWith('{') || s.startsWith('>') || s.startsWith('|') || s.startsWith('&') || s.startsWith('*')) {
    throw new Error(`config line ${lineNo}: unsupported YAML syntax "${s}"`);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  return s;
}

const SEQ_ITEM = /^-(\s|$)/;
const MAP_ITEM = /^("[^"]*"|'[^']*'|[^\s"'#\[\]{},:][^:]*?):(\s+(.*))?$/;

// Parses the block-style YAML subset that config.yaml uses: maps, sequences,
// flow sequences of scalars, quoted and plain scalars, comments.
function parseConfigYaml(text) {
  const lines = [];
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const s = stripComment(raw).replace(/\s+$/, '');
    if (s.trim() === '' || s.trim() === '---') return;
    const lead = s.match(/^\s*/)[0];
    if (lead.includes('\t')) throw new Error(`config line ${i + 1}: tab indentation`);
    lines.push({ indent: lead.length, text: s.trim(), n: i + 1 });
  });
  let pos = 0;

  function parseBlock() {
    if (pos >= lines.length) return null;
    return SEQ_ITEM.test(lines[pos].text) ? parseSeq(lines[pos].indent) : parseMap(lines[pos].indent);
  }

  function parseMap(indent) {
    const out = {};
    while (pos < lines.length && lines[pos].indent === indent && !SEQ_ITEM.test(lines[pos].text)) {
      const line = lines[pos];
      const m = line.text.match(MAP_ITEM);
      if (!m) throw new Error(`config line ${line.n}: expected "key: value"`);
      const key = parseScalar(m[1], line.n);
      if (Object.prototype.hasOwnProperty.call(out, key)) throw new Error(`config line ${line.n}: duplicate key "${key}"`);
      const rest = m[3] === undefined ? '' : m[3];
      pos++;
      if (rest !== '') {
        out[key] = parseScalar(rest, line.n);
      } else if (pos < lines.length && lines[pos].indent > indent) {
        out[key] = parseBlock();
      } else if (pos < lines.length && lines[pos].indent === indent && SEQ_ITEM.test(lines[pos].text)) {
        out[key] = parseSeq(indent);
      } else {
        out[key] = null;
      }
    }
    if (pos < lines.length && lines[pos].indent > indent) {
      throw new Error(`config line ${lines[pos].n}: unexpected indentation`);
    }
    return out;
  }

  function parseSeq(indent) {
    const out = [];
    while (pos < lines.length && lines[pos].indent === indent && SEQ_ITEM.test(lines[pos].text)) {
      const line = lines[pos];
      const rest = line.text.slice(1).trim();
      if (rest === '') {
        pos++;
        out.push(parseBlock());
      } else if (MAP_ITEM.test(rest) && !/^["'\[]/.test(rest)) {
        lines[pos] = { indent: indent + 2, text: rest, n: line.n };
        out.push(parseMap(indent + 2));
      } else {
        pos++;
        out.push(parseScalar(rest, line.n));
      }
    }
    return out;
  }

  const result = parseBlock();
  if (pos < lines.length) throw new Error(`config line ${lines[pos].n}: unexpected content`);
  return result || {};
}

function asList(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function loadConfig(text) {
  const cfg = parseConfigYaml(text);
  if (!WRITE_MODES.includes(cfg.write_mode)) {
    throw new Error(`config: write_mode must be one of ${WRITE_MODES.join(', ')}`);
  }
  const repos = asList(cfg.repos);
  if (repos.length === 0 || !repos.every((r) => /^[\w.-]+\/[\w.-]+$/.test(r))) {
    throw new Error('config: repos must list owner/name entries');
  }
  if (!Number.isInteger(cfg.per_run_cap) || cfg.per_run_cap < 1) {
    throw new Error('config: per_run_cap must be a positive integer');
  }
  return {
    write_mode: cfg.write_mode,
    repos,
    per_run_cap: cfg.per_run_cap,
    renovate_logins: asList(cfg.renovate_logins),
    cluster_version_url: cfg.cluster_version_url,
    negative_control_kube_version: cfg.negative_control_kube_version,
    gated: asList(cfg.gated).map((r) => ({
      package: r.package || null,
      datasource: r.datasource || null,
      update_types: asList(r.update_types),
    })),
    caps: asList(cfg.caps).map((c) => ({ package: c.package, below: String(c.below) })),
    one_minor_per_pr: asList(cfg.one_minor_per_pr),
    groups: asList(cfg.groups).map((g) => ({ name: g.name, branch: g.branch, packages: asList(g.packages) })),
    removed: asList(cfg.removed),
    needs_claude_packages: asList(cfg.needs_claude_packages),
    release_note_keywords: asList(cfg.release_note_keywords),
    low_risk_update_types: asList(cfg.low_risk_update_types),
    helm_index: cfg.helm_index || {},
  };
}

// The poll workflow's Start run SQL lists repos with this same pattern
// (regexp_match(body, '\nrepos:\s*\[([^\]\n]*)\]')), before any JS runs.
function reposFromConfigLine(text) {
  const m = ('\n' + String(text)).match(/\nrepos:\s*\[([^\]\n]*)\]/);
  if (!m) return [];
  return m[1].split(',').map((r) => r.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

// Fails the run if the SQL's repo list and the parsed config disagree.
function assertReposMatch(config, sqlRepos) {
  const a = config.repos.slice().sort().join(',');
  const b = (sqlRepos || []).slice().sort().join(',');
  if (a !== b) throw new Error(`repos from SQL (${b}) differ from config.yaml (${a}); keep repos on one line`);
}

// ---------------------------------------------------------------- versions

const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

function parseVersion(raw) {
  if (raw === undefined || raw === null) return null;
  const m = String(raw).trim().match(VERSION_RE);
  if (!m) return null;
  return {
    raw: String(raw).trim(),
    nums: [m[1], m[2], m[3], m[4]].map((x) => (x === undefined ? 0 : parseInt(x, 10))),
    given: [m[1], m[2], m[3]].filter((x) => x !== undefined).length,
    pre: m[5] || '',
    build: m[6] || '',
  };
}

function comparePre(a, b) {
  if (a === b) return 0;
  if (a === '') return 1; // a release sorts after any prerelease
  if (b === '') return -1;
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]);
    const nb = /^\d+$/.test(pb[i]);
    if (na && nb) {
      const d = parseInt(pa[i], 10) - parseInt(pb[i], 10);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
}

// Compares numeric parts, then prerelease. Build metadata is ignored.
function compareVersions(a, b) {
  const va = typeof a === 'string' ? parseVersion(a) : a;
  const vb = typeof b === 'string' ? parseVersion(b) : b;
  if (!va || !vb) return null;
  for (let i = 0; i < 4; i++) {
    if (va.nums[i] !== vb.nums[i]) return va.nums[i] < vb.nums[i] ? -1 : 1;
  }
  return comparePre(va.pre, vb.pre);
}

// Helm/Masterminds semver constraint subset: ||, comma or space AND,
// = != > < >= <= ~ ^, x-ranges, hyphen ranges.
function expandComparator(token) {
  const m = token.match(/^(>=|<=|!=|>|<|=|~>|~|\^)?(.*)$/);
  const op = m[1] || '=';
  const ver = m[2].replace(/^v/, '');
  if (ver === '' || ver === '*' || ver === 'x' || ver === 'X') return [{ op: '*' }];
  const parts = ver.split(/[-+]/)[0].split('.');
  if (parts.length > 3 || !parts.every((p) => /^(\d+|x|X|\*)$/.test(p))) throw new Error(`bad version in constraint: ${token}`);
  const pre = ver.includes('-') ? ver.slice(ver.indexOf('-') + 1).split('+')[0] : '';
  const wild = parts.findIndex((p) => p === 'x' || p === 'X' || p === '*');
  const nums = parts.map((p) => (/^\d+$/.test(p) ? parseInt(p, 10) : null));
  const given = wild === -1 ? parts.length : wild;
  const base = [nums[0] || 0, given > 1 ? nums[1] || 0 : 0, given > 2 ? nums[2] || 0 : 0];
  const v = (n) => ({ nums: [n[0], n[1], n[2], 0], pre: '' });
  const exact = { nums: [base[0], base[1], base[2], 0], pre };
  const upper = (level) => {
    if (level === 0) return v([base[0] + 1, 0, 0]);
    return v([base[0], base[1] + 1, 0]);
  };
  if (op === '^') {
    let hi;
    if (base[0] > 0 || given === 1) hi = v([base[0] + 1, 0, 0]);
    else if (base[1] > 0 || given === 2) hi = v([0, base[1] + 1, 0]);
    else hi = v([0, 0, base[2] + 1]);
    return [{ op: '>=', v: exact }, { op: '<', v: Object.assign(hi, { pre: '0' }) }];
  }
  if (op === '~' || op === '~>') {
    const hi = given <= 1 ? upper(0) : upper(1);
    return [{ op: '>=', v: exact }, { op: '<', v: Object.assign(hi, { pre: '0' }) }];
  }
  if (given < 3 && (op === '=' || op === '!=')) {
    const lo = exact;
    const hi = Object.assign(given === 1 ? upper(0) : upper(1), { pre: '0' });
    if (op === '=') return [{ op: '>=', v: lo }, { op: '<', v: hi }];
    return [{ op: 'or-outside', lo, hi }];
  }
  if (given < 3 && op === '>') return [{ op: '>=', v: Object.assign(given === 1 ? upper(0) : upper(1), { pre: '0' }) }];
  if (given < 3 && op === '<=') return [{ op: '<', v: Object.assign(given === 1 ? upper(0) : upper(1), { pre: '0' }) }];
  return [{ op, v: exact }];
}

function testComparator(version, c) {
  if (c.op === '*') return true;
  if (c.op === 'or-outside') return compareVersions(version, c.lo) < 0 || compareVersions(version, c.hi) >= 0;
  const d = compareVersions(version, c.v);
  switch (c.op) {
    case '=': return d === 0;
    case '!=': return d !== 0;
    case '>': return d > 0;
    case '<': return d < 0;
    case '>=': return d >= 0;
    case '<=': return d <= 0;
    default: return false;
  }
}

// Returns true/false, or null when the constraint can't be parsed.
function satisfies(versionRaw, constraintRaw) {
  const version = parseVersion(String(versionRaw).replace(/^v/, ''));
  if (!version || constraintRaw === undefined || constraintRaw === null) return null;
  // Prereleases of the cluster version are compared as releases, as Helm does
  // for kubeVersion when the constraint carries a "-0".
  const ver = { nums: version.nums, pre: version.pre };
  const groups = String(constraintRaw).split('||');
  let anyParsed = false;
  for (const group of groups) {
    let g = group.trim();
    if (g === '') continue;
    g = g.replace(/(\S+)\s+-\s+(\S+)/g, '>=$1 <=$2');
    g = g.replace(/(>=|<=|!=|~>|>|<|=|~|\^)\s+/g, '$1');
    const tokens = g.split(/[\s,]+/).filter(Boolean);
    let comparators;
    try {
      comparators = [].concat(...tokens.map(expandComparator));
    } catch (e) {
      return null;
    }
    if (comparators.some((c) => c.v && compareVersions(ver, c.v) === null)) return null;
    anyParsed = true;
    if (comparators.every((c) => testComparator(ver, c))) return true;
  }
  return anyParsed ? false : null;
}

// digest | pin | patch | minor | major | downgrade | unknown
function classifyUpdate(oldTag, newTag, oldDigest, newDigest) {
  if (oldTag === newTag) {
    if (!oldDigest && newDigest) return 'pin';
    if (oldDigest && newDigest && oldDigest !== newDigest) return 'digest';
    return 'unknown';
  }
  const a = parseVersion(oldTag);
  const b = parseVersion(newTag);
  if (!a || !b) return 'unknown';
  const d = compareVersions(a, b);
  if (d === null) return 'unknown';
  if (d > 0) return 'downgrade';
  if (a.nums[0] !== b.nums[0]) return 'major';
  if (a.nums[1] !== b.nums[1]) return 'minor';
  return 'patch';
}

// ---------------------------------------------------------------- PR parsing

function linkText(cell) {
  const m = cell.match(/\[([^\]]+)\]\(([^)]+)\)/);
  return m ? m[1].trim() : cell.replace(/[`*]/g, '').trim();
}

// Renovate's "| Package | Type | Update | Change |" table. Columns vary.
function parseRenovateTable(body) {
  const lines = String(body || '').split(/\r?\n/);
  const start = lines.findIndex((l) => /^\|\s*Package\s*\|/i.test(l.trim()));
  if (start === -1) return [];
  const headers = lines[start].trim().replace(/^\||\|$/g, '').split('|').map((h) => h.trim().toLowerCase());
  const rows = [];
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) break;
    const cells = line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const row = {};
    headers.forEach((h, idx) => { row[h] = cells[idx] || ''; });
    const change = (row.change || '').match(/`([^`]+)`\s*(?:→|->|&#8594;)\s*`([^`]+)`/);
    const source = (row.package || '').match(/\[source\]\(([^)]+)\)/);
    rows.push({
      package: linkText(row.package || ''),
      type: (row.type || '').trim(),
      update: (row.update || '').replace(/[`*]/g, '').trim().toLowerCase(),
      from: change ? change[1] : null,
      to: change ? change[2] : null,
      source_url: source ? source[1] : null,
    });
  }
  return rows;
}

function extractReleaseNotes(body) {
  const text = String(body || '');
  const i = text.search(/^###\s+Release Notes\s*$/m);
  if (i === -1) return null;
  const rest = text.slice(i);
  const end = rest.search(/\n---\s*\n|^###\s+Configuration/m);
  return end === -1 ? rest : rest.slice(0, end);
}

function parseImageRef(raw) {
  if (!raw) return null;
  let ref = String(raw).trim().replace(/^["']|["']$/g, '');
  if (!ref || /\s/.test(ref)) return null;
  let digest = null;
  const at = ref.indexOf('@');
  if (at !== -1) {
    digest = ref.slice(at + 1);
    ref = ref.slice(0, at);
  }
  let tag = null;
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  if (colon > slash) {
    tag = ref.slice(colon + 1);
    ref = ref.slice(0, colon);
  }
  const parts = ref.split('/');
  let registry = 'docker.io';
  if (parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost')) {
    registry = parts.shift();
  }
  if (registry === 'index.docker.io' || registry === 'registry-1.docker.io') registry = 'docker.io';
  let repository = parts.join('/');
  if (!repository) return null;
  if (registry === 'docker.io' && !repository.includes('/')) repository = `library/${repository}`;
  const depName = registry === 'docker.io'
    ? repository.replace(/^library\//, '')
    : `${registry}/${repository}`;
  return { registry, repository, tag, digest, depName };
}

function imageKey(img) {
  return `${img.registry}/${img.repository}${img.tag ? `:${img.tag}` : ''}${img.digest ? `@${img.digest}` : ''}`;
}

const VERSION_TOKEN = /(sha256:[0-9a-f]{64}|v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.+-]*)?)/g;

function maskVersions(line) {
  return line.replace(VERSION_TOKEN, '<v>');
}

// Pairs removed/added lines in each hunk and classifies each pair.
function parsePatch(patch) {
  const pairs = [];
  const lines = String(patch || '').split('\n');
  let context = [];
  let removed = [];
  let added = [];
  const flush = () => {
    const n = Math.max(removed.length, added.length);
    for (let i = 0; i < n; i++) {
      pairs.push({ old: removed[i] === undefined ? null : removed[i], new: added[i] === undefined ? null : added[i], context: context.slice(-6) });
    }
    removed = [];
    added = [];
  };
  for (const line of lines) {
    if (line.startsWith('@@')) {
      flush();
      context = [];
      continue;
    }
    if (line.startsWith('-')) {
      if (added.length) flush();
      removed.push(line.slice(1));
    } else if (line.startsWith('+')) {
      added.push(line.slice(1));
    } else {
      flush();
      context.push(line.startsWith(' ') ? line.slice(1) : line);
    }
  }
  flush();
  return pairs;
}

function keyValue(line) {
  const m = String(line || '').match(/^\s*(?:-\s+)?([\w.-]+):\s*(.*?)\s*$/);
  return m ? { key: m[1], value: m[2].replace(/^["']|["']$/g, '') } : null;
}

function firstVersionToken(s) {
  const m = String(s || '').match(/v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.+-]*)?/);
  return m ? m[0] : null;
}

// Turns the PR's files into a list of version changes.
function extractChanges(files, table) {
  const changes = [];
  const helmRows = (table || []).filter((r) => /helm/i.test(r.type));
  for (const f of files || []) {
    if (typeof f.patch !== 'string') {
      changes.push({ file: f.filename, kind: 'unparsed', versionOnly: false, reason: 'no patch in API response' });
      continue;
    }
    for (const pair of parsePatch(f.patch)) {
      const versionOnly = pair.old !== null && pair.new !== null && maskVersions(pair.old) === maskVersions(pair.new) && pair.old !== pair.new;
      const kvOld = keyValue(pair.old);
      const kvNew = keyValue(pair.new);
      const change = { file: f.filename, versionOnly, old_line: pair.old, new_line: pair.new };
      const key = kvNew ? kvNew.key : kvOld ? kvOld.key : null;
      const ctx = pair.context.join('\n');
      if (key === 'image' && kvNew) {
        const a = kvOld ? parseImageRef(kvOld.value) : null;
        const b = parseImageRef(kvNew.value);
        Object.assign(change, {
          kind: 'image',
          package: b ? b.depName : null,
          image: b,
          from: a ? a.tag : null,
          to: b ? b.tag : null,
          update: a && b ? classifyUpdate(a.tag, b.tag, a.digest, b.digest) : 'unknown',
          datasource: 'docker',
        });
      } else if ((key === 'newTag' || key === 'tag') && kvNew) {
        const nameLine = pair.context.slice().reverse().map(keyValue).find((kv) => kv && /^(newName|name|repository)$/.test(kv.key));
        const img = nameLine ? parseImageRef(`${nameLine.value}:${kvNew.value}`) : null;
        Object.assign(change, {
          kind: 'image',
          package: img ? img.depName : null,
          image: img,
          from: kvOld ? kvOld.value : null,
          to: kvNew.value,
          update: kvOld ? classifyUpdate(kvOld.value, kvNew.value) : 'unknown',
          datasource: 'docker',
        });
      } else if (key === 'version' && kvNew) {
        const renovateHint = ctx.match(/#\s*renovate:\s*datasource=(\S+)\s+depName=(\S+)/);
        const chartLine = pair.context.slice().reverse().map(keyValue).find((kv) => kv && kv.key === 'chart');
        const from = kvOld ? kvOld.value : null;
        const to = kvNew.value;
        if (renovateHint) {
          Object.assign(change, { kind: 'release', package: renovateHint[2], datasource: renovateHint[1] });
        } else if (chartLine || helmRows.length === 1) {
          Object.assign(change, { kind: 'chart', package: chartLine ? chartLine.value : helmRows[0].package, datasource: 'helm' });
        } else {
          Object.assign(change, { kind: 'other', package: null, datasource: null });
        }
        Object.assign(change, { from, to, update: from ? classifyUpdate(from, to) : 'unknown' });
      } else {
        const from = firstVersionToken(pair.old);
        const to = firstVersionToken(pair.new);
        Object.assign(change, {
          kind: 'other',
          package: null,
          datasource: null,
          from,
          to,
          update: from && to ? classifyUpdate(from, to) : 'unknown',
        });
      }
      changes.push(change);
    }
  }
  return changes;
}

function pathClass(filename) {
  const f = String(filename || '');
  if (/(^|\/)gotk-components\.ya?ml$/.test(f)) return 'gotk';
  if (f.startsWith('clusters/')) return 'clusters';
  if (f.startsWith('infrastructure/')) return 'infrastructure';
  if (f.startsWith('apps/')) return 'apps';
  return 'other';
}

function parseDashboard(body) {
  const out = { pending: [], open: [], closed: [] };
  let section = null;
  for (const line of String(body || '').split(/\r?\n/)) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) {
      const title = h[1].toLowerCase();
      section = title.includes('pending approval') ? 'pending'
        : title.startsWith('open') ? 'open'
          : title.includes('closed') ? 'closed' : null;
      continue;
    }
    const m = line.match(/<!--\s*(?:approve|rebase|recreate|unlimit)-branch=([^\s>]+)\s*-->/);
    if (m && section) out[section].push(m[1]);
  }
  return out;
}

// Finds one chart version's entry in a Helm repository index.
// Returns {found, kubeVersion} or null when the text isn't an index.
function findChartEntry(indexText, chart, version) {
  const text = String(indexText || '');
  const want = String(version).replace(/^v/, '');
  if (text.trim().startsWith('{')) {
    let doc;
    try { doc = JSON.parse(text); } catch (e) { return null; }
    const list = doc && doc.entries && doc.entries[chart];
    if (!Array.isArray(list)) return doc && doc.entries ? { found: false, kubeVersion: null } : null;
    const e = list.find((x) => String(x.version).replace(/^v/, '') === want);
    return e ? { found: true, kubeVersion: e.kubeVersion || null } : { found: false, kubeVersion: null };
  }
  const lines = text.split(/\r?\n/);
  const entriesAt = lines.findIndex((l) => /^entries:\s*$/.test(l));
  if (entriesAt === -1) return null;
  let chartIndent = -1;
  let i = entriesAt + 1;
  for (; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) return { found: false, kubeVersion: null };
    const m = lines[i].match(/^(\s+)(["']?)([^"':\s]+)\2:\s*$/);
    if (m && m[3] === chart) {
      chartIndent = m[1].length;
      break;
    }
  }
  if (chartIndent === -1) return { found: false, kubeVersion: null };
  let item = null;
  let itemIndent = -1;
  const finish = () => {
    if (item && String(item.version || '').replace(/^v/, '') === want) return true;
    return false;
  };
  for (i += 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const indent = line.match(/^\s*/)[0].length;
    const dash = line.match(/^(\s*)-\s+(.*)$/);
    if (dash && (itemIndent === -1 ? indent >= chartIndent : indent === itemIndent)) {
      if (finish()) break;
      itemIndent = indent;
      item = {};
      const kv = keyValue(dash[2]);
      if (kv) item[kv.key] = kv.value;
      continue;
    }
    if (indent <= chartIndent && !dash) break;
    if (item && indent === itemIndent + 2) {
      const kv = keyValue(line);
      if (kv && (kv.key === 'version' || kv.key === 'kubeVersion')) item[kv.key] = kv.value;
    }
  }
  if (finish()) return { found: true, kubeVersion: item.kubeVersion || null };
  return { found: false, kubeVersion: null };
}

function parseAuthChallenge(header) {
  const h = Array.isArray(header) ? header[0] : header;
  const m = String(h || '').match(/^Bearer\s+(.*)$/i);
  if (!m) return null;
  const out = {};
  const re = /(\w+)="([^"]*)"/g;
  let p;
  while ((p = re.exec(m[1])) !== null) out[p[1]] = p[2];
  return out.realm ? out : null;
}

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

// true/false for an index; null for a single-platform manifest.
function amd64InIndex(manifest) {
  if (!manifest || !Array.isArray(manifest.manifests)) return null;
  return manifest.manifests.some((m) => m.platform && m.platform.os === 'linux' && m.platform.architecture === 'amd64');
}

function header(headers, name) {
  if (!headers) return null;
  const want = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === want) return Array.isArray(headers[k]) ? headers[k][0] : headers[k];
  }
  return null;
}

function bodyText(body) {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  if (body.type === 'Buffer' && Array.isArray(body.data)) {
    let s = '';
    for (let i = 0; i < body.data.length; i += 8192) s += String.fromCharCode.apply(null, body.data.slice(i, i + 8192));
    try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
  }
  return JSON.stringify(body);
}

function bodyJson(body) {
  if (body && typeof body === 'object' && body.type !== 'Buffer') return body;
  try { return JSON.parse(bodyText(body)); } catch (e) { return null; }
}

// SHA-256 of a string's UTF-8 bytes, in pure JS (Code nodes can't load crypto).
// Evidence for sources that send no ETag.
function rotr(x, n) {
  return (x >>> n) | (x << (32 - n));
}

function fracBits(x) {
  return Math.floor((x - Math.floor(x)) * 0x100000000) | 0;
}

const SHA256_K = [];
const SHA256_H = [];
for (let n = 2; SHA256_K.length < 64; n++) {
  let prime = true;
  for (let d = 2; d * d <= n; d++) if (n % d === 0) prime = false;
  if (!prime) continue;
  if (SHA256_H.length < 8) SHA256_H.push(fracBits(Math.sqrt(n)));
  SHA256_K.push(fracBits(Math.cbrt(n)));
}

function sha256Hex(message) {
  const bin = unescape(encodeURIComponent(String(message)));
  const len = bin.length;
  const words = [];
  for (let i = 0; i < len; i++) words[i >> 2] |= (bin.charCodeAt(i) & 0xff) << (24 - (i % 4) * 8);
  words[len >> 2] |= 0x80 << (24 - (len % 4) * 8);
  const total = (((len + 8) >> 6) + 1) * 16;
  for (let i = 0; i < total; i++) words[i] = words[i] | 0;
  words[total - 1] = (len * 8) | 0;
  words[total - 2] = Math.floor((len * 8) / 0x100000000) | 0;
  const H = SHA256_H.slice();
  const W = new Array(64);
  for (let j = 0; j < total; j += 16) {
    for (let t = 0; t < 64; t++) {
      if (t < 16) {
        W[t] = words[j + t];
      } else {
        const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
        const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
        W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
      }
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[t] + W[t]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  return H.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

// ---------------------------------------------------------------- fetchers (http injected)

async function fetchClusterVersion(http, url) {
  try {
    const r = await http({ method: 'GET', url, headers: { Accept: 'application/json' } });
    const j = bodyJson(r.body);
    if (r.statusCode !== 200 || !j || !j.gitVersion) return { url, error: `HTTP ${r.statusCode}` };
    return { url, gitVersion: j.gitVersion, etag_or_sha: j.gitCommit || `sha256:${sha256Hex(bodyText(r.body))}` };
  } catch (e) {
    return { url, error: String(e.message || e) };
  }
}

async function fetchChartIndex(http, url) {
  try {
    const r = await http({ method: 'GET', url, headers: { Accept: 'application/x-yaml, text/yaml, */*' } });
    if (r.statusCode !== 200) return { url, error: `HTTP ${r.statusCode}` };
    const text = bodyText(r.body);
    return { url, etag: header(r.headers, 'etag') || `sha256:${sha256Hex(text)}`, text };
  } catch (e) {
    return { url, error: String(e.message || e) };
  }
}

async function registryGet(http, img, path, accept, tokenCache) {
  const host = img.registry === 'docker.io' ? 'registry-1.docker.io' : img.registry;
  const url = `https://${host}/v2/${img.repository}/${path}`;
  const headers = { Accept: accept };
  const scopeKey = `${host}/${img.repository}`;
  if (tokenCache[scopeKey]) headers.Authorization = `Bearer ${tokenCache[scopeKey]}`;
  let r = await http({ method: 'GET', url, headers });
  if (r.statusCode === 401) {
    const ch = parseAuthChallenge(header(r.headers, 'www-authenticate'));
    if (!ch) return { url, r };
    const q = [];
    if (ch.service) q.push(`service=${encodeURIComponent(ch.service)}`);
    q.push(`scope=${encodeURIComponent(ch.scope || `repository:${img.repository}:pull`)}`);
    const t = await http({ method: 'GET', url: `${ch.realm}?${q.join('&')}`, headers: { Accept: 'application/json' } });
    const tj = bodyJson(t.body);
    const token = tj && (tj.token || tj.access_token);
    if (!token) return { url, r };
    tokenCache[scopeKey] = token;
    headers.Authorization = `Bearer ${token}`;
    r = await http({ method: 'GET', url, headers });
  }
  return { url, r };
}

async function fetchImage(http, img, tokenCache) {
  const ref = img.digest || img.tag;
  if (!ref) return { error: 'no tag or digest' };
  try {
    const { url, r } = await registryGet(http, img, `manifests/${ref}`, MANIFEST_ACCEPT, tokenCache);
    if (r.statusCode !== 200) return { url, error: `HTTP ${r.statusCode}` };
    const digest = header(r.headers, 'docker-content-digest');
    const manifest = bodyJson(r.body);
    if (!manifest) return { url, error: 'manifest is not JSON' };
    let amd64 = amd64InIndex(manifest);
    let platform = null;
    if (amd64 === null && manifest.config && manifest.config.digest) {
      const blob = await registryGet(http, img, `blobs/${manifest.config.digest}`, 'application/json', tokenCache);
      const cfg = blob.r.statusCode === 200 ? bodyJson(blob.r.body) : null;
      if (!cfg) return { url, digest, error: `config blob HTTP ${blob.r.statusCode}` };
      platform = `${cfg.os}/${cfg.architecture}`;
      amd64 = cfg.os === 'linux' && cfg.architecture === 'amd64';
    }
    if (amd64 === null) return { url, digest, error: 'unrecognised manifest' };
    return { url, digest: digest || `body-sha256:${sha256Hex(bodyText(r.body))}`, amd64, platform };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// Gathers every non-GitHub fact the checks need for one PR.
async function gatherExternalFacts(http, changes, config, caches) {
  const charts = {};
  const images = {};
  for (const c of changes) {
    if (c.kind === 'chart' && c.package && c.to) {
      const key = `${c.package}@${c.to}`;
      const repoUrl = config.helm_index[c.package];
      if (!repoUrl) {
        charts[key] = { error: 'chart has no helm_index entry in config' };
        continue;
      }
      const indexUrl = `${String(repoUrl).replace(/\/+$/, '')}/index.yaml`;
      if (!caches.index[indexUrl]) caches.index[indexUrl] = await fetchChartIndex(http, indexUrl);
      const idx = caches.index[indexUrl];
      if (idx.error) {
        charts[key] = { url: indexUrl, error: idx.error };
        continue;
      }
      const entry = findChartEntry(idx.text, c.package, c.to);
      charts[key] = entry
        ? { url: indexUrl, etag: idx.etag, found: entry.found, kubeVersion: entry.kubeVersion }
        : { url: indexUrl, error: 'not a Helm index' };
    }
    if (c.kind === 'image' && c.image) {
      const key = imageKey(c.image);
      if (!caches.image[key]) caches.image[key] = await fetchImage(http, c.image, caches.tokens);
      images[key] = caches.image[key];
    }
  }
  return { charts, images };
}

// ---------------------------------------------------------------- checks

function check(id, result, evidence, extra) {
  return Object.assign({ id, result, evidence: evidence || {} }, extra || {});
}

// Missing evidence means not_run, never pass.
function finalize(c) {
  if (!RESULTS.includes(c.result)) c.result = 'not_run';
  const e = c.evidence || {};
  if (c.result !== 'not_run' && (!e.source_url || !e.etag_or_sha)) {
    c.evidence = Object.assign({}, e, { missing_evidence: true, original_result: c.result });
    c.result = 'not_run';
  }
  return c;
}

function filesEvidence(facts, compared) {
  return { source_url: facts.files && facts.files.url, etag_or_sha: facts.files && (facts.files.etag || facts.pr.head_sha), compared };
}

function prEvidence(facts, compared) {
  return { source_url: facts.pr.html_url, etag_or_sha: facts.pr.etag || null, compared };
}

function configEvidence(facts, compared) {
  return { source_url: CONFIG_SOURCE, etag_or_sha: facts.config_sha || null, compared };
}

function versionChanges(changes) {
  return changes.filter((c) => ['image', 'chart', 'release'].includes(c.kind));
}

function checkR1(facts, ctx) {
  if (!ctx.isRenovate) return check('R1', 'not_run', { compared: 'not applicable: not a Renovate PR' }, { required: false });
  const diffTypes = ctx.changes.filter((c) => c.kind !== 'unparsed' && c.old_line !== null && c.new_line !== null && c.update !== 'unknown').map((c) => c.update);
  const tableTypes = ctx.table.map((r) => r.update).filter(Boolean);
  const compared = {
    diff: ctx.changes.filter((c) => c.kind !== 'unparsed').map((c) => ({ file: c.file, package: c.package || null, from: c.from || null, to: c.to || null, update: c.update })),
    renovate_table: ctx.table.map((r) => ({ package: r.package, update: r.update, from: r.from, to: r.to })),
  };
  if (!facts.files || ctx.changes.some((c) => c.kind === 'unparsed') || diffTypes.length === 0 || tableTypes.length === 0) {
    return check('R1', 'not_run', Object.assign(filesEvidence(facts, compared), { reason: 'could not classify from the diff or the PR table' }), { required: true });
  }
  const diffSet = Array.from(new Set(diffTypes)).sort();
  const tableSet = Array.from(new Set(tableTypes)).sort();
  const toValues = ctx.table.map((r) => r.to).filter(Boolean);
  const addedText = ctx.changes.map((c) => c.new_line || '').join('\n');
  const valuesInDiff = toValues.every((v) => addedText.includes(v));
  const agree = diffSet.join(',') === tableSet.join(',') && valuesInDiff;
  compared.classification = diffSet.length === 1 ? diffSet[0] : 'mixed';
  if (!agree) compared.mismatch = { diff: diffSet, table: tableSet, table_values_in_diff: valuesInDiff };
  return check('R1', agree ? 'pass' : 'flag', filesEvidence(facts, compared), { required: true, classification: compared.classification });
}

function checkR2(facts, ctx) {
  if (!facts.files) return check('R2', 'not_run', { compared: 'files not read' }, { required: true });
  const files = facts.files.items || [];
  const classes = Array.from(new Set(files.map((f) => pathClass(f.filename))));
  const additions = files.reduce((n, f) => n + (f.additions || 0), 0);
  const deletions = files.reduce((n, f) => n + (f.deletions || 0), 0);
  const singleLine = files.length === 1 && additions === 1 && deletions === 1 && ctx.changes.length === 1 && ctx.changes[0].versionOnly;
  const compared = {
    files: files.map((f) => ({ path: f.filename, class: pathClass(f.filename), additions: f.additions, deletions: f.deletions })),
    single_version_line: singleLine,
    path_classes: classes,
  };
  const ok = singleLine && classes.length === 1 && classes[0] === 'apps';
  return check('R2', ok ? 'pass' : 'flag', filesEvidence(facts, compared), { required: true, path_classes: classes, single_version_line: singleLine });
}

function ruleMatches(rule, pkg, datasource, update) {
  if (rule.package && rule.package !== pkg) return false;
  if (rule.datasource && rule.datasource !== datasource) return false;
  if (rule.update_types.length && !rule.update_types.includes(update)) return false;
  return true;
}

function packagesOf(ctx) {
  const out = [];
  for (const c of versionChanges(ctx.changes)) {
    if (c.package) out.push({ package: c.package, datasource: c.datasource, update: c.update, from: c.from, to: c.to });
  }
  for (const r of ctx.table) {
    if (!out.some((p) => p.package === r.package)) {
      out.push({ package: r.package, datasource: /helm/i.test(r.type) ? 'helm' : null, update: r.update, from: r.from, to: r.to });
    }
  }
  return out;
}

function checkR3(facts, ctx, config) {
  const pkgs = packagesOf(ctx);
  const gated = [];
  for (const p of pkgs) {
    const rule = config.gated.find((r) => ruleMatches(r, p.package, p.datasource, p.update));
    if (rule) gated.push({ package: p.package, update: p.update, rule });
  }
  const dash = facts.dashboard ? parseDashboard(facts.dashboard.body) : null;
  const branch = facts.pr.head_ref;
  const dashboardState = !dash ? 'not read'
    : dash.open.includes(branch) ? 'open'
      : dash.pending.includes(branch) ? 'pending approval'
        : dash.closed.includes(branch) ? 'closed' : 'not listed';
  const compared = {
    packages: pkgs.map((p) => `${p.package} (${p.datasource || 'unknown'}, ${p.update})`),
    gated: gated.map((g) => ({ package: g.package, update: g.update, rule: g.rule })),
    dashboard: { url: facts.dashboard ? facts.dashboard.url : null, etag: facts.dashboard ? facts.dashboard.etag : null, branch_state: dashboardState },
  };
  if (pkgs.length === 0) return check('R3', 'not_run', configEvidence(facts, compared), { required: ctx.isRenovate });
  return check('R3', gated.length ? 'flag' : 'pass', configEvidence(facts, compared), { required: ctx.isRenovate });
}

function evaluateKubeVersion(entry, cluster) {
  if (!cluster || !cluster.gitVersion) return { result: 'not_run', reason: 'cluster version not read' };
  if (!entry.kubeVersion) return { result: 'pass', reason: 'chart declares no kubeVersion' };
  const ok = satisfies(cluster.gitVersion, entry.kubeVersion);
  if (ok === null) return { result: 'not_run', reason: `unparsable constraint ${entry.kubeVersion}` };
  return { result: ok ? 'pass' : 'fail' };
}

function checkR4(facts, ctx) {
  const charts = ctx.changes.filter((c) => c.kind === 'chart' && c.to);
  if (charts.length === 0) return check('R4', 'not_run', { compared: 'not applicable: no chart version in the diff' }, { required: false });
  const per = [];
  for (const c of charts) {
    const key = `${c.package}@${c.to}`;
    const fact = (facts.charts || {})[key];
    if (!fact || fact.error) {
      per.push({ chart: key, result: 'not_run', reason: fact ? fact.error : 'index not read', source_url: fact && fact.url });
      continue;
    }
    if (!fact.found) {
      per.push({ chart: key, result: 'not_run', reason: 'version not in index', source_url: fact.url, etag: fact.etag });
      continue;
    }
    const r = evaluateKubeVersion(fact, facts.cluster);
    per.push({ chart: key, result: r.result, reason: r.reason, kubeVersion: fact.kubeVersion, cluster: facts.cluster && facts.cluster.gitVersion, source_url: fact.url, etag: fact.etag });
  }
  const order = ['fail', 'not_run', 'flag', 'pass'];
  const worst = per.slice().sort((a, b) => order.indexOf(a.result) - order.indexOf(b.result))[0];
  const evidence = {
    source_url: worst.source_url || null,
    etag_or_sha: worst.etag || null,
    compared: { charts: per, cluster_source: facts.cluster ? facts.cluster.url : null },
  };
  if (worst.result !== 'not_run' && !(facts.cluster && facts.cluster.gitVersion)) return check('R4', 'not_run', evidence, { required: true });
  return check('R4', worst.result, evidence, { required: true });
}

function checkR5(facts, ctx, config) {
  const pkgs = packagesOf(ctx);
  const violations = [];
  for (const p of pkgs) {
    for (const cap of config.caps) {
      if (cap.package === p.package && p.to && compareVersions(p.to.replace(/^v/, ''), cap.below.replace(/^v/, '')) >= 0) {
        violations.push({ package: p.package, rule: `below ${cap.below}`, to: p.to });
      }
    }
    if (config.one_minor_per_pr.includes(p.package) && p.from && p.to) {
      const a = parseVersion(p.from);
      const b = parseVersion(p.to);
      if (a && b && (a.nums[0] !== b.nums[0] || b.nums[1] - a.nums[1] > 1)) {
        violations.push({ package: p.package, rule: 'one minor per PR', from: p.from, to: p.to });
      }
    }
    for (const g of config.groups) {
      if (g.packages.includes(p.package) && facts.pr.head_ref !== g.branch) {
        violations.push({ package: p.package, rule: `group ${g.name} must come from ${g.branch}`, branch: facts.pr.head_ref });
      }
    }
  }
  const names = pkgs.map((p) => p.package).concat((facts.files ? facts.files.items : []).map((f) => f.filename));
  for (const removed of config.removed) {
    if (names.some((n) => String(n).toLowerCase().includes(String(removed).toLowerCase()))) {
      violations.push({ package: removed, rule: 'removed from this cluster; any reappearance is flagged' });
    }
  }
  const compared = { packages: pkgs.map((p) => p.package), violations };
  if (pkgs.length === 0 && violations.length === 0 && ctx.isRenovate) return check('R5', 'not_run', configEvidence(facts, compared), { required: true });
  return check('R5', violations.length ? 'fail' : 'pass', configEvidence(facts, compared), { required: true });
}

function checkR6(facts, ctx, config) {
  if (!ctx.isRenovate) return check('R6', 'not_run', { compared: 'not applicable: not a Renovate PR' }, { required: false });
  const notes = extractReleaseNotes(facts.pr.body);
  if (notes === null) {
    return check('R6', 'pass', prEvidence(facts, { release_notes: 'none in the PR body', hits: [] }), { required: true });
  }
  const lower = notes.toLowerCase();
  const hits = config.release_note_keywords.filter((k) => lower.includes(String(k).toLowerCase()));
  return check('R6', hits.length ? 'flag' : 'pass', prEvidence(facts, { release_notes_chars: notes.length, hits }), { required: true });
}

function checkR7(facts) {
  const pr = facts.pr;
  if (pr.mergeable === undefined && pr.mergeable_state === undefined) {
    return check('R7', 'not_run', prEvidence(facts, 'PR detail not read'), { required: false, informational: true });
  }
  const ageDays = facts.now && pr.created_at ? Math.floor((Date.parse(facts.now) - Date.parse(pr.created_at)) / 86400000) : null;
  const compared = { mergeable: pr.mergeable, mergeable_state: pr.mergeable_state, draft: !!pr.draft, age_days: ageDays };
  const ok = pr.mergeable !== false && !pr.draft && pr.mergeable_state !== 'dirty';
  return check('R7', ok ? 'pass' : 'flag', prEvidence(facts, compared), { required: false, informational: true });
}

function checkR8(facts, ctx) {
  const imgs = ctx.changes.filter((c) => c.kind === 'image' && c.image);
  if (imgs.length === 0) return check('R8', 'not_run', { compared: 'not applicable: no image in the diff' }, { required: false });
  const per = imgs.map((c) => {
    const key = imageKey(c.image);
    const fact = (facts.images || {})[key];
    if (!fact || fact.error) return { image: key, result: 'not_run', reason: fact ? fact.error : 'registry not read', source_url: fact && fact.url };
    return { image: key, result: fact.amd64 ? 'pass' : 'fail', platform: fact.platform || null, source_url: fact.url, digest: fact.digest };
  });
  const order = ['fail', 'not_run', 'pass'];
  const worst = per.slice().sort((a, b) => order.indexOf(a.result) - order.indexOf(b.result))[0];
  return check('R8', worst.result, { source_url: worst.source_url || null, etag_or_sha: worst.digest || null, compared: { images: per } }, { required: true });
}

function compilePatterns(patterns) {
  const out = [];
  let invalid = 0;
  for (const raw of patterns || []) {
    const p = String(raw).trim();
    if (!p || p.startsWith('#')) continue;
    const m = p.match(/^\/(.+)\/([gimsuy]*)$/);
    if (m) {
      try {
        out.push(new RegExp(m[1], m[2].includes('i') ? m[2] : `${m[2]}i`));
      } catch (e) {
        invalid++;
      }
    } else {
      out.push(p.toLowerCase());
    }
  }
  return { list: out, invalid };
}

function countMatches(text, compiled) {
  const lower = text.toLowerCase();
  let n = 0;
  for (const p of compiled) {
    if (typeof p === 'string' ? lower.includes(p) : p.test(text)) n++;
  }
  return n;
}

function checkR9(facts, ctx) {
  if (ctx.isRenovate) return check('R9', 'not_run', { compared: 'not applicable: Renovate PR' }, { required: false });
  const compiled = compilePatterns(facts.patterns);
  if (!facts.files) return check('R9', 'not_run', { compared: 'files not read' }, { required: true });
  if (compiled.list.length === 0) return check('R9', 'not_run', filesEvidence(facts, { reason: 'no deny-list patterns loaded' }), { required: true });
  const hitFiles = [];
  let total = 0;
  for (const f of facts.files.items || []) {
    const added = String(f.patch || '').split('\n').filter((l) => l.startsWith('+')).map((l) => l.slice(1)).join('\n');
    const n = countMatches(`${f.filename}\n${added}`, compiled.list);
    if (n) {
      hitFiles.push(f.filename);
      total += n;
    }
  }
  total += countMatches(`${facts.pr.title || ''}\n${facts.pr.body || ''}`, compiled.list);
  const unpatched = (facts.files.items || []).filter((f) => typeof f.patch !== 'string').map((f) => f.filename);
  // Deny-list values are never echoed: only counts and file paths.
  const compared = { patterns: compiled.list.length, invalid_patterns: compiled.invalid, matched_patterns: total, files_with_matches: hitFiles, files_without_patch: unpatched };
  if (total > 0) return check('R9', 'fail', filesEvidence(facts, compared), { required: true });
  if (unpatched.length) return check('R9', 'not_run', filesEvidence(facts, compared), { required: true });
  return check('R9', 'pass', filesEvidence(facts, compared), { required: true });
}

// ---------------------------------------------------------------- verdict

function isNeedsClaudePackage(pkg, config) {
  return config.needs_claude_packages.includes(pkg);
}

function touchesCrds(facts, ctx) {
  const files = facts.files ? facts.files.items : [];
  if (files.some((f) => /crd/i.test(f.filename))) return true;
  return ctx.changes.some((c) => /kind:\s*CustomResourceDefinition|crds?\.ya?ml/i.test(`${c.old_line || ''}\n${c.new_line || ''}`))
    || files.some((f) => /^[+-].*kind:\s*CustomResourceDefinition/m.test(String(f.patch || '')));
}

// First matching rule wins: blocked, needs-claude, review, low-risk.
function verdictFor(checks, facts, ctx, config) {
  const by = {};
  for (const c of checks) by[c.id] = c;
  const reasons = [];
  for (const id of ['R4', 'R5', 'R8', 'R9']) {
    if (by[id].result === 'fail') reasons.push(`${id} fail`);
  }
  if (reasons.length) return { verdict: 'blocked', reasons };

  if (by.R3.result === 'flag') reasons.push('R3 gated package (Dependency Dashboard approval)');
  const pkgs = Array.from(new Set(packagesOf(ctx).map((p) => p.package)));
  const special = pkgs.filter((p) => isNeedsClaudePackage(p, config));
  if (special.length) reasons.push(`package needs Claude: ${special.join(', ')}`);
  if (touchesCrds(facts, ctx)) reasons.push('touches CRDs');
  const classes = (facts.files ? facts.files.items : []).map((f) => pathClass(f.filename));
  if (classes.includes('clusters') || classes.includes('gotk')) reasons.push('touches clusters/ or gotk-components');
  if (reasons.length) return { verdict: 'needs-claude', reasons };

  if (by.R1.result === 'flag') reasons.push('R1 diff and Renovate table disagree');
  if (by.R2.result === 'flag') reasons.push(`R2 not a single version line in apps/ (${by.R2.path_classes.join(', ')})`);
  if (by.R6.result === 'flag') reasons.push(`R6 release-note keywords: ${(by.R6.evidence.compared.hits || []).join(', ')}`);
  const notRun = checks.filter((c) => c.required && c.result === 'not_run').map((c) => c.id);
  if (notRun.length) reasons.push(`required checks not run: ${notRun.join(', ')}`);
  if (reasons.length) return { verdict: 'review', reasons };

  const lowRiskType = by.R1.result === 'pass' && config.low_risk_update_types.includes(by.R1.classification);
  const kinds = versionChanges(ctx.changes);
  const kindOk = kinds.length > 0 && kinds.every((c) => (c.kind === 'image' && pathClass(c.file) === 'apps') || c.kind === 'chart');
  const required = (id) => !by[id].required || by[id].result === 'pass';
  const clear = by.R2.result === 'pass' && by.R3.result === 'pass' && by.R5.result === 'pass' && by.R6.result === 'pass' && required('R4') && required('R8');
  if (ctx.isRenovate && lowRiskType && kindOk && clear) return { verdict: 'low-risk', reasons: ['all low-risk conditions hold'] };
  return { verdict: 'review', reasons: ['low-risk conditions not all met'] };
}

function buildContext(facts, config) {
  const login = facts.pr.user_login;
  const isRenovate = config.renovate_logins.includes(login);
  const table = isRenovate ? parseRenovateTable(facts.pr.body) : [];
  const changes = extractChanges(facts.files ? facts.files.items : [], table);
  return { isRenovate, table, changes };
}

function evaluate(facts, config) {
  const ctx = buildContext(facts, config);
  const checks = [
    checkR1(facts, ctx),
    checkR2(facts, ctx),
    checkR3(facts, ctx, config),
    checkR4(facts, ctx),
    checkR5(facts, ctx, config),
    checkR6(facts, ctx, config),
    checkR7(facts),
    checkR8(facts, ctx),
    checkR9(facts, ctx),
  ].map(finalize);
  const v = verdictFor(checks, facts, ctx, config);
  return { verdict: v.verdict, reasons: v.reasons, checks };
}

// Fetches the non-GitHub facts one PR needs, then evaluates it.
async function triagePR(http, facts, config, caches) {
  const ctx = buildContext(facts, config);
  const external = await gatherExternalFacts(http, ctx.changes, config, caches);
  return evaluate(Object.assign({}, facts, external), config);
}

function newCaches() {
  return { index: {}, image: {}, tokens: {} };
}

// A synthetic chart that no cluster satisfies. A run whose control does not
// come back `fail` is marked broken.
function negativeControl(cluster, config) {
  const constraint = (config && config.negative_control_kube_version) || '>=99';
  const r = evaluateKubeVersion({ kubeVersion: constraint }, cluster);
  return finalize(check('negative_control', r.result, {
    source_url: cluster ? cluster.url : null,
    etag_or_sha: cluster ? cluster.etag_or_sha : null,
    compared: { kubeVersion: constraint, cluster: cluster ? cluster.gitVersion || null : null, reason: r.reason || null },
  }));
}

// Picks PRs to triage: open, not draft, head_sha not yet seen, oldest first,
// capped per run. A capped or failed list keeps no ETag, so the next run refetches.
function selectPRs(lists, seen, config) {
  const seenSet = new Set(seen || []);
  const candidates = [];
  const etags = {};
  for (const l of lists) {
    const r = l.response || {};
    if (r.statusCode === 304) {
      etags[l.repo] = l.previous_etag || null;
      continue;
    }
    if (r.statusCode !== 200 || !Array.isArray(r.body)) {
      throw new Error(`listing PRs for ${l.repo} failed: HTTP ${r.statusCode}`);
    }
    etags[l.repo] = header(r.headers, 'etag');
    for (const pr of r.body) {
      if (pr.draft) continue;
      const key = `${l.repo}#${pr.number}@${pr.head.sha}`;
      if (seenSet.has(key)) continue;
      candidates.push({ repo: l.repo, number: pr.number, head_sha: pr.head.sha, created_at: pr.created_at });
    }
  }
  candidates.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.number - b.number);
  const selected = candidates.slice(0, config.per_run_cap);
  if (candidates.length > selected.length) {
    for (const c of candidates.slice(config.per_run_cap)) etags[c.repo] = null;
  }
  return { selected, etags, candidates: candidates.length };
}

const RULES_EXPORTS = {
  RESULTS, VERDICTS, WRITE_MODES, CHECK_IDS,
  parseConfigYaml, loadConfig, reposFromConfigLine, assertReposMatch, parseVersion, compareVersions, satisfies, classifyUpdate,
  parseRenovateTable, extractReleaseNotes, parseImageRef, imageKey, parsePatch, extractChanges,
  pathClass, sha256Hex, parseDashboard, findChartEntry, parseAuthChallenge, amd64InIndex, bodyText, bodyJson,
  fetchClusterVersion, fetchChartIndex, fetchImage, gatherExternalFacts,
  finalize, evaluate, verdictFor, triagePR, newCaches, negativeControl, selectPRs, compilePatterns,
};

if (typeof module !== 'undefined' && module.exports && typeof $input === 'undefined') {
  module.exports = RULES_EXPORTS;
}
