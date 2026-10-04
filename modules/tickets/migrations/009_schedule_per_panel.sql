-- La plage horaire d'activation (clôture automatique + reping) devient propre à chaque panel,
-- plutôt qu'un seul réglage pour tout le serveur.
ALTER TABLE ticket_panels
  ADD COLUMN schedule_enabled  TINYINT(1)  NOT NULL DEFAULT 0,
  ADD COLUMN schedule_start    TIME        NULL,
  ADD COLUMN schedule_end      TIME        NULL,
  ADD COLUMN schedule_timezone VARCHAR(64) NULL DEFAULT 'Europe/Paris';

ALTER TABLE ticket_settings
  DROP COLUMN schedule_enabled,
  DROP COLUMN schedule_start,
  DROP COLUMN schedule_end,
  DROP COLUMN schedule_timezone;
