'use strict';

const { SlashCommandBuilder, InteractionContextType, MessageFlags } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { actionCard } = require('../lib/format');

module.exports = {
  permission: { default: 'admin' },

  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Supprimer plusieurs messages d’un coup dans ce salon')
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((o) => o.setName('nombre').setDescription('Nombre de messages à supprimer (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
    .addUserOption((o) => o.setName('user').setDescription('Ne supprimer que les messages de ce membre').setRequired(false)),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const channel = interaction.channel;
    if (!channel?.bulkDelete) return ui.replyError(interaction, 'Ce salon ne permet pas la suppression groupée.');
    const amount = interaction.options.getInteger('nombre', true);
    const target = interaction.options.getUser('user');
    const { moderation, logs } = ctx.services;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let toDelete;
    if (target) {
      const recent = await channel.messages.fetch({ limit: 100 });
      toDelete = recent.filter((m) => m.author.id === target.id).first(amount);
    } else {
      toDelete = amount;
    }

    const deleted = await channel.bulkDelete(toDelete, true).catch(() => null);
    const count = deleted ? deleted.size : 0;
    if (!count) return ui.replyError(interaction, 'Aucun message supprimé (peut-être trop anciens, +14 jours).', 'Rien à supprimer', '⚠️');

    await moderation.record({
      guildId: guild.id,
      action: 'clear',
      channelId: channel.id,
      targetId: target?.id ?? null,
      executorId: interaction.user.id,
      metadata: { count },
    });

    await ui.respond(
      interaction,
      actionCard('clear', `${count} message(s) supprimé(s) dans <#${channel.id}>${target ? ` (de <@${target.id}>)` : ''}.`, []),
    );
    await logs.action({
      guildId: guild.id,
      action: 'clear',
      channelId: channel.id,
      targetId: target?.id ?? null,
      executorId: interaction.user.id,
      extra: { stats: [['Messages supprimés', String(count)]] },
    });
  },
};
