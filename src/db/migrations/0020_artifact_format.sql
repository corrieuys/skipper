-- Artifact body format: 'html' | 'markdown'. Nullable — legacy rows created
-- before this column resolve their render mode via the looksLikeHtml heuristic.
-- New artifacts store an explicit format; html bodies are structurally validated
-- at create time (see orchestrator/html-validator.ts). Enum is enforced in the
-- app layer (ArtifactManager), not a CHECK, to stay aligned with the ADD COLUMN.
ALTER TABLE task_artifacts ADD COLUMN format TEXT;
