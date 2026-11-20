-- Run by the triage-schema initContainer after schema.sql.
-- REDACTION_PATTERNS comes from the Secret as env: one pattern per line,
-- blank lines and lines starting with # ignored. GITHUB_APP_ID and
-- GITHUB_APP_INSTALLATION_ID come from the same Secret; a missing one removes
-- its row, and write_mode labels then publishes nothing. HA_HEARTBEAT_URL
-- (same Secret) becomes the one triage.alert_target row; missing, there is none.

\getenv patterns REDACTION_PATTERNS
\getenv app_id GITHUB_APP_ID
\getenv installation_id GITHUB_APP_INSTALLATION_ID
\getenv ha_url HA_HEARTBEAT_URL
-- An unset variable would reach the SQL as literal text.
\if :{?app_id}
\else
  \set app_id ''
\endif
\if :{?installation_id}
\else
  \set installation_id ''
\endif
\if :{?ha_url}
\else
  \set ha_url ''
\endif
\set config `cat /triage/config.yaml`
\set rules `cat /triage/rules.js`

BEGIN;

DELETE FROM triage.redaction_patterns;

INSERT INTO triage.redaction_patterns (pattern)
SELECT DISTINCT btrim(p)
FROM regexp_split_to_table(coalesce(:'patterns', ''), E'\r?\n') AS p
WHERE btrim(p) <> '' AND btrim(p) NOT LIKE '#%';

INSERT INTO triage.config (name, body, sha256, loaded)
VALUES ('config.yaml', :'config', encode(sha256(convert_to(:'config', 'UTF8')), 'hex'), now())
ON CONFLICT (name) DO UPDATE
  SET body = excluded.body, sha256 = excluded.sha256, loaded = excluded.loaded;

-- The Triage Code node carries rules.js verbatim (sync-code-nodes.js), so this
-- hash identifies the rules that produce each verdict.
INSERT INTO triage.config (name, body, sha256, loaded)
VALUES ('rules.js', :'rules', encode(sha256(convert_to(:'rules', 'UTF8')), 'hex'), now())
ON CONFLICT (name) DO UPDATE
  SET body = excluded.body, sha256 = excluded.sha256, loaded = excluded.loaded;

-- The GitHub App's identifiers, digits only. Not secrets and not in the ruleset.
DELETE FROM triage.config WHERE name IN ('github-app-id', 'github-app-installation-id');
INSERT INTO triage.config (name, body, sha256, loaded)
SELECT v.name, btrim(v.body), encode(sha256(convert_to(btrim(v.body), 'UTF8')), 'hex'), now()
FROM (VALUES ('github-app-id', :'app_id'),
             ('github-app-installation-id', :'installation_id')) AS v (name, body)
WHERE btrim(v.body) ~ '^[0-9]+$';

-- The heartbeat webhook. Never printed.
DELETE FROM triage.alert_target;
INSERT INTO triage.alert_target (name, url)
SELECT 'home-assistant', btrim(:'ha_url')
WHERE btrim(:'ha_url') ~ '^https?://[^/[:space:]]+/[^[:space:]]+$';

COMMIT;

SELECT count(*) AS redaction_patterns FROM triage.redaction_patterns;
SELECT count(*) AS alert_targets FROM triage.alert_target;
SELECT name, CASE WHEN name LIKE 'github-app-%' THEN 'set' ELSE sha256 END AS sha256 FROM triage.config ORDER BY name;
