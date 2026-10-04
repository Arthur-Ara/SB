'use strict';

const { SlashCommandBuilder, InteractionContextType, MessageFlags } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { actionCard } = require('../lib/format');
const { unlockChannel } = require('../lib/channelLock');

module.exports = {
  permission: { default: 'admin' },

  data: new SlashCommandBuilder()
    .setName('unlockall')
    .setDescription('Déverrouiller tous les salons verrouillés par /lock ou /lockall')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('raison').setDescription('Raison du déverrouillage').setRequired(false).setMaxLength(512)),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const reason = interaction.options.getString('raison');
    const { moderation, logs } = ctx.services;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channelIds = await moderation.lockedChannelIds(guild.id);
    if (!channelIds.length) return ui.replyError(interaction, 'Aucun salon n’est actuellement verrouillé.', 'Rien à faire', '⚠️');

    let unlocked = 0;
    const failed = [];
    for (const channelId of channelIds) {
      const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
      if (!channel) {
        await moderation.clearLockState(guild.id, channelId);
        continue;
      }
      try {
        await unlockChannel(moderation, channel, interaction.user.id, reason);
        unlocked += 1;
      } catch (err) {
        failed.push(channelId);
        ctx.logger.warn(`Déverrouillage du salon ${channelId} impossible`, err.message);
      }
    }

    await moderation.record({
      guildId: guild.id,
      action: 'unlockall',
      executorId: interaction.user.id,
      reason,
      metadata: { unlocked, failed },
    });

    await ui.respond(
      interaction,
      actionCard('unlockall', `${unlocked} salon(s) déverrouillé(s).${failed.length ? `\n⚠️ ${failed.length} échec(s).` : ''}`, reason ? [{ name: 'Raison', value: reason }] : []),
    );
    await logs.action({ guildId: guild.id, action: 'unlockall', executorId: interaction.user.id, reason, extra: { stats: [['Salons déverrouillés', String(unlocked)]] } });
  },
};
