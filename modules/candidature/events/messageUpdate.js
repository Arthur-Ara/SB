'use strict';

const { Events } = require('discord.js');

/** Message modifié dans un salon de candidature : la transcription suit (le contenu final fait foi pour les critères). */
module.exports = {
  event: Events.MessageUpdate,

  async execute(ctx, oldMessage, newMessage) {
    if (!ctx.services.candidatures.isCandidatureChannel(newMessage.channelId)) return;
    const message = newMessage.partial ? await newMessage.fetch().catch(() => null) : newMessage;
    if (!message?.guild) return;
    await ctx.services.candidatures.updateMessage(message.id, message.content || null);
  },
};
