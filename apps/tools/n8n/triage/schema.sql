-- PR triage schema. Applied on every pod start by the triage-schema
-- initContainer, so every statement must be idempotent.

CREATE SCHEMA IF NOT EXISTS triage;

CREATE TABLE IF NOT EXISTS triage.runs (
  id               bigserial PRIMARY KEY,
  started          timestamptz NOT NULL DEFAULT now(),
  finished         timestamptz,
  pr_count         integer,
  -- Must be 'fail' on every run; anything else marks the run broken.
  negative_control text,
  ok               boolean,
  -- Per-repo ETag of the open-PR list, for conditional requests.
  list_etags       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The ruleset this run triaged with (see the verdicts table).
  ruleset          text
);

CREATE TABLE IF NOT EXISTS triage.verdicts (
  id       bigserial PRIMARY KEY,
  run_id   bigint REFERENCES triage.runs (id) ON DELETE SET NULL,
  repo     text NOT NULL,
  pr       integer NOT NULL,
  head_sha text NOT NULL,
  verdict  text NOT NULL CHECK (verdict IN ('blocked', 'needs-claude', 'review', 'low-risk')),
  reasons  jsonb NOT NULL DEFAULT '[]'::jsonb,
  checks   jsonb NOT NULL,
  created  timestamptz NOT NULL DEFAULT now(),
  -- r<sha256(rules.js)[:12]>.c<sha256(config.yaml)[:12]>: the rules and config
  -- that produced this verdict. A new ruleset re-triages open PRs.
  ruleset  text,
  -- Set by hand (or, later, by a write mode) to stop re-triage of this head SHA.
  finalised_at timestamptz
);

-- Migration for tables created before rulesets: one verdict per ruleset.
ALTER TABLE triage.runs ADD COLUMN IF NOT EXISTS ruleset text;
ALTER TABLE triage.verdicts ADD COLUMN IF NOT EXISTS ruleset text;
ALTER TABLE triage.verdicts ADD COLUMN IF NOT EXISTS finalised_at timestamptz;
ALTER TABLE triage.verdicts DROP CONSTRAINT IF EXISTS verdicts_repo_pr_head_sha_key;
CREATE UNIQUE INDEX IF NOT EXISTS verdicts_repo_pr_sha_ruleset_key
  ON triage.verdicts (repo, pr, head_sha, ruleset);

CREATE INDEX IF NOT EXISTS verdicts_created_idx ON triage.verdicts (created DESC);

-- Reseeded from the n8n-secrets Secret on every pod start.
CREATE TABLE IF NOT EXISTS triage.redaction_patterns (
  pattern text PRIMARY KEY
);

-- config.yaml and rules.js, reloaded on every pod start. Workflows read the
-- config from here; the two sha256 values make up the ruleset.
CREATE TABLE IF NOT EXISTS triage.config (
  name   text PRIMARY KEY,
  body   text NOT NULL,
  sha256 text NOT NULL,
  loaded timestamptz NOT NULL DEFAULT now()
);

-- Written by the triage-heartbeat workflow.
CREATE TABLE IF NOT EXISTS triage.heartbeat (
  name         text PRIMARY KEY,
  last_success timestamptz,
  checked      timestamptz NOT NULL
);
