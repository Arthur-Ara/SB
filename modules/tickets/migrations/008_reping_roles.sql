-- Rôles à repinger, distincts des rôles notifiés à l'ouverture (case à cocher côté panel web pour
-- reprendre les mêmes rôles que les rôles notifiés, réglage par défaut).
ALTER TABLE ticket_types
  ADD COLUMN reping_role_ids       JSON       NOT NULL DEFAULT (JSON_ARRAY()) AFTER notify_role_ids,
  ADD COLUMN reping_same_as_notify TINYINT(1) NOT NULL DEFAULT 1 AFTER reping_role_ids;
