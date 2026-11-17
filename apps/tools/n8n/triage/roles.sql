-- Run by the triage-schema initContainer after schema.sql and seed.sql.
-- The workflows' postgres credential logs in as `triage`, which can use only
-- the triage schema and only what the workflows need. n8n's own tables stay
-- with the n8n superuser. Re-running resets the role and its grants exactly.
--
-- TRIAGE_DB_PASSWORD comes from the Secret as env (derived in the
-- ExternalSecret from db-password).

\getenv triage_password TRIAGE_DB_PASSWORD

SELECT coalesce(length(:'triage_password'), 0) >= 32 AS password_ok \gset
\if :password_ok
\else
  DO $$ BEGIN RAISE EXCEPTION 'TRIAGE_DB_PASSWORD is missing or too short'; END $$;
\endif

SELECT 'CREATE ROLE triage' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'triage') \gexec

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
-- The heartbeat upserts one row.
GRANT SELECT, INSERT, UPDATE ON triage.heartbeat TO triage;
GRANT USAGE ON SEQUENCE triage.runs_id_seq, triage.verdicts_id_seq TO triage;

COMMIT;

SELECT 'triage role ready' AS status;
