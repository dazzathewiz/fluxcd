'use strict';
// PR triage rules R1-R9. Pure functions: no n8n APIs, no require().
// Network access is injected as `http(opts) -> {statusCode, headers, body}`.
// The triage-poll workflow's Triage Code node carries a verbatim copy of
// this file (check with sync-code-nodes.js). Edit here, then run
// `node sync-code-nodes.js --write`.

const RESULTS = ['pass', 'flag', 'fail', 'not_run'];
const VERDICTS = ['blocked', 'deep-review', 'review', 'low-risk', 'human'];
// off: plans are recorded, nothing is written. labels: the GitHub App writes them.
const WRITE_MODES = ['off', 'labels'];
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

const FOLDED = /:\s+>-$/;

// Parses the block-style YAML subset that config.yaml uses: maps, sequences,
// flow sequences of scalars, quoted and plain scalars, `>-` folded scalars,
// comments.
function parseConfigYaml(text) {
  const lines = [];
  const raw = String(text).split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const s = stripComment(raw[i]).replace(/\s+$/, '');
    if (s.trim() === '' || s.trim() === '---') continue;
    const lead = s.match(/^\s*/)[0];
    if (lead.includes('\t')) throw new Error(`config line ${i + 1}: tab indentation`);
    const line = { indent: lead.length, text: s.trim(), n: i + 1 };
    if (FOLDED.test(line.text)) {
      // The block is every following line indented deeper (or blank), read raw:
      // a # inside it is text, not a comment. Lines fold to spaces, blank lines
      // to newlines, and the final newline is stripped.
      const body = [];
      let j = i + 1;
      while (j < raw.length && (raw[j].trim() === '' || raw[j].match(/^\s*/)[0].length > lead.length)) {
        if (raw[j].match(/^\s*/)[0].includes('\t')) throw new Error(`config line ${j + 1}: tab indentation`);
        body.push(raw[j].trim());
        j++;
      }
      line.block = body.join('\n').trim().split(/\n{2,}/).map((p) => p.split('\n').join(' ')).join('\n');
      if (line.block === '') throw new Error(`config line ${i + 1}: empty folded scalar`);
      i = j - 1;
    }
    lines.push(line);
  }
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
      if (line.block !== undefined) {
        out[key] = line.block;
      } else if (rest !== '') {
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
        lines[pos] = Object.assign({}, line, { indent: indent + 2, text: rest });
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

const CONFIG_KEYS = [
  'write_mode', 'repos', 'per_run_cap', 'renovate_logins', 'cluster_version_url', 'negative_control_kube_version',
  'gated', 'caps', 'one_minor_per_pr', 'groups', 'removed', 'deep_review_packages', 'review_floor_packages',
  'path_class_overrides', 'dependants', 'release_note_keywords', 'low_risk_update_types', 'helm_index',
  'verdict_labels', 'outcome_labels', 'status_context', 'app_slug',
  'watch_write_mode', 'watch_timeout_min', 'watch_stale_min', 'watch_kustomizations', 'fix_forward_packages',
];
const UPDATE_TYPES = ['digest', 'pin', 'patch', 'minor', 'major'];
// clusters/ and gotk-components always go to deep-review, and apps/ needs no override.
const OVERRIDABLE_PATH_CLASSES = ['infrastructure', 'other'];
// A floor caps how good a verdict can be; low-risk would be no floor at all.
const FLOORS = ['deep-review', 'review'];
const PACKAGE_NAME = /^[a-z0-9][a-z0-9._/-]*$/;

function checkKeys(where, obj, allowed) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`config: ${where} must be a map`);
  const unknown = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new Error(`config: ${where} has unknown key(s) ${unknown.join(', ')}`);
}

function checkPackage(where, name) {
  if (typeof name !== 'string' || !PACKAGE_NAME.test(name)) throw new Error(`config: ${where} names an invalid package "${name}"`);
}

function loadPathClassOverrides(list, helmIndex) {
  return asList(list).map((o, i) => {
    const where = `path_class_overrides[${i}]`;
    checkKeys(where, o, ['package', 'datasource', 'path_class', 'update_types']);
    checkPackage(where, o.package);
    if (o.datasource !== 'helm' && o.datasource !== 'docker') throw new Error(`config: ${where} datasource must be helm or docker`);
    // A chart the triage can't find in helm_index is a typo or a removed chart.
    if (o.datasource === 'helm' && !Object.prototype.hasOwnProperty.call(helmIndex, o.package)) {
      throw new Error(`config: ${where} names chart ${o.package}, which has no helm_index entry`);
    }
    if (!OVERRIDABLE_PATH_CLASSES.includes(o.path_class)) {
      throw new Error(`config: ${where} path_class must be one of ${OVERRIDABLE_PATH_CLASSES.join(', ')}`);
    }
    const types = asList(o.update_types);
    if (types.length === 0 || !types.every((t) => UPDATE_TYPES.includes(t) && t !== 'major')) {
      throw new Error(`config: ${where} update_types must list ${UPDATE_TYPES.filter((t) => t !== 'major').join(', ')} (majors stay gated)`);
    }
    return { package: o.package, datasource: o.datasource, path_class: o.path_class, update_types: types };
  });
}

function loadDependants(map) {
  if (map === undefined || map === null) return {};
  if (typeof map !== 'object' || Array.isArray(map)) throw new Error('config: dependants must be a map of package to list');
  const out = {};
  const ids = new Set();
  for (const [pkg, entries] of Object.entries(map)) {
    checkPackage(`dependants.${pkg}`, pkg);
    if (!Array.isArray(entries) || entries.length === 0) throw new Error(`config: dependants.${pkg} must be a non-empty list`);
    out[pkg] = entries.map((d, i) => {
      const where = `dependants.${pkg}[${i}]`;
      checkKeys(where, d, ['id', 'where', 'check', 'floor']);
      for (const k of ['id', 'where', 'check']) {
        if (typeof d[k] !== 'string' || d[k].trim() === '') throw new Error(`config: ${where} needs ${k}`);
      }
      if (ids.has(d.id)) throw new Error(`config: ${where} repeats id ${d.id}`);
      ids.add(d.id);
      if (d.floor !== undefined && !FLOORS.includes(d.floor)) throw new Error(`config: ${where} floor must be one of ${FLOORS.join(', ')}`);
      return { id: d.id, where: d.where, check: d.check, floor: d.floor || null };
    });
  }
  return out;
}

// Rule 1: the only labels the App ever adds or removes. The names are fixed here
// as well as in config.yaml, so a config edit can't point a write at another label.
const OUTCOME_LABELS = ['merge', 'merge-watched'];
const STATUS_CONTEXT = /^[a-z0-9][a-z0-9._/-]{0,99}$/;
// A GitHub App slug: lowercase letters, digits and inner hyphens.
const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,32}[a-z0-9])?$/;

function loadLabels(cfg) {
  const v = cfg.verdict_labels;
  checkKeys('verdict_labels', v, VERDICTS);
  for (const verdict of VERDICTS) {
    if (v[verdict] !== `triage:${verdict}`) throw new Error(`config: verdict_labels.${verdict} must be triage:${verdict}`);
  }
  const outcome = asList(cfg.outcome_labels);
  if (outcome.join(',') !== OUTCOME_LABELS.join(',')) throw new Error(`config: outcome_labels must be [${OUTCOME_LABELS.join(', ')}]`);
  if (typeof cfg.status_context !== 'string' || !STATUS_CONTEXT.test(cfg.status_context)) {
    throw new Error('config: status_context must be a commit status context such as pr-triage/verdict');
  }
  if (typeof cfg.app_slug !== 'string' || !APP_SLUG.test(cfg.app_slug)) throw new Error('config: app_slug must be the GitHub App\'s slug');
  return { verdict_labels: Object.assign({}, v), outcome_labels: outcome, status_context: cfg.status_context, app_slug: cfg.app_slug };
}

