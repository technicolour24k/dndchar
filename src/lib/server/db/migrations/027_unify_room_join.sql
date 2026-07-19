ALTER TABLE users ADD COLUMN IF NOT EXISTS active_vtt_session_id text;

UPDATE users u SET active_vtt_session_id = c.active_vtt_session_id
FROM characters c
WHERE c.owner_user_id = u.id AND c.active_vtt_session_id IS NOT NULL;

ALTER TABLE characters DROP COLUMN IF EXISTS active_vtt_session_id;
