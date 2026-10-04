-- ════════════════════════════════════════════════════════════════════════
-- Module Modération — sanctions, verrouillages, avertissements, historique
-- ════════════════════════════════════════════════════════════════════════

-- Réglages par serveur (salon de journal, catégorie « Prison » pour le shadow-ban)
CREATE TABLE IF NOT EXISTS moderation_settings (
  guild_id           BIGINT UNSIGNED NOT NULL,
  log_channel_id     BIGINT UNSIGNED NULL,
  prison_category_id BIGINT UNSIGNED NULL,
  updated_at         DATETIME(3)     NOT NULL,
  PRIMARY KEY (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Historique complet de toutes les actions du module (une ligne par action, jamais supprimée) :
-- sert à la fois de journal, d'historique (/history) et de source pour /modlogs.
CREATE TABLE IF NOT EXISTS moderation_actions (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  guild_id    BIGINT UNSIGNED NOT NULL,
  action      ENUM('ban','unban','kick','tempmute','unmute','tempvocmute','untempvocmute','warn','removewarn',
                    'shadowban','unshadowban','lock','unlock','lockall','unlockall','clear',
                    'slowmode','purge') NOT NULL,
  target_id   BIGINT UNSIGNED NULL,      -- NULL pour les actions sans membre visé (lockall, purge…)
  channel_id  BIGINT UNSIGNED NULL,      -- salon concerné (lock, clear, slowmode, purge, tempvocmute…)
  executor_id BIGINT UNSIGNED NOT NULL,
  reason      VARCHAR(512)    NULL,
  duration_s  INT UNSIGNED    NULL,      -- durée demandée, en secondes (tempmute, tempvocmute, slowmode)
  expires_at  DATETIME(3)     NULL,      -- pour tempvocmute : échéance surveillée par le planificateur
  metadata    JSON            NULL,      -- détails additionnels (ex. nombre de messages supprimés)
  active       TINYINT(1)     NOT NULL DEFAULT 1, -- warn actif ? tempvocmute pas encore levé ?
  resolved_at DATETIME(3)     NULL,      -- levée manuelle (/unmute) ou automatique (expiration)
  resolved_by BIGINT UNSIGNED NULL,
  created_at  DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_mod_guild_time (guild_id, created_at),
  KEY idx_mod_guild_target_time (guild_id, target_id, created_at),
  KEY idx_mod_guild_executor_time (guild_id, executor_id, created_at),
  KEY idx_mod_guild_channel_time (guild_id, channel_id, created_at),
  KEY idx_mod_active_expiry (action, active, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- État d'un salon verrouillé (/lock, /lockall) : permet à /unlock de restaurer précisément la
-- permission @everyone d'avant (autorisée, refusée ou héritée), pas juste de l'effacer.
CREATE TABLE IF NOT EXISTS moderation_channel_locks (
  guild_id        BIGINT UNSIGNED NOT NULL,
  channel_id      BIGINT UNSIGNED NOT NULL,
  -- État précédent des seules permissions touchées par le verrouillage, pour @everyone :
  -- { "SendMessages": true|false|null, … } — null = ni autorisée ni refusée (héritée).
  previous_state  JSON            NOT NULL,
  locked_by       BIGINT UNSIGNED NULL,
  locked_at       DATETIME(3)     NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Shadow-bans actifs : retrouve le salon prison d'un membre pour le supprimer au /unshadow-ban.
CREATE TABLE IF NOT EXISTS moderation_shadowbans (
  guild_id          BIGINT UNSIGNED NOT NULL,
  user_id           BIGINT UNSIGNED NOT NULL,
  prison_channel_id BIGINT UNSIGNED NOT NULL,
  executor_id       BIGINT UNSIGNED NULL,
  reason            VARCHAR(512)    NULL,
  created_at        DATETIME(3)     NOT NULL,
  PRIMARY KEY (guild_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