function loadConfig(text) {
  const cfg = parseConfigYaml(text);
  checkKeys('the top level', cfg, CONFIG_KEYS);
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
  const helmIndex = cfg.helm_index || {};
  const reviewFloor = asList(cfg.review_floor_packages);
  reviewFloor.forEach((p, i) => checkPackage(`review_floor_packages[${i}]`, p));
  return Object.assign({
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
    deep_review_packages: asList(cfg.deep_review_packages),
    review_floor_packages: reviewFloor,
    path_class_overrides: loadPathClassOverrides(cfg.path_class_overrides, helmIndex),
    dependants: loadDependants(cfg.dependants),
    release_note_keywords: asList(cfg.release_note_keywords),
    low_risk_update_types: asList(cfg.low_risk_update_types),
    helm_index: helmIndex,
  }, loadLabels(cfg), loadWatchConfig(cfg));
}

// R10's keys. watch_kustomizations maps a path prefix to the Flux
// Kustomization that applies it; target_namespace mirrors its targetNamespace.
const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const WATCH_PATH = /^(?:[a-z0-9][a-z0-9._-]*\/)+$/;

function loadWatchConfig(cfg) {
  if (!WRITE_MODES.includes(cfg.watch_write_mode)) throw new Error(`config: watch_write_mode must be one of ${WRITE_MODES.join(', ')}`);
  for (const k of ['watch_timeout_min', 'watch_stale_min']) {
    if (!Number.isInteger(cfg[k]) || cfg[k] < 5 || cfg[k] > 1440) throw new Error(`config: ${k} must be a whole number of minutes, 5 to 1440`);
  }
  const seen = new Set();
  const kustomizations = asList(cfg.watch_kustomizations).map((k, i) => {
    const where = `watch_kustomizations[${i}]`;
    checkKeys(where, k, ['path', 'name', 'target_namespace']);
    if (typeof k.path !== 'string' || !WATCH_PATH.test(k.path)) throw new Error(`config: ${where} path must be a repo directory ending in /`);
    if (typeof k.name !== 'string' || !DNS_LABEL.test(k.name)) throw new Error(`config: ${where} name must be a Kustomization name`);
    if (k.target_namespace !== undefined && !(typeof k.target_namespace === 'string' && DNS_LABEL.test(k.target_namespace))) {
      throw new Error(`config: ${where} target_namespace must be a namespace name`);
    }
    if (seen.has(k.path)) throw new Error(`config: ${where} repeats path ${k.path}`);
    seen.add(k.path);
    return { path: k.path, name: k.name, target_namespace: k.target_namespace || null };
  });
  if (kustomizations.length === 0) throw new Error('config: watch_kustomizations must list at least one path');
  const ff = asList(cfg.fix_forward_packages);
  ff.forEach((p, i) => checkPackage(`fix_forward_packages[${i}]`, p));
  return {
    watch_write_mode: cfg.watch_write_mode,
    watch_timeout_min: cfg.watch_timeout_min,
    watch_stale_min: cfg.watch_stale_min,
    watch_kustomizations: kustomizations,
    fix_forward_packages: ff,
  };
}

