'use strict';

const ui = require('../../../src/bot/ui');
const { syncChannelName, desiredCategoryId, refreshLists, moveChannel } = require('./lifecycle');

function tagLabel(tag) {
  return `${tag.emoji ? `${tag.emoji} ` : ''}${tag.name}`;
}

/**
 * Pose ou retire une étiquette sur un ticket (commande /ticket tag et panel web), puis applique ses effets :
 * - catégorie Discord : le salon va dans celle de sa plus prioritaire étiquette qui en impose une, sinon revient
 *   dans celle de son type ;
 * - préfixe : le nom du salon est recalculé (préfixes de toutes ses étiquettes, par priorité) ;
 * - mention : à la pose seulement, les rôles réglés sur l'étiquette sont mentionnés dans le ticket.
 * Les listes automatiques (/ticket autolist) et le journal suivent. Renvoie le nouvel état (true = posée).
 */
async function applyTicketTag(ctx, { guild, ticket, type, tag, on = null, executorId, viaWeb = false }) {
  const { tickets } = ctx.services;
  const wanted = on ?? !(await tickets.ticketHasTag(ticket.id, tag.id));
  await tickets.setTicketTag(ticket.id, tag.id, wanted, executorId);

  const channel = guild.channels.cache.get(String(ticket.channel_id));
  if (channel && ticket.status === 'open' && type) {
    const tags = (await tickets.tagsForTickets([ticket.id])).get(String(ticket.id)) ?? [];
    const parentId = desiredCategoryId(guild, type, tags) ?? (type.category_id ? String(type.category_id) : null);
    if (parentId && guild.channels.cache.has(parentId)) {
      await moveChannel(channel, parentId, `Étiquette « ${tag.name} » du ticket #${ticket.id}`).catch((err) =>
        ctx.logger?.warn(`Déplacement du ticket #${ticket.id} impossible`, err.message),
      );
    }
    if (tag.channel_prefix) syncChannelName(ctx, channel, type, ticket, ticket.claimed_by ? 'claimed' : 'open', { force: true });
    if (wanted) {
      const mentions = (tag.mention_role_ids ?? []).map((id) => `<@&${id}>`).join(' ');
      await channel
        .send({
          content: mentions || undefined,
          ...ui.payload(ui.card({ description: `🏷️ Étiquette **${tagLabel(tag)}** ajoutée par <@${executorId}>${viaWeb ? ' (panel web)' : ''}.` })),
          allowedMentions: { parse: ['roles'] },
        })
        .catch(() => {});
    }
  }

  await ctx.services.logs.event(guild, {
    emoji: '🏷️',
    label: `${wanted ? 'Étiquette ajoutée' : 'Étiquette retirée'} : ${tagLabel(tag)}${viaWeb ? ' (panel web)' : ''}`,
    ticket,
    type,
    executorId,
  });
  refreshLists(ctx, guild.id);
  return wanted;
}

module.exports = { applyTicketTag, tagLabel };
