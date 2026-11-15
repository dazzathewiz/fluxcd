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
  list_etags       jsonb NOT NULL DEFAULT '{}'::jsonb
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
  UNIQUE (repo, pr, head_sha)
);

CREATE INDEX IF NOT EXISTS verdicts_created_idx ON triage.verdicts (created DESC);

-- Reseeded from the n8n-secrets Secret on every pod start.
CREATE TABLE IF NOT EXISTS triage.redaction_patterns (
  pattern text PRIMARY KEY
);

-- config.yaml, reloaded on every pod start. Workflows read it from here.
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
