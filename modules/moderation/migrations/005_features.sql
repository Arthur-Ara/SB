-- Modération v1.3.0 : ban temporaire, sanctions automatiques au cumul d'avertissements, automod (mots interdits),
-- notes internes, modification des sanctions, verrouillage temporaire, contestation. Tout est désactivé par défaut.

ALTER TABLE moderation_actions
  MODIFY COLUMN action ENUM('ban','unban','kick','tempmute','unmute','tempvocmute','untempvocmute','warn','removewarn',
                            'shadowban','unshadowban','lock','unlock','lockall','unlockall','clear',
                            'slowmode','purge','blacklist','unblacklist','tempban','untempban','automod') NOT NULL,
  ADD COLUMN edited_at DATETIME(3)     NULL,
  ADD COLUMN edited_by BIGINT UNSIGNED NULL;

-- Verrouillage avec durée : déverrouillage automatique à l'échéance.
ALTER TABLE moderation_channel_locks
  ADD COLUMN unlock_at DATETIME(3) NULL;

-- Contestation (reliée à un type de ticket) et réglages de l'automod.
ALTER TABLE moderation_settings
  ADD COLUMN appeal_enabled             TINYINT(1)        NOT NULL DEFAULT 0,
  ADD COLUMN appeal_ticket_type_id      BIGINT UNSIGNED   NULL,
  ADD COLUMN automod_enabled            TINYINT(1)        NOT NULL DEFAULT 0,
  ADD COLUMN automod_action             ENUM('delete','warn','mute') NOT NULL DEFAULT 'delete',
  ADD COLUMN automod_mute_minutes       INT UNSIGNED      NOT NULL DEFAULT 10,
  ADD COLUMN automod_threshold          TINYINT UNSIGNED  NOT NULL DEFAULT 80, -- similarité minimale, en %
  ADD COLUMN automod_exempt_role_ids    JSON              NULL,
  ADD COLUMN automod_exempt_channel_ids JSON              NULL;

-- Sanction automatique déclenchée quand un membre atteint N avertissements actifs.
CREATE TABLE IF NOT EXISTS moderation_warn_rules (
  id               INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  guild_id         BIGINT UNSIGNED NOT NULL,
  warn_count       INT UNSIGNED    NOT NULL,
  action           ENUM('tempmute','kick','ban','tempban') NOT NULL,
  duration_minutes INT UNSIGNED    NULL,   -- tempmute / tempban
  created_at       DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_warn_rules (guild_id, warn_count)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Automod : mots interdits, détections (avec marquage des faux positifs) et mots autorisés (faux positifs confirmés).
CREATE TABLE IF NOT EXISTS moderation_automod_words (
  id         INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  guild_id   BIGINT UNSIGNED NOT NULL,
  word       VARCHAR(100)    NOT NULL,
  added_by   BIGINT UNSIGNED NULL,
  created_at DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_automod_word (guild_id, word)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS moderation_automod_allow (
  guild_id   BIGINT UNSIGNED NOT NULL,
  token      VARCHAR(100)    NOT NULL,
  added_by   BIGINT UNSIGNED NULL,
  created_at DATETIME(3)     NOT NULL,
  PRIMARY KEY (guild_id, token)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS moderation_automod_hits (
  id             BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  guild_id       BIGINT UNSIGNED  NOT NULL,
  user_id        BIGINT UNSIGNED  NOT NULL,
  channel_id     BIGINT UNSIGNED  NOT NULL,
  content        TEXT             NULL,
  matched_word   VARCHAR(100)     NOT NULL,
  token          VARCHAR(100)     NOT NULL,
  score          TINYINT UNSIGNED NOT NULL, -- similarité, en %
  action         VARCHAR(20)      NOT NULL,
  false_positive TINYINT(1)       NOT NULL DEFAULT 0,
  reviewed_by    BIGINT UNSIGNED  NULL,
  created_at     DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  KEY idx_automod_hits_guild (guild_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Notes internes du staff sur un membre (pas des sanctions).
CREATE TABLE IF NOT EXISTS moderation_notes (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  guild_id   BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  author_id  BIGINT UNSIGNED NOT NULL,
  content    TEXT            NOT NULL,
  created_at DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_notes_member (guild_id, user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Contestations : une seule par sanction, reliée au ticket ouvert.
CREATE TABLE IF NOT EXISTS moderation_appeals (
  action_id  BIGINT UNSIGNED NOT NULL,
  guild_id   BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  ticket_id  BIGINT UNSIGNED NULL,
  reason     TEXT            NULL,
  created_at DATETIME(3)     NOT NULL,
  PRIMARY KEY (action_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
