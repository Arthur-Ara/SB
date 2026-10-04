'use strict';

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const ui = require('../../../src/bot/ui');

module.exports = {
  permission: { default: 'everyone' },

  data: new SlashCommandBuilder()
    .setName('imdog')
    .setDescription('Savoir si tu es en laisse, et de qui')
    .setContexts(InteractionContextType.Guild),

  async execute(ctx, interaction) {
    const { leash } = ctx.services;
    const state = await leash.state(interaction.guildId);
    const userId = interaction.user.id;
    const link = state.links.get(userId);
    const member = leash.member(state, userId);

    let description;
    if (link) {
      const since = `<t:${Math.floor(new Date(link.createdAt).getTime() / 1000)}:R>`;
      description = `**Oui !** Tu es en laisse de <@${link.leasherId}> depuis ${since}.`;
      if (member.immune) description += '\n🛡️ Tu es immunisé : tu n’es pas déplacé automatiquement.';
    } else {
      description = '**Non**, tu n’es dans aucune laisse. Libre comme l’air !';
      if (member.godmode) description += '\n✨ God mode : personne ne peut te mettre en laisse.';
    }
    await ui.respond(interaction, ui.card({ emoji: ui.EMOJIS.dog, title: 'Suis-je en laisse ?', description }));
  },
};
