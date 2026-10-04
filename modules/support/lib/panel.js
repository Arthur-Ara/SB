'use strict';

const { buildEmbed } = require('../../tickets/lib/embed');
const { pickerRow } = require('./components');

async function panelPayload(service, panel) {
  const nodes = await service.listChildren(panel.id, null);
  const embed = buildEmbed({
    title: panel.embed_title,
    description: panel.embed_description,
    color: panel.embed_color,
    footer: panel.embed_footer,
    image: panel.embed_image,
    thumbnail: panel.embed_thumbnail,
  });
  return {
    embeds: embed ? [embed] : [],
    components: nodes.length ? [pickerRow(nodes, panel.placeholder)] : [],
  };
}

/**
 * Publie (ou republie) le message d'un panel dans un salon. Un panel n'a qu'un seul message actif :
 * l'ancien (même salon ou non) est supprimé une fois le nouveau envoyé.
 */
async function publishPanel(ctx, service, panel, channel) {
  const nodes = await service.listChildren(panel.id, null);
  if (!nodes.length) return { error: 'Ajoute au moins une catégorie ou une réponse avant de publier ce panel.' };
  const payload = await panelPayload(service, panel);

  let previous = null;
  if (panel.channel_id && panel.message_id) {
    const oldChannel = ctx.client.channels.cache.get(String(panel.channel_id)) ?? (await ctx.client.channels.fetch(String(panel.channel_id)).catch(() => null));
    previous = oldChannel?.isTextBased() ? await oldChannel.messages.fetch(String(panel.message_id)).catch(() => null) : null;
  }

  const message = await channel.send(payload);
  await service.setPanelMessage(panel.id, channel.id, message.id);
  if (previous && previous.id !== message.id) await previous.delete().catch((err) => ctx.logger.warn(`Ancien message du panel support #${panel.id} non supprimé`, err.message));
  return { message };
}

/** Rafraîchit le message publié d'un panel après modification de son embed ou de son arbre. */
async function refreshPanelMessage(ctx, service, panel) {
  if (!panel?.channel_id || !panel?.message_id) return;
  try {
    const channel = ctx.client.channels.cache.get(panel.channel_id) ?? (await ctx.client.channels.fetch(panel.channel_id).catch(() => null));
    if (!channel?.isTextBased()) return;
    const message = await channel.messages.fetch(panel.message_id).catch(() => null);
    if (!message) return;
    await message.edit(await panelPayload(service, panel));
  } catch (err) {
    ctx.logger.warn(`Rafraîchissement du panel support #${panel.id} impossible`, err.message);
  }
}

module.exports = { panelPayload, publishPanel, refreshPanelMessage };
