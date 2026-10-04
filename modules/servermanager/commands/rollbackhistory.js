'use strict';

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { SCOPE_LABEL } = require('../lib/constants');
const { formatDuration } = require('../lib/duration');

const STATUS_LABEL = { running: 'En cours', done: 'Terminé', aborted: 'Interrompu', failed: 'Échec' };

module.exports = {
  permission: { default: 'admin' },

  data: new SlashCommandBuilder()
    .setName('rollbackhistory')
    .setDescription('Historique des rollbacks exécutés sur ce serveur')
    .setContexts(InteractionContextType.Guild),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const rows = await ctx.services.store.history(guild.id, 50);

    if (!rows.length) {
      await ui.sendPaginated(interaction, [ui.card({ title: '⏪ Historique des rollbacks', description: 'Aucun rollback exécuté.' })], { ephemeral: true });
      return;
    }

    const pages = ui.paginateLines(rows, {
      perPage: 4,
      build: (slice) =>
        ui.card({
          title: '⏪ Historique des rollbacks',
          body: [
            { stats: [['Rollbacks', rows.length]] },
            ...slice.map((row) => ({
              item: {
                emoji: '⏪',
                title: `Rollback n°${row.id}`,
                lines: [
                  `🛠️ <@${row.invoker_id}> · ${ui.ts(row.created_at, 'f')} (${ui.ts(row.created_at, 'R')})`,
                  row.target_user_id ? `🎯 Actions de <@${row.target_user_id}>` : null,
                ],
                details: [
                  `Type: ${SCOPE_LABEL[row.scope] ?? row.scope}`,
                  `Période: ${formatDuration(row.window_s)}`,
                  `Statut: ${STATUS_LABEL[row.status] ?? row.status}`,
                  `Annulées: ${row.applied} / ${row.planned}`,
                  `Ignorées: ${row.skipped} · Échecs: ${row.failed}`,
                ],
              },
            })),
          ],
        }),
    });
    await ui.sendPaginated(interaction, pages, { ephemeral: true });
  },
};
