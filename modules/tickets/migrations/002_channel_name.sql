-- Format configurable du nom des salons de ticket, par type.
-- Placeholders disponibles côté application : {number} {user} {type} — voir lib/channelName.js.
ALTER TABLE ticket_types
  ADD COLUMN channel_name_pattern VARCHAR(100) NULL AFTER select_description;
