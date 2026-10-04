'use strict';

const { SlashCommandBuilder, InteractionContextType, MessageFlags, ChannelType } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { actionCard } = require('../lib/format');
const { isChannelLocked, unlockChannel } = require('../lib/channelLock');

module.exports = {
  permission: { default: 'admin' },

  data: new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('Déverrouiller un salon')
    .setContexts(InteractionContextType.Guild)
    .addChannelOption((o) =>
      o
        .setName('salon')
        .setDescription('Salon à déverrouiller (par défaut : ce salon)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false),
    )
    .addStringOption((o) => o.setName('raison').setDescription('Raison du déverrouillage').setRequired(false).setMaxLength(512)),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const channel = interaction.options.getChannel('salon') ?? interaction.channel;
    const reason = interaction.options.getString('raison');
    const { moderation, logs } = ctx.services;

    if (!isChannelLocked(channel)) return ui.replyError(interaction, `<#${channel.id}> n’est pas verrouillé.`, 'Pas verrouillé', '⚠️');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await unlockChannel(moderation, channel, interaction.user.id, reason);
    await moderation.record({ guildId: guild.id, action: 'unlock', channelId: channel.id, executorId: interaction.user.id, reason });

    await ui.respond(interaction, actionCard('unlock', `<#${channel.id}> a été déverrouillé.`, reason ? [{ name: 'Raison', value: reason }] : []));
    await logs.action({ guildId: guild.id, action: 'unlock', channelId: channel.id, executorId: interaction.user.id, reason });
  },
};
