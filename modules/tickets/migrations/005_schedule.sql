-- Clôture automatique sur inactivité + reping du staff, avec plage horaire d'activation (par
-- serveur) pour pouvoir désactiver le système la nuit.

ALTER TABLE ticket_types
  ADD COLUMN auto_close_minutes INT UNSIGNED NULL AFTER user_can_close, -- NULL = désactivé
  ADD COLUMN reping_minutes     INT UNSIGNED NULL AFTER auto_close_minutes; -- NULL = désactivé

ALTER TABLE ticket_settings
  ADD COLUMN schedule_enabled  TINYINT(1)  NOT NULL DEFAULT 0,
  ADD COLUMN schedule_start    TIME        NULL,     -- ex. '08:00:00'
  ADD COLUMN schedule_end      TIME        NULL,      -- ex. '22:00:00' (peut être < start : plage traversant minuit)
  ADD COLUMN schedule_timezone VARCHAR(64) NULL DEFAULT 'Europe/Paris';

ALTER TABLE tickets
  ADD COLUMN last_message_at       DATETIME(3) NULL AFTER created_at,
  ADD COLUMN last_message_is_staff TINYINT(1)  NOT NULL DEFAULT 0 AFTER last_message_at, -- dernier message = staff (mod/helper/admin) et non l'ouvreur
  ADD COLUMN last_reping_at        DATETIME(3) NULL AFTER last_message_is_staff;
