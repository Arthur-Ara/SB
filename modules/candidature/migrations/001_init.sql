-- Module Candidature : catégories (modèle d'ouverture, formulaire, critères), candidatures avec statut,
-- historique des événements et transcription (messages + pièces jointes) de chaque candidature.

CREATE TABLE IF NOT EXISTS cand_settings (
  guild_id                BIGINT UNSIGNED NOT NULL,
  log_channel_id          BIGINT UNSIGNED NULL,
  refusal_reason_required TINYINT(1)      NOT NULL DEFAULT 1,
  auto_replies            JSON            NULL,           -- { statut: { message, dm } }
  panel_channel_id        BIGINT UNSIGNED NULL,
  panel_message_id        BIGINT UNSIGNED NULL,
  panel_style             VARCHAR(10)     NOT NULL DEFAULT 'buttons',
  panel_title             VARCHAR(256)    NULL,
  panel_description       TEXT            NULL,
  panel_color             VARCHAR(7)      NULL,
  panel_footer            VARCHAR(2048)   NULL,
  panel_image             VARCHAR(1024)   NULL,
  panel_thumbnail         VARCHAR(1024)   NULL,
  updated_at              DATETIME(3)     NOT NULL,
  PRIMARY KEY (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cand_categories (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  guild_id           BIGINT UNSIGNED NOT NULL,
  label              VARCHAR(80)     NOT NULL,
  emoji              VARCHAR(64)     NULL,
  button_style       VARCHAR(16)     NOT NULL DEFAULT 'primary',
  select_description VARCHAR(100)    NULL,
  category_id        BIGINT UNSIGNED NULL,                -- catégorie Discord où sont créés les salons
  recruiter_role_ids JSON            NULL,
  notify_role_ids    JSON            NULL,
  max_open           INT UNSIGNED    NULL,                -- candidatures actives simultanées (NULL = illimité)
  cooldown_days      INT UNSIGNED    NULL,                -- délai avant de se représenter après un refus
  accept_role_id     BIGINT UNSIGNED NULL,                -- rôle donné à l'acceptation
  channel_name_pattern VARCHAR(100)  NULL,
  auto_check         TINYINT(1)      NOT NULL DEFAULT 0,  -- contrôle automatique des critères à la fin de la rédaction
  criteria           JSON            NULL,
  form_enabled       TINYINT(1)      NOT NULL DEFAULT 0,
  form_title         VARCHAR(45)     NULL,
  form_questions     JSON            NULL,
  opened_title       VARCHAR(256)    NULL,                -- « modèle » : embed d'ouverture de la candidature
  opened_description TEXT            NULL,
  opened_color       VARCHAR(7)      NULL,
  opened_footer      VARCHAR(2048)   NULL,
  opened_image       VARCHAR(1024)   NULL,
  opened_thumbnail   VARCHAR(1024)   NULL,
  position           INT             NOT NULL DEFAULT 0,
  created_at         DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_cand_categories_guild (guild_id, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cand_candidatures (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  guild_id           BIGINT UNSIGNED NOT NULL,
  category_id        BIGINT UNSIGNED NOT NULL,
  channel_id         BIGINT UNSIGNED NOT NULL,
  applicant_id       BIGINT UNSIGNED NOT NULL,
  status             VARCHAR(20)     NOT NULL DEFAULT 'draft',
  status_reason      VARCHAR(1000)   NULL,
  status_by          BIGINT UNSIGNED NULL,                -- NULL = automatique (contrôle des critères)
  status_at          DATETIME(3)     NOT NULL,
  form_answers       JSON            NULL,
  check_failures     JSON            NULL,
  control_message_id BIGINT UNSIGNED NULL,
  submitted_at       DATETIME(3)     NULL,
  closed_at          DATETIME(3)     NULL,
  channel_deleted    TINYINT(1)      NOT NULL DEFAULT 0,
  created_at         DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_cand_guild_status (guild_id, status),
  KEY idx_cand_applicant (guild_id, applicant_id),
  KEY idx_cand_category (category_id, status),
  KEY idx_cand_channel (channel_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cand_events (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  candidature_id BIGINT UNSIGNED NOT NULL,
  kind           VARCHAR(20)     NOT NULL,                -- opened | submitted | status | category | deleted
  status         VARCHAR(20)     NULL,
  actor_id       BIGINT UNSIGNED NULL,
  detail         VARCHAR(1000)   NULL,
  created_at     DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_cand_events (candidature_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cand_messages (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  candidature_id     BIGINT UNSIGNED NOT NULL,
  message_id         BIGINT UNSIGNED NOT NULL,
  author_id          BIGINT UNSIGNED NOT NULL,
  author_name        VARCHAR(100)    NOT NULL,
  author_avatar      VARCHAR(255)    NULL,
  author_role_color  VARCHAR(7)      NULL,
  author_bot         TINYINT(1)      NOT NULL DEFAULT 0,
  content            TEXT            NULL,
  embeds             JSON            NULL,
  attachments        JSON            NULL,
  created_at         DATETIME(3)     NOT NULL,
  updated_at         DATETIME(3)     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cand_message (message_id),
  KEY idx_cand_messages (candidature_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cand_attachments (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_row_id BIGINT UNSIGNED NOT NULL,
  name           VARCHAR(255)    NOT NULL,
  content_type   VARCHAR(100)    NULL,
  size           INT UNSIGNED    NULL,
  data           LONGBLOB        NOT NULL,
  PRIMARY KEY (id),
  KEY idx_cand_attachments (message_row_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
