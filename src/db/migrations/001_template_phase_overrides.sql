-- Migration: add prompt/review/consensus override columns to task_template_phases
-- Applied via ensureColumn in migrateLegacySchema (idempotent for existing DBs).
-- Fresh installs already have these columns from the CREATE TABLE in schema.sql.
ALTER TABLE task_template_phases ADD COLUMN override_prompt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_template_phases ADD COLUMN review_override TEXT DEFAULT NULL;
ALTER TABLE task_template_phases ADD COLUMN consensus_override TEXT DEFAULT NULL;