// The heartbeat's SQL reads watch_stale_min with this same pattern.
function watchStaleFromConfigLine(text) {
  const m = ('\n' + String(text)).match(/\nwatch_stale_min:\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
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
      } else if (key === 'apiVersion' && kvNew && kvOld && kvOld.value !== kvNew.value) {
        // An API migration (e.g. notification.toolkit.fluxcd.io/v1beta3 -> v1), not a
        // package version: the group and version sit after the last '/'.
        const group = kvNew.value.includes('/') ? kvNew.value.slice(0, kvNew.value.lastIndexOf('/')) : 'core';
        Object.assign(change, {
          kind: 'api',
          package: group,
          group,
          from: kvOld.value,
          to: kvNew.value,
          update: 'api',
          datasource: 'kubernetes-api',
        });
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
  // Renovate labels an apiVersion move with a semver-style update type, so compare
  // its table's from/to values with the diff instead of the type.
  const parsed = ctx.changes.filter((c) => c.kind !== 'unparsed');
  if (facts.files && parsed.length > 0 && parsed.every((c) => c.kind === 'api')) {
    const matches = ctx.table.length > 0 && ctx.table.every((r) => parsed.some((c) => c.from === r.from && c.to === r.to));
    compared.classification = 'api-version';
    if (!matches) compared.mismatch = { diff: parsed.map((c) => `${c.from} -> ${c.to}`), table: ctx.table.map((r) => `${r.from} -> ${r.to}`) };
    return check('R1', matches ? 'pass' : 'flag', filesEvidence(facts, compared), { required: true, classification: 'api-version' });
  }
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

// path_class_overrides: the one version change's package, datasource and update
// type, in the overridden path class. It lifts only the path reason.
function pathOverrideFor(change, cls, config) {
  if (!change || !change.package) return null;
  return (config.path_class_overrides || []).find((o) => o.path_class === cls && ruleMatches(o, change.package, change.datasource, change.update)) || null;
}

function checkR2(facts, ctx, config) {
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
  const override = singleLine && classes.length === 1 && classes[0] !== 'apps' ? pathOverrideFor(ctx.changes[0], classes[0], config) : null;
  if (override) compared.path_class_override = override;
  const ok = singleLine && classes.length === 1 && (classes[0] === 'apps' || !!override);
  return check('R2', ok ? 'pass' : 'flag', filesEvidence(facts, compared), { required: true, path_classes: classes, single_version_line: singleLine, path_class_override: !!override });
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

function isDeepReviewPackage(pkg, config) {
  return config.deep_review_packages.includes(pkg);
}

function touchesCrds(facts, ctx) {
  const files = facts.files ? facts.files.items : [];
  if (files.some((f) => /crd/i.test(f.filename))) return true;
  return ctx.changes.some((c) => /kind:\s*CustomResourceDefinition|crds?\.ya?ml/i.test(`${c.old_line || ''}\n${c.new_line || ''}`))
    || files.some((f) => /^[+-].*kind:\s*CustomResourceDefinition/m.test(String(f.patch || '')));
}

// The dependants config lists for the PR's packages, in package order.
function dependantsOf(ctx, config) {
  const out = [];
  for (const pkg of Array.from(new Set(packagesOf(ctx).map((p) => p.package)))) {
    for (const d of (config.dependants || {})[pkg] || []) out.push(Object.assign({ package: pkg }, d));
  }
  return out;
}

// Floors from review_floor_packages and dependant floors: [{floor, reason}].
function floorsOf(ctx, config, dependants) {
  const pkgs = Array.from(new Set(packagesOf(ctx).map((p) => p.package)));
  const out = pkgs.filter((p) => (config.review_floor_packages || []).includes(p))
    .map((p) => ({ floor: 'review', reason: `floor review: ${p} is never low-risk` }));
  for (const d of dependants) {
    if (d.floor) out.push({ floor: d.floor, reason: `floor ${d.floor}: dependant ${d.id} of ${d.package}` });
  }
  return out;
}

// First matching rule wins: blocked, deep-review, review, low-risk. A floor
// joins the reasons at its own level, so it can only make a verdict worse.
function verdictFor(checks, facts, ctx, config, floors) {
  const by = {};
  for (const c of checks) by[c.id] = c;
  const floorReasons = (level) => (floors || []).filter((f) => f.floor === level).map((f) => f.reason);
  const reasons = [];
  for (const id of ['R4', 'R5', 'R8', 'R9']) {
    if (by[id].result === 'fail') reasons.push(`${id} fail`);
  }
  if (reasons.length) return { verdict: 'blocked', reasons };

  if (by.R3.result === 'flag') reasons.push('R3 gated package (Dependency Dashboard approval)');
  const pkgs = Array.from(new Set(packagesOf(ctx).map((p) => p.package)));
  const special = pkgs.filter((p) => isDeepReviewPackage(p, config));
  if (special.length) reasons.push(`deep-review package: ${special.join(', ')}`);
  reasons.push(...floorReasons('deep-review'));
  if (touchesCrds(facts, ctx)) reasons.push('touches CRDs');
  const apiMoves = ctx.changes.filter((c) => c.kind === 'api');
  if (apiMoves.length) {
    reasons.push(`API version change: ${apiMoves.map((c) => `${c.group} ${c.from.split('/').pop()} -> ${c.to.split('/').pop()}`).join(', ')}`);
  }
  const classes = (facts.files ? facts.files.items : []).map((f) => pathClass(f.filename));
  if (classes.includes('clusters') || classes.includes('gotk')) reasons.push('touches clusters/ or gotk-components');
  if (reasons.length) return { verdict: 'deep-review', reasons };

  if (by.R1.result === 'flag') reasons.push('R1 diff and Renovate table disagree');
  if (by.R2.result === 'flag') reasons.push(`R2 not a single version line in apps/ (${by.R2.path_classes.join(', ')})`);
  if (by.R6.result === 'flag') reasons.push(`R6 release-note keywords: ${(by.R6.evidence.compared.hits || []).join(', ')}`);
  const notRun = checks.filter((c) => c.required && c.result === 'not_run').map((c) => c.id);
  if (notRun.length) reasons.push(`required checks not run: ${notRun.join(', ')}`);
  reasons.push(...floorReasons('review'));
  if (reasons.length) return { verdict: 'review', reasons };

  const lowRiskType = by.R1.result === 'pass' && config.low_risk_update_types.includes(by.R1.classification);
  const kinds = versionChanges(ctx.changes);
  const imageOk = (c) => pathClass(c.file) === 'apps' || by.R2.path_class_override === true;
  const kindOk = kinds.length > 0 && kinds.every((c) => (c.kind === 'image' && imageOk(c)) || c.kind === 'chart');
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

// A PR from anyone but Renovate is triaged by hand. Only R9 runs: a hit is
// blocked; otherwise the verdict is human, recorded finalised. If R9 couldn't
// run, the verdict is still human but left unfinalised, so a later ruleset
// checks it again.
function evaluateHuman(facts, ctx) {
  const skipped = (id) => check(id, 'not_run', { compared: 'not applicable: not a Renovate PR (triaged by hand)' }, { required: false });
  const checks = CHECK_IDS.map((id) => (id === 'R9' ? checkR9(facts, ctx) : skipped(id))).map(finalize);
  const r9 = checks.find((c) => c.id === 'R9');
  if (r9.result === 'fail') return { verdict: 'blocked', reasons: ['R9 fail'], checks, dependants: [], finalise: false };
  if (r9.result === 'pass') return { verdict: 'human', reasons: ['not a Renovate PR: triaged by hand'], checks, dependants: [], finalise: true };
  return { verdict: 'human', reasons: ['not a Renovate PR: triaged by hand', 'R9 not run: left unfinalised'], checks, dependants: [], finalise: false };
}

function evaluate(facts, config) {
  const ctx = buildContext(facts, config);
  if (!ctx.isRenovate) return evaluateHuman(facts, ctx);
  const checks = [
    checkR1(facts, ctx),
    checkR2(facts, ctx, config),
    checkR3(facts, ctx, config),
    checkR4(facts, ctx),
    checkR5(facts, ctx, config),
    checkR6(facts, ctx, config),
    checkR7(facts),
    checkR8(facts, ctx),
    checkR9(facts, ctx),
  ].map(finalize);
  const dependants = dependantsOf(ctx, config);
  const v = verdictFor(checks, facts, ctx, config, floorsOf(ctx, config, dependants));
  // Dependants go into the reasons, which every row stores (carried or not),
  // so the review sees what outside the repo to check.
  const reasons = v.reasons.concat(dependants.map((d) => `dependant ${d.id} (${d.where}): ${d.check}`));
  return {
    verdict: v.verdict,
    reasons,
    checks,
    dependants: dependants.map((d) => ({ id: d.id, where: d.where, check: d.check })),
    finalise: false,
  };
}

// Fetches the non-GitHub facts one PR needs, then evaluates it.
async function triagePR(http, facts, config, caches) {
  const ctx = buildContext(facts, config);
  if (!ctx.isRenovate) return evaluate(facts, config);
  const external = await gatherExternalFacts(http, ctx.changes, config, caches);
  return evaluate(Object.assign({}, facts, external), config);
}

// Compares a new result with the latest verdict row for the same head SHA:
// previous = {id, verdict, results: [{id, result}]}, where id is the full row
// (a carried row's own carried_from). Same verdict and the same result for every
// check: a carried row, which stores no checks and points at that full row.
// Anything else: a full row.
function carryForward(result, previous) {
  const full = { carried_from: null, checks: result.checks };
  if (!previous || !previous.id || previous.verdict !== result.verdict || !Array.isArray(previous.results)) return full;
  const before = {};
  for (const c of previous.results) before[c.id] = c.result;
  const now = result.checks.map((c) => [c.id, c.result]);
  if (Object.keys(before).length !== now.length) return full;
  if (!now.every(([id, r]) => before[id] === r)) return full;
  return { carried_from: previous.id, checks: null };
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

// ---------------------------------------------------------------- publish (write_mode labels)

// Each open PR gets one triage:<verdict> label, one triage comment and one
// commit status, all written by the GitHub App in the TriagePublishV01
// sub-workflow. planPublish turns what was read into the exact writes; it
// never writes anything itself.

// Escalation order. On one head SHA the automation only moves rightwards.
const SEVERITY = ['low-risk', 'review', 'deep-review', 'human', 'blocked'];
const STATUS_STATES = { 'low-risk': 'success', review: 'pending', 'deep-review': 'pending', human: 'pending', blocked: 'failure' };
const VERDICT_MEANING = {
  'low-risk': 'Low risk: this is the merge signal.',
  review: 'Needs a review: merge it, or escalate to deep-review.',
  'deep-review': 'Needs a deep review: merge it, or hand it to a person.',
  human: 'A person decides: merge it, or apply a merge label.',
  blocked: 'Blocked: no further action on this commit.',
};
const STATUS_DESCRIPTIONS = {
  'low-risk': 'low-risk: the merge signal',
  review: 'review: needs a review before merge',
  'deep-review': 'deep-review: needs a deep review before merge',
  human: 'human: a person decides',
  blocked: 'blocked: no further action on this commit',
};
const LABEL_STYLES = {
  'triage:low-risk': { color: '0e8a16', description: 'PR triage: low risk, the merge signal' },
  'triage:review': { color: 'fbca04', description: 'PR triage: needs a review' },
  'triage:deep-review': { color: 'd93f0b', description: 'PR triage: needs a deep review' },
  'triage:human': { color: '5319e7', description: 'PR triage: a person decides' },
  'triage:blocked': { color: 'b60205', description: 'PR triage: blocked' },
};
// The publications.outcome values a plan can start with. Record publish turns
// publishing into published or failed.
const PUBLISH_SKIPS = ['unhealthy', 'closed', 'draft', 'no-verdict', 'no-app', 'label-events-incomplete', 'comments-incomplete', 'bad-input'];
// triage.runs.publish.
const RUN_PUBLISH = ['planned-only', 'skipped-unhealthy', 'no-op', 'published', 'redaction-hit', 'failed'];
const ACTION_TYPES = ['create_comment', 'edit_comment', 'set_status', 'ensure_label', 'remove_label', 'add_label'];
const MARKER_RE = /^<!-- pr-triage:v1 sha=([0-9a-f]{40}) ruleset=([A-Za-z0-9._-]{1,64}) verdict=([a-z-]+) -->/;
const RULESET_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const RATE_LIMIT_URL = 'https://api.github.com/rate_limit';

function publishMarker(sha, ruleset, verdict) {
  return `<!-- pr-triage:v1 sha=${sha} ruleset=${ruleset} verdict=${verdict} -->`;
}

function parseMarker(body) {
  const m = String(body || '').match(MARKER_RE);
  return m ? { sha: m[1], ruleset: m[2], verdict: m[3] } : null;
}

function managedLabels(config) {
  return VERDICTS.map((v) => config.verdict_labels[v]).concat(config.outcome_labels);
}

function severity(verdict) {
  return SEVERITY.indexOf(verdict);
}

// The reasons rules.js writes, each as a fixed template. A stored reason that
// fits none is shown as a placeholder, so no free text reaches the comment.
const R_ID = 'R[1-9]';
const PKG = '[a-z0-9][a-z0-9._/-]*';
const PATH_CLASSES = ['apps', 'infrastructure', 'clusters', 'gotk', 'other'];
const tpl = (s) => new RegExp(`^${s}$`);
const listOf = (item) => `${item}(?:, ${item})*`;
const REASON_TEMPLATES = [
  tpl('(?:R4|R5|R8|R9) fail'),
  tpl('R3 gated package \\(Dependency Dashboard approval\\)'),
  tpl(`deep-review package: ${listOf(PKG)}`),
  tpl(`floor (?:review|deep-review): ${PKG} is never low-risk`),
  tpl(`floor (?:review|deep-review): dependant [a-z0-9][a-z0-9-]* of ${PKG}`),
  tpl('touches CRDs'),
  tpl(`API version change: ${listOf('(?:core|[a-z0-9][a-z0-9.-]*) [a-z0-9]+ -> [a-z0-9]+')}`),
  tpl('touches clusters/ or gotk-components'),
  tpl('R1 diff and Renovate table disagree'),
  tpl(`R2 not a single version line in apps/ \\(${listOf(`(?:${PATH_CLASSES.join('|')})`)}\\)`),
  tpl(`required checks not run: ${listOf(R_ID)}`),
  tpl('low-risk conditions not all met'),
  tpl('all low-risk conditions hold'),
  tpl('not a Renovate PR: triaged by hand'),
  tpl('R9 not run: left unfinalised'),
];

function templatedReason(reason, config) {
  const r = String(reason);
  if (REASON_TEMPLATES.some((t) => t.test(r))) return r;
  const kw = r.match(/^R6 release-note keywords: (.+)$/);
  if (kw && kw[1].split(', ').every((k) => config.release_note_keywords.includes(k))) return r;
  return 'other reason (see triage.verdicts)';
}

// A dependant reason is rendered from the config entry its id names.
function templatedDependant(reason, config) {
  const m = String(reason).match(/^dependant ([a-z0-9][a-z0-9-]*) \(/);
  if (!m) return null;
  for (const entries of Object.values(config.dependants || {})) {
    const d = entries.find((e) => e.id === m[1]);
    if (d) return `${d.id} (${d.where}): ${d.check}`;
  }
  return 'a dependant not in the current config (see triage.verdicts)';
}

// PR and issue references are written without #, so a comment never links
// or notifies anything.
function withoutHashRefs(text) {
  return String(text).replace(/#(\d)/g, 'PR $1').replace(/@(?=[A-Za-z0-9])/g, '@​');
}

// The triage comment: the marker first, then fixed templates only. The same
// inputs give the same bytes, so an unchanged comment is never edited.
function renderTriageComment(input, config) {
  const { head_sha: sha, ruleset, verdict, triaged_verdict: triaged } = input;
  const why = [];
  const deps = [];
  for (const r of input.reasons || []) {
    const d = templatedDependant(r, config);
    if (d) deps.push(d);
    else why.push(templatedReason(r, config));
  }
  const lines = [
    `### PR triage: \`${verdict}\``,
    '',
    `Commit \`${sha.slice(0, 12)}\`, ruleset \`${ruleset}\`. ${VERDICT_MEANING[verdict]}`,
  ];
  if (why.length) lines.push('', '**Why**', ...why.map((r) => `- ${r}`));
  if (deps.length) lines.push('', '**Check outside the repo**', ...deps.map((d) => `- ${d}`));
  if (triaged && triaged !== verdict) {
    lines.push('', `Held at \`${verdict}\`: this ruleset gave \`${triaged}\`, and triage only escalates a commit.`);
  }
  if (input.override) {
    lines.push('', 'A triage or outcome label on this commit was changed by hand, so triage leaves the labels alone until the next commit.');
  }
  lines.push('', '<sub>Written by the PR triage automation for this commit only. A new commit is triaged again. Merges are by hand.</sub>');
  return `${publishMarker(sha, ruleset, verdict)}\n${withoutHashRefs(lines.join('\n'))}`;
}

// Pages from a Link-paginated read: complete only if every page read and the
// last has no next link. Returns the items, or null.
function pagedItems(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return null;
  const items = [];
  for (const p of pages) {
    if (!p || p.statusCode !== 200 || !Array.isArray(p.body)) return null;
    items.push(...p.body);
  }
  const last = pages[pages.length - 1];
  if (/<[^>]+>;\s*rel="next"/.test(String(header(last.headers, 'link') || ''))) return null;
  return items;
}

// The App's actor login, from config.yaml's app_slug. Label events name only
// the actor, so this is how the App's own label events are told apart.
function appLoginOf(config) {
  return `${config.app_slug}[bot]`;
}

// A comment is the App's only if its author is the App's login and GitHub
// says the App made it.
function isAppComment(c, appLogin) {
  const app = c && c.performed_via_github_app;
  return !!(app && c.user && c.user.login === appLogin && `${app.slug}[bot]` === appLogin);
}

// The App's triage comments on this head SHA, oldest first. The stored comment
// is read directly; only when it isn't usable are the PR's comments searched.
function triageComments(read, appLogin, sha) {
  const mine = (c) => isAppComment(c, appLogin) && Number.isInteger(c.id) && (parseMarker(c.body) || {}).sha === sha;
  const stored = read.stored || {};
  if (stored.statusCode === 200 && mine(stored.body)) return { ok: true, comments: [stored.body] };
  if (read.stored_id && ![200, 404, 410].includes(stored.statusCode)) return { ok: false };
  const listed = pagedItems(read.list);
  if (!listed) return { ok: false };
  return { ok: true, comments: listed.filter(mine).sort((a, b) => a.id - b.id) };
}

// A triage or outcome label added or removed on this head SHA by anyone but
// the App. since is when the poll last saw another head SHA of the PR (or the
// latest force push): earlier events belong to an earlier commit.
function findOverride(events, appLogin, managed, since) {
  const from = since ? Date.parse(since) : null;
  const hits = (events || []).filter((e) => e && (e.event === 'labeled' || e.event === 'unlabeled')
    && e.label && managed.includes(e.label.name)
    && (from === null || Date.parse(e.created_at) >= from)
    && !(appLogin && e.actor && e.actor.login === appLogin));
  if (!hits.length) return null;
  const last = hits.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || (a.id || 0) - (b.id || 0))[hits.length - 1];
  return { actor: last.actor ? last.actor.login : null, label: last.label.name, event: last.event };
}

// The start of this head SHA's window: the last time the poll saw another head
// SHA of the PR, or the latest force push, whichever is later.
function headSince(seenShas, headSha, events) {
  let t = null;
  for (const [sha, at] of Object.entries(seenShas || {})) {
    if (sha !== headSha && at && (t === null || Date.parse(at) > Date.parse(t))) t = at;
  }
  for (const e of events || []) {
    if (e && e.event === 'head_ref_force_pushed' && e.created_at && (t === null || Date.parse(e.created_at) > Date.parse(t))) t = e.created_at;
  }
  return t;
}

// Rules 1-6 for one open PR.
//   prState     {repo, number, head_sha, state, draft, labels: [name],
//                repo_labels: [name] | null, since, comments: {stored_id, stored, list}}
//   verdict     the head SHA's current verdict {verdict, reasons, ruleset}, or null
//   publication the triage.publications row for this head SHA, or null
//   labelEvents the PR's issue-event pages [{statusCode, headers, body}]
//   appLogin    the App's login, appLoginOf(config): <app_slug>[bot]
//   ctx         {config, healthy, patterns, app_id, installation_id}
// Returns {action: publish | skip, outcome, actions: [...], ...}. A skip makes
// no request; publish lists the writes in the order they run.
function planPublish(prState, verdict, publication, labelEvents, appLogin, ctx) {
  const config = ctx.config;
  const p = prState || {};
  const plan = {
    repo: p.repo, pr: p.number, head_sha: p.head_sha, action: 'skip', outcome: null, reason: null,
    verdict: null, triaged_verdict: null, ruleset: null, label: null, status: null,
    human_override: false, override_actor: null, override_label: null, actions: [],
  };
  const skip = (reason, extra) => Object.assign(plan, { reason, outcome: reason === 'up-to-date' || reason === 'redaction-hit' ? reason : `skipped-${reason}` }, extra || {});
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(p.repo)) || !Number.isInteger(p.number) || !SHA_RE.test(String(p.head_sha)) || !Array.isArray(p.labels)) return skip('bad-input');
  // The login always comes from config, in every write_mode.
  if (appLogin !== appLoginOf(config)) return skip('bad-input');
  // Rule 6: an unhealthy run publishes nothing. No patterns, or a bad one, is unhealthy.
  const patterns = compilePatterns(ctx.patterns);
  if (!ctx.healthy || patterns.list.length === 0 || patterns.invalid > 0) return skip('unhealthy');
  if (p.state && p.state !== 'open') return skip('closed');
  if (p.draft) return skip('draft');
  if (!verdict || !VERDICTS.includes(verdict.verdict) || !RULESET_RE.test(String(verdict.ruleset || ''))) return skip('no-verdict');
  if (config.write_mode === 'labels' && !(/^\d+$/.test(String(ctx.app_id || '')) && /^\d+$/.test(String(ctx.installation_id || '')))) return skip('no-app');
  const events = pagedItems(labelEvents);
  if (!events) return skip('label-events-incomplete');
  const found = triageComments(p.comments || {}, appLogin, p.head_sha);
  if (!found.ok) return skip('comments-incomplete');

  const managed = managedLabels(config);
  const published = publication && VERDICTS.includes(publication.verdict) ? publication : null;
  const triaged = verdict.verdict;
  // Rule 2: on one head SHA the automation only escalates.
  const eff = published && severity(published.verdict) > severity(triaged) ? published.verdict : triaged;
  const label = config.verdict_labels[eff];
  const override = findOverride(events, appLogin, managed, p.since);
  const status = { state: STATUS_STATES[eff], context: config.status_context, description: STATUS_DESCRIPTIONS[eff] };
  const body = renderTriageComment({ head_sha: p.head_sha, ruleset: verdict.ruleset, verdict: eff, triaged_verdict: triaged, reasons: verdict.reasons, override: !!override }, config);
  Object.assign(plan, {
    verdict: eff, triaged_verdict: triaged, ruleset: verdict.ruleset,
    label: override ? (published ? published.label || null : null) : label,
    status: override ? null : status,
    human_override: !!override, override_actor: override ? override.actor : null, override_label: override ? override.label : null,
  });
  // Rule 6: a redaction hit publishes nothing. Only a count is kept.
  const hits = countMatches(`${body}\n${status.description}`, patterns.list);
  if (hits) return skip('redaction-hit', { matched_patterns: hits, label: null, status: null });

  const actions = [];
  // The comment. Same verdict: edit in place. Changed verdict or new head SHA:
  // a new comment, unless an earlier try already posted this verdict's one.
  // Under an override the comment is all that changes.
  const mine = found.comments;
  const forVerdict = mine.filter((c) => parseMarker(c.body).verdict === eff).pop();
  const target = override ? mine[mine.length - 1] : forVerdict;
  // An override alone is not a re-triage: with nothing new published here
  // (same verdict, same ruleset), the comment stays as it is.
  const retriage = !published || published.verdict !== eff || published.ruleset !== verdict.ruleset;
  if (!target) actions.push({ type: 'create_comment', body });
  else if (target.body !== body && (retriage || !override)) actions.push({ type: 'edit_comment', comment_id: target.id, body });

  if (!override) {
    const sameVerdict = !!published && published.verdict === eff;
    if (!sameVerdict || published.ruleset !== verdict.ruleset || published.status_state !== status.state) {
      actions.push(Object.assign({ type: 'set_status', sha: p.head_sha }, status));
    }
    // Rule 4. Same verdict: no label change. Changed verdict or new head SHA:
    // swap to the verdict label and drop every other verdict and outcome label.
    if (!sameVerdict) {
      const current = p.labels.filter((n) => managed.includes(n));
      if (!current.includes(label)) {
        if (!(p.repo_labels || []).includes(label)) actions.push(Object.assign({ type: 'ensure_label', name: label }, LABEL_STYLES[label]));
      }
      for (const n of current) if (n !== label) actions.push({ type: 'remove_label', name: n });
      if (!current.includes(label)) actions.push({ type: 'add_label', name: label });
    }
  }
  if (!actions.length) return skip('up-to-date');
  return Object.assign(plan, { action: 'publish', outcome: config.write_mode === 'labels' ? 'publishing' : 'planned-only', actions });
}

// ------------------------------------------------- R10: post-merge watch
// After a merge to the default branch: did Flux apply it, did each HelmRelease
// it changed upgrade, and did each Deployment or StatefulSet whose image changed
// finish rolling out. Alert-only: nothing here reverts anything.

const WATCH_STATUSES = ['pending', 'ok', 'failed', 'timeout'];
const WATCH_LABELS = { ok: 'triage:post-merge-ok', failed: 'triage:post-merge-failed' };
const WATCH_LABEL_STYLES = {
  'triage:post-merge-ok': { color: '0e8a16', description: 'PR triage: the merge rolled out' },
  'triage:post-merge-failed': { color: 'b60205', description: 'PR triage: the merge did not roll out' },
};
const WATCH_MARKER_RE = /^<!-- pr-triage-watch:v1 sha=([0-9a-f]{40}) status=(failed|timeout) -->/;
const WATCH_ACTION_TYPES = ['watch_ensure_label', 'watch_add_label', 'ensure_label', 'add_label', 'create_comment'];
const WORKLOAD_KINDS = { Deployment: 'deployment', StatefulSet: 'statefulset' };
// The only cluster reads TriageClusterV01 makes. {ns} and {name} are DNS labels.
const CLUSTER_PATHS = [
  '/version',
  '/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/flux-system/kustomizations/{name}',
  '/apis/helm.toolkit.fluxcd.io/v2/namespaces/{ns}/helmreleases/{name}',
  '/apis/apps/v1/namespaces/{ns}/deployments/{name}',
  '/apis/apps/v1/namespaces/{ns}/statefulsets/{name}',
];
const CLUSTER_PATH_FOR = {
  kustomization: CLUSTER_PATHS[1], helmrelease: CLUSTER_PATHS[2], deployment: CLUSTER_PATHS[3], statefulset: CLUSTER_PATHS[4],
};
// A HelmRelease Ready=False reason that means the new chart didn't go in.
const HR_FAIL_REASONS = ['InstallFailed', 'UpgradeFailed', 'TestFailed', 'RollbackSucceeded', 'RollbackFailed', 'UninstallFailed', 'ArtifactFailed', 'InitFailed', 'RetriesExceeded'];
// A Kustomization Ready=False reason that isn't (yet) a failure.
const KS_WAIT_REASONS = ['Progressing', 'DependencyNotReady'];
const FIX_FORWARD_MARKER = /^rollback:\s*fix-forward\s*$/im;

function clusterPath(type, ns, name) {
  const t = CLUSTER_PATH_FOR[type];
  if (!t || !DNS_LABEL.test(String(name || ''))) return null;
  if (t.includes('{ns}') && !DNS_LABEL.test(String(ns || ''))) return null;
  return t.replace('{ns}', ns).replace('{name}', name);
}

// The same check TriageClusterV01 makes before any request.
function allowedClusterPath(path) {
  if (typeof path !== 'string') return false;
  const label = '[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?';
  return CLUSTER_PATHS.some((t) => new RegExp(`^${t.replace(/[.]/g, '\\.').replace('{ns}', label).replace('{name}', label)}$`).test(path));
}

// New-side line numbers a patch touches: added lines, and where removed lines
// were. Also the added lines themselves, by new line number.
function patchLines(patch) {
  const touched = new Set();
  const added = {};
  let n = null;
  for (const line of String(patch || '').split('\n')) {
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { n = parseInt(h[1], 10); continue; }
    if (n === null || line.startsWith('\\')) continue;
    if (line.startsWith('+')) { touched.add(n); added[n] = line.slice(1); n++; }
    else if (line.startsWith('-')) touched.add(n);
    else n++;
  }
  return { touched, added };
}

const MANIFEST_FILE = /\.ya?ml$/;
const IMAGE_LINE = /^\s*(?:-\s+)?image:\s*["']?([^\s"'#]+)["']?\s*(?:#.*)?$/;

// The Kubernetes objects in one manifest file, with their line ranges. A
// line scanner, not a YAML parser: enough for kind, metadata, the chart
// version and image lines.
function manifestDocs(text) {
  const lines = String(text || '').split('\n');
  const docs = [];
  let doc = null;
  let stack = [];
  const open = (start) => {
    doc = { start, end: start, kind: null, apiVersion: null, name: null, namespace: null, chart: null, version: null, images: [] };
    docs.push(doc);
    stack = [];
  };
  open(1);
  lines.forEach((raw, i) => {
    const no = i + 1;
    if (/^---(\s|$)/.test(raw)) { doc.end = no - 1; open(no + 1); return; }
    doc.end = no;
    const line = raw.replace(/\s+#.*$/, '');
    if (/^\s*(#|$)/.test(line)) return;
    const img = line.match(IMAGE_LINE);
    if (img) doc.images.push({ line: no, image: img[1] });
    const m = line.match(/^(\s*)(-\s+)?([\w.-]+):\s*(.*)$/);
    if (!m) return;
    const indent = m[1].length + (m[2] ? m[2].length : 0);
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ indent, key: m[3] });
    const path = stack.map((s) => s.key).join('.');
    const value = m[4].replace(/^&\S+\s*/, '').replace(/^["']|["']$/g, '').trim();
    if (path === 'kind') doc.kind = value;
    else if (path === 'apiVersion') doc.apiVersion = value;
    else if (path === 'metadata.name') doc.name = value;
    else if (path === 'metadata.namespace') doc.namespace = value;
    else if (path === 'spec.chart.spec.chart') doc.chart = value;
    else if (path === 'spec.chart.spec.version') { doc.version = value; doc.version_line = no; }
    else if (path === 'spec.version') doc.plan_version_line = no;
  });
  return docs.filter((d) => d.kind);
}

// The Kustomization that applies a path: the longest matching prefix.
function kustomizationFor(filename, config) {
  let best = null;
  for (const k of config.watch_kustomizations) {
    if (String(filename).startsWith(k.path) && (!best || k.path.length > best.path.length)) best = k;
  }
  return best;
}

// planWatch: the rollout targets for one merge.
//   files: the PR files API items {filename, previous_filename, status, patch},
//          each with content: the file's text at the merge commit, or null.
// Returns {targets: [{id, type, name, ns?, version?, chart?, images?}], notes}.
function planWatch(files, config) {
  const targets = [];
  const notes = [];
  const ids = new Set();
  const add = (t) => { if (!ids.has(t.id)) { ids.add(t.id); targets.push(t); } };
  for (const f of files || []) {
    for (const name of [f.previous_filename, f.filename].filter(Boolean)) {
      const k = kustomizationFor(name, config);
      if (k) add({ id: `kustomization ${k.name}`, type: 'kustomization', name: k.name });
    }
    if (f.status === 'removed' || !/\.ya?ml$/.test(String(f.filename))) continue;
    const ks = kustomizationFor(f.filename, config);
    const hasPatch = typeof f.patch === 'string';
    const p = hasPatch ? patchLines(f.patch) : null;
    const relevant = hasPatch && Object.values(p.added).some((l) => IMAGE_LINE.test(l) || /^\s*(?:-\s+)?(version|chart):/.test(l));
    if (typeof f.content !== 'string') {
      if (!hasPatch || relevant) notes.push(`${f.filename}: not read at the merge commit; kustomization check only`);
      continue;
    }
    if (!hasPatch) notes.push(`${f.filename}: no patch in the API response; every object in it is checked`);
    for (const d of manifestDocs(f.content)) {
      const inDoc = (no) => no >= d.start && no <= d.end;
      const changed = !hasPatch || Array.from(p.touched).some(inDoc);
      if (!changed) continue;
      const ns = (ks && ks.target_namespace) || d.namespace;
      const where = `${d.kind} ${ns || '?'}/${d.name || '?'}`;
      if (d.kind === 'HelmRelease' && /^helm\.toolkit\.fluxcd\.io\//.test(String(d.apiVersion))) {
        if (!d.version) { notes.push(`${where}: no spec.chart.spec.version; kustomization check only`); continue; }
        const path = clusterPath('helmrelease', ns, d.name);
        if (!path) { notes.push(`${where}: name or namespace not resolved; kustomization check only`); continue; }
        add({ id: `helmrelease ${ns}/${d.name}`, type: 'helmrelease', ns, name: d.name, chart: d.chart, version: d.version });
        continue;
      }
      const images = d.images.filter((im) => !hasPatch || p.added[im.line] !== undefined).map((im) => im.image);
      if (!images.length) continue;
      const type = WORKLOAD_KINDS[d.kind];
      if (!type) { notes.push(`${where}: image change in a ${d.kind}; kustomization check only`); continue; }
      if (!clusterPath(type, ns, d.name)) { notes.push(`${where}: name or namespace not resolved; kustomization check only`); continue; }
      add({ id: `${type} ${ns}/${d.name}`, type, ns, name: d.name, images: Array.from(new Set(images)) });
    }
  }
  return { targets, notes };
}

// The cluster reads for a watch's targets, as TriageClusterV01 paths.
function watchReads(targets) {
  return (targets || []).map((t) => ({ id: t.id, path: clusterPath(t.type, t.ns, t.name) })).filter((r) => r.path);
}

function revisionSha(rev) {
  const m = String(rev || '').match(/(?:^|[@:])([0-9a-f]{40})$/);
  return m ? m[1] : null;
}

// Reasons and versions from the cluster, before they go into a condition.
const safeWord = (s) => (/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(String(s)) ? String(s) : 'Unknown');
const conditionOf = (body, type) => (((body || {}).status || {}).conditions || []).find((c) => c && c.type === type) || null;

function checkKustomization(t, read, includes) {
  if (!read || read.statusCode === 404) return read ? { state: 'fail', cond: 'not found' } : { state: 'pending', cond: 'not read' };
  if (read.statusCode !== 200 || !read.body) return { state: 'pending', cond: 'not read' };
  const st = read.body.status || {};
  const ready = conditionOf(read.body, 'Ready');
  const applied = revisionSha(st.lastAppliedRevision);
  const attempted = revisionSha(st.lastAttemptedRevision);
  // lastAppliedRevision moves only after a successful apply. While Flux
  // reconciles again (every interval, a few seconds), Ready is Unknown and
  // the applied revision still stands, so that counts as applied too.
  if (ready && ready.status === 'False' && !KS_WAIT_REASONS.includes(ready.reason) && includes(attempted) === true) {
    return { state: 'fail', cond: `Ready=False (${safeWord(ready.reason)})` };
  }
  if (ready && ready.status !== 'False' && includes(applied) === true) {
    return { state: 'ok', cond: ready.status === 'True' ? 'applied' : 'applied (reconciling again)' };
  }
  if (includes(applied) === null || includes(attempted) === null) return { state: 'pending', cond: 'revision not compared yet' };
  if (ready && ready.status === 'Unknown') return { state: 'pending', cond: 'merge not applied yet (reconciling)' };
  return { state: 'pending', cond: 'merge not applied yet' };
}

function checkHelmRelease(t, read) {
  if (!read || read.statusCode === 404) return read ? { state: 'fail', cond: 'not found' } : { state: 'pending', cond: 'not read' };
  if (read.statusCode !== 200 || !read.body) return { state: 'pending', cond: 'not read' };
  const b = read.body;
  const live = (((b.spec || {}).chart || {}).spec || {}).version;
  const hist = ((b.status || {}).history || [])[0] || {};
  const ready = conditionOf(b, 'Ready');
  const stalled = conditionOf(b, 'Stalled');
  const settled = (b.status || {}).observedGeneration === (b.metadata || {}).generation;
  // history[0] is the release Helm last deployed. Ready=Unknown means another
  // reconcile is running, which doesn't undo it.
  const deployed = hist.chartVersion === t.version && (hist.status === undefined || hist.status === 'deployed');
  if (deployed && ready && ready.status !== 'False' && settled) {
    return { state: 'ok', cond: ready.status === 'True' ? `chart ${t.version} installed` : `chart ${t.version} installed (reconciling again)` };
  }
  if (live === t.version && stalled && stalled.status === 'True') return { state: 'fail', cond: `Stalled (${safeWord(stalled.reason)})` };
  if (live === t.version && ready && ready.status === 'False' && HR_FAIL_REASONS.includes(ready.reason)) {
    return { state: 'fail', cond: `Ready=False (${safeWord(ready.reason)})` };
  }
  if (live !== t.version) return { state: 'pending', cond: 'new chart version not applied yet' };
  return { state: 'pending', cond: `chart ${t.version} not installed yet` };
}

function checkWorkload(t, read) {
  if (!read || read.statusCode === 404) return read ? { state: 'fail', cond: 'not found' } : { state: 'pending', cond: 'not read' };
  if (read.statusCode !== 200 || !read.body) return { state: 'pending', cond: 'not read' };
  const b = read.body;
  const spec = b.spec || {};
  const st = b.status || {};
  const pod = ((spec.template || {}).spec) || {};
  const live = [].concat(pod.containers || [], pod.initContainers || []).map((c) => c && c.image);
  const imageLive = (t.images || []).every((im) => live.includes(im));
  const want = Number.isInteger(spec.replicas) ? spec.replicas : 1;
  const [replicas, updated, ready] = [st.replicas, st.updatedReplicas, st.readyReplicas].map((x) => (Number.isInteger(x) ? x : 0));
  const observed = st.observedGeneration === (b.metadata || {}).generation;
  if (observed && imageLive && updated === ready && ready === replicas && replicas === want) return { state: 'ok', cond: 'rolled out' };
  const progressing = conditionOf(b, 'Progressing');
  if (observed && imageLive && progressing && progressing.status === 'False' && progressing.reason === 'ProgressDeadlineExceeded') {
    return { state: 'fail', cond: 'ProgressDeadlineExceeded' };
  }
  if (!imageLive) return { state: 'pending', cond: 'new image not in the spec yet' };
  if (!observed) return { state: 'pending', cond: 'generation not observed yet' };
  return { state: 'pending', cond: `rollout ${updated}/${want} updated, ${ready} ready` };
}

// evaluateWatch: one check of one watch.
//   targets      from planWatch
//   observations {merge_sha, reads: {target id: {statusCode, body}},
//                 compare: {sha: compare API status}} (missing: not compared)
//   now, mergedAt ISO-8601 or ms; history: the fail_streak from the last check
//   opts         {timeout_min}
// Returns {status, fail_streak, detail: [{id, state, cond}]}. failed needs the
// same failing condition on two checks in a row; timeout is timeout_min after
// the merge.
function evaluateWatch(targets, observations, now, mergedAt, history, opts) {
  const obs = observations || {};
  const reads = obs.reads || {};
  const compare = obs.compare || {};
  const includes = (sha) => {
    if (!sha) return false;
    if (sha === obs.merge_sha) return true;
    const s = compare[sha];
    if (s === undefined || s === null) return null;
    return s === 'identical' || s === 'ahead';
  };
  const detail = (targets || []).map((t) => {
    const read = reads[t.id];
    let r;
    if (t.type === 'kustomization') r = checkKustomization(t, read, includes);
    else if (t.type === 'helmrelease') r = checkHelmRelease(t, read);
    else if (t.type === 'deployment' || t.type === 'statefulset') r = checkWorkload(t, read);
    else r = { state: 'pending', cond: 'unknown target type' };
    return { id: t.id, state: r.state, cond: r.cond };
  });
  const streak = {};
  for (const d of detail) {
    if (d.state !== 'fail') continue;
    const prev = (history || {})[d.id];
    streak[d.id] = { cond: d.cond, count: prev && prev.cond === d.cond ? prev.count + 1 : 1 };
  }
  const timeoutMs = ((opts || {}).timeout_min || 30) * 60000;
  const elapsed = new Date(now).getTime() - new Date(mergedAt).getTime();
  let status = 'pending';
  if (detail.every((d) => d.state === 'ok')) status = 'ok';
  else if (Object.values(streak).some((s) => s.count >= 2)) status = 'failed';
  else if (elapsed >= timeoutMs) status = 'timeout';
  return { status, fail_streak: streak, detail };
}

// Text outside fenced code blocks.
function outsideCode(text) {
  const out = [];
  let fence = null;
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (m) {
      if (!fence) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      continue;
    }
    if (!fence) out.push(line);
  }
  return out.join('\n');
}

// fixForward: whether a revert would do more harm than the failure.
//   pr        the PR {body, user: {login}}; reviews, comments: API items
//   files     as for planWatch
//   identities {app_login, bot_login, owner_login}: who may write the marker
// Returns {fix_forward, source}. The marker is a line `rollback: fix-forward`
// outside code and quotes, written by one of those identities.
function fixForward(pr, reviews, comments, files, identities, config) {
  const allowed = new Set(Object.values(identities || {}).filter((l) => typeof l === 'string' && l).map((l) => l.toLowerCase()));
  const by = (x) => !!(x && x.user && typeof x.user.login === 'string' && allowed.has(x.user.login.toLowerCase()));
  const marked = (x) => by(x) && FIX_FORWARD_MARKER.test(outsideCode(x.body));
  if (marked(pr)) return { fix_forward: true, source: 'marker in the PR description' };
  if ((reviews || []).some(marked)) return { fix_forward: true, source: 'marker in a review' };
  if ((comments || []).some(marked)) return { fix_forward: true, source: 'marker in a comment' };

  const packages = (config && config.fix_forward_packages) || [];
  const imageOf = (line) => {
    const kv = keyValue(line);
    return kv && kv.key === 'image' ? parseImageRef(kv.value) : null;
  };
  const repoIn = (lines) => lines.map(keyValue).filter((kv) => kv && kv.key === 'repository').map((kv) => kv.value).find((v) => packages.includes(v));
  let pvcs = 0;
  for (const f of files || []) {
    // Only manifests count: not docs, code, or YAML kept as test data.
    if (!MANIFEST_FILE.test(String(f.filename)) || /(^|\/)(fixtures|testdata)\//.test(String(f.filename))) continue;
    for (const pair of parsePatch(f.patch)) {
      for (const [side, sign] of [[pair.old, -1], [pair.new, 1]]) {
        if (side !== null && /^\s*kind:\s*PersistentVolumeClaim\s*$/.test(side)) pvcs -= sign;
      }
      if (pair.old === pair.new) continue;
      // A changed image line for a listed package, on either side.
      for (const side of [pair.old, pair.new]) {
        const im = imageOf(side);
        if (im && packages.includes(im.depName)) return { fix_forward: true, source: `fix-forward package ${im.depName}` };
      }
      // A chart's image as repository: <package> with its tag changed, or the
      // repository line itself changed.
      const kvOld = keyValue(pair.old);
      const kvNew = keyValue(pair.new);
      const repoLine = [kvOld, kvNew].find((kv) => kv && kv.key === 'repository' && packages.includes(kv.value));
      if (repoLine) return { fix_forward: true, source: `fix-forward package ${repoLine.value}` };
      if (kvOld && kvNew && kvOld.key === 'tag' && kvNew.key === 'tag' && kvOld.value !== kvNew.value) {
        const pkg = repoIn(pair.context);
        if (pkg) return { fix_forward: true, source: `fix-forward package ${pkg}` };
      }
      const a = imageOf(pair.old);
      const b = imageOf(pair.new);
      const va = a ? parseVersion(a.tag) : null;
      const vb = b ? parseVersion(b.tag) : null;
      if (a && b && a.depName === 'postgres' && b.depName === 'postgres' && va && vb && va.nums[0] !== vb.nums[0]) {
        return { fix_forward: true, source: 'Postgres major change' };
      }
      if (kvNew && kvNew.key === 'version' && kvOld && kvOld.key === 'version' && kvOld.value !== kvNew.value && /depName=k3s-io\/k3s\b/.test(pair.context.join('\n'))) {
        return { fix_forward: true, source: 'k3s Plan version change' };
      }
    }
    if (f.status === 'removed' && typeof f.patch !== 'string' && /pvc/i.test(String(f.filename))) pvcs++;
    if (typeof f.content === 'string' && f.status !== 'removed') {
      const p = typeof f.patch === 'string' ? patchLines(f.patch) : null;
      // The version line itself must change, not just something in the object.
      const versionChanged = (no) => !p || (no !== undefined && p.touched.has(no));
      for (const d of manifestDocs(f.content)) {
        if (d.kind === 'HelmRelease' && d.chart && packages.includes(d.chart) && versionChanged(d.version_line)) {
          return { fix_forward: true, source: `fix-forward package ${d.chart}` };
        }
        if (d.kind === 'HelmRelease' && d.chart === 'longhorn' && versionChanged(d.version_line)) return { fix_forward: true, source: 'Longhorn chart change' };
        if (d.kind === 'Plan' && /^upgrade\.cattle\.io\//.test(String(d.apiVersion)) && versionChanged(d.plan_version_line)) {
          return { fix_forward: true, source: 'k3s Plan version change' };
        }
      }
    }
  }
  if (pvcs > 0) return { fix_forward: true, source: 'a PersistentVolumeClaim is deleted' };
  return { fix_forward: false, source: null };
}

// Base64 to text (UTF-8), for the contents API. Code nodes have no Buffer
// guarantee, and rules.js loads nothing.
function decodeBase64Utf8(b64) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = String(b64 || '').replace(/[^A-Za-z0-9+/]/g, '');
  const bytes = [];
  for (let i = 0; i + 1 < clean.length; i += 4) {
    const n = [0, 1, 2, 3].map((k) => (i + k < clean.length ? alphabet.indexOf(clean[i + k]) : -1));
    bytes.push((n[0] << 2) | (n[1] >> 4));
    if (n[2] >= 0) bytes.push(((n[1] & 15) << 4) | (n[2] >> 2));
    if (n[3] >= 0) bytes.push(((n[2] & 3) << 6) | n[3]);
  }
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.slice(i, i + 8192));
  try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
}

function watchMarker(sha, status) {
  return `<!-- pr-triage-watch:v1 sha=${sha} status=${status} -->`;
}

// The failure comment: the marker, then fixed templates only.
function renderWatchComment(watch, config) {
  const failing = (watch.detail || []).filter((d) => d.state !== 'ok');
  const lines = [
    `### Post-merge check: \`${watch.status}\``,
    '',
    watch.status === 'timeout'
      ? `Merge commit \`${watch.merge_sha.slice(0, 12)}\` had not rolled out ${config.watch_timeout_min} minutes after the merge.`
      : `Merge commit \`${watch.merge_sha.slice(0, 12)}\` failed to roll out.`,
  ];
  if (failing.length) lines.push('', '**Not rolled out**', ...failing.map((d) => `- \`${d.id}\`: ${d.cond}`));
  lines.push('', watch.fix_forward
    ? `**Fix forward — no revert.** Source: ${watch.fix_forward_source}.`
    : 'This merge was not made by an automated merger, so nothing reverts it automatically.');
  lines.push('', '<sub>Written by the PR triage post-merge watcher for this merge commit only. Nothing here reverts anything.</sub>');
  return `${watchMarker(watch.merge_sha, watch.status)}\n${withoutHashRefs(lines.join('\n'))}`;
}

// planWatchPublish: the writes for one finished watch.
//   watch  {repo, pr, merge_sha, status, fix_forward, fix_forward_source, detail}
//   reads  {pr_labels: pages, comments: pages, repo_labels: [name] | null}
//   ctx    {config, patterns, mode: off | labels}
// Returns {action: publish | skip, outcome, actions, mode}. One comment per merge
// SHA, only on failed or timeout; labels are only ever added.
function planWatchPublish(watch, reads, ctx) {
  const config = ctx.config;
  const w = watch || {};
  const plan = { mode: ctx.mode, action: 'skip', outcome: null, reason: null, labels: [], comment: false, actions: [] };
  const skip = (reason) => Object.assign(plan, { reason, outcome: reason === 'up-to-date' ? reason : `skipped-${reason}` });
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(w.repo)) || !Number.isInteger(w.pr) || !SHA_RE.test(String(w.merge_sha)) || !['ok', 'failed', 'timeout'].includes(w.status)) return skip('bad-input');
  const patterns = compilePatterns(ctx.patterns);
  if (patterns.list.length === 0 || patterns.invalid > 0) return skip('unhealthy');
  const labels = pagedItems((reads || {}).pr_labels);
  if (!labels) return skip('labels-incomplete');
  const on = labels.map((l) => l && l.name);
  const repoLabels = (reads || {}).repo_labels || [];
  const want = w.status === 'ok' ? [WATCH_LABELS.ok] : [WATCH_LABELS.failed].concat(w.fix_forward ? [config.verdict_labels['deep-review']] : []);
  plan.labels = want;
  const actions = [];
  for (const name of want) {
    if (on.includes(name)) continue;
    const watchLabel = Object.prototype.hasOwnProperty.call(WATCH_LABEL_STYLES, name);
    if (!repoLabels.includes(name)) actions.push(Object.assign({ type: watchLabel ? 'watch_ensure_label' : 'ensure_label', name }, watchLabel ? WATCH_LABEL_STYLES[name] : LABEL_STYLES[name]));
    actions.push({ type: watchLabel ? 'watch_add_label' : 'add_label', name });
  }
  if (w.status !== 'ok') {
    const comments = pagedItems((reads || {}).comments);
    if (!comments) return skip('comments-incomplete');
    const appLogin = appLoginOf(config);
    const posted = comments.some((c) => isAppComment(c, appLogin) && (String(c.body || '').match(WATCH_MARKER_RE) || [])[1] === w.merge_sha);
    if (!posted) {
      const body = renderWatchComment(w, config);
      // A redaction hit drops the comment; the labels are fixed strings.
      if (countMatches(body, patterns.list)) plan.redaction_hit = true;
      else { actions.push({ type: 'create_comment', body }); plan.comment = true; }
    }
  }
  if (!actions.length) return skip('up-to-date');
  return Object.assign(plan, { action: 'publish', outcome: ctx.mode === 'labels' ? 'publishing' : 'planned-only', actions });
}

const RULES_EXPORTS = {
  RESULTS, VERDICTS, WRITE_MODES, CHECK_IDS,
  parseConfigYaml, loadConfig, reposFromConfigLine, assertReposMatch, parseVersion, compareVersions, satisfies, classifyUpdate,
  parseRenovateTable, extractReleaseNotes, parseImageRef, imageKey, parsePatch, extractChanges,
  pathClass, sha256Hex, parseDashboard, findChartEntry, parseAuthChallenge, amd64InIndex, bodyText, bodyJson,
  fetchClusterVersion, fetchChartIndex, fetchImage, gatherExternalFacts,
  finalize, evaluate, verdictFor, triagePR, newCaches, negativeControl, selectPRs, compilePatterns, carryForward,
  SEVERITY, STATUS_STATES, LABEL_STYLES, PUBLISH_SKIPS, RUN_PUBLISH, ACTION_TYPES, OUTCOME_LABELS, RATE_LIMIT_URL,
  publishMarker, parseMarker, managedLabels, renderTriageComment, pagedItems, isAppComment, appLoginOf,
  triageComments, findOverride, headSince, planPublish,
  watchStaleFromConfigLine, WATCH_STATUSES, WATCH_LABELS, WATCH_LABEL_STYLES, WATCH_ACTION_TYPES, CLUSTER_PATHS,
  clusterPath, allowedClusterPath, patchLines, manifestDocs, kustomizationFor, planWatch, watchReads, revisionSha,
  evaluateWatch, outsideCode, fixForward, decodeBase64Utf8, watchMarker, renderWatchComment, planWatchPublish,
};

if (typeof module !== 'undefined' && module.exports && typeof $input === 'undefined') {
  module.exports = RULES_EXPORTS;
}
