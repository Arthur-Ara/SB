-- ════════════════════════════════════════════════════════════════════════
-- Module Laisse — un membre « en laisse » suit son maître de vocal en vocal
-- ════════════════════════════════════════════════════════════════════════

-- Réglages par serveur
CREATE TABLE IF NOT EXISTS leash_settings (
  guild_id       BIGINT UNSIGNED  NOT NULL,
  global_limit   INT UNSIGNED     NOT NULL DEFAULT 3,
  leash_leashers TINYINT(1)       NOT NULL DEFAULT 1,
  log_channel_id BIGINT UNSIGNED  NULL,
  updated_at     DATETIME(3)      NOT NULL,
  PRIMARY KEY (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Statuts individuels : autorisation, limite, immunité, god mode, admin du module (+ qui / quand)
CREATE TABLE IF NOT EXISTS leash_members (
  guild_id    BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  allowed     TINYINT(1)      NOT NULL DEFAULT 0,
  allowed_by  BIGINT UNSIGNED NULL,
  allowed_at  DATETIME(3)     NULL,
  max_leashes INT UNSIGNED    NULL,
  immune      TINYINT(1)      NOT NULL DEFAULT 0,
  immune_by   BIGINT UNSIGNED NULL,
  immune_at   DATETIME(3)     NULL,
  godmode     TINYINT(1)      NOT NULL DEFAULT 0,
  godmode_by  BIGINT UNSIGNED NULL,
  godmode_at  DATETIME(3)     NULL,
  is_admin    TINYINT(1)      NOT NULL DEFAULT 0,
  admin_by    BIGINT UNSIGNED NULL,
  admin_at    DATETIME(3)     NULL,
  PRIMARY KEY (guild_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Laisses : un membre ne peut être que dans une seule liste (clé primaire sur leashed_id)
CREATE TABLE IF NOT EXISTS leash_links (
  guild_id   BIGINT UNSIGNED NOT NULL,
  leashed_id BIGINT UNSIGNED NOT NULL,
  leasher_id BIGINT UNSIGNED NOT NULL,
  added_by   BIGINT UNSIGNED NULL,
  created_at DATETIME(3)     NOT NULL,
  PRIMARY KEY (guild_id, leashed_id),
  KEY idx_leash_leasher (guild_id, leasher_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
