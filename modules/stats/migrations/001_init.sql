-- ════════════════════════════════════════════════════════════════════════
-- Module Statistiques — schéma initial
-- Toutes les dates sont en UTC. Les IDs Discord sont des BIGINT UNSIGNED.
-- Les index composites commencent par guild_id (toutes les requêtes du
-- dashboard sont filtrées par serveur) puis par la date.
-- ════════════════════════════════════════════════════════════════════════

-- Serveurs suivis + état de la rétroactivité
CREATE TABLE IF NOT EXISTS stats_guilds (
  id              BIGINT UNSIGNED NOT NULL,
  name            VARCHAR(100)    NOT NULL,
  icon            VARCHAR(64)     NULL,
  owner_id        BIGINT UNSIGNED NULL,
  bot_joined_at   DATETIME(3)     NULL,
  is_present      TINYINT(1)      NOT NULL DEFAULT 1,
  backfill_status ENUM('pending','running','done','failed') NOT NULL DEFAULT 'pending',
  backfilled_at   DATETIME(3)     NULL,
  tracking_since  DATETIME(3)     NULL,
  updated_at      DATETIME(3)     NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Profil global Discord des utilisateurs (hors bots)
CREATE TABLE IF NOT EXISTS stats_users (
  id            BIGINT UNSIGNED NOT NULL,
  username      VARCHAR(64)     NOT NULL,
  global_name   VARCHAR(64)     NULL,
  avatar        VARCHAR(64)     NULL,
  first_seen_at DATETIME(3)     NOT NULL,
  updated_at    DATETIME(3)     NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Appartenance d'un utilisateur à un serveur (état courant)
CREATE TABLE IF NOT EXISTS stats_members (
  guild_id       BIGINT UNSIGNED NOT NULL,
  user_id        BIGINT UNSIGNED NOT NULL,
  nickname       VARCHAR(64)     NULL,
  guild_avatar   VARCHAR(64)     NULL,
  joined_at      DATETIME(3)     NULL,
  left_at        DATETIME(3)     NULL,
  is_member      TINYINT(1)      NOT NULL DEFAULT 1,
  premium_since  DATETIME(3)     NULL,
  nitro_detected TINYINT(1)      NOT NULL DEFAULT 0,
  updated_at     DATETIME(3)     NOT NULL,
  PRIMARY KEY (guild_id, user_id),
  KEY idx_members_user (user_id),
  KEY idx_members_joined (guild_id, is_member, joined_at),
  KEY idx_members_premium (guild_id, is_member, premium_since)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Salons et rôles (pour afficher des noms, même après suppression)
CREATE TABLE IF NOT EXISTS stats_channels (
  id         BIGINT UNSIGNED   NOT NULL,
  guild_id   BIGINT UNSIGNED   NOT NULL,
  parent_id  BIGINT UNSIGNED   NULL,
  name       VARCHAR(100)      NOT NULL,
  type       SMALLINT UNSIGNED NOT NULL,
  is_deleted TINYINT(1)        NOT NULL DEFAULT 0,
  updated_at DATETIME(3)       NOT NULL,
  PRIMARY KEY (id),
  KEY idx_channels_guild (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stats_roles (
  id         BIGINT UNSIGNED NOT NULL,
  guild_id   BIGINT UNSIGNED NOT NULL,
  name       VARCHAR(100)    NOT NULL,
  color      INT UNSIGNED    NOT NULL DEFAULT 0,
  position   INT             NOT NULL DEFAULT 0,
  is_deleted TINYINT(1)      NOT NULL DEFAULT 0,
  updated_at DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_roles_guild (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Messages envoyés (métadonnées ; contenu seulement si STATS_STORE_MESSAGE_CONTENT=true)
CREATE TABLE IF NOT EXISTS stats_messages (
  id                BIGINT UNSIGNED   NOT NULL,
  guild_id          BIGINT UNSIGNED   NOT NULL,
  channel_id        BIGINT UNSIGNED   NOT NULL,
  user_id           BIGINT UNSIGNED   NOT NULL,
  created_at        DATETIME(3)       NOT NULL,
  length            INT UNSIGNED      NOT NULL DEFAULT 0,
  content           TEXT              NULL,
  attachments       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  mentions_everyone TINYINT(1)        NOT NULL DEFAULT 0,
  mentions_here     TINYINT(1)        NOT NULL DEFAULT 0,
  source            ENUM('live','backfill') NOT NULL DEFAULT 'live',
  PRIMARY KEY (id),
  KEY idx_msg_guild_time (guild_id, created_at),
  KEY idx_msg_guild_user_time (guild_id, user_id, created_at),
  KEY idx_msg_guild_channel_time (guild_id, channel_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Messages supprimés
CREATE TABLE IF NOT EXISTS stats_message_deletions (
  message_id BIGINT UNSIGNED NOT NULL,
  guild_id   BIGINT UNSIGNED NOT NULL,
  channel_id BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NULL,
  deleted_at DATETIME(3)     NOT NULL,
  PRIMARY KEY (message_id),
  KEY idx_del_guild_time (guild_id, deleted_at),
  KEY idx_del_guild_user (guild_id, user_id, deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Mentions de rôles contenues dans les messages
CREATE TABLE IF NOT EXISTS stats_role_mentions (
  message_id BIGINT UNSIGNED NOT NULL,
  role_id    BIGINT UNSIGNED NOT NULL,
  guild_id   BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3)     NOT NULL,
  PRIMARY KEY (message_id, role_id),
  KEY idx_rm_guild_time (guild_id, created_at),
  KEY idx_rm_guild_role_time (guild_id, role_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sessions vocales (une ligne par passage dans un salon)
CREATE TABLE IF NOT EXISTS stats_voice_sessions (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  guild_id         BIGINT UNSIGNED NOT NULL,
  user_id          BIGINT UNSIGNED NOT NULL,
  channel_id       BIGINT UNSIGNED NOT NULL,
  joined_at        DATETIME(3)     NOT NULL,
  left_at          DATETIME(3)     NULL,
  duration_seconds INT UNSIGNED    NULL,
  PRIMARY KEY (id),
  KEY idx_vs_guild_time (guild_id, joined_at),
  KEY idx_vs_guild_left (guild_id, left_at, joined_at),
  KEY idx_vs_guild_user_time (guild_id, user_id, joined_at),
  KEY idx_vs_open (left_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Arrivées / départs
CREATE TABLE IF NOT EXISTS stats_member_events (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  guild_id   BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  type       ENUM('join','leave') NOT NULL,
  created_at DATETIME(3)     NOT NULL,
  source     ENUM('live','backfill','sync') NOT NULL DEFAULT 'live',
  PRIMARY KEY (id),
  UNIQUE KEY uq_member_event (guild_id, user_id, type, created_at),
  KEY idx_me_guild_type_time (guild_id, type, created_at),
  KEY idx_me_user_time (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sanctions (bannissements, expulsions, exclusions temporaires) issues du journal d'audit
CREATE TABLE IF NOT EXISTS stats_moderation_actions (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  guild_id     BIGINT UNSIGNED NOT NULL,
  target_id    BIGINT UNSIGNED NULL,
  executor_id  BIGINT UNSIGNED NULL,
  action       ENUM('ban','kick','timeout') NOT NULL,
  reason       VARCHAR(512)    NULL,
  expires_at   DATETIME(3)     NULL,
  created_at   DATETIME(3)     NOT NULL,
  audit_log_id BIGINT UNSIGNED NULL,
  source       ENUM('live','backfill') NOT NULL DEFAULT 'live',
  PRIMARY KEY (id),
  UNIQUE KEY uq_mod_audit (audit_log_id),
  KEY idx_mod_guild_time (guild_id, created_at),
  KEY idx_mod_guild_target (guild_id, target_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Historique des rôles (ajouts / retraits)
CREATE TABLE IF NOT EXISTS stats_role_history (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  guild_id     BIGINT UNSIGNED NOT NULL,
  user_id      BIGINT UNSIGNED NOT NULL,
  role_id      BIGINT UNSIGNED NOT NULL,
  action       ENUM('add','remove') NOT NULL,
  executor_id  BIGINT UNSIGNED NULL,
  created_at   DATETIME(3)     NOT NULL,
  audit_log_id BIGINT UNSIGNED NULL,
  source       ENUM('live','backfill') NOT NULL DEFAULT 'live',
  PRIMARY KEY (id),
  UNIQUE KEY uq_role_audit (audit_log_id, role_id, action),
  KEY idx_rh_guild_user_time (guild_id, user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Historique des pseudonymes : global (username, display name) et local (surnom par serveur)
CREATE TABLE IF NOT EXISTS stats_name_history (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      BIGINT UNSIGNED NOT NULL,
  guild_id     BIGINT UNSIGNED NULL,
  name_type    ENUM('username','global_name','nickname') NOT NULL,
  old_value    VARCHAR(64)     NULL,
  new_value    VARCHAR(64)     NULL,
  changed_at   DATETIME(3)     NOT NULL,
  audit_log_id BIGINT UNSIGNED NULL,
  source       ENUM('live','backfill','sync') NOT NULL DEFAULT 'live',
  PRIMARY KEY (id),
  UNIQUE KEY uq_name_audit (audit_log_id),
  KEY idx_nh_user_time (user_id, changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Historique des boosts
CREATE TABLE IF NOT EXISTS stats_boost_history (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  guild_id   BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  started_at DATETIME(3)     NOT NULL,
  ended_at   DATETIME(3)     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_boost (guild_id, user_id, started_at),
  KEY idx_boost_open (guild_id, user_id, ended_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Instantanés périodiques de l'état du serveur (courbe du nombre de membres, boosts, Nitro)
CREATE TABLE IF NOT EXISTS stats_guild_snapshots (
  guild_id      BIGINT UNSIGNED NOT NULL,
  taken_at      DATETIME(3)     NOT NULL,
  member_count  INT UNSIGNED    NOT NULL,
  boost_count   INT UNSIGNED    NULL,
  booster_count INT UNSIGNED    NULL,
  nitro_count   INT UNSIGNED    NULL,
  source        ENUM('live','backfill') NOT NULL DEFAULT 'live',
  PRIMARY KEY (guild_id, taken_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Petites valeurs techniques du module (ex : dernier battement de cœur)
CREATE TABLE IF NOT EXISTS stats_meta (
  name       VARCHAR(64)  NOT NULL,
  value      VARCHAR(255) NOT NULL,
  updated_at DATETIME(3)  NOT NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
