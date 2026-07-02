-- The connect instance id (gid) is now derived from the connect key's JWT
-- payload; the separately stored guid setting is obsolete. Remove the row.
DELETE FROM app_settings WHERE key = 'skipper_connect_global_id_guid';
