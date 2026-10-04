-- Historique des transitions d'un ticket (fermé / réouvert / supprimé), pour archiver l'ensemble en
-- un seul log au moment de la suppression du salon plutôt que de journaliser chaque étape à part.
CREATE TABLE IF NOT EXISTS ticket_events (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_id  BIGINT UNSIGNED NOT NULL,
  event      ENUM('closed','reopened','deleted') NOT NULL,
  actor_id   BIGINT UNSIGNED NULL, -- NULL = automatique (clôture auto, salon supprimé manuellement hors du bot)
  reason     VARCHAR(512) NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_events_ticket (ticket_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
