-- Operator message body format: 'text' | 'markdown' | 'html'. Nullable — legacy
-- rows and the common case are plain text (NULL is treated as 'text' at render
-- time). Agents pick the format via post_message; 'text' is the preferred,
-- default choice. Enum enforced in the app layer (MessageManager).
ALTER TABLE task_messages ADD COLUMN format TEXT;
