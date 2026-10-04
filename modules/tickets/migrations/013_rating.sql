-- Notation de fin de ticket (facultative pour le membre), activable par type : quand elle est
-- activée, le staff doit prendre en charge (claim) le ticket avant de pouvoir y répondre, et
-- l'ouvreur reçoit une invitation à noter le ticket (1 à 5 étoiles) en message privé à la fermeture.
ALTER TABLE ticket_types
  ADD COLUMN rating_enabled TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE tickets
  ADD COLUMN rating_stars TINYINT UNSIGNED NULL,
  ADD COLUMN rating_at    DATETIME(3)      NULL;
