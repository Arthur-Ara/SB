-- ════════════════════════════════════════════════════════════════════════
-- Module Server Manager — journal des modifications du serveur + rollbacks
-- Toutes les dates sont en UTC. Les IDs Discord sont des BIGINT UNSIGNED.
-- ════════════════════════════════════════════════════════════════════════

-- Journal des modifications annulables (salons, rôles, rôles des membres).
-- before_json / after_json : instantanés (voir lib/serialize.js) avant et après la modification.
CREATE TABLE IF NOT EXISTS sm_changes (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  guild_id       BIGINT UNSIGNED NOT NULL,
  kind           ENUM('channel','role','member_role') NOT NULL,
  op             ENUM('create','update','delete','add','remove') NOT NULL,
  target_id      BIGINT UNSIGNED NOT NULL,           -- salon, rôle, ou membre (member_role)
  role_id        BIGINT UNSIGNED NULL,               -- member_role : rôle ajouté / retiré
  executor_id    BIGINT UNSIGNED NULL,               -- NULL = auteur inconnu (journal d'audit indisponible)
  label          VARCHAR(120)    NOT NULL DEFAULT '',
  before_json    MEDIUMTEXT      NULL,
  after_json     MEDIUMTEXT      NULL,
  created_at     DATETIME(3)     NOT NULL,
  rolled_back_at DATETIME(3)     NULL,
  rolled_back_by BIGINT UNSIGNED NULL,
  batch_id       BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  KEY idx_smc_guild_time (guild_id, created_at),
  KEY idx_smc_guild_exec (guild_id, executor_id, created_at),
  KEY idx_smc_target (guild_id, kind, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Correspondance ancien ID → nouvel ID quand un salon / rôle supprimé est recréé par un rollback
-- (les modifications plus anciennes de l'objet restent ainsi annulables).
CREATE TABLE IF NOT EXISTS sm_id_map (
  guild_id   BIGINT UNSIGNED NOT NULL,
  kind       ENUM('channel','role') NOT NULL,
  old_id     BIGINT UNSIGNED NOT NULL,
  new_id     BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3)     NOT NULL,
  PRIMARY KEY (guild_id, kind, old_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Réglages par serveur
CREATE TABLE IF NOT EXISTS sm_settings (
  guild_id       BIGINT UNSIGNED NOT NULL,
  log_channel_id BIGINT UNSIGNED NULL,
  tracking_since DATETIME(3)     NULL,               -- début de la couverture du journal sur ce serveur
  updated_at     DATETIME(3)     NOT NULL,
  PRIMARY KEY (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Une ligne par rollback exécuté (le rapport détaillé est conservé en JSON)
CREATE TABLE IF NOT EXISTS sm_batches (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  guild_id       BIGINT UNSIGNED NOT NULL,
  invoker_id     BIGINT UNSIGNED NOT NULL,
  scope          VARCHAR(16)     NOT NULL,
  window_s       INT UNSIGNED    NOT NULL,
  target_user_id BIGINT UNSIGNED NULL,
  status         ENUM('running','done','aborted','failed') NOT NULL DEFAULT 'running',
  planned        INT UNSIGNED    NOT NULL DEFAULT 0,
  applied        INT UNSIGNED    NOT NULL DEFAULT 0,
  skipped        INT UNSIGNED    NOT NULL DEFAULT 0,
  failed         INT UNSIGNED    NOT NULL DEFAULT 0,
  report         MEDIUMTEXT      NULL,
  created_at     DATETIME(3)     NOT NULL,
  finished_at    DATETIME(3)     NULL,
  PRIMARY KEY (id),
  KEY idx_smb_guild_time (guild_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sanctions de modération déjà annulées par un rollback (une sanction ne l'est qu'une fois)
CREATE TABLE IF NOT EXISTS sm_mod_reverted (
  action_id   BIGINT UNSIGNED NOT NULL,
  guild_id    BIGINT UNSIGNED NOT NULL,
  batch_id    BIGINT UNSIGNED NOT NULL,
  reverted_by BIGINT UNSIGNED NOT NULL,
  created_at  DATETIME(3)     NOT NULL,
  PRIMARY KEY (action_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
