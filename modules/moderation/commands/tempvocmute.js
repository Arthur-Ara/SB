'use strict';

const { SlashCommandBuilder, InteractionContextType, MessageFlags } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { resolveTarget } = require('../lib/guard');
const { actionCard, maybeNotify, dmNote, attachProof, formatDuration } = require('../lib/format');
const { addSanctionOptions, resolveProof } = require('../lib/proofs');

const MAX_MINUTES = 10_080; // 7 jours

module.exports = {
  permission: { default: 'admin' },

  data: addSanctionOptions(
    new SlashCommandBuilder()
      .setName('tempvocmute')
      .setDescription('Couper le micro d’un membre en vocal, temporairement (texte non affecté)')
      .setContexts(InteractionContextType.Guild)
      .addUserOption((o) => o.setName('user').setDescription('Membre concerné').setRequired(true))
      .addIntegerOption((o) => o.setName('minutes').setDescription('Durée en minutes (7 jours max)').setRequired(true).setMinValue(1).setMaxValue(MAX_MINUTES))
      .addStringOption((o) => o.setName('raison').setDescription('Raison').setMaxLength(512)),
  ),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const minutes = interaction.options.getInteger('minutes', true);
    const reason = interaction.options.getString('raison');
    const seconds = minutes * 60;

    const { user, member, error } = await resolveTarget(interaction);
    if (error) return ui.replyError(interaction, error, 'Action impossible', '🎙️');

    const { proof, error: proofError } = await resolveProof(interaction);
    if (proofError) return ui.replyError(interaction, proofError, 'Preuve invalide', '🔎');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const dmSent = await maybeNotify(interaction, user, guild.name, 'tempvocmute', reason ? `${reason} (${formatDuration(seconds)})` : formatDuration(seconds));
    try {
      await member.voice.setMute(true, reason ?? undefined);
    } catch (err) {
      return ui.replyError(interaction, `Mute vocal impossible : ${err.message}`, 'Erreur', '🎙️');
    }

    const expiresAt = new Date(Date.now() + seconds * 1000);
    const id = await ctx.services.moderation.record({
      guildId: guild.id,
      action: 'tempvocmute',
      targetId: user.id,
      executorId: interaction.user.id,
      reason,
      durationS: seconds,
      expiresAt,
    });
    await ui.respond(
      interaction,
      actionCard('tempvocmute', `<@${user.id}> a le micro coupé en vocal pour **${formatDuration(seconds)}**.${dmNote(dmSent)}`, [
        { name: 'Jusqu’au', value: ui.dateTime(expiresAt) },
        { name: 'Raison', value: reason ?? '—' },
        { name: 'Sanction', value: `#${id}` },
        ...(await attachProof(ctx.services.moderation, guild.id, id, proof, interaction.user.id)),
      ]),
    );
    await ctx.services.logs.action({ guildId: guild.id, action: 'tempvocmute', targetId: user.id, executorId: interaction.user.id, reason: `${reason ?? '—'} (${formatDuration(seconds)})`, id, proof });
  },
};
