'use strict';

const { Events, MessageFlags } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { describe } = require('../lib/engine');
const { selectRow } = require('../lib/message');

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

/** Options du menu dont le membre a le rôle. */
function ownedOptionIds(member, bundle) {
  return bundle.options.filter((o) => member.roles.cache.has(String(o.role_id))).map((o) => String(o.id));
}

/** Réponse éphémère : résultat + sélecteur personnel où les rôles déjà possédés sont cochés. */
function personalReply(interaction, bundle, member, results) {
  const lines = [results.length ? describe(results) : 'ℹ️ Aucun changement.', '', '-# Modifie tes rôles ci-dessous : ceux que tu as déjà sont cochés (décoche pour retirer).'];
  const row = selectRow(interaction.guild, bundle.menu, bundle.options, { personal: true, ownedIds: ownedOptionIds(member, bundle) });
  return { ...ui.message(ui.card({ description: lines.join('\n') })), components: [row] };
}

/**
 * Menu déroulant publié : il est commun à tous et s'affiche vide. En mode « plusieurs rôles », les choix s'ajoutent
 * donc aux rôles déjà possédés (rien n'est retiré par erreur) ; la réponse propose ensuite un sélecteur personnel
 * présélectionné pour retirer ou modifier.
 */
async function handleSelect(ctx, interaction) {
  const { rolemenu: service, engine } = ctx.services;
  const bundle = await service.bundle(interaction.customId.split(':')[2]);
  if (!activeBundle(bundle, interaction)) return ui.replyError(interaction, INACTIVE, 'RôleMenu', '🎭');

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const known = new Set(bundle.options.map((o) => String(o.id)));
  const selected = interaction.values.filter((value) => known.has(String(value)));
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const wanted = bundle.menu.mode === 'single' ? selected : [...new Set([...ownedOptionIds(member, bundle), ...selected])];
  const results = await engine.sync(member, bundle, wanted);
  await interaction.editReply(personalReply(interaction, bundle, member, results));
  // Discord garde la sélection affichée : on renvoie les composants tels quels pour la réinitialiser.
  interaction.message.edit({ components: interaction.message.components }).catch(() => {});
}

/** Sélecteur personnel (réponse éphémère) : la sélection devient exactement l'état voulu. */
async function handlePersonalSelect(ctx, interaction) {
  const { rolemenu: service, engine } = ctx.services;
  const bundle = await service.bundle(interaction.customId.split(':')[2]);
  if (!bundle || String(bundle.menu.guild_id) !== interaction.guildId || !bundle.menu.message_id) {
    return interaction.update({ ...ui.message(ui.errorCard(INACTIVE, 'RôleMenu', '🎭')), components: [] });
  }
  await interaction.deferUpdate();
  const known = new Set(bundle.options.map((o) => String(o.id)));
  const selected = interaction.values.filter((value) => known.has(String(value)));
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const results = await engine.sync(member, bundle, selected);
  await interaction.editReply(personalReply(interaction, bundle, member, results));
}

module.exports = {
  event: Events.InteractionCreate,

  async execute(ctx, interaction) {
    if (!interaction.inGuild()) return;
    // « ar: » : identifiants des menus publiés avant le renommage en RôleMenu (ils continuent de fonctionner).
    const button = interaction.isButton() && /^(rm|ar):b:/.test(interaction.customId);
    const select = interaction.isStringSelectMenu() && /^(rm|ar):s:/.test(interaction.customId);
    const personal = interaction.isStringSelectMenu() && /^rm:p:/.test(interaction.customId);
    if (!button && !select && !personal) return;
    try {
      if (button) await handleButton(ctx, interaction);
      else if (personal) await handlePersonalSelect(ctx, interaction);
      else await handleSelect(ctx, interaction);
    } catch (err) {
      ctx.logger.error('Interaction RôleMenu impossible', err);
      const card = ui.errorCard('Une erreur est survenue, réessaie dans un instant.', 'RôleMenu', '🎭');
      if (interaction.deferred || interaction.replied) await interaction.editReply(ui.message(card)).catch(() => {});
      else await ui.respond(interaction, card, { ephemeral: true }).catch(() => {});
    }
  },
};
