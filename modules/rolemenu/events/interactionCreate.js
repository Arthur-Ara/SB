'use strict';

const { Events, MessageFlags } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { describe } = require('../lib/engine');

/** Un menu n'est actif que sur le message qu'il a publié (une ancienne copie ne doit plus rien attribuer). */
function activeBundle(bundle, interaction) {
  return bundle && String(bundle.menu.guild_id) === interaction.guildId && String(bundle.menu.message_id) === interaction.message.id;
}

const INACTIVE = 'Ce menu n’est plus actif.';

async function handleButton(ctx, interaction) {
  const { rolemenu: service, engine } = ctx.services;
  const option = await service.getOption(interaction.customId.split(':')[2]);
  const bundle = option ? await service.bundle(option.menu_id) : null;
  if (!activeBundle(bundle, interaction)) return ui.replyError(interaction, INACTIVE, 'RôleMenu', '🎭');
  const current = bundle.options.find((o) => String(o.id) === String(option.id));
  if (!current) return ui.replyError(interaction, 'Cette option n’existe plus.', 'RôleMenu', '🎭');

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const results = await engine.toggle(member, bundle, current);
  await interaction.editReply(ui.message(ui.card({ description: describe(results) })));
}

async function handleSelect(ctx, interaction) {
  const { rolemenu: service, engine } = ctx.services;
  const bundle = await service.bundle(interaction.customId.split(':')[2]);
  if (!activeBundle(bundle, interaction)) return ui.replyError(interaction, INACTIVE, 'RôleMenu', '🎭');

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const known = new Set(bundle.options.map((o) => String(o.id)));
  const selected = interaction.values.filter((value) => known.has(String(value)));
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const results = await engine.sync(member, bundle, selected);
  await interaction.editReply(ui.message(ui.card({ description: describe(results) })));
  // Discord garde la sélection affichée : on renvoie les composants tels quels pour la réinitialiser.
  interaction.message.edit({ components: interaction.message.components }).catch(() => {});
}

module.exports = {
  event: Events.InteractionCreate,

  async execute(ctx, interaction) {
    if (!interaction.inGuild()) return;
    // « ar: » : identifiants des menus publiés avant le renommage en RôleMenu (ils continuent de fonctionner).
    const button = interaction.isButton() && /^(rm|ar):b:/.test(interaction.customId);
    const select = interaction.isStringSelectMenu() && /^(rm|ar):s:/.test(interaction.customId);
    if (!button && !select) return;
    try {
      if (button) await handleButton(ctx, interaction);
      else await handleSelect(ctx, interaction);
    } catch (err) {
      ctx.logger.error('Interaction RôleMenu impossible', err);
      const card = ui.errorCard('Une erreur est survenue, réessaie dans un instant.', 'RôleMenu', '🎭');
      if (interaction.deferred || interaction.replied) await interaction.editReply(ui.message(card)).catch(() => {});
      else await ui.respond(interaction, card, { ephemeral: true }).catch(() => {});
    }
  },
};
