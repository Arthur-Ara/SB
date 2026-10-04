'use strict';

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { historyItem, actionCard } = require('../lib/format');
const { captureProof, proofItem } = require('../lib/proofs');
const { editSanction, revokeSanction } = require('../lib/sanctions');
const { parseDuration } = require('../../../src/core/duration');

/** Détail d'une sanction (par identifiant) : cible, auteur, raison, durée et preuves attachées. */
async function sanctionCard(moderation, guildId, row, client) {
  const proofs = await moderation.proofs(guildId, row.id);
  return ui.card({
    title: `🔎 Sanction n°${row.id}`,
    body: [
      historyItem(row, { client, proofCount: proofs.length }),
      ...proofs.map((p) => proofItem(guildId, p, client)),
      proofs.length ? null : '*Aucune preuve attachée.*',
    ],
  });
}

module.exports = {
  permission: { default: 'admin' },

  data: new SlashCommandBuilder()
    .setName('sanction')
    .setDescription('Consulter, modifier ou annuler une sanction et gérer ses preuves')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName('voir')
        .setDescription('Afficher une sanction et ses preuves')
        .addIntegerOption((o) => o.setName('id').setDescription('Identifiant de la sanction (#…)').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName('preuve-ajouter')
        .setDescription('Attacher un message Discord en preuve d’une sanction')
        .addIntegerOption((o) => o.setName('id').setDescription('Identifiant de la sanction (#…)').setRequired(true).setMinValue(1))
        .addStringOption((o) => o.setName('lien').setDescription('Lien du message (clic droit → Copier le lien du message)').setRequired(true).setMaxLength(200)),
    )
    .addSubcommand((s) =>
      s
        .setName('preuve-retirer')
        .setDescription('Retirer une preuve d’une sanction')
        .addIntegerOption((o) => o.setName('id').setDescription('Identifiant de la sanction (#…)').setRequired(true).setMinValue(1))
        .addIntegerOption((o) => o.setName('preuve').setDescription('Numéro de la preuve à retirer').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName('modifier')
        .setDescription('Modifier la raison ou la durée d’une sanction publiée')
        .addIntegerOption((o) => o.setName('id').setDescription('Identifiant de la sanction (#…)').setRequired(true).setMinValue(1))
        .addStringOption((o) => o.setName('raison').setDescription('Nouvelle raison').setMaxLength(512))
        .addStringOption((o) => o.setName('duree').setDescription('Nouvelle durée totale : 30m, 12h, 7j… (sanctions temporaires)').setMaxLength(20)),
    )
    .addSubcommand((s) =>
      s
        .setName('annuler')
        .setDescription('Annuler une sanction publiée (la lève et la marque comme annulée)')
        .addIntegerOption((o) => o.setName('id').setDescription('Identifiant de la sanction (#…)').setRequired(true).setMinValue(1))
        .addStringOption((o) => o.setName('raison').setDescription('Raison de l’annulation').setMaxLength(512)),
    ),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const { moderation } = ctx.services;
    const id = interaction.options.getInteger('id', true);
    const row = await moderation.get(guild.id, id);
    if (!row) return ui.replyError(interaction, `Aucune sanction #${id} sur ce serveur.`, 'Introuvable', '🔎');

    const sub = interaction.options.getSubcommand();
    if (sub === 'voir') {
      return ui.respond(interaction, await sanctionCard(moderation, guild.id, row, ctx.client), { ephemeral: true });
    }

    if (sub === 'modifier') {
      const reason = interaction.options.getString('raison');
      const durationText = interaction.options.getString('duree');
      if (reason === null && durationText === null) return ui.replyError(interaction, 'Indique une nouvelle raison et/ou une nouvelle durée.', 'Rien à modifier', '✏️');
      const durationS = durationText ? parseDuration(durationText) : undefined;
      if (durationText && !durationS) return ui.replyError(interaction, 'Durée invalide : par exemple `30m`, `12h` ou `7j`.', 'Durée invalide', '✏️');
      const result = await editSanction(ctx.services, guild, row, { reason: reason ?? undefined, durationS }, interaction.user.id);
      if (result.error) return ui.replyError(interaction, result.error, 'Modification impossible', '✏️');
      await ctx.services.logs.send(guild.id, ui.card({ description: `✏️ <@${interaction.user.id}> a modifié la sanction \`#${id}\`\n${result.changes.join('\n')}`, timestamp: true }));
      return ui.respond(interaction, await sanctionCard(moderation, guild.id, await moderation.get(guild.id, id), ctx.client), { ephemeral: true });
    }

    if (sub === 'annuler') {
      const reason = interaction.options.getString('raison');
      const result = await revokeSanction(ctx.services, guild, row, interaction.user.id, reason);
      if (result.error) return ui.replyError(interaction, result.error, 'Annulation impossible', '↩️');
      await ctx.services.logs.action({ guildId: guild.id, action: result.inverse, targetId: row.target_id, executorId: interaction.user.id, reason: `Annulation de la sanction #${id}${reason ? ` : ${reason}` : ''}` });
      return ui.respond(interaction, actionCard(result.inverse, `Sanction **#${id}** annulée.`, [{ name: 'Raison', value: reason ?? '—' }]), { ephemeral: true });
    }

    if (sub === 'preuve-ajouter') {
      const { proof, error } = await captureProof(guild, interaction.options.getString('lien', true), interaction.member);
      if (error) return ui.replyError(interaction, error, 'Preuve invalide', '🔎');
      const proofId = await moderation.addProof(guild.id, id, proof, interaction.user.id);
      await ctx.services.logs.send(guild.id, ui.card({ description: `🔎 <@${interaction.user.id}> a ajouté la preuve n°${proofId} à la sanction \`#${id}\` — [message](https://discord.com/channels/${guild.id}/${proof.channelId}/${proof.messageId})`, timestamp: true }));
      return ui.respond(interaction, await sanctionCard(moderation, guild.id, row, ctx.client), { ephemeral: true });
    }

    const proofId = interaction.options.getInteger('preuve', true);
    const removed = await moderation.removeProof(guild.id, id, proofId);
    if (!removed) return ui.replyError(interaction, `La sanction #${id} n’a pas de preuve n°${proofId}.`, 'Introuvable', '🔎');
    await ctx.services.logs.send(guild.id, ui.card({ description: `🔎 <@${interaction.user.id}> a retiré la preuve n°${proofId} de la sanction \`#${id}\`.`, timestamp: true }));
    return ui.respond(interaction, await sanctionCard(moderation, guild.id, row, ctx.client), { ephemeral: true });
  },
};
