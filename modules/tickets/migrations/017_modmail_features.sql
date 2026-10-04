-- Fonctionnalités v1.3.0 du modmail — toutes désactivées / vides par défaut.

-- Par catégorie : message d'accueil envoyé au membre et fermeture automatique après X heures d'inactivité.
ALTER TABLE modmail_categories
  ADD COLUMN welcome_message  TEXT         NULL,
  ADD COLUMN auto_close_hours INT UNSIGNED NULL;

-- Dernière activité d'un fil (message du membre ou du staff), pour la fermeture automatique.
ALTER TABLE modmail_threads
  ADD COLUMN last_message_at DATETIME(3) NULL;
UPDATE modmail_threads SET last_message_at = created_at WHERE last_message_at IS NULL;

-- Réponses envoyées depuis le panel web et réponses anonymes (affichage du transcript).
ALTER TABLE modmail_messages
  ADD COLUMN via_web   TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN anonymous TINYINT(1) NOT NULL DEFAULT 0;

-- Préfixe de grade affiché au membre devant le nom du staff qui lui répond (ex. « [Admin] »).
CREATE TABLE IF NOT EXISTS modmail_role_prefixes (
  guild_id BIGINT UNSIGNED NOT NULL,
  role_id  BIGINT UNSIGNED NOT NULL,
  prefix   VARCHAR(32)     NOT NULL,
  PRIMARY KEY (guild_id, role_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
