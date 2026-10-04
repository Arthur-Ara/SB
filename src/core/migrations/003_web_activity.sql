-- Journal d'activité du panel web : connexions et actions (requêtes qui modifient quelque chose).
-- Les consultations (GET) ne sont pas journalisées ; aucune adresse IP n'est conservée.
CREATE TABLE IF NOT EXISTS web_activity (
  id         BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED  NOT NULL,
  username   VARCHAR(64)      NOT NULL,
  action     VARCHAR(16)      NOT NULL, -- login, logout, POST, PUT, PATCH, DELETE
  path       VARCHAR(200)     NOT NULL,
  module     VARCHAR(64)      NULL,
  guild_id   BIGINT UNSIGNED  NULL,
  status     SMALLINT UNSIGNED NULL,
  created_at DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  KEY idx_web_activity_time (created_at),
  KEY idx_web_activity_user (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
