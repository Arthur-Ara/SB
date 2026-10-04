-- Fermeture automatique avec confirmation du staff : au lieu de fermer d'office un ticket inactif, le bot
-- demande confirmation dans le salon (boutons Confirmer / Garder ouvert). `autoclose_asked_at` évite de
-- reposer la question à chaque balayage ; `auto_closed` marque un ticket fermé par ce mécanisme (ou parce
-- que le membre a quitté le serveur) : aucune demande de notation n'est alors envoyée à la suppression.
ALTER TABLE tickets
  ADD COLUMN autoclose_asked_at DATETIME(3) NULL,
  ADD COLUMN auto_closed        TINYINT(1)  NOT NULL DEFAULT 0;
