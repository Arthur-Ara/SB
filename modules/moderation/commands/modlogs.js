'use strict';

const { SlashCommandBuilder, InteractionContextType, PermissionFlagsBits, ChannelType } = require('discord.js');
const ui = require('../../../src/bot/ui');

module.exports = {
  permission: { default: 'admin' },

  data: new SlashCommandBuilder()
    .setName('modlogs')
    .setDescription('Définir le salon de journal du module Modération')
    .setContexts(InteractionContextType.Guild)
    .addChannelOption((o) =>
      o
        .setName('salon')
        .setDescription('Salon où seront journalisées les actions de modération')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    ),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const channel = interaction.options.getChannel('salon', true);
    const me = guild.members.me;
    if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      return ui.replyError(interaction, `Le bot ne peut pas écrire dans <#${channel.id}>.`, 'Salon inaccessible', '⚠️');
    }

    await ctx.services.moderation.setLogChannel(guild.id, channel.id);
    await ui.respond(
      interaction,
      ui.successCard('Journal configuré', `Les actions du module Modération seront désormais journalisées dans <#${channel.id}>.`, '🛡️'),
      { ephemeral: true },
    );
  },
};
