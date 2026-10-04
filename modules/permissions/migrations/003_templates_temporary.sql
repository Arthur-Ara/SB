-- Permissions v1.3.0 : accords temporaires (règle supprimée automatiquement à l'échéance) et modèles de
-- permissions réutilisables (créés par l'utilisateur, appliqués à un rôle).

ALTER TABLE permissions_users
  ADD COLUMN expires_at DATETIME(3) NULL,
  ADD KEY idx_pu_expires (expires_at);

ALTER TABLE permissions_roles
  ADD COLUMN expires_at DATETIME(3) NULL,
  ADD KEY idx_pr_expires (expires_at);

ALTER TABLE web_permission_grants
  ADD COLUMN expires_at DATETIME(3) NULL,
  ADD KEY idx_wpg_expires (expires_at);

-- Modèle : instantané des règles d'un rôle (commandes autorisées/bloquées et accès au panel web).
CREATE TABLE IF NOT EXISTS permissions_templates (
  id          INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  guild_id    BIGINT UNSIGNED NOT NULL,
  name        VARCHAR(50)     NOT NULL,
  description VARCHAR(200)    NULL,
  rules       JSON            NOT NULL, -- [{ "command": "ban", "allowed": true }]
  web         JSON            NOT NULL, -- [{ "category": "moderation", "right": "" }]
  created_by  BIGINT UNSIGNED NULL,
  created_at  DATETIME(3)     NOT NULL,
  updated_at  DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_permissions_template (guild_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
