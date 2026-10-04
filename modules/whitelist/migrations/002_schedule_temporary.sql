-- Whitelist vocale v1.3.0 : plage horaire par salon (restrictions actives uniquement dans la plage),
-- accès temporaires (/whitelist invite) et admins limités à certains salons.

ALTER TABLE whitelist_channels
  ADD COLUMN schedule_enabled  TINYINT(1)  NOT NULL DEFAULT 0,
  ADD COLUMN schedule_start    CHAR(5)     NULL, -- « HH:MM »
  ADD COLUMN schedule_end      CHAR(5)     NULL,
  ADD COLUMN schedule_timezone VARCHAR(64) NULL;

-- Accès temporaire : la ligne disparaît à l'échéance (NULL = membre whitelisté en permanence).
ALTER TABLE whitelist_channel_users
  ADD COLUMN expires_at DATETIME(3) NULL,
  ADD KEY idx_wcu_expires (expires_at);

-- Admins d'un salon : peuvent donner des accès temporaires à ce salon (/whitelist invite) et y entrer librement.
CREATE TABLE IF NOT EXISTS whitelist_channel_admins (
  guild_id   BIGINT UNSIGNED NOT NULL,
  channel_id BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  added_by   BIGINT UNSIGNED NULL,
  added_at   DATETIME(3)     NOT NULL,
  PRIMARY KEY (guild_id, channel_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
