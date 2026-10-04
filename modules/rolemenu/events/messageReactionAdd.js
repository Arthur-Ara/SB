'use strict';

const { Events } = require('discord.js');
const { parseEmoji, reactionKey } = require('../lib/safety');

const NOTICE_LIFETIME_MS = 10_000;

/** Contexte d'une réaction sur un menu : { bundle, option, member, message } ou null si elle ne concerne pas RôleMenu. */
async function resolveReaction(ctx, reaction, user) {
  if (user.bot) return null;
  const guildId = reaction.message.guildId;
  // L'événement n'est pas filtré par serveur (une réaction ne porte pas d'identifiant de serveur) : on le fait ici.
  if (!guildId || !ctx.modules.isEnabledFor('rolemenu', guildId)) return null;
  const { rolemenu: service } = ctx.services;
  const menuId = await service.reactionMenuIdByMessage(reaction.message.id);
  if (!menuId) return null;
  const bundle = await service.bundle(menuId);
  if (!bundle || String(bundle.menu.guild_id) !== guildId) return null;
  const key = reactionKey(reaction.emoji);
  const option = bundle.options.find((o) => parseEmoji(o.emoji)?.key === key);
  if (!option) return null; // autre émoji posé par un membre : on n'y touche pas
  const guild = ctx.client.guilds.cache.get(guildId);
  const member = guild ? await guild.members.fetch(user.id).catch(() => null) : null;
  if (!member) return null;
  return { bundle, option, member, message: reaction.message };
}

module.exports = {
  event: Events.MessageReactionAdd,

  async execute(ctx, reaction, user) {
    const found = await resolveReaction(ctx, reaction, user);
    if (!found) return;
    const { bundle, option, member, message } = found;
    const [result] = await ctx.services.engine.add(member, bundle, option);

    if (result.kind === 'denied' || result.kind === 'error') {
      // Refusé : la réaction est retirée et un court message explique pourquoi (une réaction ne peut pas répondre en privé).
      await reaction.users.remove(user.id).catch(() => {});
      const channel = message.channel ?? (await ctx.client.channels.fetch(message.channelId).catch(() => null));
      const notice = await channel?.send({ content: `<@${user.id}> ❌ ${result.message}`, allowedMentions: { users: [user.id] } }).catch(() => null);
      if (notice) setTimeout(() => notice.delete().catch(() => {}), NOTICE_LIFETIME_MS).unref?.();
      return;
    }

    // Mode « un seul rôle » : les autres réactions du membre sur ce menu sont retirées.
    if (result.kind === 'added' && bundle.menu.mode === 'single') {
      for (const other of result.removed ?? []) {
        const key = parseEmoji(other.emoji)?.key;
        const stale = key ? message.reactions.cache.find((r) => reactionKey(r.emoji) === key) : null;
        if (stale) await stale.users.remove(user.id).catch(() => {});
      }
    }
  },
};
