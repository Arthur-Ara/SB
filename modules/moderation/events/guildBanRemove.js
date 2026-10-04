'use strict';

const { Events } = require('discord.js');
const { blacklistReason } = require('../lib/blacklist');

/**
 * Ban levé à la main (hors /unblacklist) sur un utilisateur blacklisté : re-banni aussitôt. Sinon, les bans
 * (et bans temporaires) en cours du membre sont clos dans l'historique, même si le débannissement a été fait
 * depuis Discord directement (/unban et le panel les closent déjà en nommant l'auteur).
 */
module.exports = {
  event: Events.GuildBanRemove,

  async execute(ctx, ban) {
    const { moderation, logs } = ctx.services;
    const entry = await moderation.blacklistEntry(ban.user.id);
    if (!entry) {
      await moderation.resolveBans(ban.guild.id, ban.user.id, null);
      return;
    }
    try {
      await ban.guild.members.ban(ban.user.id, { reason: blacklistReason(entry.reason) });
    } catch (err) {
      ctx.logger.warn(`Re-ban de l'utilisateur blacklisté ${ban.user.id} impossible`, err.message);
      return;
    }
    await logs.action({
      guildId: ban.guild.id,
      action: 'ban',
      targetId: ban.user.id,
      executorId: ctx.client.user.id,
      reason: `Blacklist (sanction #${entry.action_id ?? '?'}) : débannissement manuel annulé — utiliser /unblacklist`,
    });
  },
};
