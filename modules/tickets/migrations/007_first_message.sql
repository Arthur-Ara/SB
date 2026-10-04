-- Distingue « personne n'a encore parlé » (compte pour la clôture automatique, dès l'ouverture)
-- de « l'ouvreur a parlé, le staff n'a pas répondu » (compte pour le reping, jamais avant).
ALTER TABLE tickets
  ADD COLUMN first_opener_message_at DATETIME(3) NULL AFTER last_message_at;
