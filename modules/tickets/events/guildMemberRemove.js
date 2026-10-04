'use strict';

const { Events } = require('discord.js');
const { closeTicket } = require('../lib/lifecycle');

/**
 * Un membre quitte le serveur : ses tickets ouverts dont le type a l'option « fermer si le membre
 * quitte le serveur » sont fermés automatiquement, et son éventuel fil modmail aussi.
 */
module.exports = {
  event: Events.GuildMemberRemove,

  async execute(ctx, member) {
    const guild = member.guild;
    for (const ticket of await ctx.services.tickets.openTicketsByOpener(guild.id, member.id)) {
      try {
        const type = await ctx.services.tickets.getType(ticket.type_id);
        if (!type?.close_on_leave) continue;
        const channel = guild.channels.cache.get(ticket.channel_id);
        if (!channel) continue;
        await closeTicket(ctx, { ticket, type, channel, closedBy: null, reason: 'Fermeture automatique : le membre a quitté le serveur.', auto: true });
      } catch (err) {
        ctx.logger.warn(`Fermeture du ticket #${ticket.id} après départ du membre impossible`, err.message);
      }
    }

    const thread = await ctx.services.tickets.openModmailForUser(guild.id, member.id);
    if (thread) {
      const { closeModmail } = require('../lib/modmail');
      await closeModmail(ctx, thread, { closedBy: null, reason: 'Le membre a quitté le serveur.', notifyUser: false }).catch((err) =>
        ctx.logger.warn(`Fermeture du modmail #${thread.id} impossible`, err.message),
      );
    }
  },
};
