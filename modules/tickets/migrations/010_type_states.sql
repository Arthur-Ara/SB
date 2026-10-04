-- Noms de salon selon l'état du ticket (pris en charge / fermé), message de reping personnalisé
-- et fermeture automatique quand l'ouvreur quitte le serveur — tous réglés par type de ticket.
ALTER TABLE ticket_types
  ADD COLUMN claimed_channel_name_pattern VARCHAR(100) NULL,
  ADD COLUMN closed_channel_name_pattern  VARCHAR(100) NULL,
  ADD COLUMN reping_message               TEXT         NULL,
  ADD COLUMN close_on_leave               TINYINT(1)   NOT NULL DEFAULT 0;
