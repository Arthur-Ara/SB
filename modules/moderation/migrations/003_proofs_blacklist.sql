-- ════════════════════════════════════════════════════════════════════════
-- Modération : preuves attachées aux sanctions + blacklist
-- ════════════════════════════════════════════════════════════════════════

-- Nouveaux types d'action journalisés (blacklist / unblacklist).
ALTER TABLE moderation_actions
  MODIFY COLUMN action ENUM('ban','unban','kick','tempmute','unmute','tempvocmute','untempvocmute','warn','removewarn',
                            'shadowban','unshadowban','lock','unlock','lockall','unlockall','clear',
                            'slowmode','purge','blacklist','unblacklist') NOT NULL;

-- Messages Discord attachés en preuve d'une sanction (l'identifiant de la sanction est moderation_actions.id).
-- Le contenu est copié au moment de l'ajout : la preuve reste lisible même si le message est supprimé ensuite.
CREATE TABLE IF NOT EXISTS moderation_proofs (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  guild_id    BIGINT UNSIGNED NOT NULL,
  action_id   BIGINT UNSIGNED NOT NULL,
  channel_id  BIGINT UNSIGNED NOT NULL,
  message_id  BIGINT UNSIGNED NOT NULL,
  author_id   BIGINT UNSIGNED NULL,
  content     TEXT            NULL,
  attachments JSON            NULL,      -- [url, …] des pièces jointes du message
  added_by    BIGINT UNSIGNED NOT NULL,
  created_at  DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_proof_action (action_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Blacklist : bannissement « permanent » ré-appliqué automatiquement si le membre revient
-- (ou si son ban est levé à la main), jusqu'à /unblacklist.
CREATE TABLE IF NOT EXISTS moderation_blacklist (
  guild_id    BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  action_id   BIGINT UNSIGNED NULL,
  executor_id BIGINT UNSIGNED NOT NULL,
  reason      VARCHAR(512)    NULL,
  created_at  DATETIME(3)     NOT NULL,
  PRIMARY KEY (guild_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
