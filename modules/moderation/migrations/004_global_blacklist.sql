-- La blacklist devient globale : un seul bannissement par utilisateur, appliqué sur tous les
-- serveurs où le bot est présent (et automatiquement sur ceux rejoints plus tard, ou sur lesquels
-- le membre revient). guild_id est conservé comme « serveur d'origine » (où /blacklist a été
-- lancé), à titre indicatif seulement.
DELETE b1 FROM moderation_blacklist b1
INNER JOIN moderation_blacklist b2 ON b1.user_id = b2.user_id AND b1.guild_id > b2.guild_id;

ALTER TABLE moderation_blacklist
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (user_id);
