'use strict';

const { SlashCommandBuilder, InteractionContextType, MessageFlags } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { basicChecks, canModerate } = require('../lib/guard');
const { actionCard, maybeNotify, dmNote, attachProof } = require('../lib/format');
const { addSanctionOptions, resolveProof } = require('../lib/proofs');
const { applyTempBan } = require('../lib/sanctions');
const { parseDuration, formatDuration } = require('../../../src/core/duration');

const MAX_SECONDS = 365 * 86_400;

module.exports = {
  permission: { default: 'admin' },

  data: addSanctionOptions(
    new SlashCommandBuilder()
      .setName('tempban')
      .setDescription('Bannir un membre pour une durée limitée (débanni automatiquement)')
      .setContexts(InteractionContextType.Guild)
      .addUserOption((o) => o.setName('user').setDescription('Membre à bannir').setRequired(true))
      .addStringOption((o) => o.setName('duree').setDescription('Durée : 30m, 12h, 7j, 2sem… (1 an max)').setRequired(true).setMaxLength(20))
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
    const seconds = parseDuration(interaction.options.getString('duree', true));
    if (!seconds || seconds > MAX_SECONDS) return ui.replyError(interaction, 'Durée invalide : par exemple `30m`, `12h`, `7j` ou `2sem` (1 an maximum).', 'Durée invalide', '⏳');

    const basic = basicChecks(interaction, target);
    if (!basic.allowed) return ui.replyError(interaction, basic.reason, 'Action impossible', '⏳');
    const member = guild.members.cache.get(target.id) ?? (await guild.members.fetch(target.id).catch(() => null));
    if (member) {
      const hierarchy = canModerate(interaction.member, member);
      if (!hierarchy.allowed) return ui.replyError(interaction, hierarchy.reason, 'Action impossible', '⏳');
    }
    const already = await guild.bans.fetch(target.id).catch(() => null);
    if (already) return ui.replyError(interaction, `<@${target.id}> est déjà banni.`, 'Action impossible', '⏳');

    const { proof, error: proofError } = await resolveProof(interaction);
    if (proofError) return ui.replyError(interaction, proofError, 'Preuve invalide', '🔎');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const dmSent = await maybeNotify(interaction, target, guild.name, 'tempban', `${reason ?? '—'} (${formatDuration(seconds)})`);
    let result;
    try {
      result = await applyTempBan(ctx.services, guild, target.id, { seconds, reason, executorId: interaction.user.id, deleteDays: days });
    } catch (err) {
      return ui.replyError(interaction, `Bannissement impossible : ${err.message}`, 'Erreur', '⏳');
    }

    const proofFields = await attachProof(ctx.services.moderation, guild.id, result.id, proof, interaction.user.id);
    await ui.respond(
      interaction,
      actionCard('tempban', `<@${target.id}> est banni pour **${formatDuration(seconds)}**.${dmNote(dmSent)}`, [
        { name: 'Jusqu’au', value: ui.dateTime(result.expiresAt) },
        { name: 'Raison', value: reason ?? '—' },
        { name: 'Sanction', value: `#${result.id}` },
        ...proofFields,
      ]),
    );
    await ctx.services.logs.action({
      guildId: guild.id,
      action: 'tempban',
      targetId: target.id,
      executorId: interaction.user.id,
      reason: `${reason ?? '—'} (${formatDuration(seconds)})`,
      id: result.id,
      proof,
    });
  },
};
