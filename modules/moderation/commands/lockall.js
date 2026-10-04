'use strict';

const { SlashCommandBuilder, InteractionContextType, MessageFlags, ChannelType } = require('discord.js');
const ui = require('../../../src/bot/ui');
const { actionCard } = require('../lib/format');
const { isChannelLocked, lockChannel } = require('../lib/channelLock');

const LOCKABLE_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

module.exports = {
  permission: { default: 'admin' },

  data: new SlashCommandBuilder()
    .setName('lockall')
    .setDescription('Verrouiller tous les salons textuels du serveur')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('raison').setDescription('Raison du verrouillage').setRequired(false).setMaxLength(512)),

  async execute(ctx, interaction) {
    const guild = interaction.guild;
    if (!guild) return ui.replyError(interaction, 'Cette commande s’utilise sur un serveur.');
    const reason = interaction.options.getString('raison');
    const { moderation, logs } = ctx.services;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channels = guild.channels.cache.filter((c) => LOCKABLE_TYPES.includes(c.type) && !isChannelLocked(c));

    let locked = 0;
    const failed = [];
    for (const channel of channels.values()) {
      try {
        await lockChannel(moderation, channel, interaction.user.id, reason);
        locked += 1;
      } catch (err) {
        failed.push(channel.id);
        ctx.logger.warn(`Verrouillage de #${channel.name} impossible`, err.message);
      }
    }

    await moderation.record({
      guildId: guild.id,
      action: 'lockall',
      executorId: interaction.user.id,
      reason,
      metadata: { locked, failed },
    });

    await ui.respond(
      interaction,
      actionCard('lockall', `${locked} salon(s) verrouillé(s).${failed.length ? `\n⚠️ ${failed.length} échec(s).` : ''}`, reason ? [{ name: 'Raison', value: reason }] : []),
    );
    await logs.action({ guildId: guild.id, action: 'lockall', executorId: interaction.user.id, reason, extra: { stats: [['Salons verrouillés', String(locked)]] } });
  },
};
