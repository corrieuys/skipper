-- Per-agent chosen identity for custom agents: a color (hex) that tints the
-- active-agent orb + this agent's timeline output, and a creature character id
-- shown in the orb instead of the spinning cube. Team + single agents store the
-- same two fields in their existing JSON blobs (no column needed); custom_agents
-- has no catch-all blob, so they are first-class columns here.
-- On a fresh DB the CREATE in schema.runtime.sql already adds these, so this ALTER
-- hits "duplicate column name" and is marked applied (handled in connection.ts).
ALTER TABLE custom_agents ADD COLUMN color TEXT;
ALTER TABLE custom_agents ADD COLUMN character TEXT;
