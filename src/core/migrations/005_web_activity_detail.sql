-- Journal d'activité du panel : détail de chaque action (champs modifiés, ancienne → nouvelle valeur quand le module
-- le fournit, sinon liste des champs envoyés).
ALTER TABLE web_activity
  ADD COLUMN detail TEXT NULL AFTER status;
