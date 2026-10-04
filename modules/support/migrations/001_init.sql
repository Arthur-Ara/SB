-- Support automatique : un panel publié sur Discord propose des catégories, elles-mêmes composées
-- de sous-catégories et/ou de réponses (arbre, profondeur libre). Une réponse peut proposer un
-- bouton « Créer un ticket » si elle ne suffit pas, ouvrant un type de ticket précis (module
-- Tickets — voir ticket_type_id, aucune contrainte FK réelle : convention déjà suivie ailleurs
-- dans ce projet pour les références inter-modules, voir modules/tickets/lib/service.js).
CREATE TABLE IF NOT EXISTS support_panels (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  guild_id          BIGINT UNSIGNED NOT NULL,
  channel_id        BIGINT UNSIGNED NULL,
  message_id        BIGINT UNSIGNED NULL,
  embed_title       VARCHAR(256)    NULL,
  embed_description TEXT            NULL,
  embed_color       VARCHAR(7)      NULL,
  embed_footer      VARCHAR(2048)   NULL,
  embed_image       VARCHAR(1024)   NULL,
  embed_thumbnail   VARCHAR(1024)   NULL,
  placeholder       VARCHAR(150)    NULL,
  created_at        DATETIME(3)     NOT NULL,
  updated_at        DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_support_panels_guild (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS support_nodes (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  panel_id             BIGINT UNSIGNED NOT NULL,
  parent_id            BIGINT UNSIGNED NULL,
  kind                 ENUM('category','response') NOT NULL DEFAULT 'category',
  position             INT UNSIGNED    NOT NULL DEFAULT 0,
  label                VARCHAR(100)    NOT NULL,
  emoji                VARCHAR(64)     NULL,
  select_description   VARCHAR(100)    NULL,
  embed_title          VARCHAR(256)    NULL,
  embed_description    TEXT            NULL,
  embed_color          VARCHAR(7)      NULL,
  embed_footer         VARCHAR(2048)   NULL,
  embed_image          VARCHAR(1024)   NULL,
  embed_thumbnail      VARCHAR(1024)   NULL,
  allow_ticket         TINYINT(1)      NOT NULL DEFAULT 0,
  ticket_type_id       BIGINT UNSIGNED NULL,
  ticket_extra_message VARCHAR(1000)   NULL,
  created_at           DATETIME(3)     NOT NULL,
  updated_at           DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_support_nodes_panel (panel_id, parent_id, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
