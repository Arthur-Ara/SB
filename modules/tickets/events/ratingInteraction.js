'use strict';

const { Events } = require('discord.js');
const ui = require('../../../src/bot/ui');

/** Clic sur une étoile de notation (message privé, envoyé à la fermeture d'un ticket — voir lib/rating.js). */
module.exports = {
  event: Events.InteractionCreate,

  async execute(ctx, interaction) {
    if (!interaction.isButton() || !interaction.customId.startsWith('ticket:rate:')) return;
    const [, , ticketId, starsRaw] = interaction.customId.split(':');
    const stars = Number(starsRaw);
    if (!Number.isInteger(stars) || stars < 0 || stars > 5) return;

    try {
      // « Ne pas répondre » (0) : la notation est déclinée, rien n'est enregistré ni relancé.
      if (stars === 0) {
        await interaction
          .update({ ...ui.payload(ui.card({ emoji: '🙅', description: 'Pas de souci, aucune note n’est enregistrée. Merci !' })), components: [] })
          .catch(() => {});
        return;
      }

      const ticket = await ctx.services.tickets.getTicket(ticketId);
      if (!ticket) {
        await interaction.update({ components: [] }).catch(() => {});
        return;
      }
      if (ticket.rating_stars) {
        await interaction
          .update({ ...ui.payload(ui.card({ emoji: '⭐', description: `Tu as déjà noté ce ticket : ${'⭐'.repeat(ticket.rating_stars)}.` })), components: [] })
          .catch(() => {});
        return;
      }

      await ctx.services.tickets.setRating(ticket.id, stars);
      await interaction.update({
        ...ui.payload(ui.successCard('Merci pour ton retour !', `Note enregistrée : ${'⭐'.repeat(stars)}${'☆'.repeat(5 - stars)}.`, '⭐')),
        components: [],
      });

      const guild = ctx.client.guilds.cache.get(ticket.guild_id);
      if (guild) {
        const type = await ctx.services.tickets.getType(ticket.type_id);
        await ctx.services.logs.rated(guild, ticket, type, stars);
      }
    } catch (err) {
      ctx.logger.error('Notation de ticket impossible', err);
      await ui.replyError(interaction, 'Une erreur est survenue.').catch(() => {});
    }
  },
};
