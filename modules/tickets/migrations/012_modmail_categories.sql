-- Modmail multi-catégories : chaque serveur peut configurer plusieurs catégories (ex. "Support",
-- "Signalement"), chacune avec sa propre catégorie Discord et ses propres rôles staff — le membre
-- choisit parmi celles disponibles à l'ouverture. Remplace les colonnes plates
-- modmail_category_id/modmail_staff_role_ids (une seule catégorie possible) par cette table.
CREATE TABLE IF NOT EXISTS modmail_categories (
  id             INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  guild_id       BIGINT UNSIGNED NOT NULL,
  name           VARCHAR(100)    NOT NULL,
  category_id    BIGINT UNSIGNED NULL,
  staff_role_ids JSON            NOT NULL,
  position       INT UNSIGNED    NOT NULL DEFAULT 0,
  created_at     DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_modmail_categories_guild (guild_id, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Reprend la config existante (si activée) en une première catégorie "Support".
INSERT INTO modmail_categories (guild_id, name, category_id, staff_role_ids, position, created_at)
SELECT guild_id, 'Support', modmail_category_id, COALESCE(modmail_staff_role_ids, JSON_ARRAY()), 0, NOW()
FROM ticket_settings
WHERE modmail_category_id IS NOT NULL;

ALTER TABLE ticket_settings
  DROP COLUMN modmail_category_id,
  DROP COLUMN modmail_staff_role_ids;

-- Chaque fil garde une copie (nom + rôles) de sa catégorie au moment de l'ouverture : la
-- permission staff et l'affichage du transcript restent corrects même si la catégorie est
-- ensuite renommée/supprimée du panel web.
ALTER TABLE modmail_threads
  ADD COLUMN category_id    INT UNSIGNED NULL,
  ADD COLUMN category_name  VARCHAR(100) NULL,
  ADD COLUMN staff_role_ids JSON         NULL;

-- Messages capturés d'un fil modmail (miroir de ticket_messages), pour affichage sur le panel web.
CREATE TABLE IF NOT EXISTS modmail_messages (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  thread_id    BIGINT UNSIGNED NOT NULL,
  message_id   BIGINT UNSIGNED NULL,
  author_id    BIGINT UNSIGNED NOT NULL,
  author_name  VARCHAR(100)    NOT NULL,
  author_avatar VARCHAR(255)   NULL,
  author_bot   TINYINT(1)      NOT NULL DEFAULT 0,
  kind         ENUM('member','staff','note','system') NOT NULL DEFAULT 'member',
  content      MEDIUMTEXT      NULL,
  embeds       JSON            NULL,
  attachments  JSON            NULL,
  created_at   DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_modmail_messages_thread (thread_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Contenu binaire des pièces jointes d'un message modmail (miroir de ticket_attachments).
CREATE TABLE IF NOT EXISTS modmail_attachments (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_row_id BIGINT UNSIGNED NOT NULL,
  name           VARCHAR(255)    NOT NULL,
  content_type   VARCHAR(100)    NULL,
  size           INT UNSIGNED    NULL,
  data           LONGBLOB        NOT NULL,
  created_at     DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_modmail_attachments_message (message_row_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
