-- Run by the triage-schema initContainer after schema.sql and seed.sql.
-- The workflows' postgres credential logs in as `triage`, which can use only
-- the triage schema and only what the workflows need. n8n's own tables stay
-- with the n8n superuser. Re-running resets the role and its grants exactly.
--
-- TRIAGE_DB_PASSWORD comes from the Secret as env (derived in the
-- ExternalSecret from db-password). TRIAGE_RENDER_DB_PASSWORD is the
-- triage-render CronJob's login (1Password field triage-render-db-password).

\getenv triage_password TRIAGE_DB_PASSWORD
\getenv render_password TRIAGE_RENDER_DB_PASSWORD

SELECT coalesce(length(:'triage_password'), 0) >= 32 AS password_ok \gset
\if :password_ok
\else
  DO $$ BEGIN RAISE EXCEPTION 'TRIAGE_DB_PASSWORD is missing or too short'; END $$;
\endif

SELECT coalesce(length(:'render_password'), 0) >= 32 AS render_password_ok \gset
\if :render_password_ok
\else
  DO $$ BEGIN RAISE EXCEPTION 'TRIAGE_RENDER_DB_PASSWORD is missing or too short'; END $$;
\endif

SELECT 'CREATE ROLE triage' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'triage') \gexec
SELECT 'CREATE ROLE triage_render' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'triage_render') \gexec

BEGIN;

ALTER ROLE triage WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
  NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10 PASSWORD :'triage_password';

-- Start from nothing, then grant exactly what the workflows use.
REVOKE ALL ON ALL TABLES IN SCHEMA triage FROM triage;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA triage FROM triage;
REVOKE ALL ON SCHEMA triage FROM triage;

GRANT USAGE ON SCHEMA triage TO triage;
-- Start run inserts a run and reads the last ETags; Finish run updates it.
GRANT SELECT, INSERT, UPDATE ON triage.runs TO triage;
-- Insert verdict (ON CONFLICT DO NOTHING; a human row sets finalised_at in the
-- insert itself), and the seen-SHA and previous-verdict reads. No UPDATE or
-- DELETE: finalising an existing row is a manual step.
GRANT SELECT, INSERT ON triage.verdicts TO triage;
-- Loaded by this initContainer; the workflows only read them.
GRANT SELECT ON triage.config, triage.redaction_patterns TO triage;
-- Record plan upserts a row per open PR; Record publish updates it.
GRANT SELECT, INSERT, UPDATE ON triage.publications TO triage;
-- The heartbeat upserts one row, then records its ping (last_ping, ping_status).
GRANT SELECT, INSERT, UPDATE ON triage.heartbeat TO triage;
-- TriageAlertV01 reads the heartbeat webhook URL.
GRANT SELECT ON triage.alert_target TO triage;
-- R10: the watcher inserts and updates watches, its cursor and its runs.
GRANT SELECT, INSERT, UPDATE ON triage.watches, triage.watch_cursor, triage.watch_runs TO triage;
-- The heartbeat's daily retention step runs as the function's owner; the role
-- itself can't delete. Functions are executable by PUBLIC unless revoked.
REVOKE ALL ON FUNCTION triage.prune_runs() FROM PUBLIC, triage;
GRANT EXECUTE ON FUNCTION triage.prune_runs() TO triage;
-- R11: the poll queues render requests (ON CONFLICT DO NOTHING) and reads the
-- finished renders. The CronJob does the rest.
GRANT SELECT, INSERT ON triage.render_requests TO triage;
GRANT SELECT ON triage.renders TO triage;
GRANT USAGE ON SEQUENCE triage.runs_id_seq, triage.verdicts_id_seq, triage.watches_id_seq, triage.watch_runs_id_seq, triage.render_requests_id_seq TO triage;

-- The triage-render CronJob: claims pending requests (FOR UPDATE needs
-- UPDATE), records the outcome and inserts the two renders. renders has no
-- sequence, and the role inserts no request, so it needs none. No DELETE.
ALTER ROLE triage_render WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
  NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD :'render_password';

REVOKE ALL ON ALL TABLES IN SCHEMA triage FROM triage_render;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA triage FROM triage_render;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA triage FROM triage_render;
REVOKE ALL ON SCHEMA triage FROM triage_render;

GRANT USAGE ON SCHEMA triage TO triage_render;
GRANT SELECT, UPDATE ON triage.render_requests TO triage_render;
GRANT INSERT ON triage.renders TO triage_render;

COMMIT;

SELECT 'triage_render role ready' AS status;
SELECT 'triage role ready' AS status;
