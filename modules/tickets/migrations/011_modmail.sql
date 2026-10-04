-- Modmail : le membre écrit au bot en message privé, un salon de discussion est créé pour le staff.
ALTER TABLE ticket_settings
  ADD COLUMN modmail_enabled        TINYINT(1)      NOT NULL DEFAULT 0,
  ADD COLUMN modmail_category_id    BIGINT UNSIGNED NULL,
  ADD COLUMN modmail_staff_role_ids JSON            NULL;

CREATE TABLE IF NOT EXISTS modmail_threads (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  guild_id     BIGINT UNSIGNED NOT NULL,
  user_id      BIGINT UNSIGNED NOT NULL,
  channel_id   BIGINT UNSIGNED NOT NULL,
  status       ENUM('open','closed') NOT NULL DEFAULT 'open',
  opened_by    BIGINT UNSIGNED NULL,          -- NULL = ouvert par le membre lui-même
  closed_by    BIGINT UNSIGNED NULL,
  close_reason VARCHAR(512)    NULL,
  created_at   DATETIME(3)     NOT NULL,
  closed_at    DATETIME(3)     NULL,
  PRIMARY KEY (id),
  KEY idx_modmail_user (user_id, status),
  KEY idx_modmail_channel (channel_id),
  KEY idx_modmail_guild (guild_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
