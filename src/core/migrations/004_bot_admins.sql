-- Admins globaux du bot (/admin) : mêmes droits que les propriétaires du .env sur tous les serveurs et tous les
-- modules (dont l'accès au panel web), sans pouvoir eux-mêmes ajouter ou retirer d'admins.
CREATE TABLE IF NOT EXISTS bot_admins (
  user_id    BIGINT UNSIGNED NOT NULL,
  added_by   BIGINT UNSIGNED NOT NULL,
  added_at   DATETIME(3)     NOT NULL,
  PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
