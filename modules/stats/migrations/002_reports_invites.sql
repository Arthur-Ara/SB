-- Statistiques v1.3.0 : réglages par serveur, rapports hebdomadaires et suivi des invitations.
-- Tout est désactivé par défaut (réglable depuis le panel, onglet Rapports).

CREATE TABLE IF NOT EXISTS stats_guild_settings (
  guild_id          BIGINT UNSIGNED  NOT NULL,
  report_enabled    TINYINT(1)       NOT NULL DEFAULT 0,
  report_channel_id BIGINT UNSIGNED  NULL,
  report_weekday    TINYINT UNSIGNED NOT NULL DEFAULT 1,  -- 1 = lundi … 7 = dimanche
  report_hour       TINYINT UNSIGNED NOT NULL DEFAULT 9,  -- heure locale d'envoi (0-23)
  report_timezone   VARCHAR(64)      NOT NULL DEFAULT 'Europe/Paris',
  last_report_at    DATETIME(3)      NULL,
  invite_tracking   TINYINT(1)       NOT NULL DEFAULT 0,
  updated_at        DATETIME(3)      NOT NULL,
  PRIMARY KEY (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rapports générés (automatiquement ou à la demande) : données figées au moment de la génération.
CREATE TABLE IF NOT EXISTS stats_reports (
  id          INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  guild_id    BIGINT UNSIGNED NOT NULL,
  period_from DATETIME(3)     NOT NULL,
  period_to   DATETIME(3)     NOT NULL,
  data        JSON            NOT NULL,
  channel_id  BIGINT UNSIGNED NULL,
  message_id  BIGINT UNSIGNED NULL,
  origin      ENUM('auto','manual') NOT NULL DEFAULT 'auto',
  created_by  BIGINT UNSIGNED NULL,
  created_at  DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_stats_reports_guild (guild_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Invitations connues (créateur, utilisations) : sert à déterminer quelle invitation a servi à chaque arrivée.
CREATE TABLE IF NOT EXISTS stats_invites (
  guild_id   BIGINT UNSIGNED NOT NULL,
  code       VARCHAR(32)     NOT NULL,
  inviter_id BIGINT UNSIGNED NULL,
  channel_id BIGINT UNSIGNED NULL,
  uses       INT UNSIGNED    NOT NULL DEFAULT 0,
  max_uses   INT UNSIGNED    NULL,
  created_at DATETIME(3)     NULL,
  expires_at DATETIME(3)     NULL,
  deleted_at DATETIME(3)     NULL,
  PRIMARY KEY (guild_id, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Arrivées attribuées à une invitation (ou à l'URL personnalisée, ou inconnues).
CREATE TABLE IF NOT EXISTS stats_invite_joins (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  guild_id   BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  code       VARCHAR(32)     NULL,
  inviter_id BIGINT UNSIGNED NULL,
  source     ENUM('invite','vanity','unknown') NOT NULL,
  joined_at  DATETIME(3)     NOT NULL,
  left_at    DATETIME(3)     NULL,
  PRIMARY KEY (id),
  KEY idx_invite_joins_guild (guild_id, joined_at),
  KEY idx_invite_joins_user (guild_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
