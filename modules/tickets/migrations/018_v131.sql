-- Tickets v1.3.1 : prise en charge obligatoire séparée de la notation, effets des étiquettes, modmail traité
-- uniquement depuis le panel, listes automatiques des tickets ouverts.

-- « Obliger à prendre en charge pour répondre » devient une option à part entière. Jusqu'ici elle découlait de la
-- notation : les types qui avaient la notation activée gardent exactement le même comportement.
ALTER TABLE ticket_types
  ADD COLUMN claim_required TINYINT(1) NOT NULL DEFAULT 0;
UPDATE ticket_types SET claim_required = rating_enabled;

-- Étiquettes : la position sert désormais de priorité (0 = la plus prioritaire). Effets facultatifs à la pose :
-- déplacement du salon dans une autre catégorie Discord, mention de rôles, préfixe ajouté au nom du salon.
ALTER TABLE ticket_tags
  ADD COLUMN category_id      BIGINT UNSIGNED NULL,
  ADD COLUMN mention_role_ids JSON            NULL,
  ADD COLUMN channel_prefix   VARCHAR(20)     NULL;

-- Catégorie modmail « panel uniquement » : aucun salon Discord, le staff lit et répond depuis le panel web.
ALTER TABLE modmail_categories
  ADD COLUMN panel_only TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE modmail_threads
  MODIFY COLUMN channel_id BIGINT UNSIGNED NULL;

-- Messages « liste des tickets » publiés par /ticket autolist, tenus à jour à chaque ouverture, prise en charge,
-- fermeture, transfert ou changement d'étiquette.
CREATE TABLE IF NOT EXISTS ticket_autolists (
  id         INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  guild_id   BIGINT UNSIGNED NOT NULL,
  channel_id BIGINT UNSIGNED NOT NULL,
  message_id BIGINT UNSIGNED NOT NULL,
  type_id    INT UNSIGNED    NULL, -- NULL = tous les types
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_autolists_guild (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
