'use strict';

const { Events } = require('discord.js');

/**
 * Message modifié : met à jour le transcript. Sert surtout aux aperçus de liens (GIF, images), que
 * Discord ajoute quelques instants après l'envoi, et aux modifications de contenu.
 */
module.exports = {
  event: Events.MessageUpdate,

  async execute(ctx, oldMessage, newMessage) {
    // Avant toute récupération (un message partiel coûterait un appel à Discord) : seuls les salons de tickets comptent.
    if (!ctx.services.tickets.isTicketChannel(newMessage.channelId)) return;
    const message = newMessage.partial ? await newMessage.fetch().catch(() => null) : newMessage;
    if (!message?.guild) return;
    const ticket = await ctx.services.tickets.getTicketByChannel(message.channel.id);
    if (!ticket) return;
    if (message.webhookId && String(message.webhookId) === String(ticket.webhook_id)) return;
    const type = await ctx.services.tickets.getType(ticket.type_id);
    if (!type || (!type.auto_transcript && !type.live_transcript)) return;
    await ctx.services.tickets.updateMessageByDiscordId(message.id, {
      content: message.content || null,
      embeds: message.embeds.map((e) => e.toJSON()),
    });
  },
};
