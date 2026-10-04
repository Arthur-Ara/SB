'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { slugifyChannelName } = require('../../../src/bot/text');

/** Récupère (ou crée) la catégorie « Prison » du serveur, utilisée par /shadow-ban. */
async function ensurePrisonCategory(service, guild) {
  const settings = await service.settings(guild.id);
  if (settings.prisonCategoryId) {
    const existing = guild.channels.cache.get(settings.prisonCategoryId) ?? (await guild.channels.fetch(settings.prisonCategoryId).catch(() => null));
    if (existing) return existing;
  }
  const category = await guild.channels.create({
    name: 'Prison',
    type: ChannelType.GuildCategory,
    permissionOverwrites: [{ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] }],
  });
  await service.setPrisonCategory(guild.id, category.id);
  return category;
}

/** État actuel (autorisé/refusé/hérité) de la permission ViewChannel pour ce membre sur ce salon. */
function viewChannelState(channel, userId) {
  const overwrite = channel.permissionOverwrites.cache.get(userId);
  if (!overwrite) return null;
  if (overwrite.allow.has(PermissionFlagsBits.ViewChannel)) return true;
  if (overwrite.deny.has(PermissionFlagsBits.ViewChannel)) return false;
  return null;
}

/**
 * Refuse ViewChannel pour `userId` sur tous les salons hors de la catégorie prison, en gardant un
 * instantané de l'état précédent (utile si le membre avait déjà une dérogation manuelle sur un
 * salon) pour pouvoir le restaurer exactement avec `restoreChannelAccess`, plutôt que de tout
 * effacer à la levée du shadow-ban.
 */
async function denyChannelAccess(guild, userId, { prisonChannelId, categoryId, reason }) {
  const previousState = {};
  let denied = 0;
  const others = guild.channels.cache.filter(
    (c) => c.type !== ChannelType.GuildCategory && c.parentId !== categoryId && c.id !== prisonChannelId && c.permissionOverwrites,
  );
  for (const channel of others.values()) {
    try {
      previousState[channel.id] = viewChannelState(channel, userId);
      await channel.permissionOverwrites.edit(userId, { ViewChannel: false }, { reason });
      denied += 1;
    } catch {
      delete previousState[channel.id];
    }
  }
  return { previousState, denied };
}

/**
 * Restaure l'état ViewChannel d'avant le shadow-ban à partir de l'instantané pris par
 * `denyChannelAccess` (au lieu de simplement effacer la dérogation, ce qui perdrait un accès
 * accordé manuellement avant le shadow-ban). Sans instantané pour un salon (shadow-ban posé avant
 * cette mise à jour, ou salon créé après coup), on retire juste ViewChannel sans toucher au reste.
 */
async function restoreChannelAccess(guild, userId, previousState, { prisonChannelId, reason }) {
  let restored = 0;
  const others = guild.channels.cache.filter((c) => c.type !== ChannelType.GuildCategory && c.id !== prisonChannelId && c.permissionOverwrites);
  for (const channel of others.values()) {
    if (!channel.permissionOverwrites.cache.get(userId)) continue;
    try {
      const previous = previousState && channel.id in previousState ? previousState[channel.id] : null;
      await channel.permissionOverwrites.edit(userId, { ViewChannel: previous }, { reason });
      const after = channel.permissionOverwrites.cache.get(userId);
      if (after && after.allow.bitfield === 0n && after.deny.bitfield === 0n) {
        await channel.permissionOverwrites.delete(userId, reason).catch(() => {});
      }
      restored += 1;
    } catch {
      // Salon impossible à restaurer (permissions manquantes…) : on continue les autres.
    }
  }
  return restored;
}

module.exports = { slugifyChannelName, ensurePrisonCategory, denyChannelAccess, restoreChannelAccess };
