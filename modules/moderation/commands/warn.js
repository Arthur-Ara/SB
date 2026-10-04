'use strict';

const { SlashCommandBuilder, InteractionContextType, MessageFlags } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { resolveTarget } = require('../lib/guard');
const { actionCard, maybeNotify, dmNote, attachProof } = require('../lib/format');
const { addSanctionOptions, resolveProof } = require('../lib/proofs');
const { applyWarnRules } = require('../lib/sanctions');

module.exports = {
  permission: { default: 'admin' },

  data: addSanctionOptions(
    new SlashCommandBuilder()
      .setName('warn')
      .setDescription('Avertir un membre (conservé dans son historique)')
      .setContexts(InteractionContextType.Guild)
      .addUserOption((o) => o.setName('user').setDescription('Membre concerné').setRequired(true))
      .addStringOption((o) => o.setName('raison').setDescription('Raison de l’avertissement').setRequired(true).setMaxLength(512)),
  ),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const reason = interaction.options.getString('raison', true);

    const { user, error } = await resolveTarget(interaction);
    if (error) return ui.replyError(interaction, error, 'Action impossible', '⚠️');

    const { proof, error: proofError } = await resolveProof(interaction);
    if (proofError) return ui.replyError(interaction, proofError, 'Preuve invalide', '🔎');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const dmSent = await maybeNotify(interaction, user, guild.name, 'warn', reason);
    const id = await ctx.services.moderation.record({ guildId: guild.id, action: 'warn', targetId: user.id, executorId: interaction.user.id, reason });
    const count = await ctx.services.moderation.warnCount(guild.id, user.id);
    const proofFields = await attachProof(ctx.services.moderation, guild.id, id, proof, interaction.user.id);
    await ctx.services.logs.action({ guildId: guild.id, action: 'warn', targetId: user.id, executorId: interaction.user.id, reason, id, proof });
    const automatic = await applyWarnRules(ctx.services, guild, user.id, ctx.client);

    await ui.respond(
      interaction,
      actionCard('warn', `<@${user.id}> a été averti.${dmNote(dmSent)}`, [
        { name: 'Raison', value: reason },
        { name: 'Avertissements actifs', value: String(count) },
        { name: 'Sanction', value: `#${id}` },
        ...proofFields,
        ...(automatic ? [{ name: 'Palier atteint', value: automatic }] : []),
      ]),
    );
  },
};
