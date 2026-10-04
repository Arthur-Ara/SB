-- Accès granulaire au panel web par rôle, catégorie (généralement un module) et droit précis
-- (/permission grant-panel). Purement additif : tant qu'aucune ligne n'existe pour une catégorie
-- donnée sur un serveur, tout utilisateur autorisé du dashboard (AUTHORIZED_WEB_USERS) y garde un
-- accès complet — le comportement actuel n'est jamais cassé par cette table.
CREATE TABLE IF NOT EXISTS web_permission_grants (
  guild_id   BIGINT UNSIGNED NOT NULL,
  role_id    BIGINT UNSIGNED NOT NULL,
  category   VARCHAR(32)     NOT NULL,
  right_key  VARCHAR(32)     NOT NULL DEFAULT '', -- '' = tous les droits de la catégorie
  granted_by BIGINT UNSIGNED NULL,
  granted_at DATETIME(3)     NOT NULL,
  PRIMARY KEY (guild_id, role_id, category, right_key),
  KEY idx_wpg_guild_category (guild_id, category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
