-- Instantané de l'état ViewChannel (par salon) d'avant le shadow-ban, pour que /unshadow-ban
-- restaure précisément cet état au lieu d'effacer une dérogation manuelle préexistante.
ALTER TABLE moderation_shadowbans
  ADD COLUMN previous_state JSON NULL AFTER prison_channel_id;
