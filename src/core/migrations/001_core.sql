-- Sessions du dashboard web (store express-session persistant).
CREATE TABLE IF NOT EXISTS web_sessions (
  sid        VARCHAR(128) NOT NULL,
  data       MEDIUMTEXT   NOT NULL,
  expires_at DATETIME     NOT NULL,
  PRIMARY KEY (sid),
  KEY idx_web_sessions_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
