'use strict';

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const ui = require('../../../src/bot/ui');

module.exports = {
  permission: { default: 'admin' },

  data: new SlashCommandBuilder()
    .setName('rolemenu')
    .setDescription('Panneau interactif : menus de rôles (réactions, boutons, menu déroulant) et conditions d’accès')
    .setContexts(InteractionContextType.Guild),

  async execute(ctx, interaction) {
    if (!interaction.guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    await ctx.services.panel.open(interaction);
  },
};
