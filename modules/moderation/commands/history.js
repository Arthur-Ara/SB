'use strict';

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { historyItem } = require('../lib/format');

module.exports = {
  permission: { default: 'admin' },

  data: new SlashCommandBuilder()
    .setName('history')
    .setDescription('Historique de modération : ce salon, ou un membre en particulier')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName('user').setDescription('Voir l’historique de ce membre (modérateur + sanctionné)').setRequired(false)),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const target = interaction.options.getUser('user');
    const { moderation } = ctx.services;

    const rows = target ? await moderation.userHistory(guild.id, target.id) : await moderation.channelHistory(guild.id, interaction.channel.id);
    const title = target ? `Historique de ${target.username}` : `Historique de #${interaction.channel.name}`;

    if (!rows.length) {
      await ui.sendPaginated(interaction, [ui.card({ title, emoji: '📋', description: 'Aucune entrée.' })], { ephemeral: true });
      return;
    }

    const proofCounts = await moderation.proofCounts(guild.id, rows.map((row) => row.id));
    const pages = ui.paginateLines(rows, {
      perPage: 4,
      build: (slice) =>
        ui.card({
          title: `📋 ${title}`,
          body: [
            { stats: [['Entrées', rows.length]] },
            ...slice.map((row) => historyItem(row, { client: ctx.client, proofCount: proofCounts.get(Number(row.id)) ?? 0 })),
            '-# Les preuves d’une sanction : /sanction voir <identifiant>',
          ],
        }),
    });
    await ui.sendPaginated(interaction, pages, { ephemeral: true });
  },
};
