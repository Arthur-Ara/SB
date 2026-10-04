-- Fonctionnalités v1.3.0 des tickets — toutes désactivées / vides par défaut, réglables par type ou par serveur.

-- Formulaire d'ouverture (questions posées dans une fenêtre Discord avant la création du ticket) et
-- suppression automatique du salon d'un ticket fermé depuis X heures — réglés par type.
ALTER TABLE ticket_types
  ADD COLUMN form_enabled      TINYINT(1)   NOT NULL DEFAULT 0,
  ADD COLUMN form_title        VARCHAR(45)  NULL,
  ADD COLUMN form_questions    JSON         NULL,      -- [{ label, placeholder, style: short|paragraph, required, maxLength }]
  ADD COLUMN auto_delete_hours INT UNSIGNED NULL;      -- NULL = suppression manuelle uniquement

-- Réponses au formulaire, et date de suppression du salon (un ticket archivé n'est plus traité par le balayage).
ALTER TABLE tickets
  ADD COLUMN form_answers JSON        NULL,
  ADD COLUMN deleted_at   DATETIME(3) NULL,
  ADD KEY idx_tickets_claimed (guild_id, claimed_by);

-- Transfert d'un ticket vers un autre type : conservé dans l'historique archivé.
ALTER TABLE ticket_events
  MODIFY COLUMN event ENUM('closed','reopened','deleted','transferred') NOT NULL;

-- Réponses prédéfinies du staff (/ticket reponse, panel web).
CREATE TABLE IF NOT EXISTS ticket_snippets (
  id         INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  guild_id   BIGINT UNSIGNED NOT NULL,
  name       VARCHAR(50)     NOT NULL,
  content    TEXT            NOT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3)     NOT NULL,
  updated_at DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_snippets_name (guild_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Étiquettes (priorité, catégorie de problème…) définies par serveur, posées sur les tickets.
CREATE TABLE IF NOT EXISTS ticket_tags (
  id         INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  guild_id   BIGINT UNSIGNED NOT NULL,
  name       VARCHAR(50)     NOT NULL,
  emoji      VARCHAR(64)     NULL,
  color      CHAR(7)         NULL,
  position   INT UNSIGNED    NOT NULL DEFAULT 0,
  created_at DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tags_name (guild_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ticket_tag_links (
  ticket_id BIGINT UNSIGNED NOT NULL,
  tag_id    INT UNSIGNED    NOT NULL,
  added_by  BIGINT UNSIGNED NULL,
  added_at  DATETIME(3)     NOT NULL,
  PRIMARY KEY (ticket_id, tag_id),
  KEY idx_tag_links_tag (tag_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Membres interdits d'ouvrir un ticket (et d'écrire au staff par modmail) sur un serveur.
CREATE TABLE IF NOT EXISTS ticket_blacklist (
  guild_id BIGINT UNSIGNED NOT NULL,
  user_id  BIGINT UNSIGNED NOT NULL,
  reason   VARCHAR(512)    NULL,
  added_by BIGINT UNSIGNED NULL,
  added_at DATETIME(3)     NOT NULL,
  PRIMARY KEY (guild_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
