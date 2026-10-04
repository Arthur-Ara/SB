-- Candidatures v1.5.1 : à l'acceptation, plusieurs rôles, un message privé libre (lien d'un Discord…) et, en option,
-- une invitation à usage unique vers un autre serveur où se trouve le bot, générée pour le candidat accepté.

ALTER TABLE cand_categories
  ADD COLUMN accept_role_ids        JSON            NULL AFTER accept_role_id,
  ADD COLUMN accept_message         TEXT            NULL AFTER accept_role_ids,
  ADD COLUMN accept_invite_guild_id BIGINT UNSIGNED NULL AFTER accept_message,
  ADD COLUMN accept_invite_hours    INT UNSIGNED    NULL AFTER accept_invite_guild_id;

UPDATE cand_categories SET accept_role_ids = JSON_ARRAY(CAST(accept_role_id AS CHAR)) WHERE accept_role_id IS NOT NULL;
