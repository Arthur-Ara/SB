-- Candidatures v1.5.1 : plusieurs panels par serveur (un salon chacun), comme les tickets. Chaque catégorie de
-- candidature appartient à un panel. Le panel unique des réglages (cand_settings.panel_*) devient le panel n° 1 du
-- serveur et reçoit toutes ses catégories existantes ; ces colonnes ne sont plus lues.

CREATE TABLE IF NOT EXISTS cand_panels (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  guild_id    BIGINT UNSIGNED NOT NULL,
  channel_id  BIGINT UNSIGNED NULL,                -- salon de publication (NULL tant que non publié)
  message_id  BIGINT UNSIGNED NULL,
  style       VARCHAR(10)     NOT NULL DEFAULT 'buttons',
  title       VARCHAR(256)    NULL,
  description TEXT            NULL,
  color       VARCHAR(7)      NULL,
  footer      VARCHAR(2048)   NULL,
  image       VARCHAR(1024)   NULL,
  thumbnail   VARCHAR(1024)   NULL,
  created_at  DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_cand_panels_guild (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE cand_categories
  ADD COLUMN panel_id BIGINT UNSIGNED NULL AFTER guild_id,
  ADD KEY idx_cand_categories_panel (panel_id, position);

INSERT INTO cand_panels (guild_id, channel_id, message_id, style, title, description, color, footer, image, thumbnail, created_at)
SELECT g.guild_id, s.panel_channel_id, s.panel_message_id, COALESCE(s.panel_style, 'buttons'), s.panel_title, s.panel_description,
       s.panel_color, s.panel_footer, s.panel_image, s.panel_thumbnail, UTC_TIMESTAMP(3)
  FROM (SELECT DISTINCT guild_id FROM cand_categories) g
  LEFT JOIN cand_settings s ON s.guild_id = g.guild_id;

UPDATE cand_categories c
  JOIN cand_panels p ON p.guild_id = c.guild_id
   SET c.panel_id = p.id
 WHERE c.panel_id IS NULL;
