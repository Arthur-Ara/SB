'use strict';

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { webBaseUrl } = require('../../../src/web/url');

module.exports = {
  // La configuration (panels, catégories, réponses) se fait uniquement sur le panel web.
  permission: { default: 'admin' },

  data: new SlashCommandBuilder()
    .setName('support')
    .setDescription('Lien vers le panel web pour configurer le support automatique')
    .setContexts(InteractionContextType.Guild),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const base = webBaseUrl(ctx.config);
    if (!base) return ui.replyError(interaction, 'Le panel web est désactivé sur ce bot.');
    const url = `${base}/m/support/?guild=${guild.id}`;
    await ui.respond(interaction, ui.card({ emoji: '❓', title: 'Support automatique', description: `**${url}**` }), { ephemeral: true });
  },
};
