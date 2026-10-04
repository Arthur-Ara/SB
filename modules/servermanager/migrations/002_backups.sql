-- Server Manager v1.3.0 : sauvegardes de la structure du serveur (rôles, salons, permissions) et
-- sauvegardes automatiques (désactivées par défaut).

ALTER TABLE sm_settings
  ADD COLUMN backup_enabled        TINYINT(1)       NOT NULL DEFAULT 0,
  ADD COLUMN backup_interval_hours SMALLINT UNSIGNED NOT NULL DEFAULT 24,
  ADD COLUMN backup_keep           TINYINT UNSIGNED NOT NULL DEFAULT 7,
  ADD COLUMN last_backup_at        DATETIME(3)      NULL;

-- Une sauvegarde = instantané JSON de la structure (voir lib/backup.js#capture). Les messages ne sont jamais sauvegardés.
CREATE TABLE IF NOT EXISTS sm_backups (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  guild_id       BIGINT UNSIGNED NOT NULL,
  name           VARCHAR(80)     NOT NULL,
  origin         ENUM('manual','auto') NOT NULL DEFAULT 'manual',
  roles_count    INT UNSIGNED    NOT NULL DEFAULT 0,
  channels_count INT UNSIGNED    NOT NULL DEFAULT 0,
  size_bytes     INT UNSIGNED    NOT NULL DEFAULT 0,
  data           MEDIUMTEXT      NOT NULL,
  created_by     BIGINT UNSIGNED NULL,
  created_at     DATETIME(3)     NOT NULL,
  restored_at    DATETIME(3)     NULL,
  restored_by    BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  KEY idx_sm_backups_guild (guild_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
