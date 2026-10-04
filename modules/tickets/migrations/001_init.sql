-- ════════════════════════════════════════════════════════════════════════
-- Module Tickets — panels multi-types, cycle de vie, transcripts
-- ════════════════════════════════════════════════════════════════════════

-- Réglages par serveur (salon de journal unique, commun à tous les panels/types).
CREATE TABLE IF NOT EXISTS ticket_settings (
  guild_id       BIGINT UNSIGNED NOT NULL,
  log_channel_id BIGINT UNSIGNED NULL,
  updated_at     DATETIME(3)     NOT NULL,
  PRIMARY KEY (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Admins du module (/ticket admin) : peuvent créer des panels et voient/gèrent tous les tickets,
-- en plus des administrateurs et propriétaires du serveur/bot (toujours admins implicitement).
CREATE TABLE IF NOT EXISTS ticket_admins (
  guild_id BIGINT UNSIGNED NOT NULL,
  user_id  BIGINT UNSIGNED NOT NULL,
  added_by BIGINT UNSIGNED NULL,
  added_at DATETIME(3)     NOT NULL,
  PRIMARY KEY (guild_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Un panel = un message posté quelque part (embed d'ouverture + boutons ou sélecteur).
CREATE TABLE IF NOT EXISTS ticket_panels (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  guild_id         BIGINT UNSIGNED NOT NULL,
  channel_id       BIGINT UNSIGNED NULL,      -- salon où le panel est publié (NULL tant que non publié)
  message_id       BIGINT UNSIGNED NULL,      -- message du panel, pour le mettre à jour en place
  style            ENUM('buttons','select') NOT NULL DEFAULT 'buttons',
  open_title       VARCHAR(256)    NULL,
  open_description MEDIUMTEXT      NULL,
  open_color       CHAR(7)         NULL,      -- '#5865F2'
  open_footer      VARCHAR(2048)   NULL,
  open_image       VARCHAR(1024)   NULL,
  open_thumbnail   VARCHAR(1024)   NULL,
  created_by       BIGINT UNSIGNED NOT NULL,
  created_at       DATETIME(3)     NOT NULL,
  updated_at       DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_panels_guild (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Un type = un bouton ou une option du sélecteur d'un panel, avec sa configuration complète et
-- indépendante (catégorie, rôles, limite, embed d'ouverture de ticket, options de transcript).
CREATE TABLE IF NOT EXISTS ticket_types (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  panel_id            BIGINT UNSIGNED NOT NULL,
  position            INT UNSIGNED    NOT NULL DEFAULT 0,
  label               VARCHAR(80)     NOT NULL,
  emoji               VARCHAR(64)     NULL,
  button_style        ENUM('primary','secondary','success','danger') NULL, -- si style de panel = buttons
  select_description  VARCHAR(100)    NULL,   -- si style de panel = select
  category_id         BIGINT UNSIGNED NULL,   -- catégorie où sont créés les tickets de ce type
  max_open            INT UNSIGNED    NULL,   -- NULL = illimité
  mod_role_ids        JSON            NOT NULL, -- accès complet : écrire, voir, fermer, claim, ajouter/retirer
  notify_role_ids     JSON            NOT NULL, -- mentionnés une fois à l'ouverture
  helper_role_ids     JSON            NOT NULL, -- voir + écrire, sans claim ni fermer
  opened_title        VARCHAR(256)    NULL,
  opened_description  MEDIUMTEXT      NULL,   -- placeholders : {user} {type} {ticket}
  opened_color        CHAR(7)         NULL,
  opened_footer       VARCHAR(2048)   NULL,
  opened_image        VARCHAR(1024)   NULL,
  opened_thumbnail    VARCHAR(1024)   NULL,
  auto_transcript     TINYINT(1)      NOT NULL DEFAULT 1,
  transcript_prompt   TINYINT(1)      NOT NULL DEFAULT 1, -- proposer le transcript à la fermeture (si auto_transcript)
  live_transcript     TINYINT(1)      NOT NULL DEFAULT 0, -- transcript live + réponse depuis le panel web
  user_can_close      TINYINT(1)      NOT NULL DEFAULT 1,
  created_at          DATETIME(3)     NOT NULL,
  updated_at          DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_types_panel (panel_id, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Un ticket ouvert (ou fermé, conservé pour historique/transcript).
CREATE TABLE IF NOT EXISTS tickets (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  guild_id             BIGINT UNSIGNED NOT NULL,
  panel_id             BIGINT UNSIGNED NOT NULL,
  type_id              BIGINT UNSIGNED NOT NULL,
  channel_id           BIGINT UNSIGNED NOT NULL,
  opener_id            BIGINT UNSIGNED NOT NULL,
  status               ENUM('open','closed') NOT NULL DEFAULT 'open',
  claimed_by           BIGINT UNSIGNED NULL,
  subject              VARCHAR(120)    NULL,   -- libellé du type au moment de l'ouverture (garde une trace si le type change)
  close_reason         VARCHAR(512)    NULL,
  closed_by            BIGINT UNSIGNED NULL,
  closed_at            DATETIME(3)     NULL,
  transcript_generated TINYINT(1)      NOT NULL DEFAULT 0,
  created_at           DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tickets_channel (channel_id),
  KEY idx_tickets_guild_status (guild_id, status, created_at),
  KEY idx_tickets_type_status (type_id, status),
  KEY idx_tickets_opener (guild_id, opener_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Membres ajoutés explicitement à un ticket (/ticket add), en plus de l'ouvreur et des rôles.
CREATE TABLE IF NOT EXISTS ticket_members (
  ticket_id BIGINT UNSIGNED NOT NULL,
  user_id   BIGINT UNSIGNED NOT NULL,
  added_by  BIGINT UNSIGNED NOT NULL,
  added_at  DATETIME(3)     NOT NULL,
  PRIMARY KEY (ticket_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Messages capturés en direct (messageCreate) pour la reconstitution du transcript côté panel web.
CREATE TABLE IF NOT EXISTS ticket_messages (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_id         BIGINT UNSIGNED NOT NULL,
  message_id        BIGINT UNSIGNED NOT NULL,
  author_id         BIGINT UNSIGNED NOT NULL,
  author_name       VARCHAR(64)     NOT NULL, -- pseudo au moment de l'envoi
  author_avatar     VARCHAR(1024)   NULL,
  author_role_color CHAR(7)         NULL,     -- couleur du rôle le plus haut au moment de l'envoi
  author_bot        TINYINT(1)      NOT NULL DEFAULT 0,
  content           MEDIUMTEXT      NULL,
  embeds            JSON            NULL,
  attachments       JSON            NULL,
  via_web           TINYINT(1)      NOT NULL DEFAULT 0, -- envoyé depuis le panel web (transcript live)
  created_at        DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_messages_message (message_id),
  KEY idx_messages_ticket_time (ticket_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
