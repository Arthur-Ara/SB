'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const ui = require('../../../src/bot/ui');

/** Raison enregistrée quand le staff confirme une fermeture proposée par le délai d'inactivité. */
const AUTO_CLOSE_REASON = 'Clôture automatique confirmée par le staff : aucune réponse du membre dans le délai configuré.';

/** « 90 » → « 1 h 30 min », « 45 » → « 45 min ». */
function formatMinutes(minutes) {
  const total = Math.max(1, Math.round(Number(minutes) || 0));
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours < 48) return rest ? `${hours} h ${String(rest).padStart(2, '0')}` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} j ${hours % 24} h` : `${days} j`;
}

function autoCloseControls(ticketId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ticket:acyes:${ticketId}`).setLabel('Confirmer la fermeture').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
      new ButtonBuilder().setCustomId(`ticket:acno:${ticketId}`).setLabel('Garder ouvert').setStyle(ButtonStyle.Secondary).setEmoji('↩️'),
    ),
  ];
}

/**
 * Inactivité dépassée : au lieu de fermer d'office, demande confirmation au staff dans le salon du ticket
 * (même présentation qu'une fermeture manuelle : un message du bot avec ses boutons). Le staff concerné
 * est mentionné : celui qui a pris le ticket en charge, sinon les modérateurs du type.
 * @returns {Promise<boolean>} true si la question a bien été postée.
 */
async function askAutoClose(ctx, ticket, type, channel) {
  const staff = ticket.claimed_by ? `<@${ticket.claimed_by}>` : type.mod_role_ids.map((id) => `<@&${id}>`).join(' ');
  const lines = [
    '⏳ **Fermeture automatique : confirmation demandée**',
    `📌 Ticket #${ticket.id} — aucune réponse de <@${ticket.opener_id}> depuis plus de **${formatMinutes(type.auto_close_minutes)}**.`,
    'Un membre du staff doit **confirmer la fermeture** ou garder le ticket ouvert.',
  ];
  if (type.rating_enabled) lines.push('-# Un ticket fermé de cette façon ne déclenche aucune demande de notation.');
  try {
    await channel.send({
      content: staff || undefined,
      ...ui.payload(ui.card({ description: lines.join('\n'), timestamp: true })),
      components: autoCloseControls(ticket.id),
      allowedMentions: { parse: ['users', 'roles'] },
    });
  } catch (err) {
    ctx.logger.warn(`Demande de fermeture automatique du ticket #${ticket.id} impossible`, err.message);
    return false;
  }
  await ctx.services.tickets.markAutoCloseAsked(ticket.id);
  return true;
}

module.exports = { AUTO_CLOSE_REASON, askAutoClose, autoCloseControls };
