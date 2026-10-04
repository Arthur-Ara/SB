'use strict';

const { SlashCommandBuilder, InteractionContextType, MessageFlags, ChannelType } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { actionCard, formatDuration } = require('../lib/format');

const MAX_SECONDS = 21_600; // limite native Discord (6h)

module.exports = {
  permission: { default: 'admin' },

  data: new SlashCommandBuilder()
    .setName('slowmod')
    .setDescription('Définir le mode lent d’un salon')
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((o) => o.setName('secondes').setDescription('Délai entre les messages, en secondes (0 = désactivé)').setRequired(true).setMinValue(0).setMaxValue(MAX_SECONDS))
    .addChannelOption((o) =>
      o
        .setName('salon')
        .setDescription('Salon concerné (par défaut : ce salon)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false),
    ),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const channel = interaction.options.getChannel('salon') ?? interaction.channel;
    const seconds = interaction.options.getInteger('secondes', true);
    const { moderation, logs } = ctx.services;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await channel.setRateLimitPerUser(seconds, 'Mode lent ajusté via /slowmod');
    await moderation.record({ guildId: guild.id, action: 'slowmode', channelId: channel.id, executorId: interaction.user.id, durationS: seconds });

    const description = seconds > 0 ? `Mode lent de <#${channel.id}> réglé sur **${formatDuration(seconds)}**.` : `Mode lent désactivé sur <#${channel.id}>.`;
    await ui.respond(interaction, actionCard('slowmode', description, []));
    await logs.action({ guildId: guild.id, action: 'slowmode', channelId: channel.id, executorId: interaction.user.id, reason: seconds > 0 ? `Délai : ${formatDuration(seconds)}` : 'Désactivé' });
  },
};
