-- Date de dernière modification d'un message capturé (aperçus de liens ajoutés après l'envoi, éditions) :
-- le transcript live ne récupère plus que les messages nouveaux OU modifiés depuis son dernier passage.
ALTER TABLE ticket_messages
  ADD COLUMN updated_at DATETIME(3) NULL AFTER created_at,
  ADD KEY idx_messages_ticket_updated (ticket_id, updated_at);
