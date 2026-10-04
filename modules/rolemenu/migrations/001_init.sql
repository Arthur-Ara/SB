-- ════════════════════════════════════════════════════════════════════════
-- Module RôleMenu — menus de rôles (réactions / boutons / menu déroulant)
-- et conditions d'accès. Dates en UTC.
-- Ce module s'appelait « Autorôle » : la fin de ce fichier reprend automatiquement
-- la configuration déjà enregistrée sous l'ancien nom (tables autorole_*, activation par
-- serveur, règles /permission, droits du panel web). Sans ancien module, elle ne fait rien.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS rolemenu_settings (
  guild_id       BIGINT UNSIGNED NOT NULL,
  log_channel_id BIGINT UNSIGNED NULL,
  updated_at     DATETIME(3)     NOT NULL,
  PRIMARY KEY (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Un menu = un message publié, avec une liste d'options (rôles)
CREATE TABLE IF NOT EXISTS rolemenu_menus (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  guild_id          BIGINT UNSIGNED NOT NULL,
  name              VARCHAR(100)    NOT NULL,
  type              ENUM('reaction','button','select') NOT NULL DEFAULT 'button',
  mode              ENUM('multiple','single') NOT NULL DEFAULT 'multiple',   -- single = un seul rôle de la liste
  max_selected      SMALLINT UNSIGNED NOT NULL DEFAULT 0,                    -- mode multiple : 0 = illimité
  removable         TINYINT(1)      NOT NULL DEFAULT 1,                      -- le membre peut-il se retirer le rôle ?
  placeholder       VARCHAR(150)    NULL,
  channel_id        BIGINT UNSIGNED NULL,
  message_id        BIGINT UNSIGNED NULL,
  embed_title       VARCHAR(256)    NULL,
  embed_description TEXT            NULL,
  embed_color       VARCHAR(16)     NULL,
  embed_footer      VARCHAR(2048)   NULL,
  embed_image       VARCHAR(512)    NULL,
  embed_thumbnail   VARCHAR(512)    NULL,
  created_at        DATETIME(3)     NOT NULL,
  updated_at        DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_rmm_guild (guild_id),
  KEY idx_rmm_message (message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rolemenu_options (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  menu_id     BIGINT UNSIGNED NOT NULL,
  role_id     BIGINT UNSIGNED NOT NULL,
  label       VARCHAR(80)     NULL,
  emoji       VARCHAR(80)     NULL,       -- émoji Unicode ou personnalisé (<:nom:id>)
  description VARCHAR(100)    NULL,       -- affichée dans le menu déroulant
  style       ENUM('primary','secondary','success','danger') NOT NULL DEFAULT 'secondary',
  position    INT             NOT NULL DEFAULT 0,
  created_at  DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rmo_menu_role (menu_id, role_id),
  KEY idx_rmo_menu (menu_id, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Conditions d'accès (toutes doivent être remplies) : sur tout un menu (option_id NULL) ou sur une option.
-- `type` renvoie au registre de conditions (rôles, ancienneté… et, plus tard, niveau, invitations).
CREATE TABLE IF NOT EXISTS rolemenu_conditions (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  menu_id    BIGINT UNSIGNED NOT NULL,
  option_id  BIGINT UNSIGNED NULL,
  type       VARCHAR(32)     NOT NULL,
  params     TEXT            NULL,        -- JSON
  created_at DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_rmc_menu (menu_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Reprise depuis l'ancien module « Autorôle » (sans effet s'il n'a jamais existé) ──────────────
-- Chaque reprise est une instruction préparée gardée par un test sur information_schema :
-- elle ne s'exécute que si la table source existe et ne touche jamais aux données déjà reprises.

-- Menus (mêmes identifiants : les messages déjà publiés restent valides), options, conditions, réglages
SET @src = (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'autorole_menus');
SET @sql = IF(@src > 0,
  'INSERT IGNORE INTO rolemenu_menus (id, guild_id, name, type, mode, max_selected, removable, placeholder, channel_id, message_id, embed_title, embed_description, embed_color, embed_footer, embed_image, embed_thumbnail, created_at, updated_at) SELECT id, guild_id, name, type, mode, max_selected, removable, placeholder, channel_id, message_id, embed_title, embed_description, embed_color, embed_footer, embed_image, embed_thumbnail, created_at, updated_at FROM autorole_menus',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @src = (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'autorole_options');
SET @sql = IF(@src > 0,
  'INSERT IGNORE INTO rolemenu_options (id, menu_id, role_id, label, emoji, description, style, position, created_at) SELECT id, menu_id, role_id, label, emoji, description, style, position, created_at FROM autorole_options',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @src = (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'autorole_conditions');
SET @sql = IF(@src > 0,
  'INSERT IGNORE INTO rolemenu_conditions (id, menu_id, option_id, type, params, created_at) SELECT id, menu_id, option_id, type, params, created_at FROM autorole_conditions',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @src = (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'autorole_settings');
SET @sql = IF(@src > 0,
  'INSERT IGNORE INTO rolemenu_settings (guild_id, log_channel_id, updated_at) SELECT guild_id, log_channel_id, updated_at FROM autorole_settings',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Activation par serveur (/modules) : table du cœur, toujours présente
INSERT IGNORE INTO guild_modules (guild_id, module, enabled, updated_by, updated_at)
  SELECT guild_id, 'rolemenu', enabled, updated_by, updated_at FROM guild_modules WHERE module = 'autorole';

-- Règles /permission sur la commande renommée, et droits du panel web (tables du module Permissions)
SET @src = (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'permissions_roles');
SET @sql = IF(@src > 0, 'UPDATE IGNORE permissions_roles SET command_name = ''rolemenu'' WHERE command_name = ''autorole''', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @src = (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'permissions_users');
SET @sql = IF(@src > 0, 'UPDATE IGNORE permissions_users SET command_name = ''rolemenu'' WHERE command_name = ''autorole''', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @src = (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'permissions_public');
SET @sql = IF(@src > 0, 'UPDATE IGNORE permissions_public SET command_name = ''rolemenu'' WHERE command_name = ''autorole''', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @src = (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'web_permission_grants');
SET @sql = IF(@src > 0, 'UPDATE IGNORE web_permission_grants SET category = ''rolemenu'' WHERE category = ''autorole''', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
