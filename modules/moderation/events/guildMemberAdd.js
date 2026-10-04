'use strict';

const { Events } = require('discord.js');
const { blacklistReason } = require('../lib/blacklist');

/** Un membre blacklisté qui rejoint le serveur est immédiatement re-banni. */
module.exports = {
  event: Events.GuildMemberAdd,

  async execute(ctx, member) {
    const { moderation, logs } = ctx.services;
    const entry = await moderation.blacklistEntry(member.id);
    if (!entry) return;
    try {
      await member.ban({ reason: blacklistReason(entry.reason) });
    } catch (err) {
      ctx.logger.warn(`Re-ban du membre blacklisté ${member.id} impossible`, err.message);
      return;
    }
    await logs.action({
      guildId: member.guild.id,
      action: 'ban',
      targetId: member.id,
      executorId: ctx.client.user.id,
      reason: `Blacklist (sanction #${entry.action_id ?? '?'}) : re-banni automatiquement à son retour`,
    });
  },
};
