'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const ui = require('../../../src/bot/ui');

const STARS = [1, 2, 3, 4, 5];

function ratingRow(ticketId, { disabled = false } = {}) {
  return new ActionRowBuilder().addComponents(
    STARS.map((n) =>
      new ButtonBuilder().setCustomId(`ticket:rate:${ticketId}:${n}`).setLabel(`${n} ⭐`).setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    ),
  );
}

/** Seconde ligne : décliner la notation (rien n'est enregistré, la demande n'est jamais renvoyée). */
function skipRow(ticketId, { disabled = false } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket:rate:${ticketId}:0`).setLabel('Ne pas répondre').setStyle(ButtonStyle.Secondary).setEmoji('🙅').setDisabled(disabled),
  );
}

/** Invite l'ouvreur à noter son ticket (1 à 5 étoiles) en MP, une fois fermé — facultatif, jamais relancé. */
async function sendRatingPrompt(ctx, ticket, type) {
  const user = await ctx.client.users.fetch(ticket.opener_id).catch(() => null);
  if (!user) return;
  const guild = ctx.client.guilds.cache.get(ticket.guild_id);
  await user
    .send({
      ...ui.payload(
        ui.card({
          emoji: '⭐',
          title: 'Ton avis compte !',
          description: `Ton ticket **${type?.label ?? `#${ticket.id}`}** sur **${guild?.name ?? 'le serveur'}** a été fermé.\nSi tu le souhaites, note le support reçu :`,
        }),
      ),
      components: [ratingRow(ticket.id), skipRow(ticket.id)],
    })
    .catch(() => {});
}

module.exports = { ratingRow, skipRow, sendRatingPrompt };
