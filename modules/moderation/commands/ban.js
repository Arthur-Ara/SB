'use strict';

const { SlashCommandBuilder, InteractionContextType, MessageFlags } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { basicChecks, canModerate } = require('../lib/guard');
const { actionCard, maybeNotify, dmNote, attachProof } = require('../lib/format');
const { addSanctionOptions, resolveProof } = require('../lib/proofs');

module.exports = {
  permission: { default: 'admin' },

  data: addSanctionOptions(
    new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Bannir un membre du serveur')
      .setContexts(InteractionContextType.Guild)
      .addUserOption((o) => o.setName('user').setDescription('Membre à bannir').setRequired(true))
      .addStringOption((o) => o.setName('raison').setDescription('Raison du bannissement').setMaxLength(512))
      .addIntegerOption((o) =>
        o.setName('jours_messages').setDescription('Supprimer ses messages des N derniers jours (0-7)').setMinValue(0).setMaxValue(7),
      ),
  ),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const target = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('raison');
    const days = interaction.options.getInteger('jours_messages') ?? 0;

    const basic = basicChecks(interaction, target);
    if (!basic.allowed) return ui.replyError(interaction, basic.reason, 'Action impossible', '🔨');
    const member = guild.members.cache.get(target.id) ?? (await guild.members.fetch(target.id).catch(() => null));
    if (member) {
      const hierarchy = canModerate(interaction.member, member);
      if (!hierarchy.allowed) return ui.replyError(interaction, hierarchy.reason, 'Action impossible', '🔨');
    }
    const already = await guild.bans.fetch(target.id).catch(() => null);
    if (already) return ui.replyError(interaction, `<@${target.id}> est déjà banni.`, 'Action impossible', '🔨');

    const { proof, error: proofError } = await resolveProof(interaction);
    if (proofError) return ui.replyError(interaction, proofError, 'Preuve invalide', '🔎');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const dmSent = await maybeNotify(interaction, target, guild.name, 'ban', reason);
    try {
      await guild.members.ban(target.id, { reason: reason ?? undefined, deleteMessageSeconds: days * 86400 });
    } catch (err) {
      return ui.replyError(interaction, `Bannissement impossible : ${err.message}`, 'Erreur', '🔨');
    }

    const id = await ctx.services.moderation.record({ guildId: guild.id, action: 'ban', targetId: target.id, executorId: interaction.user.id, reason });
    const proofFields = await attachProof(ctx.services.moderation, guild.id, id, proof, interaction.user.id);
    await ui.respond(
      interaction,
      actionCard('ban', `<@${target.id}> a été banni.${dmNote(dmSent)}`, [
        { name: 'Raison', value: reason ?? '—' },
        { name: 'Sanction', value: `#${id}` },
        ...proofFields,
      ]),
    );
    await ctx.services.logs.action({ guildId: guild.id, action: 'ban', targetId: target.id, executorId: interaction.user.id, reason, id, proof });
  },
};
