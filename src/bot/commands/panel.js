'use strict';

const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, RESTJSONErrorCodes } = require('discord.js');
const ui = require('../ui');
const { webUrl } = require('../../web/url');

module.exports = {
  // Simple lien : accessible à tous (l'accès au dashboard reste protégé par AUTHORIZED_WEB_USERS).
  permission: { default: 'everyone' },

  data: new SlashCommandBuilder().setName('panel').setDescription('Obtenir le lien du panel web (dashboard)'),

  async execute(core, interaction) {
    const url = webUrl(core.config);
    if (!url) {
      await ui.replyError(interaction, 'Le panel web est désactivé sur ce bot.');
      return;
    }

    const authorized = core.config.web.authorizedUsers.has(interaction.user.id);
    const build = (withButton) =>
      ui.card({
        emoji: ui.EMOJIS.panel,
        title: 'Panel web',
        description: `**${url}**`,
        body: [
          authorized
            ? `${ui.EMOJIS.allowed} Ton compte Discord est **autorisé** : connecte-toi avec Discord.`
            : `${ui.EMOJIS.denied} Ton compte Discord n’est **pas autorisé** : l’accès te sera refusé.`,
          withButton
            ? new ActionRowBuilder().addComponents(
                new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Ouvrir le panel').setURL(url),
              )
            : null,
        ],
      });

    try {
      await ui.respond(interaction, build(true), { ephemeral: true });
    } catch (err) {
      // Discord peut refuser un bouton pointant vers une adresse locale (localhost…) : on envoie le lien seul.
      if (err?.code !== RESTJSONErrorCodes.InvalidFormBodyOrContentType) throw err;
      await ui.respond(interaction, build(false), { ephemeral: true });
    }
  },
};
