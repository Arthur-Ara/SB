'use strict';

const { Events } = require('discord.js');

module.exports = {
  event: Events.MessageBulkDelete,
  async execute(ctx, messages, channel) {
    const guildId = channel?.guildId;
    if (!guildId) return;
    const now = new Date();
    const deletions = [...messages.values()]
      .filter((message) => !message.author?.bot && !message.webhookId)
      .map((message) => ({
        messageId: message.id,
        guildId,
        channelId: channel.id,
        userId: message.author?.id ?? null,
        deletedAt: now,
      }));
    await ctx.services.store.recordDeletions(deletions);
  },
};
