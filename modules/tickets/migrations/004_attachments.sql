-- Contenu binaire des pièces jointes des messages de ticket, téléchargé au moment de la capture
-- (les URL du CDN Discord expirent) et servi ensuite par le panel web pour garder les transcripts
-- consultables durablement (images, gifs, fichiers…).
CREATE TABLE IF NOT EXISTS ticket_attachments (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_row_id BIGINT UNSIGNED NOT NULL,
  name           VARCHAR(255)    NOT NULL,
  content_type   VARCHAR(100)    NULL,
  size           INT UNSIGNED    NULL,
  data           LONGBLOB        NOT NULL,
  created_at     DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_attachments_message (message_row_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
