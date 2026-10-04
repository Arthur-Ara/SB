-- Support automatique v1.3.0 : accès restreint par rôles, mesure de l'efficacité des réponses.

-- Rôles autorisés à voir un nœud (catégorie ou réponse) et tout ce qu'il contient ; NULL ou [] = tout le monde.
ALTER TABLE support_nodes
  ADD COLUMN allowed_role_ids JSON NULL;

-- Avis « Ça m'a aidé / Pas résolu » laissé sous une réponse (un seul par membre et par réponse, modifiable).
CREATE TABLE IF NOT EXISTS support_feedback (
  node_id    BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  guild_id   BIGINT UNSIGNED NOT NULL,
  helpful    TINYINT(1)      NOT NULL,
  updated_at DATETIME(3)     NOT NULL,
  PRIMARY KEY (node_id, user_id),
  KEY idx_support_feedback_guild (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Compteurs par nœud : affichages et tickets ouverts depuis cette réponse.
CREATE TABLE IF NOT EXISTS support_node_stats (
  node_id  BIGINT UNSIGNED NOT NULL,
  guild_id BIGINT UNSIGNED NOT NULL,
  views    INT UNSIGNED    NOT NULL DEFAULT 0,
  tickets  INT UNSIGNED    NOT NULL DEFAULT 0,
  PRIMARY KEY (node_id),
  KEY idx_support_stats_guild (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
