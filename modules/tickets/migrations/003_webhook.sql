-- Webhook du salon d'un ticket, réutilisé pour relayer les réponses envoyées depuis le panel web
-- sous le pseudo et la photo de profil Discord de l'auteur (transcript live).
ALTER TABLE tickets
  ADD COLUMN webhook_id    BIGINT UNSIGNED NULL AFTER channel_id,
  ADD COLUMN webhook_token VARCHAR(255)    NULL AFTER webhook_id;
