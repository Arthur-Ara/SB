-- Activation des modules par serveur (commande /modules).
-- Absence de ligne = valeur par défaut du module (defaultEnabled).
CREATE TABLE IF NOT EXISTS guild_modules (
  guild_id   BIGINT UNSIGNED NOT NULL,
  module     VARCHAR(64)     NOT NULL,
  enabled    TINYINT(1)      NOT NULL,
  updated_by BIGINT UNSIGNED NULL,
  updated_at DATETIME(3)     NOT NULL,
  PRIMARY KEY (guild_id, module)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
