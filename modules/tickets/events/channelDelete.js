'use strict';

const { Events } = require('discord.js');
const { closeModmail } = require('../lib/modmail');

/**
 * Salon supprimé manuellement (hors du bot) : un ticket ou un fil modmail encore ouvert ne doit pas rester
 * « ouvert » en base — sinon, pour le modmail, le membre ne pourrait plus jamais en ouvrir un nouveau.
 */
module.exports = {
  event: Events.ChannelDelete,

  async execute(ctx, channel) {
    if (!channel.guild) return;
    const { tickets } = ctx.services;

    const thread = await tickets.modmailByChannel(channel.id);
    if (thread) {
      await closeModmail(ctx, thread, { closedBy: null, reason: 'Salon du fil supprimé manuellement.', notifyUser: true });
      return;
    }

    if (!tickets.isTicketChannel(channel.id)) return;
    const ticket = await tickets.getTicketByChannel(channel.id);
    // `deleted_at` déjà posé : suppression faite par le bot (deleteTicket), l'archive est déjà publiée.
    if (!ticket || ticket.deleted_at) return;
    const type = await tickets.getType(ticket.type_id);
    if (ticket.status === 'open') {
      await tickets.closeTicket(ticket.id, { reason: 'Salon supprimé manuellement', closedBy: null });
      await tickets.recordEvent(ticket.id, 'closed', null, 'Salon supprimé manuellement (hors du bot)');
    }
    await tickets.recordEvent(ticket.id, 'deleted', null, null);
    await tickets.markDeleted(ticket.id);
    const events = await tickets.listEvents(ticket.id);
    await ctx.services.logs.archived(channel.guild, ticket, type, events, { deletedBy: null, channelName: channel.name });
    ctx.services.autolist?.refresh(channel.guild.id);
  },
};
