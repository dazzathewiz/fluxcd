-- Run by the triage-schema initContainer after schema.sql.
-- REDACTION_PATTERNS comes from the Secret as env: one pattern per line,
-- blank lines and lines starting with # ignored.

\getenv patterns REDACTION_PATTERNS
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

COMMIT;

SELECT count(*) AS redaction_patterns FROM triage.redaction_patterns;
SELECT name, sha256 FROM triage.config ORDER BY name;
