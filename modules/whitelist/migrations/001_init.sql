-- ════════════════════════════════════════════════════════════════════════
-- Module Whitelist Vocal — accès restreint et limite de places par salon
-- ════════════════════════════════════════════════════════════════════════

-- Réglages par serveur (salon de journal)
CREATE TABLE IF NOT EXISTS whitelist_settings (
  guild_id       BIGINT UNSIGNED NOT NULL,
  log_channel_id BIGINT UNSIGNED NULL,
  updated_at     DATETIME(3)     NOT NULL,
  PRIMARY KEY (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Admins du module : exemptés de la whitelist et de la limite de slots, seuls autorisés à configurer
CREATE TABLE IF NOT EXISTS whitelist_admins (
  guild_id   BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  added_by   BIGINT UNSIGNED NULL,
  added_at   DATETIME(3)     NOT NULL,
  PRIMARY KEY (guild_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Configuration par salon vocal (chaque salon a sa propre config, absence de ligne = non configuré)
CREATE TABLE IF NOT EXISTS whitelist_channels (
  guild_id   BIGINT UNSIGNED NOT NULL,
  channel_id BIGINT UNSIGNED NOT NULL,
  enabled    TINYINT(1)      NOT NULL DEFAULT 0,
  slot_limit INT UNSIGNED    NULL,
  updated_by BIGINT UNSIGNED NULL,
  updated_at DATETIME(3)     NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Membres whitelistés par salon
CREATE TABLE IF NOT EXISTS whitelist_channel_users (
  guild_id   BIGINT UNSIGNED NOT NULL,
  channel_id BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  added_by   BIGINT UNSIGNED NULL,
  added_at   DATETIME(3)     NOT NULL,
  PRIMARY KEY (guild_id, channel_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rôles whitelistés par salon (un membre ayant l'un de ces rôles peut rejoindre)
CREATE TABLE IF NOT EXISTS whitelist_channel_roles (
  guild_id   BIGINT UNSIGNED NOT NULL,
  channel_id BIGINT UNSIGNED NOT NULL,
  role_id    BIGINT UNSIGNED NOT NULL,
  added_by   BIGINT UNSIGNED NULL,
  added_at   DATETIME(3)     NOT NULL,
  PRIMARY KEY (guild_id, channel_id, role_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
