'use strict';

const { SlashCommandBuilder, InteractionContextType, MessageFlags } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { resolveTarget } = require('../lib/guard');
const { actionCard, maybeNotify, dmNote, attachProof } = require('../lib/format');
const { addSanctionOptions, resolveProof } = require('../lib/proofs');

module.exports = {
  permission: { default: 'admin' },

  data: addSanctionOptions(
    new SlashCommandBuilder()
      .setName('kick')
      .setDescription('Expulser un membre du serveur')
      .setContexts(InteractionContextType.Guild)
      .addUserOption((o) => o.setName('user').setDescription('Membre à expulser').setRequired(true))
      .addStringOption((o) => o.setName('raison').setDescription('Raison de l’expulsion').setMaxLength(512)),
  ),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const reason = interaction.options.getString('raison');

    const { user, member, error } = await resolveTarget(interaction);
    if (error) return ui.replyError(interaction, error, 'Action impossible', '👢');

    const { proof, error: proofError } = await resolveProof(interaction);
    if (proofError) return ui.replyError(interaction, proofError, 'Preuve invalide', '🔎');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const dmSent = await maybeNotify(interaction, user, guild.name, 'kick', reason);
    try {
      await member.kick(reason ?? undefined);
    } catch (err) {
      return ui.replyError(interaction, `Expulsion impossible : ${err.message}`, 'Erreur', '👢');
    }

    const id = await ctx.services.moderation.record({ guildId: guild.id, action: 'kick', targetId: user.id, executorId: interaction.user.id, reason });
    await ui.respond(
      interaction,
      actionCard('kick', `<@${user.id}> a été expulsé.${dmNote(dmSent)}`, [
        { name: 'Raison', value: reason ?? '—' },
        { name: 'Sanction', value: `#${id}` },
        ...(await attachProof(ctx.services.moderation, guild.id, id, proof, interaction.user.id)),
      ]),
    );
    await ctx.services.logs.action({ guildId: guild.id, action: 'kick', targetId: user.id, executorId: interaction.user.id, reason, id, proof });
  },
};
