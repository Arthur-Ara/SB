'use strict';

const { SlashCommandBuilder, InteractionContextType, ChannelType, MessageFlags } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { formatDuration } = require('../lib/duration');

module.exports = {
  permission: { default: 'admin' },

  data: new SlashCommandBuilder()
    .setName('rollbackconfig')
    .setDescription('Réglages et état du journal du module Server Manager')
    .setContexts(InteractionContextType.Guild)
    .addChannelOption((o) =>
      o
        .setName('salon')
        .setDescription('Salon où publier chaque rollback (lancement et résultat)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    )
    .addBooleanOption((o) => o.setName('retirer_salon').setDescription('Ne plus publier les rollbacks dans un salon')),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const { store, limits } = ctx.services;

    const channel = interaction.options.getChannel('salon');
    if (channel) await store.setLogChannel(guild.id, channel.id);
    else if (interaction.options.getBoolean('retirer_salon')) await store.setLogChannel(guild.id, null);

    const [settings, journal] = await Promise.all([store.settings(guild.id), store.journalSize(guild.id)]);
    const card = ui.card({
      title: '🗂️ Server Manager',
      body: [
        {
          item: {
            emoji: '📝',
            title: 'Salon de journal des rollbacks',
            lines: [settings.logChannelId ? `<#${settings.logChannelId}>` : 'Aucun (utilise `/rollbackconfig salon:`)'],
          },
        },
        {
          item: {
            emoji: '🗃️',
            title: 'Journal des modifications',
            lines: [settings.trackingSince ? `Couverture depuis ${ui.ts(settings.trackingSince, 'f')}` : 'Pas encore de couverture'],
            details: [`Entrées annulables: ${journal.count}`, `Conservation: ${limits.retentionDays} jours`],
          },
        },
        {
          item: {
            emoji: '🛡️',
            title: 'Garde-fous',
            details: [
              `Période maximale: ${formatDuration(limits.maxWindowS)}`,
              `Actions maximum par rollback: ${limits.maxActions}`,
              `Délai entre deux rollbacks: ${limits.cooldownS} s`,
            ],
          },
        },
      ],
      footer: 'Réglable via SERVERMANAGER_* dans le .env',
    });
    await ui.respond(interaction, card, { ephemeral: true });
  },
};
