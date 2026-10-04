'use strict';

const { Events } = require('discord.js');

module.exports = {
  event: Events.MessageDelete,
  async execute(ctx, message) {
    const guildId = message.guildId ?? message.guild?.id ?? message.channel?.guildId;
    if (!guildId) return;
    // Auteur inconnu si le message n'était pas en cache : retrouvé en base par le store.
    if (message.author?.bot || message.webhookId) return;
    await ctx.services.store.recordDeletions([
      {
        messageId: message.id,
        guildId,
        channelId: message.channelId,
        userId: message.author?.id ?? null,
        deletedAt: new Date(),
      },
    ]);
  },
};
