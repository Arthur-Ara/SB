'use strict';

const { SlashCommandBuilder, InteractionContextType, PermissionFlagsBits, MessageFlags, ChannelType } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { resolveTarget } = require('../lib/guard');
const { actionCard, maybeNotify, dmNote, attachProof } = require('../lib/format');
const { addSanctionOptions, resolveProof } = require('../lib/proofs');
const { slugifyChannelName, ensurePrisonCategory, denyChannelAccess } = require('../lib/prison');

module.exports = {
  permission: { default: 'admin' },

  data: addSanctionOptions(
    new SlashCommandBuilder()
      .setName('shadow-ban')
      .setDescription('Isoler un membre dans un salon prison, sans accès au reste du serveur')
      .setContexts(InteractionContextType.Guild)
      .addUserOption((o) => o.setName('user').setDescription('Membre concerné').setRequired(true))
      .addStringOption((o) => o.setName('raison').setDescription('Raison du shadow-ban').setRequired(false).setMaxLength(512)),
  ),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const reason = interaction.options.getString('raison');
    const { moderation, logs } = ctx.services;

    const { user, error } = await resolveTarget(interaction);
    if (error) return ui.replyError(interaction, error, 'Action impossible', '⚠️');

    const existing = await moderation.shadowban(guild.id, user.id);
    if (existing) return ui.replyError(interaction, `<@${user.id}> est déjà shadow-ban.`, 'Déjà shadow-ban', '⚠️');

    const { proof, error: proofError } = await resolveProof(interaction);
    if (proofError) return ui.replyError(interaction, proofError, 'Preuve invalide', '🔎');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const category = await ensurePrisonCategory(moderation, guild);
    const prisonChannel = await guild.channels.create({
      name: `prison-de-${slugifyChannelName(user.username)}`,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      ],
      reason: reason ?? 'Shadow-ban',
    });

    const { previousState, denied } = await denyChannelAccess(guild, user.id, {
      prisonChannelId: prisonChannel.id,
      categoryId: category.id,
      reason: reason ?? 'Shadow-ban',
    });

    await moderation.addShadowban(guild.id, user.id, prisonChannel.id, previousState, interaction.user.id, reason);
    const dmSent = await maybeNotify(interaction, user, guild.name, 'shadowban', reason);
    const id = await moderation.record({
      guildId: guild.id,
      action: 'shadowban',
      targetId: user.id,
      channelId: prisonChannel.id,
      executorId: interaction.user.id,
      reason,
      metadata: { deniedChannels: denied },
    });

    await ui.respond(
      interaction,
      actionCard('shadowban', `<@${user.id}> est désormais shadow-ban, isolé dans <#${prisonChannel.id}>.${dmNote(dmSent)}`, [
        ...(reason ? [{ name: 'Raison', value: reason }] : []),
        { name: 'Sanction', value: `#${id}` },
        ...(await attachProof(moderation, guild.id, id, proof, interaction.user.id)),
      ]),
    );
    await logs.action({ guildId: guild.id, action: 'shadowban', targetId: user.id, channelId: prisonChannel.id, executorId: interaction.user.id, reason, id, proof });
  },
};
