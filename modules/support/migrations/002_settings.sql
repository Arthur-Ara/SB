-- Réglages du module (salon de journal, pour les logs « système » des modifications de config —
-- panels, catégories, réponses — voir web/routes.js).
CREATE TABLE IF NOT EXISTS support_settings (
  guild_id       BIGINT UNSIGNED NOT NULL,
  log_channel_id BIGINT UNSIGNED NULL,
  updated_at     DATETIME(3)     NOT NULL,
  PRIMARY KEY (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
