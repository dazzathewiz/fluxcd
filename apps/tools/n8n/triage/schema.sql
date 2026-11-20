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
  ruleset          text,
  -- The publish outcome: planned-only (write_mode off), skipped-unhealthy,
  -- no-op, published, redaction-hit or failed.
  publish          text
);

CREATE TABLE IF NOT EXISTS triage.verdicts (
  id       bigserial PRIMARY KEY,
  run_id   bigint REFERENCES triage.runs (id) ON DELETE SET NULL,
  repo     text NOT NULL,
  pr       integer NOT NULL,
  head_sha text NOT NULL,
  verdict  text NOT NULL,
  reasons  jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- NULL on a carried row: see carried_from.
  checks   jsonb,
  created  timestamptz NOT NULL DEFAULT now(),
  -- r<sha256(rules.js)[:12]>.c<sha256(config.yaml)[:12]>: the rules and config
  -- that produced this verdict. A new ruleset re-triages open PRs.
  ruleset  text,
  -- Set by hand (or, later, by a write mode) to stop re-triage of this head SHA.
  -- A human verdict is inserted with it set.
  finalised_at timestamptz,
  -- A new ruleset gave the same verdict and check results as this full row, so
  -- this row stores no checks.
  carried_from bigint REFERENCES triage.verdicts (id)
);

-- Migration for tables created before rulesets: one verdict per ruleset.
ALTER TABLE triage.runs ADD COLUMN IF NOT EXISTS ruleset text;
ALTER TABLE triage.verdicts ADD COLUMN IF NOT EXISTS ruleset text;
ALTER TABLE triage.verdicts ADD COLUMN IF NOT EXISTS finalised_at timestamptz;
ALTER TABLE triage.verdicts DROP CONSTRAINT IF EXISTS verdicts_repo_pr_head_sha_key;
CREATE UNIQUE INDEX IF NOT EXISTS verdicts_repo_pr_sha_ruleset_key
  ON triage.verdicts (repo, pr, head_sha, ruleset);

-- Migration for carried verdicts and the human verdict. The constraints are
-- dropped and re-added by name, so a fresh table and an old one end up alike.
ALTER TABLE triage.verdicts ADD COLUMN IF NOT EXISTS carried_from bigint REFERENCES triage.verdicts (id);
ALTER TABLE triage.verdicts ALTER COLUMN checks DROP NOT NULL;
-- needs-claude is now deep-review. The CHECK is dropped, the rows and any
-- reason naming the old level move, and the CHECK comes back without the old
-- value. A second run matches no rows. There is no way back: an older CHECK
-- would reject the moved rows.
ALTER TABLE triage.verdicts DROP CONSTRAINT IF EXISTS verdicts_verdict_check;
UPDATE triage.verdicts SET verdict = 'deep-review' WHERE verdict = 'needs-claude';
UPDATE triage.verdicts
SET reasons = (SELECT jsonb_agg(replace(replace(r, 'package needs Claude: ', 'deep-review package: '), 'needs-claude', 'deep-review') ORDER BY n)
               FROM jsonb_array_elements_text(reasons) WITH ORDINALITY AS e (r, n))
WHERE jsonb_typeof(reasons) = 'array' AND jsonb_array_length(reasons) > 0
  AND reasons::text ~ '(needs-claude|needs Claude)';
ALTER TABLE triage.verdicts ADD CONSTRAINT verdicts_verdict_check
  CHECK (verdict IN ('blocked', 'deep-review', 'review', 'low-risk', 'human'));
-- A row has its own checks or names the full row that has them, never both.
ALTER TABLE triage.verdicts DROP CONSTRAINT IF EXISTS verdicts_checks_or_carried;
ALTER TABLE triage.verdicts ADD CONSTRAINT verdicts_checks_or_carried
  CHECK ((checks IS NULL) <> (carried_from IS NULL));

CREATE INDEX IF NOT EXISTS verdicts_created_idx ON triage.verdicts (created DESC);

-- Reseeded from the n8n-secrets Secret on every pod start.
CREATE TABLE IF NOT EXISTS triage.redaction_patterns (
  pattern text PRIMARY KEY
);

-- config.yaml and rules.js, reloaded on every pod start. Workflows read the
-- config from here; the two sha256 values make up the ruleset. The GitHub App's
-- ID and installation ID are loaded here too (seed.sql); they are identifiers,
-- not secrets, and are not part of the ruleset.
CREATE TABLE IF NOT EXISTS triage.config (
  name   text PRIMARY KEY,
  body   text NOT NULL,
  sha256 text NOT NULL,
  loaded timestamptz NOT NULL DEFAULT now()
);

-- write_mode labels: what the GitHub App published, or would publish, on one
-- head SHA. The published columns (verdict to published_at) change only after
-- every planned write read back as sent. planned and outcome are the latest plan,
-- written on every run that read the PR, in every write_mode.
CREATE TABLE IF NOT EXISTS triage.publications (
  repo           text NOT NULL,
  pr             integer NOT NULL,
  head_sha       text NOT NULL,
  verdict        text,
  ruleset        text,
  -- The verdict label the App left applied (NULL under a human override).
  label          text,
  comment_id     bigint,
  status_state   text,
  published_at   timestamptz,
  -- A triage or outcome label added or removed by anyone but the App on this
  -- head SHA. Labels are then left alone until the next head SHA.
  human_override boolean NOT NULL DEFAULT false,
  override_actor text,
  override_label text,
  -- The actions planPublish returned, and when.
  planned        jsonb,
  planned_at     timestamptz,
  run_id         bigint REFERENCES triage.runs (id) ON DELETE SET NULL,
  -- planned-only, publishing, published, failed, redaction-hit, up-to-date or
  -- skipped-<reason>.
  outcome        text,
  PRIMARY KEY (repo, pr, head_sha)
);
ALTER TABLE triage.runs ADD COLUMN IF NOT EXISTS publish text;
ALTER TABLE triage.publications DROP CONSTRAINT IF EXISTS publications_verdict_check;
ALTER TABLE triage.publications ADD CONSTRAINT publications_verdict_check
  CHECK (verdict IN ('blocked', 'deep-review', 'review', 'low-risk', 'human'));
CREATE INDEX IF NOT EXISTS publications_run_idx ON triage.publications (run_id);

-- Written by the triage-heartbeat workflow.
CREATE TABLE IF NOT EXISTS triage.heartbeat (
  name         text PRIMARY KEY,
  last_success timestamptz,
  checked      timestamptz NOT NULL
);
-- The heartbeat's last ping to Home Assistant: when, and the HTTP status (NULL
-- on a network error).
ALTER TABLE triage.heartbeat ADD COLUMN IF NOT EXISTS last_ping timestamptz, ADD COLUMN IF NOT EXISTS ping_status integer;

-- The Home Assistant webhook URL, reseeded from the Secret on every pod start.
-- Only the TriageAlertV01 sub-workflow reads it.
CREATE TABLE IF NOT EXISTS triage.alert_target (
  name text PRIMARY KEY,
  url  text NOT NULL
);
