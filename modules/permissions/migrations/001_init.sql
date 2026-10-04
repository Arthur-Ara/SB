-- ════════════════════════════════════════════════════════════════════════
-- Module Permissions — exceptions d'accès aux slash commands, par serveur
-- ════════════════════════════════════════════════════════════════════════

-- Règles individuelles (priorité la plus forte)
CREATE TABLE IF NOT EXISTS permissions_users (
  guild_id       BIGINT UNSIGNED NOT NULL,
  user_id        BIGINT UNSIGNED NOT NULL,
  command_name   VARCHAR(32)     NOT NULL,
  has_permission TINYINT(1)      NOT NULL,
  updated_by     BIGINT UNSIGNED NULL,
  updated_at     DATETIME(3)     NOT NULL,
  PRIMARY KEY (guild_id, user_id, command_name),
  KEY idx_pu_guild_command (guild_id, command_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Règles par rôle
CREATE TABLE IF NOT EXISTS permissions_roles (
  guild_id       BIGINT UNSIGNED NOT NULL,
  role_id        BIGINT UNSIGNED NOT NULL,
  command_name   VARCHAR(32)     NOT NULL,
  has_permission TINYINT(1)      NOT NULL,
  updated_by     BIGINT UNSIGNED NULL,
  updated_at     DATETIME(3)     NOT NULL,
  PRIMARY KEY (guild_id, role_id, command_name),
  KEY idx_pr_guild_command (guild_id, command_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Commandes rendues publiques sur un serveur
CREATE TABLE IF NOT EXISTS permissions_public (
  guild_id     BIGINT UNSIGNED NOT NULL,
  command_name VARCHAR(32)     NOT NULL,
  is_public    TINYINT(1)      NOT NULL,
  updated_by   BIGINT UNSIGNED NULL,
  updated_at   DATETIME(3)     NOT NULL,
  PRIMARY KEY (guild_id, command_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
